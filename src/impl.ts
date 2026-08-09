/**
 * Which WebGPU implementation this process loads.
 *
 * Two are supported, and they are interchangeable at the C ABI: **wgpu-native** (the default, the
 * engine behind Firefox, Servo and Deno) and **Dawn** (the one behind Chromium). They expose the
 * same `webgpu.h` — measured aggregate by aggregate, 92 of them, zero differences — which is why
 * `src/layouts`, `src/desc` and `src/api` are implementation-agnostic and only the loading layer
 * knows there is a choice at all.
 *
 * ── Why `impl` and not `backend` ────────────────────────────────────────────────────────────────
 *
 * WebGPU already uses "backend" for the graphics API underneath — Vulkan, D3D12, Metal — and both
 * implementations use it that way in their own logs and options. Calling this a backend too would
 * make `backend=dawn` and `backend=vulkan` two different axes wearing one word, in a package whose
 * whole job is to be precise about what is talking to what. `impl` is the word Dawn and wgpu use for
 * each other.
 *
 * ── Selection ───────────────────────────────────────────────────────────────────────────────────
 *
 *     WGPU_BUN_IMPL=wgpu-native   (default — what `bun add wgpu-bun` installs)
 *     WGPU_BUN_IMPL=dawn          requires the Dawn platform package, which is opt-in
 *
 * An unset variable is the default and never an error. A *misspelled* one is always an error: a
 * typo'd `WGPU_BUN_IMPL=dwan` that silently fell back to wgpu-native would report success while
 * measuring the wrong implementation, which is the failure this package exists to avoid.
 */

/** A supported WebGPU implementation. */
export type WgpuImpl = "wgpu-native" | "dawn";

/** Every value {@link currentImpl} accepts, in the order an error message should list them. */
export const WGPU_IMPLS: readonly WgpuImpl[] = ["wgpu-native", "dawn"];

/** Environment variable naming the implementation to load. */
export const IMPL_ENV_VAR = "WGPU_BUN_IMPL";

/**
 * What loads when nothing is asked for.
 *
 * wgpu-native, because it is what the four published platform packages contain and what every
 * example in the README runs against. Dawn is an addition, not a migration.
 */
export const DEFAULT_IMPL: WgpuImpl = "wgpu-native";

/** Is this a name of a supported implementation? */
export function isWgpuImpl(value: string): value is WgpuImpl {
  return (WGPU_IMPLS as readonly string[]).includes(value);
}

/**
 * The implementation selected for this process.
 *
 * @param env  the environment to read; a parameter so tests do not have to mutate `process.env`
 * @throws when the variable is set to something that is not a supported implementation
 */
export function currentImpl(env: Record<string, string | undefined> = process.env): WgpuImpl {
  const raw = env[IMPL_ENV_VAR];
  if (raw === undefined || raw === "") return DEFAULT_IMPL;
  const value = raw.trim().toLowerCase();
  if (isWgpuImpl(value)) return value;
  throw new Error(
    `wgpu-bun: ${IMPL_ENV_VAR} is set to "${raw}", which is not a supported implementation.\n` +
      `  Use one of: ${WGPU_IMPLS.join(", ")}\n` +
      `  Unset it to get the default (${DEFAULT_IMPL}).`,
  );
}
