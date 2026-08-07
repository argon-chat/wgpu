# wgpu-bun

A [Bun](https://bun.sh) FFI binding to [wgpu-native](https://github.com/gfx-rs/wgpu-native),
API-compatible with the [`webgpu`](https://www.npmjs.com/package/webgpu) npm package.

> ## Status: alpha. It works, and it is not finished.
>
> `create()` returns a real `GPU`. You can request an adapter and a device, create buffers and
> textures, compile WGSL, run a compute dispatch, render to a texture, and read the results back.
> Error scopes report. `getCompilationInfo()` returns real diagnostics.
>
> What is not there is listed under [Scope](#scope) and named rather than discovered: surface
> presentation, render bundles, indirect draw, occlusion queries, external textures. Nothing else is
> a stub — a call either does the thing or throws saying it does not exist.
>
> Verified end to end on `win32-x64` against wgpu-native `v29.0.1.1`. The other four platforms build
> and typecheck but have not been executed; the ABI seam below refuses to run on Linux x64 and Intel
> macOS rather than being silently wrong there.

---

## What works today

| | |
|---|---|
| Pinned wgpu-native manifest — `v29.0.1.1`, 5 platforms, sha256 for each | ✅ |
| `bun run fetch` — download, verify, extract into `vendor/<rid>/` | ✅ |
| `resolveNativeLibrary()` — locate the installed library, report its origin | ✅ |
| Generated C-ABI struct layouts for all 115 aggregates, checked against a C compiler | ✅ |
| The abort-on-call blocklist, derived two independent ways and enforced in CI | ✅ |
| `create()` / `globals` — the WebGPU surface, adapter through readback | ✅ |
| Error scopes, nested, with negative tests proving they report | ✅ |
| `getCompilationInfo()`, synthesised from the creation-time validation error | ✅ |
| Explicit, documented backend selection (D3D12 / Vulkan / Metal) | ✅ |
| Surfaces, render bundles, indirect draw, occlusion queries, external textures | ❌ out of scope |

## Why this exists

**Bun cannot load the `webgpu` package.** `webgpu` (dawn-gpu/node-webgpu) ships Dawn as a prebuilt
N-API addon — `dist/<platform>-<arch>.dawn.node`, loaded through `createRequire`. Bun's N-API
compatibility does not stretch to it: loading the addon **segfaults the runtime** rather than throwing
a catchable error. Verified on Bun 1.4 (canary), Windows, 2026-08-07.

That is a hard wall, not a papering-over-able bug. Any WebGPU workload behind that package is simply
unreachable from Bun.

**wgpu-native rather than Dawn — a deliberate backend choice.** Dawn and wgpu-native are both
conformant-ish WebGPU implementations that disagree in observable ways: validation strictness, WGSL
acceptance, reported limits, resource lifetimes, error message text. Neither is "correct"; they are
different. wgpu-native is the C API over [wgpu](https://github.com/gfx-rs/wgpu), the same
implementation every Rust/wgpu consumer ships. If that is your deployment target, a Dawn-backed
binding tests an implementation you do not run — and passes.

Bindings are the right layer to make that choice at. Being able to pick the implementation your JS
code is validated against, rather than inheriting whichever one your binding's author preferred, is
most of the value here.

## Prior art: `bun-webgpu`

Worth saying plainly, because "I wrote my own" usually implies the alternative was bad, and here it
wasn't. [`bun-webgpu`](https://github.com/kommander/bun-webgpu) (Apache-2.0, by SST) already covers
the heavy end of the WebGPU API competently over `bun:ffi`. Verified against it on 2026-08-07, it
correctly handled:

- compute dispatch with buffer readback,
- `r32uint` storage textures,
- `depth-2d-array` textures with comparison samplers,
- 3D textures with live mip chains,
- the `shader-f16` feature and `rgba16float` render targets.

That is the hard 80%, and it works. If Dawn is the backend you want, it is a reasonable answer today
and this package is not yet an answer at all.

It was set aside here for two specific reasons:

- **Its error path is broken.** `popErrorScope` crashes its userdata allocator — *even on an empty
  scope*, i.e. on the happy path. `getCompilationInfo()` is unimplemented.
- **It targets Dawn**, for the reasons above.

That assessment sets this package's bar. **Its entire justification is the error path and the backend
choice**, so those are first-class deliverables, not a later milestone.

## The error path

### Why it is the point

Subtler than "the other one crashes": for both `popErrorScope` and `getCompilationInfo`, the
dangerous failure mode is not a crash. It is a **silent green**.

Real WebGPU test suites use the error scope *as the assertion* — push a scope, do the thing, pop,
pass if the result is null. Nothing else is checked. So an error scope that dutifully records
nothing, or a `getCompilationInfo()` that unconditionally returns an empty message list, does not
fail. It makes every assertion built on top of it pass **vacuously**. A suite in that state is
decoration: it runs, it is green, and no gate in it is capable of noticing a regression. A crash is
loud and gets fixed in an hour; a silent green survives for months and quietly voids everything
downstream of it.

So this package owes its users **negative tests** — proof that it *reports* a validation error and
*reports* a shader compilation error, not merely that it survives being asked for one. A binding that
cannot demonstrate a red is not entitled to be believed when it shows a green.

Every error-path test in `test/` is written as a **pair**: an operation that must report, and the
valid twin that differs only in the way that makes it valid and must report nothing. A do-nothing
implementation fails the first half; an always-report implementation fails the second.

### Shader diagnostics: what is actually on offer

`getCompilationInfo` is not merely missing from other bindings. **`wgpuShaderModuleGetCompilationInfo`
is `unimplemented!()` in wgpu-native itself** — it is one of the 40 exported symbols that abort the
process when called (below). There is no native call to forward to. A binding that wires
`GPUShaderModule.getCompilationInfo()` straight through does not return empty diagnostics; it kills
the process.

So the honest offering is:

> **Shader compilation errors arrive through the error scope, at `createShaderModule` time.**
> `getCompilationInfo()` is *synthesised* from that same validation error — not fetched from
> wgpu-native.

That differs from Dawn, where the two channels are independent. It is not a loss of *information*:
naga's diagnostic text is what lands in the validation error either way. It does mean the two are not
independent oracles here, and code that only ever calls `getCompilationInfo()` without an error scope
is relying on synthesis.

```ts
device.pushErrorScope('validation');
const module = device.createShaderModule({ code });
const error = await device.popErrorScope();   // ← the real channel
if (error) console.error(error.message);
```

## The 40 symbols that abort the process

wgpu-native exports 40 functions that are `unimplemented!()`. Because the entry points are
`extern "C"` and therefore non-unwinding, the Rust panic cannot be caught: calling one **kills the
process** — no exception, no JS stack, no partial results.

They are indistinguishable from working functions beforehand. They are in the export table, they are
in `webgpu.h`, and they are typed exactly like their neighbours. The specific trap:

| Aborts | Use instead |
|---|---|
| `wgpuBufferReadMappedRange` | `wgpuBufferGetMappedRange` |
| `wgpuBufferWriteMappedRange` | `wgpuBufferGetConstMappedRange` |

Those two are the **modern `webgpu.h` spellings**, so a binding generated faithfully from the header
picks precisely the pair that aborts — and dies on its first buffer readback, which is the hot path of
essentially every GPU workload. Three more shape this package's design: `wgpuShaderModuleGetCompilationInfo`
(above), `wgpuDeviceGetLostFuture` (so `device.lost` cannot be backed natively), and
`wgpuInstanceWaitAny` (so async completion is driven by polling). Twenty-one of the forty are
`*SetLabel`, which is why labels are only ever passed in creation descriptors and never assigned
afterwards.

The list is derived **two independent ways** — by executing every exported symbol in an isolated
subprocess and watching for the panic banner, and by parsing upstream's Rust source at the pinned tag
— and the two derivations must agree, at 40, or CI fails. A version bump cannot quietly re-admit one.

### Two more ways it aborts, which are not symbols

The blocklist covers functions that abort *whenever* they are called. Two further paths abort only on
particular **inputs**, so no list of symbols can catch them. Both were found by executing this
binding, not by reading anything, and both are handled here:

- **An omitted `rowsPerImage` on `copyTextureToBuffer` / `copyBufferToTexture`** panics in `conv.rs`
  (`invalid rowsPerImage`). This is the hot path of every pixel assertion in existence. The binding
  fills the field in from `copySize.height` — which is the value the WebGPU specification already
  defines as the default for a single-layer copy, so nothing is invented. `writeTexture` is *not*
  given the same treatment: it accepts the field's absence, and supplying it there trips a different
  check. One field, two entry points, opposite requirements.

- **Submitting an invalid command buffer** aborts inside `wgpuQueueSubmit`
  (`Error in wgpuQueueSubmit: Validation Error`). The uncaptured-error callback is installed and the
  error scope is open; neither is consulted. Device-level creation and `commandEncoder.finish()`
  *do* report normally, so the shape that works for a negative test is **encode, `finish()`,
  `popErrorScope()` — and do not submit.** This one is not papered over: the verdict is asynchronous
  and `submit()` is synchronous by specification, so suppressing submissions on suspicion would break
  every legitimate frame.

### The ABI seam

Five of the eight `webgpu.h` functions that take a callback-info struct **by value** are callable
(the other three are on the blocklist). `bun:ffi` has no struct-by-value argument type, and on Win64
and AArch64 that does not matter: an aggregate of this size is passed by hidden reference, so handing
over a pointer is the correct calling sequence — proven by execution, not assumed. Under the SysV
x86-64 ABI it is copied onto the stack instead, and no combination of `bun:ffi` argument types can
produce that.

Rather than be silently wrong on Linux x64 and Intel macOS, `src/ffi/abiSeam.ts` **refuses to run**
there. Closing the gap needs a small compiled shim behind that one module; every call site already
passes a pointer to an already-packed buffer, which is exactly the signature such a shim would
expose, so adopting one changes that file and nothing else.

## Scope

**Targets:** wgpu-native `v29.0.1.1` (wgpu-core 29.x) · Bun ≥ 1.4 · headless compute and offscreen
render-to-texture on `win32-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`.

### The compatibility contract, precisely

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
themselves today. Providing it is a small nicety this package can offer for free.

#### Why the bag is complete rather than partial

A partially-filled bag is the worst of the available failure modes. `Object.assign(globalThis, globals)`
appears to succeed, and the program then dies far away with `GPUBufferUsage is not defined`, pointing
at the caller instead of at this package. So all 42 names are present, and the five that are read as
*values* carry the exact bit constants wgpu-native's C API expects — names without values would be
the same failure with a longer fuse.

`navigator.gpu` is offered as `installNavigatorGpu(gpu)`. It is opt-in rather than automatic: a
library writing to a global nobody asked it to touch is not a nicety.

### How much of WebGPU actually has to work

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

**Explicitly out of scope, and likely to stay that way.** Each of these measured *zero* uses across
that same body of code — they are not "hard parts deferred", they are subsystems nobody reached for:

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
- **Dawn.** Not a fallback, not a build flag. If you want Dawn under Bun, `bun-webgpu` already does it.
- **Node.** Bun-only, deliberately — `bun:ffi` *is* the implementation strategy.
- **WebGPU CTS conformance.** A worthy goal; not a claim that will be made before it is measured.

## Install

Not published yet. The npm name `wgpu-bun` was unclaimed as of 2026-08-07, and nothing will be pushed
to it until the platform matrix has actually been executed on more than one platform — publishing a
package whose claims outrun its evidence is how the next person loses a day.

To work on it:

```sh
bun install
bun run fetch          # download + verify the pinned wgpu-native for this host
bun run check:layouts  # confirm the generated struct layouts match those headers
bun run typecheck
bun test
```

## Usage

```ts
import { create, globals } from 'wgpu-bun';

Object.assign(globalThis, globals);          // GPUBufferUsage, GPUShaderStage, …

const gpu = create([]);
const adapter = await gpu.requestAdapter();
const device = await adapter!.requestDevice();

device.pushErrorScope('validation');
const module = device.createShaderModule({ code: '/* wgsl */' });
const error = await device.popErrorScope();
if (error) throw new Error(error.message);
```

Identical to `webgpu`'s usage, by construction. Swapping the two is an import-specifier change — and
if you route it through a one-line local re-export module, swapping is a single edit for a whole
codebase, which is worth doing on day one rather than after the 30th call site.

The diagnostic path, useful for confirming the fetch landed:

```ts
import { resolveNativeLibrary, STATUS } from 'wgpu-bun';

console.log(STATUS);
console.log(resolveNativeLibrary());
// { path: '…/vendor/win32-x64/lib/wgpu_native.dll', source: 'vendor',
//   includeDir: '…/vendor/win32-x64/include', version: 'v29.0.1.1' }
```

## How the native library reaches you

Via **per-platform npm packages in `optionalDependencies`** — `@wgpu-bun/win32-x64`,
`@wgpu-bun/linux-x64`, and so on, each carrying one shared library and declaring `os` / `cpu` so your
package manager installs exactly the matching one. This is what esbuild, swc, sharp and `bun-webgpu`
all do.

### Why not a postinstall hook

**`bun install` does not run lifecycle scripts of installed dependencies.** That is a deliberate
supply-chain defence, and unblocking it requires *the consumer* to add this package to
`trustedDependencies` or run `bun pm trust`. There is a built-in allowlist of well-known packages; a
new one is obviously not on it.

Worse, the failure is silent. Bun installs the package, skips the hook, and reports success — the
user then meets a library-not-found error at runtime that points nowhere near the cause. For a
package whose primary audience *is* Bun users, being broken-by-default on Bun, silently, is not
shippable.

Sub-packages also survive `--ignore-scripts`, are integrity-checked by the registry itself, install
from a warm cache offline, and need no egress to GitHub releases from networks where only a mirrored
npm registry is reachable. The cost is publishing N+1 packages instead of 1 — a one-time
release-process cost, not a per-user tax.

There is therefore **no `postinstall` hook** in `package.json`, and there will not be one.

### The sharp edge, stated plainly

**`optionalDependencies` fail silently.** On a platform with no matching package, your package manager
installs nothing, reports success, and says nothing. The first thing that notices is this package's
own resolver, which is why its error message names the platform it looked for, the package that would
have provided it, and the `WGPU_NATIVE_LIB` override — that message is the *only* diagnostic that
exists at that moment.

Resolution order is `WGPU_NATIVE_LIB` → `@wgpu-bun/<rid>` → `vendor/<rid>/`, so an explicitly built
library always wins and a development checkout works with no publishing at all.

`bun run fetch` keeps its job: it is what populates the platform packages at release time, and it
remains the development path.

### Unpublished platforms

Nothing is published yet, so `optionalDependencies` is **absent** from `package.json` rather than
listing five packages the install cannot resolve. `bun run release:wire` writes the block at release
time from the same manifest that pins the binaries. Any platform whose archive did not land is
reported as unpublished rather than declared as a target.

## Supply chain

Native binaries are **fetched, never committed**. Every download is pinned to an exact URL and an
exact sha256 in [`wgpu-native.manifest.ts`](wgpu-native.manifest.ts), and a mismatch always hard-fails
— including under `--soft`, which exists so a fresh clone without network can still proceed, not to
wave through an unexpected binary.

```sh
bun run fetch                      # this host
bun run fetch --rid linux-arm64    # cross-fetch another platform
bun run fetch --force              # re-download even if the version stamp matches
bun run fetch:hashes               # re-measure every pinned archive's sha256, print, write nothing
```

Archive layout is **probed, not hardcoded**: the script searches the extracted tree for
`wgpu_native.{dll,so,dylib}` and the `webgpu.h` / `wgpu.h` headers by name. An upstream reshuffle
surfaces as a clear "not found in archive" rather than a silently-empty directory.

Bumping the pinned release is a two-line edit (`WGPU_NATIVE_TAG` + the URLs) followed by
`bun run fetch:hashes` to re-measure, then `bun run gen:layouts` to regenerate the struct tables.
Hashes are pasted by a human, never written by the tool — pinning should stay a deliberate,
reviewable act.

### Provenance, and what it does not cover

Releases are published from CI with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):
OIDC-issued, short-lived, workflow-specific credentials, with no long-lived `NPM_TOKEN` anywhere. npm
generates and attaches provenance attestations automatically.

**That attestation covers *this* build.** It binds a commit in this repository to the bytes published
under this name. It says **nothing** about the origin of the bundled `wgpu_native` library — that is
covered separately, by the pinned URL and sha256 in `wgpu-native.manifest.ts`, which anyone can verify
against upstream's own release page. Two different guarantees; neither substitutes for the other. A
reader who sees the provenance badge should not conclude the native binary is attested.

## Struct layouts

Every C-ABI struct layout in `src/layouts/generated/` is **derived from the pinned headers**, never
hand-counted. The generated tables carry member names and type tags only — no offsets, no sizes,
nothing numeric — and offsets are computed from them at import time. `test/layout-oracle.test.ts`
then compiles the real headers and checks every aggregate against the C compiler's own `sizeof` and
`offsetof`.

The generated tables record the sha256 of the headers they came from, so a bumped pin with stale
layouts fails the oracle instead of silently shifting every offset after the inserted member. The
ordering rule is therefore: **`bun run fetch`, then `bun run gen:layouts`.** `bun run check:layouts`
enforces it.

The oracle needs no GPU and no linking — `sizeof`/`offsetof` are compile-time — so it runs on every
CI runner, including the ones with no adapter.

## Testing

```sh
bun test                       # everything; GPU suites skip loudly when there is no adapter
bun run check:layouts          # generated layouts vs. the fetched headers
bun run derive:aborts:source   # re-derive the abort blocklist from upstream source (--check to gate)
bun run derive:aborts:probe    # re-derive it by execution; slow, run on a pin bump
```

**A skipped GPU suite must never read as a passed one.** The rules:

| Reason a device could not be acquired | Default | Escape hatch |
|---|---|---|
| No native library installed | **fails** | `WGPU_BUN_ALLOW_NO_LIBRARY=1` |
| No adapter on this host | **fails** | `WGPU_BUN_ALLOW_NO_ADAPTER=1` |
| `requestDevice` failed with an adapter present | **fails** | none — that is a defect |
| The binding is unimplemented | skips | none; see below |

The escapes are environment variables rather than auto-detection, so granting one is a visible,
per-job decision a reviewer can see in the workflow file, and a local run never grants itself one.

The unimplemented-skip would be a permanent loophole — never finish it and nothing ever has to run —
except that the same flag is bound to the package's public claims: while it is set, the README must
carry the status banner and the version must stay `0.0.x`. The way out of the skip is not a knob, it
is shipping.

CI runs a five-platform matrix. Linux legs install Mesa's lavapipe and are **required** to find an
adapter; the Windows and macOS legs are permitted to skip while it is established whether WARP and
paravirtualised Metal come up on hosted runners. A final job reads one marker per leg and **fails the
run if no leg anywhere reached a device** — five individually-defensible skips must not add up to a
meaningless pass.

## Conventions

A few choices that a reader might otherwise wonder about:

- **Platform ids use Node's spelling** (`win32-x64`, `darwin-arm64`) rather than any other RID scheme,
  because npm's `os`/`cpu` fields and optional-dependency naming use exactly those strings, and
  matching the ecosystem matters more than internal tidiness.
- **Interfaces carry an `I` prefix** (`IArchiveAsset`, `IResolvedNativeLibrary`). A style choice, kept
  consistent throughout.
- **No compatibility shims while pre-1.0.** Dead code is deleted rather than deprecated-for-later. This
  is honest at `0.x` and only at `0.x` — after a 1.0, a package strangers depend on owes them real
  deprecation periods, and this rule yields to semver at that point. Saying so now beats making a
  promise that gets quietly broken later.
- **No build step.** Bun consumes the TypeScript sources directly; there is no `dist/`, no bundler and
  no source-map drift.
- **Files stay under ~600 lines**, split by responsibility when they grow past it.

## Licence

MIT © 2026 Argon Inc — see [LICENSE](LICENSE). That covers this repository's own code only.

[wgpu-native](https://github.com/gfx-rs/wgpu-native) is dual-licensed **MIT or Apache-2.0** by the
gfx-rs project. Its binaries are not vendored into this repository — they are fetched from upstream's
own releases — but the per-platform npm packages *do* redistribute them, so those packages declare
`MIT OR Apache-2.0` and carry [`LICENSE-WGPU-NATIVE`](LICENSE-WGPU-NATIVE).

That file exists because **upstream's release archives contain no licence text at all** — the pinned
Windows archive holds exactly `include/`, `lib/` and `wgpu-native-meta/`. Shipping the shared library
without accompanying terms would be a licence violation, not untidiness, so the text is committed
here verbatim from the wgpu-native repository at the pinned tag and copied into every platform
package. It is deliberately not generated: a synthesised licence would mean an invented copyright
line. `bun run release:check` refuses to stage a release without it.

[`bun-webgpu`](https://github.com/kommander/bun-webgpu) (Apache-2.0) is credited above as prior art;
it is not a dependency and no code is taken from it.
