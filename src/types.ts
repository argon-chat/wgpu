/**
 * The compatibility surface.
 *
 * This package's contract is not "some WebGPU API" — it is *drop-in replaceability for the `webgpu`
 * npm package* (`webgpu@0.3.8`, dawn-gpu/node-webgpu). That package's entire public surface is three
 * exports, which is why the compat claim is cheap to make and cheap to keep honest:
 *
 *     export declare function create(options: string[]): GPU;
 *     export declare const globals: Object;
 *     export declare const isMac: boolean;         // present in index.js, absent from its types.d.ts
 *
 * Everything else a caller touches is standard `@webgpu/types` — `GPU`, `GPUDevice`, `GPUBuffer`, …
 * So the job is: return objects that satisfy `@webgpu/types` and behave like a real implementation.
 *
 * Types only. No runtime code lives here.
 */

/**
 * Instance-creation options, passed through to wgpu-native.
 *
 * node-webgpu forwards these to Dawn as toggle strings (`"enable-dawn-features=..."`, `"verbose"`,
 * …). **wgpu-native has no toggle system**, so string-for-string parity is impossible and pretending
 * otherwise would be the first lie in the compat claim. The intended behaviour is: recognise the
 * handful of toggles that map onto a wgpu-native instance/adapter setting, and ignore the rest
 * rather than throwing — an unknown toggle must never be the reason a program fails to boot.
 *
 * Note also that real callers pass an extra trailing argument (`create([], '')`) that the upstream
 * type declaration does not mention, so the entry point tolerates extra positional arguments.
 */
export type CreateOptions = readonly string[];

/**
 * The globals bag that callers splat onto `globalThis`:
 *
 *     Object.assign(globalThis, globals);
 *
 * Upstream ships 42 constructor functions here. Only FIVE of them are ever read as values in
 * practice — `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`, `GPUMapMode`, `GPUColorWrite` —
 * and those are non-negotiable, because WebGPU code references them unqualified. The remaining
 * ~37 (`GPUDevice`, `GPUBuffer`, `GPUAdapter`, …, plus the error classes `GPUValidationError`,
 * `GPUOutOfMemoryError`, `GPUPipelineError`) exist for `instanceof` and error-class identity.
 *
 * `navigator.gpu` is NOT part of upstream's bag — callers hand-build that shim themselves. Providing
 * it here is a cheap nicety worth offering.
 *
 * Typed as an index signature rather than a hand-written roster on purpose: a partially-filled
 * roster would typecheck while failing at runtime, which is the wrong direction for a compat claim
 * to fail in.
 */
export interface IWebGPUGlobals {
  readonly [name: string]: unknown;
}

/**
 * What `create()` returns — the standard `navigator.gpu` entry point from `@webgpu/types`.
 *
 * Declared as a named alias rather than used inline so that the one place the compat claim is made
 * is greppable.
 */
export type GPUEntryPoint = GPU;

/**
 * Where the native library came from, for diagnostics.
 *
 * Reported by {@link import("./resolve.ts").resolveNativeLibrary} so a confusing "wrong wgpu"
 * failure is one log line away from an answer, rather than a filesystem archaeology session.
 */
export type NativeLibrarySource =
  /** `WGPU_NATIVE_LIB` env var — an explicit absolute path, wins over everything. */
  | "env"
  /** A per-platform npm sub-package (`@wgpu-bun/<rid>`), if one is installed. */
  | "npm"
  /** `vendor/<rid>/lib/…`, produced by `scripts/fetch-wgpu-native.ts`. */
  | "vendor";

/** A located wgpu-native shared library. */
export interface IResolvedNativeLibrary {
  /** Absolute path to the shared library. */
  path: string;
  /** How it was found. */
  source: NativeLibrarySource;
  /** Absolute path to the directory holding `webgpu.h` / `wgpu.h`, when it shipped alongside. */
  includeDir: string | null;
  /** The pinned upstream tag recorded next to the library, when known (`vendor/<rid>/.version`). */
  version: string | null;
}
