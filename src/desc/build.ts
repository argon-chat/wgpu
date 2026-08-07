/**
 * Descriptor construction: header defaults, and lifetime for everything a descriptor points at.
 *
 * `src/layouts/` deliberately knows nothing about semantics — `allocStruct` hands back a zeroed
 * buffer, and zeroing is a *memory* operation, not "reset to defaults". This module is the layer
 * that supplies the meaning, and it has two jobs.
 *
 * ══ 1. "Absent" is not "zero" ══
 *
 * wgpu-native resolves an omitted field against the resource it belongs to — all remaining mip
 * levels, all remaining array layers, the rest of the buffer. Those sentinels are mostly
 * `UINT32_MAX` / `UINT64_MAX`, so a zeroed struct is not a neutral starting point: it is an
 * explicit request for *zero* mip levels and a *zero-sized* binding.
 *
 * The failure modes are not symmetric, and the dangerous one is quiet:
 *
 *   - `arrayLayerCount` wrong on a cube view → **rejected**, with a clear message.
 *   - `format` wrong on a depth-only aspect  → **rejected**, with a clear message.
 *   - `mipLevelCount` defaulted to 1 on a mipped view → **accepted, and wrong.** A prefiltered
 *     roughness chain silently collapses to mip 0. It validates. It renders. It is incorrect.
 *
 * So {@link initStruct} starts every descriptor from the pinned header's own `WGPU_*_INIT` values
 * and only then applies the caller's fields. {@link INIT_DEFAULTS} carries those values, resolved
 * mechanically from the macros in the vendored header; only the non-zero ones are listed, because
 * the buffer is already zero. Nothing else in this package may call `allocStruct` directly.
 *
 * Two deliberate exclusions, both of which would be bugs if included:
 *
 *   - **`WGPUStringView`.** Its `INIT` sets `length = WGPU_STRLEN` (`SIZE_MAX`), which pairs with a
 *     non-NULL `data` to mean "NUL-terminated, measure it". With the NULL `data` a fresh buffer has,
 *     it would ask wgpu-native to `strlen(NULL)`. `{NULL, 0}` — the zeroed state — is the
 *     representation of an absent label that actually works.
 *   - **Nested aggregates reached through `sub()`.** The header's own macros initialise most of
 *     those with `_wgpu_STRUCT_ZERO_INIT`, i.e. genuinely to zero. The load-bearing case is
 *     `WGPUBindGroupLayoutEntry`, whose four sub-layouts must all read `BindingNotUsed` (0) unless
 *     the entry really is of that kind — applying `WGPUBufferBindingLayout`'s own default there
 *     would set `type = Undefined`, giving an entry with two non-`BindingNotUsed` sub-layouts,
 *     which is the shape that **panics** wgpu-native's `conv.rs` rather than erroring.
 *
 * ══ 2. Lifetime ══
 *
 * A descriptor is mostly pointers: labels, entry arrays, nested descriptors. Something must hold
 * those alive from the moment `ptr()` is taken until the native call returns, and Bun never
 * promises that taking a pointer pins a buffer against GC.
 *
 * {@link Arena} is that something, and it is deliberately the dullest possible design: every
 * allocation is a fresh buffer, nothing is pooled, nothing is recycled, nothing is freed. A pool
 * keyed by object identity is exactly the design that lets a stale native write land in an
 * unrelated request's memory — a bug whose *loud* face is a double-free throw and whose quiet face
 * is a wrong answer somewhere else entirely.
 */

import { ptr as bunPtr } from "bun:ffi";

import type { Ptr } from "../ffi/pointer.ts";

import {
  CStructArray,
  CStructView,
  allocStruct,
  allocStructArray,
  layoutOf,
  type AggregateName,
} from "../layouts/index.ts";

/** `UINT32_MAX` — the shape of "the implementation decides" for every 32-bit sentinel here. */
export const U32_UNDEFINED = 0xffffffff;
/** `UINT64_MAX` — `WGPU_WHOLE_SIZE`, `WGPU_WHOLE_MAP_SIZE`, `WGPU_LIMIT_U64_UNDEFINED`. */
export const U64_UNDEFINED = 0xffffffffffffffffn;

