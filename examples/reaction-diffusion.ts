/**
 * Gray-Scott reaction-diffusion — 4 000 compute dispatches, ping-ponged between two textures.
 *
 *     bun run examples/reaction-diffusion.ts          # → reaction-diffusion.png
 *     bun run examples/reaction-diffusion.ts out.png
 *
 * Two chemicals, `u` and `v`. `v` eats `u` and reproduces; `u` is fed in and `v` is killed off, both
 * at fixed rates; both diffuse. That is the whole model, and it produces mitosis, coral, fingerprint
 * mazes and travelling waves depending on two numbers.
 *
 * So this image varies those two numbers **across the frame** — the feed rate along x, the kill rate
 * along y — and every distinct texture in it is the same kernel run with a different pair. It is a
 * map of the model's behaviour, computed in one dispatch chain.
 *
 * What it demonstrates about the binding: a long iterative pipeline. State lives in two textures
 * that swap roles every step, so the whole simulation runs without a single round trip to the CPU —
 * 4 000 passes are encoded into one command buffer and submitted once, and the only readback is the
 * finished picture.
 */
import { create, globals } from "wgpu-bun";

import { saveTexturePng } from "wgpu-bun/image";

Object.assign(globalThis, globals);

const SIZE = 1024;
const STEPS = 4_000;

const WGSL = /* wgsl */ `
struct Params {
  size: u32,
  // Diffusion rates. v diffuses at half u's rate, which is what makes the patterns rather than a
  // uniform smear — equal rates cannot break symmetry.
  du: f32,
  dv: f32,
  dt: f32,
  feedMin: f32,
  feedMax: f32,
  killMin: f32,
  killMax: f32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rg32float, write>;

fn hash(v: vec2u) -> f32 {
  var h = v.x * 374761393u + v.y * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) * 2.3283064365386963e-10;
}

@compute @workgroup_size(8, 8, 1)
fn seed(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.size || gid.y >= p.size) { return; }
  // u saturated, v seeded as sparse single pixels. Perfectly uniform v is a fixed point — the
  // system would sit there forever — so the noise is not decoration, it is the initial condition.
  //
  // Single pixels rather than blocks: seeding a coarse hash paints square patches, and in the
  // slow-growing corners of the parameter map those squares are still visible 4 000 steps later.
  // The initial condition has to be smaller than any feature the model makes, or it becomes one.
  var v = 0.0;
  if (hash(gid.xy) > 0.995) { v = 0.5; }
  textureStore(dst, vec2i(gid.xy), vec4f(1.0, v, 0.0, 1.0));
}

/// Wrapping fetch — the domain is a torus, so patterns run off one edge and back on the other
/// instead of decaying against a wall.
fn at(x: i32, y: i32) -> vec2f {
  let n = i32(p.size);
  return textureLoad(src, vec2i((x + n) % n, (y + n) % n), 0).xy;
}

@compute @workgroup_size(8, 8, 1)
fn step(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.size || gid.y >= p.size) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let c = at(x, y);

  // Nine-point Laplacian. The five-point one is cheaper and visibly square: its patterns inherit
  // the grid's axes, and on a 4 000-step run that anisotropy accumulates into a lattice.
  let lap =
      (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 0.2
    + (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) * 0.05
    - c;

  // The parameter map: feed across the frame, kill down it.
  let fx = f32(gid.x) / f32(p.size - 1u);
  let fy = f32(gid.y) / f32(p.size - 1u);
  let feed = mix(p.feedMin, p.feedMax, fx);
  let kill = mix(p.killMin, p.killMax, fy);

  let reaction = c.x * c.y * c.y;
  let du = p.du * lap.x - reaction + feed * (1.0 - c.x);
  let dv = p.dv * lap.y + reaction - (kill + feed) * c.y;

  textureStore(dst, vec2i(gid.xy), vec4f(
    clamp(c.x + du * p.dt, 0.0, 1.0),
    clamp(c.y + dv * p.dt, 0.0, 1.0),
    0.0,
    1.0,
  ));
}

@group(0) @binding(3) var image: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn develop(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.size || gid.y >= p.size) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let v = at(x, y).y;

  // Central difference on v, used as a surface normal. The concentration field is smooth, so a
  // directional light over it reads as relief and the structures stop looking like a heat map.
  let gx = at(x + 1, y).y - at(x - 1, y).y;
  let gy = at(x, y + 1).y - at(x, y - 1).y;
  let n = normalize(vec3f(-gx * 12.0, -gy * 12.0, 1.0));
  let shade = 0.55 + 0.45 * max(dot(n, normalize(vec3f(-0.5, -0.6, 0.62))), 0.0);

  let t = smoothstep(0.04, 0.34, v);
  let deep = vec3f(0.03, 0.06, 0.13);
  let mid = vec3f(0.06, 0.42, 0.52);
  let high = vec3f(0.86, 0.94, 0.83);
  var colour = mix(deep, mid, smoothstep(0.0, 0.6, t));
  colour = mix(colour, high, smoothstep(0.55, 1.0, t));
  textureStore(image, vec2i(gid.xy), vec4f(colour * shade, 1.0));
}
`;

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter on this host");
const device = await adapter.requestDevice();

