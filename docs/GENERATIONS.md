# More than one wgpu-native generation

`wgpu-bun@29.x` **ships** wgpu-native v29 and **accepts** v27. The platform npm package carries one
library — one tarball cannot hold two — but what the binding will *load* is a set: point it at a v27
library and it runs, because the whole suite has been executed against that library on every
supported platform.

- [Why](#why)
- [What was measured](#what-was-measured)
- [Using a non-default generation](#using-a-non-default-generation)
- [What the refusal is for](#what-the-refusal-is-for)
- [Adding a generation](#adding-a-generation)

## Why

A binding is where you choose the implementation your JavaScript is validated against
([ERROR-PATH.md](./ERROR-PATH.md#wgpu-native-rather-than-dawn--a-deliberate-backend-choice)).
Pinning exactly one generation takes half of that back: a project whose Rust half is on wgpu 27
cannot have its JavaScript half validated against wgpu 27. The generation is as much a part of
"which implementation" as Dawn-versus-wgpu is — and upstream's are sparse and slow (v25, v27, v29;
no v26, no v28), so "upgrade to keep up" is a real ask.

## What was measured

On `win32-x64` (NVIDIA discrete, D3D12), running the full suite against each library in turn:

| | v29.0.1.1 | v27.0.4.1 |
|---|---|---|
| Suite result | 331 pass / 5 skip / 0 fail | **322 pass / 5 skip / 0 fail** |
| `webgpu.h` layout tables — everything the binding packs | — | **identical** to v29's |
| `wgpu.h` extension tables | 23 aggregates | **18; 11 names differ**, none of them used |
| `check:layouts` against that generation's own headers | green | **green** |
| Symbols the binding calls | all present | all present |
| ABI shim | binds | **binds, unmodified** |
| Backend override (`WGPU_BUN_BACKEND=vulkan`) | takes effect | **takes effect** |
| Blocklisted abort-on-call symbols exported | 40 | **36** |

The nine-case gap in the totals is not missing coverage: `layout-oracle` emits one test per aggregate
and `abort-symbols` one per blocklisted symbol, so both shrink with what the loaded generation has —
5 fewer `wgpu.h` aggregates, 4 fewer symbols.

The layout row is the load-bearing one. **`webgpu.h` — the 92 aggregates the binding packs — is
identical across the two generations**: regenerating the tables from v27's headers reproduces the
committed `webgpu.structs.ts` byte for byte. What moves is `wgpu.h`, wgpu-native's own extension
header — display handles, border-colour sampling and `WGPUImageSubresourceRange` appear in v29, push
constants and `WGPUPipelineLayoutExtras` appear in v27, and `WGPUInstanceExtras` / `WGPUNativeLimits`
exist in both with different members. (The 115 figure elsewhere is both headers together: 92 + 23.)

None of those eleven is packed or read by this binding. `GENERATION_VARIANT_AGGREGATES` in
`wgpu-native.manifest.ts` declares them by name; `check:layouts` permits exactly those to differ on a
non-default generation and nothing else, and `test/generations.test.ts` asserts that no hand-written
line under `src/` mentions one (the generated tables are excluded — they are the inventory of the
headers, not use of them). Tolerance and justification are checked by the same suite.

Backend selection looks like it should have broken, and did not: it goes through
`WGPURequestAdapterOptions.backendType`, a **core** `webgpu.h` field, not the `WGPUInstanceExtras`
chain that differs.

The four missing symbols are `wgpuExternalTexture{AddRef,Release,SetLabel}` and
`wgpuTextureGetTextureBindingViewDimension`, all added to `webgpu.h` after v27. `FIRST_GENERATION`
(`src/ffi/unimplemented.ts`) records them and `test/abort-symbols.test.ts` asserts the whole
partition — an undeclared absence fails, and so does a declared absence that turns out to be present.

### An earlier version of this table said "byte-identical", and it was wrong

The claim was measured on a developer machine and confirmed by a green `check:layouts` — but that
machine had all four platforms cross-fetched into `vendor/` and the generator picked the
**alphabetically first** RID with headers, reading `darwin-arm64`'s v29 headers while `win32-x64`
held v27. Only a runner with exactly one vendored RID could see it, and all four v27 CI legs went red
at once. The generator now prefers the host's own RID and warns on a mixed tree. The comparison
itself was also vacuous: its reader parsed **zero** aggregates out of every table, so "no differences
found" was the answer for any input. An empty parse is now a hard error.

### The thing that did move, and did not bite

⚠ **`wgpu.h`'s extension enums renumbered.** `WGPUSType_ShaderSourceGLSL` is `0x00030004` in v27 and
`0x00030003` in v29. The binding touches none of them, and should keep not touching them: a chained
extension struct sent with the wrong `sType` is not rejected, it is **ignored** or read as a
different struct entirely. A backend override that silently stops taking effect looks exactly like
one that worked, which is why that row is checked by execution.

## Using a non-default generation

```sh
bun run fetch --generation 27    # into vendor/<rid>/, for a source checkout
WGPU_NATIVE_LIB=/path/to/libwgpu_native.so bun test    # or point at one you already have
```

Fetching does **not** disturb the ABI shim beside it in `vendor/<rid>/lib/`. The binding reports what
it actually loaded at first use — the generation comes from `wgpuGetVersion()`, never from a filename
or a directory name:

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

This used to be a `console.warn`. Between generations the observable differences are validation
strictness, WGSL acceptance and extension-struct numbering — none of which raise anything. They
produce plausible wrong answers, and warnings scroll past inside a test runner.
`WGPU_BUN_ALLOW_UNTESTED_GENERATION=1` exists because "unsupported" means *untested*, not *known
broken*; it is a knob someone has to type.

## Adding a generation

The entry criterion is execution, not inspection. `ci.yml` runs every platform × every supported
generation — eight legs today — so adding a generation means four more legs of real evidence, or
none.

1. Add the tag and the four platform archives to `GENERATIONS` in `wgpu-native.manifest.ts`, with
   **measured** hashes: `bun run fetch --generation <n> --update-hashes`, then paste. An empty hash
   means unpinned and the fetcher refuses it.
2. `bun run fetch --generation <n>` and `bun run check:layouts`. Extension aggregates that differ go
   into `GENERATION_VARIANT_AGGREGATES` **only after** confirming the binding does not name them —
   `test/generations.test.ts` enforces that half. If a `webgpu.h` aggregate differs, or one the
   binding uses, stop: the answer is per-generation tables, not a longer allow-list.
3. `bun test`. Record what the suite says in the table above, including anything that had to change.
4. Add the number to the `generation:` axis in `.github/workflows/ci.yml`.
5. If the generation adds or removes abort-on-call symbols, update `UNIMPLEMENTED` and
   `FIRST_GENERATION` in `src/ffi/unimplemented.ts`. `bun run derive:aborts:source --check`
   re-derives the list from upstream's Rust source at the pinned tag.

Removing one is the same work in reverse, and is the right answer when a generation costs more than
it earns — this list is what has been tested, not a compatibility promise.
