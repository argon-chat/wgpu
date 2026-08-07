/**
 * The ABI shim — identity, acquisition, and the rule for when it is required.
 *
 * ── What the shim is ────────────────────────────────────────────────────────────────────────────
 *
 * `bun:ffi` cannot express a C aggregate passed **by value**, and seven wgpu-native entry points
 * take one. `shim/` is a small Rust `cdylib` that declares those aggregates as real `#[repr(C)]`
 * structs, lets a real compiler emit the calling sequence, and re-exports the seven functions with
 * flat pointer parameters — exactly the signature `src/ffi/abiSeam.ts` already uses. See that file
 * for the ABI reasoning and `shim/src/lib.rs` for the implementation.
 *
 * ── Why it is built for every platform, not only where it is required ───────────────────────────
 *
 * Only `linux-x64` *needs* it among the four supported RIDs: `win32-x64` is Win64 and the two
 * `arm64` targets are AAPCS, and both of those pass these aggregates by hidden reference, so the
 * JS-only path is the correct calling sequence there (proven by execution on Windows). Building the
 * shim for SysV alone would be less work — one target instead of four.
 *
 * It is built everywhere anyway, and the reason is where the code gets *exercised*. A SysV-only shim
 * would run on exactly one platform: the one a developer on Windows cannot execute, cannot attach a
 * debugger to, and cannot bisect on. Its first real run would be in CI on the platform where a
 * mistake is most expensive to diagnose. Built for every platform, the same code runs on every test
 * invocation on the maintainer's own machine against a real GPU — so a wrong struct member or a
 * mis-transcribed prototype surfaces where it is cheap, and what ships to SysV is code that has been
 * executed thousands of times.
 *
 * The cost of that choice is a four-target build matrix instead of one. It is paid by CI runners
 * that already exist for the test matrix, and it buys the only thing that actually makes the SysV
 * claim credible.
 *
 * ── …and why the direct path is still kept ──────────────────────────────────────────────────────
 *
 * Preferring the shim is not the same as requiring it. Where the ABI provably permits the direct
 * path, an absent shim falls back to it rather than failing: that keeps a fresh checkout with no
 * Rust toolchain and no published artefact working exactly as it does today on Windows and ARM. On
 * SysV there is no fallback, because there is nothing correct to fall back to.
 *
 * `WGPU_BUN_SEAM=shim|direct|auto` forces the choice, which is what lets one machine A/B both paths.
 */

import { currentRid, platformOf, type IArchiveAsset, type Rid } from "./wgpu-native.manifest.ts";

/**
 * Version of the *flat function surface* the shim exports.
 *
 * Must equal `SHIM_ABI_VERSION` in `shim/src/lib.rs`. The seam reads the value out of the loaded
 * library and refuses a mismatch, because a silently different signature corrupts a stack rather
 * than raising an error.
 */
export const SHIM_ABI_VERSION = 1;

/**
 * The shim crate's own release version — what names its published artefacts.
 *
 * Separate from the package version on purpose: the shim only changes when the seven wrapped
 * prototypes or the wgpu-native generation change, which is far less often than the binding.
 */
export const SHIM_VERSION = "1.0.0";

/** Git tag the shim artefacts are published under. */
export const SHIM_RELEASE_TAG = `shim-v${SHIM_VERSION}`;

/** Platform-correct file name of the shim shared library, as cargo names a `cdylib`. */
export function shimFileName(platform: string = process.platform): string {
  if (platform === "win32") return "wgpu_bun_shim.dll";
  if (platform === "darwin") return "libwgpu_bun_shim.dylib";
  return "libwgpu_bun_shim.so";
}

/** The Rust target triple built for a RID, for `cargo build --target`. */
export function rustTargetFor(rid: Rid): string | null {
  switch (rid) {
    case "win32-x64":
      return "x86_64-pc-windows-msvc";
    case "linux-x64":
      return "x86_64-unknown-linux-gnu";
    case "linux-arm64":
      return "aarch64-unknown-linux-gnu";
    case "darwin-arm64":
      return "aarch64-apple-darwin";
    default:
      return null;
  }
}

