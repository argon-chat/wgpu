/**
 * Asynchronous completion: ticket identity, long-lived callbacks, and the pump.
 *
 * ══ 1. Userdata is a monotonic integer ticket. Never an address. Never a recycled buffer. ══
 *
 * This is the single most important decision in the package, and it is a direct response to how the
 * other Bun WebGPU binding fails. That binding hands the C side a **pooled `ArrayBuffer`, keyed by
 * object identity**, and releases it by looking the object up in a `Map`. Two failures follow from
 * that shape and only one of them is visible:
 *
 *   - a second release throws `"was not allocated from this allocator or already freed"` — the
 *     crash people actually see, and the *lucky* outcome;
 *   - blocks are **recycled**, so a late or duplicate native callback writes into a block that has
 *     since been handed to a different in-flight request. Silent cross-request corruption. No
 *     throw, no crash, just a wrong answer somewhere else.
 *
 * The root cause is using a *reused, address-identified, GC-owned object* as the correlation token.
 * Any scheme that gives C a pointer to something JavaScript manages has this bug latent in it.
 *
 * So: **the C side receives an integer that names nothing.** Why each property is load-bearing —
 *
 * | Property | What it makes impossible |
 * |---|---|
 * | an **integer**, not a pointer | C holds no reference to JS-owned memory, so there is nothing to keep alive across the call and nothing the GC can invalidate. Bun never promises that `ptr()` pins a buffer; treating it as unpinned is the only safe reading. |
 * | **monotonic, never reused** | the recycled-block corruption above. A stale callback can only ever name a ticket that is already gone, and "already gone" is the one state that is safe. |
 * | `Map.delete` **before** invoking the settler | double-settle *and* re-entrancy. wgpu-native fires callbacks synchronously, inside the very call that armed them, so the settler may issue another WebGPU call whose callback fires nested — by then the entry is gone and the nested dispatch cannot see it. |
 * | an unknown ticket **returns**, never throws | the exact crash above. A callback arriving after teardown is a *normal* condition, not an invariant violation. |
 * | `arm()` **before** the native call | measured: callbacks fire re-entrantly inside `wgpuInstanceRequestAdapter`, even with a callback mode that by spec forbids it. Registering afterwards is a race that loses on the first attempt. |
 *
 * Structurally there is no allocator here and nothing to free — the only resource is a `Map` entry,
 * and `delete` on an absent key is a no-op by language semantics rather than by our carefulness.
 * That is what "double-free is impossible" has to mean: not "we are careful", but "there is no
 * free".
 *
 * ══ 2. Async is polled, not awaited — and *whose* job the pump is ══
 *
 * Futures do not exist in this build. `wgpuInstanceWaitAny` is an `unimplemented!()` stub that
 * aborts the process, `WGPUFuture.id` is always 0, and timed waits report
 * `Unsupported timed WaitAny features specified`. The only mechanisms that make progress are
 * `wgpuInstanceProcessEvents` and `wgpuDevicePoll`.
 *
 * The pump belongs to **the await itself**, driven by the pending-ticket set. The alternatives were
 * considered and rejected:
 *
 *   - an internal `setInterval` — makes settle latency a race against a clock, keeps the event loop
 *     alive, and *decouples pumping from awaiting*, which is precisely the decoupling that produces
 *     a vacuously-empty error scope;
 *   - an explicit `device.poll()` the caller must remember — "correct only if the caller remembers"
 *     is how the silent-green failure gets written in the first place.
 *
 * **Validation errors are delivered only on poll.** That makes this more than an ergonomics
 * question: an error scope that resolves without having pumped reports *no error* for an operation
 * that genuinely failed, and a scope that recorded nothing satisfies every assertion built on it
 * vacuously. No type gate, no lint and no assertion count can see that — the test passes for the
 * same reason a test with no assertions passes. It is worse than a crash, because a crash is a bug
 * report and this is a false negative that hides other bugs behind it.
 *
 * {@link settle} therefore makes the guarantee structural rather than remembered:
 *
 * > **An async result is produced only by its native callback.** There is no timeout path, no
 * > iteration cap, no default value, no "resolve as success if nothing arrived". If the callback
 * > has not fired, the operation has not completed, and the promise stays pending.
 *
 * The designed failure mode is a **hang**, which a test runner's timeout catches and a human
 * notices. `popErrorScope()` goes through `settle()` like everything else, so it cannot physically
 * resolve before wgpu-native has delivered its verdict.
 *
 * ══ 3. One `JSCallback` per signature, for the life of the process ══
 *
 * Not one per call. A per-call `JSCallback` would reintroduce a lifetime problem in a new place —
 * exactly the thing part 1 exists to eliminate. `threadsafe` is deliberately off: wgpu-native's
 * callbacks are all `void` and fire on the calling thread inside the pump, and Bun's thread-safe
 * mode marshals asynchronously and requires the C side to ignore the return value.
 */

