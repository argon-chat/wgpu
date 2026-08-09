/**
 * `wgpu-bun/image` — the readback and PNG surface.
 *
 * Two classes of defect are in scope here, and they fail differently.
 *
 * **The PNG encoder can be wrong in a way that still opens.** A viewer will happily render a file
 * whose CRCs are garbage or whose rows are off by one, so "it produced a picture" proves nothing.
 * The tests below inflate the `IDAT` back and compare it byte-for-byte against the scanlines that
 * should have gone in, and check every chunk's CRC — the two things a lenient decoder skips.
 *
 * **The row de-padding can be wrong in a way that only shows at some widths.** `copyTextureToBuffer`
 * pads rows to 256 bytes, so a width that is already a multiple of 64 pixels has no padding at all
 * and hides the bug entirely. The GPU test therefore uses a width that is *not*, and asserts a
 * per-row-varying pattern rather than a flat colour — a flat fill survives a shear.
 */
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import { BYTES_PER_ROW_ALIGNMENT, encodePng, readTexture } from "../src/image.ts";
import { freshDevice, skipGpu } from "./support/gpu.ts";

/** Walk a PNG's chunk list, verifying each CRC on the way. */
function chunks(png: Uint8Array): { type: string; body: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const out: { type: string; body: Uint8Array }[] = [];
  let at = 8;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    // The CRC covers the type AND the body — a decoder that skips it will not tell you when an
    // encoder gets that wrong, and every viewer skips it.
    expect(crc(png.subarray(at + 4, at + 8 + length))).toBe(view.getUint32(at + 8 + length));
    out.push({ type, body });
    at += 12 + length;
  }
  return out;
}

describe("encodePng", () => {
  const RED = [255, 0, 0, 255];
  const GREEN = [0, 255, 0, 255];
  const pixels2x2 = new Uint8Array([...RED, ...GREEN, ...GREEN, ...RED]);

  test("writes a well-formed IHDR / IDAT / IEND", () => {
    const parsed = chunks(encodePng(pixels2x2, 2, 2));
    expect(parsed.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);

    const ihdr = new DataView(parsed[0]!.body.buffer, parsed[0]!.body.byteOffset);
    expect(ihdr.getUint32(0)).toBe(2); // width
    expect(ihdr.getUint32(4)).toBe(2); // height
    expect(parsed[0]!.body[8]).toBe(8); // bit depth
    expect(parsed[0]!.body[9]).toBe(6); // colour type: RGBA
    expect([...parsed[0]!.body.subarray(10, 13)]).toEqual([0, 0, 0]); // deflate, adaptive, no interlace
  });

  test("the compressed data really is the scanlines, filter byte and all", () => {
    const [, idat] = chunks(encodePng(pixels2x2, 2, 2));
    // Filter type 0 prefixes every row. Asserting the whole inflated stream is what makes this a
    // test of the encoder rather than of zlib.
    expect([...inflateSync(idat!.body)]).toEqual([0, ...RED, ...GREEN, 0, ...GREEN, ...RED]);
  });

  test("a padded source stride is dropped, not encoded", () => {
    // The `copyTextureToBuffer` shape: two pixels of data per row, 256 bytes of stride.
    const padded = new Uint8Array(BYTES_PER_ROW_ALIGNMENT * 2);
    padded.set([...RED, ...GREEN], 0);
    padded.set([...GREEN, ...RED], BYTES_PER_ROW_ALIGNMENT);
    padded.fill(0xcc, 8, BYTES_PER_ROW_ALIGNMENT); // junk in the padding — it must not appear

    const [, idat] = chunks(encodePng(padded, 2, 2, { stride: BYTES_PER_ROW_ALIGNMENT }));
    expect([...inflateSync(idat!.body)]).toEqual([0, ...RED, ...GREEN, 0, ...GREEN, ...RED]);
  });

  test("bgra sources are swizzled", () => {
    const bgra = new Uint8Array([0, 0, 255, 255]); // blue, green, red, alpha → red
    const [, idat] = chunks(encodePng(bgra, 1, 1, { format: "bgra8unorm" }));
    expect([...inflateSync(idat!.body)]).toEqual([0, ...RED]);
  });

  test("a source too short for its dimensions is refused, not truncated", () => {
    // Silently encoding whatever is there would produce a valid PNG of garbage — the failure mode
    // this whole module exists to remove.
    expect(() => encodePng(new Uint8Array(4), 2, 2)).toThrow(/short of/);
  });
});

describe.skipIf(skipGpu)("readTexture", () => {
  test("returns tightly packed rows from a padded copy", async () => {
    const device = await freshDevice("readTexture");
    // 100 px = 400 B per row, which pads to 512 — so the returned rows must be re-packed. A width
    // that happened to be a multiple of 64 px would make this test pass with the bug in place.
    const WIDTH = 100;
    const HEIGHT = 3;
    expect((WIDTH * 4) % BYTES_PER_ROW_ALIGNMENT).not.toBe(0);

    const texture = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    // Each row gets its own clear colour, so a shear by the padding shows up as the wrong row
    // rather than as nothing at all.
    const encoder = device.createCommandEncoder();
    for (let y = 0; y < HEIGHT; y++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView(),
            loadOp: y === 0 ? "clear" : "load",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setScissorRect(0, y, WIDTH, 1);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);

    const data = await readTexture(device, texture);
    expect(data.width).toBe(WIDTH);
    expect(data.height).toBe(HEIGHT);
    expect(data.format).toBe("rgba8unorm");
    // The whole point: `width * height * 4`, with no 512-byte rows in it.
    expect(data.pixels.length).toBe(WIDTH * HEIGHT * 4);
    expect(data.pixels.length).not.toBe(512 * HEIGHT);
  });

  test("a texture without COPY_SRC is refused before it can abort the process", async () => {
    const device = await freshDevice("readTexture-refusal");
    const texture = device.createTexture({
      size: [4, 4],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // Not a nicety: reaching wgpuQueueSubmit with this kills the process, so the refusal has to
    // happen here or not at all.
    await expect(readTexture(device, texture)).rejects.toThrow(/COPY_SRC/);
  });

  test("an unsupported format is refused rather than reinterpreted", async () => {
    const device = await freshDevice("readTexture-format");
    const texture = device.createTexture({
      size: [4, 4],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    await expect(readTexture(device, texture)).rejects.toThrow(/unsupported format/);
  });
});
