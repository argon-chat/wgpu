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
 * ── Why passing a pointer works on some ABIs, and why that is not portable ─────────────────────
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
 * ── The second case, which is where this actually went wrong ───────────────────────────────────
 *
 * A 16-byte aggregate of two integer-class members (`WGPUSupportedFeatures`, and every
 * `WGPUStringView`) classifies as INTEGER+INTEGER under SysV and is passed in **two registers** —
 * differently wrong from the 40-byte case, and not detectable by size. Under AAPCS the same 16 bytes
 * are ≤16 and therefore also go in **two registers**. Only Win64 passes them by hidden reference,
 * because 128 bits is not one of {8,16,32,64}.
 *
 * | | Win64 | AArch64 AAPCS | SysV x86-64 |
 * |---|---|---|---|
 * | 40-byte aggregate **argument** | hidden reference | indirect | **stack** |
 * | 16-byte aggregate, incl. every **callback** `message` | hidden reference | **two registers** | **two registers** |
 *
 * **The two rows group the platforms differently, and that is the whole trap.** Row one makes SysV
 * the outlier; row two makes Win64 the outlier. An earlier revision read row one, concluded that
 * Win64 and AArch64 were both safe, and shipped a callback signature that declared `message` as a
 * single pointer — correct on Windows, wrong on `linux-x64`, `linux-arm64` and `darwin-arm64` alike.
 *
 * The symptom was not a crash. The callee read the correlation ticket out of the register holding
 * `message.length`, `dispatch` correctly ignored the resulting unknown ticket, and the promise never
 * settled: a hang inside `requestAdapter` on three platforms simultaneously, with nothing anywhere
 * reporting an ABI problem. It survived every local run because the one platform available locally
 * was the one platform it was right on.
 *
 * ── How the hole is filled: a compiled shim, in both directions ────────────────────────────────
 *
 * Outside Win64 this module **cannot be made correct in JavaScript**. So the calling sequence is
 * bought from a compiler instead: `shim/` is a small Rust `cdylib` that declares these aggregates as
 * real `#[repr(C)]` structs and gives JavaScript a flat surface both ways —
 *
 *   - **going in**: the seven entry points re-exported with pointer parameters. Because every call
 *     site here already hands over a pointer to an already-packed buffer, the shim's signature *is*
 *     the signature this module was already using.
 *   - **coming back**: five C trampolines with the real callback prototypes, which take the
 *     by-value `WGPUStringView` and forward `(data, length)` to a flat JavaScript function. See
 *     {@link callbackTrampolines} and `src/ffi/async.ts`.
 *
 * The shim resolves wgpu-native at runtime, by the same absolute path this package resolved, so
 * there is exactly one wgpu-native instance in the process. It is checked on load for its flat-ABI
 * version, the wgpu-native generation it was written against, and — the interesting one — its
 * `sizeof` for each aggregate, compared against this package's independently derived C-ABI layouts.
 * Two descriptions of the same C types, cross-checked at runtime on the real target.
 *
 * ── Three states, and why the direct path survives ──────────────────────────────────────────────
 *
 * | State | When | |
 * |---|---|---|
 * | `shim`   | a shim library resolved | preferred on **every** platform |
 * | `direct` | no shim, and **both** by-value rules permit a pointer | **Win64 only** |
 * | `refuse` | no shim, and either rule does not | SysV x86-64, and all of AArch64 |
 *
 * `direct` is Win64-only because it has to satisfy both rows of the table above, and AArch64 fails
 * the second. That is a narrowing of what this file previously claimed.
 *
 * Preferring the shim everywhere is deliberate: it means the code that runs on Linux and macOS is
 * the code that has been executed on every test run on a machine with a real GPU and a debugger,
 * rather than a path whose first execution is on the platform where a mistake is hardest to
 * diagnose. The reasoning is set out in full in `shim.manifest.ts`.
 *
 * Keeping `direct` at all costs one branch and preserves one thing worth preserving: a fresh
 * checkout with no Rust toolchain and no published artefact still works on Windows, which is where
 * most people meet the package first. Everywhere else there is nothing correct to fall back to, and
 * {@link assertSeamUsable} refuses rather than corrupting a stack or dropping a ticket.
 *
 * `WGPU_BUN_SEAM=shim|direct|auto` forces the choice. `direct` on SysV is refused even when asked
 * for — an override may select between correct paths, never select an incorrect one.
 */

