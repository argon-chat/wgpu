/**
 * Asynchronous completion: ticket identity, long-lived callbacks, and the pump.
 *
 * ══ 1. Userdata is a monotonic integer ticket. Never an address. Never a recycled buffer. ══
 *
 * The most important decision in the package, and a direct response to how the other Bun WebGPU
 * binding fails. That binding hands the C side a **pooled `ArrayBuffer`, keyed by object identity**,
 * and releases it by looking the object up in a `Map`. Two failures follow, only one visible:
 *
 *   - a second release throws `"was not allocated from this allocator or already freed"` — the
 *     crash people actually see, and the *lucky* outcome;
 *   - blocks are **recycled**, so a late or duplicate native callback writes into a block since
 *     handed to a different in-flight request. Silent cross-request corruption: no throw, no crash,
 *     just a wrong answer somewhere else.
 *
 * The root cause is a *reused, address-identified, GC-owned object* as the correlation token. Any
 * scheme that gives C a pointer to something JavaScript manages has this bug latent in it. So:
 * **the C side receives an integer that names nothing.** Each property is load-bearing —
 *
 * | Property | What it makes impossible |
 * |---|---|
 * | an **integer**, not a pointer | C holds no reference to JS-owned memory, so there is nothing to keep alive across the call and nothing the GC can invalidate. Bun never promises that `ptr()` pins a buffer; treating it as unpinned is the only safe reading. |
 * | **monotonic, never reused** | the recycled-block corruption above. A stale callback can only name a ticket that is already gone, and "already gone" is the one state that is safe. |
 * | `Map.delete` **before** invoking the settler | double-settle *and* re-entrancy. wgpu-native fires callbacks synchronously, inside the very call that armed them, so the settler may issue another WebGPU call whose callback fires nested — by then the entry is gone and the nested dispatch cannot see it. |
 * | an unknown ticket **returns**, never throws | the exact crash above. A callback arriving after teardown is a *normal* condition, not an invariant violation. |
 * | `arm()` **before** the native call | measured: callbacks fire re-entrantly inside `wgpuInstanceRequestAdapter`, even with a callback mode that by spec forbids it. Registering afterwards is a race that loses on the first attempt. |
 *
 * There is no allocator here and nothing to free — the only resource is a `Map` entry, and `delete`
 * on an absent key is a no-op by language semantics rather than by our carefulness. "Double-free is
 * impossible" means "there is no free", not "we are careful".
 *
 * ══ 2. Async is polled, not awaited — and *whose* job the pump is ══
 *
 * Futures do not exist in this build. `wgpuInstanceWaitAny` is an `unimplemented!()` stub that
 * aborts the process, `WGPUFuture.id` is always 0, and timed waits report
 * `Unsupported timed WaitAny features specified`. Only `wgpuInstanceProcessEvents` and
 * `wgpuDevicePoll` make progress.
 *
 * The pump belongs to **the await itself**, driven by the pending-ticket set. Rejected alternatives:
 *
 *   - an internal `setInterval` — makes settle latency a race against a clock, keeps the event loop
 *     alive, and *decouples pumping from awaiting*, which is exactly what produces a
 *     vacuously-empty error scope;
 *   - an explicit `device.poll()` the caller must remember — "correct only if the caller remembers"
 *     is how the silent-green failure gets written in the first place.
 *
 * **Validation errors are delivered only on poll**, so this is not an ergonomics question: a scope
 * that resolves without having pumped reports *no error* for an operation that genuinely failed, and
 * a scope that recorded nothing satisfies every assertion built on it vacuously. No type gate, lint
 * or assertion count can see that — the test passes for the same reason a test with no assertions
 * passes. {@link settle} therefore makes the guarantee structural rather than remembered:
 *
 * > **An async result is produced only by its native callback.** No default value, no sentinel, no
 * > "resolve as success if nothing arrived". If the callback has not fired, the operation has not
 * > completed. `popErrorScope()` goes through `settle()` like everything else, so it cannot
 * > physically resolve before wgpu-native has delivered its verdict.
 *
 * There **is** a deadline, and after it expires `settle` *throws* — it does not resolve, so it still
 * invents nothing. An earlier revision had none, on the reasoning that a hang is the honest failure
 * and a test runner's timeout would catch it. The first CI run to reach this code on AArch64 sat
 * inside `requestAdapter` until the job's own limit, produced no diagnosis, and burned a runner. A
 * hang does not say *which* call stalled, and on an unattended machine it looks like slow work.
 *
 * ══ 3. One `JSCallback` per signature, for the life of the process ══
 *
 * Not one per call: a per-call `JSCallback` would reintroduce the lifetime problem part 1 exists to
 * eliminate. `threadsafe` is deliberately off — wgpu-native's callbacks are all `void` and fire on
 * the calling thread inside the pump, while Bun's thread-safe mode marshals asynchronously and
 * requires the C side to ignore the return value.
 */

