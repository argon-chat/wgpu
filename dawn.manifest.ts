/**
 * Dawn — the pin, and why this one needs a build step where wgpu-native does not.
 *
 * Dawn is Chromium's WebGPU implementation. This package is preparing to offer it as a second
 * implementation alongside wgpu-native, selected at runtime; see `docs/COMPATIBILITY.md`.
 *
 * ── The one structural difference from `wgpu-native.manifest.ts` ────────────────────────────────
 *
 * wgpu-native publishes **shared** libraries: fetch, verify the hash, done. Every Dawn release asset
 * is a **static archive** — `libwebgpu_dawn.a` / `webgpu_dawn.lib`, and nothing else. `bun:ffi`
 * needs something it can `dlopen`, so an archive is not a deliverable here; it is an *input*. The
 * shared library that ships is produced by this repository, in a public CI run, from the pinned
 * archive below.
 *
 * That gives the supply chain two pins rather than one, and both matter:
 *
 *   · **Input** — the tag, URL and sha256 in this file. Reproducible: anyone can fetch the same
 *     bytes and check them.
 *   · **Output** — the shared library published to npm, carrying a provenance attestation that
 *     binds a commit in this repository to those bytes.
 *
 * ── What was measured, and what it cost ─────────────────────────────────────────────────────────
 *
 * Linking `webgpu_dawn.lib` (613 MB expanded) into a DLL takes **under five seconds**. The link is
 * not the expensive part; the download is.
 *
 * ⚠ **The Windows link needs an MSVC toolset no older than the one Dawn was built with.** Measured:
 * linking the release below with MSVC 14.50.35717 fails on `__std_min_element_4u`,
 * `__std_max_element_4u` and `__std_min_element_8u` — vectorised STL helpers whose unsigned variants
 * that toolset does not ship. Dawn's own releases are built on `windows-latest`, so a link job on
 * the same image matches by construction; that is a reason to build this in CI rather than a
 * limitation of it. The failure is loud — unresolved externals, named — never a silently wrong
 * binary.
 *
 * ⚠ **Two properties are lost by re-linking carelessly.** Dawn's Linux release is built inside
 * `dockcross/manylinux_2_28` for a glibc 2.28 floor, and its macOS build sets a 12.0 deployment
 * target. A link on a bare runner silently forfeits both.
 */

import type { IArchiveAsset, Rid } from "./wgpu-native.manifest.ts";

/**
 * Pinned Dawn release.
 *
 * The tag identifies the release; the **commit sha** appears in every asset filename, which is why
 * the URLs below are written out literally rather than templated. That is the same rule
 * `wgpu-native.manifest.ts` follows, for the same reason: a literal URL stays greppable and cannot
 * be assembled wrongly.
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
 * ⚠ **`linux-arm64` is deliberately absent.** Google publishes no arm64 Linux desktop build in any
 * release, so there is nothing to pin. Supporting it means building Dawn from source for that one
 * platform (~20 minutes on an arm64 runner) — a different job in the same matrix, deferred rather
 * than pretended. A RID missing here is an unsupported platform, and the fetcher says so instead of
 * guessing an asset name.
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
 * Deliberately the same basename Dawn would have used for a shared build, so a reader who goes
 * looking for `webgpu_dawn` finds it — and deliberately *not* `wgpu_native`, so the two
 * implementations can never be confused for one another on disk.
 */
export function dawnLibFileName(platform: string = process.platform): string {
  if (platform === "win32") return "webgpu_dawn.dll";
  if (platform === "darwin") return "libwebgpu_dawn.dylib";
  return "libwebgpu_dawn.so";
}

/**
 * Static archive inside the release, relative to the extracted root.
 *
 * Windows puts it in `lib/` and Linux in `lib64/` — probed rather than assumed by the link script,
 * for the same reason the wgpu-native fetcher probes for its library: an upstream reshuffle should
 * surface as "not found in archive" rather than as an empty directory.
 */
export const DAWN_STATIC_BASENAMES = ["webgpu_dawn.lib", "libwebgpu_dawn.a"] as const;

/**
 * Extra runtime files that must travel with the library.
 *
 * Dawn loads the DirectX shader compiler dynamically on Windows; without `d3dcompiler_47.dll`
 * beside it, D3D12 device creation fails at runtime rather than at load, which is the hard kind of
 * bug to attribute. wgpu-native has no equivalent.
 */
export const DAWN_WINDOWS_RUNTIME_FILES = ["d3dcompiler_47.dll"] as const;
