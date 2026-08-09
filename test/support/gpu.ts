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
 * | Reason           | Default        | Escape hatch                       |
 * |------------------|----------------|------------------------------------|
 * | `no-library`     | **hard fail**  | `WGPU_BUN_ALLOW_NO_LIBRARY=1`      |
 * | `unimplemented`  | skip           | none — see below                   |
 * | `abi-unsupported`| skip *if no shim is installed* | none — see below  |
 * | `no-callback`    | **hard fail**  | none — see below                   |
 * | `no-adapter`     | **hard fail**  | `WGPU_BUN_ALLOW_NO_ADAPTER=1`      |
 * | `no-device`      | **hard fail**  | none                               |
 *
 * `unimplemented` skips because the binding legitimately does not exist yet, and a permanently red
 * suite trains people to ignore it. That would be a loophole — "never implement it and the tests
 * never run" — except that `environment.test.ts` binds the package's public claims to the same flag:
 * while `IMPLEMENTED` is false the README must say so and the version must stay `0.0.x`. The escape
 * from the skip is not a knob, it is shipping.
 *
 * ── `abi-unsupported`, and the misclassification it exists to end ───────────────────────────────
 *
 * `bun:ffi` cannot express a by-value C aggregate, and under the SysV x86-64 ABI seven wgpu-native
 * entry points need exactly that. Where no compiled shim is installed, the binding **refuses to
 * run** rather than corrupt a stack (see `src/ffi/abiSeam.ts`).
 *
 * That refusal used to arrive as `requestAdapter() threw`, which this file filed under
 * **`no-adapter`** — a diagnosis meaning "this host has no GPU". On the `linux-x64` CI leg it was
 * flatly untrue: `vulkaninfo` on that same runner reports `llvmpipe (LLVM 20.1.2) /
 * DRIVER_ID_MESA_LLVMPIPE`, so the software adapter was installed and visible the whole time. The
 * gate sent a reader looking for a driver problem that did not exist. A binding declining an ABI it
 * cannot express and a machine with no GPU are different facts and now have different names.
 *
 * Its policy follows the same shape as `unimplemented`, and for the same reason: the escape is
 * shipping, not a knob. It is a permitted skip **only while no shim is installed for this host**. If
 * a shim *is* installed and the seam still refused, that is a defect — a shim that failed to load,
 * or a version-skew rejection — and it hard-fails. So the kind stops being reachable the moment the
 * artefact lands, mechanically rather than by anyone remembering to delete it.
 *
 * ── `no-callback`, the same mistake a third time ────────────────────────────────────────────────
 *
 * A native call whose callback never arrives used to land here as `no-adapter` too, and it was wrong
 * in both of the ways that matter. It named the wrong subsystem — the runners that hit it had an
 * adapter, and `vulkaninfo` said so — and `no-adapter` is escapable by an environment variable two
 * matrix legs are granted, so a real completion defect could be skipped past on exactly the legs
 * most likely to have one.
 *
 * It is never a permitted skip. A device that never answers and a binding that mis-decodes its own
 * callback arguments both produce it, and neither is something a run should be allowed to shrug off;
 * the thrown error carries the seam diagnostics needed to tell them apart.
 *
 * `no-adapter` is the one CI actually needs, because hosted runners vary. It is an env var rather
 * than auto-detection so that granting it is a visible, per-job decision in the workflow file, and
 * every skip it causes is announced on stderr and as a GitHub annotation.
 */
import {
  AbiUnsupportedError,
  CallbackDeadlineError,
  create,
  globals,
  IMPLEMENTED,
  NotImplementedError,
  seamStatus,
  type ISeamStatus,
} from "../../src/index.ts";
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
  /**
   * The binding refused to run on this ABI, because `bun:ffi` cannot express a by-value aggregate
   * here and no compiled shim is installed. **Not** a statement about the GPU: the host may have a
   * perfectly good adapter, and on the `linux-x64` CI runner it does.
   */
  | { readonly kind: "abi-unsupported"; readonly detail: string }
  /**
   * A native call was issued and its callback never arrived within the deadline. **Not** a statement
   * about the GPU either: the adapter was reached far enough to be asked. Never a permitted skip.
   */
  | { readonly kind: "no-callback"; readonly detail: string }
  /** The binding works but the host exposes no adapter (headless CI without a software rasteriser). */
  | { readonly kind: "no-adapter"; readonly detail: string }
  /** An adapter exists but `requestDevice` failed. Never acceptable — it means a real defect. */
  | { readonly kind: "no-device"; readonly detail: string };

