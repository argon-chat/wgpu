/**
 * Getting pixels out — texture readback and PNG encoding.
 *
 * ── Why this is in the package at all ───────────────────────────────────────────────────────────
 *
 * Every headless user writes these two functions, and both have a trap in them.
 *
 * `copyTextureToBuffer` requires a **256-byte-aligned row stride**, so the buffer that comes back
 * is almost never the image: a 1400-pixel-wide RGBA frame arrives with 5 600 bytes of pixels and 32
 * bytes of padding per row, and code that ignores it gets a picture that shears progressively to
 * one side — which looks like a rendering bug and is not one. And the readback itself is a
 * four-step dance (staging buffer → `copyTextureToBuffer` → `mapAsync` → `getMappedRange`) whose
 * failure mode, if the texture was created without `COPY_SRC`, is an abort inside `wgpuQueueSubmit`
 * rather than an error anyone can catch.
 *
 * So: {@link readTexture} hands back **tightly packed** rows and refuses up front rather than
 * aborting later, and {@link encodePng} turns them into a file with no dependency — PNG's
 * uncompressed-scanline form is a signature, three chunks and a CRC, and `node:zlib` does the rest.
 *
 * ── Why it is a subpath, `wgpu-bun/image`, and not part of the main export ──────────────────────
 *
 * The root entry point is a compatibility surface: `create`, `globals`, `isMac`, exactly what the
 * `webgpu` package exports (see `docs/COMPATIBILITY.md`). Adding to it would mean this package no
 * longer answers "what do I get if I swap the import" with a single sentence. A subpath keeps that
 * claim exact and still puts the batteries in the box, and nothing here is imported by the binding
 * itself — a consumer who does not want it does not load it.
 */
import * as fs from "node:fs";
import { deflateSync } from "node:zlib";

import { GPUBufferUsage, GPUMapMode, GPUTextureUsage } from "./globals.ts";

/** Row stride alignment `copyTextureToBuffer` requires, in bytes. Not negotiable, not ours. */
export const BYTES_PER_ROW_ALIGNMENT = 256;

/**
 * The formats {@link readTexture} and {@link encodePng} understand: four 8-bit channels, in one of
 * the two orders hardware uses.
 *
 * Anything else — depth, 16-bit float, compressed — throws rather than being reinterpreted. A
 * plausible-looking picture derived from a misread format is worse than a refusal, because nothing
 * downstream can tell it is wrong.
 */
const CHANNEL_ORDER: Record<string, "rgba" | "bgra"> = {
  "rgba8unorm": "rgba",
  "rgba8unorm-srgb": "rgba",
  "bgra8unorm": "bgra",
  "bgra8unorm-srgb": "bgra",
};

/** A block of 8-bit RGBA-ish pixels with **no row padding**. */
export interface IPixelData {
  /** `width * height * 4` bytes, tightly packed. */
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The texture format the bytes came from — it is what decides the channel order. */
  readonly format: GPUTextureFormat;
}

export interface IReadTextureOptions {
  /** Mip level to read. Default 0. */
  readonly mipLevel?: number;
  /** Region size; defaults to the texture's own dimensions at that mip level. */
  readonly width?: number;
  readonly height?: number;
  /** Texel offset of the region. Default `[0, 0]`. */
  readonly origin?: readonly [number, number];
}

/**
 * Copy a texture back to the CPU, tightly packed.
 *
 * Submits its own command buffer and waits for the map — so it is a synchronisation point, not
 * something to call per frame in a loop.
 *
 * @throws if the texture lacks `COPY_SRC` usage, or its format is not one of the four 8-bit RGBA
 *         formats above. Both are refused here rather than becoming a validation error later; the
 *         `COPY_SRC` one in particular aborts the process at submit time if it reaches wgpu-native.
 */
