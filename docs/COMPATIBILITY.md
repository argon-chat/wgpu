# Compatibility with the `webgpu` package, and scope

## The compatibility contract, precisely

The target is `webgpu@0.3.8` (dawn-gpu/node-webgpu) — an ESM wrapper over a prebuilt Dawn N-API
addon. Its entire public surface is three exports:

| Export | Shape | Notes |
|---|---|---|
| `create(flags: string[])` | returns a `GPU` | Real callers invoke it as `create([], '')`, with a trailing argument the type declaration does not mention. The signature here tolerates extra positional arguments — compatibility means matching what callers do, not what was declared. |
| `globals` | 42 constructor functions | Splatted onto `globalThis`. Only **five** are ever read as *values*: `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`, `GPUMapMode`, `GPUColorWrite`. The other 37 exist for `instanceof` and error-class identity. |
| `isMac` | `boolean` | Exported from its `index.js`, absent from its `types.d.ts`. Matched anyway. |

Everything a caller touches beyond those three is standard
[`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types).

Two entries of upstream's 42 are **Dawn-proprietary with no spec equivalent** — `GPUSubgroupMatrixConfig`
and `WGSLLanguageFeatures` — and are the one place the bags will legitimately differ.

**`navigator.gpu` is not part of `globals`**, so callers hand-build that shim themselves. This
package offers it as `installNavigatorGpu(gpu)`, opt-in rather than automatic: a library should not
write to a global on import.

### Why the bag is complete rather than partial

`Object.assign(globalThis, globals)` on a partially-filled bag appears to succeed, and the program
then dies far away with `GPUBufferUsage is not defined`, pointing at the caller instead of at this
package. So all 42 names are present, and the five read as *values* carry the exact bit constants
wgpu-native's C API expects.

### What is deliberately *not* in that surface

`wgpu-bun/image` (`readTexture`, `encodePng`, `saveTexturePng`) is a **subpath export**, not part of
the root, so the root keeps answering "what do I get if I swap the import from `webgpu`" with three
names and nothing else. The subpath still ships the two functions every headless user would
otherwise write — including the 256-byte row-stride de-padding, the most common way a headless
render comes out visibly wrong. Nothing in `src/` imports it, so a consumer who does not use it
never loads it.

## Backend selection

**The backend is stated, not inherited.** "Whatever the driver picks" is a correctness decision in
disguise: feature availability is backend-dependent, and a power preference can change vendor
outright. Measured on one NVIDIA RTX 5070, `shader-f16` is present on Vulkan and absent on D3D12 for
that same adapter. The default is per-host and documented in `src/api/gpu.ts`; override with
`create(["backend=vulkan"])`, the `WGPU_BUN_BACKEND` environment variable, or
`requestAdapter({ backendType })`. The chosen adapter is logged once at device creation unless
`quiet` is requested.

**Async completes on poll, and every async operation polls for itself.** Futures do not exist in this
build of wgpu-native (`wgpuInstanceWaitAny` is an abort-on-call stub), so nothing settles unless
something pumps. Making that the caller's job would be a trap: validation errors are also delivered
on poll, so an error scope popped without pumping reports "no error" for an operation that genuinely
failed. `device.poll()` is exposed for callers running their own frame loop, but nothing here
depends on anyone calling it.

## How much of WebGPU actually has to work

Sized against roughly 71 000 lines of real WebGPU-using application and test code rather than
against the specification: about **54% of the WebGPU method surface, ~32% of the total declared
surface**. ⚠ That corpus is not in this repository, so those two percentages are not reproducible
from a checkout; the denominators below are, and match `src/enums.ts` exactly.

The shape matters more than the number:

- **The object graph is nearly complete.** You cannot render a frame without buffers, textures,
  samplers, bind groups, pipelines, encoders and queues — real code touches almost every WebGPU
  interface. ~24 of 42 need a genuine implementation.
- **The value space is sparse.** 14 of 101 texture formats, 6 of 17 blend factors, 1 of 8 compare
  functions and 1 of 3 address modes are exercised at all.

This is a sizing of what a useful binding needs, not a claim of conformance.

## Out of scope

Not implemented at all. These have zero call sites in the corpus above — they are not "hard parts
deferred":

- **Render bundles** — `GPURenderBundle` and `GPURenderBundleEncoder`, the whole interface pair.
- **Indirect draw** — `drawIndirect`, `drawIndexedIndirect`. (`dispatchWorkgroupsIndirect` is the one
  indirect call that does get used, and is in scope.)
- **Occlusion queries** — only timestamp query sets exist in practice.
- **External textures** — `GPUExternalTexture`, `importExternalTexture`.

Implemented but unexercised — the descriptor path carries them and no test does:

- **MSAA** (`sampleCount` is passed through) and **`GPUMapMode.WRITE`** (`mapAsync` honours it).
  Every `mapAsync` in the corpus is `READ`, so neither has a negative test behind it. Treat them as
  untested rather than absent.

And by design:

- **Surfaces, swapchains, windowing.** No canvas, no `GPUCanvasContext`. This is for headless compute
  and offscreen rendering; presenting to a window needs a windowing library, which is a different
  package.
- **Browser API fidelity beyond WebGPU.** No `requestAnimationFrame`, no `ImageBitmap`, no
  `OffscreenCanvas`. `queue.copyExternalImageToTexture` therefore has no equivalent — decode to a
  `Uint8Array` and use `writeTexture`.
- **WebGPU CTS conformance.** A worthy goal; not a claim that will be made before it is measured.
- **Node.** Bun-only, deliberately — `bun:ffi` *is* the implementation strategy here. A Node
  counterpart would be its own package on its own mechanism; that is a property of this package, not
  of the repository, which is why the repository is `argon-chat/wgpu` and not `argon-chat/wgpu-bun`
  (see [RELEASE.md](./RELEASE.md#repository-name-deliberately-not-the-package-name)).

Nothing on the first list returns a plausible-looking nothing — the methods are absent, so a call
throws rather than quietly succeeding.

### Dawn: out of scope *today*, and deliberately not forever

An earlier revision of this file said Dawn was "not a fallback and not a build flag in this package",
as a standing position. **That has been retracted** — the decided direction is a second
implementation *inside* this package, selected at runtime, with the Dawn binaries delivered as
additional per-platform packages a consumer opts into.

What is true right now, and all this file describes, is the first half: this package binds
wgpu-native, and nothing here loads Dawn. Preparation has started — `dawn.manifest.ts` pins a Dawn
release and `bun run dawn:fetch` / `dawn:link` produce a shared library from it — but no Dawn code
path exists in `src/`, and no test loads one.

The layout half ports for free, and that is measured rather than assumed. Dawn's `webgpu.h` is a
**superset**, not the same file: 192 aggregates to wgpu-native's 92, generated from `dawn.json`. But
of wgpu-native's 92, **none is missing from Dawn and none differs** — compiling both headers
separately and comparing `sizeof`/`alignof`/`offsetof` across all 92 aggregates and their members
gives 1480 measurements and zero disagreements; enum values, flag constants and `WGPU_*` macros
agree too.

One caveat, because "backend-agnostic as they stand" would paper over it: the binding's table
carries **115** aggregates, not 92 — the other 23 come from wgpu-native's `wgpu.h` and do not exist
in Dawn. Nothing packs them today, so there is no runtime consequence, but the layout oracle does
`#include "wgpu.h"` and would not build against a Dawn include directory. The layouts are portable;
the harness that verifies them is not yet.

Beyond that, what changes is the part built around wgpu-native's particular defects — most of which
disappears, since Dawn implements what wgpu-native stubs.

## Conventions

- **Platform ids use Node's spelling** (`win32-x64`, `darwin-arm64`) rather than any other RID scheme,
  because npm's `os`/`cpu` fields and optional-dependency naming use exactly those strings.
- **Interfaces carry an `I` prefix** (`IArchiveAsset`, `IResolvedNativeLibrary`).
- **No compatibility shims while pre-1.0.** Dead code is deleted rather than deprecated-for-later.
  This is honest at `0.x`/early-major and only there; after the API settles, this rule yields to
  semver and the deprecation periods strangers are owed.
- **No build step for the JavaScript.** Bun consumes the TypeScript sources directly; there is no
  `dist/`, no bundler and no source-map drift. The one compiled artefact is the ABI shim, built by
  CI and shipped prebuilt — a consumer never compiles anything, and a contributor only needs cargo
  if they are changing `shim/src/lib.rs`.
- **Files stay under ~600 lines**, split by responsibility when they grow past it.
