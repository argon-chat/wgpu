/**
 * `create()` — instance construction, and the boundary where the FFI substrate is first touched.
 *
 * The mechanism is settled: descriptors are packed into `ArrayBuffer`s from layouts derived from
 * the pinned headers and verified against a real C compiler, and passed by pointer, which is what
 * `bun:ffi` does natively. The one place C's calling convention cannot be expressed in JavaScript —
 * the handful of entry points taking an aggregate **by value** — is isolated in
 * {@link ./ffi/abiSeam.ts}, which refuses to run rather than silently corrupt where a pointer is
 * not a valid stand-in.
 *
 * What is genuinely not implemented is listed on {@link NotImplementedError}: surface presentation,
 * render bundles, indirect draw, occlusion queries and external textures — four coherent
 * subsystems, chosen because they have zero call sites in the corpus this package exists to serve.
 */

import { GPU, parseFlags } from "./api/gpu.ts";
import { wgpu } from "./ffi/library.ts";
import { asAddress } from "./ffi/pointer.ts";
import { Arena } from "./desc/build.ts";
import type { CreateOptions } from "./types.ts";

/**
 * Thrown by the parts of WebGPU this binding does not implement.
 *
 * Deliberately distinct from the abort-blocklist error in `./ffi/unimplemented.ts`: that one means
 * "wgpu-native would kill the process", this one means "this package has not built it".
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `wgpu-bun: ${what} is not implemented.\n` +
        `  This package covers the WebGPU surface a headless engine and its GPU test suites use.\n` +
        `  Not implemented, and named so the omission is deliberate rather than discovered:\n` +
        `    · surface presentation (GPUCanvasContext, configure/getCurrentTexture/present)\n` +
        `    · render bundles\n` +
        `    · indirect draw (dispatchWorkgroupsIndirect IS supported)\n` +
        `    · occlusion queries (timestamp query sets ARE supported)\n` +
        `    · external textures / importExternalTexture`,
    );
    this.name = "NotImplementedError";
  }
}

/**
 * Create a `GPU` entry point backed by wgpu-native.
 *
 * @param options flags, in the shape the reference implementation takes. Its flags are toggles for
 *        a different engine, so unrecognised entries are **ignored rather than rejected** — an
 *        unknown toggle must never be why a program fails to boot. The ones this package
 *        understands are `backend=<name>`, `power=<preference>` and `quiet`.
 */
export function createInstance(options?: CreateOptions): GPU {
  const parsed = parseFlags(options);
  const arena = new Arena();
  const descriptor = arena.struct("WGPUInstanceDescriptor");
  const instance = wgpu().wgpuCreateInstance(arena.hold(descriptor));
  if (!instance) {
    throw new Error(
      "wgpu-bun: wgpuCreateInstance returned NULL. The library loaded but no instance could be " +
        "created, which usually means no usable graphics backend is present.",
    );
  }
  return new GPU(asAddress(instance), parsed);
}
