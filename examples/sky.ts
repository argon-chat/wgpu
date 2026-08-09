/**
 * A physically-based sky, rendered headless.
 *
 *     bun run examples/sky.ts                 # → sky.png
 *     bun run examples/sky.ts out.png
 *
 * Four passes, which is the point of the example: two precompute kernels build lookup tables, a
 * third ray-marches the visible sky into a 192×108 image, and a fullscreen shader turns that into
 * pixels. The shaders are a WGSL port of RedPewEngine's Hillaire 2020 atmosphere — see
 * `sky.wgsl.ts` for what was kept and what was left behind.
 *
 * Nothing here is a canvas. The whole thing runs in Bun, on a device that never presents to a
 * window, and the last thing it touches is a PNG encoder.
 */
import { create, globals } from "wgpu-bun";

import { saveTexturePng } from "wgpu-bun/image";
import { ATMOSPHERE_WGSL, BACKGROUND_WGSL, MULTISCATTER_WGSL, SKYVIEW_WGSL, TRANSMITTANCE_WGSL } from "./sky.wgsl.ts";

Object.assign(globalThis, globals);

const WIDTH = 1600;
const HEIGHT = 900;

const TRANSMITTANCE_SIZE = [256, 64] as const;
const MULTISCATTER_SIZE = [32, 32] as const;
const SKYVIEW_SIZE = [192, 108] as const;

/**
 * Earth, in kilometres. The coefficients are the standard literature values (Bruneton-Neyret /
 * Hillaire) and are the reason the units are kilometres — they paste in without a power-of-ten
 * rewrite, and f32 has a fixed *relative* precision, so nothing is bought or lost numerically.
 */
const EARTH = {
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3],
  mieScattering: [3.996e-3, 3.996e-3, 3.996e-3],
  mieExtinction: [4.44e-3, 4.44e-3, 4.44e-3],
  ozoneAbsorption: [0.65e-3, 1.881e-3, 0.085e-3],
  groundAlbedo: [0.1, 0.09, 0.08],
  planetRadius: 6360,
  atmosphereRadius: 6460,
  rayleighScaleHeight: 8,
  mieScaleHeight: 1.2,
  ozoneCenter: 25,
  ozoneHalfWidth: 15,
  mieAnisotropy: 0.8,
  multiScatteringFactor: 1,
};

/** Camera and sun. A low sun is what makes the aerosol lobe and the ozone tent both visible. */
const SUN_ELEVATION_DEG = 1.6;
/** Angular radius of the sun, degrees. Half of the familiar 0.53° disc. */
const SUN_ANGULAR_RADIUS_DEG = 0.2665;
/** Top-of-atmosphere illuminance, lux. */
const SUN_ILLUMINANCE = 120_000;
/** Limb darkening `u` in `I(μ)/I(1) = 1 − u(1 − μ)`. */
const SUN_LIMB = 0.6;
const CAMERA_ALTITUDE_KM = 0.35;
/** Degrees between where the camera looks and where the sun is. */
const CAMERA_AZIMUTH_OFFSET_DEG = 22;
const CAMERA_PITCH_DEG = 11;
const CAMERA_FOV_DEG = 60;
/** Scene radiance is in cd/m²; this is the one place it becomes a display value. */
const EXPOSURE = 1 / 9000;

/** `Atmosphere` occupies 112 bytes: five `vec4f`, then eight `f32`. */
const ATMOSPHERE_BYTES = 112;

function writeAtmosphere(view: DataView, base: number): void {
  const vec4 = (offset: number, v: readonly number[]) => {
    view.setFloat32(base + offset + 0, v[0]!, true);
    view.setFloat32(base + offset + 4, v[1]!, true);
    view.setFloat32(base + offset + 8, v[2]!, true);
    view.setFloat32(base + offset + 12, 0, true);
  };
  vec4(0, EARTH.rayleighScattering);
  vec4(16, EARTH.mieScattering);
  vec4(32, EARTH.mieExtinction);
  vec4(48, EARTH.ozoneAbsorption);
  vec4(64, EARTH.groundAlbedo);
  const scalars = [
    EARTH.planetRadius,
    EARTH.atmosphereRadius,
    EARTH.rayleighScaleHeight,
    EARTH.mieScaleHeight,
    EARTH.ozoneCenter,
    EARTH.ozoneHalfWidth,
    EARTH.mieAnisotropy,
    EARTH.multiScatteringFactor,
  ];
  scalars.forEach((v, i) => view.setFloat32(base + 80 + i * 4, v, true));
}

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter on this host");
const device = await adapter.requestDevice();

device.pushErrorScope("validation");

