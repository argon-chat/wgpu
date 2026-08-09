/**
 * A path tracer, in one compute dispatch.
 *
 *     bun run examples/pathtracer.ts          # → pathtracer.png
 *     bun run examples/pathtracer.ts out.png
 *
 * A Cornell-style box with a spherical light, traced with cosine-weighted diffuse bounces and a
 * dielectric and a metal to make the difference between the two visible. 1 024 samples per pixel,
 * 8 bounces, at 900×900 — the kind of workload that is a coffee break on a CPU and about a second
 * here.
 *
 * Why it belongs in this package's examples: this is the shape of the work a headless GPU binding
 * is *for*. There is no frame loop, no interactivity and no window; there is one very large amount
 * of arithmetic, and then an image. Everything about the pipeline is the boring part — a uniform
 * buffer, one storage texture, one dispatch — and that is the point.
 *
 * The whole scene lives in the shader as constants. That keeps the example about the GPU rather
 * than about a scene format, and it lets the compiler see the geometry, which is worth a good deal
 * of the speed.
 */
import { create, globals } from "wgpu-bun";
import { saveTexturePng } from "wgpu-bun/image";

Object.assign(globalThis, globals);

const WIDTH = 900;
const HEIGHT = 900;
const SAMPLES = 4096;
const BOUNCES = 8;

const WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  samples: u32,
  bounces: u32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var image: texture_storage_2d<rgba8unorm, write>;

// ── material kinds ─────────────────────────────────────────────────────────────────────────────
const DIFFUSE: u32 = 0u;
const METAL: u32 = 1u;
const GLASS: u32 = 2u;

struct Sphere {
  centre: vec3f,
  radius: f32,
  albedo: vec3f,
  kind: u32,
  emission: vec3f,
  fuzz: f32,
}

/// The box is five enormous spheres, which is a trick worth knowing: a sphere of radius 10 000 is
/// flat to within a rounding error over a two-metre room, so the whole scene needs one intersection
/// routine instead of two. Planes would be cheaper and would double the code.
const SCENE = array<Sphere, 9>(
  // walls
  Sphere(vec3f( 0.0, -10000.0,   0.0), 10000.0, vec3f(0.73, 0.73, 0.73), DIFFUSE, vec3f(0.0), 0.0),
  Sphere(vec3f( 0.0,  10002.0,   0.0), 10000.0, vec3f(0.73, 0.73, 0.73), DIFFUSE, vec3f(0.0), 0.0),
  Sphere(vec3f( 0.0,      0.0, -10002.0), 10000.0, vec3f(0.73, 0.73, 0.73), DIFFUSE, vec3f(0.0), 0.0),
  Sphere(vec3f(-10001.0,  0.0,   0.0), 10000.0, vec3f(0.75, 0.16, 0.16), DIFFUSE, vec3f(0.0), 0.0),
  Sphere(vec3f( 10001.0,  0.0,   0.0), 10000.0, vec3f(0.16, 0.45, 0.75), DIFFUSE, vec3f(0.0), 0.0),
  // light — a sphere rather than a quad, so the soft shadow comes from real area sampling
  Sphere(vec3f( 0.0, 2.42, -0.6), 0.55, vec3f(0.0), DIFFUSE, vec3f(14.0, 12.4, 10.4), 0.0),
  // contents
  Sphere(vec3f(-0.42, 0.34, -1.05), 0.34, vec3f(0.99, 0.99, 0.99), GLASS,   vec3f(0.0), 0.0),
  Sphere(vec3f( 0.42, 0.38, -0.55), 0.38, vec3f(0.95, 0.85, 0.55), METAL,   vec3f(0.0), 0.03),
  Sphere(vec3f(-0.10, 0.20, -0.15), 0.20, vec3f(0.30, 0.72, 0.45), DIFFUSE, vec3f(0.0), 0.0),
);

// ── rng ────────────────────────────────────────────────────────────────────────────────────────
// PCG. A weak hash shows up as visible structure in the noise — correlated pixels look like a
// pattern in the image, not like grain — and at 1 024 samples there is nowhere for it to hide.
var<private> rngState: u32;

fn rand() -> f32 {
  rngState = rngState * 747796405u + 2891336453u;
  var word = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word) * 2.3283064365386963e-10;
}

/// Cosine-weighted hemisphere direction, built by normalising a point on a unit sphere offset by
/// the normal. Cosine weighting is what lets the diffuse BRDF's cosθ/π factor cancel against the pdf,
/// so a bounce costs one multiply by the albedo and nothing else.
fn cosineHemisphere(n: vec3f) -> vec3f {
  let z = rand() * 2.0 - 1.0;
  let a = rand() * 6.28318530718;
  let r = sqrt(1.0 - z * z);
  return normalize(n + vec3f(r * cos(a), r * sin(a), z));
}

struct Hit {
  t: f32,
  point: vec3f,
  normal: vec3f,
  index: u32,
  front: bool,
}