import { FFIType, JSCallback } from "bun:ffi";
import { currentImpl } from "../impl.ts";

import { callbackTrampolines, seamBoundMode as boundMode, seamStatus, type CallbackSlot } from "./abiSeam.ts";
import { decodeStringParts, readStringView } from "./strings.ts";
import { wgpu } from "./library.ts";
import { asAddress, type Ptr } from "./pointer.ts";

export type { CallbackSlot } from "./abiSeam.ts";

/** A correlation token. Opaque to callers; meaningful only to this module. */
export type Ticket = number;

/**
 * Monotonic. Starts at 1 so that a zeroed `userdata1` — the state of any buffer nobody filled in —
 * can never collide with a live ticket.
 */
let nextTicket: Ticket = 1;

const pending = new Map<Ticket, (result: never) => void>();

/**
 * Register a settler and get the ticket to hand to C.
 *
 * Must be called **before** the native call that will fire the callback.
 */
export function arm<T>(settle: (result: T) => void): Ticket {
  const ticket = nextTicket++;
  pending.set(ticket, settle as (result: never) => void);
  return ticket;
}

/**
 * Deliver a result to whoever armed this ticket.
 *
 * An unknown ticket is ignored, by design: a callback arriving after teardown, or a second delivery
 * for the same operation, is a normal thing for a C library to do and must not be an exception.
 */
export function dispatch<T>(ticket: Ticket, result: T): void {
  const settle = pending.get(ticket);
  if (!settle) return;
  pending.delete(ticket); // freed exactly once, and BEFORE user code can run re-entrantly
  (settle as (r: T) => void)(result);
}

/** Drop a ticket whose native call never happened (the call threw before handing it over). */
export function disarm(ticket: Ticket): void {
  pending.delete(ticket);
}

/** How many operations are still waiting on a native callback. Diagnostics only. */
export function pendingOperations(): number {
  return pending.size;
}

// ── result shapes ────────────────────────────────────────────────────────────────────────────

export interface IStatusResult { status: number; message: string }
export interface IHandleResult extends IStatusResult { handle: Ptr }
export interface IErrorScopeResult extends IStatusResult { errorType: number }

const { ptr, u32, u64, void: v } = FFIType;

/**
 * ══ Two callback shapes, because `WGPUStringView message` is passed BY VALUE ══
 *
 * Every wgpu-native callback receives `message` as a 16-byte `{char const*, size_t}` **by value**,
 * and the ABIs disagree about what that means in a way that does **not** match the split for the
 * 40-byte `*CallbackInfo` argument:
 *
 * | | Win64 | AArch64 AAPCS | SysV x86-64 |
 * |---|---|---|---|
 * | 40-byte aggregate | hidden reference | indirect (>16 B) | **stack** |
 * | **16-byte aggregate** | **hidden reference** | **two registers** | **two registers** |
 *
 * For the 40-byte case SysV is the outlier. For the 16-byte case **Win64 is the outlier and the
 * other three agree.** Declaring `message` as a single pointer — the {@link POINTER_FORM} below — is
 * therefore correct on Windows and wrong on `linux-x64`, `linux-arm64` and `darwin-arm64`, where the
 * callee reads `ud1` out of the register holding `message.length`. That shipped once and hung inside
 * `requestAdapter` on all three; `src/ffi/abiSeam.ts` has the full account.
 *
 * So the shape is no longer chosen by reasoning, but by *who is decoding the aggregate*:
 *
 *   - **{@link FLAT_FORM}** — `(…, msgData, msgLen, ud1, ud2)`. Used whenever the shim is bound. The
 *     shim's C trampolines take the aggregate with its real prototype and split it, so the compiler
 *     on the target applies the target's rules and this side only ever sees primitives.
 *   - **{@link POINTER_FORM}** — `(…, StringView*, ud1, ud2)`. Used only on the direct path, which
 *     `src/ffi/abiSeam.ts` now binds on **Win64 only** for precisely this reason.
 */

