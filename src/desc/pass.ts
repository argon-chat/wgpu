/**
 * Descriptor packing for passes and for texel copies.
 *
 * ── `bytesPerRow` / `rowsPerImage` are "absent or exact", never "pass it if you have it" ────────
 *
 * `rowsPerImage` is **required** when a copy's depth exceeds 1 and is **poison** for a
 * single-image 2D copy — supplying block-rows there trips wgpu-native's texel-height check. Both
 * stay at `WGPU_COPY_STRIDE_UNDEFINED` unless the caller named them, which is the same rule as
 * every other optional field and for the same reason.
 *
 * Block-compressed copies carry a second, quieter constraint that belongs to the caller rather
 * than to this layer: copy extents are counted in texels but must be **block-aligned**, and the
 * tail of a compressed mip chain (4×4, 2×2, 1×1) still stores a whole block. wgpu-native rejects a
 * 2-texel-wide copy into a 4×4-block format, and the visible symptom is that the texture silently
 * never loads. This module cannot fix that without knowing the format's block size, so it does not
 * pretend to — it passes the caller's extents through unchanged rather than rounding them.
 *
 * ── `depthClearValue` ───────────────────────────────────────────────────────────────────────────
 *
 * Initialised to `NAN` (`WGPU_DEPTH_CLEAR_VALUE_UNDEFINED`), because 0.0 is a perfectly valid
 * clear value and therefore cannot double as "unspecified".
 */

import type { Arena } from "./build.ts";
import { LOAD_OP, STORE_OP, TEXTURE_ASPECT, toEnum } from "../enums.ts";
import type { Ptr } from "../ffi/pointer.ts";
import type { CStructView } from "../layouts/index.ts";
import type { IHandleOwner } from "./bindings.ts";
import { extentDims, writeExtent3D, writeOrigin3D } from "./resources.ts";

function writeColor(view: CStructView<"WGPUColor">, color: GPUColor | undefined): void {
  if (!color) return;
  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    const v = Array.from(color as Iterable<number>);
    view.setF64("r", v[0] ?? 0).setF64("g", v[1] ?? 0).setF64("b", v[2] ?? 0).setF64("a", v[3] ?? 0);
    return;
  }
  const dict = color as GPUColorDict;
  view.setF64("r", dict.r).setF64("g", dict.g).setF64("b", dict.b).setF64("a", dict.a);
}

function packTimestampWrites(
  arena: Arena,
  writes: GPURenderPassTimestampWrites | GPUComputePassTimestampWrites | undefined,
): Ptr | null {
  if (!writes) return null;
  const w = arena.struct("WGPUPassTimestampWrites");
  w.setPtr("querySet", (writes.querySet as unknown as IHandleOwner).handle);
  if (writes.beginningOfPassWriteIndex !== undefined) {
    w.setU32("beginningOfPassWriteIndex", writes.beginningOfPassWriteIndex);
  }
  if (writes.endOfPassWriteIndex !== undefined) {
    w.setU32("endOfPassWriteIndex", writes.endOfPassWriteIndex);
  }
  return arena.hold(w);
}

export function packComputePassDescriptor(
  arena: Arena,
  descriptor: GPUComputePassDescriptor | undefined,
): Ptr {
  const d = arena.struct("WGPUComputePassDescriptor");
  arena.writeString(d.sub("label"), descriptor?.label);
  d.setPtr("timestampWrites", packTimestampWrites(arena, descriptor?.timestampWrites));
  return arena.hold(d);
}

