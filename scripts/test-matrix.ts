#!/usr/bin/env bun
/**
 * Run the suite across every implementation × backend this host can actually reach.
 *
 *     bun run test:matrix
 *     bun run test:matrix --impl dawn          # one implementation
 *     bun run test:matrix -- --timeout 60000   # anything after `--` goes to `bun test`
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * The backend is a **correctness knob on this binding**, not a preference: the same GPU exposes
 * different features through different APIs — `shader-f16` is present on Vulkan and absent on D3D12
 * for the reference adapter — and the two implementations disagree about more than that. A suite
 * that only ever runs the host default therefore proves one cell of a table and reads like the whole
 * table.
 *
 * CI cannot fill it in: every runner has exactly one usable backend (WARP is D3D12-only, lavapipe is
 * Vulkan-only, macOS is Metal). A developer machine with a real GPU has two, and this is what makes
 * running both one command instead of a habit.
 *
 * It has already earned itself. The first four-way sweep found that an **explicit**
 * `WGPU_BUN_BACKEND` under Dawn on Windows never preloaded Dawn's dynamically-loaded dependency —
 * the preload had been wired into the default-backend branch only — so `backend=vulkan` reported
 * "requestAdapter() resolved to null — no GPU on this host" on a machine with a GPU. Both default
 * paths were green throughout.
 *
 * ⚠ A combination that cannot run **is reported, never skipped quietly**. An implementation that is
 * not installed prints a line saying so and does not count as a pass.
 */

import { spawnSync } from "node:child_process";

import { WGPU_IMPLS, type WgpuImpl } from "../src/impl.ts";
import { tryResolveNativeLibrary } from "../src/resolve.ts";
import { currentRid } from "../wgpu-native.manifest.ts";

/** Backends worth trying per platform — the ones an implementation can actually reach there. */
function backendsFor(platform: string): string[] {
  if (platform === "win32") return ["d3d12", "vulkan"];
  if (platform === "darwin") return ["metal"];
  return ["vulkan"];
}

interface IOutcome {
  readonly impl: WgpuImpl;
  readonly backend: string;
  readonly status: "pass" | "fail" | "unavailable";
  readonly detail: string;
}

function run(impl: WgpuImpl, backend: string, extra: string[]): IOutcome {
  const r = spawnSync("bun", ["test", ...extra], {
    encoding: "utf-8",
    env: { ...process.env, WGPU_BUN_IMPL: impl, WGPU_BUN_BACKEND: backend },
  });
  // `bun test` writes its summary to stderr.
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const pass = /^\s*(\d+) pass/m.exec(output)?.[1] ?? "?";
  const fail = /^\s*(\d+) fail/m.exec(output)?.[1] ?? "?";
  const detail = `${pass} pass, ${fail} fail`;
  if (r.status === 0) return { impl, backend, status: "pass", detail };
  // The first failing test name, so the table is a diagnosis rather than a scoreboard.
  const first = /^\(fail\) (.+?)(?: \[|$)/m.exec(output)?.[1];
  return { impl, backend, status: "fail", detail: first ? `${detail} — ${first}` : detail };
}

function main(argv: string[]): void {
  const dashDash = argv.indexOf("--");
  const extra = dashDash === -1 ? [] : argv.slice(dashDash + 1);
  const args = dashDash === -1 ? argv : argv.slice(0, dashDash);

  const implIdx = args.indexOf("--impl");
  const impls: readonly WgpuImpl[] =
    implIdx === -1 ? WGPU_IMPLS : [args[implIdx + 1] as WgpuImpl];

  const platform = process.platform;
  const rid = currentRid();
  const outcomes: IOutcome[] = [];

  for (const impl of impls) {
    const installed = tryResolveNativeLibrary(rid, platform, impl);
    if (!installed) {
      outcomes.push({
        impl,
        backend: "—",
        status: "unavailable",
        detail:
          impl === "dawn"
            ? "not installed: bun run dawn:fetch && bun run dawn:link"
            : "not installed: bun run fetch",
      });
      continue;
    }
    for (const backend of backendsFor(platform)) {
      process.stdout.write(`\x1b[36m·\x1b[0m      ${impl} / ${backend} …\n`);
      outcomes.push(run(impl, backend, extra));
    }
  }

  console.log(`\n  ${rid}\n`);
  for (const o of outcomes) {
    const mark =
      o.status === "pass" ? "\x1b[32mpass\x1b[0m" : o.status === "fail" ? "\x1b[31mFAIL\x1b[0m" : "\x1b[33mn/a \x1b[0m";
    console.log(`  ${mark}  ${`${o.impl} / ${o.backend}`.padEnd(24)} ${o.detail}`);
  }
  console.log("");

  const failed = outcomes.filter((o) => o.status === "fail").length;
  const unavailable = outcomes.filter((o) => o.status === "unavailable").length;
  if (unavailable > 0) {
    // Loud, and not an error: a machine without Dawn installed is a normal state, and the point is
    // that the cell is visibly empty rather than quietly absent from the table.
    console.log(`  ${unavailable} combination(s) could not run. They are not passes.\n`);
  }
  if (failed > 0) process.exit(1);
}

main(process.argv.slice(2));
