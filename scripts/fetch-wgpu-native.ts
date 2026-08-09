#!/usr/bin/env bun
/**
 * Fetch + verify + extract the pinned wgpu-native release for this host.
 *
 * The whole acquisition path in one file, driven entirely by `wgpu-native.manifest.ts`:
 *
 *     bun run scripts/fetch-wgpu-native.ts                 # install for this host
 *     bun run scripts/fetch-wgpu-native.ts --force         # re-download even if the stamp matches
 *     bun run scripts/fetch-wgpu-native.ts --soft          # tolerate NETWORK failure (never a hash one)
 *     bun run scripts/fetch-wgpu-native.ts --rid linux-x64 # install for another host
 *     bun run scripts/fetch-wgpu-native.ts --generation 27 # install a different wgpu-native generation
 *     bun run scripts/fetch-wgpu-native.ts --update-hashes # measure sha256s, print, write nothing
 *
 * Layout it produces (all git-ignored — binaries are fetched, never committed):
 *
 *     vendor/<rid>/lib/<wgpu_native.dll | libwgpu_native.so | libwgpu_native.dylib>
 *     vendor/<rid>/include/{webgpu.h,wgpu.h}
 *     vendor/<rid>/.version                 # the pinned tag — the ONLY staleness check
 *
 * Two rules, both load-bearing:
 *
 *   1. A sha256 mismatch ALWAYS hard-fails, even under `--soft`. `--soft` exists so a fresh clone
 *      without network still installs; it does not exist to wave through a wrong binary.
 *   2. The `.version` stamp is the only staleness comparison, so bumping `WGPU_NATIVE_TAG` without
 *      bumping the stamp string would leave already-vendored machines silently on the old library.
 *      They are the same string here, so that failure mode is structurally impossible.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_GENERATION,
  SUPPORTED_GENERATIONS,
  generation as generationOf,
  HEADER_BASENAMES,
  WGPU_NATIVE_TAG,
  assetFor,
  currentRid,
  libFileName,
  platformOf,
  supportedRids,
  type Rid,
} from "../wgpu-native.manifest.ts";

import { displace } from "./displace.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(PKG_ROOT, "vendor");

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

interface IOptions {
  rid: Rid;
  /** wgpu-native generation (wgpu-core major) to install. Defaults to the one this package ships. */
  generation: number;
  force: boolean;
  soft: boolean;
  updateHashes: boolean;
}

function parseArgs(argv: string[]): IOptions {
  const opts: IOptions = {
    rid: currentRid(),
    generation: DEFAULT_GENERATION,
    force: argv.includes("--force"),
    soft: argv.includes("--soft"),
    updateHashes: argv.includes("--update-hashes"),
  };
  const ridIdx = argv.indexOf("--rid");
  if (ridIdx !== -1) {
    const value = argv[ridIdx + 1];
    if (!value || value.startsWith("--")) fail("--rid needs a value, e.g. --rid linux-x64");
    opts.rid = value;
  }
  const genIdx = argv.indexOf("--generation");
  if (genIdx !== -1) {
    const value = argv[genIdx + 1];
    if (!value || value.startsWith("--")) {
      fail(`--generation needs a value, one of: ${SUPPORTED_GENERATIONS.join(", ")}`);
    }
    const parsed = Number(value);
    if (!SUPPORTED_GENERATIONS.includes(parsed)) {
      fail(
        `--generation ${value} is not supported. Supported: ${SUPPORTED_GENERATIONS.join(", ")}.\n` +
          `       A generation is added only once a CI leg has run the suite against it — see docs/GENERATIONS.md.`,
      );
    }
    opts.generation = parsed;
  }
  return opts;
}

function fail(message: string): never {
  console.error(`\x1b[31merror\x1b[0m  ${message}`);
  process.exit(1);
}

function warn(message: string): void {
  console.warn(`\x1b[33mwarn\x1b[0m   ${message}`);
}

function info(message: string): void {
  console.log(`\x1b[36m·\x1b[0m      ${message}`);
}

