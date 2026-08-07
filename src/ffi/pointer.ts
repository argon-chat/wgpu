/**
 * The one place where an integer becomes an address.
 *
 * `bun:ffi` brands its `Pointer` type (`number & { __pointer__: null }`) so that an integer which
 * happens to be lying around cannot be handed to C as an address. That brand is load-bearing here
 * rather than merely tidy, because this package deliberately traffics in **two** kinds of 64-bit
 * integer that look identical at runtime and must never be confused:
 *
 *   - **addresses** — real machine pointers, produced by `ptr()` or handed back by wgpu-native;
 *   - **tickets** — monotonic integers stored in a `void* userdata1` slot precisely *because* they
 *     are not addresses. The entire correctness argument for the async layer is that C never holds
 *     a reference to JS-owned memory (see {@link ./async.ts}). If the two collapse into "number",
 *     that argument stops being checkable.
 *
 * So conversions are narrow, named, and single-purpose. There is no general `as Pointer` cast in
 * this package, and adding one would remove the only mechanical guard the distinction has.
 *
 * Note the asymmetry the brand gives for free: a `Pointer` *is* a `number`, so an address can flow
 * into a struct member without ceremony; a `number` is not a `Pointer`, so it cannot flow the other
 * way without passing through {@link asAddress} and its comment.
 */

import type { Pointer } from "bun:ffi";

export type { Pointer };

/** A native address, or NULL. Handles, descriptor pointers, mapped ranges. */
export type Ptr = Pointer;

/** NULL, spelled so call sites read as C rather than as JavaScript. */
export const NULL = null;

/**
 * Reinterpret an integer that genuinely *is* an address.
 *
 * Legitimate sources are exactly two, and both are places the value arrives from C untyped:
 * a pointer read out of a C struct (`CStructView.getPtr`), and a handle delivered as a callback
 * argument. Anything else calling this is smuggling a ticket across the line.
 */
export function asAddress(value: number | bigint): Ptr {
  return Number(value) as Ptr;
}

/** `true` for NULL. Reads better than `!p` where `p` is legitimately 0-valued elsewhere. */
export function isNull(p: Ptr | null | undefined): boolean {
  return !p;
}

/**
 * Assert that a creation call returned a real handle.
 *
 * wgpu-native returns NULL from `wgpuDeviceCreate*` when the descriptor was rejected, having
 * already reported the reason through the uncaptured-error callback or the open error scope. A
 * NULL that flows onward becomes a null-dereference inside Rust several calls later, attributed to
 * whatever happened to touch it — so it is caught here, at the call that produced it.
 */
export function requireHandle(value: Ptr | null, what: string): Ptr {
  if (!value) {
    throw new Error(
      `wgpu-bun: ${what} returned NULL — the descriptor was rejected. The reason was reported ` +
        `through the uncaptured-error callback or the enclosing error scope.`,
    );
  }
  return value;
}
