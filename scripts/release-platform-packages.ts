#!/usr/bin/env bun
/**
 * Build the per-platform npm packages that deliver the native library.
 *
 * ── Why sub-packages and not a postinstall hook ─────────────────────────────────────────────────
 *
 * **`bun install` does not run lifecycle scripts of installed dependencies.** That is a deliberate
 * supply-chain defence, and unblocking it requires the *consumer* to add this package to
 * `trustedDependencies` or run `bun pm trust`; Bun's built-in allowlist covers well-known packages,
 * and a new one is not on it. ⚠ The failure is easy to miss: Bun prints `Blocked 1 postinstall.` and
 * still reports overall success, and the user meets a library-not-found error at runtime pointing
 * nowhere near the cause. So: `optionalDependencies` with `os`/`cpu` fields, and no install scripts
 * anywhere. Full argument in docs/PACKAGING.md.
 *
 * ── What this script does ───────────────────────────────────────────────────────────────────────
 *
 *     bun run scripts/release-platform-packages.ts --check          # validate, build nothing
 *     bun run scripts/release-platform-packages.ts                  # stage every RID into dist/npm/
 *     bun run scripts/release-platform-packages.ts --rid linux-x64  # stage one
 *     bun run scripts/release-platform-packages.ts --impl dawn      # the Dawn packages instead
 *     bun run scripts/release-platform-packages.ts --wire           # write optionalDependencies
 *
 * Staging a wgpu-native RID requires **two** libraries under `vendor/<rid>/lib/`: upstream's
 * wgpu-native, from `bun run fetch --rid <rid>`, and this project's ABI shim, from
 * `bun run shim:build --rid <rid>`. They differ in portability: wgpu-native is a file download, so
 * one machine can stage every platform, while the shim is compiled here and cross-linking a `cdylib`
 * for four targets from one host means four target toolchains. The release workflow therefore builds
 * each on its matching runner — a release needs four machines, for one of the two artefacts.
 *
 * ── Two implementations, two families of package ────────────────────────────────────────────────
 *
 * `@wgpu-bun/<rid>` carries wgpu-native plus the shim; `@wgpu-bun/<rid>-dawn` carries **one** file,
 * because `dawn:link` fuses the same shim objects into the Dawn library itself. Three platforms
 * rather than four — Google publishes no arm64 Linux build.
 *
 * The asymmetry is in delivery: **the Dawn packages are never wired into `optionalDependencies`.**
 * An optional dependency installs by default, and a consumer who never types `WGPU_BUN_IMPL=dawn`
 * should not be downloading a second WebGPU implementation. `--wire` therefore refuses `--impl dawn`
 * outright rather than quietly doing something reasonable-looking.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentRid,
  libFileName,
  platformOf,
  supportedRids,
  WGPU_NATIVE_TAG,
  type Rid,
} from "../wgpu-native.manifest.ts";
import { SHIM_VERSION, shimFileNameFor, shimIsRequired } from "../shim.manifest.ts";
import { DAWN_TAG, dawnLibFileName, dawnRids } from "../dawn.manifest.ts";
import { npmPackageFor } from "../src/resolve.ts";
import { isWgpuImpl, WGPU_IMPLS, type WgpuImpl } from "../src/impl.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(PKG_ROOT, "vendor");
const STAGE_DIR = path.join(PKG_ROOT, "dist", "npm");

/** npm scope the per-platform packages live under. Must match `NPM_SCOPE` in `src/resolve.ts`. */
export const SCOPE = "@wgpu-bun";

/**
 * Package name for a RID: `@wgpu-bun/win32-x64`, or `@wgpu-bun/win32-x64-dawn`.
 *
 * Delegated to the resolver rather than spelled again here: the name is a contract between two
 * pieces of code that never meet — the publisher, and `import.meta.resolve` at runtime — so there
 * must be exactly one function producing it.
 */
export function platformPackageName(rid: Rid, impl: WgpuImpl = "wgpu-native"): string {
  return npmPackageFor(rid, impl);
}

/** The `cpu` half of a RID, in npm's spelling (which is Node's, which is why RIDs use it). */
export function cpuOf(rid: Rid): string {
  const dash = rid.indexOf("-");
  return dash === -1 ? "" : rid.slice(dash + 1);
}

