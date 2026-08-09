# Compatibility with the `webgpu` package, and scope

## The compatibility contract, precisely

The target is `webgpu@0.3.8` (dawn-gpu/node-webgpu) — an ESM wrapper over a prebuilt Dawn N-API
addon. Its entire public surface is three exports:

| Export | Shape | Notes |
|---|---|---|
| `create(flags: string[])` | returns a `GPU` | Real callers invoke it as `create([], '')`, with a trailing argument the type declaration does not mention. The signature here tolerates extra positional arguments — compatibility means matching what callers do, not what was declared. |
| `globals` | 42 constructor functions | Splatted onto `globalThis`. Only **five** are ever read as *values*: `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`, `GPUMapMode`, `GPUColorWrite`. The other 37 exist for `instanceof` and error-class identity. |
| `isMac` | `boolean` | Exported from its `index.js`, absent from its `types.d.ts`. Matched anyway. |

Everything else a caller touches is standard
[`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types). Two of upstream's 42 are
**Dawn-proprietary with no spec equivalent** — `GPUSubgroupMatrixConfig` and `WGSLLanguageFeatures` —
and are the one place the bags will legitimately differ.

**`navigator.gpu` is not part of `globals`**, so callers hand-build that shim themselves. This
package offers it as `installNavigatorGpu(gpu)`, opt-in: a library should not write to a global on
import.

### Why the bag is complete rather than partial

A partially-filled bag makes `Object.assign(globalThis, globals)` appear to succeed, and the program
then dies far away with `GPUBufferUsage is not defined`, pointing at the caller instead of at this
package. So all 42 names are present, and the five read as *values* carry the exact bit constants
wgpu-native's C API expects.

### What is deliberately *not* in that surface

`wgpu-bun/image` (`readTexture`, `encodePng`, `saveTexturePng`) is a **subpath export**, so the
root's answer to "what do I get if I swap the import from `webgpu`" stays three names. It ships what
every headless user would otherwise write, including the 256-byte row-stride de-padding — the most
common way a headless render comes out visibly wrong. Nothing in `src/` imports it.

## Backend selection

**The backend is stated, not inherited.** Feature availability is backend-dependent and a power
preference can change vendor outright, so "whatever the driver picks" is a correctness decision in
disguise. Measured on one NVIDIA RTX 5070: `shader-f16` is present on Vulkan and absent on D3D12,
same adapter. The default is per-host and documented in `src/api/gpu.ts`; override with
`create(["backend=vulkan"])`, the `WGPU_BUN_BACKEND` environment variable, or
`requestAdapter({ backendType })`. The chosen adapter is logged once at device creation unless
`quiet` is requested.

**Async completes on poll, and every async operation polls for itself.** Futures do not exist in this
build of wgpu-native (`wgpuInstanceWaitAny` is an abort-on-call stub), so nothing settles unless
something pumps. Leaving that to the caller would be a trap: validation errors are delivered on poll
too, so an error scope popped without pumping reports "no error" for an operation that genuinely
failed. `device.poll()` is exposed for callers running their own frame loop; nothing here needs it.

## How much of WebGPU actually has to work

Sized against roughly 71 000 lines of real WebGPU-using application and test code rather than
against the specification: about **54% of the WebGPU method surface, ~32% of the total declared
surface**. A sizing of what a useful binding needs, not a claim of conformance. ⚠ That corpus is not
in this repository, so those two percentages are not reproducible from a checkout; the denominators
below are, and match `src/enums.ts` exactly.

- **The object graph is nearly complete.** You cannot render a frame without buffers, textures,
  samplers, bind groups, pipelines, encoders and queues. ~24 of 42 interfaces need a genuine
  implementation.
- **The value space is sparse.** 14 of 101 texture formats, 6 of 17 blend factors, 1 of 8 compare
  functions and 1 of 3 address modes are exercised at all.

## Out of scope

Not implemented at all — zero call sites in the corpus above, not "hard parts deferred". The methods
are absent, so a call throws rather than quietly succeeding.

- **Render bundles** — `GPURenderBundle` and `GPURenderBundleEncoder`, the whole interface pair.
- **Indirect draw** — `drawIndirect`, `drawIndexedIndirect`. (`dispatchWorkgroupsIndirect` is the one
  indirect call that does get used, and is in scope.)
- **Occlusion queries** — only timestamp query sets exist in practice.
- **External textures** — `GPUExternalTexture`, `importExternalTexture`.

Implemented but unexercised — the descriptor path carries them and no test does: **MSAA**
(`sampleCount` is passed through) and **`GPUMapMode.WRITE`** (`mapAsync` honours it). Every
`mapAsync` in the corpus is `READ`. Untested rather than absent.

And by design:

- **Surfaces, swapchains, windowing.** No canvas, no `GPUCanvasContext`. Headless compute and
  offscreen rendering only; presenting to a window needs a windowing library — a different package.
- **Browser API fidelity beyond WebGPU.** No `requestAnimationFrame`, no `ImageBitmap`, no
  `OffscreenCanvas`. `queue.copyExternalImageToTexture` therefore has no equivalent — decode to a
  `Uint8Array` and use `writeTexture`.
- **WebGPU CTS conformance.** A worthy goal; not a claim that will be made before it is measured.
- **Node.** Bun-only, deliberately — `bun:ffi` *is* the implementation strategy. A Node counterpart
  would be its own package on its own mechanism: a property of this package, not of the repository,
  which is why the repository is `argon-chat/wgpu` and not `argon-chat/wgpu-bun`
  (see [RELEASE.md](./RELEASE.md#repository-name-deliberately-not-the-package-name)).

### Dawn: out of scope *today*, and deliberately not forever

That standing position was retracted, and then done: Dawn is a second implementation inside this
package, selected with `WGPU_BUN_IMPL=dawn`, its binaries opt-in per-platform packages. See
[DAWN.md](./DAWN.md).

The layout half ported for free, measured rather than assumed. Dawn's `webgpu.h` is a **superset**,
not the same file: 192 aggregates to wgpu-native's 92, generated from `dawn.json`. But of
wgpu-native's 92, **none is missing from Dawn and none differs** — compiling both headers separately
and comparing `sizeof`/`alignof`/`offsetof` across all 92 aggregates and their members found no
disagreements; enum values, flag constants and `WGPU_*` macros agree too. What still changes under
Dawn is the part built around wgpu-native's defects, most of which Dawn simply implements.

⚠ The verification harness did **not** port. The binding's table carries **115** aggregates, not 92:
the other 23 come from wgpu-native's extension header `wgpu.h`, which has no Dawn equivalent.
Nothing packs them today, so there is no runtime consequence — but the layout oracle `#include`s
`wgpu.h`, so `check:layouts` cannot be pointed at a Dawn include directory.

## Conventions

- **Platform ids use Node's spelling** (`win32-x64`, `darwin-arm64`), because npm's `os`/`cpu` fields
  and optional-dependency naming use exactly those strings.
- **Interfaces carry an `I` prefix** (`IArchiveAsset`, `IResolvedNativeLibrary`).
- **No compatibility shims while pre-1.0.** Dead code is deleted, not deprecated-for-later. Honest at
  `0.x`/early-major and only there; once the API settles this yields to semver and the deprecation
  periods strangers are owed.
- **No build step for the JavaScript.** Bun consumes the TypeScript sources directly: no `dist/`, no
  bundler, no source-map drift. The one compiled artefact is the ABI shim, built by CI and shipped
  prebuilt — a contributor needs cargo only to change `shim/src/lib.rs`.
- **Files stay under ~600 lines**, split by responsibility when they grow past it. The exception is
  `shim/src/lib.rs`, one compilation unit by design.
