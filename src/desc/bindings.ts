/**
 * Descriptor packing for the binding model — and the pre-validation that keeps it out of `conv.rs`.
 *
 * ══ Why a bind-group-layout entry is validated in JavaScript before it is packed ══
 *
 * wgpu-native decides what *kind* an entry is by looking at which of its four sub-layouts
 * (`buffer`, `sampler`, `texture`, `storageTexture`) is non-zero. An entry where all four read
 * `BindingNotUsed` is unclassifiable, and it does not produce a validation error — it **panics**
 * inside `conv.rs`, which crosses a `nounwind` boundary and aborts the process. The literal string
 * `invalid bind group layout entry for bind group layout descriptor` is compiled into the shipped
 * DLL; this is not folklore.
 *
 * There are three ways to arrive there, and all three are a fresh binding's natural first draft:
 *
 *   1. the descriptor genuinely omits the kind (author error);
 *   2. a **hole in the entries array** — a `null`, an `undefined`, or a sparse JS array — that gets
 *      written through as a zeroed struct. A naive per-entry loop never notices;
 *   3. a binding kind or texture format the marshaller does not map, left zeroed rather than
 *      thrown on. The historically expensive instance of this: unmapped `storageTexture` entries
 *      meant every compute kernel that writes an image aborted at layout creation.
 *
 * So: exactly one sub-layout must be classifiable, holes are rejected outright, and an unmapped
 * enum throws from {@link toEnum} rather than falling back to zero. All three become ordinary JS
 * errors with a stack pointing at the caller.
 *
 * ══ Buffer binding `size` ══
 *
 * An omitted `size` means `buffer.size - offset`, and the header spells that `WGPU_WHOLE_SIZE`
 * (`UINT64_MAX`), which is what the descriptor is initialised to. Two things must not happen:
 * substituting the *whole* buffer size (which overruns by exactly `offset`), and computing the
 * subtraction ourselves without a range check — the arithmetic is unsigned, so an out-of-range
 * offset wraps and hands wgpu a size near 1.8e19.
 */

import type { Arena } from "./build.ts";
import {
  BUFFER_BINDING_TYPE,
  SAMPLER_BINDING_TYPE,
  STORAGE_TEXTURE_ACCESS,
  TEXTURE_FORMAT,
  TEXTURE_SAMPLE_TYPE,
  TEXTURE_VIEW_DIMENSION,
  toEnum,
} from "../enums.ts";
import type { Ptr } from "../ffi/pointer.ts";

/** Anything holding a native handle. */
export interface IHandleOwner {
  readonly handle: Ptr;
}

function requireEntries<T>(entries: Iterable<T> | undefined, what: string): T[] {
  const list = entries === undefined ? [] : Array.from(entries);
  for (let i = 0; i < list.length; i++) {
    if (list[i] === null || list[i] === undefined) {
      throw new Error(
        `wgpu-bun: ${what}[${i}] is ${String(list[i])}. There is no valid empty entry — a hole here ` +
          `becomes a zeroed C struct, which aborts the process inside wgpu-native rather than ` +
          `producing a validation error.`,
      );
    }
  }
  return list;
}