function ok(message: string): void {
  console.log(`\x1b[32mok\x1b[0m     ${message}`);
}

// ── download + hash ─────────────────────────────────────────────────────────────────────────────

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `--update-hashes`: download every pinned archive and print manifest-ready lines. Writes nothing —
 * a human pastes the result, so the act of pinning stays a deliberate, reviewable edit.
 */
async function updateHashes(major: number): Promise<void> {
  const gen = generationOf(major);
  console.log(`\nMeasuring sha256 for ${gen.tag} — paste these into wgpu-native.manifest.ts:\n`);
  let failures = 0;
  for (const rid of supportedRids(major)) {
    const asset = gen.assets[rid];
    if (!asset) continue;
    try {
      const bytes = await download(asset.url);
      const mib = (bytes.byteLength / 1024 / 1024).toFixed(1);
      console.log(`  "${rid}": sha256: "${sha256(bytes)}",  // ${mib} MiB`);
    } catch (err) {
      failures++;
      warn(`${rid}: ${(err as Error).message}`);
    }
  }
  console.log("");
  if (failures > 0) fail(`${failures} archive(s) could not be measured`);
}

// ── extraction ──────────────────────────────────────────────────────────────────────────────────

/**
 * Unzip via whatever the host provides. Bun has no built-in zip reader, and pulling an npm unzip
 * dependency into a package whose entire point is "no heavy dependencies" is the wrong trade.
 *
 * `bsdtar` (shipped as `tar` on Windows 10+ and macOS) reads zip; GNU `tar` on Linux does NOT, hence
 * `unzip` first there. Every candidate is tried before giving up.
 */
async function unzip(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const candidates: string[][] =
    process.platform === "linux"
      ? [
          ["unzip", "-oq", archive, "-d", destDir],
          ["bsdtar", "-xf", archive, "-C", destDir],
        ]
      : [
          ["tar", "-xf", archive, "-C", destDir],
          ["unzip", "-oq", archive, "-d", destDir],
        ];

  const errors: string[] = [];
  for (const cmd of candidates) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code === 0) return;
      errors.push(`${cmd[0]} exited ${code}: ${(await new Response(proc.stderr).text()).trim()}`);
    } catch (err) {
      errors.push(`${cmd[0]}: ${(err as Error).message}`);
    }
  }
  throw new Error(`could not extract ${path.basename(archive)}\n  ${errors.join("\n  ")}`);
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
 * Deliberately a probe rather than a hardcoded `lib/wgpu_native.dll`: upstream's in-archive layout
 * is not part of any documented contract, so pinning it would turn a harmless upstream reshuffle
 * into a confusing empty-directory bug. A probe turns the same event into "not found in archive".
 */
function findByBasename(root: string, basename: string): string | null {
  return walk(root).find((p) => path.basename(p) === basename) ?? null;
}

// ── install ─────────────────────────────────────────────────────────────────────────────────────