import { FFIType, dlopen } from "bun:ffi";

import { NPM_SCOPE, resolveNativeLibrary, shimSearchPath, tryResolveShimLibrary } from "../resolve.ts";
import { sizeOf } from "../layouts/index.ts";
import { WGPU_NATIVE_MAJOR } from "../../wgpu-native.manifest.ts";
import { SHIM_ABI_VERSION, shimIsRequired } from "../../shim.manifest.ts";
import type { IResolvedNativeLibrary } from "../types.ts";
import type { Ptr } from "./library.ts";

const { i32, ptr: p, u32, u64, void: v } = FFIType;

/**
 * The by-value entry points as wgpu-native exports them, declared with the aggregate parameter as a
 * pointer.
 *
 * `WGPUFuture` returns are typed `u64` (a single `uint64_t`, returned in `RAX` under both ABIs) and
 * are never read: `WGPUFuture.id` is always 0 in this build because futures are not implemented.
 */
const DIRECT_SYMBOLS = {
  /** `(instance, options*, WGPURequestAdapterCallbackInfo /* 40B by value * /) -> WGPUFuture` */
  wgpuInstanceRequestAdapter: { args: [p, p, p], returns: u64 },
  /** `(adapter, descriptor*, WGPURequestDeviceCallbackInfo /* 40B * /) -> WGPUFuture` */
  wgpuAdapterRequestDevice: { args: [p, p, p], returns: u64 },
  /** `(buffer, WGPUMapMode, size_t offset, size_t size, WGPUBufferMapCallbackInfo /* 40B * /)` */
  wgpuBufferMapAsync: { args: [p, u64, u64, u64, p], returns: u64 },
  /** `(device, WGPUPopErrorScopeCallbackInfo /* 40B * /) -> WGPUFuture` */
  wgpuDevicePopErrorScope: { args: [p, p], returns: u64 },
  /** `(queue, WGPUQueueWorkDoneCallbackInfo /* 40B * /) -> WGPUFuture` */
  wgpuQueueOnSubmittedWorkDone: { args: [p, p], returns: u64 },
  /** `(WGPUAdapterInfo /* 96B by value * /)` — frees the strings `wgpuAdapterGetInfo` allocated. */
  wgpuAdapterInfoFreeMembers: { args: [p], returns: v },
  /** `(WGPUSupportedFeatures /* 16B by value * /)` — SysV would pass this in two registers. */
  wgpuSupportedFeaturesFreeMembers: { args: [p], returns: v },
} as const satisfies Record<string, { args: readonly FFIType[]; returns: FFIType }>;

/**
 * The same seven, as the shim exports them.
 *
 * Names are prefixed rather than mirrored. Identical names would be marginally less code here and a
 * genuine hazard everywhere else: two `wgpuInstanceRequestAdapter` symbols in one process are
 * indistinguishable in a profiler, a crash dump, or a `dlopen` that happened to use `RTLD_GLOBAL`.
 * The mapping is seven lines and it is also the documentation of the pairing.
 */
