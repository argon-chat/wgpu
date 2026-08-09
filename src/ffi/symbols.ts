/**
 * The `dlopen` symbol table.
 *
 * Every signature here was extracted from the pinned `webgpu.h` / `wgpu.h` that ship inside the
 * wgpu-native release archive, not written from memory. Two mappings are worth stating because
 * getting them wrong is silent:
 *
 *   - `size_t` and every `WGPUFlags` bitset are **64-bit** (`u64`). `WGPUBufferUsage`,
 *     `WGPUTextureUsage`, `WGPUShaderStage`, `WGPUMapMode` and `WGPUColorWriteMask` all widened to
 *     64 bits in v29. Declaring one as `u32` shifts every argument after it.
 *   - Every `WGPUFuture` return is a single `uint64_t`, so it comes back in `RAX` on both Win64 and
 *     SysV and `u64` is correct everywhere. It is also **always 0** in this build — futures are not
 *     implemented — which is why nothing in this package reads it.
 *
 * The eight functions taking a `*CallbackInfo` **by value** are deliberately *absent* from this
 * table. They live behind {@link ./abiSeam.ts}, which is the only module allowed to know that
 * passing a pointer where C declares an aggregate happens to be the correct calling sequence on
 * this ABI.
 *
 * Nothing from {@link ./unimplemented.ts} appears here either, and {@link assertNoBlockedSymbols}
 * proves it at load rather than trusting review.
 */

import { FFIType } from "bun:ffi";

import { isUnimplemented } from "./unimplemented.ts";

const { ptr, u16, u32, u64, i32, f32, void: v } = FFIType;

/**
 * Tier-1 surface plus the error-scope and compilation paths.
 *
 * Not exhaustive by design: surfaces/presentation, render bundles, indirect draw and occlusion
 * queries have zero call sites in the corpus this package targets, and an unbound symbol is a
 * missing-key error at the call site rather than a latent one.
 */