/**
 * ══ Every `JSCallback` in this package is constructed here ══
 *
 * A containment boundary, not a style preference. Choosing a callback's argument shape *is*
 * answering an ABI question, and that question has been got wrong twice, both times at a site a
 * previous sweep did not cover: the second pair (`uncapturedError`, `deviceLost`) lived in
 * `src/api/device.ts`, next to the state they need, invisible to a search of the seam. So the state
 * comes to the callback instead: modules register a **handler** — plain JavaScript, no FFI types, no
 * ABI decisions — and this module owns the one place a C signature is declared.
 * `test/abi-seam.test.ts` asserts `src/` contains no other `new JSCallback`, which makes "there is
 * no third site" a checked property rather than a claim.
 */

/** A device-scoped native callback, after this module has decoded it. */
export type DeviceCallbackHandler = (deviceId: number, code: number, message: string) => void;

const deviceHandlers = new Map<"uncapturedError" | "deviceLost", DeviceCallbackHandler>();

/**
 * Register what to do when a device-scoped native callback arrives.
 *
 * Must be registered before a device is created, which is trivially true: `src/api/device.ts` does
 * it at module scope, and nothing can create a device without importing that module.
 */
export function setDeviceCallbackHandler(
  slot: "uncapturedError" | "deviceLost",
  handler: DeviceCallbackHandler,
): void {
  deviceHandlers.set(slot, handler);
}

let unmatchedDeviceCallbacks = 0;

/**
 * Route a decoded device callback, and notice when it matches nothing.
 *
 * The `?.`-style miss is how the last ABI defect stayed invisible: an id naming no live device is
 * *safe* — it must be, a callback can arrive after teardown — and safety here reads exactly like
 * correctness. So misses are counted and reported once. A handful after `destroy()` is ordinary; one
 * on the very first uncaptured error is the signature of an argument shift.
 *
 * Never throws: this frame returns into Rust across a `nounwind` boundary, where an exception is
 * undefined behaviour rather than a stack trace.
 */
function routeDeviceCallback(
  slot: "uncapturedError" | "deviceLost",
  deviceId: number,
  code: number,
  message: string,
): void {
  try {
    const handler = deviceHandlers.get(slot);
    if (!handler) return;
    handler(deviceId, code, message);
  } catch {
    /* swallowed on purpose — see above */
  }
}

/** Count a device callback that named no live device, and say so the first time. */
export function noteUnmatchedDeviceCallback(slot: string, deviceId: number): void {
  unmatchedDeviceCallbacks++;
  if (unmatchedDeviceCallbacks !== 1) return;
  console.error(
    `wgpu-bun: a ${slot} callback named device id ${deviceId}, which is not live.\n` +
      `  After device.destroy() that is ordinary. Before it, it means the callback's arguments were\n` +
      `  decoded under the wrong ABI rule — the id is being read out of a neighbouring register — and\n` +
      `  the error it carried has been lost.\n` +
      `  seam: resolved=${seamStatus().mode} bound=${boundMode() ?? "(not bound)"}`,
  );
}

/** How many device callbacks named no live device. Diagnostics only. */
export function unmatchedDeviceCallbackCount(): number {
  return unmatchedDeviceCallbacks;
}

/** Flat: `(status, handle, msgData, msgLen, ud1, ud2)` — correct on every ABI, via the shim. */
const FLAT_ARGS_HANDLE = [u32, ptr, ptr, u64, u64, u64] as const;
/** Flat: `(status, msgData, msgLen, ud1, ud2)`. */
const FLAT_ARGS_STATUS = [u32, ptr, u64, u64, u64] as const;
/** Flat: `(status, errorType, msgData, msgLen, ud1, ud2)`. */
const FLAT_ARGS_ERROR_SCOPE = [u32, u32, ptr, u64, u64, u64] as const;

