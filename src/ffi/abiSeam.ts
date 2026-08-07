/**
 * ███ THE ABI SEAM ███
 *
 * The only module in this package that passes a C **aggregate by value**. Everything else crosses
 * the boundary with primitives and pointers, which `bun:ffi` handles natively and correctly on
 * every platform.
 *
 * ── Why a seam at all ───────────────────────────────────────────────────────────────────────────
 *
 * `bun:ffi` has no struct-by-value argument type — `FFIType` has 22 members and none of them is a
 * struct. Upstream calls it "not supported yet"; it has been open since 2023 and the FFI rewrite
 * did not fix it. That is a hard constraint, not an oversight to work around.
 *
 * It turns out to matter far less than it sounds. All 115 descriptor structs in `webgpu.h` —
 * including the 168-byte `WGPURenderPipelineDescriptor` with its nested vertex state and chained
 * fragment state — are passed **by pointer**. Descriptors are not the problem. The entire hazard is
 * the handful of functions below, which take a `*CallbackInfo` (40 bytes) or an info struct by
 * value.
 *
 * ── Why passing a pointer works here, and why that is not portable ─────────────────────────────
 *
 * > **Win64 calling convention:** an aggregate argument whose size is not exactly 1, 2, 4 or 8
 * > bytes is passed **by hidden reference** — the caller materialises a temporary and passes its
 * > address in the register or stack slot.
 *
 * `WGPURequestAdapterCallbackInfo` is 40 bytes, so at the machine level `f(ptr, ptr, byval40)` and
 * `f(ptr, ptr, const void*)` are the *same call*. Declaring the parameter as a pointer and passing
 * the address of a packed buffer is not a trick that happens to work — it is the correct calling
 * sequence. This is proven by execution on Windows x64: the callback fires and a sentinel written
 * into `userdata1` arrives intact.
 *
 * | ABI | 40-byte aggregate argument | Pointer substitution |
 * |---|---|---|
 * | **Win64** (x64 Windows) | size ∉ {1,2,4,8} → by hidden reference | **correct** — verified by execution |
 * | **AArch64 AAPCS** (win/linux arm64, Apple silicon) | size > 16 → indirect, address in a register | **correct by rule** — not executed here |
 * | **SysV x86-64** (Linux x64, Intel macOS) | size > 16 → class MEMORY → **copied onto the stack** | **WRONG.** A pointer in `RDX` where 40 bytes of stack were expected is garbage. |
 *
 * There is a second, subtler SysV case: a 16-byte aggregate of two integer-class members
 * (`WGPUSupportedFeatures`, and every `WGPUStringView`) classifies as INTEGER+INTEGER and is passed
 * in **two registers**, so a pointer is wrong there too — differently wrong, and not detectable by
 * size alone.
 *
 * ── What this seam costs, stated plainly ────────────────────────────────────────────────────────
 *
 * On SysV x86-64 this module **cannot be made correct in JavaScript**, so {@link assertSeamUsable}
 * refuses to run there rather than corrupting the stack. Filling that hole needs a small compiled
 * shim — a Rust `cdylib` (or a `cc()` translation unit) that declares these functions with real
 * `#[repr(C)]` structs, lets a real compiler emit the right calling sequence, and re-exports them
 * with flat pointer parameters. The shim is roughly 200–300 lines and wraps **only** the functions
 * in this file.
 *
 * Everything is arranged so that shim slots in behind this module and nothing else moves: callers
 * only ever hand over pointers to already-packed buffers, so the shim's signature is exactly the
 * signature already used here. The cost of adopting it is a cargo toolchain and a per-platform
 * build matrix — which is why it is not being built now, and why refusing to run is the honest
 * behaviour in the meantime. If Bun ever lands struct-by-value in `bun:ffi`, this whole module
 * collapses into the ordinary symbol table.
 */

import { FFIType, dlopen } from "bun:ffi";

import { resolveNativeLibrary } from "../resolve.ts";
import type { Ptr } from "./library.ts";

const { ptr, u64, void: v } = FFIType;

/**
 * The by-value entry points, declared with the aggregate parameter as a pointer.
 *
 * `WGPUFuture` returns are typed `u64` (a single `uint64_t`, returned in `RAX` under both ABIs) and
 * are never read: `WGPUFuture.id` is always 0 in this build because futures are not implemented.
 */
