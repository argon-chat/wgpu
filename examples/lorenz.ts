/**
 * The Lorenz attractor, integrated and plotted entirely on the GPU.
 *
 *     bun run examples/lorenz.ts              # → lorenz.png
 *     bun run examples/lorenz.ts out.png
 *
 * Two compute passes and no render pass at all — which is the example's point. Nothing here needs a
 * rasteriser, a canvas, or a window; it needs a device, and Bun can now have one.
 *
 *   1. **Integrate.** 65 536 trajectories, each stepped 3 000 times with RK4, atomically
 *      accumulating a hit count per pixel. 196 million atomic adds into one storage buffer.
 *   2. **Develop.** A second kernel reads that density, takes its logarithm and maps it through a
 *      colour ramp into an `rgba8unorm` storage texture — the same "expose the histogram, don't
 *      clip it" move a photographic print does, for the same reason: the density between the two
 *      lobes and the density on the strands differ by three orders of magnitude.
 *
 * The particles all start in a tiny cloud. They stay together for a while, and then they do not —
 * that separation *is* the butterfly effect, and the picture is what it leaves behind.
 */
import { create, globals } from "wgpu-bun";

import { saveTexturePng } from "wgpu-bun/image";

Object.assign(globalThis, globals);

const WIDTH = 1400;
const HEIGHT = 1000;

const PARTICLES = 65_536;
const STEPS = 3_000;
const WORKGROUP = 256;

const WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  particles: u32,
  steps: u32,
  sigma: f32,
  rho: f32,
  beta: f32,
  dt: f32,
  // The world window mapped onto the image: x ∈ [minX, maxX], z ∈ [minZ, maxZ].
  minX: f32,
  maxX: f32,
  minZ: f32,
  maxZ: f32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> density: array<atomic<u32>>;

/// The Lorenz system: convection rolls in a fluid heated from below.
fn lorenz(v: vec3f) -> vec3f {
  return vec3f(
    p.sigma * (v.y - v.x),
    v.x * (p.rho - v.z) - v.y,
    v.x * v.y - p.beta * v.z,
  );
}

/// Classic RK4. Euler would drift off the attractor over 3 000 steps and draw a thicker, blurrier
/// shape — the integrator is visible in the output here, not an implementation detail.
fn step(v: vec3f, dt: f32) -> vec3f {
  let k1 = lorenz(v);
  let k2 = lorenz(v + k1 * (dt * 0.5));
  let k3 = lorenz(v + k2 * (dt * 0.5));
  let k4 = lorenz(v + k3 * dt);
  return v + (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (dt / 6.0);
}

/// A cheap integer hash, so every trajectory gets a different starting point without uploading one.
fn hash(x: u32) -> f32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) * 2.3283064365386963e-10;
}

@compute @workgroup_size(${WORKGROUP}, 1, 1)
fn integrate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= p.particles) { return; }

  // All 65 536 start inside a 0.02-wide cube. Divergence does the rest.
  var v = vec3f(
    -8.0 + hash(i * 3u + 0u) * 0.02,
     8.0 + hash(i * 3u + 1u) * 0.02,
    27.0 + hash(i * 3u + 2u) * 0.02,
  );

  let sx = f32(p.width) / (p.maxX - p.minX);
  let sz = f32(p.height) / (p.maxZ - p.minZ);

  for (var s = 0u; s < p.steps; s = s + 1u) {
    v = step(v, p.dt);

    // Plot x against z — the projection the attractor is famous in.
    let px = i32((v.x - p.minX) * sx);
    let py = i32(f32(p.height) - (v.z - p.minZ) * sz);
    if (px >= 0 && px < i32(p.width) && py >= 0 && py < i32(p.height)) {
      atomicAdd(&density[u32(py) * p.width + u32(px)], 1u);
    }
  }
}

@group(0) @binding(2) var outImage: texture_storage_2d<rgba8unorm, write>;

