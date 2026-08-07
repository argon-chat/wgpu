/**
 * Descriptor packing for buffers, textures, views, samplers and query sets.
 *
 * Every optional field here is written **only if the caller actually supplied it**. That is the
 * whole discipline of this file, and it is not stylistic:
 *
 *   - `mipLevelCount` materialised as 1 on a mipped view is **accepted and wrong** — a prefiltered
 *     roughness chain collapses to mip 0, validates, renders, and is silently incorrect.
 *   - `arrayLayerCount` materialised as 1 on a `cube` view is rejected outright
 *     (``Views of type `Cube` must have arrayLayerCount of 6``).
 *   - `format` materialised from the texture's format on a `depth-only` view is rejected
 *     (`format is not present in the texture's viewFormat array`) — an implicit request turned into
 *     an explicit one by helpfulness.
 *
 * `viewFormats` is never dropped, for the same reason in reverse: wgpu-native requires a view's
 * explicit format to appear in the texture's `viewFormats` **even when it equals the texture's own
 * format**, which is stricter than other implementations.
 */

import type { Arena } from "./build.ts";
import {
  ADDRESS_MODE,
  COMPARE_FUNCTION,
  FILTER_MODE,
  MIPMAP_FILTER_MODE,
  QUERY_TYPE,
  TEXTURE_ASPECT,
  TEXTURE_DIMENSION,
  TEXTURE_FORMAT,
  TEXTURE_VIEW_DIMENSION,
  toEnum,
} from "../enums.ts";
import type { Ptr } from "../ffi/pointer.ts";
import type { CStructView } from "../layouts/index.ts";

/** `GPUExtent3D` in either of its two spec spellings. */
export function writeExtent3D(view: CStructView<"WGPUExtent3D">, size: GPUExtent3D): void {
  if (Array.isArray(size) || ArrayBuffer.isView(size)) {
    const values = Array.from(size as Iterable<number>);
    view.setU32("width", values[0] ?? 1);
    view.setU32("height", values[1] ?? 1);
    view.setU32("depthOrArrayLayers", values[2] ?? 1);
    return;
  }
  const dict = size as GPUExtent3DDict;
  view.setU32("width", dict.width);
  view.setU32("height", dict.height ?? 1);
  view.setU32("depthOrArrayLayers", dict.depthOrArrayLayers ?? 1);
}

/** `GPUExtent3D` reduced to three numbers, applying the spec's own defaults for the absent axes. */
export function extentDims(size: GPUExtent3D): { width: number; height: number; depth: number } {
  if (Array.isArray(size) || ArrayBuffer.isView(size)) {
    const v = Array.from(size as Iterable<number>);
    return { width: v[0] ?? 1, height: v[1] ?? 1, depth: v[2] ?? 1 };
  }
  const d = size as GPUExtent3DDict;
  return { width: d.width, height: d.height ?? 1, depth: d.depthOrArrayLayers ?? 1 };
}

/** `GPUOrigin3D` in either of its two spec spellings. Absent means the origin, i.e. all zeroes. */
export function writeOrigin3D(view: CStructView<"WGPUOrigin3D">, origin: GPUOrigin3D | undefined): void {
  if (!origin) return;
  if (Array.isArray(origin) || ArrayBuffer.isView(origin)) {
    const values = Array.from(origin as Iterable<number>);
    view.setU32("x", values[0] ?? 0).setU32("y", values[1] ?? 0).setU32("z", values[2] ?? 0);
    return;
  }
  const dict = origin as GPUOrigin3DDict;
  view.setU32("x", dict.x ?? 0).setU32("y", dict.y ?? 0).setU32("z", dict.z ?? 0);
}

