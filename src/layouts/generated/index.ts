/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Derived from webgpu.structs.ts + wgpu.structs.ts by `bun run scripts/gen-layouts.ts`.
 *
 * Contains member names and C-ABI type tags only. Offsets and sizes are computed from this table at
 * import time (`src/layouts/cabi.ts`) and verified against a real C compiler in CI
 * (`test/layout-oracle.test.ts`), so this file is structurally incapable of carrying a wrong number.
 */

import { WEBGPU_AGGREGATES } from "./webgpu.structs.ts";
import { WGPU_NATIVE_AGGREGATES } from "./wgpu.structs.ts";
import { UNION_NAMES } from "./unions.ts";

export { WEBGPU_AGGREGATES } from "./webgpu.structs.ts";
export { WGPU_NATIVE_AGGREGATES } from "./wgpu.structs.ts";
export { UNION_NAMES } from "./unions.ts";
export * from "./provenance.ts";

/**
 * Every aggregate from both headers, keyed by its C name.
 *
 * `wgpu.h` only adds types; it never redefines one from `webgpu.h`, so the merge cannot lose an
 * entry. If upstream ever changes that, the duplicate-key check in `registry.ts` catches it.
 */
export const ALL_AGGREGATES = { ...WEBGPU_AGGREGATES, ...WGPU_NATIVE_AGGREGATES };

/** Every C aggregate name this package can lay out. */
export type AggregateName = keyof typeof ALL_AGGREGATES;

/** The member declarations of one aggregate. */
export type MembersOf<N extends AggregateName> = (typeof ALL_AGGREGATES)[N];

/** `true` when an aggregate is a C `union` (members all at offset 0) rather than a `struct`. */
export function isUnion(name: string): boolean {
  return (UNION_NAMES as readonly string[]).includes(name);
}
