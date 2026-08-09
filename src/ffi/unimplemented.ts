/**
 * The 40 exported wgpu-native symbols that **abort the process** when called.
 *
 * These are `unimplemented!()` stubs. The entry points are `extern "C"` and therefore `nounwind`, so
 * the Rust panic cannot unwind and is escalated to `abort`: no catchable error, no status code, no
 * JS stack — the process dies and takes everything with it. They are indistinguishable beforehand,
 * sitting in the DLL's export table and in `webgpu.h`, typed exactly like their neighbours.
 *
 * ── The trap this sets for header-driven binding generation ─────────────────────────────────────
 *
 * `wgpuBufferReadMappedRange` and `wgpuBufferWriteMappedRange` are the **modern `webgpu.h`
 * spellings** for buffer access, so a binding generated faithfully from the header picks exactly the
 * two entry points that abort — and dies on its first pixel readback, the hot path of nearly every
 * GPU test. The functions that work are the older `wgpuBufferGetMappedRange` /
 * `wgpuBufferGetConstMappedRange`; this package uses those, and {@link assertImplemented} makes the
 * wrong choice impossible to make by accident. Same shape for `wgpuGetInstanceFeatures` /
 * `wgpuHasInstanceFeature` (probe features on the *adapter* instead),
 * `wgpuShaderModuleGetCompilationInfo` (see the shader module's error-scope fallback), and
 * `wgpuInstanceWaitAny` (no futures here — poll instead).
 *
 * ── How this list was derived ───────────────────────────────────────────────────────────────────
 *
 * Two independent sources, because one is not trustworthy: the shipped DLL and the tagged source can
 * be different commits, and the export table is the thing that misleads.
 *
 * 1. **Behaviour-derived (primary).** Every exported symbol in the pinned headers was called once,
 *    in **its own subprocess**, with zeroed arguments; a symbol is a stub iff the child printed the
 *    Rust panic banner `not implemented`. Reproduce with `bun run scripts/derive-unimplemented.ts`,
 *    which diffs its result against this list, exits non-zero on drift, and documents why the
 *    classification can produce neither a false positive nor a false negative.
 * 2. **Source-derived (cross-check).** `grep -rn 'unimplemented!' src/` at the pinned upstream tag,
 *    across the **whole crate** and not just `src/unimplemented.rs` — five of the forty live in
 *    `src/lib.rs`, including both `MappedRange` entry points, so a derivation that reads only the
 *    obviously-named file reports 35 and misses the two that matter most.
 *
 * The two agree at 40 for this pin, by execution: `bun run derive:aborts:probe` against the shipped
 * `v29.0.1.1` binary reproduces this list exactly. Re-run it on a pin bump.
 *
 * ⚠ Twenty-one of the forty are `*SetLabel`, which look harmless: a `device.label = "x"` setter that
 * forwards naively turns a cosmetic line of test code into a process abort with a Rust backtrace and
 * no JS stack. So labels are never forwarded after creation — only passed *in descriptors at
 * creation time*, where they work.
 *
 * ── Scope: this is wgpu-native's list, and only wgpu-native's ───────────────────────────────────
 *
 * Every name here was derived by executing **wgpu-native**. Dawn (`WGPU_BUN_IMPL=dawn`) is a
 * different implementation of the same header and has not been swept, so nothing here is a claim
 * about it — some of these very likely work there. That costs nothing: {@link isUnimplemented} gates
 * the *symbol table* (`src/ffi/symbols.ts`), which both implementations share, so a name that aborts
 * under either is never bound under either, and the package uses `wgpuBufferGetConstMappedRange` and
 * friends, which both support.
 *
 * ⚠ The exported {@link isUnimplemented} / {@link assertImplemented} answer for wgpu-native even when
 * Dawn is loaded. To sweep Dawn, run `scripts/derive-unimplemented.ts` under `WGPU_BUN_IMPL=dawn`
 * (it resolves whichever library the environment selects); the result would be a second list, not an
 * edit to this one.
 */

import { WGPU_NATIVE_TAG } from "../../wgpu-native.manifest.ts";

/**
 * The generation a blocklisted symbol first **exists** in.
 *
 * The list below is the UNION across every supported generation. A symbol absent from the loaded
 * library cannot be called through `dlopen` anyway, so blocklisting it there costs nothing, while
 * forgetting to blocklist it in the generation that *does* export it costs a process.
 *
 * These four were added to `webgpu.h` after v27. Recorded rather than dropped: the test that asserts
 * "every blocklisted symbol is exported" catches a name upstream renamed or a list transcribed from
 * the wrong tag, and stays a real check only if legitimate absences are declared.
 *
 * @see test/abort-symbols.test.ts, which asserts exactly this partition against the loaded library.
 *
 * ⚠ **A list of records, not an object keyed by symbol name — and it must stay one.**
 * `test/abort-symbols.test.ts` treats *any* exported object in `src/ffi` whose keys look like
 * `wgpu*` as a symbol table and fails if a blocklisted name appears among them. That bluntness is
 * what stops a trap being bound by accident. Tidying this into a `Record<string, number>` would trip
 * it; the correct response would be to change the shape back, not to teach the guard exceptions.
 */
export interface IGenerationBoundSymbol {
  /** The blocklisted symbol. */
  readonly symbol: string;
  /** First wgpu-native generation whose export table contains it. */
  readonly since: number;
}

export const FIRST_GENERATION: readonly IGenerationBoundSymbol[] = [
  { symbol: "wgpuExternalTextureAddRef", since: 29 },
  { symbol: "wgpuExternalTextureRelease", since: 29 },
  { symbol: "wgpuExternalTextureSetLabel", since: 29 },
  { symbol: "wgpuTextureGetTextureBindingViewDimension", since: 29 },
];

/** Not exported: the guard above inspects exports, and this is keyed by exactly those names. */
const SINCE = new Map(FIRST_GENERATION.map((e) => [e.symbol, e.since]));

/** Is this blocklisted symbol expected to exist in a given wgpu-native generation? */
export function existsInGeneration(symbol: string, major: number): boolean {
  return major >= (SINCE.get(symbol) ?? 0);
}

/**
 * Sorted, exhaustive, and verified against the DLL this package pins — the union across supported
 * generations, with {@link FIRST_GENERATION} recording the four that are not in all of them.
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
 * Called on the way *in* to every blocked symbol, so the failure arrives as a stack trace pointing
 * at the caller instead of a Rust backtrace on stderr followed by exit code `0xC0000409`.
 */
export function assertImplemented(symbol: string, wgpuNativeVersion = WGPU_NATIVE_TAG): void {
  if (!BLOCKED.has(symbol)) return;
  const alt = ALTERNATIVES[symbol];
  throw new Error(
    `wgpu-bun: ${symbol}() is an unimplemented stub in wgpu-native ${wgpuNativeVersion} and ` +
      `aborts the process when called.` +
      (alt ? `\n  Use ${alt} instead.` : "") +
      `\n  (One of ${UNIMPLEMENTED.length} such symbols — see src/ffi/unimplemented.ts.)`,
  );
}
