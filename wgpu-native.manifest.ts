/**
 * wgpu-native binary manifest — the single source of truth for WHICH native library this package
 * binds to.
 *
 * Doctrine: binaries are **fetched, never committed**, and every download is pinned by an exact URL
 * plus a sha256 that hard-fails on mismatch. Committing them would put a per-platform blob in git
 * history and quietly decouple what ships from what is pinned.
 *
 * Consumed by:
 *   - scripts/fetch-wgpu-native.ts  — downloads + verifies + extracts into `vendor/<rid>/`
 *   - src/resolve.ts                — locates the extracted library at runtime
 *
 * ── Bumping the pin ─────────────────────────────────────────────────────────────────────────────
 * Edit `WGPU_NATIVE_TAG` and the URLs, then re-measure:
 *
 *     bun run scripts/fetch-wgpu-native.ts --update-hashes
 *
 * which downloads each pinned URL, prints manifest-ready lines, and writes nothing — a human pastes
 * them, so pinning stays a deliberate, reviewable edit. An entry whose sha256 is empty is treated as
 * unpinned and is REFUSED by the fetch script; that is on purpose, because a plausible-looking
 * invented hash in a supply-chain file is worse than a blank one.
 */

/** Runtime id: `${process.platform}-${process.arch}`. */
export type Rid = string;

/** Current RID for the running process (or an explicit platform/arch pair). */
export function currentRid(
  platform: string = process.platform,
  arch: string = process.arch,
): Rid {
  return `${platform}-${arch}`;
}

/** The `process.platform` half of a RID (`"win32-x64"` → `"win32"`). */
export function platformOf(rid: Rid): string {
  const dash = rid.indexOf("-");
  return dash === -1 ? rid : rid.slice(0, dash);
}

/** Platform-correct file name of the wgpu-native shared library. */
export function libFileName(platform: string = process.platform): string {
  if (platform === "win32") return "wgpu_native.dll";
  if (platform === "darwin") return "libwgpu_native.dylib";
  return "libwgpu_native.so";
}

/** One pinned release archive. */
export interface IArchiveAsset {
  /** Full download URL — kept literal and greppable, never templated from `version`. */
  url: string;
  /**
   * sha256 of the archive. EMPTY = unpinned = the fetch script refuses to install it.
   * Measure with `--update-hashes`; never hand-write a guess.
   */
  sha256: string;
}

/**
 * The pinned upstream release.
 *
 * {@link WGPU_NATIVE_TAG} is upstream's own 4-part tag; {@link WGPU_NATIVE_MAJOR} is the wgpu-core
 * generation, which is the number that matters when talking about ABI and validation behaviour.
 *
 * Pinning an exact tag rather than tracking latest is the point: wgpu-native's C ABI, its WGSL
 * acceptance and its validation strictness all move between generations, so "which wgpu" is part of
 * this package's contract with its callers, not an implementation detail.
 */
export const WGPU_NATIVE_TAG = "v29.0.1.1";
export const WGPU_NATIVE_MAJOR = 29;

/**
 * Per-RID release archives, restricted to the platforms Bun itself runs on.
 *
 * Upstream publishes ~40 assets per release (`wgpu-{platform}-{arch}[-{compiler}]-{release|debug}.zip`,
 * plus iOS/Android). Only the desktop `release` builds are listed here — a debug wgpu-native is ~10x
 * larger and its assertion behaviour differs, which is the wrong thing to make a test gate depend on.
 *
 * Notable omissions, on purpose:
 *   - `wgpu-windows-x86_64-gnu-*`  — the MSVC build is what Windows Bun links against.
 *   - `wgpu-windows-aarch64-msvc-*`, `wgpu-windows-i686-msvc-*` — Bun ships no such builds.
 *   - iOS / Android — out of scope for a Bun-hosted test harness.
 *
 * A RID absent from this map is not an error; it is simply an unsupported host (the fetch script
 * says so and exits non-zero, rather than guessing an asset name).
 */
export const ASSETS: Partial<Record<Rid, IArchiveAsset>> = {
  "win32-x64": {
    url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-windows-x86_64-msvc-release.zip",
    sha256: "7e67d7445c42aeb85e30f88930fd8d7d83ee769e3390aeb1ada75ebf3cf78132",
  },
  "darwin-arm64": {
    url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-macos-aarch64-release.zip",
    sha256: "a5797a37b1adf720bcd5dcffb291edbbd5b7b14be0a3874c28e6393a655a7a3e",
  },
  "darwin-x64": {
    url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-macos-x86_64-release.zip",
    sha256: "8e2f7378548ddd0e2cf21e7d864dda46e953f0af724855a33778b85ead206d41",
  },
  "linux-x64": {
    url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-linux-x86_64-release.zip",
    sha256: "95a4d90c071005a98d03eab348beaa6b07e16eb00d1dcdb9f8348f75eb97ec5a",
  },
  "linux-arm64": {
    url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-linux-aarch64-release.zip",
    sha256: "015fcdf1dbae82e614a783cc38017e5399ae0927a889fe9b69c9b664bc61b47a",
  },
};

/**
 * Headers shipped inside each archive, relative to wherever they land after extraction.
 *
 * We keep them (rather than extracting only the library) because two of the three candidate FFI
 * mechanisms need them at build time: `bun:ffi`'s `cc()` `#include`s them directly, and a Rust shim
 * crate would run bindgen over them. The hand-packed-ArrayBuffer mechanism does not need them, but
 * a human reading offsets does.
 *
 * Upstream sources are `ffi/webgpu-headers/webgpu.h` (the Khronos webgpu-native header) and
 * `ffi/wgpu.h` (wgpu-native's own extensions). Their in-archive layout is NOT hardcoded anywhere:
 * the fetch script probes the extracted tree for these basenames, so an upstream reshuffle shows up
 * as a clear "header not found" instead of a silently-empty include dir.
 */
export const HEADER_BASENAMES = ["webgpu.h", "wgpu.h"] as const;

/** Look up the archive for a RID. */
export function assetFor(rid: Rid = currentRid()): IArchiveAsset | undefined {
  return ASSETS[rid];
}

/** Every RID this manifest knows how to install. */
export function supportedRids(): Rid[] {
  return Object.keys(ASSETS);
}