const SHIM_SYMBOLS = {
  wgpu_bun_shim_instance_request_adapter: { args: [p, p, p], returns: u64 },
  wgpu_bun_shim_adapter_request_device: { args: [p, p, p], returns: u64 },
  wgpu_bun_shim_buffer_map_async: { args: [p, u64, u64, u64, p], returns: u64 },
  wgpu_bun_shim_device_pop_error_scope: { args: [p, p], returns: u64 },
  wgpu_bun_shim_queue_on_submitted_work_done: { args: [p, p], returns: u64 },
  wgpu_bun_shim_adapter_info_free_members: { args: [p], returns: v },
  wgpu_bun_shim_supported_features_free_members: { args: [p], returns: v },

  // Lifecycle and self-description. `open` must be called before any wrapper above; a wrapper called
  // first returns an invalid future id and fires no callback, which surfaces as the async layer's
  // deadline rather than as a fabricated success.
  wgpu_bun_shim_abi_version: { args: [], returns: u32 },
  wgpu_bun_shim_target_generation: { args: [], returns: u32 },
  wgpu_bun_shim_sizeof: { args: [u32], returns: u64 },
  wgpu_bun_shim_open: { args: [p, u64], returns: i32 },
  wgpu_bun_shim_is_open: { args: [], returns: i32 },
  wgpu_bun_shim_last_error: { args: [p, u64], returns: u64 },

  // The callback direction. `wgpuStringView` arrives BY VALUE in every wgpu-native callback, and the
  // rule for a 16-byte aggregate splits the platforms the opposite way from the 40-byte one — see
  // src/ffi/strings.ts. These two let the shim own that decoding too: JavaScript registers a flat
  // function pointer, and installs the matching trampoline's address in `WGPUCallbackInfo.callback`.
  wgpu_bun_shim_set_callback: { args: [u32, p], returns: i32 },
  wgpu_bun_shim_trampoline: { args: [u32], returns: p },
} as const satisfies Record<string, { args: readonly FFIType[]; returns: FFIType }>;

/**
 * Which callback the shim should trampoline. Must match the `SLOT_*` constants in the crate.
 *
 * A numeric selector rather than a string because it crosses a C boundary on every registration, and
 * a string would mean marshalling a length-prefixed buffer to say "0".
 */
export const CALLBACK_SLOTS = {
  requestAdapter: 0,
  requestDevice: 1,
  bufferMap: 2,
  popErrorScope: 3,
  queueWorkDone: 4,
} as const;

/** Name of a wgpu-native callback this seam can install a trampoline for. */
export type CallbackSlot = keyof typeof CALLBACK_SLOTS;

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
 * a different costume (`WGPUAdapterInfo` is 96 bytes, `WGPUSupportedFeatures` is 16).
 */
export const BY_VALUE_FUNCTIONS: readonly string[] = Object.keys(DIRECT_SYMBOLS);

/**
 * Every symbol the seam requires the shim to export — wrappers and lifecycle alike.
 *
 * Exported so a test can compare it against the `#[no_mangle]` functions in `shim/src/lib.rs`. The
 * two live in different languages and are edited for different reasons, and the failure mode of
 * drift is a `dlopen` that throws at first GPU call rather than at build time.
 */
export const SHIM_EXPORTS: readonly string[] = Object.keys(SHIM_SYMBOLS);

/** The wgpu-native name each shim export stands in for. Also the adapter's construction table. */
const SHIM_TO_NATIVE = {
  wgpuInstanceRequestAdapter: "wgpu_bun_shim_instance_request_adapter",
  wgpuAdapterRequestDevice: "wgpu_bun_shim_adapter_request_device",
  wgpuBufferMapAsync: "wgpu_bun_shim_buffer_map_async",
  wgpuDevicePopErrorScope: "wgpu_bun_shim_device_pop_error_scope",
  wgpuQueueOnSubmittedWorkDone: "wgpu_bun_shim_queue_on_submitted_work_done",
  wgpuAdapterInfoFreeMembers: "wgpu_bun_shim_adapter_info_free_members",
  wgpuSupportedFeaturesFreeMembers: "wgpu_bun_shim_supported_features_free_members",
} as const satisfies Record<keyof typeof DIRECT_SYMBOLS, keyof typeof SHIM_SYMBOLS>;

/**
 * Which aggregate each `wgpu_bun_shim_sizeof` selector describes.
 *
 * The cross-check this drives is the whole reason the selector exists: the Rust crate laid these out
 * with a compiler, this package derived them from the pinned headers, and neither consulted the
 * other. Agreement at runtime, on the real target, is evidence; agreement by inspection is not.
 */
