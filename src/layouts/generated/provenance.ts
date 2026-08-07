/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Derived from the vendored wgpu-native headers by `bun run scripts/gen-layouts.ts`.
 *
 * Contains member names and C-ABI type tags only. Offsets and sizes are computed from this table at
 * import time (`src/layouts/cabi.ts`) and verified against a real C compiler in CI
 * (`test/layout-oracle.test.ts`), so this file is structurally incapable of carrying a wrong number.
 */

/** The vendored RID whose headers were read. Layouts are identical across every 64-bit RID. */
export const SOURCE_RID = "win32-x64";

/**
 * sha256 of each header this table was derived from.
 *
 * The oracle test hashes the headers it compiles and compares them to this. A mismatch means the
 * pinned binary moved without the table being regenerated — which is exactly the silent-offset-shift
 * scenario the whole derivation exists to prevent, so it fails the test rather than being tolerated.
 */
export const HEADER_DIGESTS: readonly { readonly file: string; readonly sha256: string }[] = [
  { file: "webgpu.h", sha256: "2516cf5a7bec4385bf76ecc550d45015c1e3df77962211f3cef3f57507b2f2c8" },
  { file: "wgpu.h", sha256: "873faa1c1b63d48e4d866000fc51a163e85d0f7c6c01425c687d3f12d073ff74" },
];

/** Aggregate counts, per header. A bump that adds or removes structs shows up here in review. */
export const AGGREGATE_COUNTS = {
  "webgpu.h": 92,
  "wgpu.h": 23
} as const;
