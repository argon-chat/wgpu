/**
 * `GPU` — the `navigator.gpu` entry point — and adapter selection.
 *
 * ══ Adapter and backend selection is part of the contract, not a preference ══
 *
 * On a machine with more than one GPU, or more than one usable backend, "whatever the instance
 * picks" is a correctness decision disguised as a default. Two measured facts make that concrete:
 *
 *   - **Same GPU, different backend, different feature set.** On the reference machine wgpu-native
 *     defaults to the discrete NVIDIA part over **Vulkan**, where the Dawn-based implementation the
 *     existing baselines were captured on reaches the *same silicon* over **D3D12**. `shader-f16`
 *     is present on Vulkan and **absent on D3D12** for that one adapter. A binding that reports
 *     "no f16" without also saying "because D3D12" costs someone a day.
 *   - **`powerPreference: "low-power"` changes vendor**, not just clocks — it lands on the
 *     integrated AMD part. In a two-GPU laptop that is a device swap, and every pixel comparison
 *     changes underneath it.
 *
 * So this package **states a backend rather than inheriting one**, and says which one it chose:
 *
 *   | host      | default backend | why |
 *   |-----------|-----------------|-----|
 *   | `win32`   | D3D12           | matches the Dawn-based reference implementation, so pixel goldens and floating-point behaviour stay comparable. Cost: no `shader-f16` — request `backend=vulkan` for f16 work. |
 *   | `darwin`  | Metal           | the only real option. |
 *   | `linux`   | Vulkan          | the only real option. |
 *
 * Override, in precedence order: `requestAdapter({ backendType })` → `create(["backend=vulkan"])`
 * → `WGPU_BUN_BACKEND` → the table above. Passing `backend=auto` restores wgpu-native's own choice,
 * which is the one thing this module will not do silently.
 *
 * The chosen adapter is **logged once**, with backend, adapter type, device name and vendor ID,
 * unless `WGPU_BUN_QUIET` is set. A binding that picks differently from the reference
 * implementation and says nothing makes every numeric comparison suspect for a reason nobody will
 * suspect.
 */

import { seam } from "../ffi/abiSeam.ts";
import { callbackAddress, processEvents, settle, type IHandleResult } from "../ffi/async.ts";
import { wgpu, type Ptr } from "../ffi/library.ts";
import { Arena } from "../desc/build.ts";
import { C, POWER_PREFERENCE, toEnum } from "../enums.ts";
import { GPUAdapter } from "./adapter.ts";

/** Parsed `create()` flags plus environment overrides. */
export interface IInstanceOptions {
  /** `undefined` = the per-host default; `"auto"` = defer to wgpu-native. */
  backend?: string;
  powerPreference?: GPUPowerPreference;
  quiet?: boolean;
}

const BACKEND_ALIASES: Readonly<Record<string, number>> = {
  auto: C.backendType.undefined,
  d3d12: C.backendType.d3d12,
  dx12: C.backendType.d3d12,
  vulkan: C.backendType.vulkan,
  vk: C.backendType.vulkan,
  metal: C.backendType.metal,
  gl: C.backendType.openGL,
  opengl: C.backendType.openGL,
  gles: C.backendType.openGLES,
  null: C.backendType.null,
};

function defaultBackendFor(platform: string): number {
  if (platform === "win32") return C.backendType.d3d12;
  if (platform === "darwin") return C.backendType.metal;
  return C.backendType.vulkan;
}

/**
 * Turn `create()`'s string array into instance options.
 *
 * Upstream's flags are Dawn toggles; wgpu-native has no toggle system, so an unrecognised entry is
 * **ignored rather than rejected**. An unknown toggle must never be the reason a program fails to
 * boot — but the ones this package does understand are its own, and are documented above.
 */
export function parseFlags(flags: readonly string[] | undefined): IInstanceOptions {
  const options: IInstanceOptions = {};
  for (const flag of flags ?? []) {
    const [key, value] = String(flag).split("=", 2);
    if (key === "backend" && value) options.backend = value.toLowerCase();
    else if (key === "power" && value) options.powerPreference = value as GPUPowerPreference;
    else if (key === "quiet") options.quiet = true;
  }
  options.backend ??= process.env["WGPU_BUN_BACKEND"]?.toLowerCase();
  options.quiet ??= Boolean(process.env["WGPU_BUN_QUIET"]);
  return options;
}

