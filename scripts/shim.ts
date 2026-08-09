#!/usr/bin/env bun
/**
 * Acquire the ABI shim — by building it, or by downloading a pinned prebuilt one.
 *
 *     bun run scripts/shim.ts --build                  # cargo build for this host
 *     bun run scripts/shim.ts --build --rid linux-x64  # cross-build (needs the Rust target)
 *     bun run scripts/shim.ts --fetch                  # download the pinned prebuilt artefact
 *     bun run scripts/shim.ts --fetch --update-hashes  # measure sha256s, print, write nothing
 *     bun run scripts/shim.ts --check                  # report what is installed; never installs
 *
 * Both paths land in the same place, which is the point:
 *
 *     vendor/<rid>/lib/<wgpu_bun_shim.dll | libwgpu_bun_shim.so | libwgpu_bun_shim.dylib>
 *     vendor/<rid>/.shim-version
 *
 * — the third tier of `src/resolve.ts`, right beside wgpu-native. `bun run release:stage` copies
 * both libraries into one platform package, so a consumer can never end up with a shim and a
 * wgpu-native from different releases.
 *
 * ── Why both a build and a fetch ────────────────────────────────────────────────────────────────
 *
 * **Consumers must not need a Rust toolchain**, so what ships is a prebuilt artefact — pinned by
 * sha256, fetched never committed, exactly as `wgpu-native.manifest.ts` treats upstream's binaries.
 * `--build` is for the people who change `shim/src/lib.rs`, and for CI, which is where the published
 * artefacts come from in the first place.
 *
 * The same rule applies as for wgpu-native: **an entry with an empty sha256 is unpinned and is
 * refused.** Every shim entry is unpinned today because no shim release has been cut. `--fetch` says
 * so and points at `--build`, rather than downloading something it cannot verify.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { currentRid, platformOf, type Rid } from "../wgpu-native.manifest.ts";
import { displace } from "./displace.ts";
import { buildShimCrate } from "./shimBuild.ts";
import {
  SHIM_ASSETS,
  SHIM_RELEASE_TAG,
  SHIM_VERSION,
  rustTargetFor,
  shimAssetFor,
  shimFileNameFor,
  shimRids,
} from "../shim.manifest.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM_CRATE = path.join(PKG_ROOT, "shim");
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
function warn(message: string): void {
  console.warn(`\x1b[33mwarn\x1b[0m   ${message}`);
}

/** Where a built or fetched shim is installed for a RID. */
function destFor(rid: Rid): { dir: string; lib: string; stamp: string } {
  const dir = path.join(VENDOR_DIR, rid);
  return {
    dir,
    lib: path.join(dir, "lib", shimFileNameFor(rid)),
    stamp: path.join(dir, ".shim-version"),
  };
}


function install(rid: Rid, bytesOrPath: Uint8Array | string): void {
  const dest = destFor(rid);
  fs.mkdirSync(path.dirname(dest.lib), { recursive: true });
  displace(dest.lib);
  if (typeof bytesOrPath === "string") fs.copyFileSync(bytesOrPath, dest.lib);
  else fs.writeFileSync(dest.lib, bytesOrPath);
  fs.writeFileSync(dest.stamp, `${SHIM_VERSION}\n`);
  const kib = (fs.statSync(dest.lib).size / 1024).toFixed(0);
  ok(`${rid}: shim ${SHIM_VERSION} → vendor/${rid}/lib/${shimFileNameFor(rid)} (${kib} KiB)`);
}

// ── build ───────────────────────────────────────────────────────────────────────────────────────

function build(rid: Rid): void {
  // The cargo invocation itself lives in `shimBuild.ts`, because `dawn-link.ts` needs the same
  // build to obtain the static archive it fuses in. One build, both artefacts; this path installs
  // the loadable one and ignores the other.
  let artifacts;
  try {
    artifacts = buildShimCrate(rid, { onCommand: (c) => info(`${rid}: ${c}`) });
  } catch (e) {
    fail(`${rid}: ${e instanceof Error ? e.message : String(e)}`);
  }
  install(rid, artifacts.cdylib);
}

