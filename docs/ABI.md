# The ABI seam

Everything in this file is about one boundary: `bun:ffi` has no way to express a C aggregate passed
**by value**, and wgpu-native does it in both directions. If you never intend to change
`src/ffi/`, you do not need any of it. If you do, [Not being wrong a third
time](#not-being-wrong-a-third-time) is the paragraph to read first — it has caught two readers in a
row.

- [The 40 symbols that abort the process](#the-40-symbols-that-abort-the-process)
- [Two more ways it aborts, which are not symbols](#two-more-ways-it-aborts-which-are-not-symbols)
- [The by-value hole](#the-by-value-hole)
- [How it is closed](#how-it-is-closed)
- [Required on three platforms of four, built on all four](#required-on-three-platforms-of-four-built-on-all-four)
- [Struct layouts](#struct-layouts)
- [Not being wrong a third time](#not-being-wrong-a-third-time)

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
essentially every GPU workload. Three more shape this package's design:
`wgpuShaderModuleGetCompilationInfo` (see [ERROR-PATH.md](./ERROR-PATH.md)), `wgpuDeviceGetLostFuture`
(so `device.lost` cannot be backed natively), and `wgpuInstanceWaitAny` (so async completion is
driven by polling). Twenty-one of the forty are `*SetLabel`, which is why labels are only ever passed
in creation descriptors and never assigned afterwards.

The list is derived **two independent ways** — by executing every exported symbol in an isolated
subprocess and watching for the panic banner, and by parsing upstream's Rust source at the pinned tag
— and the two derivations must agree, at 40, or CI fails. A version bump cannot quietly re-admit one.

## Two more ways it aborts, which are not symbols

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

### Why it aborts at all, and what it would take upstream

Worth stating plainly, because the answer is not "Rust cannot do better here": **wgpu-native already has
the machinery, and the submit path just does not use it.** Dawn returns an error for the same input.

`src/lib.rs` at the pinned tag has two error routes side by side:

```rust
fn handle_error_fatal(cause: impl error::Error + Send + Sync + 'static, operation: &'static str) -> ! {
    panic!("Error in {operation}: {f}", f = format_error(&cause));
}

fn handle_error(sink_mutex: &Mutex<ErrorSinkRaw>, source: …, label: …, fn_ident: &'static str) {
    …  // routes to the error scope / uncaptured-error callback, i.e. what the spec wants
}
```

There are **17 `handle_error_fatal` call sites**, and `wgpuQueueSubmit` is one of them. The interesting
part is what sits twenty lines below it:

| function | what it does with an error |
|---|---|
| `wgpuQueueSubmit` | `handle_error_fatal(cause.1, "wgpuQueueSubmit")` — **panics** |
| `wgpuQueueWriteBuffer` | `handle_error(error_sink, cause, None, "wgpuQueueWriteBuffer")` — reports |

Both are methods on the same object, and `WGPUQueueImpl` **already carries the sink**:

```rust
pub struct WGPUQueueImpl {
    queue: Arc<QueueId>,
    error_sink: ErrorSink,
}
```

So the change is to take the sink the sibling function already takes, and call the function the
sibling function already calls:

```diff
-    let (queue_id, context) = {
+    let (queue_id, context, error_sink) = {
         let queue = queue.as_ref().expect("invalid queue");
-        (queue.queue.id, &queue.queue.context)
+        (queue.queue.id, &queue.queue.context, &queue.error_sink)
     };
     …
     if let Err(cause) = context.queue_submit(queue_id, &command_buffers) {
-        handle_error_fatal(cause.1, "wgpuQueueSubmit");
+        handle_error(error_sink, cause.1, None, "wgpuQueueSubmit");
     }
```

The `conv.rs` panics are a **different class** and need a different fix: `panic!("invalid rowsPerImage")`
sits inside a pure conversion function with no sink and no error return, so making it reportable means
changing that function's signature rather than its body. There are 38 such panicking sites in `conv.rs`.

**Upstream state, as of this writing:** issue
[#113](https://github.com/gfx-rs/wgpu-native/issues/113) ("When will panics become errors that can be
handled?") has been open since 2021; in 2023 a maintainer asked on it whether the fatal categorisation —
inherited from wgpu-rs, where a panic is catchable — should simply be dropped for the C API, and the
question was never answered. Issue [#588](https://github.com/gfx-rs/wgpu-native/issues/588) reports
exactly this for `wgpuQueueSubmitForIndex`, the sibling of the function above. Nothing tracks
`wgpuQueueSubmit` itself.

⚠ **Argued, not executed.** The diff above has not been compiled or run — no patched wgpu-native has
been built and tested here, so it belongs in the same column as everything else in
[EVIDENCE.md](./EVIDENCE.md#argued-not-executed) that rests on reading rather than running. What *is*
executed is the abort itself, and the shape that avoids it: encode, `finish()`, `popErrorScope()`, do
not submit.

## The by-value hole

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

## How it is closed

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

## Required on three platforms of four, built on all four

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

**Consumers never need a Rust toolchain** — the shim ships prebuilt inside the same
`@wgpu-bun/<rid>` package that carries wgpu-native. These commands are for working on the package
itself:

```sh
bun run shim:build     # cargo build for this host → vendor/<rid>/lib/
bun run shim:fetch     # download the pinned prebuilt artefact (once a shim release exists)
bun run shim:check     # report what is installed
```

One tarball, one version, one `os`/`cpu` match. That is deliberate rather than convenient: a shim
transcribes one wgpu-native generation's layouts, so the two are only correct as a pair, and shipping
them together makes separating them impossible rather than merely inadvisable. Resolution is the same
three tiers as the native library — `WGPU_BUN_SHIM_LIB` → `@wgpu-bun/<rid>` → `vendor/<rid>/`.

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

## Not being wrong a third time

The most useful paragraph in this repository for anyone extending the package, because it caught two
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
