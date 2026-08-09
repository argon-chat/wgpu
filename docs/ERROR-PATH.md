# The error path

The reason this package exists, stated at length. The short version is on the
[front page](../README.md): a binding whose error scope cannot report is worse than one that
crashes.

## Why it is the point

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

## Shader diagnostics: what is actually on offer

`getCompilationInfo` is not merely missing from other bindings. **`wgpuShaderModuleGetCompilationInfo`
is `unimplemented!()` in wgpu-native itself** — it is one of the [40 exported symbols that abort the
process](./ABI.md#the-40-symbols-that-abort-the-process). There is no native call to forward to. A
binding that wires `GPUShaderModule.getCompilationInfo()` straight through does not return empty
diagnostics; it kills the process.

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

That is the hard 80%, and it works. If Dawn is the backend you want, it is a reasonable answer.

It was set aside here for two specific reasons:

- **Its error path is broken.** `popErrorScope` crashes its userdata allocator — *even on an empty
  scope*, i.e. on the happy path. `getCompilationInfo()` is unimplemented.
- **It targets Dawn**, and the backend is a choice worth making deliberately (below).

That assessment sets this package's bar. **Its entire justification is the error path and the backend
choice**, so those are first-class deliverables, not a later milestone.

## wgpu-native rather than Dawn — a deliberate backend choice

Dawn and wgpu-native are both conformant-ish WebGPU implementations that disagree in observable ways:
validation strictness, WGSL acceptance, reported limits, resource lifetimes, error message text.
Neither is "correct"; they are different.

They are also not obscure alternatives — they are **the two browser implementations**, and which one
you validate against is the choice this package exists to hand you:

| | implementation | ships in |
|---|---|---|
| **wgpu-native** — what this binds | the C API over [`wgpu`](https://github.com/gfx-rs/wgpu) | "the core of the WebGPU integration in **Firefox, Servo, and Deno**" — wgpu's own README |
| **Dawn** — what `webgpu` and `bun-webgpu` bind | Google's implementation | "the underlying implementation of WebGPU in **Chromium**" — Dawn's own README |

Deno is the one to notice if you are choosing a JavaScript runtime's binding: its WebGPU is wgpu, so
this is the binding that makes Bun agree with Deno rather than with Chrome. And if you ship a Rust
or wgpu-based renderer, it is the same implementation your other half already runs.

The general form of the argument: a Dawn-backed binding tests an implementation you may not deploy —
and passes.

Bindings are the right layer to make that choice at. Being able to pick the implementation your JS
code is validated against, rather than inheriting whichever one your binding's author preferred, is
most of the value here.

## Why `webgpu` itself is not an option under Bun

`webgpu` (dawn-gpu/node-webgpu) ships Dawn as a prebuilt N-API addon —
`dist/<platform>-<arch>.dawn.node`, loaded through `createRequire`. Bun's N-API compatibility does not
stretch to it: loading the addon **segfaults the runtime** rather than throwing a catchable error.
Verified on Bun 1.4 (canary), Windows, 2026-08-07.

That is a hard wall, not a papering-over-able bug. Any WebGPU workload behind that package is simply
unreachable from Bun.