/**
 * Filename of the upstream licence text that must travel with every redistributed binary.
 *
 * ⚠ **Upstream's release archives contain no licence file** — verified against
 * `wgpu-windows-x86_64-msvc-release.zip` at the pinned tag, which holds exactly `include/`, `lib/`
 * and `wgpu-native-meta/`. A package that ships the DLL without this is redistributing MIT /
 * Apache-2.0 bytes with no accompanying terms: a licence violation, not untidiness. So the text is
 * committed here, copied verbatim from the wgpu-native repository at the pinned tag, and not
 * generated — a synthesised licence would invent a copyright line. Preflight refuses without it.
 */
export const UPSTREAM_LICENSE_FILE = "LICENSE-WGPU-NATIVE";

/**
 * Dawn's terms, under the same rule and for the same reason.
 *
 * Google's release archive holds exactly `bin/`, `include/` and `lib/` — no licence text either — so
 * a package shipping `webgpu_dawn` without this redistributes BSD-3-Clause bytes bare. Copied
 * verbatim from the Dawn repository at {@link DAWN_COMMIT}: upstream's own file, sectioned by
 * `Files:` globs, committed rather than generated for the same reason as wgpu-native's.
 *
 * ⚠ It covers Dawn and Tint only. The linked library also contains vendored third parties — abseil,
 * SPIRV-Tools and others — whose notices live in their own `third_party/` subtrees upstream and
 * cannot be enumerated from a binary here; the platform README points at that tree.
 */
export const DAWN_LICENSE_FILE = "LICENSE-DAWN";

/**
 * Everything that differs between the two implementations when packaging them.
 *
 * A table rather than branches at each site, because the failure it guards against is a partial edit
 * — the library name remembered, the version stamp or include directory or licence forgotten —
 * which produces a package that installs and then cannot be resolved at runtime.
 */
interface IImplPackaging {
  readonly impl: WgpuImpl;
  /** Platforms this implementation is published for. */
  readonly rids: () => Rid[];
  /** Loadable library inside `vendor/<rid>/lib`, and inside the package. */
  readonly libFile: (platform: string) => string;
  /**
   * Further libraries that must travel in the same tarball.
   *
   * wgpu-native ships the ABI shim beside it; under Dawn the same objects are linked *into* the
   * library, so the list is empty by construction rather than by omission.
   */
  readonly extraLibs: (rid: Rid) => readonly string[];
  /** Version stamps copied from `vendor/<rid>` — the resolver reads these back. */
  readonly stamps: readonly string[];
  /** Sibling directory holding this implementation's headers. Must match `ILibraryKind` in resolve.ts. */
  readonly includeDirName: string;
  /** Upstream licence text, committed at the package root. */
  readonly licenseFile: string;
  /** What the upstream revision is called, for descriptions and READMEs. */
  readonly upstreamTag: string;
  readonly upstreamName: string;
}

const PACKAGING: Readonly<Record<WgpuImpl, IImplPackaging>> = {
  "wgpu-native": {
    impl: "wgpu-native",
    rids: supportedRids,
    libFile: libFileName,
    extraLibs: (rid) => [shimFileNameFor(rid)],
    stamps: [".version", ".shim-version"],
    includeDirName: "include",
    licenseFile: UPSTREAM_LICENSE_FILE,
    upstreamTag: WGPU_NATIVE_TAG,
    upstreamName: "wgpu-native",
  },
  dawn: {
    impl: "dawn",
    rids: dawnRids,
    libFile: dawnLibFileName,
    extraLibs: () => [],
    stamps: [".dawn-version"],
    includeDirName: "include-dawn",
    licenseFile: DAWN_LICENSE_FILE,
    upstreamTag: DAWN_TAG,
    upstreamName: "Dawn",
  },
};

/**
 * The `package.json` of one platform package.
 *
 * ⚠ The `exports` map is load-bearing and easy to omit. `src/resolve.ts` locates the library with
 * `import.meta.resolve('@wgpu-bun/<rid>/lib/<file>')`, and a package with no `exports` map — or one
 * naming only `"."` — makes that deep specifier unresolvable: it installs correctly and stays
 * invisible.
 */
