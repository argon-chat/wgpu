/**
 * The 40 exported wgpu-native symbols that **abort the process** when called.
 *
 * These are `unimplemented!()` stubs. Because the entry points are `extern "C"` — and therefore
 * `nounwind` — the Rust panic cannot unwind and is escalated to `abort`. There is no catchable
 * error, no status code, and no JS stack: the process dies, and everything else running in it dies
 * with it. Nothing distinguishes them from working functions beforehand; they are in the DLL's
 * export table and in `webgpu.h`, typed exactly like their neighbours.
 *
 * ── The trap this sets for header-driven binding generation ─────────────────────────────────────
 *
 * `wgpuBufferReadMappedRange` and `wgpuBufferWriteMappedRange` are the **modern `webgpu.h`
 * spellings** for buffer access, so a binding generated faithfully from the header picks precisely
 * the two entry points that abort — and dies on its first pixel readback, which is the hot path of
 * essentially every GPU test in existence. The functions that actually work are the older
 * `wgpuBufferGetMappedRange` / `wgpuBufferGetConstMappedRange`. This package uses those, and
 * {@link assertImplemented} makes the wrong choice impossible to make by accident.
 *
 * The same shape applies to `wgpuGetInstanceFeatures` / `wgpuHasInstanceFeature` (probe features on
 * the *adapter* instead), to `wgpuShaderModuleGetCompilationInfo` (see the shader module's
 * error-scope fallback), and to `wgpuInstanceWaitAny` (there are no futures here — poll instead).
 *
 * ── How this list was derived ───────────────────────────────────────────────────────────────────
 *
 * Two independent sources, because a single one is not trustworthy: the shipped DLL and the tagged
 * source can be different commits, and the export table is exactly the thing that misleads.
 *
 * 1. **Behaviour-derived (primary, and what is written below).** Every exported symbol in the
 *    pinned headers was called once, in **its own subprocess**, with zeroed arguments; a symbol is
 *    a stub iff the child printed the Rust panic banner `not implemented`. This is sound because
 *    `unimplemented!()` is the first statement in these bodies — it fires before any argument is
 *    read — so a NULL handle cannot produce a false positive, and a working function cannot produce
 *    a false negative. Reproduce with `bun run scripts/derive-unimplemented.ts`, which also diffs
 *    its result against this list and exits non-zero on any drift.
 *
 * 2. **Source-derived (cross-check).** `grep -rn 'unimplemented!' src/` at the pinned upstream tag,
 *    across the **whole crate** and not just `src/unimplemented.rs` — five of the forty live in
 *    `src/lib.rs`, including both `MappedRange` entry points, and a derivation that reads only the
 *    obviously-named file reports 35 and misses the two that matter most.
 *
 * The two agree at 40 for this pin. Re-run (1) on every pin bump; the list changes only when the
 * pin does.
 *
 * ── Reading the list ────────────────────────────────────────────────────────────────────────────
 *
 * Twenty-one of the forty are `*SetLabel`. They look harmless — a `device.label = "x"` setter that
 * forwards naively turns a cosmetic line of test code into a process abort with a Rust backtrace
 * and no JS stack. This package therefore never forwards a label after creation; labels are only
 * ever passed *in descriptors at creation time*, where they work.
 */

/**
 * Sorted, exhaustive, and verified against the DLL this package pins.
 *
 * @see scripts/derive-unimplemented.ts
 */
export const UNIMPLEMENTED: readonly string[] = [
  "wgpuBindGroupLayoutSetLabel",
  "wgpuBindGroupSetLabel",
  "wgpuBufferGetMapState",
  "wgpuBufferReadMappedRange",
  "wgpuBufferSetLabel",
  "wgpuBufferWriteMappedRange",
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
  "wgpuGetInstanceFeatures",
  "wgpuGetProcAddress",
  "wgpuHasInstanceFeature",
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
  "wgpuSupportedInstanceFeaturesFreeMembers",
  "wgpuSupportedWGSLLanguageFeaturesFreeMembers",
  "wgpuSurfaceSetLabel",
  "wgpuTextureGetTextureBindingViewDimension",
  "wgpuTextureSetLabel",
  "wgpuTextureViewSetLabel",
];

const BLOCKED = new Set(UNIMPLEMENTED);

/** The working alternative, where one exists, so the error names the fix and not just the problem. */
const ALTERNATIVES: Readonly<Record<string, string>> = {
  wgpuBufferReadMappedRange: "wgpuBufferGetConstMappedRange",
  wgpuBufferWriteMappedRange: "wgpuBufferGetMappedRange",
  wgpuGetInstanceFeatures: "wgpuAdapterGetFeatures / wgpuDeviceGetFeatures",
  wgpuHasInstanceFeature: "wgpuAdapterHasFeature / wgpuDeviceHasFeature",
  wgpuInstanceWaitAny: "wgpuInstanceProcessEvents / wgpuDevicePoll (there are no futures in this build)",
  wgpuDeviceGetAdapterInfo: "wgpuAdapterGetInfo, on the adapter the device came from",
  wgpuShaderModuleGetCompilationInfo: "an error scope around wgpuDeviceCreateShaderModule",
  wgpuDeviceCreateComputePipelineAsync: "wgpuDeviceCreateComputePipeline",
  wgpuDeviceCreateRenderPipelineAsync: "wgpuDeviceCreateRenderPipeline",
};

/** `true` if calling this symbol would abort the process. */
export function isUnimplemented(symbol: string): boolean {
  return BLOCKED.has(symbol);
}

/**
 * Throw a normal JS `Error` rather than letting the process die.
 *
 * Called on the way *in* to every blocked symbol. The whole value of this module is that the
 * failure arrives as a stack trace pointing at the caller instead of as a Rust backtrace on stderr
 * followed by exit code `0xC0000409`.
 */
export function assertImplemented(symbol: string, wgpuNativeVersion = "v29.0.1"): void {
  if (!BLOCKED.has(symbol)) return;
  const alt = ALTERNATIVES[symbol];
  throw new Error(
    `wgpu-bun: ${symbol}() is an unimplemented stub in wgpu-native ${wgpuNativeVersion} and ` +
      `aborts the process when called.` +
      (alt ? `\n  Use ${alt} instead.` : "") +
      `\n  (One of ${UNIMPLEMENTED.length} such symbols — see src/ffi/unimplemented.ts.)`,
  );
}