export const SYMBOLS = {
  // ── instance ───────────────────────────────────────────────────────────────────────────────
  wgpuCreateInstance: { args: [ptr], returns: ptr },
  wgpuInstanceProcessEvents: { args: [ptr], returns: v },
  wgpuInstanceRelease: { args: [ptr], returns: v },

  // ── adapter ────────────────────────────────────────────────────────────────────────────────
  wgpuAdapterGetInfo: { args: [ptr, ptr], returns: u32 },
  wgpuAdapterGetFeatures: { args: [ptr, ptr], returns: v },
  wgpuAdapterGetLimits: { args: [ptr, ptr], returns: u32 },
  wgpuAdapterHasFeature: { args: [ptr, u32], returns: u32 },
  wgpuAdapterRelease: { args: [ptr], returns: v },

  // ── device ─────────────────────────────────────────────────────────────────────────────────
  wgpuDeviceGetQueue: { args: [ptr], returns: ptr },
  wgpuDeviceGetFeatures: { args: [ptr, ptr], returns: v },
  wgpuDeviceGetLimits: { args: [ptr, ptr], returns: u32 },
  wgpuDeviceHasFeature: { args: [ptr, u32], returns: u32 },
  wgpuDevicePushErrorScope: { args: [ptr, u32], returns: v },
  wgpuDeviceDestroy: { args: [ptr], returns: v },
  wgpuDeviceRelease: { args: [ptr], returns: v },
  // ── resource creation ──────────────────────────────────────────────────────────────────────
  wgpuDeviceCreateBuffer: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateTexture: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateSampler: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateShaderModule: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateBindGroupLayout: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreatePipelineLayout: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateBindGroup: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateComputePipeline: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateRenderPipeline: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateCommandEncoder: { args: [ptr, ptr], returns: ptr },
  wgpuDeviceCreateQuerySet: { args: [ptr, ptr], returns: ptr },

  // ── queue ──────────────────────────────────────────────────────────────────────────────────
  wgpuQueueSubmit: { args: [ptr, u64, ptr], returns: v },
  wgpuQueueWriteBuffer: { args: [ptr, ptr, u64, ptr, u64], returns: v },
  wgpuQueueWriteTexture: { args: [ptr, ptr, ptr, u64, ptr, ptr], returns: v },
  wgpuQueueRelease: { args: [ptr], returns: v },

  // ── buffer ─────────────────────────────────────────────────────────────────────────────────
  // NOTE: Get/GetConst, never Read/Write — the modern spellings abort. See ./unimplemented.ts.
  wgpuBufferGetMappedRange: { args: [ptr, u64, u64], returns: ptr },
  wgpuBufferGetConstMappedRange: { args: [ptr, u64, u64], returns: ptr },
  wgpuBufferUnmap: { args: [ptr], returns: v },
  wgpuBufferGetSize: { args: [ptr], returns: u64 },
  wgpuBufferGetUsage: { args: [ptr], returns: u64 },
  wgpuBufferDestroy: { args: [ptr], returns: v },
  wgpuBufferRelease: { args: [ptr], returns: v },

  // ── texture / view / sampler ───────────────────────────────────────────────────────────────
  wgpuTextureCreateView: { args: [ptr, ptr], returns: ptr },
  wgpuTextureGetWidth: { args: [ptr], returns: u32 },
  wgpuTextureGetHeight: { args: [ptr], returns: u32 },
  wgpuTextureGetDepthOrArrayLayers: { args: [ptr], returns: u32 },
  wgpuTextureGetMipLevelCount: { args: [ptr], returns: u32 },
  wgpuTextureGetSampleCount: { args: [ptr], returns: u32 },
  wgpuTextureGetDimension: { args: [ptr], returns: u32 },
  wgpuTextureGetFormat: { args: [ptr], returns: u32 },
  wgpuTextureGetUsage: { args: [ptr], returns: u64 },
  wgpuTextureDestroy: { args: [ptr], returns: v },
  wgpuTextureRelease: { args: [ptr], returns: v },
  wgpuTextureViewRelease: { args: [ptr], returns: v },
  wgpuSamplerRelease: { args: [ptr], returns: v },

  // ── shaders, layouts, pipelines ────────────────────────────────────────────────────────────
  wgpuShaderModuleRelease: { args: [ptr], returns: v },
  wgpuBindGroupRelease: { args: [ptr], returns: v },
  wgpuBindGroupLayoutRelease: { args: [ptr], returns: v },
  wgpuPipelineLayoutRelease: { args: [ptr], returns: v },
  wgpuComputePipelineGetBindGroupLayout: { args: [ptr, u32], returns: ptr },
  wgpuComputePipelineRelease: { args: [ptr], returns: v },
  wgpuRenderPipelineGetBindGroupLayout: { args: [ptr, u32], returns: ptr },
  wgpuRenderPipelineRelease: { args: [ptr], returns: v },

  // ── command encoding ───────────────────────────────────────────────────────────────────────
  wgpuCommandEncoderBeginComputePass: { args: [ptr, ptr], returns: ptr },
  wgpuCommandEncoderBeginRenderPass: { args: [ptr, ptr], returns: ptr },
  wgpuCommandEncoderCopyBufferToBuffer: { args: [ptr, ptr, u64, ptr, u64, u64], returns: v },
  wgpuCommandEncoderCopyBufferToTexture: { args: [ptr, ptr, ptr, ptr], returns: v },
  wgpuCommandEncoderCopyTextureToBuffer: { args: [ptr, ptr, ptr, ptr], returns: v },
  wgpuCommandEncoderCopyTextureToTexture: { args: [ptr, ptr, ptr, ptr], returns: v },
  wgpuCommandEncoderClearBuffer: { args: [ptr, ptr, u64, u64], returns: v },
  wgpuCommandEncoderResolveQuerySet: { args: [ptr, ptr, u32, u32, ptr, u64], returns: v },
  wgpuCommandEncoderFinish: { args: [ptr, ptr], returns: ptr },
  wgpuCommandEncoderRelease: { args: [ptr], returns: v },
  wgpuCommandBufferRelease: { args: [ptr], returns: v },

  // ── compute pass ───────────────────────────────────────────────────────────────────────────
  wgpuComputePassEncoderSetPipeline: { args: [ptr, ptr], returns: v },
  wgpuComputePassEncoderSetBindGroup: { args: [ptr, u32, ptr, u64, ptr], returns: v },
  wgpuComputePassEncoderDispatchWorkgroups: { args: [ptr, u32, u32, u32], returns: v },
  wgpuComputePassEncoderDispatchWorkgroupsIndirect: { args: [ptr, ptr, u64], returns: v },
  wgpuComputePassEncoderEnd: { args: [ptr], returns: v },
  wgpuComputePassEncoderRelease: { args: [ptr], returns: v },

  // ── render pass ────────────────────────────────────────────────────────────────────────────
  wgpuRenderPassEncoderSetPipeline: { args: [ptr, ptr], returns: v },
  wgpuRenderPassEncoderSetBindGroup: { args: [ptr, u32, ptr, u64, ptr], returns: v },
  wgpuRenderPassEncoderSetVertexBuffer: { args: [ptr, u32, ptr, u64, u64], returns: v },
  wgpuRenderPassEncoderSetIndexBuffer: { args: [ptr, ptr, u32, u64, u64], returns: v },
  wgpuRenderPassEncoderDraw: { args: [ptr, u32, u32, u32, u32], returns: v },
  wgpuRenderPassEncoderDrawIndexed: { args: [ptr, u32, u32, u32, i32, u32], returns: v },
  wgpuRenderPassEncoderSetViewport: { args: [ptr, f32, f32, f32, f32, f32, f32], returns: v },
  wgpuRenderPassEncoderSetScissorRect: { args: [ptr, u32, u32, u32, u32], returns: v },
  wgpuRenderPassEncoderSetBlendConstant: { args: [ptr, ptr], returns: v },
  wgpuRenderPassEncoderEnd: { args: [ptr], returns: v },
  wgpuRenderPassEncoderRelease: { args: [ptr], returns: v },

  // ── query sets ─────────────────────────────────────────────────────────────────────────────
  wgpuQuerySetGetCount: { args: [ptr], returns: u32 },
  wgpuQuerySetRelease: { args: [ptr], returns: v },

  // ── free-members: `WGPUSupportedFeatures` is 16 bytes, `WGPUAdapterInfo` 96 — both aggregates
  //    passed BY VALUE, so they belong to the ABI seam, not here. See ./abiSeam.ts.
} as const satisfies Record<string, { args: readonly FFIType[]; returns: FFIType }>;

