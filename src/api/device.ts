/**
 * `GPUDevice`: creation, the uncaptured-error callback, error scopes, and every `create*` method.
 *
 * ══ The uncaptured-error callback goes in at creation, before anything can fail ══
 *
 * wgpu-native's default uncaptured-error handler **panics**, and the panic crosses a `nounwind`
 * boundary, so it aborts. There is no post-hoc setter and therefore no safe window in which the
 * callback is missing: it is written into the `WGPUDeviceDescriptor` unconditionally, in the same
 * call that creates the device. Not an option, not a flag — the first thing that happens.
 *
 * The callback resolves the device through an integer id, never through a pointer, for the same
 * reason the async layer uses integer tickets: nothing that C holds should be an address into
 * JS-owned memory. It also cannot throw — a JS exception propagating back into Rust would turn the
 * mechanism that prevents aborts into a cause of them.
 *
 * ══ `getCompilationInfo` is recovered from an error scope ══
 *
 * `wgpuShaderModuleGetCompilationInfo` aborts the process, so shader diagnostics have to come from
 * somewhere else. `createShaderModule` wraps its native call in an internal validation scope and
 * hands the pending verdict to the module.
 *
 * The obvious hazard with that is nesting: an internal scope opened inside a caller's scope would
 * *swallow* the error the caller was waiting for, silently converting a red assertion into a green
 * one. {@link ErrorScopeStack} closes it — an intercepted error is deposited into the innermost
 * caller scope with a matching filter, and `popErrorScope()` returns the native result or the
 * deposit. Both the caller and the shader module see the error.
 *
 * The ordering that makes it work: the JS mirror entry is popped **after** awaiting the native pop,
 * so any internal scope that settles during that pump still has a live entry to deposit into.
 */

import { FFIType, JSCallback, read } from "bun:ffi";

import { seam } from "../ffi/abiSeam.ts";
import {
  callbacks,
  devicePoll,
  processEvents,
  settle,
  type IErrorScopeResult,
  type IHandleResult,
} from "../ffi/async.ts";
import { wgpu } from "../ffi/library.ts";
import { asAddress, requireHandle, type Ptr } from "../ffi/pointer.ts";
import { readStringView } from "../ffi/strings.ts";
import { Arena } from "../desc/build.ts";
import {
  packBindGroupDescriptor,
  packBindGroupLayoutDescriptor,
  packPipelineLayoutDescriptor,
  type IHandleOwner,
} from "../desc/bindings.ts";
import { packComputePipelineDescriptor, packRenderPipelineDescriptor } from "../desc/pipeline.ts";
import {
  packBufferDescriptor,
  packQuerySetDescriptor,
  packSamplerDescriptor,
  packShaderModuleDescriptor,
  packTextureDescriptor,
} from "../desc/resources.ts";
import { C, ERROR_FILTER, FEATURE_NAME, featureNameOf, toEnum } from "../enums.ts";
import type { GPUAdapter } from "./adapter.ts";
import { ErrorScopeStack, GPUUncapturedErrorEvent, errorFor, type GPUError } from "./errors.ts";
import { GPUQueue } from "./queue.ts";
import {
  GPUBindGroup,
  GPUBindGroupLayout,
  GPUBuffer,
  GPUComputePipeline,
  GPUPipelineLayout,
  GPUQuerySet,
  GPURenderPipeline,
  GPUSampler,
  GPUShaderModule,
  GPUTexture,
} from "./resources.ts";
import { GPUCommandEncoder } from "./encoder.ts";

/**
 * Live devices, keyed by a monotonic integer.
 *
 * The integer — not the device pointer — is what goes into `userdata1`. Same discipline as the
 * async tickets, same reason: an unknown id is ignored rather than dereferenced, so a callback
 * arriving after teardown is a no-op instead of a crash.
 */
const devices = new Map<number, GPUDevice>();
let nextDeviceId = 1;

const { ptr, u32, u64, void: v } = FFIType;

