# wgpu-bun

A [Bun](https://bun.sh) FFI binding to [wgpu-native](https://github.com/gfx-rs/wgpu-native),
API-compatible with the [`webgpu`](https://www.npmjs.com/package/webgpu) npm package.

> ## Status: green on every supported platform, against three graphics APIs.
>
> **Implemented.** `create()` returns a real `GPU`. Adapter, device, buffers, textures, samplers,
> bind groups, pipelines, encoders, queues; WGSL compilation, compute dispatch, render to texture,
> buffer readback. Error scopes report, with negative tests proving they can go red.
> `getCompilationInfo()` returns real diagnostics. Backend selection is explicit.
>
> **Refused, not stubbed.** Nothing returns a plausible-looking nothing. A call either does the
> thing or throws saying it does not exist: the 40 wgpu-native symbols that abort the process are
> blocklisted by name, and the five out-of-scope subsystems are listed under [Scope](#scope) —
> surfaces, render bundles, indirect draw, occlusion queries, external textures.
>
> **Proven by execution on all four supported platforms**, against wgpu-native `v29.0.1.1`, each
> reaching a real device rather than skipping:
>
> | platform | adapter | API |
> |---|---|---|
> | `win32-x64` | Microsoft Basic Render Driver (WARP), and a discrete NVIDIA adapter locally | D3D12 |
> | `linux-x64` | llvmpipe (Mesa 25.2.8, 256-bit) | Vulkan |
> | `linux-arm64` | llvmpipe (Mesa 25.2.8, 128-bit) | Vulkan |
> | `darwin-arm64` | Apple Paravirtual device | Metal |
>
> Three graphics backends, two processor architectures, two calling conventions. The CI legs that
> cannot reach a device are configured to **fail rather than skip**, so a green matrix means the
> suite ran, not that it was excused.
>
> **Versioning: the major is the wgpu-native generation.** `wgpu-bun@29.x.y` binds wgpu-native
> **v29**. That digit is not a marketing choice and not a maturity signal — it names the native
> library inside, which is what decides ABI, validation strictness and WGSL acceptance. When
> upstream moves to v30, so does this package's major, on the same day and for that reason alone.
> Minor and patch are ordinary semver for this binding's own changes. See
> [Versioning](#versioning).
>
> [What is proven and what is argued](#what-is-proven-and-what-is-argued) still separates every
> claim resting on execution from every claim resting on a specification — the distinction that
> caught a real defect on three platforms at once, and is worth keeping now that they are green.

---

## What works today

| | |
|---|---|
| Pinned wgpu-native manifest — `v29.0.1.1`, 4 platforms, sha256 for each | ✅ |
| `bun run fetch` — download, verify, extract into `vendor/<rid>/` | ✅ |
| `resolveNativeLibrary()` — locate the installed library, report its origin | ✅ |
| Generated C-ABI struct layouts for all 115 aggregates, checked against a C compiler | ✅ |
| The abort-on-call blocklist, derived two independent ways and enforced in CI | ✅ |
| `create()` / `globals` — the WebGPU surface, adapter through readback | ✅ |
| Error scopes, nested, with negative tests proving they report | ✅ |
| `getCompilationInfo()`, synthesised from the creation-time validation error | ✅ |
| Explicit, documented backend selection (D3D12 / Vulkan / Metal) | ✅ |
| The by-value ABI holes — both directions — closed by a compiled shim | ✅ |
| A green test run on every supported platform, each on a real device | ✅ |
| Prebuilt shim artefacts published and pinned by sha256 | ⏳ not yet released |
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

## The ABI seam

`bun:ffi` has no struct-by-value argument type — `FFIType` has 22 members and none of them is a
struct. Seven wgpu-native entry points need exactly that: five of the eight `webgpu.h` functions
taking a callback-info struct by value (the other three are on the blocklist), plus
`wgpuAdapterInfoFreeMembers` and `wgpuSupportedFeaturesFreeMembers`.

Everything else is fine. All 115 descriptor structs — including the 168-byte
`WGPURenderPipelineDescriptor` with its nested vertex state — are passed **by pointer**. Descriptors
are not the problem. The whole hazard is seven functions of 207.

Aggregates also come back **out**: every wgpu-native callback receives its `message` as a 16-byte
`WGPUStringView` by value. That is the same phrase, a different size, and — critically — a different
rule.

| aggregate | Win64 | AArch64 AAPCS | SysV x86-64 |
|---|---|---|---|
| **40 B** `*CallbackInfo`, an argument | hidden reference | indirect (>16 B) | **stack (MEMORY)** |
| **16 B** `WGPUStringView`, a callback parameter | hidden reference (∉ {1,2,4,8}) | **two registers** | **two registers** |

**The two rows group the platforms differently, and that is the whole trap.** Row one makes SysV the
outlier. Row two makes **Win64** the outlier.

An earlier revision of this package read row one, concluded Win64 and AArch64 were both safe, and
declared the callback's `message` as a single pointer. Correct on Windows; wrong on `linux-x64`,
`linux-arm64` and `darwin-arm64` alike, where the callee reads the correlation ticket out of the
register holding `message.length`. The symptom was not a crash and not an ABI error: the ticket came
back as garbage, an unknown ticket is *deliberately* ignored (a late callback is normal), and the
promise simply never settled — a hang inside `requestAdapter` on three platforms simultaneously. It
survived every local run because the one platform available locally was the one it was right on.

Both directions are now bought from a compiler rather than reasoned about.

### How it is closed

`shim/` is a small Rust `cdylib` — no dependencies — that declares those aggregates as real
`#[repr(C)]` structs and lets a real compiler emit the sequence for whatever it is compiling for.
It gives JavaScript a flat surface in both directions:

- **Going in** — the seven entry points re-exported with flat pointer parameters. Since every call
  site already hands over a pointer to an already-packed buffer, **the shim's signature is the
  signature the binding was already using**.
- **Coming back** — seven C trampolines carrying the real callback prototypes. They take the
  by-value `WGPUStringView`, split it, and forward `(data, length)` to a flat JavaScript function.
  What goes into `WGPUCallbackInfo.callback` is the trampoline's address, not a `bun:ffi` callback's.

The seven are derived from the pinned header rather than collected by hand: nine callback typedefs
in `webgpu.h` take a by-value `WGPUStringView`, seven are reachable, and the two that are not
(`CreateComputePipelineAsync`, `CreateRenderPipelineAsync`) have entry points that abort on call
and are already blocklisted. A test asserts that partition against the header, so an upstream
release that adds a callback cannot slip past — see
[Not being wrong a third time](#not-being-wrong-a-third-time).

It resolves wgpu-native at runtime, by the exact absolute path the binding resolved, rather than
linking it. That is not laziness: linking would risk a *second* wgpu-native instance in the process
with its own global state, and it would tie the shim to a load-time search path when the real one is
decided at runtime. It also means the crate builds with no headers, no import library, and no
wgpu-native present — so a build runner needs a Rust toolchain and nothing else.

Three checks run before the shim is trusted, and each corresponds to a way the pairing can be wrong:

- **Flat-ABI version.** A shim built from different sources would be called with the wrong
  arguments, which corrupts a stack rather than raising anything.
- **wgpu-native generation.** The shim transcribes one generation's layouts by hand. Version skew is
  the one runtime failure mode a compiled shim *adds* over the direct path, so it is refused, not
  assumed away.
- **`sizeof` agreement.** The shim exports `size_of` for every aggregate it declares, and the binding
  compares it against the layouts it derived independently from the pinned headers. Two descriptions
  of the same C types, cross-checked at runtime on the real target — which is the one thing the
  build-time header oracle cannot do for a platform the author is not sitting on.

### Required on three platforms of four, built on all four

Because the direct path has to satisfy **both** rows of the table above, it is correct on
`win32-x64` and nowhere else. `linux-x64`, `linux-arm64` and `darwin-arm64` all require the shim.
(An earlier revision of this section said "only `linux-x64` needs it". That was the same mistake in
prose form, and it is what a CI matrix cost to find.)

It is built for all four anyway, including the one that does not need it, and the reason is **where
the code gets exercised**. `win32-x64` is the only platform a maintainer can run interactively,
attach a debugger to, or bisect on. A shim absent there would mean the calling path that ships to
everyone else is one that has never executed on a machine anybody was watching — which is precisely
the shape of the defect above. Built everywhere, the same trampolines run on every local test.

The cost is a four-target build matrix instead of three, paid by runners the test matrix already
uses.

The direct path is kept only as a **Win64 fallback**, so a fresh checkout with no Rust toolchain and
no published artefact still works on the platform most people meet the package on. Elsewhere there
is nothing correct to fall back to. `WGPU_BUN_SEAM=shim|direct|auto` forces the choice; `direct` off
Win64 is refused even when asked for, because an override may pick between correct paths, never
select an incorrect one:

| state | when |
|---|---|
| `shim` | a shim library resolved — preferred on every platform |
| `direct` | no shim, and **both** by-value rules permit a pointer — Win64 only |
| `refuse` | no shim, and either rule does not |

A refusal throws `AbiUnsupportedError`, which is a distinct class on purpose: it is a distinct and
expected condition, and filing it under anything else is how a reader ends up debugging a driver
problem that does not exist.

### Building and installing it

```sh
bun run shim:build     # cargo build for this host → vendor/<rid>/lib/
bun run shim:fetch     # download the pinned prebuilt artefact (once a release exists)
bun run shim:check     # report what is installed
```

**Consumers never need a Rust toolchain.** The shim ships prebuilt inside the same
`@wgpu-bun/<rid>` package that carries wgpu-native — one tarball, one version, one `os`/`cpu` match.
That is deliberate rather than convenient: a shim transcribes one wgpu-native generation's layouts,
so the two are only correct as a pair, and shipping them together makes separating them impossible
rather than merely inadvisable. Resolution is the same three tiers as the native library —
`WGPU_BUN_SHIM_LIB` → `@wgpu-bun/<rid>` → `vendor/<rid>/`.

## Versioning

**The major version is the wgpu-native generation this package binds.**

```
wgpu-bun@29.0.0
         ││ └── patch — this binding's own changes
         │└──── minor — this binding's own changes
         └───── major — wgpu-native v29. Not ours to pick.
```

Pick the major that matches the native behaviour you want; the rest is ordinary semver. A bump from
`29.x` to `30.x` means the native library changed generation — expect different validation, possibly
different WGSL acceptance — and it will happen even if not one line of this binding changed.

**Why not mirror the upstream tag exactly.** wgpu-native tags have four components (`v29.0.1.1`:
wgpu-core `29.0.1`, then upstream's own revision) and semver has three. Something had to give, so
the exact tag lives where it can be read in full instead — [`wgpu-native.manifest.ts`](./wgpu-native.manifest.ts),
this README, and the `.version` stamp written next to the installed library. The one part that could
have rotted silently is enforced instead: a test asserts this package's major **is**
`WGPU_NATIVE_MAJOR`, so a pin bump to v30 cannot ship as `29.x` and tell every consumer the ABI did
not move.

**Why not track the [`webgpu`](https://www.npmjs.com/package/webgpu) package's version**, given this
is API-compatible with it: that number moves for its own reasons — Dawn updates, its own fixes — and
would say nothing about which native library is inside. Between "what API shape do I get" and "what
implementation will actually run my shaders", the second is the one people are choosing a binding
for, and the second is what this number answers.

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

## What is proven and what is argued

The distinction this section exists for: **executed** means a machine ran it and the result was
observed. **Argued** means it follows from a document — an ABI specification, a header — and nothing
has run. Both can be true; only one is evidence. Everything below is one or the other, explicitly.

### Executed

| | |
|---|---|
| The whole suite on `win32-x64` — discrete NVIDIA/D3D12 locally, WARP in CI | adapter → device → compute dispatch → render to texture → readback → error scopes |
| Both seam paths on `win32-x64` | `WGPU_BUN_SEAM=shim` and `=direct` each run the full suite green |
| The shim's trampolines on `win32-x64` | all five installed and firing; a 246-character validation message decoded through the flat `(data, length)` path |
| The shim's `sizeof` against the derived layouts | at runtime, on the real target, for all five aggregates it declares |
| The version-skew guard | a shim reporting the wrong flat-ABI version is refused at load, as `AbiUnsupportedError` |
| The struct-layout oracle on `win32-x64` | all 115 aggregates, `sizeof`/`offsetof` from a real C compiler on the pinned headers |
| **The shim compiles on all four platforms** | CI built and uploaded it on `win32-x64`, `linux-x64`, `linux-arm64` and `darwin-arm64` |
| **The whole suite on every supported platform** | each leg reached a real device and ran: WARP/D3D12, llvmpipe/Vulkan on both architectures, Apple Paravirtual/Metal. All four bound the shim |
| **Both by-value ABI holes, on the platforms each one afflicts** | the 40-byte argument hole on `linux-x64` (SysV), the 16-byte `WGPUStringView` callback hole on all three non-Windows platforms. Each was found by a red CI leg and closed by a green one |
| **AArch64 register assignment for both aggregate sizes** | `linux-arm64` and `darwin-arm64` both green through the shim — the AAPCS rules are now observed behaviour, not a reading of the specification |
| **The layout oracle outside Windows** | it compiles the pinned headers with a real C compiler on every leg; the header-shadowing shim is Windows-only precisely because the other platforms have real system headers |
| **Struct layouts identical across all four platforms** | `check:layouts` green on every leg against that leg's own fetched headers |
| The structural guard against a third site | mutation-tested: a stray `JSCallback`, an inline arg list, and an unbound header callback each make it fail |
| Two of the forty abort-on-call symbols, by hand | `wgpuBufferWriteMappedRange` aborts; `wgpuBufferGetMappedRange` works |

### Argued, not executed

Short, and deliberately kept rather than deleted — a section that empties itself is a section nobody
will repopulate when the next claim outruns its evidence.

| | Basis | What would settle it |
|---|---|---|
| Behaviour on a **discrete** GPU on anything but Windows | every non-Windows leg ran on a software or paravirtualised adapter. Nothing here is adapter-specific, but "nothing here is" is an argument, not a measurement | a run on real hardware, which hosted runners do not offer |
| `win32-arm64` | the AAPCS rules it would follow are now executed on two other AArch64 platforms, but Windows-on-ARM combines them with the Win64 aggregate rule, and that pairing has never run | adding the RID and a runner |
| Thirty-eight of the forty abort-on-call symbols | upstream's Rust source at the pinned tag | the subprocess-per-symbol sweep (`bun run derive:aborts:probe`) |

### Not being wrong a third time

The most useful paragraph in this file for anyone extending the package, because it caught two
readers in a row:

> **Two different aggregates in this API have two different rules that partition the platforms
> differently.** A 40-byte `*CallbackInfo` *argument* goes by hidden reference on Win64 and AArch64
> and on the stack under SysV — SysV is the outlier. A 16-byte `WGPUStringView` *callback parameter*
> goes by hidden reference on Win64 and in two registers on both AArch64 and SysV — **Win64** is the
> outlier.
>
> So **the set of failing platforms will not match the ABI grouping anyone expects.** Three
> platforms failing identically read as evidence *against* an ABI cause, twice, because the failing
> set matched neither documented group. Both times it was an ABI cause belonging to the other
> aggregate. When a failure set does not match your model's partitions, the model has the wrong
> partitions.

It is worse than a subtle rule, because the failure is *silent by construction*. A shifted argument
list means the correlation identifier arrives as half of the message; the lookup that uses it finds
nothing and returns — which is a deliberate safety property, since a callback arriving after
teardown must be harmless. **The safety property and the ABI defect are indistinguishable from
inside.** The first occurrence presented as a hang; the second as a test observing zero events.

Found by sweep twice, so a sweep is not the answer. `test/callback-abi.test.ts` replaces it with
three checked properties:

1. **The hazardous set is derived from the pinned header**, not from a maintained list. Every
   callback typedef taking a by-value `WGPUStringView` must have a trampoline slot or a documented
   exemption; an upstream addition fails the test.
2. **Exactly one module in `src/` may construct a `JSCallback`** — the one that knows which seam
   path is bound. Everything else registers a plain handler with no FFI types in it. A construction
   site anywhere else fails the test.
3. **Every argument shape is a named constant.** An inline argument list at a construction site is
   exactly what both defects looked like; naming it forces the author to say which side of the ABI
   question it falls on.

All three were mutation-tested — each was made to fail deliberately before being trusted.

## Remaining gaps

Ordered by what blocks a release.

1. **No shim release has been cut**, so every `sha256` in `shim.manifest.ts` is empty — which means
   `bun run shim:fetch` refuses to install, by design. Until then the acquisition paths are
   `bun run shim:build` (needs cargo) or the platform npm package, which does not exist either.
2. **`private: true` is still set**, and `bun run release:check` names it as a blocker. It is an
   interlock, not an oversight: `npm publish` refuses a private package, so nothing can reach the
   registry by accident. Clearing it is a deliberate release decision that belongs in the release
   commit next to the version bump.
3. **The version is `0.0.0`.** It stays `0.0.x` while the status flag says the binding is
   unfinished — the test suite binds those two together so the claim and the code cannot drift.
4. **The behaviour-derived blocklist sweep has not been run** against the shipped binary. The list is
   source-accurate at the pinned tag; the tag and the shipped build can differ by a commit, which is
   the reason the second derivation exists.
5. **No WebGPU CTS run.** A worthy goal, and not a claim that will be made before it is measured.

## Install

Not published yet. The npm name `wgpu-bun` was unclaimed as of 2026-08-07, and nothing will be pushed
to it until the platform matrix has actually been executed on more than one platform — publishing a
package whose claims outrun its evidence is how the next person loses a day.

To work on it:

```sh
bun install
bun run fetch          # download + verify the pinned wgpu-native for this host
bun run shim:build     # build the ABI shim (needs cargo; see The ABI seam)
bun run check:layouts  # confirm the generated struct layouts match those headers
bun run typecheck
bun test
```

`shim:build` is optional **only on `win32-x64`**, where the direct path is correct anyway — and even
there it is worth building, because it is the path that ships everywhere else. On `linux-x64`,
`linux-arm64` and `darwin-arm64` it is not optional: without it the GPU suites skip with
`abi-unsupported`.

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

## How the native libraries reach you

Via **per-platform npm packages in `optionalDependencies`** — `@wgpu-bun/win32-x64`,
`@wgpu-bun/linux-x64`, and so on, each declaring `os` / `cpu` so your package manager installs
exactly the matching one. This is what esbuild, swc, sharp and `bun-webgpu` all do.

Each carries **two** shared libraries: upstream's `wgpu_native`, and this project's ABI shim. They
ship in one tarball rather than two packages because a shim transcribes one wgpu-native generation's
struct layouts by hand and is only correct paired with it — one package makes the two impossible to
separate, where two packages would merely make separating them a bad idea. The binding does check for
skew at load and refuses, but never being able to reach that state is better than refusing well.

Neither library is fetched at install time, and **no consumer needs a Rust toolchain**: the shim is
built by CI, one platform per matching runner, and published as a prebuilt artefact.

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
listing four packages the install cannot resolve. `bun run release:wire` writes the block at release
time from the same manifest that pins the binaries. Any platform whose archive did not land is
reported as unpublished rather than declared as a target.

## Supply chain

Native binaries are **fetched, never committed** — upstream's and ours alike. Every download is
pinned to an exact URL and an exact sha256, in [`wgpu-native.manifest.ts`](wgpu-native.manifest.ts)
for upstream's archives and [`shim.manifest.ts`](shim.manifest.ts) for the ABI shim, and a mismatch
always hard-fails — including under `--soft`, which exists so a fresh clone without network can still
proceed, not to wave through an unexpected binary.

The same rule covers the shim's *absence* of a pin: every shim `sha256` is empty because no shim
release has been cut, an empty hash means unpinned, and `bun run shim:fetch` refuses to install an
unpinned binary and says why. A plausible-looking invented hash in a supply-chain file is worse than
a blank one.

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
cd shim && cargo test          # the shim's own view of the aggregates it declares
WGPU_BUN_SEAM=direct bun test  # the same suite over the other calling path, where the ABI allows it
```

**A skipped GPU suite must never read as a passed one.** The rules:

| Reason a device could not be acquired | Default | Escape hatch |
|---|---|---|
| No native library installed | **fails** | `WGPU_BUN_ALLOW_NO_LIBRARY=1` |
| No adapter on this host | **fails** | `WGPU_BUN_ALLOW_NO_ADAPTER=1` |
| `requestDevice` failed with an adapter present | **fails** | none — that is a defect |
| The ABI needs the shim and none is installed | skips | none; the escape is installing it |
| A native call's callback never arrived | **fails** | none — see below |
| The binding is unimplemented | skips | none; see below |

The escapes are environment variables rather than auto-detection, so granting one is a visible,
per-job decision a reviewer can see in the workflow file, and a local run never grants itself one.

**`no-callback` is its own reason too, and for the same argument one level along.** A call that is
issued and never completes used to arrive here as `no-adapter` as well. Wrong twice: the runners that
hit it *had* adapters, and `no-adapter` is escapable by an environment variable two matrix legs are
granted — so a genuine completion defect could be skipped past on exactly the legs most likely to
have one. It is never permitted. A device that never answers and a binding that mis-decodes its own
callback arguments produce the identical symptom, so the thrown error prints the seam's requested /
resolved / bound modes and the shim path, rather than telling the reader to go and find them.

**`abi-unsupported` is its own reason, and that matters more than it looks.** The seam's refusal used
to reach the gate as an untyped throw from `requestAdapter()` and get filed under `no-adapter` — a
diagnosis meaning "this host has no GPU". On the `linux-x64` CI runner that was flatly untrue:
`vulkaninfo` reports `llvmpipe (LLVM 20.1.2) / DRIVER_ID_MESA_LLVMPIPE` on the same machine, so the
software adapter was installed and visible the whole time, and the label sent a reader looking for a
driver problem that did not exist. A binding declining an ABI it cannot express and a machine with no
GPU are different facts. There is no environment variable for it, because "run without the artefact
that makes it correct" is not a decision anyone should be able to grant: it is a permitted skip only
while **no shim is installed for the host**, and if one is installed and the seam still refused, that
is a defect and it goes red. The kind stops being reachable the moment the artefact lands —
mechanically, rather than by anyone remembering to delete it.

The unimplemented-skip would be a permanent loophole — never finish it and nothing ever has to run —
except that the same flag is bound to the package's public claims: while it is set, the README must
carry the status banner and the version must stay `0.0.x`. The way out of the skip is not a knob, it
is shipping.

CI runs a four-platform matrix. Linux legs install Mesa's lavapipe and are **required** to find an
adapter; the Windows and macOS legs are permitted to skip while it is established whether WARP and
paravirtualised Metal come up on hosted runners. A final job reads one marker per leg and **fails the
run if no leg anywhere reached a device** — four individually-defensible skips must not add up to a
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
- **No build step for the JavaScript.** Bun consumes the TypeScript sources directly; there is no
  `dist/`, no bundler and no source-map drift. The one compiled artefact is the ABI shim, and it is
  built by CI and shipped prebuilt — a consumer never compiles anything, and a contributor only needs
  cargo if they are changing `shim/src/lib.rs`. That is a real cost and it is the price of being
  correct on SysV x86-64; it is recorded rather than glossed over.
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
