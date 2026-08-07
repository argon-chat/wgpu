/**
 * The GPU gate — and the policy for what "no GPU" is allowed to mean.
 *
 * ── The failure mode this file exists to prevent ────────────────────────────────────────────────
 *
 * Every GPU assertion in this suite is built on top of a device. If acquiring one quietly turns into
 * a skip, the entire suite reports green on a machine that ran none of it. That is the same
 * silent-green hazard the package's error path is about, one level up: a gate that cannot fail is
 * decoration.
 *
 * So the reasons a device might be missing are separated, and each gets an explicit policy:
 *
 * | Reason          | Default        | Escape hatch                    |
 * |-----------------|----------------|---------------------------------|
 * | `no-library`    | **hard fail**  | `WGPU_BUN_ALLOW_NO_LIBRARY=1`   |
 * | `unimplemented` | skip           | none — see below                |
 * | `no-adapter`    | **hard fail**  | `WGPU_BUN_ALLOW_NO_ADAPTER=1`   |
 * | `no-device`     | **hard fail**  | none                            |
 *
 * `unimplemented` skips because the binding legitimately does not exist yet, and a permanently red
 * suite trains people to ignore it. That would be a loophole — "never implement it and the tests
 * never run" — except that `status.test.ts` binds the package's public claims to the same flag: while
 * `IMPLEMENTED` is false the README must say so and the version must stay `0.0.x`. The escape from
 * the skip is not a knob, it is shipping.
 *
 * `no-adapter` is the one CI actually needs, because hosted runners vary. It is an env var rather
 * than auto-detection so that granting it is a visible, per-job decision in the workflow file, and
 * every skip it causes is announced on stderr and as a GitHub annotation.
 */
import { create, globals, IMPLEMENTED, NotImplementedError } from "../../src/index.ts";
import { missingLibraryMessage, nativeLibrary } from "./native.ts";

// Exactly what a real consumer writes, and for the same reason: `GPUBufferUsage`, `GPUTextureUsage`,
// `GPUShaderStage`, `GPUMapMode` and `GPUColorWrite` are read as VALUES by any code that builds a
// descriptor, and nothing puts them on the global object but this line. Mirroring the consumer's
// two-line idiom here means the suite exercises the same path the compatibility contract promises,
// rather than a private shortcut that could keep passing after the public one broke.
//
// Done at module scope rather than inside the gate: the constants are static and must exist even on
// a run where no device could be acquired, or every test would fail for the wrong reason.
Object.assign(globalThis, globals);

/** Why a device could not be acquired, or that one was. */
export type GpuGate =
  | { readonly kind: "ready"; readonly gpu: GPU; readonly adapter: GPUAdapter; readonly device: GPUDevice; readonly adapterLabel: string }
  /** No wgpu-native library installed. */
  | { readonly kind: "no-library"; readonly detail: string }
  /** `create()` threw `NotImplementedError` — the binding is still a stub. */
  | { readonly kind: "unimplemented"; readonly detail: string }
  /** The binding works but the host exposes no adapter (headless CI without a software rasteriser). */
  | { readonly kind: "no-adapter"; readonly detail: string }
  /** An adapter exists but `requestDevice` failed. Never acceptable — it means a real defect. */
  | { readonly kind: "no-device"; readonly detail: string };

const ALLOW_NO_ADAPTER = process.env["WGPU_BUN_ALLOW_NO_ADAPTER"] === "1";
const ALLOW_NO_LIBRARY = process.env["WGPU_BUN_ALLOW_NO_LIBRARY"] === "1";
const IN_GITHUB_ACTIONS = process.env["GITHUB_ACTIONS"] === "true";

function annotate(level: "warning" | "error", message: string): void {
  const oneLine = message.replace(/\n/g, " · ");
  if (IN_GITHUB_ACTIONS) console.log(`::${level} title=wgpu-bun::${oneLine}`);
  console.error(`\n${"─".repeat(96)}\n${level.toUpperCase()}: ${message}\n${"─".repeat(96)}\n`);
}

