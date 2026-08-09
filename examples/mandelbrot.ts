/**
 * A deep zoom into the Mandelbrot set.
 *
 *     bun run examples/mandelbrot.ts          # → mandelbrot.png
 *     bun run examples/mandelbrot.ts out.png
 *
 * The example that is *only* arithmetic: no scene, no state, no second pass. Every pixel is an
 * independent iteration count, which makes it the clearest possible demonstration of what the
 * dispatch is doing — two million pixels × four samples × up to 2 000 iterations, in about a second.
 *
 * Two details are what make it look like a rendering rather than a plot:
 *
 *   · **The escape count is smoothed.** `n - log2(log2|z|)` turns the integer iteration count into a
 *     continuous quantity, which is the difference between concentric bands of flat colour and a
 *     gradient. It is the whole reason this image has no visible contour lines.
 *   · **Each pixel is supersampled 4×.** The set's boundary has detail at every scale — there is no
 *     resolution at which it stops aliasing — so a single sample per pixel produces shimmer that no
 *     amount of extra resolution removes.
 *
 * The zoom is ~1.6 × 10⁴, which is comfortable in f32. Going much deeper needs f64 (which WGSL does
 * not have) or double-float emulation, and this example does not pretend otherwise — that is a
 * different demonstration.
 */
import { create, globals } from "wgpu-bun";
import { saveTexturePng } from "wgpu-bun/image";

Object.assign(globalThis, globals);

// 1080p because the committed PNG lives in this repository — at 4K the same image is a 10 MB file,
// which is a poor trade for a picture nobody zooms into. Raise these two numbers and it is 4K.
const WIDTH = 1920;
const HEIGHT = 1080;
const MAX_ITER = 2000;
/** Samples per axis; 2 means 4 per pixel. */
const SUBSAMPLES = 2;

/** A seahorse-valley view: the boundary between the main cardioid and the period-2 bulb. */
const CENTRE_X = -0.743643887037151;
const CENTRE_Y = 0.13182590420533;
const SCALE = 0.00009;

const WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  maxIter: u32,
  subsamples: u32,
  centreX: f32,
  centreY: f32,
  scale: f32,
  aspect: f32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var image: texture_storage_2d<rgba8unorm, write>;

/// Iterate z → z² + c, returning a CONTINUOUS escape time, or 0 for points that never escape.
///
/// The bailout is 256 rather than 2. Both are correct as escape tests, but the smoothing term is
/// only accurate once |z| is well past the escape radius — at a bailout of 2 the correction is
/// wrong by a visible fraction of an iteration, and that error is exactly the banding it was
/// supposed to remove.
fn escapeTime(cx: f32, cy: f32) -> f32 {
  var x = 0.0;
  var y = 0.0;
  var x2 = 0.0;
  var y2 = 0.0;
  var i = 0u;
  // The classic three-multiply inner loop: keeping x² and y² around removes one multiply per
  // iteration compared with the naive form, and this loop runs 16 billion times in this image.
  loop {
    if (i >= p.maxIter || x2 + y2 > 65536.0) { break; }
    y = 2.0 * x * y + cy;
    x = x2 - y2 + cx;
    x2 = x * x;
    y2 = y * y;
    i = i + 1u;
  }
  if (i >= p.maxIter) { return 0.0; }
  return f32(i) + 1.0 - log2(max(log2(sqrt(x2 + y2)), 1e-6));
}

/// A cyclic palette in the spirit of the Ultra Fractal one: five stops swept through repeatedly, so
/// depth reads as colour rather than as brightness alone.
fn palette(t: f32) -> vec3f {
  let x = fract(t) * 5.0;
  let i = floor(x);
  let f = x - i;
  var a = vec3f(0.0, 0.03, 0.39);
  var b = vec3f(0.13, 0.42, 0.80);
  if (i < 1.0) { a = vec3f(0.0, 0.03, 0.39); b = vec3f(0.13, 0.42, 0.80); }
  else if (i < 2.0) { a = vec3f(0.13, 0.42, 0.80); b = vec3f(0.93, 0.97, 0.99); }
  else if (i < 3.0) { a = vec3f(0.93, 0.97, 0.99); b = vec3f(1.0, 0.67, 0.0); }
  else if (i < 4.0) { a = vec3f(1.0, 0.67, 0.0); b = vec3f(0.61, 0.15, 0.02); }
  else { a = vec3f(0.61, 0.15, 0.02); b = vec3f(0.0, 0.03, 0.39); }
  // Smoothstep rather than a linear mix: a linear ramp between stops has a visible crease at every
  // stop, which on a cyclic palette becomes five concentric rings.
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.width || gid.y >= p.height) { return; }

  let n = f32(p.subsamples);
  var colour = vec3f(0.0);
  for (var sy = 0u; sy < p.subsamples; sy = sy + 1u) {
    for (var sx = 0u; sx < p.subsamples; sx = sx + 1u) {
      let px = (f32(gid.x) + (f32(sx) + 0.5) / n) / f32(p.width) * 2.0 - 1.0;
      let py = 1.0 - (f32(gid.y) + (f32(sy) + 0.5) / n) / f32(p.height) * 2.0;
      let cx = p.centreX + px * p.scale * p.aspect;
      let cy = p.centreY + py * p.scale;

      let t = escapeTime(cx, cy);
      if (t > 0.0) {
        // sqrt compresses the escape time: without it the palette cycles far too fast in the deep
        // filaments and the image turns into noise.
        colour = colour + palette(sqrt(t) * 0.11);
      }
      // Interior points contribute black, which is what makes the set itself solid.
    }
  }
  colour = colour / (n * n);
  textureStore(image, vec2i(gid.xy), vec4f(colour, 1.0));
}
`;

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter on this host");
const device = await adapter.requestDevice();

device.pushErrorScope("validation");

const module = device.createShaderModule({ label: "mandelbrot", code: WGSL });
const pipeline = device.createComputePipeline({
  label: "mandelbrot",
  layout: "auto",
  compute: { module, entryPoint: "main" },
});

const params = new ArrayBuffer(32);
{
  const view = new DataView(params);
  view.setUint32(0, WIDTH, true);
  view.setUint32(4, HEIGHT, true);
  view.setUint32(8, MAX_ITER, true);
  view.setUint32(12, SUBSAMPLES, true);
  view.setFloat32(16, CENTRE_X, true);
  view.setFloat32(20, CENTRE_Y, true);
  view.setFloat32(24, SCALE, true);
  view.setFloat32(28, WIDTH / HEIGHT, true);
}
const paramsBuffer = device.createBuffer({
  size: params.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(paramsBuffer, 0, params);

const image = device.createTexture({
  label: "image",
  size: [WIDTH, HEIGHT],
  format: "rgba8unorm",
  usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass({ label: "iterate" });
pass.setPipeline(pipeline);
pass.setBindGroup(
  0,
  device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: image.createView() },
    ],
  }),
);
pass.dispatchWorkgroups(Math.ceil(WIDTH / 8), Math.ceil(HEIGHT / 8));
pass.end();
device.queue.submit([encoder.finish()]);

const error = await device.popErrorScope();
if (error) throw new Error(error.message);

const out = process.argv[2] ?? "mandelbrot.png";
await saveTexturePng(device, image, out);
console.log(
  `wrote ${out} — ${WIDTH}×${HEIGHT}, ≤${MAX_ITER} iterations × ${SUBSAMPLES * SUBSAMPLES} samples/px ` +
    `at ${(0.5 / SCALE).toFixed(0)}× zoom`,
);
