/**
 * Implementation selection: the env var, and what it changes about resolution.
 *
 * These are the pure parts — parsing, naming, and which package/file/stamp each implementation
 * looks for. Whether the selected library then *works* is not a unit test's business; that is
 * `bun test` run with `WGPU_BUN_IMPL=dawn` against a real Dawn build, on a machine that has one.
 */

import { describe, expect, test } from "bun:test";

import {
  currentImpl,
  DEFAULT_IMPL,
  IMPL_ENV_VAR,
  isWgpuImpl,
  WGPU_IMPLS,
} from "../src/impl.ts";
import { DAWN_ENV_VAR, LIB_ENV_VAR, npmPackageFor, shimSearchPath } from "../src/resolve.ts";

describe("selecting an implementation", () => {
  test("unset means the default, and the default is wgpu-native", () => {
    expect(currentImpl({})).toBe(DEFAULT_IMPL);
    expect(currentImpl({ [IMPL_ENV_VAR]: "" })).toBe("wgpu-native");
    expect(DEFAULT_IMPL).toBe("wgpu-native");
  });

  test("both implementations are selectable, case- and space-insensitively", () => {
    expect(currentImpl({ [IMPL_ENV_VAR]: "dawn" })).toBe("dawn");
    expect(currentImpl({ [IMPL_ENV_VAR]: " Dawn " })).toBe("dawn");
    expect(currentImpl({ [IMPL_ENV_VAR]: "wgpu-native" })).toBe("wgpu-native");
  });

  test("a misspelling is an error, never a silent fallback", () => {
    // The whole point. A typo that quietly loaded the default would report success while measuring
    // the other implementation — in a package whose reason to exist is knowing what ran.
    expect(() => currentImpl({ [IMPL_ENV_VAR]: "dwan" })).toThrow(/not a supported implementation/);
    expect(() => currentImpl({ [IMPL_ENV_VAR]: "dwan" })).toThrow(/wgpu-native, dawn/);
    expect(() => currentImpl({ [IMPL_ENV_VAR]: "chromium" })).toThrow();
  });

  test("the guard and the list agree", () => {
    for (const impl of WGPU_IMPLS) expect(isWgpuImpl(impl)).toBe(true);
    expect(isWgpuImpl("dwan")).toBe(false);
    expect(isWgpuImpl("")).toBe(false);
  });
});

describe("what an implementation changes about resolution", () => {
  test("each implementation has its own per-platform package", () => {
    expect(npmPackageFor("darwin-arm64", "wgpu-native")).toBe("@wgpu-bun/darwin-arm64");
    expect(npmPackageFor("darwin-arm64", "dawn")).toBe("@wgpu-bun/darwin-arm64-dawn");
    // The suffix, not a separate scope: one `optionalDependencies` block can then name every
    // platform of both, and a missing Dawn install fails with a name that can be searched for.
    expect(npmPackageFor("win32-x64", "dawn").startsWith(npmPackageFor("win32-x64", "wgpu-native"))).toBe(true);
  });

  test("each implementation has its own explicit-path override", () => {
    expect(LIB_ENV_VAR).toBe("WGPU_NATIVE_LIB");
    expect(DAWN_ENV_VAR).toBe("WGPU_DAWN_LIB");
    expect(DAWN_ENV_VAR).not.toBe(LIB_ENV_VAR);
  });

  test("under Dawn the shim is not a separate file, and the message says so", () => {
    // The fused build is the only one this repository produces, so "where is the shim" has a
    // different answer rather than a missing one. A search path that still listed three tiers would
    // send someone looking for a file that is not supposed to exist.
    const dawn = shimSearchPath("linux-x64", "linux", "dawn");
    expect(dawn).toContain("linked into it");
    expect(dawn).toContain("@wgpu-bun/linux-x64-dawn");
    expect(dawn).not.toContain("WGPU_BUN_SHIM_LIB");

    const native = shimSearchPath("linux-x64", "linux", "wgpu-native");
    expect(native).toContain("WGPU_BUN_SHIM_LIB");
    expect(native).toContain("libwgpu_bun_shim.so");
  });
});
