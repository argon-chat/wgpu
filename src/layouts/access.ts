/**
 * Reading and writing C structs by member name.
 *
 * This is the surface the rest of the binding uses to build descriptors. Its contract is that a
 * caller never types an offset, a size or a stride — those come from the generated tables via
 * `registry.ts`, and the member names are checked by the compiler:
 *
 * ```ts
 * const d = allocStruct("WGPUBufferDescriptor");
 * d.sub("label").setPtr("data", labelPtr).setUsize("length", labelLen);
 * d.setFlags("usage", GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
 * d.setU64("size", 4096n);
 * d.setBool("mappedAtCreation", false);
 * wgpuDeviceCreateBuffer(device, ptr(d.bytes));
 * ```
 *
 * `d.setU32("usage", …)` is a compile error (it is a 64-bit flags member in v29), and so is
 * `d.setFlags("usag", …)`. Both would otherwise be the kind of mistake that produces a descriptor
 * wgpu-native reads at the wrong offsets.
 *
 * ── Two things this module deliberately does NOT do ─────────────────────────────────────────────
 *
 *  - **It does not allocate anything a pointer member points at.** No string encoding, no arrays of
 *    sub-descriptors kept alive behind the scenes. Lifetime is the caller's, because a layer that
 *    invisibly owns memory is a layer that can invisibly free it while the GPU still holds the
 *    address.
 *  - **It does not know a struct's semantic defaults.** A fresh buffer is all zeroes, which is *not*
 *    what the header's `WGPU_*_INIT` macros produce: `WGPU_STRING_VIEW_INIT` sets `length` to
 *    `WGPU_STRLEN`, and the limit structs init to `WGPU_LIMIT_*_UNDEFINED` rather than 0. Zeroing is
 *    a memory operation here, not a "reset to defaults" — deciding what "absent" means for a given
 *    field is the descriptor layer's job, and getting it wrong is how an omitted `mipLevelCount`
 *    turns into a silently wrong render.
 */

import type { ICAggregateLayout, ICField } from "./cabi.ts";
import type { AggregateOf, MemberNames, MembersOfTag } from "./decls.ts";
import type { AggregateName, MembersOf } from "./generated/index.ts";
import { layoutOf, sizeOf } from "./registry.ts";

/** The declaration tuple of `N`, in a form the type-level projections accept. */
type DeclOf<N extends AggregateName> = MembersOf<N> & readonly string[];

/** Members of `N` whose declared tag is exactly `T`. */
type Members<N extends AggregateName, T extends string> = MembersOfTag<DeclOf<N>, T>;

/** Members of `N` holding aggregate `A` by value. */
type SubMembers<N extends AggregateName> = MembersOfTag<DeclOf<N>, `@${string}`>;

/** Any 64-bit integer member accepts a `number` for readability at small magnitudes. */
export type U64Input = bigint | number;

function toBigInt(value: U64Input, where: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new Error(`${where}: expected an integer, got ${value}.`);
  }
  return BigInt(value);
}

/**
 * A typed view over one C aggregate inside an `ArrayBuffer`.
 *
 * Views are cheap and non-owning: {@link sub} returns another view over the *same* buffer, so a
 * nested `WGPUVertexState` is written in place rather than assembled separately and copied.
 */
export class CStructView<N extends AggregateName> {
  readonly layout: ICAggregateLayout;
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  private readonly dv: DataView;

  constructor(readonly name: N, buffer: ArrayBuffer, byteOffset = 0) {
    this.layout = layoutOf(name);
    if (byteOffset < 0 || byteOffset + this.layout.size > buffer.byteLength) {
      throw new Error(
        `${name} needs ${this.layout.size} bytes at offset ${byteOffset}, but the buffer is only ` +
          `${buffer.byteLength} bytes.`,
      );
    }
    this.buffer = buffer;
    this.byteOffset = byteOffset;
    this.dv = new DataView(buffer, byteOffset, this.layout.size);
  }

  /** The struct's bytes. Pass this to `bun:ffi`'s `ptr()`; it is a view, not a copy. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.buffer, this.byteOffset, this.layout.size);
  }

  /** `sizeof` this aggregate — also the stride of an array of them. */
  get size(): number {
    return this.layout.size;
  }

  /** Zero every byte. See the module note: this is *not* "reset to the header's defaults". */
  zero(): this {
    this.bytes.fill(0);
    return this;
  }

  /** The laid-out description of one member, for callers that need the raw numbers. */
  field(member: MemberNames<DeclOf<N>> & string): ICField {
    return this.require(member, null);
  }

