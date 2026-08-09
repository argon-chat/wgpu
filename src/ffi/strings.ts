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
 * ── The by-value message parameter ─────────────────────────────────────────────────────────────
 *
 * Every wgpu-native callback takes its `message` as a `WGPUStringView` **by value**, and how it
 * arrives depends on the ABI:
 *
 * | | Win64 | AArch64 AAPCS | SysV x86-64 |
 * |---|---|---|---|
 * | 16-byte `{ptr, size_t}` argument | size ∉ {1,2,4,8} → **hidden reference** | ≤16 B → **two registers** | INTEGER+INTEGER → **two registers** |
 *
 * **Windows is the outlier and the other three agree** — the opposite of the 40-byte `*CallbackInfo`
 * case, where SysV is the outlier. Same phrase "by value", different rule, different platforms. A
 * revision that declared `message` as one pointer shipped on that confusion and hung inside
 * `requestAdapter` on the other three platforms; `src/ffi/abiSeam.ts` has the full account.
 *
 * So both shapes exist here, and neither is guessed:
 *
 *   - {@link readStringView} — the pointer form, used **only** on the Win64 direct path.
 *   - {@link decodeStringParts} — the flat `(data, length)` form, fed by the shim's C trampolines,
 *     which decode the aggregate with a compiler that knows the target's rules. Used everywhere the
 *     shim is bound, which is every platform where a shim is installed.
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
    return decodeStringParts(data, length);
  } catch {
    return "";
  }
}

/**
 * Decode a `WGPUStringView` that has already been split into its two members.
 *
 * The form the shim's C trampolines deliver, and the one correct everywhere: the aggregate was taken
 * apart by a compiler on the target rather than by a signature derived for one ABI.
 * {@link readStringView} funnels into it, so there is exactly one decoder and the two entry points
 * differ only in how they got hold of the two numbers.
 *
 * Never throws — it runs inside native callbacks, and an exception crossing back into Rust through a
 * `nounwind` boundary is undefined behaviour, not a stack trace.
 */
export function decodeStringParts(data: number | bigint | null, length: number | bigint): string {
  if (!data) return "";
  try {
    const address = asAddress(data);
    const len = typeof length === "bigint" ? length : BigInt(length);
    if (len === WGPU_STRLEN) return new CString(address).toString();
    const n = Number(len);
    if (n <= 0) return "";
    return UTF8.decode(new Uint8Array(toArrayBuffer(address, 0, n)));
  } catch {
    return "";
  }
}
