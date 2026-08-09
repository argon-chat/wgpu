/**
 * Dawn — the pin, and why this one needs a build step where wgpu-native does not.
 *
 * Dawn is Chromium's WebGPU implementation, offered here as a second implementation alongside
 * wgpu-native and selected at runtime with `WGPU_BUN_IMPL=dawn`; see `docs/DAWN.md`.
 *
 * ── The one structural difference from `wgpu-native.manifest.ts` ────────────────────────────────
 *
 * wgpu-native publishes **shared** libraries: fetch, verify the hash, done. Every Dawn release asset
 * is a **static archive** — `libwebgpu_dawn.a` / `webgpu_dawn.lib`, and nothing else. `bun:ffi` needs
 * something it can `dlopen`, so the archive is an *input*, not a deliverable: the shared library that
 * ships is produced by this repository, in a public CI run, from the pinned archive below. The
 * supply chain therefore has two pins — the **input** (tag, URL and sha256 here, so anyone can fetch
 * the same bytes and check them) and the **output** (the npm-published shared library, carrying a
 * provenance attestation binding a commit in this repository to those bytes).
 *
 * ── The one thing that can go wrong in the link ─────────────────────────────────────────────────
 *
 * ⚠ **The Windows link needs an MSVC toolset no older than the one Dawn was built with.** Measured:
 * linking the release below with MSVC 14.50.35717 fails on `__std_min_element_4u`,
 * `__std_max_element_4u` and `__std_min_element_8u` — vectorised STL helpers whose unsigned variants
 * that toolset does not ship. Dawn's own releases are built on `windows-latest`, so a link job on the
 * same image matches by construction. The failure is loud — unresolved externals, named — never a
 * silently wrong binary.
 *
 * ⚠ **A glibc floor is lost by re-linking carelessly.** Dawn's Linux release is built inside
 * `dockcross/manylinux_2_28` for glibc 2.28, and a link on a bare runner silently forfeits it. macOS
 * needs no deployment-target override — the archive's objects carry their own minimum, and an earlier
 * revision forced 12.0 from a summary of Dawn's CI rather than from the archive. See
 * `scripts/dawn-link.ts`.
 */

import type { IArchiveAsset, Rid } from "./wgpu-native.manifest.ts";

/**
 * Pinned Dawn release.
 *
 * The tag identifies the release; the **commit sha** appears in every asset filename, which is why
 * the URLs below are literal rather than templated — the same rule `wgpu-native.manifest.ts` follows,
 * because a literal URL stays greppable and cannot be assembled wrongly.
 *
 * Dawn tags are `vYYYYMMDD.HHMMSS`, cut from `main`, with no semver and no LTS line — so this pin
 * names a commit, not a supported version. `upstream.manifest.ts` therefore tracks Dawn on a
 * six-month cadence rather than by version.
 */
export const DAWN_TAG = "v20260807.193620";
export const DAWN_COMMIT = "c23537c0682b5bf9c2636e0818a3a8a00591b3c3";

/**
 * Per-platform release archives, pinned by measured sha256.
 *
 * ⚠ **`linux-arm64` is deliberately absent.** Google publishes no arm64 Linux desktop build, so there
 * is nothing to pin. Supporting it means building Dawn from source for that one platform (~20 minutes
 * on an arm64 runner) — deferred rather than pretended. A RID missing here is an unsupported
 * platform, and the fetcher says so instead of guessing an asset name.
 */
