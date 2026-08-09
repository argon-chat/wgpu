/**
 * Command encoding: `GPUCommandEncoder`, the two pass encoders, and `GPUCommandBuffer`.
 *
 * Debug groups and markers are **no-ops**, not forwarded. `wgpuCommandEncoderPushDebugGroup` and
 * friends take a `WGPUStringView` by value, which is the second half of the by-value ABI hazard,
 * and the corresponding `SetLabel` entry points abort outright. A no-op is the honest
 * implementation: these calls exist to annotate a capture, and nothing in this package's remit
 * depends on the annotation appearing.
 */

import { wgpu } from "../ffi/library.ts";
import { requireHandle, type Ptr } from "../ffi/pointer.ts";
import { Arena } from "../desc/build.ts";
import {
  packComputePassDescriptor,
  packExtent3D,
  packRenderPassDescriptor,
  packTexelCopyBufferInfo,
  packTexelCopyTextureInfo,
} from "../desc/pass.ts";
import type { IHandleOwner } from "../desc/bindings.ts";
import { INDEX_FORMAT, toEnum } from "../enums.ts";
import { GPUResource } from "./resources.ts";

export class GPUCommandBuffer extends GPUResource {
  protected override releaseNative(): void {
    wgpu().wgpuCommandBufferRelease(this.handle);
  }
}

/** Shared by both pass encoders: pipeline, bind groups, debug annotation, `end`. */
abstract class PassEncoder {
  readonly handle: Ptr;
  label: string;

  constructor(handle: Ptr | null, label: string | undefined) {
    this.handle = requireHandle(handle, new.target.name);
    this.label = label ?? "";
  }

  /** No-op — see the module header. */
  pushDebugGroup(_groupLabel: string): void {}
  /** No-op — see the module header. */
  popDebugGroup(): void {}
  /** No-op — see the module header. */
  insertDebugMarker(_markerLabel: string): void {}
}

export class GPUComputePassEncoder extends PassEncoder {
  setPipeline(pipeline: IHandleOwner): void {
    wgpu().wgpuComputePassEncoderSetPipeline(this.handle, pipeline.handle);
  }

  setBindGroup(index: number, bindGroup: IHandleOwner | null, dynamicOffsets?: Iterable<number>): void {
    const arena = new Arena();
    const offsets = dynamicOffsets ? Array.from(dynamicOffsets) : [];
    wgpu().wgpuComputePassEncoderSetBindGroup(
      this.handle,
      index,
      bindGroup ? bindGroup.handle : null,
      BigInt(offsets.length),
      offsets.length > 0 ? arena.u32s(offsets) : null,
    );
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    wgpu().wgpuComputePassEncoderDispatchWorkgroups(this.handle, x, y, z);
  }

  dispatchWorkgroupsIndirect(indirectBuffer: IHandleOwner, indirectOffset: number): void {
    wgpu().wgpuComputePassEncoderDispatchWorkgroupsIndirect(
      this.handle,
      indirectBuffer.handle,
      BigInt(indirectOffset),
    );
  }

  end(): void {
    wgpu().wgpuComputePassEncoderEnd(this.handle);
    wgpu().wgpuComputePassEncoderRelease(this.handle);
  }
}

export class GPURenderPassEncoder extends PassEncoder {
  setPipeline(pipeline: IHandleOwner): void {
    wgpu().wgpuRenderPassEncoderSetPipeline(this.handle, pipeline.handle);
  }

  setBindGroup(index: number, bindGroup: IHandleOwner | null, dynamicOffsets?: Iterable<number>): void {
    const arena = new Arena();
    const offsets = dynamicOffsets ? Array.from(dynamicOffsets) : [];
    wgpu().wgpuRenderPassEncoderSetBindGroup(
      this.handle,
      index,
      bindGroup ? bindGroup.handle : null,
      BigInt(offsets.length),
      offsets.length > 0 ? arena.u32s(offsets) : null,
    );
  }

  /**
   * `size` omitted means "to the end of the buffer". That is spelled `WGPU_WHOLE_SIZE`
   * (`UINT64_MAX`) rather than 0, which would mean an empty binding.
   */
  setVertexBuffer(slot: number, buffer: IHandleOwner | null, offset = 0, size?: number): void {
    wgpu().wgpuRenderPassEncoderSetVertexBuffer(
      this.handle,
      slot,
      buffer ? buffer.handle : null,
      BigInt(offset),
      size === undefined ? 0xffffffffffffffffn : BigInt(size),
    );
  }

  setIndexBuffer(buffer: IHandleOwner, indexFormat: GPUIndexFormat, offset = 0, size?: number): void {
    wgpu().wgpuRenderPassEncoderSetIndexBuffer(
      this.handle,
      buffer.handle,
      toEnum(INDEX_FORMAT, indexFormat, "GPUIndexFormat"),
      BigInt(offset),
      size === undefined ? 0xffffffffffffffffn : BigInt(size),
    );
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    wgpu().wgpuRenderPassEncoderDraw(this.handle, vertexCount, instanceCount, firstVertex, firstInstance);
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    wgpu().wgpuRenderPassEncoderDrawIndexed(
      this.handle,
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance,
    );
  }

  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    wgpu().wgpuRenderPassEncoderSetViewport(this.handle, x, y, width, height, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    wgpu().wgpuRenderPassEncoderSetScissorRect(this.handle, x, y, width, height);
  }

