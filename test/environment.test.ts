/**
 * The gate on the gate.
 *
 * Every GPU suite in this package is `describe.skipIf(skipGpu)`. On its own that is a hole big
 * enough to drive a release through: a runner with no adapter, or a checkout with no native library,
 * would skip all of it and report a clean green. The same silent-green failure this package's error
 * path exists to prevent, one level up.
 *
 * This file closes it. It runs unconditionally and **fails** whenever the environment could not run
 * the GPU suites for a reason that was not explicitly permitted:
 *
 *   - no native library  → must be permitted by `WGPU_BUN_ALLOW_NO_LIBRARY=1`
 *   - no adapter         → must be permitted by `WGPU_BUN_ALLOW_NO_ADAPTER=1`
 *   - `requestDevice` failed with an adapter present → never permitted; that is a defect
 *   - the binding is unimplemented → permitted only while the package says so publicly (below)
 *
 * The permissions are env vars rather than auto-detection so that granting one is a visible, per-job
 * line in the CI workflow that a reviewer can see, and so that a local run never grants itself one.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { IMPLEMENTED, STATUS } from "../src/index.ts";
import { gate, skipIsPermitted } from "./support/gpu.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(PKG_ROOT, "README.md"), "utf-8");
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8")) as {
  version: string;
  name: string;
};

describe("the environment could run what it claims to have run", () => {
  test(`GPU gate resolved to "${gate.kind}", and that outcome is permitted`, () => {
    if (!skipIsPermitted()) {
      const detail = gate.kind === "ready" ? "" : gate.detail;
      throw new Error(
        `The GPU suites did not run, and nothing permitted that.\n\n` +
          `  gate: ${gate.kind}\n\n${detail}\n\n` +
          `  If this is a machine that genuinely has no GPU, set WGPU_BUN_ALLOW_NO_ADAPTER=1 —\n` +
          `  deliberately, per job, so the skip is visible in the run. Do not make it the default.`,
      );
    }
    expect(skipIsPermitted()).toBe(true);
  });
});

/**
 * The package's public claims must track `IMPLEMENTED`.
 *
 * `IMPLEMENTED === false` is what lets the GPU suites skip without failing the test above, which
 * would otherwise be a permanent loophole: leave the flag false forever and nothing ever has to run.
 * Binding the flag to the README banner and the version number closes it — the flag cannot stay
 * false on a package that presents itself as working, and it cannot be flipped to true without the
 * GPU suites becoming mandatory in the same commit.
 */
describe("status claims match the code", () => {
  // The one sentence that must be true of the README while `create()` cannot return a GPU. Chosen
  // to be a *claim about behaviour* rather than a mood word, so it stops being accurate the moment
  // the binding works and cannot be left in place out of habit.
  const PRE_ALPHA_MARKER = "`create()` throws";

  test("STATUS names the wgpu-native generation it targets", () => {
    expect(STATUS).toContain("wgpu-native");
    expect(STATUS).toMatch(/v?29/);
  });

  test.skipIf(IMPLEMENTED)("while unimplemented, the README says so and the version stays 0.0.x", () => {
    expect(readme).toContain(PRE_ALPHA_MARKER);
    expect(pkg.version).toMatch(/^0\.0\./);
  });

  test.skipIf(!IMPLEMENTED)("once implemented, the README drops the pre-alpha banner", () => {
    expect(readme).not.toContain(PRE_ALPHA_MARKER);
  });
});