/** A LUT: written by a compute pass as a storage texture, read by the next one as a sampled one. */
function lut(label: string, size: readonly [number, number]): GPUTexture {
  return device.createTexture({
    label,
    size: [size[0], size[1]],
    format: "rgba16float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
}

const transmittance = lut("transmittance", TRANSMITTANCE_SIZE);
const multiScatter = lut("multiscatter", MULTISCATTER_SIZE);
const skyView = lut("skyview", SKYVIEW_SIZE);

function uniformBuffer(label: string, bytes: number): GPUBuffer {
  return device.createBuffer({ label, size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}

function computePipeline(label: string, code: string): GPUComputePipeline {
  const module = device.createShaderModule({ label, code: ATMOSPHERE_WGSL + code });
  return device.createComputePipeline({ label, layout: "auto", compute: { module, entryPoint: "main" } });
}

// ── pass 1: transmittance ──────────────────────────────────────────────────────────────────────

const transmittancePipeline = computePipeline("transmittance", TRANSMITTANCE_WGSL);
const transmittanceUniforms = uniformBuffer("transmittance", 128);
{
  const buf = new ArrayBuffer(128);
  const view = new DataView(buf);
  writeAtmosphere(view, 0);
  view.setUint32(ATMOSPHERE_BYTES + 0, TRANSMITTANCE_SIZE[0], true);
  view.setUint32(ATMOSPHERE_BYTES + 4, TRANSMITTANCE_SIZE[1], true);
  device.queue.writeBuffer(transmittanceUniforms, 0, buf);
}

// ── pass 2: multiple scattering ────────────────────────────────────────────────────────────────

const multiScatterPipeline = computePipeline("multiscatter", MULTISCATTER_WGSL);
const multiScatterUniforms = uniformBuffer("multiscatter", 128);
{
  const buf = new ArrayBuffer(128);
  const view = new DataView(buf);
  writeAtmosphere(view, 0);
  view.setUint32(ATMOSPHERE_BYTES + 0, MULTISCATTER_SIZE[0], true);
  view.setUint32(ATMOSPHERE_BYTES + 4, MULTISCATTER_SIZE[1], true);
  view.setUint32(ATMOSPHERE_BYTES + 8, TRANSMITTANCE_SIZE[0], true);
  view.setUint32(ATMOSPHERE_BYTES + 12, TRANSMITTANCE_SIZE[1], true);
  device.queue.writeBuffer(multiScatterUniforms, 0, buf);
}

// ── pass 3: sky view ───────────────────────────────────────────────────────────────────────────

const sunElevation = (SUN_ELEVATION_DEG * Math.PI) / 180;
const sunDir = [Math.cos(sunElevation), Math.sin(sunElevation), 0] as const;

const skyViewPipeline = computePipeline("skyview", SKYVIEW_WGSL);
const skyViewUniforms = uniformBuffer("skyview", 176);
{
  const buf = new ArrayBuffer(176);
  const view = new DataView(buf);
  writeAtmosphere(view, 0);
  view.setFloat32(112, sunDir[0], true);
  view.setFloat32(116, sunDir[1], true);
  view.setFloat32(120, sunDir[2], true);
  view.setFloat32(128, SUN_ILLUMINANCE, true);
  view.setFloat32(132, SUN_ILLUMINANCE, true);
  view.setFloat32(136, SUN_ILLUMINANCE, true);
  view.setUint32(144, SKYVIEW_SIZE[0], true);
  view.setUint32(148, SKYVIEW_SIZE[1], true);
  view.setUint32(152, TRANSMITTANCE_SIZE[0], true);
  view.setUint32(156, TRANSMITTANCE_SIZE[1], true);
  view.setUint32(160, MULTISCATTER_SIZE[0], true);
  view.setUint32(164, MULTISCATTER_SIZE[1], true);
  view.setFloat32(168, CAMERA_ALTITUDE_KM, true);
  device.queue.writeBuffer(skyViewUniforms, 0, buf);
}

// ── pass 4: the frame ──────────────────────────────────────────────────────────────────────────

const backgroundModule = device.createShaderModule({ label: "sky-physical", code: ATMOSPHERE_WGSL + BACKGROUND_WGSL });
const backgroundPipeline = device.createRenderPipeline({
  label: "sky-physical",
  layout: "auto",
  vertex: { module: backgroundModule, entryPoint: "vs" },
  fragment: { module: backgroundModule, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});

const backgroundUniforms = uniformBuffer("sky-physical", 240);
{
  // The camera basis. Right-handed, up = +Y, built by hand because three normalised vectors are
  // less to get wrong in an example than an inverse view-projection matrix.
  const azimuth = (CAMERA_AZIMUTH_OFFSET_DEG * Math.PI) / 180;
  const pitch = (CAMERA_PITCH_DEG * Math.PI) / 180;
  const forward = [
    Math.cos(pitch) * Math.cos(azimuth),
    Math.sin(pitch),
    Math.cos(pitch) * Math.sin(azimuth),
  ] as const;
  const right = [Math.sin(azimuth), 0, -Math.cos(azimuth)] as const;
  // forward × right, in that order. The other order points the camera's up at the ground, and the
  // frame comes back vertically mirrored — which reads as a plausible sky until you notice the
  // horizon is lit from underneath.
  const up = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ] as const;

  const sunAngularRadius = (SUN_ANGULAR_RADIUS_DEG * Math.PI) / 180;
  // Radiance of the disc = illuminance / solid angle. Ω = 2π(1 − cos θ) for a cone of half-angle θ.
  const solidAngle = 2 * Math.PI * (1 - Math.cos(sunAngularRadius));
  const discRadiance = SUN_ILLUMINANCE / solidAngle;

  const buf = new ArrayBuffer(240);
  const view = new DataView(buf);
  writeAtmosphere(view, 0);
  const vec4 = (offset: number, v: readonly number[], w = 0) => {
    view.setFloat32(offset + 0, v[0]!, true);
    view.setFloat32(offset + 4, v[1]!, true);
    view.setFloat32(offset + 8, v[2]!, true);
    view.setFloat32(offset + 12, w, true);
  };
  vec4(112, sunDir, Math.cos(sunAngularRadius));
  vec4(128, [discRadiance, discRadiance, discRadiance], SUN_LIMB);
  vec4(144, [SUN_ILLUMINANCE, SUN_ILLUMINANCE, SUN_ILLUMINANCE]);
  vec4(160, right);
  vec4(176, up);
  vec4(192, forward);
  view.setFloat32(208, SKYVIEW_SIZE[0], true);
  view.setFloat32(212, SKYVIEW_SIZE[1], true);
  view.setFloat32(216, TRANSMITTANCE_SIZE[0], true);
  view.setFloat32(220, TRANSMITTANCE_SIZE[1], true);
  view.setFloat32(224, CAMERA_ALTITUDE_KM, true);
  view.setFloat32(228, EXPOSURE, true);
  view.setFloat32(232, Math.tan((CAMERA_FOV_DEG * Math.PI) / 360), true);
  view.setFloat32(236, WIDTH / HEIGHT, true);
  device.queue.writeBuffer(backgroundUniforms, 0, buf);
}

const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
const target = device.createTexture({
  label: "frame",
  size: [WIDTH, HEIGHT],
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

const encoder = device.createCommandEncoder();

{
  const pass = encoder.beginComputePass({ label: "transmittance" });
  pass.setPipeline(transmittancePipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: transmittancePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: transmittanceUniforms } },
        { binding: 1, resource: transmittance.createView() },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(TRANSMITTANCE_SIZE[0] / 8), Math.ceil(TRANSMITTANCE_SIZE[1] / 8));
  pass.end();
}

{
  // One workgroup per texel: 64 threads are 64 directions over the sphere, reduced in workgroup
  // memory. Not one thread per texel — the reduction is the algorithm.
  const pass = encoder.beginComputePass({ label: "multiscatter" });
  pass.setPipeline(multiScatterPipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: multiScatterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: multiScatterUniforms } },
        { binding: 1, resource: transmittance.createView() },
        { binding: 2, resource: multiScatter.createView() },
      ],
    }),
  );
  pass.dispatchWorkgroups(MULTISCATTER_SIZE[0], MULTISCATTER_SIZE[1]);
  pass.end();
}

{
  const pass = encoder.beginComputePass({ label: "skyview" });
  pass.setPipeline(skyViewPipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: skyViewPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: skyViewUniforms } },
        { binding: 1, resource: transmittance.createView() },
        { binding: 2, resource: multiScatter.createView() },
        { binding: 3, resource: skyView.createView() },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(SKYVIEW_SIZE[0] / 8), Math.ceil(SKYVIEW_SIZE[1] / 8));
  pass.end();
}

{
  const pass = encoder.beginRenderPass({
    label: "sky-physical",
    colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  pass.setPipeline(backgroundPipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: backgroundPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: backgroundUniforms } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: skyView.createView() },
        { binding: 3, resource: transmittance.createView() },
      ],
    }),
  );
  pass.draw(3);
  pass.end();
}

device.queue.submit([encoder.finish()]);

const error = await device.popErrorScope();
if (error) throw new Error(error.message);

const out = process.argv[2] ?? "sky.png";
await saveTexturePng(device, target, out);
console.log(`wrote ${out} — ${WIDTH}×${HEIGHT}, 4 passes, sun at ${SUN_ELEVATION_DEG}°`);
