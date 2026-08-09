# Examples

Every one of these runs headless, writes a PNG, and needs nothing but Bun and a GPU:

```sh
bun run examples/<name>.ts            # → <name>.png
bun run examples/<name>.ts out.png
```

They all use [`wgpu-bun/image`](../src/image.ts) for the last step, because otherwise every example
would open with the same forty lines of staging buffer and row de-padding.

---

## `triangle.ts` — hello, device

<img src="../docs/media/triangle.png" alt="A gradient triangle" width="100%">

The shortest thing that proves the stack works: one render pass, three vertices generated from
`vertex_index`, no vertex buffer. Start here if you are checking an install.

## `sky.ts` — a physically-based atmosphere

<img src="../docs/media/sky.png" alt="A physically-based sunset over a dark ground plane" width="100%">

A WGSL port of [RedPewEngine](https://github.com/argon-chat)'s Hillaire 2020 sky — the same shaders
that run in the engine, minus the parts that only mean something inside a renderer. **Four passes:**

| pass | kind | what it builds |
|---|---|---|
| transmittance | compute, 256×64 | how much light survives from any altitude, in any direction, to space |
| multiple scattering | compute, one workgroup per texel | the light that bounced more than once — 64 directions per cell, reduced in workgroup memory |
| sky view | compute, 192×108 | the whole visible sky, ray-marched once |
| background | render, fullscreen | two filtered fetches, an analytic sun disc with limb darkening, and exposure |

The interesting parts are documented in [`sky.wgsl.ts`](./sky.wgsl.ts): why `r² − R²` is never
evaluated, why the segment integral needs a degenerate branch, and which of the two isotropic phase
factors cancels — getting that one wrong is a factor of 4π and a sky that looks fine.

## `pathtracer.ts` — a path tracer in one dispatch

<img src="../docs/media/pathtracer.png" alt="A path-traced Cornell box with a glass sphere, a gold metal sphere and colour bleeding" width="100%">

A Cornell-style box, 4 096 samples per pixel, 8 bounces, at 900×900 — 3.3 billion primary rays in
under two seconds. Diffuse, metal and dielectric materials; the soft shadows and the colour bleeding
onto the white floor are not effects, they are what the integral does.

The pipeline is deliberately trivial — one uniform buffer, one storage texture, one dispatch —
because that is the honest picture of this kind of work: the interesting part is arithmetic, not
plumbing. Worth reading in the shader: **Russian roulette** (why terminating paths randomly leaves
the estimator unbiased), **cosine-weighted sampling** (why a diffuse bounce costs one multiply), and
why the walls are 10 000-unit spheres rather than planes.

## `mandelbrot.ts` — only arithmetic

<img src="../docs/media/mandelbrot.png" alt="A deep zoom into the Mandelbrot set's seahorse valley" width="100%">

A 5 556× zoom into the seahorse valley, ≤2 000 iterations, 4× supersampled. Every pixel is
independent, which makes this the clearest look at what a dispatch actually is.

Two details do all the visual work, and both are in the shader with the reasoning attached: the
**smoothed escape time** (an integer iteration count gives you concentric bands; the continuous form
gives you a gradient) and the **bailout radius of 256 rather than 2** (the smoothing correction is
only accurate well past the escape radius — at 2 its error *is* the banding it was meant to remove).

f32 runs out somewhere past this zoom. The example says so rather than pretending; deeper needs
double-float emulation, which is a different demonstration.

## `lorenz.ts` — the butterfly, on the GPU

<img src="../docs/media/lorenz.png" alt="The Lorenz attractor, plotted as a density map" width="100%">

65 536 trajectories × 3 000 RK4 steps, each step doing an `atomicAdd` into a density buffer — about
196 million of them, in under two seconds. A second kernel takes the logarithm of that density and
maps it through a colour ramp.

No render pass at all: two compute dispatches and a texture copy. The particles start inside a
0.02-wide cube; the picture is what their divergence leaves behind.

## `reaction-diffusion.ts` — 4 000 dispatches, ping-ponged

<img src="../docs/media/reaction-diffusion.png" alt="A Gray-Scott parameter map: mazes dissolving into spots" width="100%">

Gray-Scott, with the feed rate varying across the frame and the kill rate down it — so every
texture in the image is the same kernel at different parameters, and the whole Pearson map is one
dispatch chain.

State lives in two `rg32float` textures that swap roles each step. All 4 000 passes go into one
command buffer with two pre-built bind groups; nothing returns to the CPU until the picture is done.

---

## Regenerating the images

```sh
for f in triangle sky pathtracer lorenz mandelbrot reaction-diffusion; do
  bun run examples/$f.ts docs/media/$f.png
done
```

The committed PNGs were rendered on `win32-x64` / D3D12. Expect small differences on another
backend — none of these are golden images, and nothing in the test suite compares against them.