export const DAWN_ASSETS: Partial<Record<Rid, IArchiveAsset>> = {
  "win32-x64": {
    url: "https://github.com/google/dawn/releases/download/v20260807.193620/Dawn-c23537c0682b5bf9c2636e0818a3a8a00591b3c3-windows-latest-Release.tar.gz",
    sha256: "de85f953e1c914e7e3a392eaa59e748b0ff95ff2992318c83f131804101bd096",
  },
  "linux-x64": {
    url: "https://github.com/google/dawn/releases/download/v20260807.193620/Dawn-c23537c0682b5bf9c2636e0818a3a8a00591b3c3-ubuntu-latest-Release.tar.gz",
    sha256: "4de357e8ac30c7c4ddf7ef5e4328bf99f844aa7a9ced8b216b5c3293c3a6346c",
  },
  "darwin-arm64": {
    url: "https://github.com/google/dawn/releases/download/v20260807.193620/Dawn-c23537c0682b5bf9c2636e0818a3a8a00591b3c3-macos-latest-Release.tar.gz",
    sha256: "4c63e57a1f92e5521bd8b096a5e72c3633149ed87140a6460cf033b77cd18923",
  },
};

/** Every RID a Dawn library can be produced for today. */
export function dawnRids(): Rid[] {
  return Object.keys(DAWN_ASSETS);
}

/** Look up the pinned archive for a RID. */
export function dawnAssetFor(rid: Rid): IArchiveAsset | undefined {
  return DAWN_ASSETS[rid];
}

/**
 * Name of the shared library this repository produces from the archive above.
 *
 * The same basename Dawn would use for a shared build, so a reader looking for `webgpu_dawn` finds
 * it — and never `wgpu_native`, so the two implementations cannot be confused on disk.
 */
export function dawnLibFileName(platform: string = process.platform): string {
  if (platform === "win32") return "webgpu_dawn.dll";
  if (platform === "darwin") return "libwebgpu_dawn.dylib";
  return "libwebgpu_dawn.so";
}

/**
 * Static archive inside the release, relative to the extracted root.
 *
 * Windows puts it in `lib/` and Linux in `lib64/` — probed rather than assumed by the link script, so
 * an upstream reshuffle surfaces as "not found in archive" rather than as an empty directory.
 */
export const DAWN_STATIC_BASENAMES = ["webgpu_dawn.lib", "libwebgpu_dawn.a"] as const;

/**
 * Extra runtime files Dawn's D3D12 backend loads on Windows.
 *
 * **Measured by execution.** The first version of this constant guessed `d3dcompiler_47.dll` (what an
 * older D3D stack needs) and nothing checked it, because the release archive contains no DLLs at all.
 * Pointing the binding at the linked Dawn library produced the real answer, from Dawn's own error:
 *
 *     requestDevice failed (status 3) DynamicLib.Open: dxil.dll Windows Error: 87
 *         at EnsureDXCLibraries (dawn/native/d3d12/PlatformFunctionsD3D12.cpp:212)
 *
 * Dawn compiles WGSL to DXIL through **DXC**, loaded dynamically, so `dxcompiler.dll` and `dxil.dll`
 * must sit beside the library or D3D12 device creation fails — at `requestDevice`, not at load, which
 * is the hard kind of failure to attribute. Both ship in the Windows SDK
 * (`Windows Kits/10/bin/<version>/x64`) and in Microsoft's DirectXShaderCompiler releases; neither is
 * in Google's Dawn archive.
 *
 * **Nothing here is redistributed** — `dxil.dll` is closed-source Microsoft code. `src/dawnRuntime.ts`
 * preloads whatever is already on the machine, by absolute path, and falls back to Vulkan
 * (`vulkan-1.dll`, present with any GPU driver) when DXC is not there.
 *
 * wgpu-native has no equivalent requirement: naga emits DXIL-free bytecode paths and its D3D12
 * backend does not link DXC.
 *
 * @see src/dawnRuntime.ts — the resolution and preload, the redistribution decision, and the
 *      measurements behind both.
 */
export const DAWN_WINDOWS_RUNTIME_FILES = ["dxcompiler.dll", "dxil.dll"] as const;

/**
 * Dawn's Vulkan loader on Windows.
 *
 * The other half of the same problem, and why the D3D12 dependency is survivable: this one ships with
 * every GPU driver, so an ordinary machine has it even without a Windows SDK.
 */
export const DAWN_WINDOWS_VULKAN_LOADER = "vulkan-1.dll";