const BY_VALUE_SYMBOLS = {
  /** `(instance, options*, WGPURequestAdapterCallbackInfo /* 40B by value * /) -> WGPUFuture` */
  wgpuInstanceRequestAdapter: { args: [ptr, ptr, ptr], returns: u64 },
  /** `(adapter, descriptor*, WGPURequestDeviceCallbackInfo /* 40B * /) -> WGPUFuture` */
  wgpuAdapterRequestDevice: { args: [ptr, ptr, ptr], returns: u64 },
  /** `(buffer, WGPUMapMode, size_t offset, size_t size, WGPUBufferMapCallbackInfo /* 40B * /)` */
  wgpuBufferMapAsync: { args: [ptr, u64, u64, u64, ptr], returns: u64 },
  /** `(device, WGPUPopErrorScopeCallbackInfo /* 40B * /) -> WGPUFuture` */
  wgpuDevicePopErrorScope: { args: [ptr, ptr], returns: u64 },
  /** `(queue, WGPUQueueWorkDoneCallbackInfo /* 40B * /) -> WGPUFuture` */
  wgpuQueueOnSubmittedWorkDone: { args: [ptr, ptr], returns: u64 },
  /** `(WGPUAdapterInfo /* 88B by value * /)` — frees the strings `wgpuAdapterGetInfo` allocated. */
  wgpuAdapterInfoFreeMembers: { args: [ptr], returns: v },
  /** `(WGPUSupportedFeatures /* 16B by value * /)` — SysV would pass this in two registers. */
  wgpuSupportedFeaturesFreeMembers: { args: [ptr], returns: v },
} as const satisfies Record<string, { args: readonly FFIType[]; returns: FFIType }>;

/**
 * The **eight** `webgpu.h` functions that take a `*CallbackInfo` aggregate by value — the canonical
 * statement of the hazard, independent of what this package happens to bind. Extracted from the
 * pinned header, not remembered.
 */
export const BY_VALUE_CALLBACK_INFO_FUNCTIONS: readonly string[] = [
  "wgpuInstanceRequestAdapter",
  "wgpuAdapterRequestDevice",
  "wgpuBufferMapAsync",
  "wgpuQueueOnSubmittedWorkDone",
  "wgpuDevicePopErrorScope",
  // The remaining three are also by-value, but are `unimplemented!()` stubs that abort when called,
  // so they are on the blocklist rather than in this seam. That is why the seam binds five of eight.
  "wgpuShaderModuleGetCompilationInfo",
  "wgpuDeviceCreateComputePipelineAsync",
  "wgpuDeviceCreateRenderPipelineAsync",
];

/**
 * What this seam actually binds: the five callable callback-info functions, plus the two
 * `*FreeMembers` entry points, which take a whole info struct by value and are the same hazard in
 * a different costume (`WGPUAdapterInfo` is 88 bytes, `WGPUSupportedFeatures` is 16).
 */
export const BY_VALUE_FUNCTIONS: readonly string[] = Object.keys(BY_VALUE_SYMBOLS);

/**
 * Refuse to run where a pointer is not a correct stand-in for a by-value aggregate.
 *
 * Called once, before the first seam call. A loud refusal at startup is the only honest option:
 * the failure mode on SysV is not a crash but garbage read from the stack, which surfaces as a
 * callback that never fires, or fires with a nonsense status — days of debugging pointed at the
 * wrong layer.
 */
export function assertSeamUsable(): void {
  const isWindows = process.platform === "win32";
  const isArm64 = process.arch === "arm64";
  if (isWindows || isArm64) return;
  throw new Error(
    `wgpu-bun: this build cannot make by-value struct arguments on ${process.platform}-${process.arch}.\n` +
      `  ${BY_VALUE_FUNCTIONS.length} wgpu-native entry points take a *CallbackInfo aggregate by value. On Win64 and\n` +
      `  AArch64 such an aggregate is passed by hidden reference, so a pointer is the correct calling\n` +
      `  sequence and bun:ffi can express it. Under the SysV x86-64 ABI it is copied onto the stack\n` +
      `  instead, and no combination of bun:ffi argument types can produce that.\n` +
      `  Fixing it needs a small compiled shim behind src/ffi/abiSeam.ts. Running anyway would not\n` +
      `  crash — it would silently corrupt every asynchronous call — so this refuses instead.`,
  );
}

let bound: ReturnType<typeof openSeam>["symbols"] | null = null;

function openSeam(libPath: string) {
  return dlopen(libPath, BY_VALUE_SYMBOLS);
}

/**
 * The seam's entry points.
 *
 * Every argument is a pointer to a buffer the caller already packed, which is exactly the signature
 * a compiled shim would expose — so adopting one is a change to this function's body and nothing
 * else.
 */
export function seam(): ReturnType<typeof openSeam>["symbols"] {
  if (bound) return bound;
  assertSeamUsable();
  bound = openSeam(resolveNativeLibrary().path).symbols;
  return bound;
}

/** Convenience alias so call sites read as pointers rather than as numbers. */
export type SeamPtr = Ptr;