const ALLOW_NO_ADAPTER = process.env["WGPU_BUN_ALLOW_NO_ADAPTER"] === "1";
const ALLOW_NO_LIBRARY = process.env["WGPU_BUN_ALLOW_NO_LIBRARY"] === "1";
const IN_GITHUB_ACTIONS = process.env["GITHUB_ACTIONS"] === "true";

/**
 * The seam's verdict, read once.
 *
 * `SEAM.shim` is the escape-hatch-shaped part of the `abi-unsupported` policy, and it is a fact
 * about the filesystem rather than an env var on purpose: there is nothing a reviewer would want to
 * grant here. Either the artefact that makes the ABI expressible is installed, or it is not.
 */
const SEAM = seamStatus();

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
    if (err instanceof AbiUnsupportedError) return { kind: "abi-unsupported", detail: err.message };
    if (err instanceof NotImplementedError) return { kind: "unimplemented", detail: err.message };
    throw err;
  }
  if (!gpu) return { kind: "no-adapter", detail: "create() returned a falsy value" };

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (err) {
    // Order matters, and this is the whole point of the kind. The seam's refusal reaches us as a
    // throw from `requestAdapter`, which is exactly where a genuine driver failure also lands — so
    // whichever branch is tested first is the diagnosis the reader gets. Classifying by error type
    // rather than by call site is what stops "this binding will not run here" from being reported as
    // "this machine has no GPU".
    if (err instanceof AbiUnsupportedError) {
      return { kind: "abi-unsupported", detail: (err as Error).message };
    }
    if (err instanceof CallbackDeadlineError) {
      return { kind: "no-callback", detail: (err as Error).message };
    }
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
    // Same split one level down: a device request that never completes is a callback problem, not a
    // rejected descriptor, and lumping them together loses the only clue that distinguishes them.
    if (err instanceof CallbackDeadlineError) {
      return { kind: "no-callback", detail: (err as Error).message };
    }
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
} else if (gate.kind === "abi-unsupported" && !SEAM.shim) {
  annotate(
    "warning",
    `GPU suites SKIPPED — this ABI needs the compiled shim and none is installed.\n` +
      `This is NOT a statement about the GPU on this host; the adapter, if any, was never asked for.\n` +
      `Install it with \`bun run shim:fetch\` (pinned prebuilt) or \`bun run shim:build\` (needs cargo).\n` +
      `${SEAM.reason}`,
  );
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
export function skipIsPermitted(g: GpuGate = gate, seam: ISeamStatus = SEAM): boolean {
  switch (g.kind) {
    case "ready":
      return true;
    case "unimplemented":
      return !IMPLEMENTED;
    case "abi-unsupported":
      // Permitted only while there is no shim for this host. Once one is installed the seam cannot
      // legitimately refuse, so a refusal means the shim failed to load or was rejected for version
      // skew — a defect, and it must go red. No env var: granting "run without the thing that makes
      // it correct" is not a decision anyone should be able to make.
      //
      // `seam` is a parameter rather than only a module constant so this branch can be exercised for
      // both answers on one machine. A policy that can only ever be observed in the state the host
      // happens to be in is a policy nobody has tested.
      return seam.shim === null;
    case "no-adapter":
      return ALLOW_NO_ADAPTER;
    case "no-library":
      return ALLOW_NO_LIBRARY;
    case "no-callback":
      // Never permitted. Either the device never answers or the binding mis-decodes its own
      // callback arguments; both are defects, and the second is the one that hid for a whole CI
      // matrix behind a label that said "no GPU".
      return false;
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
  if (gate.kind !== "ready") throw new Error(`no GPU adapter: ${gate.kind}`);
  // A **fresh adapter**, not the shared one. WebGPU says an adapter is consumed by `requestDevice`
  // and cannot produce a second device; wgpu-native does not enforce that, so asking the cached
  // adapter again worked here for as long as wgpu-native was the only implementation ever run.
  // Dawn does enforce it, and says so exactly:
  //   requestDevice failed (status 3) adapter is "consumed": it has already been used to create a
  //   device — CreateDeviceInternal (dawn/native/Adapter.cpp:319)
  // So this was never a Dawn quirk to work around; it was a spec rule this helper was leaning past
  // because the lenient implementation let it.
  const fresh = await gate.gpu.requestAdapter();
  if (!fresh) {
    throw new Error(
      `requestAdapter() resolved to null while creating the "${label}" device.\n` +
        `  The first adapter was obtained successfully, so this is not "no GPU on this host".`,
    );
  }
  return await fresh.requestDevice({ label });
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
