/**
 * Errors, error scopes, and the uncaptured-error callback.
 *
 * ══ The uncaptured-error callback is a precondition, not a feature ══
 *
 * The shipped `wgpu_native.dll` carries the string
 * `Handling wgpu uncaptured errors as fatal by default`. A device created without an
 * `uncapturedErrorCallbackInfo` installs a default handler that **panics**, and the panic crosses a
 * `nounwind` boundary and is escalated to `abort`. So the *first ordinary validation error anywhere*
 * kills the process — no exception, no JS stack, no partial results, and every other suite sharing
 * that process dies with it. There is no post-hoc setter, so there is no window in which it is safe
 * to be missing: it must be in the `WGPUDeviceDescriptor` at creation, and {@link ./device.ts} does
 * that unconditionally.
 *
 * ⚠ The callback itself must never throw. A JS exception propagating back into Rust is undefined
 * behaviour, and would turn the mechanism that prevents aborts into another cause of them.
 * Everything here collects and reports.
 *
 * ══ Error scopes are the assertion, so they must not be able to lie ══
 *
 * In the corpus this package targets, `await device.popErrorScope()` *is* the test, and the common
 * case is the **empty** scope that must come back falsy. Two failure modes matter:
 *
 *   - a scope that crashes on the empty path takes the process down mid-suite with no attribution
 *     (this is what the pooled-userdata binding does);
 *   - a scope that accepts the call and never records anything makes every assertion built on it
 *     pass **vacuously**. No type gate, lint or assertion count can see that.
 *
 * Both are addressed structurally: the pop goes through the polled `settle()` path, so it cannot
 * resolve before wgpu-native has delivered a verdict, and the result only ever comes from the native
 * callback.
 *
 * ══ The shadow stack ══
 *
 * `getCompilationInfo` is an `unimplemented!()` stub in this build, so shader diagnostics are
 * recovered by wrapping `createShaderModule` in an *internal* error scope. Scopes nest, so an
 * internal scope opened inside a caller's scope would swallow the error the caller was waiting for.
 * {@link ErrorScopeStack} closes that: each JS-side entry carries a `shadow` slot, an internal
 * scope's capture is deposited in the innermost matching caller entry, and `popErrorScope()` returns
 * the native result *or* the shadow. The caller sees its error, the shader module gets diagnostics.
 */

import { C } from "../enums.ts";

/** Base class for the WebGPU error hierarchy. Matches the shape callers read: `.message`. */
export class GPUError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

export class GPUValidationError extends GPUError {}
export class GPUOutOfMemoryError extends GPUError {}
export class GPUInternalError extends GPUError {}

/** An error that carries no useful classification — reported rather than guessed at. */
export class GPUUnknownError extends GPUError {}

/** Build the right error subclass for a `WGPUErrorType`. */
export function errorFor(errorType: number, message: string): GPUError | null {
  switch (errorType) {
    case C.errorType.noError:
      return null;
    case C.errorType.validation:
      return new GPUValidationError(message);
    case C.errorType.outOfMemory:
      return new GPUOutOfMemoryError(message);
    case C.errorType.internal:
      return new GPUInternalError(message);
    default:
      return new GPUUnknownError(message);
  }
}

/** `GPUUncapturedErrorEvent`, minus the DOM `Event` machinery nothing here has. */
export class GPUUncapturedErrorEvent {
  readonly type = "uncapturederror";
  readonly error: GPUError;
  constructor(error: GPUError) {
    this.error = error;
  }
}

/** One entry on the JS-side mirror of the native error-scope stack. */
interface IScopeEntry {
  readonly filter: GPUErrorFilter;
  /** An error captured by an internal scope nested inside this one, if any. */
  shadow: GPUError | null;
}

/**
 * A JS-side mirror of the native scope stack, existing only to make internal scopes transparent.
 *
 * It never replaces the native scopes — wgpu-native still does the capturing. It records only what
 * the native side cannot: that an error which *would* have reached a caller's scope was intercepted.
 */
export class ErrorScopeStack {
  readonly #entries: IScopeEntry[] = [];

  push(filter: GPUErrorFilter): void {
    this.#entries.push({ filter, shadow: null });
  }

  /**
   * Pop the JS mirror. Returns any error deposited by a nested internal scope.
   *
   * Returns `undefined` when there was no matching entry — a caller popping more scopes than it
   * pushed. ⚠ That case no longer reaches here: `GPUDevice.popErrorScope` refuses an empty stack up
   * front, because the native call **aborts the process** on it (an `Option::unwrap()` on `None`
   * inside wgpu-native, non-unwinding across the C ABI). The native side does *not* report it.
   */
  pop(): GPUError | null | undefined {
    const entry = this.#entries.pop();
    return entry ? entry.shadow : undefined;
  }

  /** `true` while a caller has a scope open — the condition that makes interception observable. */
  get depth(): number {
    return this.#entries.length;
  }

  /**
   * Hand an intercepted error to the innermost caller scope that would have caught it.
   *
   * Filters are honoured: an internal scope's validation error must not surface from a caller's
   * `'out-of-memory'` scope. If no entry matches, the error was never the caller's to see and is
   * dropped here.
   */
  deposit(error: GPUError): void {
    const filter = filterFor(error);
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i]!;
      if (entry.filter === filter) {
        entry.shadow ??= error;
        return;
      }
    }
  }
}

function filterFor(error: GPUError): GPUErrorFilter {
  if (error instanceof GPUOutOfMemoryError) return "out-of-memory";
  if (error instanceof GPUInternalError) return "internal";
  return "validation";
}