const SIZEOF_SELECTORS: readonly (readonly [number, string])[] = [
  [0, "WGPUStringView"],
  [1, "WGPURequestAdapterCallbackInfo"],
  [2, "WGPUAdapterInfo"],
  [3, "WGPUSupportedFeatures"],
  [4, "WGPUFuture"],
];

// ── strategy ────────────────────────────────────────────────────────────────────────────────────

/** How the seam is being satisfied on this host. */
export type SeamMode =
  /** Through the compiled shim. Correct on every ABI. */
  | "shim"
  /** Directly, because this ABI passes the aggregates by hidden reference anyway. */
  | "direct"
  /** Not at all — the ABI needs a shim and none is installed. */
  | "refuse";

/** The seam's resolved state, for diagnostics and for the test gate's taxonomy. */
export interface ISeamStatus {
  readonly mode: SeamMode;
  /** The shim library, when one was found — regardless of whether it ended up being used. */
  readonly shim: IResolvedNativeLibrary | null;
  /** Whether this host has any correct path other than the shim. */
  readonly shimRequired: boolean;
  /** One line explaining how `mode` was arrived at. */
  readonly reason: string;
}

/** `WGPU_BUN_SEAM` — force a path. `auto` is the default and is what everything should normally use. */
function requestedMode(): "auto" | "shim" | "direct" {
  const raw = (process.env["WGPU_BUN_SEAM"] ?? "auto").toLowerCase();
  if (raw === "shim" || raw === "direct" || raw === "auto") return raw;
  throw new Error(
    `wgpu-bun: WGPU_BUN_SEAM="${raw}" is not one of auto | shim | direct.\n` +
      `  Leave it unset unless you are deliberately A/B-ing the two calling paths.`,
  );
}

/**
 * Decide how the seam will be satisfied, without loading anything or throwing on refusal.
 *
 * Pure with respect to the process: it reads the environment and the filesystem and returns a
 * verdict. `test/support/gpu.ts` uses it to tell an ABI refusal apart from a missing GPU, which was
 * previously reported as `no-adapter` and sent at least one reader looking for a driver problem that
 * did not exist.
 */
export function seamStatus(
  platform: string = process.platform,
  arch: string = process.arch,
): ISeamStatus {
  const required = shimIsRequired(platform, arch);
  let shim: IResolvedNativeLibrary | null = null;
  try {
    shim = tryResolveShimLibrary();
  } catch {
    // A set-but-wrong WGPU_BUN_SHIM_LIB throws from the resolver. Treated as "no shim" for the
    // purpose of the verdict; `seam()` re-runs the resolution and lets that error surface intact,
    // because a user who named a path deserves to be told the path is wrong.
    shim = null;
  }

  const wanted = requestedMode();
  if (wanted === "direct") {
    return required
      ? {
          mode: "refuse",
          shim,
          shimRequired: required,
          reason: `WGPU_BUN_SEAM=direct was requested, but ${platform}-${arch} cannot express a by-value aggregate from bun:ffi. An override may pick between correct paths, not select an incorrect one.`,
        }
      : { mode: "direct", shim, shimRequired: required, reason: "WGPU_BUN_SEAM=direct was requested and this ABI permits it." };
  }

  if (wanted === "shim") {
    return shim
      ? { mode: "shim", shim, shimRequired: required, reason: "WGPU_BUN_SEAM=shim was requested and a shim is installed." }
      : { mode: "refuse", shim, shimRequired: required, reason: "WGPU_BUN_SEAM=shim was requested but no shim library is installed." };
  }

  if (shim) {
    return { mode: "shim", shim, shimRequired: required, reason: "A shim is installed; it is preferred on every platform." };
  }
  return required
    ? {
        mode: "refuse",
        shim,
        shimRequired: required,
        reason: `No shim is installed and ${platform}-${arch} has no correct direct path.`,
      }
    : {
        mode: "direct",
        shim,
        shimRequired: required,
        reason: `No shim is installed, but ${platform}-${arch} passes these aggregates by hidden reference, so a pointer is the correct calling sequence.`,
      };
}