device.pushErrorScope("validation");

const module = device.createShaderModule({ label: "gray-scott", code: WGSL });
const pipelines = {
  seed: device.createComputePipeline({ label: "seed", layout: "auto", compute: { module, entryPoint: "seed" } }),
  step: device.createComputePipeline({ label: "step", layout: "auto", compute: { module, entryPoint: "step" } }),
  develop: device.createComputePipeline({
    label: "develop",
    layout: "auto",
    compute: { module, entryPoint: "develop" },
  }),
};

const params = new ArrayBuffer(32);
{
  const view = new DataView(params);
  view.setUint32(0, SIZE, true);
  view.setFloat32(4, 0.16, true); // du
  view.setFloat32(8, 0.08, true); // dv
  view.setFloat32(12, 1.0, true); // dt — the model is written for unit steps
  // The window is deliberately narrow. Outside roughly this box the system has a single stable
  // state and the frame is a flat wash — visually dead, and misleading about what the model does.
  view.setFloat32(16, 0.022, true); // feed, left edge
  view.setFloat32(20, 0.055, true); // feed, right edge
  view.setFloat32(24, 0.051, true); // kill, top
  view.setFloat32(28, 0.065, true); // kill, bottom
}
const paramsBuffer = device.createBuffer({
  size: params.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(paramsBuffer, 0, params);

/** The two chemical fields. Each is read as a sampled texture and written as a storage one. */
function field(label: string): GPUTexture {
  return device.createTexture({
    label,
    size: [SIZE, SIZE],
    format: "rg32float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
}
const fields = [field("field-a"), field("field-b")] as const;

const image = device.createTexture({
  label: "image",
  size: [SIZE, SIZE],
  format: "rgba8unorm",
  usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
});

/**
 * Two bind groups, created once and alternated — not 4 000 of them. A bind group is a real GPU
 * object; allocating one per step is the difference between a simulation and a memory profile.
 */
const stepGroups = [0, 1].map((i) =>
  device.createBindGroup({
    layout: pipelines.step.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: fields[i]!.createView() },
      { binding: 2, resource: fields[1 - i]!.createView() },
    ],
  }),
);

const encoder = device.createCommandEncoder();

{
  const pass = encoder.beginComputePass({ label: "seed" });
  pass.setPipeline(pipelines.seed);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipelines.seed.getBindGroupLayout(0),
      // `seed` never reads `src`, and an `auto` layout contains exactly the bindings its entry
      // point uses — so binding 1 must NOT be supplied here. Supplying it makes the bind group
      // invalid, and an invalid bind group is one of the two inputs that abort inside
      // `wgpuQueueSubmit` instead of reporting (docs/ABI.md).
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 2, resource: fields[0]!.createView() },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(SIZE / 8), Math.ceil(SIZE / 8));
  pass.end();
}

// All 4 000 steps in one command buffer. There is nothing for the CPU to decide between them, so
// there is no reason to hand control back.
const groups = Math.ceil(SIZE / 8);
for (let i = 0; i < STEPS; i++) {
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.step);
  pass.setBindGroup(0, stepGroups[i % 2]!);
  pass.dispatchWorkgroups(groups, groups);
  pass.end();
}

const finalField = STEPS % 2 === 0 ? 0 : 1;
{
  const pass = encoder.beginComputePass({ label: "develop" });
  pass.setPipeline(pipelines.develop);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipelines.develop.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: fields[finalField]!.createView() },
        { binding: 3, resource: image.createView() },
      ],
    }),
  );
  pass.dispatchWorkgroups(groups, groups);
  pass.end();
}

// Finish, check, *then* submit. Submitting an invalid command buffer aborts the process inside
// wgpu-native rather than reporting — the error scope and the uncaptured-error callback are both
// open and neither is consulted — so the only place a mistake can still be caught is before the
// submit. Everything up to `finish()` reports normally. See docs/ABI.md.
const commands = encoder.finish();
const error = await device.popErrorScope();
if (error) throw new Error(error.message);
device.queue.submit([commands]);

const out = process.argv[2] ?? "reaction-diffusion.png";
await saveTexturePng(device, image, out);
console.log(`wrote ${out} — ${SIZE}×${SIZE}, ${STEPS.toLocaleString("en")} ping-ponged dispatches`);
