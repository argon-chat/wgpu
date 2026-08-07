/**
 * The abort-on-call blocklist: wgpu-native symbols that are **exported but `unimplemented!()`**.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 *
 * A Rust `unimplemented!()` reached across the C ABI is compiled non-unwinding. It does not return an
 * error, does not throw, and cannot be caught: **the process dies**. Under `bun test` that takes the
 * whole runner with it — no stack, no attribution, no partial results, every remaining suite lost.
 *
 * All 40 of these are real exported symbols. `dlopen` finds them. A binding generated from
 * `webgpu.h`, or written by picking the name that looks right in the header, will reach for several
 * of them on its first draft. Two in particular are the trap:
 *
 *     wgpuBufferReadMappedRange   ← the modern header spelling. Use wgpuBufferGetMappedRange.
 *     wgpuBufferWriteMappedRange  ← ditto.        Use wgpuBufferGetConstMappedRange for reads.
 *
 * Buffer readback is on the hot path of essentially every GPU test that exists, so picking the
 * modern-looking name is not an edge case — it is an immediate, total failure.
 *
 * Three more are load-bearing for this package's design and are called out in the README:
 *
 *     wgpuShaderModuleGetCompilationInfo  — so `getCompilationInfo()` CANNOT be forwarded to
 *                                           wgpu-native at all. It has to be synthesised from the
 *                                           validation error raised at module-creation time.
 *     wgpuDeviceGetLostFuture             — so `GPUDevice.lost` cannot be backed by the native call.
 *     wgpuInstanceWaitAny                 — so async completion has to be driven by polling
 *                                           (`wgpuDevicePoll` + `wgpuInstanceProcessEvents`).
 *
 * And every single `*SetLabel` entry point is unimplemented (18 of the 40), which means labels can
 * only ever be supplied in a creation descriptor, never assigned afterwards.
 *
 * ── Provenance, and how this list is kept honest ────────────────────────────────────────────────
 *
 * Two disjoint sources, because they are visible in different places:
 *
 *   - `"binary"`  — the 5 whose `unimplemented!("…")` carries a message, so the string
 *                   `"<name> is not implemented"` is compiled into the shared library. These are
 *                   re-derived from the installed binary on every test run, and the derived set must
 *                   equal exactly these 5.
 *   - `"source"`  — the 35 bare `unimplemented!()` bodies in upstream's `src/unimplemented.rs`.
 *                   A bare panic leaves no name in the binary, so these cannot be re-derived locally.
 *                   `bun run derive:aborts` re-derives them from upstream's source at the pinned tag
 *                   and fails on any difference; CI runs it as its own job.
 *
 * Between the two, a wgpu-native version bump cannot quietly add a trap (the source check fails) or
 * quietly retire one (either check fails) without someone editing this file on purpose.
 *
 * Measured against wgpu-native v29.0.1.1. All 40 verified present in the shipped library's export
 * table, i.e. every one of them is reachable and will abort if called.
 */

/** How a blocklist entry was established. */
export type AbortSymbolProvenance =
  /** `unimplemented!("<name> is not implemented")` — the message is a string in the binary. */
  | "binary"
  /** Bare `unimplemented!()` in upstream `src/unimplemented.rs` — invisible in the binary. */
  | "source";

export interface IAbortSymbol {
  /** Exported C symbol name. */
  readonly name: string;
  readonly provenance: AbortSymbolProvenance;
}

/**
 * The 5 whose panic message names them, and which are therefore re-derivable from the binary alone.
 *
 * Kept as its own export so {@link ABORT_SYMBOLS} cannot drift from what the binary scan checks.
 */
export const BINARY_NAMED_ABORT_SYMBOLS: readonly string[] = [
  "wgpuBufferReadMappedRange",
  "wgpuBufferWriteMappedRange",
  "wgpuGetInstanceFeatures",
  "wgpuHasInstanceFeature",
  "wgpuSupportedInstanceFeaturesFreeMembers",
];

