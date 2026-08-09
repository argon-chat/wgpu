# More than one wgpu-native generation

`wgpu-bun@29.x` **ships** wgpu-native v29 and **accepts** v27.

That is two different statements and the difference matters. The platform npm package carries one
library — one tarball cannot hold two and pretend the choice is free. What the binding will *load*
is a set: point it at a v27 library and it runs, because the whole suite has been executed against
that library on every supported platform.

- [Why](#why)
- [What was measured](#what-was-measured)
- [Using a non-default generation](#using-a-non-default-generation)
- [What the refusal is for](#what-the-refusal-is-for)
- [Adding a generation](#adding-a-generation)

## Why

The reason this package exists is that a binding is where you choose the implementation your
JavaScript is validated against ([ERROR-PATH.md](./ERROR-PATH.md#wgpu-native-rather-than-dawn--a-deliberate-backend-choice)).
Pinning exactly one generation takes half of that back: a project whose Rust half is on wgpu 27
cannot have its JavaScript half validated against wgpu 27, which is precisely the mismatch the
choice-of-backend argument is about. The generation is as much a part of "which implementation" as
Dawn-versus-wgpu is.

Upstream's generations are also sparse and slow: v25, then v27, then v29 — no v26, no v28. "Upgrade
to keep up" is a bigger ask when each step is a real behaviour change.

## What was measured

On `win32-x64` (NVIDIA discrete, D3D12), running the full suite against each library in turn:

| | v29.0.1.1 | v27.0.4.1 |
|---|---|---|
| Suite result | 326 pass / 0 fail | **326 pass / 0 fail** |
| Generated struct layout tables | — | **byte-identical** to v29's |
| `check:layouts` against that generation's own headers | green | **green** |
| Symbols the binding calls | all present | all present |
| ABI shim | binds | **binds, unmodified** |
| Backend override (`WGPU_BUN_BACKEND=vulkan`) | takes effect | **takes effect** |
| Blocklisted abort-on-call symbols exported | 40 | **36** |

The layout result is the load-bearing one, and it is not a coincidence to be relied on: the
generated tables carry member *names and type tags only*, no offsets and no sizes, and the core
`webgpu.h` aggregates did not change between these two generations. The v27→v29 header diff is
additive — one WGSL language-feature enumerator and three `SetImmediates` entry points.

The four missing symbols are `wgpuExternalTexture{AddRef,Release,SetLabel}` and
`wgpuTextureGetTextureBindingViewDimension`, all added to `webgpu.h` after v27. They are recorded in
`FIRST_GENERATION` (`src/ffi/unimplemented.ts`) and `test/abort-symbols.test.ts` asserts the whole
partition — an undeclared absence fails, and so does a declared absence that turns out to be
present.

### The thing that did move, and did not bite

⚠ **`wgpu.h`'s extension enums renumbered.** `WGPUSType_ShaderSourceGLSL` is `0x00030004` in v27 and
`0x00030003` in v29; `PipelineLayoutExtras` exists in v27 and is gone in v29. The binding survives
the move because it touches none of them.

That is a property to keep deliberately, not a fact to note once. A chained extension struct sent
with the wrong `sType` is not rejected — it is **ignored**, or read as a different struct entirely.
A backend override that silently stops taking effect looks exactly like a backend override that
worked, which is why the table above bothers to check that one by execution.

## Using a non-default generation

```sh
bun run fetch --generation 27    # into vendor/<rid>/, for a source checkout
WGPU_NATIVE_LIB=/path/to/libwgpu_native.so bun test    # or point at one you already have
```

Fetching does **not** disturb the ABI shim that lives beside it in `vendor/<rid>/lib/`, so switching
generations does not mean rebuilding it.

The binding reports what it actually loaded at first use — the generation comes from
`wgpuGetVersion()`, never from a filename or a directory name:

```ts
import { nativeVersion, SUPPORTED_GENERATIONS } from 'wgpu-bun';
console.log(nativeVersion().text, SUPPORTED_GENERATIONS);
```

## What the refusal is for

A library from an **unsupported** generation is refused at load, not warned about:

```
wgpu-bun: wgpu-native 25.0.2.2 is generation 25, which this package has never been tested against.
  Supported: 29, 27 (this build ships v29.0.1.1).
  …
  Set WGPU_BUN_ALLOW_UNTESTED_GENERATION=1 to proceed anyway, deliberately.
```

This used to be a `console.warn`. A warning is the wrong instrument here for the same reason the
rest of this package refuses rather than stubs: between generations the observable differences are
validation strictness, WGSL acceptance and extension-struct numbering — none of which raise
anything. They produce plausible wrong answers. A suite that runs green against a library its
binding was never tested with has proven nothing, and nothing about it looks wrong. Warnings scroll
past inside a test runner; a throw does not.

`WGPU_BUN_ALLOW_UNTESTED_GENERATION=1` exists because "unsupported" means *untested*, not *known
broken*. It is a knob someone has to type, which makes running an untested combination possible and
doing it by accident impossible.

## Adding a generation

The entry criterion is execution, not inspection. `ci.yml` runs the whole matrix — every platform ×
every supported generation — so adding one means eight more legs of real evidence, or none.

1. Add the tag and the four platform archives to `GENERATIONS` in `wgpu-native.manifest.ts`, with
   **measured** hashes: `bun run fetch --generation <n> --update-hashes`, then paste. Never invent a
   hash; an empty one means unpinned and the fetcher refuses it.
2. `bun run fetch --generation <n>` and `bun run check:layouts`. If it fails, the generated tables
   are no longer generation-agnostic and the answer is **per-generation tables**, not a looser
   check. That is a bigger change than adding an entry, and the check going red is how you find out
   before shipping rather than after.
3. `bun test`. Record what the suite says in the table above, including anything that had to change.
4. Add the number to the `generation:` axis in `.github/workflows/ci.yml`.
5. If the new generation adds or removes abort-on-call symbols, update `UNIMPLEMENTED` and
   `FIRST_GENERATION` in `src/ffi/unimplemented.ts`. `bun run derive:aborts:source -- --check`
   re-derives the list from upstream's Rust source at the pinned tag.

Removing one is the same work in reverse, and is the right answer when a generation starts costing
more than it earns — this list is what has been tested, not a compatibility promise.
