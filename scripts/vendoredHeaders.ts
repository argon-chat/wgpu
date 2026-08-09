/**
 * Which vendored headers are authoritative — one answer, used by everything that reads them.
 *
 * ── Why this is its own module ──────────────────────────────────────────────────────────────────
 *
 * Because it was two copies, and both were wrong the same way. `gen-layouts.ts` (which writes the
 * tables) and `test/layout-oracle.test.ts` (which checks them against a C compiler) each had their
 * own "find a vendored include dir" that took the **alphabetically first** RID with headers.
 *
 * That was harmless while `vendor/` could only ever hold one generation. `bun run fetch
 * --generation <n>` ended that: it installs into the host's own directory and leaves cross-fetched
 * platforms at whatever generation they were fetched at. On a developer machine with all four
 * platforms staged, `darwin-arm64` (v29) sorted ahead of `win32-x64` (v27) — so both tools read a
 * generation nobody had installed, agreed with each other, and reported success. Every CI leg,
 * where exactly one RID is vendored, failed instead.
 *
 * Two tools deriving the same fact separately is how they end up disagreeing about it. So the rule
 * lives here: **this host's RID first**, then whatever else is staged.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_GENERATION, currentRid } from "../wgpu-native.manifest.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface IVendoredHeaders {
  /** Directory holding `webgpu.h` and `wgpu.h`. */
  readonly dir: string;
  /** RID the headers came from, or `null` when `WGPU_NATIVE_INCLUDE` chose the directory. */
  readonly rid: string | null;
  /** wgpu-native generation of those headers, from the RID's `.version` stamp; `null` if unknown. */
  readonly generation: number | null;
  /** RIDs staged in `vendor/` whose generations disagree — empty unless the tree is mixed. */
  readonly mixed: readonly string[];
}

/**
 * Locate the headers to read, preferring this host's own RID.
 *
 * Returns `null` rather than throwing so each caller can phrase its own failure: the generator wants
 * "run `bun run fetch`", and the oracle wants to say why it refuses to skip.
 */
export function locateVendoredHeaders(): IVendoredHeaders | null {
  const override = process.env["WGPU_NATIVE_INCLUDE"];
  if (override) return { dir: override, rid: null, generation: null, mixed: [] };

  const vendor = path.join(PKG_ROOT, "vendor");
  const rids = fs.existsSync(vendor) ? fs.readdirSync(vendor).sort() : [];
  const has = (rid: string) => fs.existsSync(path.join(vendor, rid, "include", "webgpu.h"));
  const stampOf = (rid: string): string | null => {
    const stamp = path.join(vendor, rid, ".version");
    return fs.existsSync(stamp) ? fs.readFileSync(stamp, "utf-8").trim() : null;
  };

  for (const rid of [currentRid(), ...rids].filter((r, i, all) => all.indexOf(r) === i)) {
    if (!has(rid)) continue;
    const staged = rids.filter(has).map((r) => stampOf(r)).filter((v): v is string => v !== null);
    const tag = stampOf(rid);
    const m = tag ? /^v(\d+)\./.exec(tag) : null;
    return {
      dir: path.join(vendor, rid, "include"),
      rid,
      generation: m ? Number(m[1]) : null,
      mixed: new Set(staged).size > 1 ? rids.filter(has) : [],
    };
  }
  return null;
}

/**
 * Is this a supported generation other than the one the package ships?
 *
 * An unknown generation counts as the shipped one — the strict path. Choosing the lenient path from
 * missing information is how a check stops being one.
 */
export function isAlternateGeneration(headers: IVendoredHeaders): boolean {
  return headers.generation !== null && headers.generation !== DEFAULT_GENERATION;
}
