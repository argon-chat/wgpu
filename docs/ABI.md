# The ABI seam

One boundary: `bun:ffi` has no way to express a C aggregate passed **by value**, and wgpu-native
does it in both directions. If you never intend to change `src/ffi/`, you do not need any of it. If
you do, start with [Not being wrong a third time](#not-being-wrong-a-third-time).

- [The 40 symbols that abort the process](#the-40-symbols-that-abort-the-process)
- [Two more ways it aborts, which are not symbols](#two-more-ways-it-aborts-which-are-not-symbols)
- [The by-value hole](#the-by-value-hole)
- [How it is closed](#how-it-is-closed)
- [Required on three platforms of four, built on all four](#required-on-three-platforms-of-four-built-on-all-four)
- [Struct layouts](#struct-layouts)
- [Not being wrong a third time](#not-being-wrong-a-third-time)

## The 40 symbols that abort the process

wgpu-native exports 40 `unimplemented!()` functions: 35 in `src/unimplemented.rs`, 5 in
`src/lib.rs`. The entry points are `extern "C"` and non-unwinding, so the Rust panic cannot be
caught — calling one **kills the process**: no exception, no JS stack, no partial results. In the
export table and in `webgpu.h` they are typed exactly like their working neighbours. The specific
trap:

| Aborts | Use instead |
|---|---|
| `wgpuBufferReadMappedRange` | `wgpuBufferGetConstMappedRange` |
| `wgpuBufferWriteMappedRange` | `wgpuBufferGetMappedRange` |

Those two are the **modern `webgpu.h` spellings**, so a binding generated faithfully from the header
picks exactly the pair that aborts, and dies on its first buffer readback. Three more shape this
package's design: `wgpuShaderModuleGetCompilationInfo` (see [ERROR-PATH.md](./ERROR-PATH.md)),
`wgpuDeviceGetLostFuture` (so `device.lost` cannot be backed natively) and `wgpuInstanceWaitAny` (so
async completion is driven by polling). Twenty-one of the forty are `*SetLabel`, which is why labels
are only ever passed in creation descriptors and never assigned afterwards.

Two derivations. CI gates the source one: `bun run derive:aborts:source --check` parses upstream's
Rust at the pinned tag and must agree with the checked-in list at 40. Offline, on every run,
`test/abort-symbols.test.ts` re-derives the 5 whose names survive into the compiled library. The
execution sweep `bun run derive:aborts:probe` calls every exported symbol in its own subprocess and
reproduces the list exactly against the shipped `v29.0.1.1` on `win32-x64`
([EVIDENCE.md](./EVIDENCE.md#executed)).

## Two more ways it aborts, which are not symbols

The blocklist covers functions that abort *whenever* they are called. Two further paths abort only
on particular **inputs**, so no symbol list can catch them. Both were found by executing this
binding, and both are handled here:

- **A zero `rowsPerImage` on `copyTextureToBuffer` / `copyBufferToTexture`** hits
  `0 => panic!("invalid rowsPerImage")` in `map_texture_data_layout` (`conv.rs`). The *omitted*
  sentinel is `WGPU_COPY_STRIDE_UNDEFINED` (`0xFFFFFFFF`), which maps cleanly to `None` — so it is a
  zeroed field, the ordinary result of not writing one, that kills the process. The binding fills it
  from `copySize.height`, the default the WebGPU specification already defines for a single-layer
  copy, so nothing is invented. `writeTexture` is *not* treated the same way: it accepts the field's
  absence, and supplying it there trips a different check.

- **Submitting an invalid command buffer** aborts inside `wgpuQueueSubmit`
  (`Error in wgpuQueueSubmit: Validation Error`), consulting neither the installed uncaptured-error
  callback nor the open error scope. Device-level creation and `commandEncoder.finish()` do report
  normally, so a negative test is shaped **encode, `finish()`, `popErrorScope()` — and do not
  submit.** The verdict is asynchronous and `submit()` is synchronous by specification, so
  suppressing submissions on suspicion would break every legitimate frame.

### Why it aborts at all, and what it would take upstream

**wgpu-native already has the machinery, and the submit path just does not use it.** Dawn, given the
same input, returns an error: `QueueBase::APISubmit` (`src/dawn/native/Queue.cpp`) hands any
`SubmitInternal` failure to `GetDevice()->ConsumedError(...)`, which routes it to the open error
scope or the uncaptured-error callback like any other validation failure. Dawn's copy-layout
validation is likewise `DAWN_INVALID_IF` in `ValidateLinearTextureData`, a recoverable `MaybeError`.

`src/lib.rs` at the pinned tag has two error routes side by side:

```rust
fn handle_error_fatal(cause: impl error::Error + Send + Sync + 'static, operation: &'static str) -> ! {
    panic!("Error in {operation}: {f}", f = format_error(&cause));
}

fn handle_error(sink_mutex: &Mutex<ErrorSinkRaw>, source: …, label: Label<'_>, fn_ident: &'static str) {
    …  // routes to the error scope / uncaptured-error callback, i.e. what the spec wants
}
```

There are **16 `handle_error_fatal` call sites**; `wgpuQueueSubmit` is one, and its sibling in the
same file is not:

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

So the change is to take the sink the sibling takes, and call the function the sibling calls:

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

The `conv.rs` panics are a **different class**: `panic!("invalid rowsPerImage")` sits in a pure
conversion function with no sink and no error return, so making it reportable means changing that
function's signature, not its body. `conv.rs` has 23 `panic!` sites and a further 15 `.expect(…)`.

**Upstream state, as of this writing:** issue
[#113](https://github.com/gfx-rs/wgpu-native/issues/113) ("When will panics become errors that can be
handled?") has been open since June 2021; in June 2023 a maintainer asked on it whether the fatal
categorisation, inherited from wgpu-rs, should simply be dropped for the C API, and got no answer.
Issue [#588](https://github.com/gfx-rs/wgpu-native/issues/588) reports exactly this for
`wgpuQueueSubmitForIndex`, the sibling of the function above. Nothing tracks `wgpuQueueSubmit`
specifically; only the umbrella #113 covers it.

⚠ **Argued, not executed.** The diff above has not been compiled or run, so it belongs in the same
column as everything else in [EVIDENCE.md](./EVIDENCE.md#argued-not-executed) that rests on reading
rather than running. What *is* executed is the abort itself, and the shape that avoids it.

## The by-value hole

`bun:ffi` has no struct-by-value argument type: `FFIType` has 41 members over 21 distinct numeric
values, none of them a struct. Seven wgpu-native entry points need exactly that — five of the eight
`webgpu.h` functions taking a callback-info struct by value (the other three are blocklisted), plus
`wgpuAdapterInfoFreeMembers` and `wgpuSupportedFeaturesFreeMembers`. Everything else is fine:
descriptors go **by pointer**, including the 168-byte `WGPURenderPipelineDescriptor` with its nested
vertex state, and of the 115 aggregates the two pinned headers declare, only the five shapes the
shim redeclares ever cross by value. The hazard is seven functions out of the 202 in `webgpu.h`.

Aggregates also come back **out**: every wgpu-native callback receives its `message` as a 16-byte
`WGPUStringView` by value — same phrase, different size, different rule.

| aggregate | Win64 | AArch64 AAPCS | SysV x86-64 |
|---|---|---|---|
| **40 B** `*CallbackInfo`, an argument | hidden reference | indirect (>16 B) | **stack (MEMORY)** |
| **16 B** `WGPUStringView`, a callback parameter | hidden reference (∉ {1,2,4,8}) | **two registers** | **two registers** |

Row one makes SysV the outlier; row two makes **Win64** the outlier. An earlier revision read row
one only, declared the callback's `message` a single pointer, and hung inside `requestAdapter` on
`linux-x64`, `linux-arm64` and `darwin-arm64` at once — on those three the callee reads the
correlation ticket out of the register holding `message.length`. It survived every local run because
the one platform available locally was the one it was right on.

## How it is closed

Both directions are now bought from a compiler rather than reasoned about. `shim/` is a small
dependency-free Rust `cdylib` that declares those aggregates as real `#[repr(C)]` structs and lets a
real compiler emit the sequence for whatever it is compiling for. JavaScript gets a flat surface in
both directions:

- **Going in** — the seven entry points re-exported with flat pointer parameters. Every call site
  already hands over a pointer to an already-packed buffer, so **the shim's signature is the
  signature the binding was already using**.
- **Coming back** — seven C trampolines carrying the real callback prototypes. They take the
  by-value `WGPUStringView`, split it, and forward `(data, length)` to a flat JavaScript function.
  What goes into `WGPUCallbackInfo.callback` is the trampoline's address, not a `bun:ffi` callback's.

The trampolined set is derived from the pinned header, not collected by hand: nine callback typedefs
in `webgpu.h` take a by-value `WGPUStringView`, seven are reachable, and the two that are not
(`CreateComputePipelineAsync`, `CreateRenderPipelineAsync`) have entry points that abort on call and
are already blocklisted. `test/callback-abi.test.ts` asserts that partition against the header, so
an upstream release that adds a callback cannot slip past.

The shim resolves wgpu-native at runtime, by the exact absolute path the binding resolved, rather
than linking it. Linking would risk a *second* wgpu-native instance in the process with its own
global state, and would tie the shim to a load-time search path when the real one is decided at
runtime. It also lets the crate build with no headers, no import library and no wgpu-native present,
so a build runner needs a Rust toolchain and nothing else.

Three checks run before the shim is trusted, one per way the pairing can be wrong:

- **Flat-ABI version.** A shim built from different sources would be called with the wrong
  arguments, which corrupts a stack rather than raising anything.
- **wgpu-native generation.** The shim transcribes one generation's layouts by hand. Version skew is
  the one runtime failure mode a compiled shim *adds* over the direct path, so it is refused rather
  than assumed away.
- **`sizeof` agreement.** The shim exports `size_of` for every aggregate it declares; the binding
  compares it against the layouts it derived independently from the pinned headers. Two descriptions
  of the same C types, cross-checked at runtime on the real target — the one thing the build-time
  header oracle cannot do for a platform the author is not sitting on.

## Required on three platforms of four, built on all four

The direct path has to satisfy **both** rows of the table above, so it is correct on `win32-x64` and
nowhere else; `linux-x64`, `linux-arm64` and `darwin-arm64` all require the shim. (An earlier
revision of this section said "only `linux-x64` needs it" — the same mistake in prose form, found by
a CI matrix.)

It is built for all four anyway, because `win32-x64` is the only platform a maintainer can run
interactively, attach a debugger to or bisect on: no shim there would mean the calling path that
ships to everyone else has never executed on a machine anybody was watching. The direct path
survives only as a **Win64 fallback**, so a fresh checkout with no Rust toolchain and no published
artefact still works on the platform most people meet the package on; elsewhere there is nothing
correct to fall back to. `WGPU_BUN_SEAM=shim|direct|auto` forces the choice, but
`direct` off Win64 is refused even when asked for, because an override may pick between correct
paths, never select an incorrect one:

| state | when |
|---|---|
| `shim` | a shim library resolved — preferred on every platform |
| `direct` | no shim, and **both** by-value rules permit a pointer — Win64 only |
| `refuse` | no shim, and either rule does not |

A refusal throws `AbiUnsupportedError`. It gets its own class because filing it under anything else
is how a reader ends up debugging a driver problem that does not exist.

### Building and installing it

**Consumers never need a Rust toolchain** — the shim ships prebuilt inside the same
`@wgpu-bun/<rid>` package that carries wgpu-native. These commands are for working on the package
itself:

```sh
bun run shim:build     # cargo build for this host → vendor/<rid>/lib/
bun run shim:fetch     # download the pinned prebuilt artefact (once a shim release exists)
bun run shim:check     # report what is installed
```

One tarball, one version, one `os`/`cpu` match: shim and library are only correct as a pair (above),
and shipping them together makes separating them impossible rather than merely inadvisable.
Resolution is the same three tiers as the native library: `WGPU_BUN_SHIM_LIB` → `@wgpu-bun/<rid>` →
`vendor/<rid>/`.

## Struct layouts

Every C-ABI struct layout in `src/layouts/generated/` is **derived from the pinned headers**, never
hand-counted. The generated tables carry member names and type tags only — no offsets, no sizes,
nothing numeric — and offsets are computed from them at import time. `test/layout-oracle.test.ts`
compiles the real headers with TinyCC and checks all 115 aggregates against the C compiler's own
`sizeof`, `_Alignof` and `offsetof`. Those are compile-time facts, so the oracle needs no GPU and no
linking and runs on every CI runner, including the ones with no adapter.

The tables record the sha256 of the headers they came from, so a bumped pin with stale layouts fails
the oracle instead of silently shifting every offset after the inserted member — hence the ordering
rule **`bun run fetch`, then `bun run gen:layouts`**, which `bun run check:layouts` enforces.

## Not being wrong a third time

This caught two readers in a row:

> **Two aggregates in this API follow two rules that partition the platforms differently.** The
> 40-byte `*CallbackInfo` *argument* makes SysV the outlier; the 16-byte `WGPUStringView` *callback
> parameter* makes Win64 the outlier (see [the table](#the-by-value-hole)).
>
> So **the set of failing platforms will not match the ABI grouping anyone expects.** Three
> platforms failing identically read as evidence *against* an ABI cause, twice, because the failing
> set matched neither documented group. Both times it was an ABI cause belonging to the other
> aggregate. When a failure set does not match your model's partitions, the model has the wrong
> partitions.

The failure is *silent by construction*: a shifted argument list means the correlation identifier
arrives as half of the message, and the lookup that uses it finds nothing and returns — a deliberate
safety property, since a callback arriving after teardown must be harmless. **The safety property
and the ABI defect are indistinguishable from inside.** The first occurrence presented as a hang;
the second as a test observing zero events.

Found by sweep twice, so a sweep is not the answer. `test/callback-abi.test.ts` replaces it with
three checked properties:

1. **The hazardous set is derived from the pinned header**, not from a maintained list: every
   callback typedef taking a by-value `WGPUStringView` needs a trampoline slot or an exemption.
2. **Exactly one module in `src/` may construct a `JSCallback`** — the one that knows which seam
   path is bound. Everything else registers a plain handler with no FFI types in it.
3. **Every argument shape is a named constant.** An inline argument list at a construction site is
   exactly what both defects looked like; naming it forces the author to say which side of the ABI
   question it falls on.

None of the three has been mutation-tested — they are asserted, not proven able to fail
([EVIDENCE.md](./EVIDENCE.md), "Argued, not executed").