export function packBindGroupLayoutDescriptor(
  arena: Arena,
  descriptor: GPUBindGroupLayoutDescriptor,
): Ptr {
  const entries = requireEntries(descriptor.entries, "bindGroupLayout.entries");
  const array = arena.structArray("WGPUBindGroupLayoutEntry", entries.length);

  entries.forEach((entry, index) => {
    const e = array.at(index);
    e.setU32("binding", entry.binding);
    e.setFlags("visibility", BigInt(entry.visibility));

    const kinds = [
      entry.buffer !== undefined,
      entry.sampler !== undefined,
      entry.texture !== undefined,
      entry.storageTexture !== undefined,
    ].filter(Boolean).length;

    if (kinds !== 1) {
      throw new Error(
        `wgpu-bun: bindGroupLayout.entries[${index}] (binding ${entry.binding}) declares ${kinds} ` +
          `binding kinds; exactly one of buffer/sampler/texture/storageTexture is required. ` +
          `wgpu-native panics rather than erroring on an unclassifiable entry.` +
          (entry.externalTexture ? ` (externalTexture is not supported by this binding.)` : ""),
      );
    }

    if (entry.buffer) {
      const b = e.sub("buffer");
      b.setEnum("type", toEnum(BUFFER_BINDING_TYPE, entry.buffer.type ?? "uniform", "GPUBufferBindingType"));
      b.setBool("hasDynamicOffset", entry.buffer.hasDynamicOffset ?? false);
      b.setU64("minBindingSize", BigInt(entry.buffer.minBindingSize ?? 0));
    } else if (entry.sampler) {
      e.sub("sampler").setEnum(
        "type",
        toEnum(SAMPLER_BINDING_TYPE, entry.sampler.type ?? "filtering", "GPUSamplerBindingType"),
      );
    } else if (entry.texture) {
      const t = e.sub("texture");
      t.setEnum("sampleType", toEnum(TEXTURE_SAMPLE_TYPE, entry.texture.sampleType ?? "float", "GPUTextureSampleType"));
      t.setEnum(
        "viewDimension",
        toEnum(TEXTURE_VIEW_DIMENSION, entry.texture.viewDimension ?? "2d", "GPUTextureViewDimension"),
      );
      t.setBool("multisampled", entry.texture.multisampled ?? false);
    } else if (entry.storageTexture) {
      const s = e.sub("storageTexture");
      s.setEnum(
        "access",
        toEnum(STORAGE_TEXTURE_ACCESS, entry.storageTexture.access ?? "write-only", "GPUStorageTextureAccess"),
      );
      s.setEnum("format", toEnum(TEXTURE_FORMAT, entry.storageTexture.format, "GPUTextureFormat"));
      s.setEnum(
        "viewDimension",
        toEnum(TEXTURE_VIEW_DIMENSION, entry.storageTexture.viewDimension ?? "2d", "GPUTextureViewDimension"),
      );
    }
  });

  const entriesPtr = arena.hold(array);
  const d = arena.struct("WGPUBindGroupLayoutDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setUsize("entryCount", entries.length);
  d.setPtr("entries", entries.length > 0 ? entriesPtr : null);
  return arena.hold(d);
}

export function packBindGroupDescriptor(
  arena: Arena,
  descriptor: GPUBindGroupDescriptor,
  layoutHandle: Ptr,
): Ptr {
  const entries = requireEntries(descriptor.entries, "bindGroup.entries");
  const array = arena.structArray("WGPUBindGroupEntry", entries.length);

  entries.forEach((entry, index) => {
    const e = array.at(index);
    e.setU32("binding", entry.binding);
    const resource = entry.resource as unknown;

    if (resource !== null && typeof resource === "object" && "buffer" in resource) {
      const binding = resource as GPUBufferBinding;
      const buffer = binding.buffer as unknown as IHandleOwner & { size: number };
      const offset = Number(binding.offset ?? 0);
      if (offset > buffer.size) {
        throw new Error(
          `wgpu-bun: bindGroup.entries[${index}] offset ${offset} exceeds the buffer's size ` +
            `${buffer.size}. The implied size is computed with unsigned arithmetic — letting this ` +
            `through would hand wgpu a binding size near 1.8e19.`,
        );
      }
      e.setPtr("buffer", buffer.handle);
      e.setU64("offset", BigInt(offset));
      // `size` stays at WGPU_WHOLE_SIZE unless given: "to the end of the buffer", not "0".
      if (binding.size !== undefined) e.setU64("size", BigInt(binding.size));
    } else if (resource !== null && typeof resource === "object" && "handle" in resource) {
      const owner = resource as IHandleOwner & { readonly kind?: string };
      if (owner.kind === "sampler") e.setPtr("sampler", owner.handle);
      else e.setPtr("textureView", owner.handle);
    } else {
      throw new Error(
        `wgpu-bun: bindGroup.entries[${index}] resource is not a GPUBuffer binding, GPUSampler or ` +
          `GPUTextureView. External textures are not supported by this binding.`,
      );
    }
  });

  const entriesPtr = arena.hold(array);
  const d = arena.struct("WGPUBindGroupDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setPtr("layout", layoutHandle);
  d.setUsize("entryCount", entries.length);
  d.setPtr("entries", entries.length > 0 ? entriesPtr : null);
  return arena.hold(d);
}

export function packPipelineLayoutDescriptor(
  arena: Arena,
  descriptor: GPUPipelineLayoutDescriptor,
): Ptr {
  const layouts = requireEntries(descriptor.bindGroupLayouts, "pipelineLayout.bindGroupLayouts");
  const handles = layouts.map((l) => (l as unknown as IHandleOwner).handle);
  const d = arena.struct("WGPUPipelineLayoutDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setUsize("bindGroupLayoutCount", handles.length);
  d.setPtr("bindGroupLayouts", handles.length > 0 ? arena.pointers(handles) : null);
  return arena.hold(d);
}