export async function readTexture(
  device: GPUDevice,
  texture: GPUTexture,
  options: IReadTextureOptions = {},
): Promise<IPixelData> {
  const format = texture.format;
  if (!CHANNEL_ORDER[format]) {
    throw new Error(
      `readTexture: unsupported format ${format}. Supported: ${Object.keys(CHANNEL_ORDER).join(", ")}.\n` +
        `  Other formats are not reinterpreted, because a picture derived from a misread format is\n` +
        `  wrong in a way nothing downstream can detect. Copy into an rgba8unorm texture first.`,
    );
  }
  if ((texture.usage & GPUTextureUsage.COPY_SRC) === 0) {
    throw new Error(
      `readTexture: the texture was created without GPUTextureUsage.COPY_SRC, so it cannot be\n` +
        `  copied back. This is refused here because letting it reach wgpuQueueSubmit ABORTS the\n` +
        `  process — no exception, no stack (see docs/ABI.md).`,
    );
  }

  const mipLevel = options.mipLevel ?? 0;
  const origin = options.origin ?? [0, 0];
  const width = options.width ?? Math.max(1, texture.width >> mipLevel);
  const height = options.height ?? Math.max(1, texture.height >> mipLevel);

  const tightBytesPerRow = width * 4;
  const bytesPerRow = Math.ceil(tightBytesPerRow / BYTES_PER_ROW_ALIGNMENT) * BYTES_PER_ROW_ALIGNMENT;

  const staging = device.createBuffer({
    label: "wgpu-bun:readTexture",
    size: bytesPerRow * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  try {
    const encoder = device.createCommandEncoder({ label: "wgpu-bun:readTexture" });
    encoder.copyTextureToBuffer(
      { texture, mipLevel, origin: { x: origin[0], y: origin[1] } },
      { buffer: staging, bytesPerRow, rowsPerImage: height },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange());

    // The de-padding the whole function exists for. A caller who forgets it gets a sheared image.
    const pixels = new Uint8Array(tightBytesPerRow * height);
    for (let y = 0; y < height; y++) {
      pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + tightBytesPerRow), y * tightBytesPerRow);
    }
    staging.unmap();
    return { pixels, width, height, format };
  } finally {
    staging.destroy();
  }
}

// ── PNG ─────────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export interface IEncodePngOptions {
  /**
   * Bytes per row in the source. Defaults to `width * 4` — pass the padded stride to encode
   * straight out of a `copyTextureToBuffer` staging buffer without de-padding first.
   */
  readonly stride?: number;
  /**
   * Channel order of the source. Defaults to `rgba`; pass a `bgra*` texture format (or `"bgra"`)
   * and the encoder swizzles.
   */
  readonly format?: GPUTextureFormat | "rgba" | "bgra";
  /** zlib compression level, 0-9. Default 9 — this runs once per image, not per frame. */
  readonly level?: number;
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * Filter type 0 (None) on every scanline: deflate does the compressing, and a screenshot is not
 * where byte-shaving pays for the extra failure modes of adaptive filtering.
 */
export function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: IEncodePngOptions = {},
): Uint8Array {
  const stride = options.stride ?? width * 4;
  const order = options.format ? (CHANNEL_ORDER[options.format] ?? options.format) : "rgba";
  if (order !== "rgba" && order !== "bgra") {
    throw new Error(`encodePng: unsupported format ${String(options.format)}`);
  }
  const rowBytes = width * 4;
  if (stride * (height - 1) + rowBytes > pixels.length) {
    throw new Error(
      `encodePng: ${pixels.length} bytes is short of the ${stride * (height - 1) + rowBytes} that\n` +
        `  ${width}×${height} at a stride of ${stride} needs. If these came from copyTextureToBuffer,\n` +
        `  the stride is padded to a multiple of ${BYTES_PER_ROW_ALIGNMENT} — pass it as options.stride.`,
    );
  }

  // One filter byte per scanline, hence the +1 per row.
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (rowBytes + 1) + 1;
    raw.set(pixels.subarray(y * stride, y * stride + rowBytes), dst);
    if (order === "bgra") {
      for (let x = 0; x < rowBytes; x += 4) {
        const b = raw[dst + x]!;
        raw[dst + x] = raw[dst + x + 2]!;
        raw[dst + x + 2] = b;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate compression, adaptive filtering, no interlace.

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: options.level ?? 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];

  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/**
 * Read a texture back and write it out as a PNG — the two calls above, in the order everyone needs
 * them.
 *
 * ```ts
 * import { saveTexturePng } from 'wgpu-bun/image';
 * await saveTexturePng(device, target, 'frame.png');
 * ```
 */
export async function saveTexturePng(
  device: GPUDevice,
  texture: GPUTexture,
  path: string,
  options: IReadTextureOptions & Pick<IEncodePngOptions, "level"> = {},
): Promise<IPixelData> {
  const data = await readTexture(device, texture, options);
  fs.writeFileSync(
    path,
    encodePng(data.pixels, data.width, data.height, { format: data.format, level: options.level }),
  );
  return data;
}
