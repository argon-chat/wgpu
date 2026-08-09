/**
 * Render a triangle to a texture and write it out as a PNG.
 *
 *     bun run examples/triangle.ts            # → triangle.png
 *     bun run examples/triangle.ts out.png
 *
 * No window, no canvas, no `requestAnimationFrame` — this package renders offscreen and hands you
 * back pixels. Everything below is standard WebGPU; the only lines specific to this package are the
 * two imports, and the second one is a convenience.
 */
import { create, globals } from "wgpu-bun";
import { saveTexturePng } from "wgpu-bun/image";

Object.assign(globalThis, globals); // GPUTextureUsage, GPUBufferUsage, GPUMapMode, …

const WIDTH = 1280;
const HEIGHT = 720;

const WGSL = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0)       colour:   vec3f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
  // Three corners and three colours, indexed rather than fed from a vertex buffer — the shortest
  // path to something on screen.
  var xy = array(vec2f(0.0, 0.62), vec2f(-0.72, -0.5), vec2f(0.72, -0.5));
  var rgb = array(vec3f(0.99, 0.29, 0.55), vec3f(0.36, 0.85, 0.99), vec3f(0.99, 0.78, 0.29));

  var out: VertexOut;
  out.position = vec4f(xy[i], 0.0, 1.0);
  out.colour = rgb[i];
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  return vec4f(in.colour, 1.0);
}
`;

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter on this host");
const device = await adapter.requestDevice();

const target = device.createTexture({
  size: [WIDTH, HEIGHT],
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

// Push an error scope around the whole build. A validation error here is reported, not guessed at —
// which is most of why this binding exists.
device.pushErrorScope("validation");

const module = device.createShaderModule({ code: WGSL });
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module, entryPoint: "vs" },
  fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [
    {
      view: target.createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0.043, g: 0.051, b: 0.071, a: 1 },
    },
  ],
});
pass.setPipeline(pipeline);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);

const error = await device.popErrorScope();
if (error) throw new Error(error.message);

const out = process.argv[2] ?? "triangle.png";
await saveTexturePng(device, target, out);
console.log(`wrote ${out} — ${WIDTH}×${HEIGHT}`);