import { FFIType, JSCallback } from "bun:ffi";

import { readStringView } from "./strings.ts";
import { wgpu } from "./library.ts";
import { asAddress, type Ptr } from "./pointer.ts";

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
const CB_ARGS_HANDLE = [u32, ptr, ptr, u64, u64] as const; // status, handle, StringView*, ud1, ud2
const CB_ARGS_STATUS = [u32, ptr, u64, u64] as const; //       status, StringView*, ud1, ud2

/**
 * One long-lived `JSCallback` per C callback signature.
 *
 * Created lazily and never closed: they live exactly as long as the process, which is the only
 * lifetime that is definitely longer than any in-flight native operation. Closing one while
 * wgpu-native still holds the pointer would be a use-after-free in the other direction.
 */
class Callbacks {
  #requestAdapter?: JSCallback;
  #requestDevice?: JSCallback;
  #bufferMap?: JSCallback;
  #popErrorScope?: JSCallback;
  #workDone?: JSCallback;

  /** `(status, adapter, message, ud1, ud2)` */
  get requestAdapter(): JSCallback {
    return (this.#requestAdapter ??= new JSCallback(
      (status: number, handle: number, message: number, ud1: bigint) =>
        dispatch<IHandleResult>(Number(ud1), { status, handle: asAddress(handle ?? 0), message: readStringView(message) }),
      { args: CB_ARGS_HANDLE, returns: v },
    ));
  }

  /** `(status, device, message, ud1, ud2)` */
  get requestDevice(): JSCallback {
    return (this.#requestDevice ??= new JSCallback(
      (status: number, handle: number, message: number, ud1: bigint) =>
        dispatch<IHandleResult>(Number(ud1), { status, handle: asAddress(handle ?? 0), message: readStringView(message) }),
      { args: CB_ARGS_HANDLE, returns: v },
    ));
  }

  /** `(status, message, ud1, ud2)` */
  get bufferMap(): JSCallback {
    return (this.#bufferMap ??= new JSCallback(
      (status: number, message: number, ud1: bigint) =>
        dispatch<IStatusResult>(Number(ud1), { status, message: readStringView(message) }),
      { args: CB_ARGS_STATUS, returns: v },
    ));
  }

  /** `(status, errorType, message, ud1, ud2)` */
  get popErrorScope(): JSCallback {
    return (this.#popErrorScope ??= new JSCallback(
      (status: number, errorType: number, message: number, ud1: bigint) =>
        dispatch<IErrorScopeResult>(Number(ud1), { status, errorType, message: readStringView(message) }),
      { args: [u32, u32, ptr, u64, u64], returns: v },
    ));
  }

  /** `(status, message, ud1, ud2)` */
  get queueWorkDone(): JSCallback {
    return (this.#workDone ??= new JSCallback(
      (status: number, message: number, ud1: bigint) =>
        dispatch<IStatusResult>(Number(ud1), { status, message: readStringView(message) }),
      { args: CB_ARGS_STATUS, returns: v },
    ));
  }
}

export const callbacks = new Callbacks();

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
  if (device) wgpu().wgpuDevicePoll(device, wait ? 1 : 0, null);
}

/**
 * Yield so JS timers and microtasks can run between pumps.
 *
 * Microtasks for the first {@link MICROTASK_SPINS} iterations — wgpu-native's callbacks fire
 * synchronously inside the pump, so the common case settles in one or two turns and a macrotask
 * hop would add milliseconds to every await. After that, hand control to the macrotask queue: a
 * genuinely stuck operation must not starve the timer a test runner uses to notice the hang.
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
 * There is no exit from the wait other than the callback firing. That is the point.
 */
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

  for (let spin = 0; !done; spin++) {
    pump();
    await yieldTurn(spin);
  }
  return result;
}
