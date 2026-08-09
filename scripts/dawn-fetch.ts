#!/usr/bin/env bun
/**
 * Fetch + verify + extract the pinned Dawn release archive.
 *
 *     bun run dawn:fetch                    # this host
 *     bun run dawn:fetch --rid linux-x64    # cross-fetch another platform
 *     bun run dawn:fetch --force            # re-download even if the stamp matches
 *     bun run dawn:fetch --update-hashes    # measure every pinned archive, print, write nothing
 *
 * It extracts to `vendor/.dawn-<rid>/`, which `scripts/dawn-link.ts` then turns into the shared
 * library and deletes. That staging directory is deliberately NOT `vendor/<rid>/` — the archive is
 * an input, not a deliverable, and leaving 600 MB of static objects beside the shipped library
 * invites shipping them.
 *
 * The rules are `fetch-wgpu-native.ts`'s, unchanged, because they are the point rather than the
 * detail:
 *
 *   1. A sha256 mismatch ALWAYS hard-fails. There is no `--soft` here: unlike wgpu-native, nothing
 *      works without this archive — there is no shared library to fall back to — so tolerating a
 *      failed download would only move the error somewhere less clear.
 *   2. Hashes are measured by `--update-hashes` and pasted by a human. A plausible-looking invented
 *      hash in a supply-chain file is worse than a blank one.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { currentRid, type Rid } from "../wgpu-native.manifest.ts";
import { DAWN_TAG, dawnAssetFor, dawnRids } from "../dawn.manifest.ts";

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

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Extract a `.tar.gz` with whatever the host provides. Bun has no tar reader. */
async function untar(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  // `-xf`, not `-xzf`: bsdtar detects the compression itself, and on Windows the `tar` on PATH may
  // be a GNU build whose gzip child is missing — which fails with a bare "child returned status 128"
  // that says nothing about the cause. The system tar is tried by absolute path too, because Git for
  // Windows puts its own earlier on PATH.
  const systemTar = process.platform === "win32" ? String.raw`C:\Windows\System32\tar.exe` : "/usr/bin/tar";
  const attempts: string[][] = [
    [systemTar, "-xf", archive, "-C", destDir],
    ["tar", "-xf", archive, "-C", destDir],
    ["bsdtar", "-xf", archive, "-C", destDir],
  ];
  const errors: string[] = [];
  for (const cmd of attempts) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) === 0) return;
      errors.push(`${cmd[0]}: ${(await new Response(proc.stderr).text()).trim()}`);
    } catch (err) {
      errors.push(`${cmd[0]}: ${(err as Error).message}`);
    }
  }
  throw new Error(`could not extract ${path.basename(archive)}\n  ${errors.join("\n  ")}`);
}

async function updateHashes(): Promise<void> {
  console.log(`\nMeasuring sha256 for Dawn ${DAWN_TAG} — paste these into dawn.manifest.ts:\n`);
  let failures = 0;
  for (const rid of dawnRids()) {
    const asset = dawnAssetFor(rid)!;
    try {
      const bytes = await download(asset.url);
      const mib = (bytes.byteLength / 1024 / 1024).toFixed(1);
      console.log(`  "${rid}": sha256: "${sha256(bytes)}",  // ${mib} MiB`);
    } catch (err) {
      failures += 1;
      console.error(`  ${rid}: ${(err as Error).message}`);
    }
  }
  console.log("");
  if (failures > 0) fail(`${failures} archive(s) could not be measured`);
}

async function install(rid: Rid, force: boolean): Promise<void> {
  const asset = dawnAssetFor(rid);
  if (!asset) {
    fail(
      `no pinned Dawn archive for RID "${rid}".\n` +
        `       supported: ${dawnRids().join(", ")}\n` +
        `       linux-arm64 is absent on purpose: Google publishes no arm64 Linux desktop build, so\n` +
        `       that platform needs a source build rather than a link. See dawn.manifest.ts.`,
    );
  }

  const stagedDir = path.join(VENDOR_DIR, `.dawn-${rid}`);
  const stampPath = path.join(VENDOR_DIR, rid, ".dawn-version");
  if (!force && fs.existsSync(stampPath) && fs.readFileSync(stampPath, "utf-8").trim() === DAWN_TAG) {
    ok(`${rid}: Dawn ${DAWN_TAG} already linked — use --force to re-fetch`);
    return;
  }

  info(`${rid}: downloading ${asset.url}`);
  const bytes = await download(asset.url);
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    fail(
      `${rid}: sha256 MISMATCH — refusing to use it.\n` +
        `       expected ${asset.sha256}\n` +
        `       actual   ${actual}\n` +
        `       url      ${asset.url}`,
    );
  }
  ok(`${rid}: sha256 verified (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB)`);

  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.mkdirSync(stagedDir, { recursive: true });
  const archivePath = path.join(stagedDir, "dawn.tar.gz");
  fs.writeFileSync(archivePath, bytes);
  await untar(archivePath, stagedDir);
  fs.rmSync(archivePath, { force: true });

  ok(`${rid}: extracted → vendor/.dawn-${rid}   (next: bun run dawn:link --rid ${rid})`);
}

const argv = process.argv.slice(2);
const ridIdx = argv.indexOf("--rid");
const rid = ridIdx !== -1 ? (argv[ridIdx + 1] as Rid | undefined) : currentRid();
if (!rid) fail("--rid needs a value");

try {
  if (argv.includes("--update-hashes")) await updateHashes();
  else await install(rid, argv.includes("--force"));
} catch (err) {
  fail((err as Error).message);
}