export function packRenderPassDescriptor(
  arena: Arena,
  descriptor: GPURenderPassDescriptor,
): Ptr {
  const attachments = Array.from(descriptor.colorAttachments);
  const array = arena.structArray("WGPURenderPassColorAttachment", attachments.length);

  attachments.forEach((attachment, index) => {
    const a = array.at(index);
    // A null colour attachment is legal and means "nothing bound at this location"; the zeroed
    // element already says that, so leaving it alone is correct.
    if (!attachment) return;
    a.setPtr("view", (attachment.view as unknown as IHandleOwner).handle);
    if (attachment.resolveTarget) {
      a.setPtr("resolveTarget", (attachment.resolveTarget as unknown as IHandleOwner).handle);
    }
    if (attachment.depthSlice !== undefined) a.setU32("depthSlice", attachment.depthSlice);
    a.setEnum("loadOp", toEnum(LOAD_OP, attachment.loadOp, "GPULoadOp"));
    a.setEnum("storeOp", toEnum(STORE_OP, attachment.storeOp, "GPUStoreOp"));
    writeColor(a.sub("clearValue"), attachment.clearValue);
  });

  const d = arena.struct("WGPURenderPassDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setUsize("colorAttachmentCount", attachments.length);
  d.setPtr("colorAttachments", attachments.length > 0 ? arena.hold(array) : null);

  if (descriptor.depthStencilAttachment) {
    const ds = descriptor.depthStencilAttachment;
    const s = arena.struct("WGPURenderPassDepthStencilAttachment");
    s.setPtr("view", (ds.view as unknown as IHandleOwner).handle);
    if (ds.depthLoadOp) s.setEnum("depthLoadOp", toEnum(LOAD_OP, ds.depthLoadOp, "GPULoadOp"));
    if (ds.depthStoreOp) s.setEnum("depthStoreOp", toEnum(STORE_OP, ds.depthStoreOp, "GPUStoreOp"));
    if (ds.depthClearValue !== undefined) s.setF32("depthClearValue", ds.depthClearValue);
    s.setBool("depthReadOnly", ds.depthReadOnly ?? false);
    if (ds.stencilLoadOp) s.setEnum("stencilLoadOp", toEnum(LOAD_OP, ds.stencilLoadOp, "GPULoadOp"));
    if (ds.stencilStoreOp) s.setEnum("stencilStoreOp", toEnum(STORE_OP, ds.stencilStoreOp, "GPUStoreOp"));
    if (ds.stencilClearValue !== undefined) s.setU32("stencilClearValue", ds.stencilClearValue);
    s.setBool("stencilReadOnly", ds.stencilReadOnly ?? false);
    d.setPtr("depthStencilAttachment", arena.hold(s));
  }

  if (descriptor.occlusionQuerySet) {
    d.setPtr("occlusionQuerySet", (descriptor.occlusionQuerySet as unknown as IHandleOwner).handle);
  }
  d.setPtr("timestampWrites", packTimestampWrites(arena, descriptor.timestampWrites));
  return arena.hold(d);
}

/**
 * `WGPUTexelCopyBufferInfo` — the buffer half of a texture copy.
 *
 * ⚠ **`rowsPerImage` is materialised here, and this is the one deliberate exception to "absent
 * stays absent".** An omitted `rowsPerImage` reaching `wgpuCommandEncoderCopyTextureToBuffer` or
 * `…CopyBufferToTexture` does not produce a validation error — it **panics** in `conv.rs`
 * (`invalid rowsPerImage`) and aborts the process. Measured, not inferred: the same copy survives
 * when the field is supplied and dies when it is not.
 *
 * This is safe to fill in precisely because the value is not invented. The WebGPU spec defines the
 * default as `copySize.height` whenever the copy covers a single layer, so writing it changes
 * nothing about what is requested — unlike `mipLevelCount`, where a materialised default is a
 * *different* request that validates and renders wrong.
 *
 * `wgpuQueueWriteTexture` is **not** given the same treatment: it accepts an absent `rowsPerImage`
 * happily, and supplying one on a single-image 2D copy is known to trip its texel-height check.
 * Two entry points, two behaviours, one field.
 */
export function packTexelCopyBufferInfo(
  arena: Arena,
  info: GPUTexelCopyBufferInfo,
  copySize?: GPUExtent3D,
): Ptr {
  const d = arena.struct("WGPUTexelCopyBufferInfo");
  d.setPtr("buffer", (info.buffer as unknown as IHandleOwner).handle);
  const layout = d.sub("layout");
  writeTexelCopyBufferLayout(layout, info);
  if (info.rowsPerImage === undefined && copySize !== undefined) {
    layout.setU32("rowsPerImage", extentDims(copySize).height);
  }
  return arena.hold(d);
}

/** The `offset` / `bytesPerRow` / `rowsPerImage` triple, shared by copies and `writeTexture`. */
export function writeTexelCopyBufferLayout(
  view: CStructView<"WGPUTexelCopyBufferLayout">,
  layout: GPUTexelCopyBufferLayout,
): void {
  view.setU64("offset", BigInt(layout.offset ?? 0));
  if (layout.bytesPerRow !== undefined) view.setU32("bytesPerRow", layout.bytesPerRow);
  if (layout.rowsPerImage !== undefined) view.setU32("rowsPerImage", layout.rowsPerImage);
}

/** `WGPUTexelCopyTextureInfo` — the texture half of a copy. */
export function packTexelCopyTextureInfo(arena: Arena, info: GPUTexelCopyTextureInfo): Ptr {
  const d = arena.struct("WGPUTexelCopyTextureInfo");
  d.setPtr("texture", (info.texture as unknown as IHandleOwner).handle);
  d.setU32("mipLevel", info.mipLevel ?? 0);
  writeOrigin3D(d.sub("origin"), info.origin);
  d.setEnum("aspect", toEnum(TEXTURE_ASPECT, info.aspect ?? "all", "GPUTextureAspect"));
  return arena.hold(d);
}

/** A standalone `WGPUExtent3D`, for the copy-size argument of `writeTexture` / `copy*`. */
export function packExtent3D(arena: Arena, size: GPUExtent3D): Ptr {
  const d = arena.struct("WGPUExtent3D");
  writeExtent3D(d, size);
  return arena.hold(d);
}