/// Inferno-ish ramp: a perceptual sweep from black through violet and orange to white. Written as a
/// few mixes rather than a lookup table so the kernel carries no extra binding.
fn ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  let c0 = vec3f(0.02, 0.01, 0.06);
  let c1 = vec3f(0.31, 0.07, 0.42);
  let c2 = vec3f(0.72, 0.22, 0.33);
  let c3 = vec3f(0.97, 0.55, 0.10);
  let c4 = vec3f(0.99, 0.94, 0.72);
  if (x < 0.25) { return mix(c0, c1, x / 0.25); }
  if (x < 0.50) { return mix(c1, c2, (x - 0.25) / 0.25); }
  if (x < 0.75) { return mix(c2, c3, (x - 0.50) / 0.25); }
  return mix(c3, c4, (x - 0.75) / 0.25);
}

@compute @workgroup_size(8, 8, 1)
fn develop(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.width || gid.y >= p.height) { return; }
  let n = f32(atomicLoad(&density[gid.y * p.width + gid.x]));

  // log(1 + n) normalised against a fixed ceiling. A linear map would show the two dense lobes and
  // nothing else — the strands that make the shape readable are three decades below them.
  let t = log(1.0 + n) / log(1.0 + 6000.0);
  textureStore(outImage, vec2i(gid.xy), vec4f(ramp(t), 1.0));
}
`;

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter on this host");
const device = await adapter.requestDevice();

device.pushErrorScope("validation");

const module = device.createShaderModule({ label: "lorenz", code: WGSL });
const integratePipeline = device.createComputePipeline({
  label: "integrate",
  layout: "auto",
  compute: { module, entryPoint: "integrate" },
});
const developPipeline = device.createComputePipeline({
  label: "develop",
  layout: "auto",
  compute: { module, entryPoint: "develop" },
});

const params = new ArrayBuffer(48);
{
  const view = new DataView(params);
  view.setUint32(0, WIDTH, true);
  view.setUint32(4, HEIGHT, true);
  view.setUint32(8, PARTICLES, true);
  view.setUint32(12, STEPS, true);
  view.setFloat32(16, 10, true); // sigma  — Prandtl number
  view.setFloat32(20, 28, true); // rho    — Rayleigh number, above the critical value
  view.setFloat32(24, 8 / 3, true); // beta — geometric factor
  view.setFloat32(28, 0.004, true); // dt
  view.setFloat32(32, -26, true);
  view.setFloat32(36, 26, true);
  view.setFloat32(40, 0, true);
  view.setFloat32(44, 52, true);
}
const paramsBuffer = device.createBuffer({
  size: params.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(paramsBuffer, 0, params);

const density = device.createBuffer({
  label: "density",
  size: WIDTH * HEIGHT * 4,
  usage: GPUBufferUsage.STORAGE,
});

const image = device.createTexture({
  label: "image",
  size: [WIDTH, HEIGHT],
  format: "rgba8unorm",
  usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
});


const encoder = device.createCommandEncoder();

{
  const pass = encoder.beginComputePass({ label: "integrate" });
  pass.setPipeline(integratePipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: integratePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: density } },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(PARTICLES / WORKGROUP));
  pass.end();
}

{
  const pass = encoder.beginComputePass({ label: "develop" });
  pass.setPipeline(developPipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: developPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: density } },
        { binding: 2, resource: image.createView() },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(WIDTH / 8), Math.ceil(HEIGHT / 8));
  pass.end();
}

device.queue.submit([encoder.finish()]);

const error = await device.popErrorScope();
if (error) throw new Error(error.message);

const out = process.argv[2] ?? "lorenz.png";
await saveTexturePng(device, image, out);
console.log(
  `wrote ${out} — ${WIDTH}×${HEIGHT}, ` +
    `${PARTICLES.toLocaleString("en")} trajectories × ${STEPS.toLocaleString("en")} RK4 steps`,
);