/**
 * Non-zero field defaults, resolved from the pinned header's `WGPU_*_INIT` macros.
 *
 * Zero-valued defaults are omitted: the allocation already starts zeroed, and listing them would
 * invite someone to "tidy up" the list by deleting the ones that look redundant.
 */
const INIT_DEFAULTS: Readonly<Record<string, Readonly<Record<string, number | bigint>>>> = {
  // `type = WGPUBufferBindingType_Undefined`. Only applies when the layout is built standalone;
  // inside a WGPUBindGroupLayoutEntry the header zeroes it to BindingNotUsed instead — see above.
  WGPUBufferBindingLayout: { type: 1 },
  WGPUExtent3D: { height: 1, depthOrArrayLayers: 1 },
  WGPUMultisampleState: { count: 1, mask: U32_UNDEFINED },
  WGPUPassTimestampWrites: { beginningOfPassWriteIndex: U32_UNDEFINED, endOfPassWriteIndex: U32_UNDEFINED },
  WGPUSamplerDescriptor: { lodMinClamp: 0, lodMaxClamp: 32, maxAnisotropy: 1 },
  WGPUTexelCopyBufferLayout: { bytesPerRow: U32_UNDEFINED, rowsPerImage: U32_UNDEFINED },
  /** `WGPU_WHOLE_SIZE` — "from `offset` to the end of the buffer", never 0, which means "empty". */
  WGPUBindGroupEntry: { size: U64_UNDEFINED },
  /** `depthWriteEnabled = WGPUOptionalBool_Undefined`; stencil masks are all-ones. */
  WGPUDepthStencilState: { depthWriteEnabled: 2, stencilReadMask: U32_UNDEFINED, stencilWriteMask: U32_UNDEFINED },
  WGPURenderPassColorAttachment: { depthSlice: U32_UNDEFINED },
  WGPUTextureDescriptor: { mipLevelCount: 1, sampleCount: 1 },
  /** `WGPUColorWriteMask_All`. */
  WGPUColorTargetState: { writeMask: 15n },
  /** The two that render silently wrong when defaulted to 1 instead. */
  WGPUTextureViewDescriptor: { mipLevelCount: U32_UNDEFINED, arrayLayerCount: U32_UNDEFINED },
  /** `WGPU_DEPTH_CLEAR_VALUE_UNDEFINED` is `NAN`. */
  WGPURenderPassDepthStencilAttachment: { depthClearValue: Number.NaN },
  /** Every limit defaults to "unspecified", which is emphatically not "0". */
  WGPULimits: Object.fromEntries(
    layoutOf("WGPULimits").fields
      .filter((f) => f.tag === "u32" || f.tag === "u64")
      .map((f) => [f.name, f.tag === "u64" ? U64_UNDEFINED : U32_UNDEFINED]),
  ),
};