/**
 * The entry points wgpu-native has and **Dawn does not**.
 *
 * Measured, not assumed: every name in {@link SYMBOLS} was checked against Dawn's own `webgpu.h`
 * (`v20260807.193620`, 277 declarations) and exactly these three are absent. They are wgpu-native's
 * own additions rather than WebGPU — two of them are not even in `webgpu.h`, and `wgpuDevicePoll`
 * is the `wgpu.h` extension the synchronous pump is built on.
 *
 * They live in a separate table because `dlopen` binds a symbol table **atomically**: one missing
 * name fails the whole load. Binding these unconditionally is what produced the first thing that
 * ever happened when this package was pointed at Dawn —
 * `TypeError: Symbol "wgpuGetVersion" not found in webgpu_dawn.dll` — before a single call was made.
 *
 * Each has a different answer under Dawn, and none of them is "pretend it exists":
 *
 *   `wgpuGetVersion`   Dawn exposes no runtime version accessor at all. The version comes from the
 *                      pinned tag instead — see `src/ffi/library.ts`.
 *   `wgpuSetLogLevel`  wgpu-native's global logger. Dawn's logging is not part of its C API.
 *   `wgpuDevicePoll`   Dawn's polling is `wgpuInstanceProcessEvents`, which is in `webgpu.h` and is
 *                      already bound above and already called at every one of these call sites.
 */
export const WGPU_NATIVE_ONLY_SYMBOLS = {
  wgpuGetVersion: { args: [], returns: u32 },
  wgpuSetLogLevel: { args: [u32], returns: v },
  /** `wgpu.h` extension. `wait = true` blocks until the queue drains — the tractable sync pump. */
  wgpuDevicePoll: { args: [ptr, u32, ptr], returns: u32 },
} as const satisfies Record<string, { args: readonly FFIType[]; returns: FFIType }>;

/** Every symbol name this package binds directly. */
export type WgpuSymbolName = keyof typeof SYMBOLS;

/**
 * Fail at load if a blocked symbol ever gets added here.
 *
 * Cheap, and it removes "someone pastes `wgpuBufferWriteMappedRange` into the table because the
 * header says that is the modern name" from the set of things that can happen quietly.
 */
export function assertNoBlockedSymbols(): void {
  const offenders = Object.keys(SYMBOLS).filter(isUnimplemented);
  if (offenders.length > 0) {
    throw new Error(
      `wgpu-bun: the symbol table binds ${offenders.length} symbol(s) that abort the process when ` +
        `called: ${offenders.join(", ")}. See src/ffi/unimplemented.ts.`,
    );
  }
}