// ── fetch ───────────────────────────────────────────────────────────────────────────────────────

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function updateHashes(): Promise<void> {
  console.log(`\nMeasuring sha256 for shim ${SHIM_RELEASE_TAG} — paste these into shim.manifest.ts:\n`);
  let failures = 0;
  for (const rid of shimRids()) {
    const asset = SHIM_ASSETS[rid];
    if (!asset) continue;
    try {
      const bytes = await download(asset.url);
      console.log(`  "${rid}": sha256: "${sha256(bytes)}",`);
    } catch (err) {
      failures++;
      warn(`${rid}: ${(err as Error).message}`);
    }
  }
  console.log("");
  if (failures > 0) fail(`${failures} artefact(s) could not be measured`);
}

async function fetchOne(rid: Rid): Promise<void> {
  const asset = shimAssetFor(rid);
  if (!asset) {
    fail(
      `no shim artefact is declared for RID "${rid}".\n` +
        `       declared: ${shimRids().join(", ")}`,
    );
  }
  if (!asset.sha256) {
    fail(
      `${rid}: the shim artefact is UNPINNED (empty sha256) — refusing to install it.\n` +
        `       No shim release has been cut yet, so there is nothing to verify against. Until one\n` +
        `       exists, build it instead:\n` +
        `         bun run shim:build\n` +
        `       After the release workflow uploads ${SHIM_RELEASE_TAG}, measure the hashes with\n` +
        `         bun run shim:fetch --update-hashes\n` +
        `       and paste them into shim.manifest.ts. A plausible-looking invented hash in a\n` +
        `       supply-chain file is worse than a blank one.`,
    );
  }

  info(`${rid}: downloading ${asset.url}`);
  const bytes = await download(asset.url);
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    fail(
      `${rid}: sha256 MISMATCH — refusing to install.\n` +
        `       expected ${asset.sha256}\n` +
        `       actual   ${actual}\n` +
        `       url      ${asset.url}`,
    );
  }
  ok(`${rid}: sha256 verified`);
  install(rid, bytes);
}

// ── check ───────────────────────────────────────────────────────────────────────────────────────

function check(rids: Rid[]): void {
  let missing = 0;
  for (const rid of rids) {
    const dest = destFor(rid);
    if (!fs.existsSync(dest.lib)) {
      missing++;
      warn(`${rid}: no shim (${path.relative(PKG_ROOT, dest.lib)})`);
      continue;
    }
    const stamped = fs.existsSync(dest.stamp) ? fs.readFileSync(dest.stamp, "utf-8").trim() : "(unstamped)";
    const note = stamped === SHIM_VERSION ? "" : `  ← expected ${SHIM_VERSION}`;
    ok(`${rid}: shim ${stamped}${note}`);
  }
  if (missing > 0) {
    console.log(
      `\n${missing} of ${rids.length} platform(s) have no shim. That is only an error where the ABI\n` +
        `requires one — see shim.manifest.ts:shimIsRequired.\n`,
    );
  }
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const ridIdx = argv.indexOf("--rid");
const explicitRid = ridIdx !== -1 ? argv[ridIdx + 1] : null;
if (ridIdx !== -1 && (!explicitRid || explicitRid.startsWith("--"))) {
  fail("--rid needs a value, e.g. --rid linux-x64");
}
const all = argv.includes("--all");
const rids: Rid[] = all ? shimRids() : [explicitRid ?? currentRid()];

try {
  if (argv.includes("--update-hashes")) await updateHashes();
  else if (argv.includes("--check")) check(all ? shimRids() : rids);
  else if (argv.includes("--fetch")) for (const rid of rids) await fetchOne(rid);
  else if (argv.includes("--build")) for (const rid of rids) build(rid);
  else {
    fail(
      "pick one of --build, --fetch, --check or --update-hashes.\n" +
        `       platform ${platformOf(currentRid())} · rid ${currentRid()} · shim ${SHIM_VERSION}`,
    );
  }
} catch (err) {
  fail((err as Error).message);
}
