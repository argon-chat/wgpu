#!/usr/bin/env bun
/**
 * Turn Dawn's pinned **static** release into the **shared** library `bun:ffi` can load.
 *
 *     bun run scripts/dawn-link.ts              # this host
 *     bun run scripts/dawn-link.ts --rid linux-x64
 *     bun run scripts/dawn-link.ts --keep       # leave the extracted archive for inspection
 *
 * Output: `vendor/<rid>/lib/<webgpu_dawn.dll | libwebgpu_dawn.so | libwebgpu_dawn.dylib>`.
 *
 * ── Why this step exists at all ─────────────────────────────────────────────────────────────────
 *
 * Every Dawn release asset is a static archive. `bun:ffi` needs something it can `dlopen`, so the
 * archive is an input, not a deliverable — see `dawn.manifest.ts` for the two-pin supply chain that
 * follows from that.
 *
 * ── The three platforms differ, and only one of them is interesting ─────────────────────────────
 *
 * **Linux and macOS are nearly free.** Dawn's static objects are compiled with default ELF/Mach-O
 * visibility, so the `wgpu*` symbols are already exportable; the linker only has to be told to keep
 * the whole archive and then to hide everything else. That second half is not cosmetic: without a
 * version script, `--whole-archive` also exports the ~600 000 tint/absl/spirv symbols the archive
 * carries, and the library becomes a namespace hazard for anything else in the process.
 *
 * **Windows needs an explicit export list.** Dawn's `WGPU_EXPORT` expands to nothing unless
 * `WGPU_SHARED_LIBRARY` is defined, and the release is built static, so the objects carry no
 * `dllexport` at all. The list is generated from the pinned header rather than maintained by hand —
 * a function added upstream then appears automatically, and one removed fails the link loudly.
 *
 * ⚠ **The Windows link needs an MSVC toolset no older than Dawn's own.** Measured against
 * `v20260807.193620`: MSVC 14.50.35717 fails on `__std_min_element_4u`, `__std_max_element_4u` and
 * `__std_min_element_8u` — vectorised STL helpers whose unsigned variants that toolset does not
 * ship. Dawn's releases are built on `windows-latest`, so a CI job on the same image matches by
 * construction. The failure mode is loud, which is the important part: unresolved externals, named,
 * never a silently wrong binary.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { currentRid, platformOf, type Rid } from "../wgpu-native.manifest.ts";
import {
  DAWN_STATIC_BASENAMES,
  DAWN_TAG,
  dawnLibFileName,
  dawnRids,
} from "../dawn.manifest.ts";
import { displace } from "./displace.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(PKG_ROOT, "vendor");

function fail(message: string): never {
  console.error(`\x1b[31merror\x1b[0m  ${message}`);
  process.exit(1);
}
function info(message: string): void {
  console.log(`\x1b[36m·\x1b[0m      ${message}`);
}
function ok(message: string): void {
  console.log(`\x1b[32mok\x1b[0m     ${message}`);
}

/** Every file under `dir`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Find a file by basename anywhere in the extracted tree.
 *
 * Probed rather than hardcoded: Windows puts the archive in `lib/` and Linux in `lib64/`, and
 * upstream's layout is not a documented contract. A probe turns a reshuffle into "not found in
 * archive" instead of a silently empty directory — the same rule `fetch-wgpu-native.ts` follows.
 */
function findByBasename(root: string, names: readonly string[]): string | null {
  const all = walk(root);
  for (const name of names) {
    const hit = all.find((p) => path.basename(p) === name);
    if (hit) return hit;
  }
  return null;
}

/**
 * Container image to run the compiler in, when the ABI floor of the host is not the one to ship.
 *
 * Dawn's own Linux release is built inside `dockcross/manylinux_2_28-x64` — its CI comments say the
 * reason is glibc 2.28 compatibility. Re-linking those objects on a bare `ubuntu-latest` produces a
 * library that requires *that runner's* glibc and silently throws the floor away: it works in CI,
 * works on the maintainer's machine, and fails on the older distribution the floor existed for.
 *
 * So the image is a parameter, not a comment. Set it and the compiler runs inside; leave it unset
 * and it runs on the host, which is what a local experiment wants.
 */