export function platformPackageManifest(
  rid: Rid,
  version: string,
  repositoryUrl: string | null,
  impl: WgpuImpl = "wgpu-native",
): Record<string, unknown> {
  const platform = platformOf(rid);
  const p = PACKAGING[impl];
  const manifest: Record<string, unknown> = {
    name: platformPackageName(rid, impl),
    version,
    description:
      impl === "dawn"
        ? `Dawn ${DAWN_TAG} with the wgpu-bun ABI shim ${SHIM_VERSION} linked in, for ${rid}. Opt-in; select it with WGPU_BUN_IMPL=dawn.`
        : `wgpu-native ${WGPU_NATIVE_TAG} and the wgpu-bun ABI shim ${SHIM_VERSION} for ${rid}. Installed automatically by wgpu-bun.`,
    // The package is almost entirely someone else's binary, so the SPDX expression is upstream's,
    // not this repository's — MIT alone would understate the terms a consumer accepts. Dawn's linked
    // library is BSD-3-Clause with Apache-2.0 components.
    license: impl === "dawn" ? "BSD-3-Clause AND Apache-2.0 AND MIT" : "MIT OR Apache-2.0",
    os: [platform],
    cpu: [cpuOf(rid)],
    exports: {
      "./lib/*": "./lib/*",
      [`./${p.includeDirName}/*`]: `./${p.includeDirName}/*`,
      "./package.json": "./package.json",
    },
    files: ["lib", p.includeDirName, ...p.stamps, "README.md", p.licenseFile],
  };
  // Never fabricated: an incorrect `repository.url` breaks npm trusted publishing with an
  // authorization error that names nothing useful, so absent is strictly better than guessed.
  if (repositoryUrl) {
    manifest["repository"] = { type: "git", url: repositoryUrl, directory: `dist/npm/${stageDirName(rid, impl)}` };
  }
  return manifest;
}

/** Staging directory for a package — the RID, plus the implementation when it is not the default. */
function stageDirName(rid: Rid, impl: WgpuImpl): string {
  return impl === "dawn" ? `${rid}-dawn` : rid;
}

/** The `optionalDependencies` block the root package.json carries once the platforms are published. */
export function optionalDependenciesFor(version: string, rids: Rid[] = supportedRids()): Record<string, string> {
  // Exact versions, not ranges. The native library and the binding move together by definition —
  // a range would let a lockfile pair a binding with a library it was never tested against.
  return Object.fromEntries([...rids].sort().map((rid) => [platformPackageName(rid), version]));
}

/** Human-readable README shipped inside each platform package. */
function platformReadme(rid: Rid, impl: WgpuImpl = "wgpu-native"): string {
  if (impl === "dawn") return dawnPlatformReadme(rid);
  return [
    `# ${platformPackageName(rid)}`,
    "",
    `Two shared libraries for \`${rid}\`:`,
    "",
    `- \`lib/${libFileName(platformOf(rid))}\` — [wgpu-native](https://github.com/gfx-rs/wgpu-native) \`${WGPU_NATIVE_TAG}\`,`,
    "  upstream's own release artifact, unmodified. Dual-licensed MIT / Apache-2.0 by the gfx-rs",
    "  project; see `LICENSE-WGPU-NATIVE`.",
    `- \`lib/${shimFileNameFor(rid)}\` — the \`wgpu-bun\` ABI shim \`${SHIM_VERSION}\`, MIT, built from`,
    "  the `wgpu-bun` repository. It supplies the calling sequence `bun:ffi` cannot express for the",
    "  handful of wgpu-native entry points that take a C aggregate by value.",
    "",
    "They ship together because the shim transcribes one wgpu-native generation's struct layouts and",
    "is only correct paired with it.",
    "",
    "You do not install this directly. It is an `optionalDependency` of",
    "[`wgpu-bun`](https://www.npmjs.com/package/wgpu-bun) and your package manager picks the one",
    "matching your platform via the `os` and `cpu` fields.",
    "",
  ].join("\n");
}

