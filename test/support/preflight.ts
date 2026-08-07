#!/usr/bin/env bun
/**
 * Report — before the suite runs — whether this machine can actually exercise a GPU.
 *
 *     bun run test/support/preflight.ts [--marker <path>]
 *
 * Always exits 0. It is a *reporter*, not a gate: whether a missing adapter is fatal is decided by
 * `test/environment.test.ts` against the `WGPU_BUN_ALLOW_NO_ADAPTER` policy, and deciding it twice
 * in two places is how the two answers end up disagreeing.
 *
 * What it adds over letting the suite speak for itself is a machine-readable marker file. CI writes
 * one per matrix leg and a final job reads them all, so the run as a whole can insist that *some*
 * platform really ran the GPU tests. Without that, five legs each legitimately skipping would add up
 * to a green run in which no GPU code executed anywhere — every individual skip defensible, the
 * aggregate meaningless.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { seamBoundMode, seamStatus } from "../../src/index.ts";
import { gate, skipIsPermitted } from "./gpu.ts";

const markerIdx = process.argv.indexOf("--marker");
const markerPath = markerIdx !== -1 ? process.argv[markerIdx + 1] : null;

const seam = seamStatus();

const summary = {
  platform: `${process.platform}-${process.arch}`,
  gate: gate.kind,
  permitted: skipIsPermitted(),
  adapter: gate.kind === "ready" ? gate.adapterLabel : null,
  // Reported unconditionally, not only on a refusal. Which calling path a green run took is the
  // thing a reader most wants to know when comparing two legs of the matrix, and inferring it from
  // the absence of an error is how the previous misclassification survived.
  seam: seam.mode,
  // What was RESOLVED and what was actually BOUND are different facts, and only the second proves a
  // path executed. `gpu.ts` has already run a full adapter+device acquisition by the time this is
  // read, so a null here on a `ready` gate would mean the seam was never reached at all.
  seamBound: seamBoundMode(),
  seamRequested: process.env["WGPU_BUN_SEAM"] ?? "auto",
  seamReason: seam.reason,
  shim: seam.shim ? `${seam.shim.version ?? "?"} via ${seam.shim.source}` : null,
  shimPath: seam.shim?.path ?? null,
  shimRequired: seam.shimRequired,
  detail: gate.kind === "ready" ? null : gate.detail,
};

console.log(`\nwgpu-bun GPU preflight — ${summary.platform}`);
console.log(`  gate      : ${summary.gate}`);
console.log(`  adapter   : ${summary.adapter ?? "(none)"}`);
// Printed unconditionally and in full. The deadline error tells a reader to check `seamStatus()`
// and `seamBoundMode()`; before this it gave them no way to see either, which is a gap worth closing
// whatever the cause turns out to be.
console.log(`  seam      : requested=${summary.seamRequested} resolved=${summary.seam} bound=${summary.seamBound ?? "(not bound)"}`);
console.log(`  shim      : ${summary.shimPath ?? "(none installed)"}${summary.shim ? ` — ${summary.shim}` : ""}`);
console.log(`  shim req'd: ${summary.shimRequired}`);
console.log(`  seam why  : ${summary.seamReason}`);
console.log(`  permitted : ${summary.permitted}`);
if (summary.detail) console.log(`  detail    : ${summary.detail.split("\n")[0]}`);
console.log("");

if (process.env["GITHUB_STEP_SUMMARY"]) {
  const row =
    gate.kind === "ready"
      ? `| \`${summary.platform}\` | ✅ ran (${summary.seam}) | ${summary.adapter} |`
      : `| \`${summary.platform}\` | ⚠️ skipped (${gate.kind}) | — |`;
  fs.appendFileSync(process.env["GITHUB_STEP_SUMMARY"]!, `${row}\n`);
}

if (markerPath) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify(summary, null, 2)}\n`);
}
