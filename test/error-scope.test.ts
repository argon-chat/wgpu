/**
 * `pushErrorScope` / `popErrorScope` — the reason this package exists.
 *
 * ── Why these tests are shaped the way they are ─────────────────────────────────────────────────
 *
 * In real WebGPU test suites the error scope *is* the assertion: code pushes a scope, does the thing
 * under test, pops, and passes if the result is null. Nothing else is checked. That makes an error
 * scope which records nothing indistinguishable from one that works — every assertion built on it
 * passes **vacuously**, and the suite becomes decoration with no gate able to notice a regression.
 *
 * So proving "it does not crash" is worthless here, and proving "an empty scope returns null" is
 * worse than worthless, because a `popErrorScope` hard-coded to `return null` passes it.
 *
 * Every test below is therefore a **pair**: an operation that must report, and its valid twin that
 * must not. A do-nothing implementation fails the first half. An always-report implementation fails
 * the second. Only something that actually distinguishes them passes both.
 *
 * The invalid operations are chosen to need *device-side* validation — usage flags that are only
 * wrong in combination with another object — rather than anything a binding could plausibly reject
 * in JS before the FFI call. A JS-side pre-check is legitimate behaviour (and is exactly what the
 * bind-group-layout panic hazard demands), so the tests accept a synchronous throw as an
 * alternative to a scope report. What they never accept is silent success.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { globals } from "../src/index.ts";
import { freshDevice, skipGpu, VALID_WGSL } from "./support/gpu.ts";

/**
 * One invalid operation and the valid twin that differs from it only in the way that makes it valid.
 *
 * The twin is what makes the pair a discriminator instead of a coin flip.
 */
interface IErrorCase {
  readonly name: string;
  /** Must produce a validation error (or throw synchronously). */
  readonly invalid: (device: GPUDevice) => void | Promise<void>;
  /** Same shape, valid. Must produce nothing. */
  readonly valid: (device: GPUDevice) => void | Promise<void>;
}

// ── Why no case submits ────────────────────────────────────────────────────────────────────────
// Submitting an INVALID command buffer aborts the process inside `wgpuQueueSubmit` — a non-unwinding
// Rust panic across the C ABI. The open error scope is not consulted and neither is the uncaptured-
// error callback, so there is nothing to catch and nothing to report; the run simply dies.
//
// `finish()` and the device-level creation calls do report normally, which makes the usable shape
// for a negative test: encode, `finish()`, `popErrorScope()`, and stop there. Both arms of every
// pair stop at the same point — if only the invalid arm stopped early the two would no longer be
// the same shape, and the pairing is the whole reason these assertions cannot pass vacuously.
const CASES: readonly IErrorCase[] = [
  {
    // Encoder-level: the source buffer lacks COPY_SRC. Only checkable against the buffer's real
    // usage flags, so this cannot be short-circuited by inspecting the call's own arguments.
    name: "copyBufferToBuffer from a buffer without COPY_SRC",
    invalid: (d) => {
      const src = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
      const dst = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST });
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, dst, 0, 16);
      enc.finish();
    },
    valid: (d) => {
      const src = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC });
      const dst = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST });
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, dst, 0, 16);
      enc.finish();
    },
  },
  {
    // Queue-level: writeBuffer into a buffer that is not a copy destination.
    name: "writeBuffer into a buffer without COPY_DST",
    invalid: (d) => {
      const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
      d.queue.writeBuffer(buf, 0, new Uint32Array(4));
    },
    valid: (d) => {
      const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(buf, 0, new Uint32Array(4));
    },
  },
  {
    // Copy geometry: bytesPerRow must be a multiple of 256 for a texture→buffer copy. This is the
    // exact constraint every pixel-readback path in the world depends on, so pinning it here is
    // worth more than a generic descriptor error.
    name: "copyTextureToBuffer with an unaligned bytesPerRow",
    invalid: (d) => {
      const tex = d.createTexture({
        size: [64, 64],
        format: "rgba8unorm",
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const buf = d.createBuffer({ size: 64 * 64 * 4, usage: GPUBufferUsage.COPY_DST });
      const enc = d.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 100 }, [64, 64]);
      enc.finish();
    },
    valid: (d) => {
      const tex = d.createTexture({
        size: [64, 64],
        format: "rgba8unorm",
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const buf = d.createBuffer({ size: 64 * 256, usage: GPUBufferUsage.COPY_DST });
      const enc = d.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 256 }, [64, 64]);
      enc.finish();
    },
  },
];

/** Run `fn` inside a validation scope; report what came back, or the synchronous throw instead. */
async function capture(
  d: GPUDevice,
  fn: (device: GPUDevice) => void | Promise<void>,
): Promise<{ error: GPUError | null; threw: Error | null }> {
  d.pushErrorScope("validation");
  let threw: Error | null = null;
  try {
    await fn(d);
  } catch (err) {
    threw = err as Error;
  }
  const error = (await d.popErrorScope()) ?? null;
  return { error, threw };
}

