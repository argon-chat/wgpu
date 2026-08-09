/**
 * Dawn's Windows dependencies: what is looked for, and what is said when nothing is found.
 *
 * The resolution itself is measured by running — locally against a real device, and in CI on the
 * `win32-x64` leg, which deliberately does **not** copy DXC into place so that the preload path is
 * the one under test. What is checked here is the part a failing machine depends on: that the
 * search covers the two places these files actually live, and that the refusal names both ways out
 * instead of a Win32 error number.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { DAWN_WINDOWS_RUNTIME_FILES, DAWN_WINDOWS_VULKAN_LOADER } from "../dawn.manifest.ts";
import { dawnWindowsDepsMessage, preloadDawnWindowsDeps, type IDawnWindowsDeps } from "../src/dawnRuntime.ts";
import { resolveBackend } from "../src/api/gpu.ts";
import { nativeLibrary } from "../src/ffi/library.ts";
import { C } from "../src/enums.ts";

describe("what Dawn needs on Windows", () => {
  test("the two dependencies are named in one place", () => {
    // `src/dawnRuntime.ts` builds its probe list from these, so a rename cannot leave the finder
    // looking for one name while the documentation states another.
    expect([...DAWN_WINDOWS_RUNTIME_FILES]).toEqual(["dxcompiler.dll", "dxil.dll"]);
    expect(DAWN_WINDOWS_VULKAN_LOADER).toBe("vulkan-1.dll");
  });

  test("the refusal names both ways out and says nothing is shipped", () => {
    const deps: IDawnWindowsDeps = { vulkan: false, dxc: false, searched: ["C:\\nowhere\\dxil.dll"] };
    const message = dawnWindowsDepsMessage(deps);
    for (const needle of ["vulkan-1.dll", "dxcompiler.dll", "dxil.dll", "Windows SDK", "ships neither"]) {
      expect(message).toContain(needle);
    }
    // The paths actually tried. Without them the message is advice; with them it is a diagnosis.
    expect(message).toContain("C:\\nowhere\\dxil.dll");
  });
});

describe.skipIf(process.platform !== "win32")("the search on this host", () => {
  test("looks beside the library and in the system locations", () => {
    const libDir = path.join("Z:", "somewhere", "lib");
    const deps = preloadDawnWindowsDeps(libDir);
    const joined = deps.searched.join("\n");

    // Beside the library first — someone who put a build there meant it.
    expect(joined).toContain(path.join(libDir, DAWN_WINDOWS_VULKAN_LOADER));
    // Then the places Windows actually keeps them: System32 for the loader, the SDK for DXC.
    expect(joined).toMatch(/System32[\\/]vulkan-1\.dll/i);
    expect(joined).toMatch(/Windows Kits[\\/]10[\\/]bin/i);

    // Something must have been found on a developer machine or a GitHub runner; both have at least
    // one. A run where neither is present would make the CI leg's Dawn suite unrunnable, and this
    // says so here rather than 300 tests later.
    expect(deps.vulkan || deps.dxc).toBe(true);
  });
});

describe("backend selection is untouched where it was already decided", () => {
  // ⚠ Every call here states the implementation as well as the platform, and that is not verbosity.
  // `resolveBackend` used to take the platform as a parameter and read the implementation from the
  // ambient environment, so these very assertions — which name `"win32"` — entered the
  // Dawn-on-Windows branch when the suite ran under `WGPU_BUN_IMPL=dawn`, and tried to preload
  // `C:\Windows\System32\vulkan-1.dll` on a macOS runner. Two legs failed; the Windows leg went
  // green, because there the DLLs exist and the test passed for a reason it was not asserting.

  test("wgpu-native keeps its per-platform defaults", () => {
    expect(resolveBackend({}, "linux", "wgpu-native")).toBe(C.backendType.vulkan);
    expect(resolveBackend({}, "darwin", "wgpu-native")).toBe(C.backendType.metal);
    expect(resolveBackend({}, "win32", "wgpu-native")).toBe(C.backendType.d3d12);
  });

  test("an explicit backend is honoured verbatim", () => {
    // Deliberate: `backend=d3d12` under Dawn without DXC still fails, rather than quietly becoming
    // Vulkan. An override that selects something else is worse than an error, because the whole
    // reason this package states a backend is that the choice changes feature sets. That refusal is
    // asserted on a real host below, where the dependencies are real too.
    expect(resolveBackend({ backend: "vulkan" }, "win32", "wgpu-native")).toBe(C.backendType.vulkan);
    expect(resolveBackend({ backend: "d3d12" }, "win32", "wgpu-native")).toBe(C.backendType.d3d12);
    expect(resolveBackend({ backend: "auto" }, "win32", "wgpu-native")).toBe(C.backendType.undefined);
    expect(resolveBackend({ backend: "metal" }, "darwin", "wgpu-native")).toBe(C.backendType.metal);
  });

  test("an unknown backend names the ones that exist", () => {
    expect(() => resolveBackend({ backend: "mantle" }, "win32", "wgpu-native")).toThrow(/unknown backend/);
    expect(() => resolveBackend({ backend: "mantle" }, "win32", "wgpu-native")).toThrow(/vulkan/);
  });
});

describe.skipIf(process.platform !== "win32")("Dawn's backend decision, on a real Windows host", () => {
  test("the default is one this machine can actually run", () => {
    // Not a fixed expectation: which backend is correct here depends on what is installed, and that
    // is the entire point of the decision. What must hold is that it picks something whose
    // dependency was found — never D3D12 without DXC, never Vulkan without a loader.
    const deps = preloadDawnWindowsDeps(path.dirname(nativeLibrary().path));
    const chosen = resolveBackend({ quiet: true }, "win32", "dawn");
    if (deps.dxc) expect(chosen).toBe(C.backendType.d3d12);
    else if (deps.vulkan) expect(chosen).toBe(C.backendType.vulkan);
    else throw new Error("neither dependency present; the earlier suite should have failed first");
  });

  test("an explicit backend whose dependency is absent is refused, not redirected", () => {
    const deps = preloadDawnWindowsDeps(path.dirname(nativeLibrary().path));
    // Only assertable for a dependency this host lacks — and on a host that has both, there is
    // nothing to refuse, which is a pass rather than a gap.
    if (!deps.dxc) {
      expect(() => resolveBackend({ backend: "d3d12" }, "win32", "dawn")).toThrow(/cannot run under Dawn/);
    }
    if (!deps.vulkan) {
      expect(() => resolveBackend({ backend: "vulkan" }, "win32", "dawn")).toThrow(/cannot run under Dawn/);
    }
    expect(deps.dxc || deps.vulkan).toBe(true);
  });
});
