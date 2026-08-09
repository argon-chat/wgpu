/**
 * The three export filters, checked against both surfaces the fused library carries.
 *
 * A Dawn build links two things into one library: Dawn's `wgpu*` C API and the shim's
 * `wgpu_bun_shim_*` trampolines. Each platform states "export exactly these" in its own dialect, so
 * "remembered one surface, forgot the other, on one platform" is three separate chances to be wrong
 * — and the class has already bitten twice here, both times silently, because neither an ELF version
 * script nor a Mach-O exports list fails when it matches nothing.
 *
 * These tests are cheap precisely because the filters are pure functions over a name list. The
 * expensive check — that the linker then actually produced those symbols — happens in CI, on all
 * three platforms, and cannot be replaced by this.
 */

import { describe, expect, test } from "bun:test";

import { SHIM_EXPORTS } from "../src/ffi/abiSeam.ts";
import {
  coveredByElfScript,
  elfVersionScript,
  ELF_GLOBAL_PATTERNS,
  machOExportsList,
  windowsDefFile,
} from "../scripts/exportFilters.ts";

/** Stand-ins for Dawn's C API, shaped like the real names. */
const DAWN = ["wgpuCreateInstance", "wgpuDeviceCreateBuffer", "wgpuQueueSubmit"];
const BOTH = [...DAWN, ...SHIM_EXPORTS];

describe("every filter carries both surfaces", () => {
  test("the Windows .def lists Dawn's API and the shim's", () => {
    const def = windowsDefFile(BOTH);
    expect(def.startsWith("EXPORTS\n")).toBe(true);
    for (const name of BOTH) expect(def).toContain(`\n    ${name}`);
  });

  test("the Mach-O list underscores every name, including the shim's", () => {
    const list = machOExportsList(BOTH);
    for (const name of BOTH) expect(list.split("\n")).toContain(`_${name}`);
    // Not one bare name: an entry without the Mach-O prefix matches no symbol, and ld will not say
    // so. The one that regressed here was the whole API.
    expect(list.split("\n").filter((l) => l && !l.startsWith("_"))).toEqual([]);
  });

  test("the ELF version script's pattern covers both surfaces", () => {
    for (const name of BOTH) expect(coveredByElfScript(name)).toBe(true);
  });

  test("the ELF script hides what is not ours", () => {
    // The staticlib drags in Rust's std; `local: *` is what keeps those out of the global namespace,
    // along with Dawn's ~600 000 vendored tint/absl/SPIRV symbols.
    expect(elfVersionScript()).toContain("local: *;");
    for (const alien of ["_ZN4core3fmt5Write", "tint_program_build", "absl_log_internal", "main"]) {
      expect(coveredByElfScript(alien)).toBe(false);
    }
  });
});

describe("the shim's names are compatible with a single ELF pattern", () => {
  test("every shim export begins with the prefix the pattern matches", () => {
    // This is the fact the Linux path depends on: one `wgpu*` glob exports both surfaces. If a
    // trampoline were ever named outside that prefix, Linux would export it nowhere and say nothing.
    expect(ELF_GLOBAL_PATTERNS).toEqual(["wgpu*"]);
    for (const name of SHIM_EXPORTS) expect(name.startsWith("wgpu")).toBe(true);
  });

  test("the shim surface is not empty and is what the seam binds", () => {
    // A `SHIM_EXPORTS` that silently became empty would make every filter above pass while fusing
    // nothing, and the post-link check would have no names to miss.
    expect(SHIM_EXPORTS.length).toBeGreaterThanOrEqual(15);
    expect(SHIM_EXPORTS).toContain("wgpu_bun_shim_open");
    expect(SHIM_EXPORTS).toContain("wgpu_bun_shim_trampoline");
  });
});