/**
 * Can `bun:ffi` express this platform's calling sequence for a by-value aggregate?
 *
 * `true` where an aggregate argument is passed by hidden reference — Win64 for anything not exactly
 * 1/2/4/8 bytes, AArch64 AAPCS for anything over 16 — so passing a pointer to a packed buffer is not
 * a substitution but the correct sequence.
 *
 * `false` under SysV x86-64, where a >16-byte aggregate is copied onto the stack and a 16-byte
 * two-integer aggregate goes in two registers. Neither is producible from JavaScript, and the second
 * is not detectable by size.
 *
 * Deliberately a function of (platform, arch) rather than a lookup of `process.*`, so the rule can be
 * tested for hosts this machine is not.
 */
export function abiExpressesByValueAggregates(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  if (arch === "arm64") return true; // AArch64 AAPCS — win/linux/darwin alike
  if (platform === "win32" && arch === "x64") return true; // Win64
  return false; // SysV x86-64, and anything unrecognised: assume it needs the shim
}

/** Is the shim mandatory for a host, i.e. is there no correct direct path? */
export function shimIsRequired(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return !abiExpressesByValueAggregates(platform, arch);
}

/**
 * Published shim artefacts, per RID — the same fetched-never-committed, pinned-by-sha256 doctrine
 * `wgpu-native.manifest.ts` applies to upstream's binaries, applied to ours.
 *
 * **Every sha256 below is empty, and that is not an oversight.** No shim release has been cut, so
 * there is nothing to measure. An empty hash means *unpinned*, and `scripts/shim.ts --fetch` refuses
 * to install an unpinned binary — exactly as the wgpu-native fetcher does. A plausible-looking
 * invented hash in a supply-chain file is worse than a blank one, and a URL that 404s with a clear
 * message is better than a URL that is silently absent.
 *
 * (The value type is `IArchiveAsset`, borrowed from the wgpu-native manifest rather than duplicated
 * under a new name. A shim artefact is a bare shared library rather than an archive, so the name is
 * loose — but it is exactly `{ url, sha256 }`, and a second identical interface would be a synonym,
 * not a distinction.)
 *
 * Measure them with `bun run shim:fetch --update-hashes` after the release workflow has uploaded the
 * artefacts, and paste the values here. Until then the acquisition paths are: build from source
 * (`bun run shim:build`, needs cargo), or install the platform npm package, which carries the shim
 * next to wgpu-native so the two can never be separated.
 */
export const SHIM_ASSETS: Partial<Record<Rid, IArchiveAsset>> = {
  "win32-x64": {
    url: `https://github.com/argon-chat/wgpu/releases/download/${SHIM_RELEASE_TAG}/wgpu_bun_shim-win32-x64.dll`,
    sha256: "",
  },
  "darwin-arm64": {
    url: `https://github.com/argon-chat/wgpu/releases/download/${SHIM_RELEASE_TAG}/libwgpu_bun_shim-darwin-arm64.dylib`,
    sha256: "",
  },
  "linux-x64": {
    url: `https://github.com/argon-chat/wgpu/releases/download/${SHIM_RELEASE_TAG}/libwgpu_bun_shim-linux-x64.so`,
    sha256: "",
  },
  "linux-arm64": {
    url: `https://github.com/argon-chat/wgpu/releases/download/${SHIM_RELEASE_TAG}/libwgpu_bun_shim-linux-arm64.so`,
    sha256: "",
  },
};

/** Look up the published shim artefact for a RID. */
export function shimAssetFor(rid: Rid = currentRid()): IArchiveAsset | undefined {
  return SHIM_ASSETS[rid];
}

/** Every RID a shim is published for. */
export function shimRids(): Rid[] {
  return Object.keys(SHIM_ASSETS);
}

/** The shim file name for a RID (rather than for the running process). */
export function shimFileNameFor(rid: Rid): string {
  return shimFileName(platformOf(rid));
}