/** `(WGPUDevice const*, WGPUErrorType, WGPUStringView, userdata1, userdata2)` */
const uncapturedErrorCallback = new JSCallback(
  (_device: number, errorType: number, message: number, ud1: bigint) => {
    // Must never throw: this frame returns into Rust.
    try {
      devices.get(Number(ud1))?.handleUncapturedError(errorType, readStringView(message));
    } catch {
      /* swallowed on purpose — see the module header */
    }
  },
  { args: [ptr, u32, ptr, u64, u64], returns: v },
);

/** `(WGPUDevice const*, WGPUDeviceLostReason, WGPUStringView, userdata1, userdata2)` */
const deviceLostCallback = new JSCallback(
  (_device: number, reason: number, message: number, ud1: bigint) => {
    try {
      devices.get(Number(ud1))?.handleDeviceLost(reason, readStringView(message));
    } catch {
      /* swallowed on purpose */
    }
  },
  { args: [ptr, u32, ptr, u64, u64], returns: v },
);

/** What a device lost report looks like. */
export class GPUDeviceLostInfo {
  readonly reason: GPUDeviceLostReason;
  readonly message: string;
  constructor(reason: GPUDeviceLostReason, message: string) {
    this.reason = reason;
    this.message = message;
  }
}

/**
 * Ask an adapter for a device.
 *
 * Features are validated against the adapter **before** the request, because `requestDevice` fails
 * wholesale if any requested feature is unsupported and the resulting message names none of them.
 * Limits the caller did not mention are left at `WGPU_LIMIT_*_UNDEFINED` rather than zero — a zero
 * limit is a request for nothing, not a request for the default.
 */
export async function requestDevice(
  adapter: GPUAdapter,
  descriptor?: GPUDeviceDescriptor,
): Promise<GPUDevice> {
  const arena = new Arena();
  const deviceId = nextDeviceId++;

  const d = arena.struct("WGPUDeviceDescriptor");
  arena.writeString(d.sub("label"), descriptor?.label);

  const requested = descriptor?.requiredFeatures ? Array.from(descriptor.requiredFeatures) : [];
  const missing = requested.filter((f) => !adapter.features.has(f));
  if (missing.length > 0) {
    throw new Error(
      `wgpu-bun: adapter does not support requiredFeatures [${missing.join(", ")}] on the ` +
        `${adapter.info.backend} backend. Available: ${[...adapter.features].join(", ")}.\n` +
        `  Feature availability is backend-dependent here — 'shader-f16' in particular is present ` +
        `on Vulkan and absent on D3D12 for the same adapter.`,
    );
  }
  if (requested.length > 0) {
    d.setUsize("requiredFeatureCount", requested.length);
    d.setPtr("requiredFeatures", arena.u32s(requested.map((f) => toEnum(FEATURE_NAME, f, "GPUFeatureName"))));
  }

  if (descriptor?.requiredLimits) {
    const limits = arena.struct("WGPULimits");
    const dynamic = limits as unknown as { setU32(m: string, v: number): void; setU64(m: string, v: bigint): void };
    for (const [name, value] of Object.entries(descriptor.requiredLimits)) {
      const field = limits.layout.byName.get(name);
      if (!field || value === undefined) continue;
      if (field.tag === "u32") dynamic.setU32(name, Number(value));
      else if (field.tag === "u64") dynamic.setU64(name, BigInt(value));
    }
    d.setPtr("requiredLimits", arena.hold(limits));
  }

  arena.writeString(d.sub("defaultQueue").sub("label"), descriptor?.defaultQueue?.label);

  // ███ The precondition. Without this, the first validation error aborts the process. ███
  d.sub("uncapturedErrorCallbackInfo")
    .setPtr("callback", uncapturedErrorCallback.ptr)
    .setPtr("userdata1", deviceId);

  d.sub("deviceLostCallbackInfo")
    .setEnum("mode", C.callbackMode.allowProcessEvents)
    .setPtr("callback", deviceLostCallback.ptr)
    .setPtr("userdata1", deviceId);

  const descriptorPtr = arena.hold(d);

  const info = arena.struct("WGPURequestDeviceCallbackInfo");
  info.setEnum("mode", C.callbackMode.allowProcessEvents);
  info.setPtr("callback", callbacks.requestDevice.ptr);
  const infoPtr = arena.hold(info);

  const instance = adapter.gpu.instance;
  const result = await settle<IHandleResult>(
    () => processEvents(instance),
    (ticket) => {
      info.setPtr("userdata1", ticket);
      seam().wgpuAdapterRequestDevice(adapter.handle, descriptorPtr, infoPtr);
    },
  );

  if (result.status !== C.requestDeviceStatus.success || !result.handle) {
    throw new Error(`wgpu-bun: requestDevice failed (status ${result.status}) ${result.message}`);
  }

  const device = new GPUDevice(result.handle, deviceId, adapter, descriptor?.label);
  devices.set(deviceId, device);

  if (adapter.gpu.verbose) {
    console.error(`wgpu-bun: device on ${adapter.info.describe()}`);
  }
  return device;
}

