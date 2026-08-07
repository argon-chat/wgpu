/**
 * C-ABI struct layouts for wgpu-native's `webgpu.h` + `wgpu.h`.
 *
 * `bun:ffi` passes every descriptor by pointer, so descriptors have to be built as real C structs in
 * `ArrayBuffer`s. This subtree owns that, end to end:
 *
 *   `scripts/gen-layouts.ts`  reads the vendored headers      → `generated/*.ts` (member tags only)
 *   `cabi.ts`                 applies the C alignment rules   → offsets, sizes, alignments
 *   `registry.ts`             resolves + memoises aggregates  → `layoutOf`, `sizeOf`, `fieldOf`
 *   `access.ts`               typed reads and writes          → `allocStruct`, `CStructView`
 *   `test/layout-oracle.test.ts`  compiles the same headers with a real C compiler and checks every
 *                                 derived `sizeof`/`offsetof` against it.
 *
 * Nothing on this path types a number: the generated tables carry only member names and type tags,
 * and the offsets are derived. The oracle is what makes that derivation trustworthy rather than
 * merely tidy — it is CI-only, and no runtime code in this package imports a C compiler.
 *
 * ── Platform axis ───────────────────────────────────────────────────────────────────────────────
 *
 * **Invariant across all five supported RIDs** (`win32-x64`, `linux-x64`, `linux-arm64`,
 * `darwin-x64`, `darwin-arm64`): every offset and size here. Both headers use only fixed-width
 * `<stdint.h>` scalars, `float`/`double`, C enums, pointers, `size_t`, and aggregates of those. No
 * `long`, no `long double`, no bitfields, no arrays — so LLP64 (Windows) and LP64 (Unix) cannot
 * diverge, and x86-64 and AArch64 agree on natural alignment for everything present.
 *
 * **Not invariant**: 32-bit targets, where `ptr`/`usize` would be 4 bytes and where i386 System V
 * additionally aligns 8-byte scalars to 4 inside structs. That is refused loudly at first import
 * (`assertHost64Bit`), never approximated. Big-endian is refused the same way.
 *
 * Verified against a C compiler on `win32-x64`. On the other four RIDs the invariance argument above
 * is reasoning from the ABI documents plus the absence of the divergent constructs in the headers —
 * the oracle test is written to run anywhere, but at the time of writing it has only been executed
 * on Windows x64.
 */

export {
  ABI_64,
  alignTo,
  assertHost64Bit,
  assertLittleEndian,
  assertNoWiderThanModel,
  layoutStruct,
  layoutUnion,
  scalarType,
  type CScalarTag,
  type ICAbiModel,
  type ICAggregateLayout,
  type ICField,
  type ICMemberInput,
  type ICType,
} from "./cabi.ts";

export {
  isAggregateTag,
  splitMemberDecl,
  type AggregateOf,
  type CAggregateDecls,
  type CMemberDecl,
  type CMemberTag,
  type MemberNames,
  type MemberNameOf,
  type MemberTagOf,
  type MembersOfTag,
} from "./decls.ts";

export {
  ALL_AGGREGATES,
  AGGREGATE_COUNTS,
  HEADER_DIGESTS,
  SOURCE_RID,
  UNION_NAMES,
  WEBGPU_AGGREGATES,
  WGPU_NATIVE_AGGREGATES,
  isUnion,
  type AggregateName,
  type MembersOf,
} from "./generated/index.ts";

export { LayoutRegistry, alignOf, fieldOf, layoutOf, registry, sizeOf } from "./registry.ts";

export {
  CStructArray,
  CStructView,
  allocStruct,
  allocStructArray,
  viewStruct,
  type U64Input,
} from "./access.ts";
