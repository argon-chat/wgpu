/**
 * The C-ABI layout engine.
 *
 * `bun:ffi` passes every descriptor by pointer, so this package has to build real C structs inside
 * `ArrayBuffer`s. That means knowing, byte-exactly, where each member sits. This file is the *only*
 * place that decides — from a declarative field list plus the target's scalar sizes, never from a
 * number typed by a human.
 *
 * ── Why this is not the repo's GPU-struct helper ────────────────────────────────────────────────
 *
 * GPU buffer layout (WGSL/std430) and the C ABI are different rule sets that happen to look alike:
 *
 *   | | WGSL | C |
 *   |---|---|---|
 *   | `vec3<f32>` | 12 bytes, **align 16** | not a type |
 *   | pointer | not a type | 8 bytes, align 8 — and it is everywhere here |
 *   | 64-bit scalar | not a type | required (`WGPUFlags` is `uint64_t` in v29) |
 *   | max align | 16 | 8 |
 *
 * A layout engine whose alignment table says "align 16" cannot describe `WGPUStringView`
 * (`{ char const* data; size_t length; }`), and importing WGSL's alignment rules into a C boundary
 * is precisely how a pointer ends up written where an integer was expected. So the *discipline* is
 * shared — declarative fields in, derived offsets out, no literal offsets — and the implementation
 * deliberately is not.
 *
 * ── The rules implemented ───────────────────────────────────────────────────────────────────────
 *
 *   1. Each member starts at the next offset that is a multiple of its own alignment.
 *   2. A struct's alignment is the maximum of its members' alignments (1 when empty).
 *   3. A struct's size is the member extent rounded up to the struct's own alignment (tail padding),
 *      so that `sizeof` is a valid array stride.
 *   4. A union's members all start at offset 0; its alignment is the max member alignment and its
 *      size is the max member size rounded up to that alignment.
 *
 * These are the rules every ABI in scope agrees on. What the ABIs do *not* agree on is the size of
 * `size_t`/pointers, which is why that lives in {@link ICAbiModel} rather than in a constant.
 */

/** Fixed-width and target-dependent C scalar kinds, plus the two aggregate kinds. */
export type CScalarTag =
  | "i8"
  | "u8"
  | "i16"
  | "u16"
  | "i32"
  | "u32"
  | "i64"
  | "u64"
  | "f32"
  | "f64"
  /** `size_t` — target-dependent width. */
  | "usize"
  /** Any data or function pointer — target-dependent width. */
  | "ptr"
  /** `WGPUBool`, a `uint32_t` carrying 0/1. Distinct from `u32` so the accessor API can be typed. */
  | "bool32"
  /** A C enum with a `Force32 = 0x7FFFFFFF` member, i.e. `int`. */
  | "enum32"
  /** A `WGPUFlags` alias — `uint64_t` in v29, *not* `uint32_t` as in earlier generations. */
  | "flags64";

/** Size and alignment of one C type, in bytes. */
export interface ICType {
  readonly size: number;
  readonly align: number;
}

/**
 * Target-dependent parameters of the C ABI.
 *
 * Only the two genuinely target-dependent widths live here. Everything else in `webgpu.h` is either
 * a fixed-width `<stdint.h>` type, a `float`/`double`, or an aggregate of those — the header uses no
 * `long`, no `long double`, no bitfields and no arrays, which is what makes this model so small.
 * {@link assertNoWiderThanModel} enforces that assumption instead of trusting it.
 */
export interface ICAbiModel {
  /** Human-readable id, carried into error messages and into the oracle's report. */
  readonly id: string;
  /** `sizeof(void*)`, which is also its alignment on every ABI in scope. */
  readonly pointerSize: number;
  /** `sizeof(size_t)`. Equal to {@link pointerSize} on every ABI in scope, but not by definition. */
  readonly sizeTSize: number;
  /**
   * Alignment of an 8-byte scalar *inside a struct*.
   *
   * 8 on every 64-bit target. Called out explicitly because it is exactly what i386 System V gets
   * wrong (it aligns `uint64_t`/`double` members to 4), so a future 32-bit model cannot be produced
   * by only shrinking the pointer.
   */
  readonly int64Align: number;
}

/**
 * The one model this package ships layouts for: 64-bit, natural alignment.
 *
 * Every supported RID — `win32-x64`, `linux-x64`, `linux-arm64`, `darwin-arm64` —
 * lands here. Win64 (LLP64) and the Unix targets (LP64) differ only in `sizeof(long)`, and no member
 * of either header is a `long`, so the resulting layouts are **identical across all four**. See
 * {@link assertHost64Bit} for what happens on anything else.
 */
export const ABI_64: ICAbiModel = {
  id: "c-abi-64",
  pointerSize: 8,
  sizeTSize: 8,
  int64Align: 8,
};

/** `process.arch` values whose pointers are 8 bytes wide. */
const ARCH64 = new Set(["x64", "arm64", "ppc64", "s390x", "riscv64", "loong64", "mips64el"]);

/**
 * Refuse to run on a target this package has not derived layouts for.
 *
 * The failure this prevents is the quiet one: on a 32-bit host every `ptr`/`usize` member would be
 * 4 bytes, every offset after the first pointer would be wrong, and the binding would write valid
 * -looking garbage into wgpu-native's descriptors. There is no partial correctness to salvage, so
 * this throws rather than degrading.
 *
 * @param arch A `process.arch`-style string.
 * @throws when `arch` is not a known 64-bit architecture.
 */