async function acquire(): Promise<GpuGate> {
  const lib = nativeLibrary();
  if (!lib) return { kind: "no-library", detail: missingLibraryMessage() };

  let gpu: GPU;
  try {
    // The second argument is deliberate: a real caller in the wild invokes `create([], '')`, and
    // tolerating the extra positional argument is part of the compatibility contract. Passing it
    // here means every GPU test exercises that tolerance for free.
    gpu = create([], "") as GPU;
  } catch (err) {
    if (err instanceof NotImplementedError) return { kind: "unimplemented", detail: err.message };
    throw err;
  }
  if (!gpu) return { kind: "no-adapter", detail: "create() returned a falsy value" };

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (err) {
    return { kind: "no-adapter", detail: `requestAdapter() threw: ${(err as Error).message}` };
  }
  if (!adapter) {
    return {
      kind: "no-adapter",
      detail:
        "requestAdapter() resolved to null — no GPU on this host.\n" +
        "  On Linux install mesa-vulkan-drivers (lavapipe); on Windows the D3D12 WARP software\n" +
        "  adapter should be present already. See .github/workflows/ci.yml for what CI installs.",
    };
  }

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ label: "wgpu-bun test device" });
  } catch (err) {
    return { kind: "no-device", detail: `requestDevice() threw: ${(err as Error).message}` };
  }

  const info = adapter.info as GPUAdapterInfo | undefined;
  const adapterLabel = info
    ? `${info.vendor || "?"} / ${info.architecture || "?"} / ${info.device || "?"} / ${info.description || "?"}`
    : "(no adapter info)";
  return { kind: "ready", gpu, adapter, device, adapterLabel };
}

/**
 * Resolved once per test file, at import time.
 *
 * Top-level await rather than lazy acquisition so that `describe.skipIf(...)` can be decided while
 * the file is still being collected — a skip decided after the fact is not a skip, it is a failure
 * that was swallowed.
 */
export const gate: GpuGate = await acquire();

/** True when GPU suites in this file should be skipped rather than run. */
export const skipGpu: boolean = gate.kind !== "ready";

// Announce the outcome exactly once per file, whichever way it went. A run that skipped everything
// must not look identical to a run that passed everything.
if (gate.kind === "ready") {
  console.error(`wgpu-bun: GPU ready — ${gate.adapterLabel}`);
} else if (gate.kind === "unimplemented") {
  console.error(`wgpu-bun: GPU suites SKIPPED — the binding is not implemented yet (IMPLEMENTED=${IMPLEMENTED}).`);
} else if (gate.kind === "no-adapter" && ALLOW_NO_ADAPTER) {
  annotate("warning", `GPU suites SKIPPED — no adapter, permitted by WGPU_BUN_ALLOW_NO_ADAPTER=1.\n${gate.detail}`);
} else if (gate.kind === "no-library" && ALLOW_NO_LIBRARY) {
  annotate("warning", `GPU suites SKIPPED — no native library, permitted by WGPU_BUN_ALLOW_NO_LIBRARY=1.`);
} else {
  annotate("error", `GPU suites CANNOT RUN (${gate.kind}).\n${gate.detail}`);
}

/**
 * Whether the current gate state is a *permitted* skip.
 *
 * `environment.test.ts` turns a non-permitted skip into a failing test, which is what stops an
 * un-runnable environment from reading as a passing one.
 */
export function skipIsPermitted(g: GpuGate = gate): boolean {
  switch (g.kind) {
    case "ready":
      return true;
    case "unimplemented":
      return !IMPLEMENTED;
    case "no-adapter":
      return ALLOW_NO_ADAPTER;
    case "no-library":
      return ALLOW_NO_LIBRARY;
    case "no-device":
      return false;
  }
}

/** The device, or a hard throw. Only call inside a suite already gated on {@link skipGpu}. */
export function device(): GPUDevice {
  if (gate.kind !== "ready") throw new Error(`no GPU device: ${gate.kind}`);
  return gate.device;
}

/** The adapter, or a hard throw. */
export function adapter(): GPUAdapter {
  if (gate.kind !== "ready") throw new Error(`no GPU adapter: ${gate.kind}`);
  return gate.adapter;
}

/**
 * A device of its own, for tests that must not share an error-scope stack with anything else.
 *
 * Error scopes are per-device and stack-shaped, so a test that pushes and fails before popping would
 * corrupt every later assertion on a shared device. Cheap insurance for exactly the tests where a
 * false green is the thing being guarded against.
 */
export async function freshDevice(label: string): Promise<GPUDevice> {
  return await adapter().requestDevice({ label });
}

/** Minimal WGSL that must compile everywhere — the control case for compilation-error tests. */
export const VALID_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  data[id.x] = data[id.x] * 2u;
}
`;

/**
 * WGSL that cannot compile, for the negative case.
 *
 * A type error rather than a syntax error on purpose: a binding could plausibly pre-screen for
 * unparseable text in JS and never reach the real compiler. `vec3<f32> + u32` needs actual WGSL type
 * checking to reject, so it can only be caught by naga.
 */
export const INVALID_WGSL = /* wgsl */ `
@compute @workgroup_size(1)
fn main() {
  let a: vec3<f32> = vec3<f32>(1.0, 2.0, 3.0);
  let b: u32 = 7u;
  let c = a + b;
}
`;
