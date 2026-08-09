/**
 * wgpu-bun — a Bun FFI binding to wgpu-native, shaped like the reference `webgpu` npm package.
 *
 * Swapping the two is an import-specifier change and nothing else:
 *
 * ```ts
 * import { create, globals } from "wgpu-bun";   // instead of "webgpu"
 * Object.assign(globalThis, globals);
 * const gpu = create([]);
 * ```
 *
 * ── Two things worth knowing before the first call ──────────────────────────────────────────────
 *
 * **The backend is stated, not inherited.** On a machine with more than one GPU or more than one
 * usable backend, "whatever the driver picks" is a correctness decision in disguise: feature
 * availability here is backend-dependent (`shader-f16` is present on Vulkan and absent on D3D12 for
 * the *same* adapter), and a power preference can change vendor outright. The default is per-host
 * and documented in `src/api/gpu.ts`; override with `create(["backend=vulkan"])`, the
 * `WGPU_BUN_BACKEND` environment variable, or `requestAdapter({ backendType })`. The chosen adapter
 * is logged once at device creation unless `quiet` is requested.
 *
 * **Async completes on poll, and every async operation polls for itself.** Futures do not exist in
 * this build of wgpu-native, so nothing settles unless something pumps. Making that the caller's
 * job would be a trap: validation errors are also delivered on poll, so an error scope popped
 * without pumping reports "no error" for an operation that genuinely failed — and a scope that
 * recorded nothing satisfies every assertion built on it vacuously. `device.poll()` is exposed for
 * callers running their own frame loop, but nothing here depends on anyone calling it.
 */

import { createInstance } from "./binding.ts";
import { WGPU_NATIVE_MAJOR, WGPU_NATIVE_TAG } from "../wgpu-native.manifest.ts";
import type { CreateOptions } from "./types.ts";
import type { GPUEntryPoint } from "./types.ts";

export {
  LIB_ENV_VAR,
  NPM_SCOPE,
  SHIM_ENV_VAR,
  resolveNativeLibrary,
  tryResolveNativeLibrary,
  tryResolveShimLibrary,
} from "./resolve.ts";
export { NotImplementedError, createInstance } from "./binding.ts";
export { globals, installNavigatorGpu } from "./globals.ts";
export { nativeLibrary, nativeVersion, type INativeVersion } from "./ffi/library.ts";
export {
  CallbackDeadlineError,
  pendingOperations,
  unmatchedDeviceCallbackCount,
} from "./ffi/async.ts";
export {
  FIRST_GENERATION,
  UNIMPLEMENTED,
  existsInGeneration,
  isUnimplemented,
  type IGenerationBoundSymbol,
} from "./ffi/unimplemented.ts";
export {
  AbiUnsupportedError,
  BY_VALUE_CALLBACK_INFO_FUNCTIONS,
  BY_VALUE_FUNCTIONS,
  seamBoundMode,
  seamStatus,
  type ISeamStatus,
  type SeamMode,
} from "./ffi/abiSeam.ts";
export {
  SHIM_ABI_VERSION,
  SHIM_VERSION,
  abiExpressesByValueAggregates,
  abiPassesLargeAggregatesByReference,
  abiPassesStringViewByReference,
  shimFileName,
  shimIsRequired,
} from "../shim.manifest.ts";
export type {
  CreateOptions,
  GPUEntryPoint,
  IResolvedNativeLibrary,
  IWebGPUGlobals,
  NativeLibrarySource,
} from "./types.ts";
export {
  DEFAULT_GENERATION,
  GENERATIONS,
  SUPPORTED_GENERATIONS,
  WGPU_NATIVE_MAJOR,
  WGPU_NATIVE_TAG,
  generation,
  type IGeneration,
} from "../wgpu-native.manifest.ts";

/**
 * Create the `GPU` entry point (the `navigator.gpu` equivalent).
 *
 * Extra positional arguments are accepted and ignored. That is not defensiveness for its own sake:
 * real callers pass them — `create([], "")` occurs in the wild — and a stricter signature would
 * break those callers on line 1, before anything useful had happened.
 */
export function create(options?: CreateOptions, ..._ignored: unknown[]): GPUEntryPoint {
  // The one place the compatibility claim is asserted rather than derived. `GPU` here implements
  // the part of the `@webgpu/types` surface this package covers (see the README for what it does
  // not), and stating that once at the boundary is better than a cast at every consumer call site.
  return createInstance(options) as unknown as GPUEntryPoint;
}

/**
 * `true` on macOS.
 *
 * Present because the reference package exports it from its entry point (though not from its type
 * declaration), and compatibility means matching what callers can actually reach.
 */
export const isMac: boolean = process.platform === "darwin";

/** Machine-readable status, so a caller can branch on it instead of catching a throw. */
export const IMPLEMENTED = true;

/** Human-readable one-liner for logs and error reports. */
export const STATUS = `wgpu-bun · wgpu-native ${WGPU_NATIVE_TAG} (generation ${WGPU_NATIVE_MAJOR})`;