export function packBufferDescriptor(arena: Arena, descriptor: GPUBufferDescriptor): Ptr {
  const d = arena.struct("WGPUBufferDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setFlags("usage", BigInt(descriptor.usage));
  d.setU64("size", BigInt(descriptor.size));
  d.setBool("mappedAtCreation", descriptor.mappedAtCreation ?? false);
  return arena.hold(d);
}

export function packTextureDescriptor(arena: Arena, descriptor: GPUTextureDescriptor): Ptr {
  const d = arena.struct("WGPUTextureDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setFlags("usage", BigInt(descriptor.usage));
  d.setEnum("dimension", toEnum(TEXTURE_DIMENSION, descriptor.dimension ?? "2d", "GPUTextureDimension"));
  writeExtent3D(d.sub("size"), descriptor.size);
  d.setEnum("format", toEnum(TEXTURE_FORMAT, descriptor.format, "GPUTextureFormat"));
  if (descriptor.mipLevelCount !== undefined) d.setU32("mipLevelCount", descriptor.mipLevelCount);
  if (descriptor.sampleCount !== undefined) d.setU32("sampleCount", descriptor.sampleCount);

  const viewFormats = descriptor.viewFormats ? Array.from(descriptor.viewFormats) : [];
  if (viewFormats.length > 0) {
    d.setUsize("viewFormatCount", viewFormats.length);
    d.setPtr(
      "viewFormats",
      arena.u32s(viewFormats.map((f) => toEnum(TEXTURE_FORMAT, f, "GPUTextureFormat"))),
    );
  }
  return arena.hold(d);
}

/**
 * A `WGPUTextureViewDescriptor`, or NULL when the caller passed nothing.
 *
 * NULL is meaningfully different from a zeroed descriptor: it asks wgpu-native to derive everything
 * from the texture. A descriptor containing only a `label` is still "a descriptor" and runs the
 * full parse path, so an all-defaults descriptor is not a free no-op.
 */
export function packTextureViewDescriptor(
  arena: Arena,
  descriptor: GPUTextureViewDescriptor | undefined,
): Ptr | null {
  if (!descriptor) return null;
  const d = arena.struct("WGPUTextureViewDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  if (descriptor.format !== undefined) {
    d.setEnum("format", toEnum(TEXTURE_FORMAT, descriptor.format, "GPUTextureFormat"));
  }
  if (descriptor.dimension !== undefined) {
    d.setEnum("dimension", toEnum(TEXTURE_VIEW_DIMENSION, descriptor.dimension, "GPUTextureViewDimension"));
  }
  if (descriptor.aspect !== undefined) {
    d.setEnum("aspect", toEnum(TEXTURE_ASPECT, descriptor.aspect, "GPUTextureAspect"));
  }
  if (descriptor.baseMipLevel !== undefined) d.setU32("baseMipLevel", descriptor.baseMipLevel);
  if (descriptor.baseArrayLayer !== undefined) d.setU32("baseArrayLayer", descriptor.baseArrayLayer);
  // Left at WGPU_*_UNDEFINED unless asked for. See the module header for what happens otherwise.
  if (descriptor.mipLevelCount !== undefined) d.setU32("mipLevelCount", descriptor.mipLevelCount);
  if (descriptor.arrayLayerCount !== undefined) d.setU32("arrayLayerCount", descriptor.arrayLayerCount);
  if (descriptor.usage !== undefined) d.setFlags("usage", BigInt(descriptor.usage));
  return arena.hold(d);
}

/**
 * A `WGPUSamplerDescriptor`.
 *
 * `compare` is what makes a sampler a *comparison* sampler. Dropping it during marshalling yields
 * an ordinary sampler and invalidates every shadow bind group built against it — a failure both
 * implementations agree is invalid, which only the marshalling can cause.
 */
export function packSamplerDescriptor(
  arena: Arena,
  descriptor: GPUSamplerDescriptor | undefined,
): Ptr {
  const d = arena.struct("WGPUSamplerDescriptor");
  if (!descriptor) return arena.hold(d);
  arena.writeString(d.sub("label"), descriptor.label);
  const address = (v: GPUAddressMode | undefined): number =>
    v === undefined ? 0 : toEnum(ADDRESS_MODE, v, "GPUAddressMode");
  d.setEnum("addressModeU", address(descriptor.addressModeU));
  d.setEnum("addressModeV", address(descriptor.addressModeV));
  d.setEnum("addressModeW", address(descriptor.addressModeW));
  if (descriptor.magFilter) d.setEnum("magFilter", toEnum(FILTER_MODE, descriptor.magFilter, "GPUFilterMode"));
  if (descriptor.minFilter) d.setEnum("minFilter", toEnum(FILTER_MODE, descriptor.minFilter, "GPUFilterMode"));
  if (descriptor.mipmapFilter) {
    d.setEnum("mipmapFilter", toEnum(MIPMAP_FILTER_MODE, descriptor.mipmapFilter, "GPUMipmapFilterMode"));
  }
  if (descriptor.lodMinClamp !== undefined) d.setF32("lodMinClamp", descriptor.lodMinClamp);
  if (descriptor.lodMaxClamp !== undefined) d.setF32("lodMaxClamp", descriptor.lodMaxClamp);
  if (descriptor.compare) d.setEnum("compare", toEnum(COMPARE_FUNCTION, descriptor.compare, "GPUCompareFunction"));
  if (descriptor.maxAnisotropy !== undefined) d.setU16("maxAnisotropy", descriptor.maxAnisotropy);
  return arena.hold(d);
}

export function packQuerySetDescriptor(arena: Arena, descriptor: GPUQuerySetDescriptor): Ptr {
  const d = arena.struct("WGPUQuerySetDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setEnum("type", toEnum(QUERY_TYPE, descriptor.type, "GPUQueryType"));
  d.setU32("count", descriptor.count);
  return arena.hold(d);
}

/** A `WGPUShaderModuleDescriptor` with a chained `WGPUShaderSourceWGSL`. */
export function packShaderModuleDescriptor(
  arena: Arena,
  descriptor: GPUShaderModuleDescriptor,
): Ptr {
  const source = arena.struct("WGPUShaderSourceWGSL");
  source.sub("chain").setPtr("next", null).setEnum("sType", 2 /* WGPUSType_ShaderSourceWGSL */);
  arena.writeString(source.sub("code"), descriptor.code);
  const sourcePtr = arena.hold(source);

  const d = arena.struct("WGPUShaderModuleDescriptor");
  d.setPtr("nextInChain", sourcePtr);
  arena.writeString(d.sub("label"), descriptor.label);
  return arena.hold(d);
}