const CONTAINER = process.env["DAWN_LINK_CONTAINER"] ?? "";

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
  const [program, argv] = CONTAINER
    ? [
        "docker",
        [
          "run", "--rm",
          "-v", `${PKG_ROOT}:${PKG_ROOT}`,
          "-w", cwd,
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          CONTAINER,
          cmd,
          ...args,
        ],
      ]
    : [cmd, args];
  const r = spawnSync(program, argv, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...env },
  });
  if (r.error) fail(`${program}: ${r.error.message}`);
  if (r.status !== 0) fail(`${program} exited ${r.status}`);
}

/**
 * The C API, read out of the pinned header.
 *
 * Only `WGPU_EXPORT`-declared functions count. A looser scan (`/wgpu[A-Za-z]+\(/`) also picks up
 * the header's own macros — `wgpu_ENUM_ZERO_INIT`, `wgpu_MAKE_INIT_STRUCT` — which are not symbols
 * and make the linker fail on names that never existed. Measured: 277 declarations, matching the
 * count of `wgpu*` symbols in the archive exactly.
 */
function exportedFunctions(headerPath: string): string[] {
  const text = fs.readFileSync(headerPath, "utf-8");
  const names = new Set<string>();
  for (const m of text.matchAll(/^WGPU_EXPORT\s+[^(;]*?\b(wgpu[A-Za-z0-9_]+)\s*\(/gm)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

interface ILinkInputs {
  readonly rid: Rid;
  readonly staticLib: string;
  readonly header: string;
  readonly outDir: string;
  readonly outLib: string;
}

/**
 * Locate `vcvars64.bat`, the only reliable way to get MSVC's linker *and* its library search path.
 *
 * ⚠ **`link` must never be invoked bare on Windows.** Git for Windows ships coreutils' `link.exe` in
 * `usr/bin`, and on a GitHub runner that is what a bare `link` resolves to — it accepts the first
 * argument and then reports `extra operand '/MACHINE:X64'`, which reads like a linker complaint and
 * is not one. Measured on `windows-latest`. MSVC's linker is also not on `PATH` at all until the
 * developer environment is initialised, and it needs `LIB` set for `user32.lib` and friends.
 *
 * So the whole invocation goes through `vcvars64.bat`, which fixes both at once, and this repository
 * keeps that decision here rather than in the workflow — the same rule the container wrapping
 * follows.
 */
function vcvarsPath(): string {
  const vswhere = String.raw`C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe`;
  if (!fs.existsSync(vswhere)) fail("vswhere.exe not found — is Visual Studio installed?");
  const r = spawnSync(
    vswhere,
    ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
    { encoding: "utf-8" },
  );
  const root = (r.stdout ?? "").trim().split(/\r?\n/)[0];
  if (!root) fail("vswhere found no Visual Studio install carrying the x64 C++ tools");
  const bat = path.join(root, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!fs.existsSync(bat)) fail(`vcvars64.bat not found under ${root}`);
  return bat;
}

/** Run a command with the MSVC developer environment initialised. */
function runInMsvcEnv(cmd: string, args: string[], cwd: string): void {
  const script = path.join(cwd, "_link.bat");
  const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  fs.writeFileSync(script, `@echo off\r\ncall "${vcvarsPath()}" >nul\r\n${cmd} ${quoted}\r\nexit /b %ERRORLEVEL%\r\n`);
  try {
    const r = spawnSync("cmd", ["/c", script], { cwd, stdio: "inherit", shell: false });
    if (r.error) fail(`cmd: ${r.error.message}`);
    if (r.status !== 0) fail(`${cmd} exited ${r.status}`);
  } finally {
    fs.rmSync(script, { force: true });
  }
}

function linkWindows(io: ILinkInputs): void {
  const names = exportedFunctions(io.header);
  if (names.length < 200) fail(`only ${names.length} exports parsed from ${io.header} — the header shape changed`);
  const defPath = path.join(io.outDir, "webgpu_dawn.def");
  fs.writeFileSync(defPath, `EXPORTS\n${names.map((n) => `    ${n}`).join("\n")}\n`);
  info(`${io.rid}: ${names.length} exports → ${path.basename(defPath)}`);

  // System libraries per Dawn's own installed `DawnTargets.cmake`. Notably absent: d3d12/dxgi/dxc —
  // Dawn loads those at runtime, which is also why `d3dcompiler_47.dll` has to travel beside the
  // library rather than being linked against.
  runInMsvcEnv(
    "link",
    [
      "/DLL", "/NOLOGO", "/MACHINE:X64",
      `/DEF:${defPath}`,
      `/OUT:${io.outLib}`,
      "/OPT:REF", "/OPT:ICF",
      io.staticLib,
      "user32.lib", "onecore_apiset.lib", "dxguid.lib",
      "ole32.lib", "oleaut32.lib", "advapi32.lib", "kernel32.lib",
      "shell32.lib", "shlwapi.lib", "version.lib", "propsys.lib",
      "winmm.lib", "ws2_32.lib", "bcrypt.lib", "userenv.lib", "ntdll.lib", "gdi32.lib",
    ],
    io.outDir,
  );
}

function linkLinux(io: ILinkInputs): void {
  // Keep every object (the C entry points live in one of them), then hide everything that is not
  // the WebGPU C API. Without the version script this also exports Dawn's vendored tint, abseil and
  // SPIRV-Tools symbols — hundreds of thousands of them — into the global namespace.
  const versionScript = path.join(io.outDir, "webgpu_dawn.map");
  fs.writeFileSync(versionScript, "{ global: wgpu*; local: *; };\n");
  run(
    "c++",
    [
      "-shared", "-fPIC",
      "-o", io.outLib,
      "-Wl,--whole-archive", io.staticLib, "-Wl,--no-whole-archive",
      `-Wl,--version-script=${versionScript}`,
      "-Wl,--as-needed",
      "-ldl", "-lpthread", "-lrt", "-lm",
    ],
    io.outDir,
  );
}

function linkDarwin(io: ILinkInputs): void {
  const names = exportedFunctions(io.header);
  // Mach-O wants the leading underscore, and an explicit list for the same reason Linux wants a
  // version script.
  const listPath = path.join(io.outDir, "webgpu_dawn.exports");
  fs.writeFileSync(listPath, `${names.map((n) => `_${n}`).join("\n")}\n`);
  run(
    "c++",
    [
      "-dynamiclib",
      "-o", io.outLib,
      "-Wl,-force_load", io.staticLib,
      "-Wl,-exported_symbols_list", listPath,
      "-framework", "Foundation",
      "-framework", "IOSurface",
      "-framework", "QuartzCore",
      "-framework", "Cocoa",
      "-framework", "IOKit",
      "-framework", "Metal",
      "-framework", "CoreFoundation",
    ],
    io.outDir,
    // ⚠ No `MACOSX_DEPLOYMENT_TARGET` override. An earlier revision forced `12.0`, taken from a
    // summary of Dawn's CI rather than from the archive itself — and the objects in this release
    // declare **26.0**. The link then emitted "built for newer 'macOS' version (26.0) than being
    // linked (12.0)" for every object and stamped a minimum the code does not support. The objects
    // carry their own floor; a number invented above them is worse than no number.
  );
}

/**
 * Prove the produced library actually exports the C API.
 *
 * A link can succeed and produce a library that exports nothing — an empty version script, a `.def`
 * parsed but ignored, a `force_load` that silently matched no archive. That failure is invisible
 * until the first `dlsym`, so it is checked here instead.
 */
function verifyExports(io: ILinkInputs): number {
  const platform = platformOf(io.rid);
  const probe =
    platform === "win32"
      ? spawnSync("dumpbin", ["/EXPORTS", "/NOLOGO", io.outLib], { encoding: "utf-8" })
      // `-gD` is GNU syntax. BSD nm, which is what macOS has, does not take `-D` — measured: the
      // darwin leg produced an empty probe, this function returned "tool missing", the caller
      // downgraded it to a warning, and a library was uploaded with its exports never checked, on a
      // green run. `-gU` is the BSD spelling for external defined symbols.
      : spawnSync("nm", [platform === "darwin" ? "-gU" : "-gD", io.outLib], { encoding: "utf-8" });
  const text = `${probe.stdout ?? ""}`;
  if (!text) {
    // Fatal, not a warning. A link can succeed and export nothing — an empty version script, a
    // `.def` parsed but ignored, a `force_load` that matched no archive — and none of that is
    // visible until the first `dlsym` on someone else's machine.
    fail(
      `${io.rid}: could not read the symbol table of ${path.basename(io.outLib)}.\n` +
        `       An unverified library must not be published, so this is an error rather than a note.`,
    );
  }
  const found = new Set([...text.matchAll(/\b(wgpu[A-Za-z0-9_]+)\b/g)].map((m) => m[1]!));
  return found.size;
}

function main(argv: string[]): void {
  const ridIdx = argv.indexOf("--rid");
  const rid = ridIdx !== -1 ? (argv[ridIdx + 1] as Rid | undefined) : currentRid();
  if (!rid) fail("--rid needs a value");
  if (!dawnRids().includes(rid)) {
    fail(
      `no pinned Dawn archive for RID "${rid}".\n` +
        `       supported: ${dawnRids().join(", ")}\n` +
        `       linux-arm64 is absent on purpose — Google publishes no arm64 Linux build, so it\n` +
        `       needs a source build rather than a link. See dawn.manifest.ts.`,
    );
  }

  const extracted = path.join(VENDOR_DIR, `.dawn-${rid}`);
  if (!fs.existsSync(extracted)) {
    fail(
      `${rid}: nothing extracted at vendor/.dawn-${rid}.\n` +
        `       Run:  bun run dawn:fetch --rid ${rid}`,
    );
  }

  const staticLib = findByBasename(extracted, DAWN_STATIC_BASENAMES);
  if (!staticLib) {
    fail(`${rid}: none of ${DAWN_STATIC_BASENAMES.join(", ")} found under vendor/.dawn-${rid}`);
  }
  const header = findByBasename(extracted, ["webgpu.h"]);
  if (!header) fail(`${rid}: webgpu.h not found under vendor/.dawn-${rid}`);

  const outDir = path.join(VENDOR_DIR, rid, "lib");
  fs.mkdirSync(outDir, { recursive: true });
  const outLib = path.join(outDir, dawnLibFileName(platformOf(rid)));
  // The library may be mapped by something that already loaded it; the same displacement rule the
  // wgpu-native fetcher and the shim installer use.
  displace(outLib);

  const io: ILinkInputs = { rid, staticLib, header, outDir, outLib };
  const mib = (fs.statSync(staticLib).size / 1024 / 1024).toFixed(0);
  info(`${rid}: linking ${path.basename(staticLib)} (${mib} MiB) → ${path.basename(outLib)}`);

  const started = Date.now();
  const platform = platformOf(rid);
  if (platform === "win32") linkWindows(io);
  else if (platform === "darwin") linkDarwin(io);
  else linkLinux(io);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (!fs.existsSync(outLib)) fail(`${rid}: the linker reported success but produced no ${path.basename(outLib)}`);
  const size = (fs.statSync(outLib).size / 1024 / 1024).toFixed(1);

  const exported = verifyExports(io);
  if (exported < 200) {
    fail(
      `${rid}: linked, but only ${exported} wgpu* symbols are exported.\n` +
        `       A library that links and exports nothing fails at the first dlsym, far from here.`,
    );
  } else {
    ok(`${rid}: ${exported} wgpu* symbols exported`);
  }

  fs.writeFileSync(path.join(VENDOR_DIR, rid, ".dawn-version"), `${DAWN_TAG}\n`);
  ok(`${rid}: Dawn ${DAWN_TAG} → vendor/${rid}/lib/${path.basename(outLib)} (${size} MiB, ${seconds}s)`);

  if (!argv.includes("--keep")) fs.rmSync(extracted, { recursive: true, force: true });
}

main(process.argv.slice(2));