/**
 * The seam could not be satisfied on this host — so nothing was attempted.
 *
 * A distinct class, not a bare `Error`, because it is a distinct condition that must not be filed
 * under anything else. It was previously indistinguishable from "no GPU on this host", and a CI leg
 * with a perfectly good software adapter reported `no-adapter` — a diagnosis pointing at the driver
 * stack, which cost real time.
 *
 * It covers **both** ways the seam can come up empty, and deliberately so:
 *
 *   - the ABI cannot express a by-value aggregate and no shim is installed (the expected case, and a
 *     permitted skip while the artefact is missing);
 *   - a shim *is* installed but was rejected — wrong flat-ABI version, wrong wgpu-native generation,
 *     a `sizeof` disagreement, or it could not open wgpu-native at all.
 *
 * Splitting those into two classes was the first design and it was wrong. The second case would then
 * have reached the test gate as an untyped throw and been filed under `no-adapter` — which is
 * *escapable* by an environment variable CI grants on some legs, so a rejected shim could be skipped
 * past in silence. One class, and the policy distinguishes them by asking whether a shim is
 * installed: absent is a permitted skip, present-and-rejected is a defect and goes red.
 */
export class AbiUnsupportedError extends Error {
  override readonly name = "AbiUnsupportedError";
}

/**
 * Refuse to run where a pointer is not a correct stand-in for a by-value aggregate and no shim can
 * supply one.
 *
 * Called once, before the first seam call. A loud refusal is the only honest option: the failure
 * mode on SysV is not a crash but garbage read from the stack, which surfaces as a callback that
 * never fires, or fires with a nonsense status — days of debugging pointed at the wrong layer.
 *
 * @throws {AbiUnsupportedError}
 */
export function assertSeamUsable(status: ISeamStatus = seamStatus()): void {
  if (status.mode !== "refuse") return;
  throw new AbiUnsupportedError(
    `wgpu-bun: this host cannot make by-value struct arguments on ${process.platform}-${process.arch}.\n` +
      `  ${status.reason}\n\n` +
      `  ${BY_VALUE_FUNCTIONS.length} wgpu-native entry points take a *CallbackInfo aggregate by value. On Win64 and\n` +
      `  AArch64 such an aggregate is passed by hidden reference, so a pointer is the correct calling\n` +
      `  sequence and bun:ffi can express it. Under the SysV x86-64 ABI it is copied onto the stack\n` +
      `  instead, and no combination of bun:ffi argument types can produce that. Running anyway would\n` +
      `  not crash — it would silently corrupt every asynchronous call — so this refuses instead.\n\n` +
      `  The fix is the compiled shim in shim/. Install it with one of:\n` +
      `    bun add ${NPM_SCOPE}/${process.platform}-${process.arch}   (once published; it carries the shim)\n` +
      `    bun run shim:fetch                        (downloads the pinned prebuilt shim)\n` +
      `    bun run shim:build                        (builds it from source; needs a Rust toolchain)\n` +
      `  Looked for it in:\n${shimSearchPath()}`,
  );
}

// ── binding ─────────────────────────────────────────────────────────────────────────────────────

/** The seven entry points, however they are being reached. */
export type SeamSymbols = ReturnType<typeof openDirect>["symbols"];

let bound: SeamSymbols | null = null;
let boundMode: SeamMode | null = null;
/** Retained after a shim bind so the callback trampolines stay reachable. `null` on the direct path. */
let shimSymbols: ShimSymbols | null = null;

function openDirect(libPath: string) {
  return dlopen(libPath, DIRECT_SYMBOLS);
}

function openShimLibrary(libPath: string) {
  return dlopen(libPath, SHIM_SYMBOLS);
}

type ShimSymbols = ReturnType<typeof openShimLibrary>["symbols"];

