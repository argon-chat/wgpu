/**
 * `GPUQueue`.
 *
 * ── `writeBuffer` / `writeTexture` element-vs-byte units ────────────────────────────────────────
 *
 * The spec measures `dataOffset` and `size` in **elements** when `data` is a `TypedArray` and in
 * **bytes** when it is a plain `ArrayBuffer`. Getting that wrong is not a crash — it is a partial
 * upload, which looks like a shader bug.
 *
 * ── `onSubmittedWorkDone` ───────────────────────────────────────────────────────────────────────
 *
 * Pumped like every other async operation, with a blocking `wgpuDevicePoll` so the submission queue
 * actually drains rather than the promise merely being *allowed* to settle.
 *
 * ── ⚠ Submitting an INVALID command buffer aborts the process ───────────────────────────────────
 *
 * Measured on this build, and worth stating plainly because it is the one place where the
 * uncaptured-error callback does **not** save you: `wgpuQueueSubmit` handles its own errors as
 * fatal. A command buffer whose encoding was invalid — say a `copyBufferToBuffer` whose source
 * lacks `COPY_SRC` — produces this, not a validation error:
 *
 * ```
 * thread '<unnamed>' panicked at src\lib.rs:605:5:
 * Error in wgpuQueueSubmit: Validation Error
 * ```
 *
 * followed by `panic in a function that cannot unwind` and an abort. The error scope is open, the
 * uncaptured-error callback is installed, and neither is consulted.
 *
 * What *does* behave normally, verified the same way: device-level creation (`createBuffer`,
 * `createBindGroup`, `createRenderPipeline`, …) and `commandEncoder.finish()` itself all report
 * through the error scope and survive. So the working shape for a negative test is
 * **encode and `finish()`, then `popErrorScope()` — but do not submit**. Submitting is only safe
 * once the encoding is known good.
 *
 * This package does not paper over it: knowing whether a buffer is valid requires an asynchronous
 * verdict, and `submit()` is synchronous by specification. Swallowing submissions on suspicion
 * would break every legitimate frame.
 */

import { ptr as bunPtr } from "bun:ffi";

import { seam } from "../ffi/abiSeam.ts";
import { callbackAddress, devicePoll, processEvents, settle, type IStatusResult } from "../ffi/async.ts";
import { wgpu } from "../ffi/library.ts";
import type { Ptr } from "../ffi/pointer.ts";
import { Arena } from "../desc/build.ts";
import {
  packExtent3D,
  packTexelCopyTextureInfo,
  writeTexelCopyBufferLayout,
} from "../desc/pass.ts";
import type { IHandleOwner } from "../desc/bindings.ts";
import { C } from "../enums.ts";
import type { GPUDevice } from "./device.ts";

/** Resolve `(data, dataOffset, size)` into a pointer and a byte count. */
function sourceBytes(
  arena: Arena,
  data: ArrayBufferView | ArrayBuffer,
  dataOffset = 0,
  size?: number,
): { pointer: Ptr; byteLength: number } {
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView & { BYTES_PER_ELEMENT?: number };
    const elementSize = view.BYTES_PER_ELEMENT ?? 1;
    const byteOffset = view.byteOffset + dataOffset * elementSize;
    const byteLength = size === undefined ? view.byteLength - dataOffset * elementSize : size * elementSize;
    return { pointer: bunPtr(view.buffer as ArrayBuffer, byteOffset), byteLength };
  }
  const buffer = data as ArrayBuffer;
  const byteLength = size === undefined ? buffer.byteLength - dataOffset : size;
  // Copy rather than offset into the caller's buffer: `ptr(ArrayBuffer, offset)` and a later GC of
  // the original are a combination this package does not need to depend on.
  return { pointer: arena.bytes(new Uint8Array(buffer, dataOffset, byteLength)), byteLength };
}

export class GPUQueue {
  readonly handle: Ptr;
  readonly #device: GPUDevice;
  label = "";

  constructor(handle: Ptr, device: GPUDevice) {
    this.handle = handle;
    this.#device = device;
  }

  /**
   * Flush staged `writeBuffer` / `writeTexture` uploads.
   *
   * ⚠ Measured, and a silent-wrong-data trap if you do not know it: `wgpuQueueWriteBuffer` stages
   * its copy into a pending internal encoder that is flushed **only by a submit**. Neither
   * `wgpuDevicePoll(wait = true)` nor `wgpuQueueOnSubmittedWorkDone` flushes it. So a
   * `writeBuffer` followed straight by `mapAsync` reads whatever was in the buffer before —
   * zeroes, typically — with no error anywhere.
   *
   * WebGPU specifies queue operations as ordered, so that divergence is the binding's to close, not
   * the caller's to remember. A zero-command submit is the cheapest thing that flushes, and it
   * cannot trip the "invalid command buffer aborts" path above because there is no command buffer.
   */
  flushWrites(): void {
    wgpu().wgpuQueueSubmit(this.handle, 0n, null);
  }

  submit(commandBuffers: Iterable<{ handle: Ptr }>): void {
    const arena = new Arena();
    const handles = Array.from(commandBuffers).map((b) => b.handle);
    wgpu().wgpuQueueSubmit(
      this.handle,
      BigInt(handles.length),
      handles.length > 0 ? arena.pointers(handles) : null,
    );
  }

  writeBuffer(
    buffer: IHandleOwner,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): void {
    const arena = new Arena();
    const { pointer, byteLength } = sourceBytes(arena, data, dataOffset, size);
    wgpu().wgpuQueueWriteBuffer(
      this.handle,
      buffer.handle,
      BigInt(bufferOffset),
      pointer,
      BigInt(byteLength),
    );
  }

  writeTexture(
    destination: GPUTexelCopyTextureInfo,
    data: ArrayBufferView | ArrayBuffer,
    dataLayout: GPUTexelCopyBufferLayout,
    size: GPUExtent3D,
  ): void {
    const arena = new Arena();
    const { pointer, byteLength } = sourceBytes(arena, data);
    const layout = arena.struct("WGPUTexelCopyBufferLayout");
    writeTexelCopyBufferLayout(layout, dataLayout);
    wgpu().wgpuQueueWriteTexture(
      this.handle,
      packTexelCopyTextureInfo(arena, destination),
      pointer,
      BigInt(byteLength),
      arena.hold(layout),
      packExtent3D(arena, size),
    );
  }

  async onSubmittedWorkDone(): Promise<void> {
    this.flushWrites(); // staged uploads are not "submitted work" until something submits
    const arena = new Arena();
    const info = arena.struct("WGPUQueueWorkDoneCallbackInfo");
    info.setEnum("mode", C.callbackMode.allowProcessEvents);
    info.setPtr("callback", callbackAddress("queueWorkDone"));
    const infoPtr = arena.hold(info);

    const result = await settle<IStatusResult>(
      () => {
        devicePoll(this.#device.handle, true);
        processEvents(this.#device.instance);
      },
      (ticket) => {
        info.setPtr("userdata1", ticket);
        seam().wgpuQueueOnSubmittedWorkDone(this.handle, infoPtr);
      },
    );

    if (result.status !== C.queueWorkDoneStatus.success) {
      throw new Error(`wgpu-bun: onSubmittedWorkDone failed (status ${result.status}) ${result.message}`);
    }
  }

  release(): void {
    wgpu().wgpuQueueRelease(this.handle);
  }
}
