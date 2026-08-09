/**
 * ███ THE ABI SEAM ███
 *
 * The only module here that passes a C **aggregate by value**. Everything else crosses with
 * primitives and pointers, which `bun:ffi` handles correctly on every platform.
 *
 * ── Why a seam at all ───────────────────────────────────────────────────────────────────────────
 *
 * `bun:ffi` has no struct-by-value argument type — none of `FFIType`'s 22 members is a struct.
 * Upstream calls it "not supported yet"; open since 2023, and the FFI rewrite did not fix it. All
 * 115 descriptor structs in `webgpu.h`, including the 168-byte `WGPURenderPipelineDescriptor`, are
 * passed **by pointer**, so the whole hazard is the handful of functions below, which take a
 * `*CallbackInfo` (40 bytes) or an info struct by value.
 *
 * ── The two by-value rules, and why they group the platforms differently ────────────────────────
 *
 * Under Win64 an aggregate argument whose size is not exactly 1, 2, 4 or 8 bytes is passed **by
 * hidden reference**: the caller materialises a temporary and passes its address in the register or
 * stack slot. `WGPURequestAdapterCallbackInfo` is 40 bytes, so `f(ptr, ptr, byval40)` and
 * `f(ptr, ptr, const void*)` are the *same call*, and handing over the address of a packed buffer is
 * the correct calling sequence rather than a trick. Verified by execution on Windows x64 — the
 * callback fires and a sentinel written into `userdata1` arrives intact. The other ABIs disagree,
 * and they disagree differently for each of the two aggregate sizes that cross this boundary:
 *
 * | aggregate | **Win64** (x64 Windows) | **AArch64 AAPCS** (win/linux arm64, Apple silicon) | **SysV x86-64** (Linux x64, Intel macOS) |
 * |---|---|---|---|
 * | **40 B** `*CallbackInfo`, an **argument** | size ∉ {1,2,4,8} → hidden reference | size > 16 → indirect, address in a register | size > 16 → class MEMORY → **copied onto the stack** |
 * | **16 B** `WGPUStringView` (and `WGPUSupportedFeatures`), every **callback** `message` | hidden reference, because 128 bits ∉ {8,16,32,64} | ≤16 B → **two registers** | INTEGER+INTEGER → **two registers** |
 *
 * So a pointer stands in correctly for row one on Win64 (verified by execution) and on AArch64
 * (correct by rule, not executed here), but **not** on SysV: a pointer in `RDX` where 40 bytes of
 * stack were expected is garbage.
 *
 * **The two rows group the platforms differently, and that is the whole trap.** Row one makes SysV
 * the outlier; row two makes Win64 the outlier. An earlier revision read only row one and shipped
 * `message` as a single pointer: right on Windows, wrong on `linux-x64`, `linux-arm64` and
 * `darwin-arm64`. Not a crash — the callee read the ticket out of the register holding
 * `message.length`, `dispatch` ignored the unknown ticket, and the promise never settled. A hang in
 * `requestAdapter` on three platforms at once, no ABI error anywhere, and every local run green
 * because the local platform was the one it was right on.
 *
 * ── How the hole is filled: a compiled shim, in both directions ────────────────────────────────
 *
 * Outside Win64 this **cannot be made correct in JavaScript**, so the calling sequence is bought
 * from a compiler. `shim/` is a small Rust `cdylib` declaring these aggregates as real `#[repr(C)]`
 * structs, flat in both directions:
 *
 *   - **in**: the seven entry points re-exported with pointer parameters. Every call site here
 *     already passes a pointer to a packed buffer, so the shim's signature *is* the one already used.
 *   - **out**: seven C trampolines with the real callback prototypes, taking the by-value
 *     `WGPUStringView` and forwarding `(data, length)` to a flat JavaScript function. See
 *     {@link callbackTrampolines} and `src/ffi/async.ts`.
 *
 * The shim resolves wgpu-native by the same absolute path this package resolved, so the process has
 * exactly one wgpu-native instance. On load it is checked for flat-ABI version, wgpu-native
 * generation, and `sizeof` per aggregate against this package's independently derived C-ABI layouts.
 *
 * ── Three states, and why the direct path survives ──────────────────────────────────────────────
 *
 * | State | When | |
 * |---|---|---|
 * | `shim`   | a shim library resolved | preferred on **every** platform |
 * | `direct` | no shim, and **both** by-value rules permit a pointer | **Win64 only** |
 * | `refuse` | no shim, and either rule does not | SysV x86-64, and all of AArch64 |
 *
 * `direct` is Win64-only because it must satisfy both rows above, and AArch64 fails the second. The
 * shim is preferred everywhere so the code running on Linux and macOS is the code executed on every
 * local test run against a real GPU with a debugger, rather than a path first exercised where a
 * mistake is hardest to diagnose (full reasoning in `shim.manifest.ts`). `direct` survives so a
 * fresh checkout with no Rust toolchain and no published artefact still works on Windows, where most
 * people meet the package first; elsewhere there is nothing correct to fall back to and
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
import { currentImpl } from "../impl.ts";
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
 * Names are prefixed rather than mirrored: two `wgpuInstanceRequestAdapter` symbols in one process
 * are indistinguishable in a profiler, a crash dump, or a `dlopen` that used `RTLD_GLOBAL`.
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
 * Numeric rather than a string because it crosses a C boundary on every registration, and a string
 * would mean marshalling a length-prefixed buffer to say "0".
 */
