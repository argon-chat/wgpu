/**
 * The compatibility contract with the `webgpu` npm package.
 *
 * That package's entire public surface is three exports — `create`, `globals`, `isMac` — and the
 * migration it enables is a one-line import change followed by an unchanged
 * `Object.assign(globalThis, globals)`. Everything else a caller touches is `@webgpu/types`.
 *
 * So compatibility is cheap to state and cheap to check, and that is exactly why it should be
 * checked rather than asserted in prose. The expensive part is the constants: WebGPU code writes
 * `GPUBufferUsage.STORAGE` unqualified, so a bag with the right *names* and wrong *bits* produces a
 * program that runs and does the wrong thing. Those five tables are pinned here by value.
 *
 * Half of this file is gated on `IMPLEMENTED`. While the binding is a stub the bag is deliberately
 * empty — a partial roster is the worst option, because `Object.assign` would appear to succeed and
 * the program would die much later with `GPUBufferUsage is not defined`, pointing at the caller
 * rather than at the stub.
 */
import { describe, expect, test } from "bun:test";

import { create, globals, IMPLEMENTED, isMac, NotImplementedError } from "../src/index.ts";

/** The exact bit values `webgpu`'s bag carries. Not spec text — measured off the real package. */
const CONSTANT_TABLES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  GPUBufferUsage: {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  },
  GPUTextureUsage: {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUMapMode: { READ: 1, WRITE: 2 },
  GPUColorWrite: { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 },
};

/**
 * The interfaces a real WebGPU program can reach for by name.
 *
 * Deliberately not the upstream 42: `GPUSubgroupMatrixConfig` and `WGSLLanguageFeatures` are
 * Dawn-proprietary with no spec equivalent, and this package binds wgpu-native. They are the one
 * place the bags may legitimately differ, and saying which two beats a vague "mostly the same".
 */
const REQUIRED_GLOBALS: readonly string[] = [
  "GPU",
  "GPUAdapter",
  "GPUAdapterInfo",
  "GPUBindGroup",
  "GPUBindGroupLayout",
  "GPUBuffer",
  "GPUBufferUsage",
  "GPUCanvasContext",
  "GPUColorWrite",
  "GPUCommandBuffer",
  "GPUCommandEncoder",
  "GPUCompilationInfo",
  "GPUCompilationMessage",
  "GPUComputePassEncoder",
  "GPUComputePipeline",
  "GPUDevice",
  "GPUDeviceLostInfo",
  "GPUError",
  "GPUExternalTexture",
  "GPUInternalError",
  "GPUMapMode",
  "GPUOutOfMemoryError",
  "GPUPipelineError",
  "GPUPipelineLayout",
  "GPUQuerySet",
  "GPUQueue",
  "GPURenderBundle",
  "GPURenderBundleEncoder",
  "GPURenderPassEncoder",
  "GPURenderPipeline",
  "GPUSampler",
  "GPUShaderModule",
  "GPUShaderStage",
  "GPUSupportedFeatures",
  "GPUSupportedLimits",
  "GPUTexture",
  "GPUTextureUsage",
  "GPUTextureView",
  "GPUUncapturedErrorEvent",
  "GPUValidationError",
];

describe("the three exports exist with the right shapes", () => {
  test("create is a function", () => {
    expect(typeof create).toBe("function");
  });

  test("globals is a frozen-or-plain object, never null", () => {
    expect(typeof globals).toBe("object");
    expect(globals).not.toBeNull();
  });

  test("isMac tracks the platform", () => {
    expect(isMac).toBe(process.platform === "darwin");
  });
});

describe("create tolerates how callers actually call it", () => {
  /** Did the call fail for a reason *other* than the binding being a stub? */
  function callFailure(fn: () => unknown): Error | null {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof NotImplementedError ? null : (err as Error);
    }
  }

  test("accepts a trailing argument the upstream type declaration does not mention", () => {
    // `create([], '')` occurs in real code. A stricter signature would break that caller for no
    // benefit, and it would break it at import time, before anything diagnosable had happened.
    expect(callFailure(() => (create as (...a: unknown[]) => unknown)([], ""))).toBeNull();
  });

  test("accepts being called with no arguments at all", () => {
    expect(callFailure(() => (create as (...a: unknown[]) => unknown)())).toBeNull();
  });

  test("accepts unknown flag strings rather than rejecting them", () => {
    // The flags are Dawn toggles upstream. wgpu-native has no toggle system, so string-for-string
    // parity is impossible — but an unrecognised toggle must never be the reason a program fails to
    // boot, because the caller passing it has no idea it is talking to a different backend.
    expect(callFailure(() => create(["enable-dawn-features=allow_unsafe_apis", "verbose"]))).toBeNull();
  });
});

describe.skipIf(IMPLEMENTED)("while unimplemented", () => {
  test("create throws NotImplementedError rather than returning something half-working", () => {
    expect(() => create([])).toThrow(NotImplementedError);
  });

  test("globals is EMPTY, not partially filled", () => {
    // A partial bag is the worst available failure: `Object.assign(globalThis, globals)` succeeds,
    // and the program dies far away with `GPUBufferUsage is not defined` pointing at the caller.
    // Empty keeps the failure at the boundary, next to the loud `create()` throw.
    expect(Object.keys(globals)).toHaveLength(0);
  });
});

describe.skipIf(!IMPLEMENTED)("once implemented, the globals bag is usable", () => {
  test("carries every interface a real program reaches for by name", () => {
    const missing = REQUIRED_GLOBALS.filter((n) => !(n in globals));
    expect(missing).toEqual([]);
  });

  test.each(Object.keys(CONSTANT_TABLES))("%s carries the exact upstream bit values", (bagName) => {
    // Names without values is the dangerous half-measure here: the program runs, the usage flags are
    // wrong, and the symptom is a validation error about something unrelated three calls later.
    const table = CONSTANT_TABLES[bagName]!;
    const actual = globals[bagName] as Record<string, unknown> | undefined;
    expect(actual).toBeDefined();
    for (const [flag, value] of Object.entries(table)) {
      expect(`${bagName}.${flag} = ${actual![flag]}`).toBe(`${bagName}.${flag} = ${value}`);
    }
  });

  test("Object.assign onto a plain object reproduces the splat callers perform", () => {
    const target: Record<string, unknown> = {};
    Object.assign(target, globals);
    expect(target["GPUBufferUsage"]).toBeDefined();
    expect((target["GPUShaderStage"] as Record<string, number>)["COMPUTE"]).toBe(4);
  });

  test("create returns a GPU with the two methods every caller uses", () => {
    const gpu = create([]) as GPU;
    expect(gpu).toBeTruthy();
    expect(typeof gpu.requestAdapter).toBe("function");
    expect(typeof gpu.getPreferredCanvasFormat).toBe("function");
  });
});