fn intersect(origin: vec3f, dir: vec3f) -> Hit {
  var best: Hit;
  best.t = 1e30;
  best.index = 0u;
  for (var i = 0u; i < 9u; i = i + 1u) {
    let s = SCENE[i];
    let oc = origin - s.centre;
    let b = dot(oc, dir);
    let c = dot(oc, oc) - s.radius * s.radius;
    let disc = b * b - c;
    if (disc < 0.0) { continue; }
    let sq = sqrt(disc);
    var t = -b - sq;
    if (t < 0.001) { t = -b + sq; }
    if (t < 0.001 || t >= best.t) { continue; }
    best.t = t;
    best.index = i;
    best.point = origin + dir * t;
    let outward = (best.point - s.centre) / s.radius;
    best.front = dot(dir, outward) < 0.0;
    best.normal = select(-outward, outward, best.front);
  }
  return best;
}

/// Schlick's approximation to the Fresnel term — the reason a glass ball is a mirror at its rim and
/// a window at its centre.
fn schlick(cosine: f32, ratio: f32) -> f32 {
  var r0 = (1.0 - ratio) / (1.0 + ratio);
  r0 = r0 * r0;
  return r0 + (1.0 - r0) * pow(1.0 - cosine, 5.0);
}

fn trace(startOrigin: vec3f, startDir: vec3f) -> vec3f {
  var origin = startOrigin;
  var dir = startDir;
  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);

  for (var bounce = 0u; bounce < p.bounces; bounce = bounce + 1u) {
    let hit = intersect(origin, dir);
    if (hit.t >= 1e29) {
      // Nothing outside the box. A grey environment here would light the scene through the walls'
      // seams and quietly flatten everything.
      break;
    }
    let s = SCENE[hit.index];
    radiance = radiance + throughput * s.emission;

    if (s.kind == DIFFUSE) {
      throughput = throughput * s.albedo;
      dir = cosineHemisphere(hit.normal);
    } else if (s.kind == METAL) {
      throughput = throughput * s.albedo;
      dir = normalize(reflect(dir, hit.normal) + cosineHemisphere(hit.normal) * s.fuzz);
      if (dot(dir, hit.normal) <= 0.0) { break; }
    } else {
      // Glass: refract, or reflect when Snell has no solution or Fresnel says so.
      let ratio = select(1.5, 1.0 / 1.5, hit.front);
      let cosTheta = min(dot(-dir, hit.normal), 1.0);
      let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
      if (ratio * sinTheta > 1.0 || schlick(cosTheta, ratio) > rand()) {
        dir = reflect(dir, hit.normal);
      } else {
        dir = refract(dir, hit.normal, ratio);
      }
    }
    origin = hit.point + hit.normal * select(-0.0005, 0.0005, dot(dir, hit.normal) > 0.0);

    // Russian roulette. Without it the loop always runs to the bounce limit and spends most of its
    // time on paths that carry almost no energy; with it, the estimator stays unbiased because the
    // survivors are scaled by exactly the probability that killed the others.
    if (bounce > 2u) {
      let q = max(throughput.x, max(throughput.y, throughput.z));
      if (rand() > q) { break; }
      throughput = throughput / max(q, 1e-4);
    }
  }
  return radiance;
}

fn tonemapACES(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn encodeSrgb(x: vec3f) -> vec3f {
  let lo = x * 12.92;
  let hi = 1.055 * pow(max(x, vec3f(1e-5)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.width || gid.y >= p.height) { return; }
  rngState = gid.x * 1973u + gid.y * 9277u + 26699u;

  let origin = vec3f(0.0, 1.0, 3.2);
  let aspect = f32(p.width) / f32(p.height);
  let tanHalfFov = tan(0.5 * 0.72);

  var colour = vec3f(0.0);
  for (var s = 0u; s < p.samples; s = s + 1u) {
    // Jitter inside the pixel: the same stratification that antialiases the edges also antialiases
    // the shadow boundaries, for free, because both are just more samples of the same integral.
    let px = (f32(gid.x) + rand()) / f32(p.width) * 2.0 - 1.0;
    let py = 1.0 - (f32(gid.y) + rand()) / f32(p.height) * 2.0;
    let dir = normalize(vec3f(px * tanHalfFov * aspect, py * tanHalfFov, -1.0));
    colour = colour + trace(origin, dir);
  }
  colour = colour / f32(p.samples);

  textureStore(image, vec2i(gid.xy), vec4f(encodeSrgb(tonemapACES(colour)), 1.0));
}
`;

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter on this host");
const device = await adapter.requestDevice();

device.pushErrorScope("validation");

const module = device.createShaderModule({ label: "pathtracer", code: WGSL });
const pipeline = device.createComputePipeline({
  label: "pathtracer",
  layout: "auto",
  compute: { module, entryPoint: "main" },
});

const params = new ArrayBuffer(16);
{
  const view = new DataView(params);
  view.setUint32(0, WIDTH, true);
  view.setUint32(4, HEIGHT, true);
  view.setUint32(8, SAMPLES, true);
  view.setUint32(12, BOUNCES, true);
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
const pass = encoder.beginComputePass({ label: "trace" });
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

const started = performance.now();
const out = process.argv[2] ?? "pathtracer.png";
await saveTexturePng(device, image, out);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(
  `wrote ${out} — ${WIDTH}×${HEIGHT}, ${SAMPLES} spp × ${BOUNCES} bounces ` +
    `(${((WIDTH * HEIGHT * SAMPLES) / 1e6).toFixed(0)} M primary rays, ${seconds}s to readback)`,
);
