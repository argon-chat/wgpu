/**
 * The ABI shim — identity, acquisition, and the rule for when it is required.
 *
 * ── What the shim is ────────────────────────────────────────────────────────────────────────────
 *
 * `bun:ffi` cannot express a C aggregate passed **by value**, and wgpu-native does it in both
 * directions: seven entry points take one as an argument, and every callback receives its `message`
 * as a `WGPUStringView` by value. `shim/` is a small Rust `cdylib` that declares those aggregates as
 * real `#[repr(C)]` structs and hands JavaScript a flat surface in both directions — pointer
 * parameters going in, split `(data, length)` coming back out through C trampolines. See
 * `src/ffi/abiSeam.ts` for the reasoning and `shim/src/lib.rs` for the implementation.
 *
 * ── It is required on three of the four supported platforms ─────────────────────────────────────
 *
 * An earlier revision said "only `linux-x64` needs it", from the 40-byte argument rule alone. That
 * was wrong and cost a full CI matrix to find out: the two aggregate sizes group the platforms
 * **differently** (see {@link abiPassesLargeAggregatesByReference} and
 * {@link abiPassesStringViewByReference}). So the direct path is correct on `win32-x64` and nowhere
 * else; `linux-x64`, `linux-arm64` and `darwin-arm64` all require the shim, and without it hang
 * inside `requestAdapter` with no ABI error anywhere.
 *
 * ── Why it is built for every platform, including the one that does not need it ─────────────────
 *
 * The point is **where the code gets exercised**. A shim absent from the one platform a maintainer
 * can actually run means the shipped calling path is never executed interactively, never attached to
 * a debugger, never bisected. Built everywhere, the same trampolines run on every local test
 * invocation against a real GPU.
 *
 * Preferring the shim is not requiring it. On Win64 — and only there — an absent shim falls back to
 * the direct path rather than failing, so a fresh checkout with no Rust toolchain and no published
 * artefact still works on the platform most likely to be someone's first contact with the package.
 * Everywhere else there is nothing correct to fall back to and the seam refuses.
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
export const SHIM_ABI_VERSION = 3;

/**
 * The shim crate's own release version — what names its published artefacts.
 *
 * Separate from the package version on purpose: the shim changes only when the wrapped prototypes or
 * the wgpu-native generation change, far less often than the binding. `2.0.0` added the callback
 * trampolines — a new exported surface, so `SHIM_ABI_VERSION` moved with it and a 1.x artefact is
 * refused at load rather than called with the wrong signatures.
 */
export const SHIM_VERSION = "3.0.0";

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
 * ── The two by-value questions, which have different answers ────────────────────────────────────
 *
 * "Can `bun:ffi` express a by-value aggregate here" is not one question. Two aggregate sizes cross
 * this boundary, in opposite directions, and the ABIs group differently for each:
 *
 * | | Win64 | AArch64 AAPCS | SysV x86-64 |
 * |---|---|---|---|
 * | **40 B** `*CallbackInfo`, an **argument** | hidden reference | indirect (>16 B) | **stack (MEMORY)** |
 * | **16 B** `WGPUStringView`, a **callback parameter** | hidden reference (∉ {1,2,4,8}) | **two registers** (≤16 B) | **two registers** |
 *
 * For the 40-byte argument SysV is the outlier. For the 16-byte callback parameter **Win64 is the
 * outlier and the other three agree**. Treating them as one question produced a binding that hung
 * inside `requestAdapter` on `linux-x64`, `linux-arm64` and `darwin-arm64` while passing everything
 * on Windows, with no ABI error anywhere — from the machine's point of view nothing went wrong.
 *
 * Both predicates take (platform, arch) rather than reading `process.*`, so the rules can be
 * asserted for hosts this machine is not — the only way a claim about an unexecutable ABI gets
 * tested at all.
 */

/** Is a >16-byte aggregate **argument** passed by hidden reference, so a pointer is the right call? */
export function abiPassesLargeAggregatesByReference(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  if (arch === "arm64") return true; // AArch64 AAPCS: >16 B is indirect, address in a register
  if (platform === "win32" && arch === "x64") return true; // Win64: size ∉ {1,2,4,8} → hidden reference
  return false; // SysV x86-64 copies it onto the stack; anything unrecognised is assumed to as well
}

/**
 * Is a 16-byte two-integer aggregate **callback parameter** passed by hidden reference?
 *
 * True on Win64 alone. AArch64 and SysV both put it in two registers, which no single `FFIType.ptr`
 * parameter can receive.
 */
export function abiPassesStringViewByReference(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "win32" && arch === "x64";
}

/**
 * Can the JS-only direct path be correct on this host?
 *
 * Only where **both** questions answer yes: Win64 and nowhere else. An earlier revision listed
 * AArch64 as safe on the strength of the 40-byte rule alone; the 16-byte callback rule rules it out.
 */
export function abiExpressesByValueAggregates(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return (
    abiPassesLargeAggregatesByReference(platform, arch) && abiPassesStringViewByReference(platform, arch)
  );
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
 * ⚠ **Every sha256 below is empty, and that is not an oversight.** No shim release has been cut, so
 * there is nothing to measure. An empty hash means *unpinned*, and `scripts/shim.ts --fetch` refuses
 * to install an unpinned binary, exactly as the wgpu-native fetcher does. An invented hash in a
 * supply-chain file is worse than a blank one.
 *
 * (The value type is `IArchiveAsset`, borrowed from the wgpu-native manifest. A shim artefact is a
 * bare shared library rather than an archive, so the name is loose — but it is exactly
 * `{ url, sha256 }`, and a second identical interface would be a synonym, not a distinction.)
 *
 * Measure them with `bun run shim:fetch --update-hashes` once the release workflow has uploaded the
 * artefacts, and paste the values here. Until then, acquire the shim by building from source
 * (`bun run shim:build`, needs cargo) or by installing the platform npm package, which carries it
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