export const CALLBACK_SLOTS = {
  requestAdapter: 0,
  requestDevice: 1,
  bufferMap: 2,
  popErrorScope: 3,
  queueWorkDone: 4,
  // Installed in the `WGPUDeviceDescriptor` at device creation rather than handed to an entry point
  // above — which is why two separate sweeps for by-value callback hazards walked past them. Their C
  // prototypes take `WGPUStringView` by value like every other callback here, so how they are
  // *installed* has no bearing on which ABI rule governs them.
  uncapturedError: 5,
  deviceLost: 6,
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
 * two are in different languages and edited for different reasons, and drift surfaces as a `dlopen`
 * that throws at the first GPU call rather than at build time.
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
 * The cross-check is the whole reason the selector exists: the Rust crate laid these out with a
 * compiler, this package derived them from the pinned headers, and neither consulted the other.
 * Agreement at runtime, on the real target, is evidence; agreement by inspection is not.
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
 * Pure with respect to the process: reads the environment and the filesystem, returns a verdict.
 * `test/support/gpu.ts` uses it to tell an ABI refusal apart from a missing GPU — the two were once
 * both reported as `no-adapter`, sending readers after a driver problem that did not exist.
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
    // A set-but-wrong WGPU_BUN_SHIM_LIB throws from the resolver. Treated as "no shim" here so the
    // verdict stays non-throwing; `seam()` re-runs the resolution and lets that error surface, so a
    // user who named a path is told the path is wrong.
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
 * Its own class, not a bare `Error`: this was once indistinguishable from "no GPU on this host", and
 * a CI leg with a perfectly good software adapter reported `no-adapter` — a diagnosis pointing at
 * the driver stack, which cost real time. It deliberately covers **both** ways the seam can come up
 * empty:
 *
 *   - the ABI cannot express a by-value aggregate and no shim is installed (the expected case, and a
 *     permitted skip while the artefact is missing);
 *   - a shim *is* installed but was rejected — wrong flat-ABI version, wrong wgpu-native generation,
 *     a `sizeof` disagreement, or it could not open wgpu-native at all.
 *
 * Two classes was the first design and it was wrong: the second case would reach the test gate as an
 * untyped throw and be filed under `no-adapter`, which is *escapable* by an environment variable CI
 * grants on some legs — so a rejected shim could be skipped past in silence. One class, and the
 * policy asks whether a shim is installed: absent is a permitted skip, present-and-rejected goes red.
 */
export class AbiUnsupportedError extends Error {
  override readonly name = "AbiUnsupportedError";
}

/**
 * Refuse to run where a pointer is not a correct stand-in for a by-value aggregate and no shim can
 * supply one.
 *
 * Called once, before the first seam call. A loud refusal is the only honest option: on SysV the
 * failure mode is not a crash but garbage read from the stack, surfacing as a callback that never
 * fires or fires with a nonsense status — days of debugging pointed at the wrong layer.
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
 *      target. The build-time header oracle cannot do that for a platform the developer is not on.
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

  // Only meaningful against wgpu-native. Dawn has no wgpu-native generation, and the shim's number
  // says which *header shape* its `#[repr(C)]` structs match, not which library it is talking to —
  // so comparing it to `WGPU_NATIVE_MAJOR` under Dawn would refuse a correct pairing on a number
  // that does not apply. The `sizeof` agreement below holds under both, and is the property this
  // check was really protecting.
  const generation = Number(s.wgpu_bun_shim_target_generation());
  if (currentImpl() !== "dawn" && generation !== WGPU_NATIVE_MAJOR) {
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

  // The adapter. Both tables declare identical FFI signatures, so the forwarding is a rename, not a
  // conversion. `satisfies` on SHIM_TO_NATIVE is what stops the two drifting apart.
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
 * Every argument is a pointer to a buffer the caller already packed — exactly the signature the
 * compiled shim exposes, which is why adopting it changed this function's body and nothing else.
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
 * signature, correct on Win64 and nowhere else. The seam only binds `direct` on Win64, so that is
 * safe — safe because of the check in {@link seamStatus}, not by luck.
 *
 * Anything else means the shim is bound and its C trampolines own the by-value `WGPUStringView`
 * decoding, so the caller must use the **flat** signature.
 *
 * Calling this binds the seam, deliberately: callback shape and calling path are the same choice,
 * and making them separately is how they end up disagreeing.
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