export function assertHost64Bit(arch: string = process.arch): void {
  if (ARCH64.has(arch)) return;
  throw new Error(
    `wgpu-bun ships C-ABI layouts for 64-bit targets only, and this host reports arch "${arch}".\n` +
      `  Pointers and size_t are assumed to be ${ABI_64.pointerSize} bytes; on a 32-bit target every\n` +
      `  descriptor offset past the first pointer would be wrong, silently. Regenerate layouts with a\n` +
      `  32-bit ICAbiModel before running here.`,
  );
}

/**
 * Refuse to run where multi-byte scalars are stored the other way round.
 *
 * Every C struct built by this package is written through a `DataView` with `littleEndian: true`,
 * which is correct on all four supported RIDs and silently wrong anywhere else. This is one branch
 * at startup against a class of corruption that would otherwise present as "the GPU renders
 * garbage".
 *
 * @throws on a big-endian host.
 */
export function assertLittleEndian(): void {
  const probe = new Uint8Array(new Uint32Array([1]).buffer);
  if (probe[0] === 1) return;
  throw new Error(
    "wgpu-bun writes C structs little-endian, and this host is big-endian. No supported wgpu-native " +
      "target is big-endian, so this is an unsupported platform rather than a bug to work around.",
  );
}

/** Scalar sizes and alignments under a given model. Aggregates are resolved by {@link layoutStruct}. */
export function scalarType(tag: CScalarTag, model: ICAbiModel): ICType {
  switch (tag) {
    case "i8":
    case "u8":
      return { size: 1, align: 1 };
    case "i16":
    case "u16":
      return { size: 2, align: 2 };
    case "i32":
    case "u32":
    case "f32":
    case "bool32":
    case "enum32":
      return { size: 4, align: 4 };
    case "i64":
    case "u64":
    case "f64":
    case "flags64":
      return { size: 8, align: model.int64Align };
    case "usize":
      return { size: model.sizeTSize, align: model.sizeTSize };
    case "ptr":
      return { size: model.pointerSize, align: model.pointerSize };
  }
}

/** Round `value` up to the next multiple of `align`. */
export function alignTo(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

/** One laid-out member. */
export interface ICField {
  readonly name: string;
  /** The declared tag, or `@Name` for an aggregate member passed by value. */
  readonly tag: string;
  readonly offset: number;
  readonly size: number;
  readonly align: number;
  /** Name of the nested aggregate for an `@Name` member, else `null`. */
  readonly aggregate: string | null;
}

/** A fully laid-out aggregate. */
export interface ICAggregateLayout {
  readonly name: string;
  readonly kind: "struct" | "union";
  readonly size: number;
  readonly align: number;
  readonly fields: readonly ICField[];
  /** Field lookup by name; the same objects as {@link fields}. */
  readonly byName: ReadonlyMap<string, ICField>;
}

/** A member as handed to {@link layoutStruct}: a name plus an already-resolved type. */
export interface ICMemberInput {
  readonly name: string;
  readonly tag: string;
  readonly type: ICType;
  readonly aggregate: string | null;
}

function finish(
  name: string,
  kind: "struct" | "union",
  fields: ICField[],
  extent: number,
  align: number,
): ICAggregateLayout {
  const byName = new Map<string, ICField>();
  for (const f of fields) {
    if (byName.has(f.name)) {
      throw new Error(`${name}: duplicate member "${f.name}" — the header parse produced a collision.`);
    }
    byName.set(f.name, f);
  }
  return { name, kind, size: alignTo(extent, align), align, fields, byName };
}

/**
 * Lay out a C `struct`: members in declaration order, each at its own alignment, tail-padded.
 *
 * @param name Diagnostic name, used verbatim in error messages and in the oracle's report.
 * @param members Declaration-order members with resolved types.
 */
export function layoutStruct(name: string, members: readonly ICMemberInput[]): ICAggregateLayout {
  let offset = 0;
  let align = 1;
  const fields: ICField[] = [];
  for (const m of members) {
    offset = alignTo(offset, m.type.align);
    fields.push({
      name: m.name,
      tag: m.tag,
      offset,
      size: m.type.size,
      align: m.type.align,
      aggregate: m.aggregate,
    });
    offset += m.type.size;
    align = Math.max(align, m.type.align);
  }
  return finish(name, "struct", fields, offset, align);
}

/** Lay out a C `union`: every member at offset 0, sized to the widest. */
export function layoutUnion(name: string, members: readonly ICMemberInput[]): ICAggregateLayout {
  let extent = 0;
  let align = 1;
  const fields: ICField[] = [];
  for (const m of members) {
    fields.push({
      name: m.name,
      tag: m.tag,
      offset: 0,
      size: m.type.size,
      align: m.type.align,
      aggregate: m.aggregate,
    });
    extent = Math.max(extent, m.type.size);
    align = Math.max(align, m.type.align);
  }
  return finish(name, "union", fields, extent, align);
}

/**
 * Assert that nothing in a laid-out aggregate aligns more strictly than the model's widest scalar.
 *
 * A member with align > 8 would mean the header grew a type this model does not describe (a vector
 * extension, a `long double`, an over-aligned array). The layouts would still *compute*, and they
 * would be wrong. Checking is one comparison per member, so it is always on.
 *
 * @throws when any member's alignment exceeds the model's maximum scalar alignment.
 */
export function assertNoWiderThanModel(layout: ICAggregateLayout, model: ICAbiModel): void {
  const max = Math.max(model.pointerSize, model.sizeTSize, model.int64Align);
  for (const f of layout.fields) {
    if (f.align > max) {
      throw new Error(
        `${layout.name}.${f.name} (tag "${f.tag}") requires ${f.align}-byte alignment, but model ` +
          `"${model.id}" describes nothing stricter than ${max}. The header has outgrown this model.`,
      );
    }
  }
}
