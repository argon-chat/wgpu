/**
 * Reading `WGPUStringView` out of native memory.
 *
 * A `WGPUStringView` is `{ char const* data; size_t length; }`. Two properties bite:
 *
 *   - `length` may be the sentinel `WGPU_STRLEN` (`SIZE_MAX`), meaning "NUL-terminated, measure it".
 *     Handing that to a length-based decoder asks for a 16-exabyte read.
 *   - `data` may be NULL with any length, meaning "no string" — which is not the same as `""` but
 *     is indistinguishable to every consumer in the WebGPU API, so both become `""` here.
 *
 * ── Why a callback receives a pointer where C says "by value" ───────────────────────────────────
 *
 * Every wgpu-native callback takes its `message` as a `WGPUStringView` **by value**. On Win64 a
 * 16-byte aggregate is not one of the {1,2,4,8} register-sized cases, so it is passed by hidden
 * reference and arrives as a pointer — which is why {@link readStringView} takes one. On SysV
 * x86-64 the same 16 bytes classify as INTEGER+INTEGER and arrive in **two registers** instead,
 * which is the second half of the portability problem documented in {@link ./abiSeam.ts}.
 */

import { CString, read, toArrayBuffer } from "bun:ffi";

import { asAddress } from "./pointer.ts";

/** `WGPU_STRLEN` — "this string is NUL-terminated; measure it yourself". */
const WGPU_STRLEN = 0xffffffffffffffffn;

const UTF8 = new TextDecoder();

/**
 * Decode a `WGPUStringView` given a pointer to it.
 *
 * @returns the string, or `""` for a NULL/absent view. Never throws: this runs inside native
 *          callbacks, and a throw crossing back into Rust is undefined behaviour.
 */
export function readStringView(structPtr: number | bigint | null): string {
  if (!structPtr) return "";
  // An address handed to us by C, not a ticket. See ./pointer.ts.
  const p = asAddress(structPtr);
  try {
    const data = read.ptr(p, 0);
    if (data === 0) return "";
    const length = read.u64(p, 8);
    if (length === WGPU_STRLEN) return new CString(asAddress(data)).toString();
    const n = Number(length);
    if (n <= 0) return "";
    return UTF8.decode(new Uint8Array(toArrayBuffer(asAddress(data), 0, n)));
  } catch {
    return "";
  }
}