  private require(member: string, tag: string | null): ICField {
    const f = this.layout.byName.get(member);
    if (!f) {
      throw new Error(
        `${this.name} has no member "${member}". It has: ` +
          `${this.layout.fields.map((x) => x.name).join(", ")}.`,
      );
    }
    if (tag !== null && f.tag !== tag) {
      throw new Error(
        `${this.name}.${member} is declared "${f.tag}", not "${tag}". Use the accessor for its ` +
          `real type — a mismatched width writes into the neighbouring member.`,
      );
    }
    return f;
  }

  /* ── 8/16/32-bit integers ─────────────────────────────────────────────────────────────────── */

  getU8(m: Members<N, "u8">): number {
    return this.dv.getUint8(this.require(m, "u8").offset);
  }
  setU8(m: Members<N, "u8">, v: number): this {
    this.dv.setUint8(this.require(m, "u8").offset, v);
    return this;
  }

  getU16(m: Members<N, "u16">): number {
    return this.dv.getUint16(this.require(m, "u16").offset, true);
  }
  setU16(m: Members<N, "u16">, v: number): this {
    this.dv.setUint16(this.require(m, "u16").offset, v, true);
    return this;
  }

  getU32(m: Members<N, "u32">): number {
    return this.dv.getUint32(this.require(m, "u32").offset, true);
  }
  setU32(m: Members<N, "u32">, v: number): this {
    this.dv.setUint32(this.require(m, "u32").offset, v, true);
    return this;
  }

  getI32(m: Members<N, "i32">): number {
    return this.dv.getInt32(this.require(m, "i32").offset, true);
  }
  setI32(m: Members<N, "i32">, v: number): this {
    this.dv.setInt32(this.require(m, "i32").offset, v, true);
    return this;
  }

  /* ── 64-bit integers ──────────────────────────────────────────────────────────────────────── */

  getU64(m: Members<N, "u64">): bigint {
    return this.dv.getBigUint64(this.require(m, "u64").offset, true);
  }
  setU64(m: Members<N, "u64">, v: U64Input): this {
    const f = this.require(m, "u64");
    this.dv.setBigUint64(f.offset, toBigInt(v, `${this.name}.${m}`), true);
    return this;
  }

  getI64(m: Members<N, "i64">): bigint {
    return this.dv.getBigInt64(this.require(m, "i64").offset, true);
  }
  setI64(m: Members<N, "i64">, v: U64Input): this {
    const f = this.require(m, "i64");
    this.dv.setBigInt64(f.offset, toBigInt(v, `${this.name}.${m}`), true);
    return this;
  }

  /**
   * `size_t` members — counts, lengths, byte sizes.
   *
   * Returns `bigint` because `WGPU_STRLEN` is `SIZE_MAX`, which does not survive a `number`. Use
   * {@link getCount} where the value is genuinely an array length.
   */
  getUsize(m: Members<N, "usize">): bigint {
    return this.dv.getBigUint64(this.require(m, "usize").offset, true);
  }
  setUsize(m: Members<N, "usize">, v: U64Input): this {
    const f = this.require(m, "usize");
    this.dv.setBigUint64(f.offset, toBigInt(v, `${this.name}.${m}`), true);
    return this;
  }