/** Pointer form: `(status, handle, StringView*, ud1, ud2)` — Win64 only. */
const PTR_ARGS_HANDLE = [u32, ptr, ptr, u64, u64] as const;
/** Pointer form: `(status, StringView*, ud1, ud2)` — Win64 only. */
const PTR_ARGS_STATUS = [u32, ptr, u64, u64] as const;
/** Pointer form: `(status, errorType, StringView*, ud1, ud2)` — Win64 only. */
const PTR_ARGS_ERROR_SCOPE = [u32, u32, ptr, u64, u64] as const;
/** Flat: `(device*, code, msgData, msgLen, ud1, ud2)` — the device-scoped pair. */
const FLAT_ARGS_DEVICE = [ptr, u32, ptr, u64, u64, u64] as const;
/** Pointer form: `(device*, code, StringView*, ud1, ud2)` — Win64 only. */
const PTR_ARGS_DEVICE = [ptr, u32, ptr, u64, u64] as const;

/**
 * The flat callbacks, matching the shim's trampoline prototypes.
 *
 * Built lazily and never closed: process lifetime is the only lifetime definitely longer than any
 * in-flight native operation. Closing one while wgpu-native still holds the pointer would be a
 * use-after-free in the other direction.
 */
const FLAT_FORM: Record<CallbackSlot, () => JSCallback> = {
  requestAdapter: () =>
    new JSCallback(
      (status: number, handle: number, data: number, len: bigint, ud1: bigint) =>
        dispatch<IHandleResult>(Number(ud1), {
          status,
          handle: asAddress(handle ?? 0),
          message: decodeStringParts(data, len),
        }),
      { args: FLAT_ARGS_HANDLE, returns: v },
    ),
  requestDevice: () =>
    new JSCallback(
      (status: number, handle: number, data: number, len: bigint, ud1: bigint) =>
        dispatch<IHandleResult>(Number(ud1), {
          status,
          handle: asAddress(handle ?? 0),
          message: decodeStringParts(data, len),
        }),
      { args: FLAT_ARGS_HANDLE, returns: v },
    ),
  bufferMap: () =>
    new JSCallback(
      (status: number, data: number, len: bigint, ud1: bigint) =>
        dispatch<IStatusResult>(Number(ud1), { status, message: decodeStringParts(data, len) }),
      { args: FLAT_ARGS_STATUS, returns: v },
    ),
  popErrorScope: () =>
    new JSCallback(
      (status: number, errorType: number, data: number, len: bigint, ud1: bigint) =>
        dispatch<IErrorScopeResult>(Number(ud1), {
          status,
          errorType,
          message: decodeStringParts(data, len),
        }),
      { args: FLAT_ARGS_ERROR_SCOPE, returns: v },
    ),
  queueWorkDone: () =>
    new JSCallback(
      (status: number, data: number, len: bigint, ud1: bigint) =>
        dispatch<IStatusResult>(Number(ud1), { status, message: decodeStringParts(data, len) }),
      { args: FLAT_ARGS_STATUS, returns: v },
    ),
  uncapturedError: () =>
    new JSCallback(
      (_device: number, errorType: number, data: number, len: bigint, ud1: bigint) =>
        routeDeviceCallback("uncapturedError", Number(ud1), errorType, decodeStringParts(data, len)),
      { args: FLAT_ARGS_DEVICE, returns: v },
    ),
  deviceLost: () =>
    new JSCallback(
      (_device: number, reason: number, data: number, len: bigint, ud1: bigint) =>
        routeDeviceCallback("deviceLost", Number(ud1), reason, decodeStringParts(data, len)),
      { args: FLAT_ARGS_DEVICE, returns: v },
    ),
};