  setBlendConstant(color: GPUColor): void {
    const arena = new Arena();
    const c = arena.struct("WGPUColor");
    if (Array.isArray(color) || ArrayBuffer.isView(color)) {
      const v = Array.from(color as Iterable<number>);
      c.setF64("r", v[0] ?? 0).setF64("g", v[1] ?? 0).setF64("b", v[2] ?? 0).setF64("a", v[3] ?? 0);
    } else {
      const d = color as GPUColorDict;
      c.setF64("r", d.r).setF64("g", d.g).setF64("b", d.b).setF64("a", d.a);
    }
    wgpu().wgpuRenderPassEncoderSetBlendConstant(this.handle, arena.hold(c));
  }

  end(): void {
    wgpu().wgpuRenderPassEncoderEnd(this.handle);
    wgpu().wgpuRenderPassEncoderRelease(this.handle);
  }
}

export class GPUCommandEncoder extends GPUResource {
  beginComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder {
    const arena = new Arena();
    const handle = wgpu().wgpuCommandEncoderBeginComputePass(
      this.handle,
      packComputePassDescriptor(arena, descriptor),
    );
    return new GPUComputePassEncoder(handle, descriptor?.label);
  }

  beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
    const arena = new Arena();
    const handle = wgpu().wgpuCommandEncoderBeginRenderPass(
      this.handle,
      packRenderPassDescriptor(arena, descriptor),
    );
    return new GPURenderPassEncoder(handle, descriptor.label);
  }

  copyBufferToBuffer(
    source: IHandleOwner,
    sourceOffset: number,
    destination: IHandleOwner,
    destinationOffset: number,
    size: number,
  ): void {
    wgpu().wgpuCommandEncoderCopyBufferToBuffer(
      this.handle,
      source.handle,
      BigInt(sourceOffset),
      destination.handle,
      BigInt(destinationOffset),
      BigInt(size),
    );
  }

  copyBufferToTexture(
    source: GPUTexelCopyBufferInfo,
    destination: GPUTexelCopyTextureInfo,
    copySize: GPUExtent3D,
  ): void {
    const arena = new Arena();
    wgpu().wgpuCommandEncoderCopyBufferToTexture(
      this.handle,
      packTexelCopyBufferInfo(arena, source),
      packTexelCopyTextureInfo(arena, destination),
      packExtent3D(arena, copySize),
    );
  }

  copyTextureToBuffer(
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyBufferInfo,
    copySize: GPUExtent3D,
  ): void {
    const arena = new Arena();
    wgpu().wgpuCommandEncoderCopyTextureToBuffer(
      this.handle,
      packTexelCopyTextureInfo(arena, source),
      packTexelCopyBufferInfo(arena, destination),
      packExtent3D(arena, copySize),
    );
  }

  copyTextureToTexture(
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyTextureInfo,
    copySize: GPUExtent3D,
  ): void {
    const arena = new Arena();
    wgpu().wgpuCommandEncoderCopyTextureToTexture(
      this.handle,
      packTexelCopyTextureInfo(arena, source),
      packTexelCopyTextureInfo(arena, destination),
      packExtent3D(arena, copySize),
    );
  }

  clearBuffer(buffer: IHandleOwner, offset = 0, size?: number): void {
    wgpu().wgpuCommandEncoderClearBuffer(
      this.handle,
      buffer.handle,
      BigInt(offset),
      size === undefined ? 0xffffffffffffffffn : BigInt(size),
    );
  }

  resolveQuerySet(
    querySet: IHandleOwner,
    firstQuery: number,
    queryCount: number,
    destination: IHandleOwner,
    destinationOffset: number,
  ): void {
    wgpu().wgpuCommandEncoderResolveQuerySet(
      this.handle,
      querySet.handle,
      firstQuery,
      queryCount,
      destination.handle,
      BigInt(destinationOffset),
    );
  }

  finish(descriptor?: GPUCommandBufferDescriptor): GPUCommandBuffer {
    const arena = new Arena();
    const d = arena.struct("WGPUCommandBufferDescriptor");
    arena.writeString(d.sub("label"), descriptor?.label);
    const handle = wgpu().wgpuCommandEncoderFinish(this.handle, arena.hold(d));
    return new GPUCommandBuffer(handle, descriptor?.label);
  }

  /** No-op — see the module header. */
  pushDebugGroup(_groupLabel: string): void {}
  /** No-op — see the module header. */
  popDebugGroup(): void {}
  /** No-op — see the module header. */
  insertDebugMarker(_markerLabel: string): void {}

  protected override releaseNative(): void {
    wgpu().wgpuCommandEncoderRelease(this.handle);
  }
}
