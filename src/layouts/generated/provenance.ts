/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Derived from the vendored wgpu-native headers by `bun run scripts/gen-layouts.ts`.
 *
 * Contains member names and C-ABI type tags only. Offsets and sizes are computed from this table at
 * import time (`src/layouts/cabi.ts`) and verified against a real C compiler in CI
 * (`test/layout-oracle.test.ts`), so this file is structurally incapable of carrying a wrong number.
 */

// No RID is recorded here, deliberately.
//
// An earlier revision exported the vendored RID whose headers were read, on the reasoning that it
// kept "any RID's headers will do" checkable. It did the opposite. Nothing consumed the value, while
// its presence made this file's contents depend on WHICH machine generated it — so every leg of a CI
// matrix found the committed file stale and demanded a regeneration that would then be stale
// everywhere else. A generated file that varies by host cannot be compared byte-for-byte, and
// comparing it byte-for-byte is the entire job of the staleness check.
//
// What actually makes the RID-invariance claim checkable is below: the digests are taken over
// LF-normalised header text, so they agree across every platform's release archive, and the oracle
// test compares derived offsets against a real C compiler on whatever host it runs on.

/**
 * sha256 of each header this table was derived from.
 *
 * The oracle test hashes the headers it compiles and compares them to this. A mismatch means the
 * pinned binary moved without the table being regenerated — which is exactly the silent-offset-shift
 * scenario the whole derivation exists to prevent, so it fails the test rather than being tolerated.
 */
export const HEADER_DIGESTS: readonly { readonly file: string; readonly sha256: string }[] = [
  { file: "webgpu.h", sha256: "a483031c3fed05ea5dd1c74082a71676c46c5b2b820ccca10da515c033efc997" },
  { file: "wgpu.h", sha256: "7bd23656d394f620a804b1f174444ea17082b6d330a2fca0c0e6b1121ec4b284" },
];

/** Aggregate counts, per header. A bump that adds or removes structs shows up here in review. */
export const AGGREGATE_COUNTS = {
  "webgpu.h": 92,
  "wgpu.h": 23
} as const;