  /**
   * A `size_t` member as a JS number.
   *
   * @throws when the stored value exceeds `Number.MAX_SAFE_INTEGER` — which is what a `SIZE_MAX`
   * sentinel looks like, and is precisely the case that must not silently round to a plausible
   * length.
   */
  getCount(m: Members<N, "usize">): number {
    const raw = this.getUsize(m);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `${this.name}.${m} is ${raw}, which is not a safe JS integer. It is probably a sentinel ` +
          `(WGPU_STRLEN / SIZE_MAX) rather than a count — read it with getUsize().`,
      );
    }
    return Number(raw);
  }

  /** `WGPUFlags` members — `uint64_t` in v29, which is why they are not `setU32`. */
  getFlags(m: Members<N, "flags64">): bigint {
    return this.dv.getBigUint64(this.require(m, "flags64").offset, true);
  }
  setFlags(m: Members<N, "flags64">, v: U64Input): this {
    const f = this.require(m, "flags64");
    this.dv.setBigUint64(f.offset, toBigInt(v, `${this.name}.${m}`), true);
    return this;
  }

  /* ── Floats, booleans, enums, pointers ────────────────────────────────────────────────────── */

  getF32(m: Members<N, "f32">): number {
    return this.dv.getFloat32(this.require(m, "f32").offset, true);
  }
  setF32(m: Members<N, "f32">, v: number): this {
    this.dv.setFloat32(this.require(m, "f32").offset, v, true);
    return this;
  }

  getF64(m: Members<N, "f64">): number {
    return this.dv.getFloat64(this.require(m, "f64").offset, true);
  }
  setF64(m: Members<N, "f64">, v: number): this {
    this.dv.setFloat64(this.require(m, "f64").offset, v, true);
    return this;
  }

  /** `WGPUBool` — a `uint32_t` holding 0 or 1. */
  getBool(m: Members<N, "bool32">): boolean {
    return this.dv.getUint32(this.require(m, "bool32").offset, true) !== 0;
  }
  setBool(m: Members<N, "bool32">, v: boolean): this {
    this.dv.setUint32(this.require(m, "bool32").offset, v ? 1 : 0, true);
    return this;
  }

  /**
   * A C enum member, as its raw `int` value.
   *
   * Enum *meanings* live in the binding's enum tables, not here — this module knows only that the
   * member is 4 bytes wide and signed.
   */
  getEnum(m: Members<N, "enum32">): number {
    return this.dv.getInt32(this.require(m, "enum32").offset, true);
  }
  setEnum(m: Members<N, "enum32">, v: number): this {
    this.dv.setInt32(this.require(m, "enum32").offset, v, true);
    return this;
  }

  /**
   * A pointer member. `null` writes a null pointer.
   *
   * The value is whatever `bun:ffi`'s `ptr()` returned. Nothing here keeps the pointee alive; see
   * the module note.
   */
  getPtr(m: Members<N, "ptr">): number {
    return Number(this.dv.getBigUint64(this.require(m, "ptr").offset, true));
  }
  setPtr(m: Members<N, "ptr">, v: number | bigint | null): this {
    const f = this.require(m, "ptr");
    this.dv.setBigUint64(f.offset, v === null ? 0n : toBigInt(v, `${this.name}.${m}`), true);
    return this;
  }

  /**
   * A view over a nested aggregate held by value, sharing this buffer.
   *
   * ```ts
   * pipeline.sub("vertex").setPtr("module", shaderPtr);
   * ```
   */
  sub<M extends SubMembers<N> & string>(
    m: M,
  ): CStructView<AggregateOf<DeclOf<N>, M> & AggregateName> {
    const f = this.require(m, null);
    if (!f.aggregate) {
      throw new Error(`${this.name}.${m} is "${f.tag}", not an aggregate held by value.`);
    }
    return new CStructView(
      f.aggregate as AggregateOf<DeclOf<N>, M> & AggregateName,
      this.buffer,
      this.byteOffset + f.offset,
    );
  }
}

/**
 * A contiguous array of C structs — what every `entries` / `attributes` / `colorAttachments` member
 * of a WebGPU descriptor points at.
 *
 * The stride is `sizeof`, taken from the layout. Writing an array element-by-element into one
 * allocation is the only correct shape: C expects the elements adjacent, and building them
 * separately then concatenating is how a stride bug gets introduced.
 */
export class CStructArray<N extends AggregateName> {
  readonly buffer: ArrayBuffer;
  readonly stride: number;

  constructor(
    readonly name: N,
    readonly length: number,
  ) {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`${name}[]: length must be a non-negative integer, got ${length}.`);
    }
    this.stride = sizeOf(name);
    this.buffer = new ArrayBuffer(this.stride * length);
  }

  /** All elements' bytes. Pass to `ptr()`; a zero-length array yields an empty (non-null) buffer. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  /** A view over element `index`. */
  at(index: number): CStructView<N> {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`${this.name}[]: index ${index} is out of range for length ${this.length}.`);
    }
    return new CStructView(this.name, this.buffer, index * this.stride);
  }

  /** Every element, in order. */
  *[Symbol.iterator](): IterableIterator<CStructView<N>> {
    for (let i = 0; i < this.length; i++) yield this.at(i);
  }
}

/** Allocate a zeroed aggregate and return a view over it. */
export function allocStruct<N extends AggregateName>(name: N): CStructView<N> {
  return new CStructView(name, new ArrayBuffer(sizeOf(name)));
}

/** Allocate `length` contiguous aggregates. */
export function allocStructArray<N extends AggregateName>(
  name: N,
  length: number,
): CStructArray<N> {
  return new CStructArray(name, length);
}

/**
 * View an aggregate that already exists in memory — a struct wgpu-native filled in for us
 * (`WGPUAdapterInfo`, `WGPULimits`, `WGPUSurfaceCapabilities`).
 */
export function viewStruct<N extends AggregateName>(
  name: N,
  buffer: ArrayBuffer,
  byteOffset = 0,
): CStructView<N> {
  return new CStructView(name, buffer, byteOffset);
}
