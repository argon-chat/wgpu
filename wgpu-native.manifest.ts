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

/** One wgpu-native generation: upstream's 4-part tag, and the archives it published. */
export interface IGeneration {
  /** Upstream's own tag, e.g. `v29.0.1.1`. */
  readonly tag: string;
  /**
   * Per-RID release archives, restricted to the platforms Bun itself runs on.
   *
   * Upstream publishes ~40 assets per release
   * (`wgpu-{platform}-{arch}[-{compiler}]-{release|debug}.zip`, plus iOS/Android). Only the desktop
   * `release` builds are listed — a debug wgpu-native is ~10× larger and its assertion behaviour
   * differs, which is the wrong thing to make a test gate depend on.
   *
   * Notable omissions, on purpose:
   *   - `wgpu-windows-x86_64-gnu-*`  — the MSVC build is what Windows Bun links against.
   *   - `wgpu-windows-aarch64-msvc-*`, `wgpu-windows-i686-msvc-*` — Bun ships no such builds.
   *   - Intel macOS — Apple has finished its own x86_64 transition and the hosted runner image has
   *     an announced end date. `linux-x64` remains as the SysV x86-64 target the ABI shim exists for.
   *   - iOS / Android — out of scope for a Bun-hosted test harness.
   */
  readonly assets: Partial<Record<Rid, IArchiveAsset>>;
}

/**
 * Every wgpu-native generation this package can bind, keyed by wgpu-core major.
 *
 * ── Why there is more than one ──────────────────────────────────────────────────────────────────
 *
 * A binding's *reason to exist* is that you can pick the implementation your shaders are validated
 * against (see `docs/ERROR-PATH.md`). Pinning exactly one generation takes half of that back: a
 * project whose Rust half is on wgpu 27 cannot have its JavaScript half validated against wgpu 27.
 *
 * Supporting several is only defensible because it was **measured**, not assumed. Between v27 and
 * v29 the entire generated layout table set is byte-identical, every symbol the binding calls is
 * present in both, and the full suite — render, compute, error scopes, readback, both seam paths —
 * runs green on either library. The only difference the suite could find is that four blocklisted
 * abort-on-call symbols do not exist at all in v27, which `src/ffi/unimplemented.ts` records.
 *
 * That measurement is the entry criterion. A generation goes in this map when a CI leg runs the
 * suite against it, and not before — `docs/GENERATIONS.md` says what adding one costs.
 *
 * ⚠ The `wgpu.h` extension enums (`WGPUNativeSType`, `WGPUNativeFeature`) DO renumber between
 * generations — `ShaderSourceGLSL` is `0x00030004` in v27 and `0x00030003` in v29. This binding
 * touches none of them, which is why it survives the move; anything added that does must become
 * per-generation, and it will fail silently rather than loudly if it is not.
 */
export const GENERATIONS: Readonly<Record<number, IGeneration>> = {
  29: {
    tag: "v29.0.1.1",
    assets: {
      "win32-x64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-windows-x86_64-msvc-release.zip",
        sha256: "7e67d7445c42aeb85e30f88930fd8d7d83ee769e3390aeb1ada75ebf3cf78132",
      },
      "darwin-arm64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-macos-aarch64-release.zip",
        sha256: "a5797a37b1adf720bcd5dcffb291edbbd5b7b14be0a3874c28e6393a655a7a3e",
      },
      "linux-x64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-linux-x86_64-release.zip",
        sha256: "95a4d90c071005a98d03eab348beaa6b07e16eb00d1dcdb9f8348f75eb97ec5a",
      },
      "linux-arm64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v29.0.1.1/wgpu-linux-aarch64-release.zip",
        sha256: "015fcdf1dbae82e614a783cc38017e5399ae0927a889fe9b69c9b664bc61b47a",
      },
    },
  },
  27: {
    tag: "v27.0.4.1",
    assets: {
      "win32-x64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v27.0.4.1/wgpu-windows-x86_64-msvc-release.zip",
        sha256: "cbb15ac6499476bd555190922142a466ba91ec9032cc6bef5e59063e829425ea",
      },
      "darwin-arm64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v27.0.4.1/wgpu-macos-aarch64-release.zip",
        sha256: "214fa6aa3a6d011643f1dcbc5a971db6f9d110f97f94a4c0b7e1e31271ef3b00",
      },
      "linux-x64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v27.0.4.1/wgpu-linux-x86_64-release.zip",
        sha256: "9385b8a9e4e6f0b00264757577511097104fedf6db7819aa3e34a106c3dc0a42",
      },
      "linux-arm64": {
        url: "https://github.com/gfx-rs/wgpu-native/releases/download/v27.0.4.1/wgpu-linux-aarch64-release.zip",
        sha256: "0d8b0172ccc811a811d6813c2d97e0a7e89926f8f618694b595a8c9f7f89e059",
      },
    },
  },
};

/**
 * Every supported generation, newest first.
 *
 * Note the gap: upstream published v25, then v27, then v29 — there is no v26 or v28. The list is
 * what exists and has been tested, not a range.
 */
export const SUPPORTED_GENERATIONS: readonly number[] = Object.keys(GENERATIONS)
  .map(Number)
  .sort((a, b) => b - a);

/**
 * The generation this package **ships**: what the platform npm packages carry, what `bun run fetch`
 * installs by default, and what the package's own major version names.
 *
 * The others are *accepted at runtime* — point `WGPU_NATIVE_LIB` at one, or
 * `bun run fetch --generation 27` — but nothing is published for them. One tarball cannot carry two
 * libraries and pretend the choice is free.
 */
export const DEFAULT_GENERATION = 29;

/** The default generation's tag. `29.x` of this package binds this exact upstream release. */
export const WGPU_NATIVE_TAG = GENERATIONS[DEFAULT_GENERATION]!.tag;
/** The default generation's wgpu-core major — the number this package's own major mirrors. */
export const WGPU_NATIVE_MAJOR = DEFAULT_GENERATION;

/** Archives of one generation, defaulting to the shipped one. */
export const ASSETS: Partial<Record<Rid, IArchiveAsset>> = GENERATIONS[DEFAULT_GENERATION]!.assets;

/** Look up a generation, or throw naming the ones that exist. */
export function generation(major: number = DEFAULT_GENERATION): IGeneration {
  const found = GENERATIONS[major];
  if (!found) {
    throw new Error(
      `wgpu-native generation ${major} is not supported. Supported: ${SUPPORTED_GENERATIONS.join(", ")}.\n` +
        `  A generation is added only once a CI leg has run the suite against it — see docs/GENERATIONS.md.`,
    );
  }
  return found;
}

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

/** Look up the archive for a RID, in a given generation. */
export function assetFor(rid: Rid = currentRid(), major: number = DEFAULT_GENERATION): IArchiveAsset | undefined {
  return generation(major).assets[rid];
}

/** Every RID this manifest knows how to install for a generation. */
export function supportedRids(major: number = DEFAULT_GENERATION): Rid[] {
  return Object.keys(generation(major).assets);
}