/** Apply one struct's `WGPU_*_INIT` values, dispatching on the member's declared C tag. */
function applyInitDefaults(view: CStructView<AggregateName>, name: string): void {
  const defaults = INIT_DEFAULTS[name];
  if (!defaults) return;
  for (const [member, value] of Object.entries(defaults)) {
    const field = view.layout.byName.get(member);
    if (!field) throw new Error(`wgpu-bun: ${name} has no member "${member}" to default.`);
    /* eslint-disable @typescript-eslint/no-explicit-any -- the member name is dynamic here by
       construction; the tag dispatch below is what keeps the width correct. */
    const v = view as any;
    switch (field.tag) {
      case "u8": v.setU8(member, Number(value)); break;
      case "u16": v.setU16(member, Number(value)); break;
      case "u32": v.setU32(member, Number(value)); break;
      case "i32": v.setI32(member, Number(value)); break;
      case "u64": v.setU64(member, value); break;
      case "usize": v.setUsize(member, value); break;
      case "flags64": v.setFlags(member, value); break;
      case "enum32": v.setEnum(member, Number(value)); break;
      case "f32": v.setF32(member, Number(value)); break;
      case "f64": v.setF64(member, Number(value)); break;
      default:
        throw new Error(`wgpu-bun: no default writer for ${name}.${member} (tag "${field.tag}").`);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}

/**
 * Allocate a descriptor initialised to the header's documented defaults.
 *
 * The replacement for `allocStruct` everywhere in this package. Using `allocStruct` directly gives
 * a struct that means "zero of everything", which for most WebGPU descriptors is a different
 * request than the one the caller made.
 */
export function initStruct<N extends AggregateName>(name: N): CStructView<N> {
  const view = allocStruct(name);
  applyInitDefaults(view as CStructView<AggregateName>, name);
  return view;
}

/** {@link initStruct} for a contiguous array — each element gets the same treatment. */
export function initStructArray<N extends AggregateName>(name: N, length: number): CStructArray<N> {
  const array = allocStructArray(name, length);
  for (let i = 0; i < length; i++) applyInitDefaults(array.at(i) as CStructView<AggregateName>, name);
  return array;
}

const UTF8 = new TextEncoder();

/**
 * Keeps every buffer a descriptor tree points at alive for the duration of an FFI call.
 *
 * One arena per native call. wgpu-native copies descriptors on entry, so the arena can be dropped
 * as soon as the synchronous call returns — but not one instruction sooner, which is why the arena
 * is a parameter rather than a global.
 */
export class Arena {
  readonly #alive: unknown[] = [];

  /** Take a pointer to a struct view (or array) and keep its backing buffer alive. */
  hold(item: { bytes: Uint8Array }): Ptr {
    this.#alive.push(item);
    return bunPtr(item.bytes);
  }

  /** Allocate a defaulted struct and keep it alive. Returns the view; take `ptr` with {@link hold}. */
  struct<N extends AggregateName>(name: N): CStructView<N> {
    const view = initStruct(name);
    this.#alive.push(view);
    return view;
  }

  /** Allocate a defaulted struct array and keep it alive. */
  structArray<N extends AggregateName>(name: N, length: number): CStructArray<N> {
    const array = initStructArray(name, length);
    this.#alive.push(array);
    return array;
  }

  /** Copy raw bytes into arena-owned memory. */
  bytes(source: ArrayBufferView | ArrayBuffer): Ptr {
    const src =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const copy = new Uint8Array(Math.max(src.byteLength, 1));
    copy.set(src);
    this.#alive.push(copy);
    return bunPtr(copy);
  }

  /** An array of pointers — `WGPUBindGroupLayout const *`, `WGPUCommandBuffer const *`, … */
  pointers(values: readonly number[]): Ptr {
    const buffer = new BigUint64Array(Math.max(values.length, 1));
    for (let i = 0; i < values.length; i++) buffer[i] = BigInt(values[i]!);
    this.#alive.push(buffer);
    return bunPtr(buffer);
  }

  /** An array of `uint32_t` — `WGPUFeatureName const *`, `viewFormats`, … */
  u32s(values: readonly number[]): Ptr {
    const buffer = new Uint32Array(Math.max(values.length, 1));
    buffer.set(values);
    this.#alive.push(buffer);
    return bunPtr(buffer);
  }

  /**
   * Write a `WGPUStringView` member from a JS string.
   *
   * `undefined` leaves it `{NULL, 0}`, which is how "no label" is spelled. An empty string is
   * written the same way: a zero-length view needs no storage, and a non-NULL pointer to nothing
   * is strictly worse than a NULL.
   */
  writeString(view: CStructView<"WGPUStringView">, value: string | undefined): void {
    if (!value) {
      view.setPtr("data", null).setUsize("length", 0);
      return;
    }
    const encoded = UTF8.encode(value);
    this.#alive.push(encoded);
    view.setPtr("data", bunPtr(encoded)).setUsize("length", encoded.byteLength);
  }
}
