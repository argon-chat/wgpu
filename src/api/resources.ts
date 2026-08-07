/**
 * The resource objects: buffers, textures, views, samplers, query sets, shader modules, layouts and
 * pipelines.
 *
 * ── Labels are set at creation and never afterwards ─────────────────────────────────────────────
 *
 * Twenty-one `wgpu*SetLabel` entry points are `unimplemented!()` stubs that **abort the process**.
 * A `label` setter that forwarded naively would turn a cosmetic line of code into a process kill
 * with a Rust backtrace and no JS stack. So `label` here is a plain JS property: it is passed into
 * the descriptor at creation time (where it works, and where wgpu-native actually uses it in error
 * messages) and is otherwise inert.
 *
 * ── Buffer mapping returns a copy, not a window onto driver memory ──────────────────────────────
 *
 * `getMappedRange` could return an `ArrayBuffer` aliasing the mapped native pages, which is what
 * the spec describes and what is cheapest. It is also a use-after-free waiting to happen: the very
 * common
 *
 * ```ts
 * const data = new Float32Array(buffer.getMappedRange());
 * buffer.unmap();
 * expect(data[0]).toBe(…);          // reads freed driver memory
 * ```
 *
 * would read plausible garbage rather than fail, and the spec's protection against it — detaching
 * the `ArrayBuffer` on unmap — is not something a plain FFI view can be made to do.
 *
 * So a mapped range is copied into JS memory, memoised per `(offset, size)` so repeated calls
 * return the *same* object as the spec requires, and — for a write mapping — copied **back** into
 * the driver's memory during `unmap()`. Reads are safe by construction and writes still land. The
 * cost is one memcpy per mapped range, which is nothing next to the GPU work that produced it.
 */

import { toArrayBuffer } from "bun:ffi";

import { seam } from "../ffi/abiSeam.ts";
import { callbackAddress, devicePoll, processEvents, settle, type IStatusResult } from "../ffi/async.ts";
import { wgpu } from "../ffi/library.ts";
import { asAddress, requireHandle, type Ptr } from "../ffi/pointer.ts";
import { Arena } from "../desc/build.ts";
import { C, TEXTURE_FORMAT } from "../enums.ts";
import { packTextureViewDescriptor } from "../desc/resources.ts";
import type { GPUError } from "./errors.ts";

/** Everything a resource needs from the device that made it. */
export interface IDeviceContext {
  readonly handle: Ptr;
  readonly instance: Ptr;
  /** Flush staged queue uploads. See `GPUQueue.flushWrites` for why this is not optional. */
  flushWrites(): void;
}

/** Common base: a native handle, a JS-side label, and a release that runs at most once. */
export abstract class GPUResource {
  readonly handle: Ptr;
  /** Purely informational after creation — see the module header on `SetLabel`. */
  label: string;
  #released = false;

  constructor(handle: Ptr | null, label: string | undefined) {
    this.handle = requireHandle(handle, new.target.name);
    this.label = label ?? "";
  }

  protected abstract releaseNative(): void;

  /** Drop the native reference. Idempotent: a double release must not be a crash. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.releaseNative();
  }
}

// ── buffer ────────────────────────────────────────────────────────────────────────────────────

/** One live `getMappedRange` result. */
interface IMappedRange {
  readonly offset: number;
  readonly size: number;
  readonly copy: ArrayBuffer;
}

export class GPUBuffer extends GPUResource {
  readonly #device: IDeviceContext;
  readonly size: number;
  readonly usage: number;
  #ranges = new Map<string, IMappedRange>();
  #mappedForWrite: boolean;
  #mapped: boolean;

  constructor(handle: Ptr | null, device: IDeviceContext, descriptor: GPUBufferDescriptor) {
    super(handle, descriptor.label);
    this.#device = device;
    this.size = Number(descriptor.size);
    this.usage = descriptor.usage;
    this.#mappedForWrite = descriptor.mappedAtCreation ?? false;
    this.#mapped = descriptor.mappedAtCreation ?? false;
  }

  /**
   * `mapState` is reported from this object's own bookkeeping.
   *
   * `wgpuBufferGetMapState` is an aborting stub, so asking the driver is not an option — and a
   * tracked value is in any case what every caller means by the question.
   */
  get mapState(): GPUBufferMapState {
    return this.#mapped ? "mapped" : "unmapped";
  }

