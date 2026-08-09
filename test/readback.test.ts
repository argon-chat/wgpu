/**
 * The readback loop — `mapAsync(READ)` → `getMappedRange()` → `unmap()`.
 *
 * Two reasons this earns a file of its own rather than being folded into a general smoke test.
 *
 * **It is where the abort trap lives.** The blocklisted `wgpuBufferReadMappedRange` is the modern
 * header spelling of exactly this operation; the working one is `wgpuBufferGetMappedRange`.
 * `abort-symbols.test.ts` proves the binding does not *name* the trap. This proves the thing it
 * named instead actually works — a static check and a dynamic check of the same hazard, and neither
 * substitutes for the other.
 *
 * **It is how every GPU assertion downstream gets its data.** Compute results, rendered pixels,
 * golden comparisons: all of them come back through this loop, with a 256-byte-aligned
 * `bytesPerRow` for the texture case. If exactly one thing has to be bit-exact, it is this.
 *
 * The values are chosen so a do-nothing implementation cannot pass: the shader *changes* the data,
 * so a `getMappedRange()` that returns a zero-filled or unmodified buffer fails. Asserting "the
 * readback returned something" would have been satisfied by both.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { freshDevice, skipGpu } from "./support/gpu.ts";

const DOUBLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&data)) {
    data[id.x] = data[id.x] * 2u + 1u;
  }
}
`;

describe.skipIf(skipGpu)("buffer readback", () => {
  let d: GPUDevice;
  beforeAll(async () => {
    d = await freshDevice("readback");
  });

  test("a compute pass round-trips through mapAsync/getMappedRange/unmap", async () => {
    const N = 256;
    const input = new Uint32Array(N);
    for (let i = 0; i < N; i++) input[i] = i;
    const expected = input.map((v) => v * 2 + 1);

    const storage = d.createBuffer({
      size: input.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    d.queue.writeBuffer(storage, 0, input);

    const module = d.createShaderModule({ code: DOUBLE_WGSL });
    const pipeline = d.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bindGroup = d.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: storage } }],
    });

    const readback = d.createBuffer({
      size: input.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    d.pushErrorScope("validation");
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(N / 64);
    pass.end();
    enc.copyBufferToBuffer(storage, 0, readback, 0, input.byteLength);
    d.queue.submit([enc.finish()]);
    const error = await d.popErrorScope();
    expect(error).toBeFalsy();

    await readback.mapAsync(GPUMapMode.READ);
    const got = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    // The strong assertion: the data came back *transformed*. A stub that hands out a zeroed range,
    // or one that echoes what was written, fails here.
    expect([...got.slice(0, 8)]).toEqual([...expected.slice(0, 8)]);
    expect([...got.slice(-8)]).toEqual([...expected.slice(-8)]);
    expect(got).not.toEqual(input);
  });

  test("getMappedRange honours an offset and size", async () => {
    const bytes = new Uint32Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const src = d.createBuffer({ size: bytes.byteLength, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(src, 0, bytes);

    const readback = d.createBuffer({
      size: bytes.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, readback, 0, bytes.byteLength);
    d.queue.submit([enc.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    // A sub-range, not the whole buffer — the offset arithmetic is the part a hand-written binding
    // gets wrong, and a full-range-only implementation would sail through the test above.
    const slice = new Uint32Array(readback.getMappedRange(16, 16).slice(0));
    readback.unmap();

    expect([...slice]).toEqual([50, 60, 70, 80]);
  });

  test("a mapped buffer can be unmapped and mapped again", async () => {
    const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(buf, 0, new Uint32Array([1, 2, 3, 4]));

    await buf.mapAsync(GPUMapMode.READ);
    const first = new Uint32Array(buf.getMappedRange().slice(0));
    buf.unmap();

    d.queue.writeBuffer(buf, 0, new Uint32Array([9, 9, 9, 9]));
    await buf.mapAsync(GPUMapMode.READ);
    const second = new Uint32Array(buf.getMappedRange().slice(0));
    buf.unmap();

    expect([...first]).toEqual([1, 2, 3, 4]);
    expect([...second]).toEqual([9, 9, 9, 9]);
  });
});

describe.skipIf(skipGpu)("texture readback", () => {
  test("copyTextureToBuffer with a 256-aligned bytesPerRow returns the cleared colour", async () => {
    // The exact loop behind every pixel assertion anywhere: render (here, just a clear), copy the
    // texture into a MAP_READ buffer with a 256-byte-aligned row stride, map, read.
    const d = await freshDevice("texture-readback");
    const W = 64;
    const H = 4;
    const bytesPerRow = 256; // 64 px * 4 B, already aligned

    const tex = d.createTexture({
      size: [W, H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = d.createBuffer({
      size: bytesPerRow * H,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    d.pushErrorScope("validation");
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: tex.createView(),
          loadOp: "clear",
          storeOp: "store",
          // 0.25/0.5/0.75/1 chosen so every channel differs — a readback that mixes up channel
          // order, or returns a constant, cannot look correct by accident.
          clearValue: { r: 0.25, g: 0.5, b: 0.75, a: 1 },
        },
      ],
    });
    pass.end();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: readback, bytesPerRow }, [W, H]);
    d.queue.submit([enc.finish()]);
    const error = await d.popErrorScope();
    expect(error).toBeFalsy();

    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();

    // rgba8unorm rounds 0.25/0.5/0.75 to 64/128/191 — allow a unit of rounding slack, but not more.
    expect(Math.abs(pixels[0]! - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(pixels[1]! - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(pixels[2]! - 191)).toBeLessThanOrEqual(1);
    expect(pixels[3]).toBe(255);

    // The last row too — a binding that copies only the first row would otherwise pass.
    const lastRow = (H - 1) * bytesPerRow;
    expect(Math.abs(pixels[lastRow + 1]! - 128)).toBeLessThanOrEqual(1);
  });
  test("a multi-layer copy that omits rowsPerImage is a validation error, not an abort", async () => {
    // The strides are written as WGPU_COPY_STRIDE_UNDEFINED when absent, and this is what that buys.
    //
    // The same C struct arrives here as a *sub-view* of `WGPUTexelCopyBufferInfo`, where `sub()`
    // deliberately does not apply the header's INIT defaults, so an untouched field reads **0** — and
    // 0 is not "unset", it is an invalid stride. Before the sentinel was written explicitly,
    // wgpu-native took a non-unwinding panic in `conv.rs:828` on exactly this shape: exit 127, no
    // catchable error, and every remaining suite in the process gone with it.
    //
    // ⚠ Deliberately never submitted. The command buffer is invalid by construction, and submitting
    // one of those is how a negative test takes the whole run down instead of reporting.
    const d = await freshDevice("multi-layer-strides");
    const W = 64;
    const H = 4;
    const layers = 2;
    const bytesPerRow = 256;

    const tex = d.createTexture({
      size: [W, H, layers],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = d.createBuffer({
      size: bytesPerRow * H * layers,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = d.createCommandEncoder();
    d.pushErrorScope("validation");
    // WebGPU *requires* rowsPerImage once the copy spans more than one layer. Omitting it must be
    // reported as such — not filled in from `copySize.height`, which is a different request that
    // validates, and not left at 0, which used to abort.
    enc.copyTextureToBuffer({ texture: tex }, { buffer: readback, bytesPerRow }, [W, H, layers]);
    enc.finish();
    const error = await d.popErrorScope();

    expect(error).toBeTruthy();
    tex.destroy();
    readback.destroy();
  });
});
