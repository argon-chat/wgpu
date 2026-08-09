# wgpu-bun

[![npm](https://img.shields.io/npm/v/wgpu-bun?logo=npm&color=cb3837)](https://www.npmjs.com/package/wgpu-bun)
[![ci](https://github.com/argon-chat/wgpu/actions/workflows/ci.yml/badge.svg)](https://github.com/argon-chat/wgpu/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)
[![bun](https://img.shields.io/badge/bun-%E2%89%A5%201.4-f9f1e1?logo=bun)](https://bun.sh)

**The `webgpu` npm package segfaults Bun. This is a WebGPU that runs there.** A `bun:ffi` binding to
[wgpu-native](https://github.com/gfx-rs/wgpu-native) — the C API over
[`wgpu`](https://github.com/gfx-rs/wgpu), which is the core of WebGPU in **Firefox, Servo and
Deno** — API-compatible with [`webgpu`](https://www.npmjs.com/package/webgpu). Headless compute and
offscreen rendering on Windows, macOS and Linux, x64 and arm64.

```sh
bun add wgpu-bun
```

```ts
import { create, globals } from 'wgpu-bun';

Object.assign(globalThis, globals);            // GPUBufferUsage, GPUShaderStage, …

const gpu = create([]);
const adapter = await gpu.requestAdapter();
const device = await adapter!.requestDevice();

device.pushErrorScope('validation');
const module = device.createShaderModule({ code: '/* wgsl */' });
const error = await device.popErrorScope();    // ← reports, with negative tests proving it can
if (error) throw new Error(error.message);
```

The native library and the ABI shim arrive with it as an `optionalDependencies` platform package
matching your `os`/`cpu`. No install hook, no toolchain, no `cargo`.

## It renders

<img src="docs/media/sky.png" alt="A physically-based sunset rendered headless by wgpu-bun" width="100%">

That is [`examples/sky.ts`](examples/sky.ts), a WGSL port of [RedPewEngine](https://pew.red)'s
Hillaire atmosphere in four passes: two compute kernels build the transmittance and
multiple-scattering tables, a third ray-marches the sky into a 192×108 image, and a fullscreen
shader adds an analytic sun disc and exposes the result.

```sh
bun run examples/sky.ts   # → sky.png
```

| | |
|:-:|:-:|
| [<img src="docs/media/pathtracer.png" alt="A path-traced Cornell box with glass and metal spheres">](examples/pathtracer.ts) | [<img src="docs/media/lorenz.png" alt="The Lorenz attractor as a GPU density plot">](examples/lorenz.ts) |
| **pathtracer** — 900×900, 4 096 spp × 8 bounces, 3.3 billion primary rays, one dispatch | **lorenz** — 65 536 trajectories × 3 000 RK4 steps, up to 196 M `atomicAdd`s, no render pass |
| [<img src="docs/media/mandelbrot.png" alt="A deep zoom into the Mandelbrot set's seahorse valley">](examples/mandelbrot.ts) | [<img src="docs/media/reaction-diffusion.png" alt="A Gray-Scott reaction-diffusion parameter map">](examples/reaction-diffusion.ts) |
| **mandelbrot** — 5 556× zoom, smoothed escape time, 4× supersampled | **reaction-diffusion** — 4 000 ping-ponged dispatches in one command buffer |

Plus [`triangle.ts`](examples/triangle.ts), the shortest thing that proves an install works. The
gallery is in [examples/README.md](examples/README.md).

### Batteries: `wgpu-bun/image`

```ts
import { saveTexturePng, readTexture, encodePng } from 'wgpu-bun/image';

await saveTexturePng(device, target, 'frame.png');
```

`copyTextureToBuffer` demands a 256-byte-aligned row stride, so the buffer that comes back is almost
never the image: a 1400-pixel-wide RGBA frame arrives with 5 600 bytes of pixels and 32 bytes of
padding per row, and code that ignores it renders a picture that shears progressively to one side.
`readTexture` hands back tightly packed rows and refuses a texture without `COPY_SRC` up front,
because letting that reach `wgpuQueueSubmit` aborts the process. `encodePng` has no dependencies.

It is a **subpath** rather than part of the root, so the three names `webgpu` exports — `create`,
`globals`, `isMac` — remain the whole compatibility surface.

## Which one should you use

| | **wgpu-bun** | [`bun-webgpu`](https://github.com/kommander/bun-webgpu) | [`webgpu`](https://www.npmjs.com/package/webgpu) |
|---|---|---|---|
| Backend | **wgpu-native** — the Rust `wgpu` behind Firefox, Servo and Deno | Dawn — Chromium's | Dawn — Chromium's |
| Runs under Bun | **yes** | yes | **no** — the N-API addon segfaults the runtime |
| `popErrorScope()` | **reports, with negative tests proving it can go red** | crashes its allocator, even on an empty scope | works |
| `getCompilationInfo()` | **real diagnostics**, synthesised from the validation error | unimplemented | works |
| Surfaces / windowing | no — headless and offscreen only | no | no |

`bun-webgpu` covers the heavy end of the API competently and is a reasonable answer if Dawn is what
you want. The full assessment is in [docs/ERROR-PATH.md](docs/ERROR-PATH.md).

## Dawn, if you want it

The default is wgpu-native. Dawn is selectable at runtime, from the same package, with
`WGPU_BUN_IMPL=dawn`.

Both implement the same `webgpu.h` — 92 aggregates, compared field by field, zero differences — so
nothing above the loading layer changes, and **the whole suite runs green against either, on all
three platforms in public CI**, over Vulkan, D3D12 and Metal. Google ships static archives only, so
this repository links its own, with the ABI shim fused in, from a tag and a sha256. Opt-in, and
what differs: [docs/DAWN.md](docs/DAWN.md).

## Status

**Green on every supported platform, against three graphics APIs**, on wgpu-native `v29.0.1.1`, each
leg reaching a real device rather than skipping:

| platform | adapter | API |
|---|---|---|
| `win32-x64` | Microsoft Basic Render Driver (WARP), and a discrete NVIDIA adapter locally | D3D12 |
| `linux-x64` | llvmpipe (Mesa lavapipe) | Vulkan |
| `linux-arm64` | llvmpipe (Mesa lavapipe) | Vulkan |
| `darwin-arm64` | Apple Paravirtual device | Metal |

Three graphics backends, two architectures, three calling conventions. CI legs that cannot reach a
device **fail rather than skip**, so a green matrix means the suite ran, not that it was excused.

**Implemented:** adapter, device, buffers, textures, samplers, bind groups, pipelines, encoders,
queues; WGSL compilation, compute dispatch, render to texture, buffer readback, error scopes,
`getCompilationInfo()`, explicit backend selection.

**Refused, not stubbed.** A call either does the thing or throws saying it does not exist, including
the 40 wgpu-native symbols that abort the process, which are blocklisted by name. Out of scope:
surfaces, render bundles, indirect draw, occlusion queries, external textures
([why](docs/COMPATIBILITY.md#out-of-scope)). Not done yet: no WebGPU CTS run, and no discrete GPU
outside Windows ([the full list](docs/EVIDENCE.md#remaining-gaps)).

## Versioning: the major is the wgpu-native generation

`wgpu-bun@29.x.y` binds wgpu-native **v29**. That digit is not a maturity signal; it names the
native library inside, which is what decides ABI, validation strictness and WGSL acceptance. When
upstream moves to v30, so does this package's major. Minor and patch are ordinary semver. A test
asserts the major *is* `WGPU_NATIVE_MAJOR`, so a pin bump cannot ship as `29.x` and tell everyone
the ABI did not move.

**It ships v29 and accepts v27.** If your Rust half is on wgpu 27, point `WGPU_NATIVE_LIB` at that
library, or run `bun run fetch --generation 27`; the same suite that certifies v29 runs against it
on every platform in CI. A generation nobody has tested is refused at load rather than warned about,
because the differences between generations produce wrong answers rather than errors.
[docs/GENERATIONS.md](docs/GENERATIONS.md) has the measurements.

## Where the binaries come from

<img src="docs/media/distribution.svg" alt="Distribution map: upstream releases are pinned by URL and sha256, fetched and built per platform in CI, published as @wgpu-bun/&lt;rid&gt; packages, and resolved at runtime in three tiers" width="100%">

Nothing is committed and nothing is downloaded at install time. wgpu-native is pinned by URL **and
sha256**, fetched at release time, and published as a platform package your package manager selects
by `os`/`cpu`. Two upstreams are watched on different terms — wgpu-native by version, Dawn by the
calendar — and `.github/workflows/upstream-watch.yml` files an issue when one is due. Dawn is
tracked but not yet consumed: nothing built from it ships here. Details:
[docs/PACKAGING.md](docs/PACKAGING.md).

## Migrating from `webgpu`

An import-specifier change and nothing else. The drop-in surface is the same three exports
(`create`, `globals`, `isMac`) over standard
[`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types). Route it through a one-line local
re-export module and swapping back is a single edit for a whole codebase. The differences that do
exist — the two Dawn-proprietary globals, `navigator.gpu`, `copyExternalImageToTexture` — are in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

Confirming an install landed:

```ts
import { resolveNativeLibrary, STATUS } from 'wgpu-bun';

console.log(STATUS);
console.log(resolveNativeLibrary());
// { path: '…/vendor/win32-x64/lib/wgpu_native.dll', source: 'vendor',
//   includeDir: '…/vendor/win32-x64/include', version: 'v29.0.1.1' }
```

## Documentation

- [**docs/ABI.md**](docs/ABI.md) — the by-value seam, the 40 symbols that abort, the layout oracle.
- [**docs/ERROR-PATH.md**](docs/ERROR-PATH.md) — why an error scope that cannot go red is worse than
  a crash, what shader diagnostics actually are here, and the prior-art assessment.
- [**docs/COMPATIBILITY.md**](docs/COMPATIBILITY.md) — the `webgpu` contract precisely, backend
  selection, how much of WebGPU real code touches, and what is out of scope.
- [**docs/GENERATIONS.md**](docs/GENERATIONS.md) — which wgpu-native generations this binding
  accepts, what was measured on each, what adding one costs.
- [**docs/DAWN.md**](docs/DAWN.md) — selecting Dawn and a backend, how its library is built here,
  every measured difference between the two implementations.
- [**docs/PACKAGING.md**](docs/PACKAGING.md) — per-platform packages, why there is no postinstall
  hook, versioning, pinning, provenance.
- [**docs/EVIDENCE.md**](docs/EVIDENCE.md) — what is proven by execution versus argued from a spec,
  the remaining gaps, and the rules that stop a skipped GPU suite reading as a pass.
- [**docs/RELEASE.md**](docs/RELEASE.md) — how a release is cut.

## Working on the package

```sh
bun install
bun run fetch          # download + verify the pinned wgpu-native for this host
bun run shim:build     # build the ABI shim (needs cargo; see docs/ABI.md)
bun run check:layouts  # confirm the generated struct layouts match those headers
bun run typecheck
bun test
bun run test:matrix    # the suite × every implementation and backend this host can reach
```

The backend is a correctness knob — the same GPU exposes `shader-f16` over Vulkan and not over
D3D12 — and CI cannot sweep it: every runner has exactly one usable backend. `test:matrix` does.

`shim:build` is optional **only on `win32-x64`**, where the direct path is correct anyway — and worth
building even there, since it is the path that ships everywhere else. On the other three RIDs it is
not optional: without it the GPU suites skip with `abi-unsupported`.

## Licence

MIT © 2026 Argon Inc — see [LICENSE](LICENSE). That covers this repository's own code only.

[wgpu-native](https://github.com/gfx-rs/wgpu-native) is dual-licensed **MIT or Apache-2.0** by the
gfx-rs project. Its binaries are not vendored here, they are fetched from upstream's own releases,
but the per-platform npm packages *do* redistribute them, so those packages declare
`MIT OR Apache-2.0` and carry [`LICENSE-WGPU-NATIVE`](LICENSE-WGPU-NATIVE)
([why](docs/PACKAGING.md#licence-redistribution)).

[`bun-webgpu`](https://github.com/kommander/bun-webgpu) (Apache-2.0) is credited as prior art; it is
not a dependency and no code is taken from it.
