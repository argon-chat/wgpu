/**
 * The `globals` bag — the 42 names callers splat onto `globalThis`.
 *
 * ```ts
 * import { create, globals } from "wgpu-bun";
 * Object.assign(globalThis, globals);
 * ```
 *
 * ── Only five of them are ever read as values ───────────────────────────────────────────────────
 *
 * `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`, `GPUMapMode` and `GPUColorWrite` carry bit
 * constants that WebGPU code references unqualified. Those bit values are **not** free choices —
 * they are the numbers wgpu-native's C API expects, so they are stated exactly rather than derived.
 * Everything else in the bag exists for `instanceof` and for error-class identity, and this package
 * supplies the real classes where it has them.
 *
 * ── Two entries have no WebGPU-spec equivalent ──────────────────────────────────────────────────
 *
 * `GPUSubgroupMatrixConfig` and `WGSLLanguageFeatures` are proprietary to the reference
 * implementation this package is drop-in for. They are exported as empty classes so
 * `Object.assign(globalThis, globals)` shape-matches; nothing can meaningfully be constructed from
 * them here, and pretending otherwise would be a lie with a longer fuse than an absence.
 *
 * ── `navigator.gpu` ─────────────────────────────────────────────────────────────────────────────
 *
 * Upstream does not provide it, so callers hand-build the shim themselves — a block that gets
 * copied between files and drifts. {@link installNavigatorGpu} offers it as a nicety; it is opt-in,
 * because silently defining a global is not something a library should do on import.
 */

import { GPU } from "./api/gpu.ts";
import type { IWebGPUGlobals } from "./types.ts";
import { GPUAdapter, GPUAdapterInfo } from "./api/adapter.ts";
import { GPUDevice, GPUDeviceLostInfo } from "./api/device.ts";
import { GPUQueue } from "./api/queue.ts";
import {
  GPUCommandBuffer,
  GPUCommandEncoder,
  GPUComputePassEncoder,
  GPURenderPassEncoder,
} from "./api/encoder.ts";
import {
  GPUBindGroup,
  GPUBindGroupLayout,
  GPUBuffer,
  GPUCompilationInfo,
  GPUCompilationMessage,
  GPUComputePipeline,
  GPUPipelineLayout,
  GPUQuerySet,
  GPURenderPipeline,
  GPUSampler,
  GPUShaderModule,
  GPUTexture,
  GPUTextureView,
} from "./api/resources.ts";
import {
  GPUError,
  GPUInternalError,
  GPUOutOfMemoryError,
  GPUUncapturedErrorEvent,
  GPUValidationError,
} from "./api/errors.ts";

/* eslint-disable @typescript-eslint/naming-convention -- these are WebGPU global names. */

/** `GPUBufferUsage` — the values wgpu-native's `WGPUBufferUsage` bitset uses. */
export const GPUBufferUsage = Object.freeze({
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
});

export const GPUTextureUsage = Object.freeze({
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
});

export const GPUShaderStage = Object.freeze({
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
});

export const GPUMapMode = Object.freeze({
  READ: 0x1,
  WRITE: 0x2,
});

export const GPUColorWrite = Object.freeze({
  RED: 0x1,
  GREEN: 0x2,
  BLUE: 0x4,
  ALPHA: 0x8,
  ALL: 0xf,
});

/** Placeholder for a name this implementation has no real class for. */
function stub(name: string): new () => object {
  const cls = class {};
  Object.defineProperty(cls, "name", { value: name });
  return cls;
}

/** Proprietary to the reference implementation; present only so the bag shape-matches. */
export const GPUSubgroupMatrixConfig = stub("GPUSubgroupMatrixConfig");
export const WGSLLanguageFeatures = stub("WGSLLanguageFeatures");
/** No surface support in this package, so there is nothing behind these two but the name. */
export const GPUCanvasContext = stub("GPUCanvasContext");
export const GPUExternalTexture = stub("GPUExternalTexture");
/** Render bundles have zero call sites in this package's target corpus and are not implemented. */
export const GPURenderBundle = stub("GPURenderBundle");
export const GPURenderBundleEncoder = stub("GPURenderBundleEncoder");
export const GPUPipelineError = stub("GPUPipelineError");
/** `features` and `limits` are a real `Set` and a plain record here, not these nominal types. */
export const GPUSupportedFeatures = stub("GPUSupportedFeatures");
export const GPUSupportedLimits = stub("GPUSupportedLimits");

/**
 * All 42 names, matching the reference implementation's bag entry for entry.
 *
 * Frozen: `Object.assign(globalThis, globals)` copies values out, so freezing costs nothing and
 * removes "somebody mutated a shared constant table" from the space of possible bugs.
 */
const GLOBALS = Object.freeze({
  GPU,
  GPUAdapter,
  GPUAdapterInfo,
  GPUBindGroup,
  GPUBindGroupLayout,
  GPUBuffer,
  GPUBufferUsage,
  GPUCanvasContext,
  GPUColorWrite,
  GPUCommandBuffer,
  GPUCommandEncoder,
  GPUCompilationInfo,
  GPUCompilationMessage,
  GPUComputePassEncoder,
  GPUComputePipeline,
  GPUDevice,
  GPUDeviceLostInfo,
  GPUError,
  GPUExternalTexture,
  GPUInternalError,
  GPUMapMode,
  GPUOutOfMemoryError,
  GPUPipelineError,
  GPUPipelineLayout,
  GPUQuerySet,
  GPUQueue,
  GPURenderBundle,
  GPURenderBundleEncoder,
  GPURenderPassEncoder,
  GPURenderPipeline,
  GPUSampler,
  GPUShaderModule,
  GPUShaderStage,
  GPUSubgroupMatrixConfig,
  GPUSupportedFeatures,
  GPUSupportedLimits,
  GPUTexture,
  GPUTextureUsage,
  GPUTextureView,
  GPUUncapturedErrorEvent,
  GPUValidationError,
  WGSLLanguageFeatures,
});

/**
 * The bag, typed both ways.
 *
 * Named access keeps its precise type; the index signature is what makes
 * `Object.assign(globalThis, globals)` and a by-name lookup legal. The single cast is the whole
 * cost of having both, and it is here rather than at every call site.
 */
export const globals = GLOBALS as typeof GLOBALS & IWebGPUGlobals;

/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Define `globalThis.navigator.gpu` backed by `gpu`.
 *
 * Opt-in, and configurable/writable so a caller can replace it. Every consumer that needs this
 * currently hand-rolls the same six lines; offering it removes a copy-paste surface, but installing
 * it automatically on import would be a library writing to a global nobody asked it to touch.
 */
export function installNavigatorGpu(gpu: GPU): void {
  const existing = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
  const value = {
    gpu: {
      requestAdapter: (options?: GPURequestAdapterOptions) => gpu.requestAdapter(options),
      getPreferredCanvasFormat: () => gpu.getPreferredCanvasFormat(),
      wgslLanguageFeatures: gpu.wgslLanguageFeatures,
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: existing ? Object.assign(Object.create(Object.getPrototypeOf(existing) ?? null), existing, value) : value,
  });
}