  async mapAsync(mode: number, offset = 0, size?: number): Promise<void> {
    // Staged `writeBuffer` uploads are flushed only by a submit — not by polling. Without this,
    // mapping straight after a write reads the buffer's previous contents and reports success.
    this.#device.flushWrites();
    const length = size ?? this.size - offset;
    const arena = new Arena();
    const info = arena.struct("WGPUBufferMapCallbackInfo");
    info.setEnum("mode", C.callbackMode.allowProcessEvents);
    info.setPtr("callback", callbackAddress("bufferMap"));
    const infoPtr = arena.hold(info);

    const result = await settle<IStatusResult>(
      () => {
        // wait=true drains the submission queue, which is what makes the copy that produced this
        // buffer's contents actually complete before the map callback can fire.
        devicePoll(this.#device.handle, true);
        processEvents(this.#device.instance);
      },
      (ticket) => {
        info.setPtr("userdata1", ticket);
        seam().wgpuBufferMapAsync(this.handle, BigInt(mode), BigInt(offset), BigInt(length), infoPtr);
      },
    );

    if (result.status !== C.mapAsyncStatus.success) {
      throw new Error(`wgpu-bun: buffer.mapAsync failed (status ${result.status}) ${result.message}`);
    }
    this.#mapped = true;
    this.#mappedForWrite = (mode & 2) !== 0; // GPUMapMode.WRITE
  }

  /**
   * A copy of the mapped range. Repeated calls for the same range return the same `ArrayBuffer`,
   * as the spec requires.
   */
  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    const length = size ?? this.size - offset;
    const key = `${offset}:${length}`;
    const existing = this.#ranges.get(key);
    if (existing) return existing.copy;

    const native = this.#mappedForWrite
      ? wgpu().wgpuBufferGetMappedRange(this.handle, BigInt(offset), BigInt(length))
      : wgpu().wgpuBufferGetConstMappedRange(this.handle, BigInt(offset), BigInt(length));
    if (!native) {
      throw new Error(
        `wgpu-bun: getMappedRange(${offset}, ${length}) returned NULL — the buffer is not mapped ` +
          `over that range. (mapState=${this.mapState})`,
      );
    }

    const copy = new ArrayBuffer(length);
    new Uint8Array(copy).set(new Uint8Array(toArrayBuffer(native, 0, length)));
    this.#ranges.set(key, { offset, size: length, copy });
    return copy;
  }

  /** Flush any write mappings back into driver memory, then unmap. */
  unmap(): void {
    if (this.#mappedForWrite) {
      for (const range of this.#ranges.values()) {
        const native = wgpu().wgpuBufferGetMappedRange(this.handle, BigInt(range.offset), BigInt(range.size));
        if (!native) continue;
        new Uint8Array(toArrayBuffer(native, 0, range.size)).set(new Uint8Array(range.copy));
      }
    }
    this.#ranges.clear();
    this.#mapped = false;
    this.#mappedForWrite = false;
    wgpu().wgpuBufferUnmap(this.handle);
  }

  destroy(): void {
    this.#ranges.clear();
    this.#mapped = false;
    wgpu().wgpuBufferDestroy(this.handle);
    this.release();
  }

  protected override releaseNative(): void {
    wgpu().wgpuBufferRelease(this.handle);
  }
}

// ── textures, views, samplers ─────────────────────────────────────────────────────────────────

const FORMAT_BY_VALUE = new Map<number, string>(
  Object.entries(TEXTURE_FORMAT).map(([name, value]) => [value, name]),
);

export class GPUTextureView extends GPUResource {
  /** Distinguishes a view from a sampler when packing a bind-group entry. */
  readonly kind = "textureView";
  protected override releaseNative(): void {
    wgpu().wgpuTextureViewRelease(this.handle);
  }
}

export class GPUSampler extends GPUResource {
  readonly kind = "sampler";
  protected override releaseNative(): void {
    wgpu().wgpuSamplerRelease(this.handle);
  }
}

export class GPUTexture extends GPUResource {
  createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    const arena = new Arena();
    const handle = wgpu().wgpuTextureCreateView(
      this.handle,
      packTextureViewDescriptor(arena, descriptor) || null,
    );
    return new GPUTextureView(handle, descriptor?.label);
  }

  get width(): number { return wgpu().wgpuTextureGetWidth(this.handle); }
  get height(): number { return wgpu().wgpuTextureGetHeight(this.handle); }
  get depthOrArrayLayers(): number { return wgpu().wgpuTextureGetDepthOrArrayLayers(this.handle); }
  get mipLevelCount(): number { return wgpu().wgpuTextureGetMipLevelCount(this.handle); }
  get sampleCount(): number { return wgpu().wgpuTextureGetSampleCount(this.handle); }
  get usage(): number { return Number(wgpu().wgpuTextureGetUsage(this.handle)); }