async function install(opts: IOptions): Promise<void> {
  const tag = generationOf(opts.generation).tag;
  const asset = assetFor(opts.rid, opts.generation);
  if (!asset) {
    fail(
      `no pinned wgpu-native ${tag} archive for RID "${opts.rid}".\n` +
        `       supported: ${supportedRids(opts.generation).join(", ")}\n` +
        `       Add an entry to wgpu-native.manifest.ts if upstream publishes one.`,
    );
  }

  const outDir = path.join(VENDOR_DIR, opts.rid);
  const stampPath = path.join(outDir, ".version");
  const libPath = path.join(outDir, "lib", libFileName(platformOf(opts.rid)));

  if (!opts.force && fs.existsSync(stampPath) && fs.existsSync(libPath)) {
    // The stamp carries the TAG, so switching generations in place is detected as staleness and
    // re-installs — `--generation 27` after a v29 fetch must not report "already vendored".
    if (fs.readFileSync(stampPath, "utf-8").trim() === tag) {
      ok(`${opts.rid}: wgpu-native ${tag} already vendored`);
      return;
    }
  }

  // Rule 1: an unpinned entry is never installed. See the manifest header for why the fields are
  // empty rather than fabricated.
  if (!asset.sha256) {
    fail(
      `${opts.rid}: manifest entry has no sha256 — refusing to install an unpinned binary.\n` +
        `       Measure it with:  bun run scripts/fetch-wgpu-native.ts --update-hashes\n` +
        `       then paste the value into wgpu-native.manifest.ts.`,
    );
  }

  info(`${opts.rid}: downloading ${asset.url}`);
  let bytes: Uint8Array;
  try {
    bytes = await download(asset.url);
  } catch (err) {
    // Rule 1's other half: --soft forgives the network, never the hash.
    if (opts.soft) {
      warn(`${opts.rid}: download failed, continuing (--soft): ${(err as Error).message}`);
      return;
    }
    throw err;
  }

  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    fail(
      `${opts.rid}: sha256 MISMATCH — refusing to install.\n` +
        `       expected ${asset.sha256}\n` +
        `       actual   ${actual}\n` +
        `       url      ${asset.url}`,
    );
  }
  ok(`${opts.rid}: sha256 verified`);

  const staging = path.join(VENDOR_DIR, `.staging-${opts.rid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const archivePath = path.join(staging, "archive.zip");
  fs.writeFileSync(archivePath, bytes);

  const extracted = path.join(staging, "x");
  await unzip(archivePath, extracted);

  const wantedLib = libFileName(platformOf(opts.rid));
  const foundLib = findByBasename(extracted, wantedLib);
  if (!foundLib) {
    fail(
      `${opts.rid}: ${wantedLib} not found in the archive.\n` +
        `       Extracted tree held: ${walk(extracted).map((p) => path.relative(extracted, p)).join(", ")}`,
    );
  }

  // Replace only what this script owns — the wgpu-native library and the headers — rather than
  // wiping `vendor/<rid>/`.
  //
  // Two reasons, and the second one is a Windows fact rather than a preference:
  //
  //   · **The ABI shim lives in the same `lib/` directory**, deliberately: the platform npm package
  //     ships the two libraries in one tarball because a shim transcribes one generation's struct
  //     layouts and is only correct paired with it. Wiping the directory deletes it, so every
  //     `bun run fetch` silently un-installed the shim and the next test run took the direct path
  //     (or refused outright, off Win64) for reasons nothing reported.
  //   · **A locked DLL makes `rm -rf` fail PART WAY THROUGH.** Windows refuses to unlink a mapped
  //     image, so a recursive delete that has already removed `include/` throws EPERM and leaves a
  //     half-installed tree behind — worse than either succeeding or not starting.
  const includeDir = path.join(outDir, "include");
  fs.rmSync(includeDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "lib"), { recursive: true });
  fs.mkdirSync(includeDir, { recursive: true });
  // The library may be mapped right now — by the editor, by a test run, by anything that called
  // create(). Displacing it is what makes a re-fetch safe while something has it open.
  const destLib = path.join(outDir, "lib", wantedLib);
  displace(destLib);
  fs.copyFileSync(foundLib, destLib);

  for (const header of HEADER_BASENAMES) {
    const found = findByBasename(extracted, header);
    if (found) fs.copyFileSync(found, path.join(outDir, "include", header));
    else warn(`${opts.rid}: header ${header} not present in the archive`);
  }

  fs.writeFileSync(stampPath, `${tag}\n`);
  fs.rmSync(staging, { recursive: true, force: true });

  const mib = (fs.statSync(path.join(outDir, "lib", wantedLib)).size / 1024 / 1024).toFixed(1);
  ok(`${opts.rid}: wgpu-native ${tag} → vendor/${opts.rid}/lib/${wantedLib} (${mib} MiB)`);
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
try {
  if (opts.updateHashes) await updateHashes(opts.generation);
  else await install(opts);
} catch (err) {
  fail((err as Error).message);
}