/** README for a Dawn platform package — one library, opt-in, and the parts a consumer must supply. */
function dawnPlatformReadme(rid: Rid): string {
  const lib = dawnLibFileName(platformOf(rid));
  const lines = [
    `# ${platformPackageName(rid, "dawn")}`,
    "",
    `One shared library for \`${rid}\`: \`lib/${lib}\`.`,
    "",
    `It is [Dawn](https://dawn.googlesource.com/dawn) \`${DAWN_TAG}\` — Chromium's WebGPU — **linked`,
    "from upstream's static release** by the `wgpu-bun` repository, with the `wgpu-bun` ABI shim",
    `\`${SHIM_VERSION}\` linked into the same binary. Google publishes Dawn as static archives only,`,
    "so there is nothing to `dlopen` until someone links it; the build is a public CI run pinned by a",
    "git tag and a sha256, both recorded in `dawn.manifest.ts`.",
    "",
    "Dawn and Tint are BSD-3-Clause with Apache-2.0 components — see `LICENSE-DAWN`, copied verbatim",
    "from upstream. The library also statically contains vendored third parties (abseil, SPIRV-Tools",
    "and others) whose notices live in Dawn's own `third_party/` tree; they cannot be enumerated from",
    "a binary, so that tree is the reference rather than this file. The shim is MIT.",
    "",
    "## This one is opt-in",
    "",
    "Unlike the wgpu-native platform packages, this is **not** an `optionalDependency` of `wgpu-bun`.",
    "Install it deliberately, and select it at runtime:",
    "",
    "```sh",
    `bun add ${platformPackageName(rid, "dawn")}`,
    "WGPU_BUN_IMPL=dawn bun run your-thing.ts",
    "```",
  ];
  if (platformOf(rid) === "win32") {
    lines.push(
      "",
      "## Windows needs one runtime dependency, and it is not in this package",
      "",
      "Dawn loads its backend's support library dynamically: **DXC** (`dxcompiler.dll` + `dxil.dll`,",
      "from the Windows SDK) for D3D12, or the **Vulkan loader** (`vulkan-1.dll`, installed with every",
      "GPU driver) for Vulkan. `wgpu-bun` finds whichever is present and preloads it, and defaults to",
      "the backend that can run.",
      "",
      "Neither is shipped here on purpose: `dxil.dll` is closed-source Microsoft code, and",
      "`vulkan-1.dll` belongs to your driver installation. A machine with neither gets an error naming",
      "both rather than a Win32 error number.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ── staging ─────────────────────────────────────────────────────────────────────────────────────

interface IStageResult {
  readonly rid: Rid;
  readonly staged: boolean;
  readonly reason?: string;
  /** Package name, so the caller reports what it actually produced rather than reconstructing it. */
  readonly name?: string;
}

function stage(
  rid: Rid,
  version: string,
  repositoryUrl: string | null,
  impl: WgpuImpl = "wgpu-native",
): IStageResult {
  const p = PACKAGING[impl];
  const srcDir = path.join(VENDOR_DIR, rid);
  const name = platformPackageName(rid, impl);

  // Every file the package needs, resolved before anything is written: a run that copies half a
  // package and then fails leaves `dist/npm` looking publishable.
  const libName = p.libFile(platformOf(rid));
  const required = [libName, ...p.extraLibs(rid)];
  for (const file of required) {
    if (!fs.existsSync(path.join(srcDir, "lib", file))) {
      return { rid, staged: false, reason: `vendor/${rid}/lib/${file} is missing — ${howToGet(rid, impl, file)}` };
    }
  }

  const license = path.join(PKG_ROOT, p.licenseFile);
  if (!fs.existsSync(license)) {
    // Upstream ships no licence text in its archives — neither project does — so this is the only
    // copy that reaches a consumer. Staging without it would publish someone else's binary bare.
    return { rid, staged: false, reason: `${p.licenseFile} is missing from the package root` };
  }

  const outDir = path.join(STAGE_DIR, stageDirName(rid, impl));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(outDir, p.includeDirName), { recursive: true });

  for (const file of required) {
    fs.copyFileSync(path.join(srcDir, "lib", file), path.join(outDir, "lib", file));
  }

  // Stamps are what `src/resolve.ts` reads back as the installed version, so a missing one is not
  // cosmetic: it turns a known revision into `null`. The wgpu-native `.version` is required; the
  // rest are copied when present, because the shim has none when it was fetched rather than built.
  for (const stamp of p.stamps) {
    const src = path.join(srcDir, stamp);
    if (!fs.existsSync(src)) {
      // Every stamp, not just the first. An earlier version required only `p.stamps[0]`, so a
      // `.shim-version` lost in transit staged silently and shipped a package whose shim version
      // reads `null` — the same dot-prefixed-file transport bug that failed the Dawn leg loudly.
      return { rid, staged: false, reason: `vendor/${rid}/${stamp} is missing — the revision would ship unrecorded` };
    }
    fs.copyFileSync(src, path.join(outDir, stamp));
  }

  const incDir = path.join(srcDir, p.includeDirName);
  if (fs.existsSync(incDir)) {
    for (const header of fs.readdirSync(incDir)) {
      fs.copyFileSync(path.join(incDir, header), path.join(outDir, p.includeDirName, header));
    }
  }

  fs.copyFileSync(license, path.join(outDir, p.licenseFile));
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify(platformPackageManifest(rid, version, repositoryUrl, impl), null, 2)}
`,
  );
  fs.writeFileSync(path.join(outDir, "README.md"), platformReadme(rid, impl));
  return { rid, staged: true, name };
}

/** The command that produces a missing input, named exactly rather than left to be guessed. */
function howToGet(rid: Rid, impl: WgpuImpl, file: string): string {
  if (impl === "dawn") return `run: bun run dawn:fetch --rid ${rid} && bun run dawn:link --rid ${rid}`;
  if (file.includes("shim")) return `run: bun run shim:build --rid ${rid} (or shim:fetch)`;
  return `run: bun run fetch --rid ${rid}`;
}

/**
 * Does this linked Dawn library actually carry the fused ABI shim?
 *
 * Answered by opening it and looking for one trampoline; trusting that `dawn:link` ran is the
 * assumption that produces a package which installs, loads, and then cannot make a single by-value
 * call. The symbol is never *called* — `dlopen` throws when a declared name is absent, and that is
 * the whole test.
 *
 * ⚠ Only answerable for the host's own RID: a cross-staged library is a different architecture and
 * will not load at all. That case reports "carries it", because checking belongs to the leg that
 * built it, where `dawn:link` verifies all 15 against the symbol table. Hence the RID parameter — an
 * earlier revision compared `currentRid()` with `process.platform`, two spellings of the same host,
 * so the guard could never fire and a cross-staged library was `dlopen`ed anyway.
 */
function dawnLibraryCarriesShim(rid: Rid, libPath: string): boolean {
  if (platformOf(rid) !== process.platform) return true;
  try {
    dlopen(libPath, { wgpu_bun_shim_abi_version: { args: [], returns: FFIType.u32 } });
    return true;
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/not found/i.test(message)) return false;
    // Would not load at all — a different failure, and one the missing-library check above reports.
    return true;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

function main(argv: string[]): void {
  const rootPkgPath = path.join(PKG_ROOT, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8")) as {
    version: string;
    private?: boolean;
    repository?: { url?: string };
  };
  const version = rootPkg.version;
  const repositoryUrl = rootPkg.repository?.url ?? null;

  const implArg = argv.indexOf("--impl") !== -1 ? argv[argv.indexOf("--impl") + 1] : null;
  if (implArg && !isWgpuImpl(implArg)) {
    console.error(`unknown --impl "${implArg}". Known: ${WGPU_IMPLS.join(", ")}.`);
    process.exit(1);
  }
  const impl: WgpuImpl = (implArg as WgpuImpl | null) ?? "wgpu-native";
  const packaging = PACKAGING[impl];

  const only = argv.indexOf("--rid") !== -1 ? argv[argv.indexOf("--rid") + 1] : null;
  const rids = only ? [only as Rid] : packaging.rids();

  if (argv.includes("--wire")) {
    // Writing the block is a release action, not a repo default. Until the platform packages exist
    // on npm, declaring them would mean every `bun install` tries to resolve four 404s.
    if (impl === "dawn") {
      // The whole reason Dawn has a package name of its own. An `optionalDependency` installs by
      // default, and Dawn is a 10-20 MiB library most consumers will never select — and on Windows
      // it needs a runtime dependency this repository does not ship.
      console.error(
        "--wire is for wgpu-native only. Dawn platform packages are opt-in and must not appear " +
          "in optionalDependencies: they would install for everyone, by default, unused.",
      );
      process.exit(1);
    }
    const next = { ...rootPkg, optionalDependencies: optionalDependenciesFor(version, rids) };
    fs.writeFileSync(rootPkgPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wired optionalDependencies for ${rids.length} platform(s) at ${version}`);
    return;
  }

  const problems: string[] = [];
  if (!repositoryUrl) {
    problems.push(
      "package.json has no `repository.url`.\n" +
        "  npm trusted publishing requires it to match the GitHub repository exactly, and a wrong\n" +
        "  value fails with an authorization error that names nothing useful. Set it before the\n" +
        "  first publish — for the root package AND for every platform package.",
    );
  }
  if (!/^0\.|^\d+\.\d+\.\d+/.test(version)) problems.push(`package.json version "${version}" is not a semver release`);
  if (rootPkg.private) {
    // The interlock: `npm publish` refuses a private package, so a pre-alpha binding cannot reach
    // the registry by accident. Clearing it belongs in the release commit, next to the version bump.
    problems.push(
      'package.json still has `"private": true`.\n' +
        "  That is intentional while the binding is unfinished — it makes an accidental publish\n" +
        "  impossible. Remove it in the release commit, together with the version bump and\n" +
        "  `repository.url`, once the package is actually worth installing.",
    );
  }

  if (argv.includes("--check")) {
    if (!fs.existsSync(path.join(PKG_ROOT, packaging.licenseFile))) {
      problems.push(
        `${packaging.licenseFile} is missing from the package root.\n` +
          `  ${packaging.upstreamName}'s release archives carry no licence text, so redistributing the\n` +
          "  shared library without it ships someone else's bytes with no accompanying terms.\n" +
          "  Copy the licence verbatim from the upstream repository at the pinned revision. It is not\n" +
          "  generated on purpose: a synthesised licence would mean an invented copyright line.",
      );
    }
    for (const rid of rids) {
      const libPath = path.join(VENDOR_DIR, rid, "lib", packaging.libFile(platformOf(rid)));
      if (!fs.existsSync(libPath)) {
        problems.push(
          impl === "dawn"
            ? `${rid}: not linked (bun run dawn:fetch --rid ${rid} && bun run dawn:link --rid ${rid})`
            : `${rid}: not fetched (bun run fetch --rid ${rid})`,
        );
      }
      if (impl === "dawn") {
        // The fused shim is what makes a Dawn package usable at all, and it is invisible in a
        // directory listing — the package is one file either way. Checked by symbol, not by presence.
        if (fs.existsSync(libPath) && !dawnLibraryCarriesShim(rid, libPath)) {
          problems.push(
            `${rid}: the linked Dawn library does not export the ABI shim.\n` +
              "    Such a package loads and then cannot make a single by-value call. Re-run\n" +
              "    bun run dawn:link, which fuses the trampolines in and verifies them.",
          );
        }
        continue;
      }
      const shimPath = path.join(VENDOR_DIR, rid, "lib", shimFileNameFor(rid));
      if (!fs.existsSync(shimPath)) {
        // A release without the shim is not a partial release. On a SysV host the package does not
        // run; everywhere else it silently takes the fallback path, so what ships is not what CI
        // exercised. Both are blockers, so the message says which one applies.
        const [platform, arch] = rid.split("-");
        problems.push(
          `${rid}: no ABI shim (bun run shim:build --rid ${rid}).\n` +
            (shimIsRequired(platform!, arch!)
              ? `    This ABI cannot express a by-value aggregate from bun:ffi, so without the shim\n` +
                `    the package refuses to run on ${rid} at all.`
              : `    This ABI can take the direct path, so it would still work — but it would then be\n` +
                `    running a different calling path from the one CI exercised, which is not what\n` +
                `    "tested" means.`),
        );
      }
    }
    if (problems.length) {
      console.error(`\nrelease preflight FAILED:\n\n  - ${problems.join("\n  - ")}\n`);
      process.exit(1);
    }
    console.log(`release preflight ok — ${rids.length} platform package(s) ready at ${version}`);
    return;
  }

  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const results = rids.map((rid) => stage(rid, version, repositoryUrl, impl));
  for (const r of results) {
    const dir = stageDirName(r.rid, impl);
    if (r.staged) console.log(`ok    ${platformPackageName(r.rid, impl)} → dist/npm/${dir}`);
    else console.warn(`skip  ${platformPackageName(r.rid, impl)}: ${r.reason}`);
  }
  const staged = results.filter((r) => r.staged).length;
  if (staged === 0) {
    console.error("\nnothing staged — no vendored library for any requested RID.\n");
    process.exit(1);
  }
  console.log(
    `\n${staged}/${results.length} staged. Publish each with:\n` +
      `  cd dist/npm/<rid> && npm publish --access public\n` +
      `Unstaged platforms are UNPUBLISHED for this release — say so in the release notes rather\n` +
      `than leaving an optionalDependency the install cannot satisfy.`,
  );
}

if (import.meta.main) main(process.argv.slice(2));
