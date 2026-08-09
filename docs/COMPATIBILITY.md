# Compatibility with the `webgpu` package, and scope

## The compatibility contract, precisely

The target is `webgpu@0.3.8` (dawn-gpu/node-webgpu) — an ESM wrapper over a prebuilt Dawn N-API
addon. Its entire public surface is three exports:

| Export | Shape | Notes |
|---|---|---|
| `create(flags: string[])` | returns a `GPU` | Real callers invoke it as `create([], '')`, with a trailing argument the type declaration does not mention. The signature here tolerates extra positional arguments, because compatibility means matching what callers actually do, not what was declared. |
| `globals` | 42 constructor functions | Splatted onto `globalThis`. Only **five** are ever read as *values* in practice: `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`, `GPUMapMode`, `GPUColorWrite`. The other 37 exist for `instanceof` and error-class identity. |
| `isMac` | `boolean` | Exported from its `index.js`, absent from its `types.d.ts`. Matched anyway. |

Everything a caller touches beyond those three is standard
[`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types).

Two entries of upstream's 42 are **Dawn-proprietary with no spec equivalent** — `GPUSubgroupMatrixConfig`
and `WGSLLanguageFeatures` — and are the one place the bags will legitimately differ.

One gap worth noting: **`navigator.gpu` is not part of `globals`.** Callers hand-build that shim
themselves today. This package offers it as `installNavigatorGpu(gpu)`, opt-in rather than automatic:
a library writing to a global nobody asked it to touch is not a nicety.

### Why the bag is complete rather than partial

A partially-filled bag is the worst of the available failure modes. `Object.assign(globalThis, globals)`
appears to succeed, and the program then dies far away with `GPUBufferUsage is not defined`, pointing
at the caller instead of at this package. So all 42 names are present, and the five that are read as
*values* carry the exact bit constants wgpu-native's C API expects — names without values would be
the same failure with a longer fuse.

### What is deliberately *not* in that surface

`wgpu-bun/image` (`readTexture`, `encodePng`, `saveTexturePng`) is a **subpath export**, not part of
the root. The root entry point answers "what do I get if I swap the import from `webgpu`" with three
names and nothing else, and that answer stops being checkable the moment convenience functions start
arriving alongside them. A subpath keeps the compatibility claim exact while still shipping the two
functions every headless user would otherwise write — including the 256-byte row-stride de-padding,
which is the single most common way a headless render comes out visibly wrong.

Nothing in `src/` imports it, so a consumer who does not use it never loads it.

## Backend selection

**The backend is stated, not inherited.** On a machine with more than one GPU or more than one usable
backend, "whatever the driver picks" is a correctness decision in disguise: feature availability is
backend-dependent (`shader-f16` is present on Vulkan and absent on D3D12 for the *same* adapter), and
a power preference can change vendor outright. The default is per-host and documented in
`src/api/gpu.ts`; override with `create(["backend=vulkan"])`, the `WGPU_BUN_BACKEND` environment
variable, or `requestAdapter({ backendType })`. The chosen adapter is logged once at device creation
unless `quiet` is requested.

**Async completes on poll, and every async operation polls for itself.** Futures do not exist in this
build of wgpu-native, so nothing settles unless something pumps. Making that the caller's job would
be a trap: validation errors are also delivered on poll, so an error scope popped without pumping
reports "no error" for an operation that genuinely failed. `device.poll()` is exposed for callers
running their own frame loop, but nothing here depends on anyone calling it.

## How much of WebGPU actually has to work

Measured against roughly 71 000 lines of real WebGPU-using application and test code, rather than
against the specification: about **54% of the WebGPU method surface, ~32% of the total declared
surface**.

The shape of that number matters more than the number:

- **The object graph is nearly complete.** You cannot render a frame without buffers, textures,
  samplers, bind groups, pipelines, encoders and queues — real code touches almost every WebGPU
  interface. ~24 of 42 need a genuine implementation.
- **The value space is sparse.** 14 of 101 texture formats, 6 of 17 blend factors, 1 of 8 compare
  functions and 1 of 3 address modes are exercised at all.

To be unambiguous: **this is a measurement of what a useful binding needs, not a claim of
conformance.** It describes the size of the job, and the job is now largely done — what remains
unimplemented is the five subsystems named below, not a long tail of individual methods.

## Out of scope

**Measured zero uses** across that same body of code — these are not "hard parts deferred", they are
subsystems nobody reached for:

- **Render bundles** — `GPURenderBundle` and `GPURenderBundleEncoder`, the whole interface pair.
- **Indirect draw** — `drawIndirect`, `drawIndexedIndirect`. (`dispatchWorkgroupsIndirect` is the one
  indirect call that does get used, and is in scope.)
- **Occlusion queries** — only timestamp query sets exist in practice.
- **External textures** — `GPUExternalTexture`, `importExternalTexture`.
- **MSAA** and **`GPUMapMode.WRITE`** — every observed `mapAsync` is `READ`.

And by design:

- **Surfaces, swapchains, windowing.** No canvas, no `GPUCanvasContext`. This is for headless compute
  and offscreen rendering. Presenting to a window needs a window, which needs a windowing library,
  which is a different package.
- **Browser API fidelity beyond WebGPU.** No `requestAnimationFrame`, no `ImageBitmap`, no
  `OffscreenCanvas`. Note that `queue.copyExternalImageToTexture` therefore has no equivalent — decode
  to a `Uint8Array` and use `writeTexture`.
- **Dawn.** Not a fallback and not a build flag *in this package*. If you want Dawn under Bun,
  `bun-webgpu` already does it.
- **Node.** Bun-only, deliberately — `bun:ffi` *is* the implementation strategy here.

  Both of those are properties of **this package**, not of the repository. `wgpu-bun` is the Bun
  binding; a Node counterpart, or a Dawn-backed one, would be its own package built on its own
  mechanism, and neither would change what the sentences above say about this one. That is also why
  the repository is `argon-chat/wgpu` and not `argon-chat/wgpu-bun` — see
  [RELEASE.md](./RELEASE.md#repository-name-deliberately-not-the-package-name).
- **WebGPU CTS conformance.** A worthy goal; not a claim that will be made before it is measured.

Nothing on this list returns a plausible-looking nothing. A call either does the thing or throws
saying it does not exist.

## Conventions

A few choices a reader might otherwise wonder about:

- **Platform ids use Node's spelling** (`win32-x64`, `darwin-arm64`) rather than any other RID scheme,
  because npm's `os`/`cpu` fields and optional-dependency naming use exactly those strings, and
  matching the ecosystem matters more than internal tidiness.
- **Interfaces carry an `I` prefix** (`IArchiveAsset`, `IResolvedNativeLibrary`). A style choice, kept
  consistent throughout.
- **No compatibility shims while pre-1.0.** Dead code is deleted rather than deprecated-for-later. This
  is honest at `0.x`/early-major and only there — after the API settles, a package strangers depend on
  owes them real deprecation periods, and this rule yields to semver at that point. Saying so now beats
  making a promise that gets quietly broken later.
- **No build step for the JavaScript.** Bun consumes the TypeScript sources directly; there is no
  `dist/`, no bundler and no source-map drift. The one compiled artefact is the ABI shim, and it is
  built by CI and shipped prebuilt — a consumer never compiles anything, and a contributor only needs
  cargo if they are changing `shim/src/lib.rs`.
- **Files stay under ~600 lines**, split by responsibility when they grow past it.