/** Read the shim's last error message back out of it. */
function shimError(s: ShimSymbols): string {
  const buffer = new Uint8Array(1024);
  const written = Number(s.wgpu_bun_shim_last_error(buffer, BigInt(buffer.length)));
  return written > 0 ? new TextDecoder().decode(buffer.subarray(0, written)) : "(the shim reported no detail)";
}

/**
 * Open the shim, verify it, and point it at the same wgpu-native this package loaded.
 *
 * Three checks, in the order that makes a failure legible:
 *
 *   1. **Flat-ABI version.** A shim built against a different set of signatures would be called with
 *      the wrong arguments, which corrupts a stack rather than raising anything.
 *   2. **wgpu-native generation.** The shim's `#[repr(C)]` structs are transcriptions of one
 *      generation's headers. This is the one runtime failure mode a compiled shim *adds* over the
 *      JS-only path, so it is checked rather than assumed.
 *   3. **`sizeof` agreement.** Two independent descriptions of the same C aggregates — a Rust
 *      compiler's, and this package's derivation from the pinned headers — compared on the real
 *      target. The build-time header oracle cannot do this for a platform the developer is not on;
 *      this can.
 */
function bindShim(shim: IResolvedNativeLibrary, nativePath: string, s: ShimSymbols): SeamSymbols {

  const abi = Number(s.wgpu_bun_shim_abi_version());
  if (abi !== SHIM_ABI_VERSION) {
    throw new AbiUnsupportedError(
      `wgpu-bun: the ABI shim at "${shim.path}" reports flat-ABI version ${abi}, but this build ` +
        `speaks version ${SHIM_ABI_VERSION}.\n` +
        `  The two were built from different sources. Rebuild or reinstall the shim — calling it ` +
        `across a signature change does not fail, it corrupts the stack.`,
    );
  }

  const generation = Number(s.wgpu_bun_shim_target_generation());
  if (generation !== WGPU_NATIVE_MAJOR) {
    throw new AbiUnsupportedError(
      `wgpu-bun: the ABI shim at "${shim.path}" was written against wgpu-native generation ` +
        `${generation}, but this package pins generation ${WGPU_NATIVE_MAJOR}.\n` +
        `  The shim transcribes that generation's struct layouts by hand; pairing it with another ` +
        `is version skew, and it is the one failure mode a compiled shim adds over the direct path.`,
    );
  }

  for (const [selector, aggregate] of SIZEOF_SELECTORS) {
    const fromShim = Number(s.wgpu_bun_shim_sizeof(selector));
    const derived = sizeOf(aggregate);
    if (fromShim !== derived) {
      throw new AbiUnsupportedError(
        `wgpu-bun: sizeof(${aggregate}) disagrees between the ABI shim and the derived C-ABI ` +
          `layouts — shim says ${fromShim}, this package derived ${derived}.\n` +
          `  These are two independent descriptions of the same C type. One of them is wrong, and ` +
          `until it is known which, every by-value call would be reading the wrong bytes.`,
      );
    }
  }

  const pathBytes = new TextEncoder().encode(nativePath);
  const rc = Number(s.wgpu_bun_shim_open(pathBytes, BigInt(pathBytes.length)));
  if (rc !== 0) {
    throw new AbiUnsupportedError(
      `wgpu-bun: the ABI shim could not open wgpu-native at "${nativePath}" (code ${rc}).\n` +
        `  ${shimError(s)}\n` +
        `  Shim: ${shim.path} (via ${shim.source})`,
    );
  }

  // The adapter. Every entry maps a wgpu-native name onto the shim export standing in for it; the
  // FFI signatures are declared identically in both tables, so the forwarding is a rename and not a
  // conversion. `satisfies` on SHIM_TO_NATIVE is what stops the two tables drifting apart.
  return {
    wgpuInstanceRequestAdapter: s[SHIM_TO_NATIVE.wgpuInstanceRequestAdapter],
    wgpuAdapterRequestDevice: s[SHIM_TO_NATIVE.wgpuAdapterRequestDevice],
    wgpuBufferMapAsync: s[SHIM_TO_NATIVE.wgpuBufferMapAsync],
    wgpuDevicePopErrorScope: s[SHIM_TO_NATIVE.wgpuDevicePopErrorScope],
    wgpuQueueOnSubmittedWorkDone: s[SHIM_TO_NATIVE.wgpuQueueOnSubmittedWorkDone],
    wgpuAdapterInfoFreeMembers: s[SHIM_TO_NATIVE.wgpuAdapterInfoFreeMembers],
    wgpuSupportedFeaturesFreeMembers: s[SHIM_TO_NATIVE.wgpuSupportedFeaturesFreeMembers],
  };
}

