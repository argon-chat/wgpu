# The error path

Why this package exists. The short version is on the [front page](../README.md): a binding whose
error scope cannot report is worse than one that crashes.

## Why it is the point

For both `popErrorScope` and `getCompilationInfo`, the dangerous failure mode is not a crash but a
**silent green**. Real WebGPU suites use the error scope *as the assertion* — push a scope, do the
thing, pop, pass if the result is null, check nothing else. An error scope that records nothing, or
a `getCompilationInfo()` that unconditionally returns an empty message list, therefore makes every
assertion built on it pass vacuously. A crash gets fixed; a silent green survives and voids
everything downstream of it.

So this package owes its users **negative tests**: proof that it *reports* a validation error and
*reports* a shader compilation error, not merely that it survives being asked for one. Every
error-path test in `test/` is a **pair** — an operation that must report, and the valid twin that
differs only in the way that makes it valid and must report nothing. A do-nothing implementation
fails the first half; an always-report implementation fails the second.

## Shader diagnostics: what is actually on offer

**`wgpuShaderModuleGetCompilationInfo` is `unimplemented!()` in wgpu-native itself**
(`src/unimplemented.rs`, unchanged from `v29.0.0.0` through current trunk) — one of the [40 exported
symbols that abort the process](./ABI.md#the-40-symbols-that-abort-the-process). There is no native
call to forward to: a binding that wires `GPUShaderModule.getCompilationInfo()` straight through
kills the process rather than returning empty diagnostics. So the honest offering is:

> **Shader compilation errors arrive through the error scope, at `createShaderModule` time.**
> `getCompilationInfo()` is *synthesised* from that same validation error — not fetched from
> wgpu-native.

Dawn keeps the two channels independent; here they are one. No *information* is lost — naga's
diagnostic text lands in the validation error either way — but they are not independent oracles, and
code that only ever calls `getCompilationInfo()` without an error scope is relying on synthesis.

```ts
device.pushErrorScope('validation');
const module = device.createShaderModule({ code });
const error = await device.popErrorScope();   // ← the real channel
if (error) console.error(error.message);
```

## Prior art: `bun-webgpu`

[`bun-webgpu`](https://github.com/kommander/bun-webgpu) (Apache-2.0, by SST) already covers the
heavy end of the WebGPU API competently over `bun:ffi`. Exercised by hand on 2026-08-07 — no harness
is committed, so this is a report, not a measurement anyone can re-run — it correctly handled compute
dispatch with buffer readback, `r32uint` storage textures, `depth-2d-array` textures with comparison
samplers, 3D textures with live mip chains, and the `shader-f16` feature with `rgba16float` render
targets. That is the hard 80%. It was set aside here for two reasons: its error path is broken on
Windows, and it targets Dawn — a choice worth making deliberately (below).

### What the error-path defect actually is

Established by reading their source at `v0.1.7` (`7be02a53`).

**`getCompilationInfo()` throws — it does not return an empty list.** The body is
`return fatalError('getCompilationInfo not implemented')`, which logs to `console.error` and throws.
A loud "not implemented" is the honest failure, not the silent-green one, so the hazard above does
not apply to it — and on Dawn it is a *fillable* gap, because Dawn implements the underlying call
that wgpu-native aborts on.

**Their `popErrorScope` breaks on Win64, and it is the same 16-byte aggregate this package hit from
the opposite side.** They declare the callback's `WGPUStringView` as two register arguments —
correct under SysV x86-64 and AArch64 AAPCS, wrong under Win64, where 16 bytes go by hidden
reference. Every argument after it shifts by one slot, so `userdata1` receives what was packed as
`userdata2` — zero. Their callback unpacks the correlation ticket from `userdata1` *before* testing
for an empty message, so the empty-scope early return is unreachable and the happy path fails too.
Their own source names the rule, beside the one callback they patched for it:

> ```
> // On windows, the WGPUStringView as value is not spread across multiple arguments, for some reason,
> // so we need to pass the messageSize as the userdata1 pointer
> ```

Eight of their nine `JSCallback` sites take a `WGPUStringView` by value; that patch covers one. So
this is [the exact aggregate and the exact rule](./ABI.md#not-being-wrong-a-third-time) that cost
this package a CI matrix, with the partition falling the other way round: this binding was correct on
Win64 and broken on the other three platforms; theirs is correct on those three and broken on Win64.

⚠ **Argued, not executed**: the argument-shift chain above is read out of their source and the ABI
rule, not run under a debugger, and their repository has no error-scope test and documents no crash.
The conclusion is not in doubt — the fix belongs in a compiled wrapper that decodes the aggregate for
the callee, which is what this package does and what their own `TODO` beside that patch proposes
("the zig wrapper should probably wrap the callback as well and pass the arguemnts correctly", *sic*).

## wgpu-native as the default — a deliberate choice

Dawn and wgpu-native are both conformant-ish WebGPU implementations that disagree observably:
validation strictness, WGSL acceptance, reported limits, resource lifetimes, error message text.
Neither is "correct"; they are different. They are also **the two browser implementations**, and
which one you validate against is the choice this package exists to hand you:

| | implementation | ships in |
|---|---|---|
| **wgpu-native** — what this binds | the C API over [`wgpu`](https://github.com/gfx-rs/wgpu) | "the core of the WebGPU integration in **Firefox, Servo, and Deno**" — wgpu's own README |
| **Dawn** — what `webgpu` and `bun-webgpu` bind, and what this loads under `WGPU_BUN_IMPL=dawn` | Google's implementation | "the underlying implementation of WebGPU in **Chromium**" — Dawn's own README |

Deno is the one to notice when choosing a JavaScript runtime's binding: its WebGPU is wgpu, so this
is the binding that makes Bun agree with Deno rather than with Chrome. And if you ship a Rust or
wgpu-based renderer, it is the same implementation your other half already runs. A Dawn-only binding
tests an implementation you may not deploy — and passes. This package binds both
([DAWN.md](./DAWN.md)); wgpu-native is merely what it loads when you do not say otherwise.

## Why `webgpu` itself is not an option under Bun

`webgpu` (dawn-gpu/node-webgpu) ships Dawn as a prebuilt N-API addon —
`dist/<platform>-<arch>.dawn.node`, loaded through `createRequire`. Bun's N-API compatibility does
not stretch to it: loading the addon **segfaults the runtime** rather than throwing a catchable
error. Verified on Bun 1.4 (canary), Windows, 2026-08-07 and again 2026-08-09. Any WebGPU workload
behind that package is unreachable from Bun.