export class GPUDevice {
  readonly handle: Ptr;
  readonly adapter: GPUAdapter;
  label: string;

  readonly #id: number;
  readonly #queue: GPUQueue;
  readonly #features: Set<string>;
  readonly #scopes = new ErrorScopeStack();
  #lostResolve: ((info: GPUDeviceLostInfo) => void) | null = null;
  readonly #lost: Promise<GPUDeviceLostInfo>;
  #destroyed = false;

  /** Assignable in the DOM style callers use: `device.onuncapturederror = e => …`. */
  onuncapturederror: ((event: GPUUncapturedErrorEvent) => void) | null = null;

  constructor(handle: Ptr, id: number, adapter: GPUAdapter, label: string | undefined) {
    this.handle = handle;
    this.#id = id;
    this.adapter = adapter;
    this.label = label ?? "";
    this.#queue = new GPUQueue(requireHandle(wgpu().wgpuDeviceGetQueue(handle), "wgpuDeviceGetQueue"), this);
    this.#features = GPUDevice.#readFeatures(handle);
    this.#lost = new Promise<GPUDeviceLostInfo>((resolve) => {
      this.#lostResolve = resolve;
    });
  }

  static #readFeatures(handle: Ptr): Set<string> {
    const arena = new Arena();
    const supported = arena.struct("WGPUSupportedFeatures");
    const structPtr = arena.hold(supported);
    wgpu().wgpuDeviceGetFeatures(handle, structPtr);
    const count = supported.getCount("featureCount");
    const values = asAddress(supported.getPtr("features"));
    const out = new Set<string>();
    for (let i = 0; i < count; i++) {
      const name = featureNameOf(read.u32(values, i * 4));
      if (name) out.add(name);
    }
    seam().wgpuSupportedFeaturesFreeMembers(structPtr);
    return out;
  }

  get instance(): Ptr {
    return this.adapter.gpu.instance;
  }

  get queue(): GPUQueue {
    return this.#queue;
  }

  get features(): ReadonlySet<string> {
    return this.#features;
  }

  get limits(): Record<string, number> {
    return this.adapter.limits;
  }

  /** Resolves only on an actual device loss. Never resolves on a healthy device, as the spec says. */
  get lost(): Promise<GPUDeviceLostInfo> {
    return this.#lost;
  }

  /** @internal — called from the native uncaptured-error callback. */
  handleUncapturedError(errorType: number, message: string): void {
    const error = errorFor(errorType, message);
    if (!error) return;
    if (this.onuncapturederror) {
      this.onuncapturederror(new GPUUncapturedErrorEvent(error));
      return;
    }
    // No handler installed: report rather than swallow. Silence here is how a validation error
    // becomes an unexplained wrong pixel three suites later.
    console.error(`wgpu-bun: uncaptured error on device "${this.label}":\n${message}`);
  }

  /** @internal — called from the native device-lost callback. */
  handleDeviceLost(reason: number, message: string): void {
    this.#lostResolve?.(new GPUDeviceLostInfo(reason === 2 ? "destroyed" : "unknown", message));
    this.#lostResolve = null;
  }

  // ── error scopes ────────────────────────────────────────────────────────────────────────────

  pushErrorScope(filter: GPUErrorFilter): void {
    wgpu().wgpuDevicePushErrorScope(this.handle, toEnum(ERROR_FILTER, filter, "GPUErrorFilter"));
    this.#scopes.push(filter);
  }

  /**
   * Pop the innermost scope.
   *
   * Cannot resolve without having pumped, because the result is produced only by the native
   * callback. That is what stops an empty result from meaning "we never asked".
   */
  async popErrorScope(): Promise<GPUError | null> {
    // ── A state-dependent abort, and the reason this guard is not optional ──────────────────────
    // `wgpuDevicePopErrorScope` with no scope open panics inside wgpu-native (`lib.rs`, an
    // `Option::unwrap()` on `None`) and takes the process with it — a non-unwinding panic across the
    // C ABI, so there is nothing to catch. Verified against the pinned 29.0.1 build.
    //
    // This is a DIFFERENT class from the blocklisted symbols: those abort whenever they are called,
    // and are caught by a symbol-level list. This one is a working symbol that aborts in a
    // particular state, so no export-table check can find it — only the caller can prevent it.
    //
    // WebGPU §"popErrorScope" says an empty stack must reject with an OperationError, so refusing
    // here is spec-conformant rather than a private invention. The shadow stack is authoritative
    // for the question: `pushErrorScope` pushes to both, this method pops both, so they cannot
    // disagree about depth.
    if (this.#scopes.depth === 0) {
      throw new DOMException("popErrorScope called with no error scope open", "OperationError");
    }
    const native = await this.#popNativeScope();
    // Popped *after* the await so that an internal scope settling during that pump still has this
    // entry to deposit into.
    const shadow = this.#scopes.pop();
    return native ?? shadow ?? null;
  }

  async #popNativeScope(): Promise<GPUError | null> {
    const arena = new Arena();
    const info = arena.struct("WGPUPopErrorScopeCallbackInfo");
    info.setEnum("mode", C.callbackMode.allowProcessEvents);
    info.setPtr("callback", callbacks.popErrorScope.ptr);
    const infoPtr = arena.hold(info);

    const result = await settle<IErrorScopeResult>(
      () => {
        devicePoll(this.handle, false);
        processEvents(this.instance);
      },
      (ticket) => {
        info.setPtr("userdata1", ticket);
        seam().wgpuDevicePopErrorScope(this.handle, infoPtr);
      },
    );

    if (result.status !== C.popErrorScopeStatus.success) {
      // A failed pop is itself an error worth surfacing. Note it is NOT the empty-stack case: that
      // one aborts the process and is refused by the guard in `popErrorScope` before reaching here.
      return errorFor(C.errorType.validation, result.message || `popErrorScope status ${result.status}`);
    }
    return errorFor(result.errorType, result.message);
  }

  /** An internal scope used to recover diagnostics wgpu-native will not hand over directly. */
  #captureInternal(): Promise<GPUError | null> {
    return this.#popNativeScope().then((error) => {
      if (error) this.#scopes.deposit(error);
      return error;
    });
  }

  // ── resource creation ───────────────────────────────────────────────────────────────────────

  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreateBuffer(this.handle, packBufferDescriptor(arena, descriptor));
    return new GPUBuffer(handle, this, descriptor);
  }

  createTexture(descriptor: GPUTextureDescriptor): GPUTexture {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreateTexture(this.handle, packTextureDescriptor(arena, descriptor));
    return new GPUTexture(handle, descriptor.label);
  }

  createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreateSampler(this.handle, packSamplerDescriptor(arena, descriptor));
    return new GPUSampler(handle, descriptor?.label);
  }

  /**
   * Compile a shader module.
   *
   * Synchronous, as the spec requires — but the validation verdict is asynchronous here, so it is
   * captured now and awaited later by `getCompilationInfo()`.
   */
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule {
    const arena = new Arena();
    const descriptorPtr = packShaderModuleDescriptor(arena, descriptor);
    // WGPUErrorFilter_Validation — NOT WGPUErrorType_Validation. The two enums are numbered
    // differently, and using the wrong one here would open a scope for the wrong class of error.
    wgpu().wgpuDevicePushErrorScope(this.handle, toEnum(ERROR_FILTER, "validation", "GPUErrorFilter"));
    const handle = wgpu().wgpuDeviceCreateShaderModule(this.handle, descriptorPtr);
    const diagnostics = this.#captureInternal();
    return new GPUShaderModule(handle, descriptor.label, diagnostics);
  }

  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreateBindGroupLayout(
      this.handle,
      packBindGroupLayoutDescriptor(arena, descriptor),
    );
    return new GPUBindGroupLayout(handle, descriptor.label);
  }

  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup {
    const arena = new Arena();
    const layout = (descriptor.layout as unknown as IHandleOwner).handle;
    const handle = wgpu().wgpuDeviceCreateBindGroup(
      this.handle,
      packBindGroupDescriptor(arena, descriptor, layout),
    );
    return new GPUBindGroup(handle, descriptor.label);
  }

  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreatePipelineLayout(
      this.handle,
      packPipelineLayoutDescriptor(arena, descriptor),
    );
    return new GPUPipelineLayout(handle, descriptor.label);
  }

  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreateComputePipeline(
      this.handle,
      packComputePipelineDescriptor(arena, descriptor),
    );
    return new GPUComputePipeline(handle, descriptor.label);
  }

  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreateRenderPipeline(
      this.handle,
      packRenderPipelineDescriptor(arena, descriptor),
    );
    return new GPURenderPipeline(handle, descriptor.label);
  }

  /**
   * `wgpuDeviceCreateComputePipelineAsync` aborts the process, so the async spelling is served by
   * the synchronous call. Honest, and strictly better than a stub that kills the runner.
   */
  async createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline> {
    return this.createComputePipeline(descriptor);
  }

  /** Same as above, for the render pipeline. */
  async createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
    return this.createRenderPipeline(descriptor);
  }

  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder {
    const arena = new Arena();
    const d = arena.struct("WGPUCommandEncoderDescriptor");
    arena.writeString(d.sub("label"), descriptor?.label);
    const handle = wgpu().wgpuDeviceCreateCommandEncoder(this.handle, arena.hold(d));
    return new GPUCommandEncoder(handle, descriptor?.label);
  }

  createQuerySet(descriptor: GPUQuerySetDescriptor): GPUQuerySet {
    const arena = new Arena();
    const handle = wgpu().wgpuDeviceCreateQuerySet(this.handle, packQuerySetDescriptor(arena, descriptor));
    return new GPUQuerySet(handle, descriptor.label);
  }

  // ── pumping and teardown ────────────────────────────────────────────────────────────────────

  /**
   * Drive pending work.
   *
   * Exposed for callers running their own frame loop, but **nothing in this package's correctness
   * depends on anyone calling it** — every async operation pumps for itself. An API that is correct
   * only if the caller remembers is how silently-green suites get written.
   */
  poll(wait = true): void {
    devicePoll(this.handle, wait);
    processEvents(this.instance);
  }

  /**
   * Flush staged queue uploads.
   *
   * Delegated to the queue, and called automatically by `mapAsync` and `onSubmittedWorkDone`, so
   * ordering holds without the caller knowing it had to. See `GPUQueue.flushWrites`.
   */
  flushWrites(): void {
    this.#queue.flushWrites();
  }

  hasFeature(name: string): boolean {
    return this.#features.has(name);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    devices.delete(this.#id);
    wgpu().wgpuDeviceDestroy(this.handle);
    wgpu().wgpuDeviceRelease(this.handle);
  }
}