/**
 * The seam's entry points.
 *
 * Every argument is a pointer to a buffer the caller already packed, which is exactly the signature
 * the compiled shim exposes — which is why adopting it was a change to this function's body and
 * nothing else.
 */
export function seam(): SeamSymbols {
  if (bound) return bound;
  const status = seamStatus();
  assertSeamUsable(status);

  const native = resolveNativeLibrary();
  if (status.mode === "shim") {
    // Re-resolve rather than trusting the status snapshot: a set-but-wrong WGPU_BUN_SHIM_LIB is
    // swallowed there (to keep the verdict non-throwing) and must surface here.
    const shim = tryResolveShimLibrary();
    if (!shim) {
      throw new AbiUnsupportedError(`wgpu-bun: the ABI shim vanished between resolution and binding.\n  ${status.reason}`);
    }
    const opened = openShimLibrary(shim.path).symbols;
    bound = bindShim(shim, native.path, opened);
    shimSymbols = opened;
    boundMode = "shim";
    return bound;
  }

  bound = openDirect(native.path).symbols;
  boundMode = "direct";
  return bound;
}

/** How the seam was actually bound, or `null` if nothing has called {@link seam} yet. */
export function seamBoundMode(): SeamMode | null {
  return boundMode;
}

/** The shim's trampoline services, or `null` when the seam is bound to the direct path. */
export interface ICallbackTrampolines {
  /** Register the flat JavaScript function the trampoline for `slot` will forward to. */
  install(slot: CallbackSlot, flatFunctionPointer: number): void;
  /** The address to write into `WGPUCallbackInfo.callback` for `slot`. */
  address(slot: CallbackSlot): number;
}

/**
 * How callbacks should be installed on this host.
 *
 * `null` means the direct path is bound and the caller must use the **pointer-form** callback
 * signature, which is correct on Win64 and nowhere else — the seam only ever binds `direct` on
 * Win64, so that is safe, but it is safe because of the check in {@link seamStatus}, not by luck.
 *
 * Anything else means the shim is bound and its C trampolines own the by-value `WGPUStringView`
 * decoding, so the caller must use the **flat** signature.
 *
 * Calling this binds the seam, which is deliberate: the choice of callback shape and the choice of
 * calling path are the same choice, and letting them be made separately is how they end up
 * disagreeing.
 */
export function callbackTrampolines(): ICallbackTrampolines | null {
  seam();
  if (boundMode !== "shim" || !shimSymbols) return null;
  const s = shimSymbols;
  return {
    install(slot, flatFunctionPointer) {
      const rc = Number(s.wgpu_bun_shim_set_callback(CALLBACK_SLOTS[slot], flatFunctionPointer as Ptr));
      if (rc !== 0) {
        throw new AbiUnsupportedError(
          `wgpu-bun: the ABI shim rejected the ${slot} callback registration (code ${rc}).\n  ${shimError(s)}`,
        );
      }
    },
    address(slot) {
      const addr = Number(s.wgpu_bun_shim_trampoline(CALLBACK_SLOTS[slot]));
      if (!addr) {
        throw new AbiUnsupportedError(
          `wgpu-bun: the ABI shim has no trampoline for slot "${slot}" (${CALLBACK_SLOTS[slot]}).\n` +
            `  The slot table here and the SLOT_* constants in the crate have drifted.`,
        );
      }
      return addr;
    },
  };
}

/** Convenience alias so call sites read as pointers rather than as numbers. */
export type SeamPtr = Ptr;