/** The pointer-form callbacks. Correct on Win64, which is the only place the seam binds `direct`. */
const POINTER_FORM: Record<CallbackSlot, () => JSCallback> = {
  requestAdapter: () =>
    new JSCallback(
      (status: number, handle: number, message: number, ud1: bigint) =>
        dispatch<IHandleResult>(Number(ud1), {
          status,
          handle: asAddress(handle ?? 0),
          message: readStringView(message),
        }),
      { args: PTR_ARGS_HANDLE, returns: v },
    ),
  requestDevice: () =>
    new JSCallback(
      (status: number, handle: number, message: number, ud1: bigint) =>
        dispatch<IHandleResult>(Number(ud1), {
          status,
          handle: asAddress(handle ?? 0),
          message: readStringView(message),
        }),
      { args: PTR_ARGS_HANDLE, returns: v },
    ),
  bufferMap: () =>
    new JSCallback(
      (status: number, message: number, ud1: bigint) =>
        dispatch<IStatusResult>(Number(ud1), { status, message: readStringView(message) }),
      { args: PTR_ARGS_STATUS, returns: v },
    ),
  popErrorScope: () =>
    new JSCallback(
      (status: number, errorType: number, message: number, ud1: bigint) =>
        dispatch<IErrorScopeResult>(Number(ud1), { status, errorType, message: readStringView(message) }),
      { args: PTR_ARGS_ERROR_SCOPE, returns: v },
    ),
  queueWorkDone: () =>
    new JSCallback(
      (status: number, message: number, ud1: bigint) =>
        dispatch<IStatusResult>(Number(ud1), { status, message: readStringView(message) }),
      { args: PTR_ARGS_STATUS, returns: v },
    ),
  uncapturedError: () =>
    new JSCallback(
      (_device: number, errorType: number, message: number, ud1: bigint) =>
        routeDeviceCallback("uncapturedError", Number(ud1), errorType, readStringView(message)),
      { args: PTR_ARGS_DEVICE, returns: v },
    ),
  deviceLost: () =>
    new JSCallback(
      (_device: number, reason: number, message: number, ud1: bigint) =>
        routeDeviceCallback("deviceLost", Number(ud1), reason, readStringView(message)),
      { args: PTR_ARGS_DEVICE, returns: v },
    ),
};

/** Kept alive for the process. The map is the only reference; nothing ever removes an entry. */
const liveCallbacks = new Map<CallbackSlot, JSCallback>();
const installedAddress = new Map<CallbackSlot, number>();

/**
 * The address to write into `WGPUCallbackInfo.callback` for a given operation.
 *
 * Single entry point on purpose: callback *shape* and calling *path* are one decision. The previous
 * arrangement — a `callbacks.requestAdapter` property that knew nothing about the seam — is what
 * allowed one shape to be used on four ABIs.
 */
export function callbackAddress(slot: CallbackSlot): number {
  const cached = installedAddress.get(slot);
  if (cached !== undefined) return cached;

  const trampolines = callbackTrampolines();
  const jsCallback = (trampolines ? FLAT_FORM : POINTER_FORM)[slot]();
  liveCallbacks.set(slot, jsCallback);

  let address: number;
  if (trampolines) {
    // wgpu-native calls the shim's C trampoline; the trampoline calls this flat JS function. The
    // by-value aggregate is decoded in between, by a compiler that knows the target.
    trampolines.install(slot, Number(jsCallback.ptr));
    address = trampolines.address(slot);
  } else {
    address = Number(jsCallback.ptr);
  }
  installedAddress.set(slot, address);
  return address;
}

// ── the pump ─────────────────────────────────────────────────────────────────────────────────

/** Non-blocking drain of an instance's ready callbacks. */
export function processEvents(instance: Ptr): void {
  if (instance) wgpu().wgpuInstanceProcessEvents(instance);
}

/**
 * `wgpu.h`'s device poll. With `wait = true` it blocks until the submission queue drains, which is
 * what makes a synchronous readback tractable; it returns immediately when the queue is empty.
 */
export function devicePoll(device: Ptr, wait: boolean): void {
  // Dawn has no device poll — the entry point does not exist in its C API. Its equivalent is
  // `wgpuInstanceProcessEvents`, which every call site here already calls on the next line, so this
  // is a no-op rather than an emulation: delivery happens in `processEvents` and waiting happens in
  // the caller's spin, as it did under wgpu-native whenever the blocking form was unavailable.
  if (currentImpl() === "dawn") return;
  if (device) wgpu().wgpuDevicePoll(device, wait ? 1 : 0, null);
}

