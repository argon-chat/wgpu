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
  test("wgpu-native keeps its per-platform defaults", () => {
    expect(resolveBackend({}, "linux")).toBe(C.backendType.vulkan);
    expect(resolveBackend({}, "darwin")).toBe(C.backendType.metal);
    // Not `win32` here: under wgpu-native it is D3D12, but this process's implementation is chosen
    // by the ambient env, and the Dawn branch of that decision reads the real filesystem. It is
    // covered by the host-specific suite above and by both CI legs.
  });

  test("an explicit backend is honoured verbatim, on every implementation", () => {
    // Deliberate: `backend=d3d12` under Dawn without DXC still fails, rather than quietly becoming
    // Vulkan. An override that selects something else is worse than an error, because the whole
    // reason this package states a backend is that the choice changes feature sets.
    expect(resolveBackend({ backend: "vulkan" }, "win32")).toBe(C.backendType.vulkan);
    expect(resolveBackend({ backend: "d3d12" }, "win32")).toBe(C.backendType.d3d12);
    expect(resolveBackend({ backend: "auto" }, "win32")).toBe(C.backendType.undefined);
  });
});