describe.skipIf(skipGpu)("popErrorScope reports", () => {
  let d: GPUDevice;
  beforeAll(async () => {
    d = await freshDevice("error-scope");
  });

  test("an empty scope resolves falsy", async () => {
    d.pushErrorScope("validation");
    const err = await d.popErrorScope();
    expect(err).toBeFalsy();
  });

  test("a scope around valid work resolves falsy", async () => {
    const { error, threw } = await capture(d, (dev) => {
      dev.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      dev.createShaderModule({ code: VALID_WGSL });
    });
    expect(threw).toBeNull();
    expect(error).toBeFalsy();
  });

  // ── The load-bearing half ─────────────────────────────────────────────────────────────────────

  test.each(CASES.map((c) => [c.name, c] as const))(
    "%s is REPORTED, and its valid twin is not",
    async (_name, testCase) => {
      const bad = await capture(d, testCase.invalid);

      // Silent success is the one outcome that is never acceptable: it would mean the scope is
      // incapable of noticing an invalid command, which makes every green built on it meaningless.
      const noticed = bad.error !== null || bad.threw !== null;
      expect(noticed).toBe(true);

      if (bad.error) {
        expect(typeof bad.error.message).toBe("string");
        expect(bad.error.message.length).toBeGreaterThan(0);
      }

      // The discriminator: the same code path, made valid, must come back clean. Without this an
      // implementation that reports an error unconditionally would pass the assertion above.
      const good = await capture(d, testCase.valid);
      expect(good.threw).toBeNull();
      expect(good.error).toBeFalsy();
    },
  );

  test("at least one invalid operation reaches the scope rather than throwing early", async () => {
    // A binding may legitimately pre-validate some descriptors in JS and throw before the FFI call —
    // that is the correct defence against wgpu-native's non-unwinding panics. But if it pre-validated
    // *everything*, the error scope would never be exercised at all and could be a stub. At least one
    // real device-side validation error has to come back through `popErrorScope`.
    const reported: string[] = [];
    for (const c of CASES) {
      const { error } = await capture(d, c.invalid);
      if (error) reported.push(c.name);
    }
    expect(reported.length).toBeGreaterThan(0);
  });

  test("the reported error is a GPUValidationError when the globals bag provides one", async () => {
    const ValidationError = (globals as Record<string, unknown>)["GPUValidationError"];
    if (typeof ValidationError !== "function") return; // nothing to check against

    const { error } = await capture(d, CASES[0]!.invalid);
    // Only meaningful if this case reported at all; the previous test guarantees some case does.
    if (error) expect(error).toBeInstanceOf(ValidationError as new () => GPUError);
  });
});

describe.skipIf(skipGpu)("error scopes nest", () => {
  let d: GPUDevice;
  beforeAll(async () => {
    d = await freshDevice("error-scope-nesting");
  });

  test("the innermost open scope captures the error; the outer one stays clean", async () => {
    d.pushErrorScope("validation"); // outer
    d.pushErrorScope("validation"); // inner

    const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
    d.queue.writeBuffer(buf, 0, new Uint32Array(4)); // invalid: no COPY_DST

    const inner = await d.popErrorScope();
    const outer = await d.popErrorScope();

    expect(inner).toBeTruthy();
    expect(outer).toBeFalsy();
  });

  test("an error raised before an inner scope opens belongs to the outer one", async () => {
    // The mirror image of the previous test. Together they rule out "remember the last error and
    // hand it to whoever pops next", which would pass the first test on its own.
    d.pushErrorScope("validation"); // outer

    const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
    d.queue.writeBuffer(buf, 0, new Uint32Array(4)); // invalid, while only `outer` is open

    d.pushErrorScope("validation"); // inner, opened AFTER the error
    const inner = await d.popErrorScope();
    const outer = await d.popErrorScope();

    expect(inner).toBeFalsy();
    expect(outer).toBeTruthy();
  });

  test("scopes nest at least four deep without leaking between levels", async () => {
    const depth = 4;
    for (let i = 0; i < depth; i++) d.pushErrorScope("validation");

    const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
    d.queue.writeBuffer(buf, 0, new Uint32Array(4));

    const results: unknown[] = [];
    for (let i = 0; i < depth; i++) results.push(await d.popErrorScope());

    expect(results[0]).toBeTruthy();
    expect(results.slice(1).every((r) => !r)).toBe(true);
  });

  test("popping with no scope open neither hangs nor invents an error", async () => {
    // The spec says this rejects. Pinning the exact rejection type would over-constrain against
    // wgpu-native, but the two outcomes that matter are non-negotiable: it must settle, and it must
    // not fabricate an error object out of nothing.
    let settled: { ok: true; value: unknown } | { ok: false } ;
    try {
      settled = { ok: true, value: await d.popErrorScope() };
    } catch {
      settled = { ok: false };
    }
    if (settled.ok) expect(settled.value).toBeFalsy();
  });
});

describe.skipIf(skipGpu)("errors outside any scope", () => {
  test("an uncaptured validation error reaches onuncapturederror instead of killing the process", async () => {
    // wgpu-native treats device errors as FATAL when no uncaptured-error callback is registered —
    // it aborts, non-unwinding, taking the whole test runner with it. A binding must therefore
    // install a callback on every device it creates, unconditionally.
    //
    // This test reaching its assertions at all already proves the process survived. The assertion
    // proves the error was delivered rather than swallowed.
    const d = await freshDevice("uncaptured-error");
    const seen: GPUError[] = [];
    d.onuncapturederror = (event) => {
      seen.push((event as GPUUncapturedErrorEvent).error);
    };

    const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
    d.queue.writeBuffer(buf, 0, new Uint32Array(4)); // invalid, no scope open

    // Errors are delivered on poll, not at the call site, so force a drain before judging.
    await d.queue.onSubmittedWorkDone();

    expect(seen.length).toBeGreaterThan(0);
    expect(typeof seen[0]!.message).toBe("string");
  });
});