/**
 * Yield so JS timers and microtasks can run between pumps.
 *
 * Microtasks for the first {@link MICROTASK_SPINS} iterations — wgpu-native's callbacks fire
 * synchronously inside the pump, so the common case settles in one or two turns and a macrotask hop
 * would add milliseconds to every await. After that, the macrotask queue: a genuinely stuck
 * operation must not starve the timer a test runner uses to notice the hang.
 */
const MICROTASK_SPINS = 64;
function yieldTurn(spin: number): Promise<void> {
  return spin < MICROTASK_SPINS
    ? Promise.resolve()
    : new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Run an asynchronous wgpu-native operation to completion.
 *
 * @param pump   what to call each turn to give wgpu-native a chance to deliver.
 * @param begin  issues the native call, having been handed the ticket to embed in `userdata1`.
 *
 * The only way to a RESULT is the callback firing — no default, no sentinel, no "assume success
 * after N turns". That is what keeps an unpumped operation from reporting "no error" for a case that
 * genuinely failed. The deadline throws rather than resolving, so it still invents nothing; see the
 * module header for why a plain hang was not good enough.
 */
const SETTLE_DEADLINE_MS = 30_000;

/**
 * A native operation was issued and its callback never arrived.
 *
 * Its own class, for the same reason `AbiUnsupportedError` is: **"the callback never came" and "this
 * machine has no GPU" are different facts**, and the test gate previously filed this one under
 * `no-adapter` — wrong twice over, because the adapter was present and enumerable on every runner
 * that hit it, and because `no-adapter` is *escapable* by an environment variable two CI legs are
 * granted, so a genuine completion defect could be skipped past in silence on the legs most likely
 * to have it. The cause turned out to be the ABI defect above, but the *category* stays separate: a
 * driver that never answers produces the identical symptom.
 */
export class CallbackDeadlineError extends Error {
  override readonly name = "CallbackDeadlineError";
}

export async function settle<T>(pump: () => void, begin: (ticket: Ticket) => void): Promise<T> {
  let done = false;
  let result!: T;

  const ticket = arm<T>((r) => { result = r; done = true; });
  try {
    begin(ticket); // may fire the callback re-entrantly — already safe, the ticket is registered
  } catch (error) {
    disarm(ticket);
    throw error;
  }

  const startedAt = performance.now();
  for (let spin = 0; !done; spin++) {
    pump();
    await yieldTurn(spin);
    if (!done && performance.now() - startedAt > SETTLE_DEADLINE_MS) {
      disarm(ticket);
      const status = seamStatus();
      throw new CallbackDeadlineError(
        `wgpu-bun: a native asynchronous call did not complete within ${SETTLE_DEADLINE_MS} ms ` +
          `(${spin + 1} pump turns on ${process.platform}-${process.arch}).\n` +
          `  The operation was issued and its callback never fired.\n\n` +
          `  seam: requested=${process.env["WGPU_BUN_SEAM"] ?? "auto"} resolved=${status.mode} ` +
          `bound=${boundMode() ?? "(not bound)"}\n` +
          `  shim: ${status.shim ? `${status.shim.path} (${status.shim.version ?? "unstamped"}, via ${status.shim.source})` : "none installed"}\n` +
          `  ${status.reason}\n\n` +
          `  Two causes produce this exactly alike, so the line above is printed rather than left to\n` +
          `  be inferred:\n` +
          `    1. A driver or adapter that never answers. wgpu-native delivers only on poll, and a\n` +
          `       device that never completes looks identical to slow work.\n` +
          `    2. A callback whose ARGUMENTS are mis-decoded, so the correlation ticket arrives as\n` +
          `       garbage and the delivery is silently ignored as an unknown ticket. This is what a\n` +
          `       by-value WGPUStringView passed under the wrong ABI rule looks like, and it is why\n` +
          `       the callback shape is chosen by which seam path is bound (src/ffi/async.ts) rather\n` +
          `       than assumed. If \`bound\` above is \`direct\` on anything other than win32-x64, that\n` +
          `       is the cause and it is a bug in the seam, not in the driver.`,
      );
    }
  }
  return result;
}
