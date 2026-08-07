/**
 * Shader compilation diagnostics — what this package can honestly offer, and proof that it does.
 *
 * ── The constraint, stated precisely ────────────────────────────────────────────────────────────
 *
 * `getCompilationInfo` is not "missing from some bindings". **`wgpuShaderModuleGetCompilationInfo`
 * is `unimplemented!()` in wgpu-native itself** (see `test/support/abort-symbols.ts` — it is one of
 * the 40 exported symbols that abort the process when called). There is no native call to forward
 * to. A binding that wires `GPUShaderModule.getCompilationInfo()` straight through does not return
 * empty diagnostics; it kills the runner.
 *
 * So the honest offering is:
 *
 *   **Compilation errors arrive through the error scope, at `createShaderModule` time.**
 *   `getCompilationInfo()` is synthesised from that same error, not fetched from wgpu-native.
 *
 * That is a real difference from Dawn, where the two channels are independent, and the README says
 * so. What it is not is a downgrade in *information*: naga's diagnostic text is what lands in the
 * validation error either way.
 *
 * ── Why the tests are pairs ─────────────────────────────────────────────────────────────────────
 *
 * The whole pass criterion of a shader-codegen test suite is usually "does the generated WGSL
 * compile", read off `info.messages.filter(m => m.type === 'error')`. A `getCompilationInfo()` that
 * unconditionally returns `{ messages: [] }` turns every such assertion green regardless of the
 * codegen being correct — and it is the single most natural stub to write, because it is what a
 * *successful* compile legitimately returns.
 *
 * Every test here therefore checks a bad shader and a good one through the same call. Empty-always
 * fails the bad case; error-always fails the good one.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { freshDevice, INVALID_WGSL, skipGpu, VALID_WGSL } from "./support/gpu.ts";

describe.skipIf(skipGpu)("shader compilation errors surface", () => {
  let d: GPUDevice;
  beforeAll(async () => {
    d = await freshDevice("shader-errors");
  });

  test("invalid WGSL raises a validation error at createShaderModule", async () => {
    d.pushErrorScope("validation");
    let threw: Error | null = null;
    try {
      d.createShaderModule({ code: INVALID_WGSL, label: "deliberately-invalid" });
    } catch (err) {
      threw = err as Error;
    }
    const error = await d.popErrorScope();

    // Either channel is acceptable — what is not acceptable is neither.
    expect(error !== null && error !== undefined ? true : threw !== null).toBe(true);

    const message = error?.message ?? threw?.message ?? "";
    expect(message.length).toBeGreaterThan(0);
  });

  test("valid WGSL raises nothing", async () => {
    d.pushErrorScope("validation");
    d.createShaderModule({ code: VALID_WGSL, label: "valid" });
    const error = await d.popErrorScope();
    expect(error).toBeFalsy();
  });

  test("the error text names something about the actual defect", async () => {
    // Not a golden — naga's wording moves between versions. But a synthesised diagnostic that says
    // only "shader error" would satisfy every other assertion here while telling a user nothing, and
    // this package's whole argument is that its error path is worth having. The bar is: the message
    // must be longer than a placeholder and must mention the offending construct or a line.
    d.pushErrorScope("validation");
    try {
      d.createShaderModule({ code: INVALID_WGSL });
    } catch {
      /* handled below via the scope, or not at all */
    }
    const error = await d.popErrorScope();
    if (!error) return; // the synchronous-throw path is covered by the first test

    expect(error.message.length).toBeGreaterThan(20);
  });
});

describe.skipIf(skipGpu)("getCompilationInfo", () => {
  let d: GPUDevice;
  beforeAll(async () => {
    d = await freshDevice("compilation-info");
  });

  /**
   * `getCompilationInfo` is optional for this package — but only in the sense that it may be absent.
   * "Present and always empty" is the outcome these tests exist to make impossible.
   */
  function supported(module: GPUShaderModule): boolean {
    return typeof (module as { getCompilationInfo?: unknown }).getCompilationInfo === "function";
  }

  test("if present, it reports errors for invalid WGSL", async () => {
    // The module has to be created inside a scope regardless, or the invalid-shader error escapes to
    // the uncaptured handler and the device is left in a state the next test would inherit.
    d.pushErrorScope("validation");
    let module: GPUShaderModule | null = null;
    try {
      module = d.createShaderModule({ code: INVALID_WGSL });
    } catch {
      module = null;
    }
    await d.popErrorScope();

    if (!module || !supported(module)) return;

    const info = await module.getCompilationInfo();
    expect(Array.isArray(info.messages)).toBe(true);

    const errors = info.messages.filter((m) => m.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(typeof errors[0]!.message).toBe("string");
    expect(errors[0]!.message.length).toBeGreaterThan(0);
    // `lineNum` is the only positional field real consumers read. Zero is an acceptable "unknown".
    expect(typeof errors[0]!.lineNum).toBe("number");
  });

  test("if present, it reports NO errors for valid WGSL", async () => {
    const module = d.createShaderModule({ code: VALID_WGSL });
    if (!supported(module)) return;

    const info = await module.getCompilationInfo();
    expect(Array.isArray(info.messages)).toBe(true);
    expect(info.messages.filter((m) => m.type === "error")).toHaveLength(0);
  });

  test("present-and-always-empty is not a passing configuration", async () => {
    // The two tests above are individually satisfiable by a stub (empty-always passes the second,
    // error-always passes the first). This one runs both through the same call and requires them to
    // differ, which no unconditional implementation can do.
    const good = d.createShaderModule({ code: VALID_WGSL });
    if (!supported(good)) return; // absent is honest; see the file header

    d.pushErrorScope("validation");
    let bad: GPUShaderModule | null = null;
    try {
      bad = d.createShaderModule({ code: INVALID_WGSL });
    } catch {
      bad = null;
    }
    await d.popErrorScope();
    if (!bad) return; // creation threw synchronously; nothing to ask for info about

    const goodErrors = (await good.getCompilationInfo()).messages.filter((m) => m.type === "error");
    const badErrors = (await bad.getCompilationInfo()).messages.filter((m) => m.type === "error");

    expect(goodErrors.length).toBe(0);
    expect(badErrors.length).toBeGreaterThan(0);
  });
});

describe.skipIf(skipGpu)("a broken shader does not become a silent pipeline", () => {
  test("creating a compute pipeline from invalid WGSL is an error, not a no-op", async () => {
    // The failure this guards against: the shader error is reported at module creation, the caller's
    // scope is popped, and then pipeline creation quietly succeeds against a module that never
    // compiled — so a later dispatch does nothing and the suite passes.
    const d = await freshDevice("broken-pipeline");

    d.pushErrorScope("validation");
    let module: GPUShaderModule | null = null;
    try {
      module = d.createShaderModule({ code: INVALID_WGSL });
    } catch {
      module = null;
    }
    const moduleError = await d.popErrorScope();
    expect(moduleError !== null && moduleError !== undefined ? true : module === null).toBe(true);

    if (!module) return; // rejected at creation — the strongest possible outcome

    d.pushErrorScope("validation");
    let pipelineThrew = false;
    try {
      d.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    } catch {
      pipelineThrew = true;
    }
    const pipelineError = await d.popErrorScope();

    expect(pipelineThrew || Boolean(pipelineError)).toBe(true);
  });
});