/** The 35 bare `unimplemented!()` bodies in upstream `src/unimplemented.rs` at the pinned tag. */
export const SOURCE_ONLY_ABORT_SYMBOLS: readonly string[] = [
  "wgpuBindGroupLayoutSetLabel",
  "wgpuBindGroupSetLabel",
  "wgpuBufferGetMapState",
  "wgpuBufferSetLabel",
  "wgpuCommandBufferSetLabel",
  "wgpuCommandEncoderSetLabel",
  "wgpuComputePassEncoderSetLabel",
  "wgpuComputePipelineSetLabel",
  "wgpuDeviceCreateComputePipelineAsync",
  "wgpuDeviceCreateRenderPipelineAsync",
  "wgpuDeviceGetAdapterInfo",
  "wgpuDeviceGetLostFuture",
  "wgpuDeviceSetLabel",
  "wgpuExternalTextureAddRef",
  "wgpuExternalTextureRelease",
  "wgpuExternalTextureSetLabel",
  "wgpuGetProcAddress",
  "wgpuInstanceGetWGSLLanguageFeatures",
  "wgpuInstanceHasWGSLLanguageFeature",
  "wgpuInstanceWaitAny",
  "wgpuPipelineLayoutSetLabel",
  "wgpuQuerySetSetLabel",
  "wgpuQueueSetLabel",
  "wgpuRenderBundleEncoderSetLabel",
  "wgpuRenderBundleSetLabel",
  "wgpuRenderPassEncoderSetLabel",
  "wgpuRenderPipelineSetLabel",
  "wgpuSamplerSetLabel",
  "wgpuShaderModuleGetCompilationInfo",
  "wgpuShaderModuleSetLabel",
  "wgpuSupportedWGSLLanguageFeaturesFreeMembers",
  "wgpuSurfaceSetLabel",
  "wgpuTextureGetTextureBindingViewDimension",
  "wgpuTextureSetLabel",
  "wgpuTextureViewSetLabel",
];

/** Every symbol that aborts the process when called, with provenance. */
export const ABORT_SYMBOLS: readonly IAbortSymbol[] = [
  ...BINARY_NAMED_ABORT_SYMBOLS.map((name) => ({ name, provenance: "binary" as const })),
  ...SOURCE_ONLY_ABORT_SYMBOLS.map((name) => ({ name, provenance: "source" as const })),
].sort((a, b) => (a.name < b.name ? -1 : 1));

/** Flat name set, for membership checks. */
export const ABORT_SYMBOL_NAMES: ReadonlySet<string> = new Set(ABORT_SYMBOLS.map((s) => s.name));

/**
 * Symbols that MUST be exported and MUST work — the correct spellings the blocklisted ones shadow,
 * plus the handful the whole design rests on.
 *
 * Asserting these positively is what stops the blocklist test passing for the wrong reason: if the
 * library failed to load, or loaded something that is not wgpu-native, "no blocklisted symbol was
 * found" would be trivially true. These make that impossible.
 */
export const REQUIRED_SYMBOLS: readonly string[] = [
  // The mapped-range pair that `…Read/WriteMappedRange` would have shadowed.
  "wgpuBufferGetMappedRange",
  "wgpuBufferGetConstMappedRange",
  // Poll-driven completion (wgpuInstanceWaitAny is blocklisted, so these are the only route).
  "wgpuDevicePoll",
  "wgpuInstanceProcessEvents",
  // The error path this package exists for.
  "wgpuDevicePushErrorScope",
  "wgpuDevicePopErrorScope",
  // Identity: assert the binary at load rather than trusting a filename.
  "wgpuGetVersion",
  // Adapter info has to come from the adapter — wgpuDeviceGetAdapterInfo is blocklisted.
  "wgpuAdapterGetInfo",
];

/**
 * Scan a binary for `unimplemented!("<name> is not implemented")` message strings.
 *
 * Reading the file byte-per-code-unit makes the regex see embedded ASCII without caring about the
 * container format. That keeps this working on PE, ELF and Mach-O alike, which matters because the
 * test runs on all five target platforms.
 *
 * The decode is done by hand rather than with `TextDecoder("latin1")`: Bun's typings only admit the
 * encodings it guarantees, and a UTF-8 decode would mangle any byte above 0x7f into a replacement
 * character — harmless for the ASCII we are matching, but it would silently shift every subsequent
 * offset, and this function's whole job is to be exact about what is in the file.
 */
export function deriveNamedAbortSymbols(bytes: Uint8Array): string[] {
  let text = "";
  const CHUNK = 0x8000; // String.fromCharCode is applied in chunks to stay under the argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  const found = new Set<string>();
  for (const m of text.matchAll(/(wgpu[A-Za-z0-9_]+) is not implemented/g)) found.add(m[1]!);
  return [...found].sort();
}