/** Resolve the backend to request, given options and the host. */
export function resolveBackend(options: IInstanceOptions, platform = process.platform): number {
  if (options.backend === undefined) return defaultBackendFor(platform);
  const mapped = BACKEND_ALIASES[options.backend];
  if (mapped === undefined) {
    throw new Error(
      `wgpu-bun: unknown backend "${options.backend}". ` +
        `Known: ${Object.keys(BACKEND_ALIASES).join(", ")}.`,
    );
  }
  return mapped;
}

/** The `navigator.gpu` object. */
export class GPU {
  readonly #instance: Ptr;
  readonly #options: IInstanceOptions;
  readonly #defaultBackend: number;

  constructor(instance: Ptr, options: IInstanceOptions) {
    this.#instance = instance;
    this.#options = options;
    this.#defaultBackend = resolveBackend(options);
  }

  /** The native `WGPUInstance`. Internal, but exposed for callers doing their own FFI. */
  get instance(): Ptr {
    return this.#instance;
  }

  /** `true` unless `quiet` was requested — read by device creation for the one-line adapter banner. */
  get verbose(): boolean {
    return !this.#options.quiet;
  }

  /**
   * Ask for an adapter.
   *
   * Accepts the standard options plus a non-standard `backendType` escape hatch, because on this
   * implementation the backend is a correctness knob (see the module header) and there is no
   * spec-blessed way to say it.
   *
   * Resolves to `null` rather than throwing when no adapter is available, matching the spec and the
   * `if (!adapter)` guard every caller already has.
   */
  async requestAdapter(
    options?: GPURequestAdapterOptions & { backendType?: string },
  ): Promise<GPUAdapter | null> {
    const arena = new Arena();

    const opts = arena.struct("WGPURequestAdapterOptions");
    opts.setEnum("featureLevel", C.featureLevel.core);
    if (options?.powerPreference) {
      opts.setEnum(
        "powerPreference",
        toEnum(POWER_PREFERENCE, options.powerPreference, "GPUPowerPreference"),
      );
    }
    opts.setBool("forceFallbackAdapter", options?.forceFallbackAdapter ?? false);
    opts.setEnum(
      "backendType",
      options?.backendType !== undefined
        ? resolveBackend({ backend: options.backendType.toLowerCase() })
        : this.#defaultBackend,
    );
    const optionsPtr = arena.hold(opts);

    const info = arena.struct("WGPURequestAdapterCallbackInfo");
    info.setEnum("mode", C.callbackMode.allowProcessEvents);
    info.setPtr("callback", callbackAddress("requestAdapter"));
    const infoPtr = arena.hold(info);

    const result = await settle<IHandleResult>(
      () => processEvents(this.#instance),
      (ticket) => {
        // userdata1 is the ticket — an integer that names nothing. See src/ffi/async.ts.
        info.setPtr("userdata1", ticket);
        seam().wgpuInstanceRequestAdapter(this.#instance, optionsPtr, infoPtr);
      },
    );

    if (result.status !== C.requestAdapterStatus.success || !result.handle) {
      if (this.verbose) {
        console.warn(`wgpu-bun: requestAdapter failed (status ${result.status}) ${result.message}`);
      }
      return null;
    }
    return new GPUAdapter(result.handle, this);
  }

  /**
   * The format a canvas should be configured with.
   *
   * Hard-coded to `bgra8unorm`: it is what the reference implementation reports on every desktop
   * platform, and this package has no surface to ask. Callers already guard this method's absence
   * with a `'bgra8unorm'` fallback, so returning anything else would be the surprising choice.
   */
  getPreferredCanvasFormat(): GPUTextureFormat {
    return "bgra8unorm";
  }

  /**
   * `wgpuInstanceGetWGSLLanguageFeatures` is an `unimplemented!()` stub that aborts, so this is
   * always empty rather than "not present" — an empty set is a truthful "we cannot enumerate any",
   * and it keeps `Object.assign(globalThis, globals)` consumers from crashing on a missing member.
   */
  readonly wgslLanguageFeatures: ReadonlySet<string> = new Set<string>();

  /** Drain any callbacks wgpu-native has ready. Exposed for callers running their own frame loop. */
  processEvents(): void {
    processEvents(this.#instance);
  }

  /** Release the instance. Nothing else in this package holds it. */
  destroy(): void {
    wgpu().wgpuInstanceRelease(this.#instance);
  }
}