  get dimension(): GPUTextureDimension {
    return (["1d", "2d", "3d"][wgpu().wgpuTextureGetDimension(this.handle) - 1] ?? "2d") as GPUTextureDimension;
  }

  get format(): GPUTextureFormat {
    const value = wgpu().wgpuTextureGetFormat(this.handle);
    return (FORMAT_BY_VALUE.get(value) ?? "rgba8unorm") as GPUTextureFormat;
  }

  destroy(): void {
    wgpu().wgpuTextureDestroy(this.handle);
    this.release();
  }

  protected override releaseNative(): void {
    wgpu().wgpuTextureRelease(this.handle);
  }
}

export class GPUQuerySet extends GPUResource {
  get count(): number { return wgpu().wgpuQuerySetGetCount(this.handle); }
  destroy(): void { this.release(); }
  protected override releaseNative(): void {
    wgpu().wgpuQuerySetRelease(this.handle);
  }
}

// ── shader modules ────────────────────────────────────────────────────────────────────────────

export class GPUCompilationMessage {
  readonly message: string;
  readonly type: GPUCompilationMessageType;
  readonly lineNum: number;
  readonly linePos: number;
  readonly offset = 0;
  readonly length = 0;

  constructor(message: string, type: GPUCompilationMessageType, lineNum = 0, linePos = 0) {
    this.message = message;
    this.type = type;
    this.lineNum = lineNum;
    this.linePos = linePos;
  }
}

export class GPUCompilationInfo {
  readonly messages: readonly GPUCompilationMessage[];
  constructor(messages: readonly GPUCompilationMessage[]) {
    this.messages = messages;
  }
}

/**
 * A compiled shader module.
 *
 * `wgpuShaderModuleGetCompilationInfo` is an aborting stub in this build, so diagnostics are
 * recovered from an error scope wrapped around creation — see {@link ./device.ts}. The pending
 * verdict is handed in as a promise and is only awaited if someone asks for it, which keeps
 * `createShaderModule` synchronous the way the spec requires.
 *
 * The distinction that matters: an **empty** message list here means "wgpu-native reported no
 * error", never "we did not look". Returning `{messages: []}` unconditionally would turn every
 * "does this generated WGSL compile?" assertion green regardless of the answer.
 */
export class GPUShaderModule extends GPUResource {
  readonly #diagnostics: Promise<GPUError | null>;

  constructor(handle: Ptr | null, label: string | undefined, diagnostics: Promise<GPUError | null>) {
    super(handle, label);
    this.#diagnostics = diagnostics;
    // Nobody may await this by default, and an unhandled rejection would be reported against an
    // unrelated stack.
    void this.#diagnostics.catch(() => null);
  }

  async getCompilationInfo(): Promise<GPUCompilationInfo> {
    const error = await this.#diagnostics;
    if (!error) return new GPUCompilationInfo([]);
    const [, line, column] = /wgsl:(\d+):(\d+)/.exec(error.message) ?? [];
    return new GPUCompilationInfo([
      new GPUCompilationMessage(error.message, "error", Number(line ?? 0), Number(column ?? 0)),
    ]);
  }

  protected override releaseNative(): void {
    wgpu().wgpuShaderModuleRelease(this.handle);
  }
}

// ── layouts and pipelines ─────────────────────────────────────────────────────────────────────

export class GPUBindGroupLayout extends GPUResource {
  protected override releaseNative(): void {
    wgpu().wgpuBindGroupLayoutRelease(this.handle);
  }
}

export class GPUBindGroup extends GPUResource {
  protected override releaseNative(): void {
    wgpu().wgpuBindGroupRelease(this.handle);
  }
}

export class GPUPipelineLayout extends GPUResource {
  protected override releaseNative(): void {
    wgpu().wgpuPipelineLayoutRelease(this.handle);
  }
}

export class GPUComputePipeline extends GPUResource {
  getBindGroupLayout(index: number): GPUBindGroupLayout {
    return new GPUBindGroupLayout(
      wgpu().wgpuComputePipelineGetBindGroupLayout(this.handle, index),
      `${this.label}[group ${index}]`,
    );
  }
  protected override releaseNative(): void {
    wgpu().wgpuComputePipelineRelease(this.handle);
  }
}

export class GPURenderPipeline extends GPUResource {
  getBindGroupLayout(index: number): GPUBindGroupLayout {
    return new GPUBindGroupLayout(
      wgpu().wgpuRenderPipelineGetBindGroupLayout(this.handle, index),
      `${this.label}[group ${index}]`,
    );
  }
  protected override releaseNative(): void {
    wgpu().wgpuRenderPipelineRelease(this.handle);
  }
}
