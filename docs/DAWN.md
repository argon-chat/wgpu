# Dawn

The default implementation is wgpu-native. Dawn — Chromium's WebGPU — is selectable at runtime from
the same package:

```sh
WGPU_BUN_IMPL=dawn bun run your-thing.ts
```

Both implement the same `webgpu.h`, measured: all 92 aggregates wgpu-native's header declares are
present in Dawn's, member for member, no differences; Dawn declares 100 more of its own. So
`src/layouts`, `src/desc` and `src/api` are implementation-agnostic — only the loading layer knows
there is a choice. ⚠ That was measured once, by hand, and is **not gated by anything**:
`check:layouts` reads wgpu-native's headers only, and nothing re-runs the comparison against Dawn's.

**The whole suite runs against either, 0 fail, on all three platforms, in public CI, over three
graphics APIs** — the same corpus, in the same job that links the library.

| platform | adapter | API |
|---|---|---|
| linux-x64 | llvmpipe (Mesa lavapipe, LLVM 20.1.2) | Vulkan |
| win32-x64 | Microsoft Basic Render Driver (WARP) | D3D12, with DXC from the Windows SDK |
| darwin-arm64 | Apple Paravirtual device | Metal |

Every leg reached a real device; none skipped, and a leg that cannot run the suite uploads nothing.
Locally it also passes on an NVIDIA RTX 5070 over D3D12, where the differences below were found.
This document says `impl` rather than `backend`, because WebGPU already uses "backend" for Vulkan /
D3D12 / Metal and both projects use the word that way in their own logs.

## Where the library comes from

Google publishes Dawn as **static archives only** (`libwebgpu_dawn.a`, `webgpu_dawn.lib`) — nothing
to `dlopen`. So this repository links its own, in public CI
([dawn-build](../.github/workflows/dawn-build.yml)), from two verifiable pins: a git tag and a
sha256, both in [`dawn.manifest.ts`](../dawn.manifest.ts). The **ABI shim is fused into the same
library**: `bun:ffi` cannot express a by-value C aggregate and the WebGPU C API passes them in both
directions, so an API-only Dawn build would still need a second file to be usable. One `cargo build`,
one binary carrying both surfaces.

Three platforms, three export mechanisms — an ELF version script, a Mach-O `-exported_symbols_list`,
a generated `.def` — and the same 277 API entry points plus 15 trampolines out of each. The link
fails if any is missing. `linux-arm64` is absent because Google publishes no arm64 Linux desktop
build; that needs a source build, a different job.

## What differs from wgpu-native

**Three entry points do not exist in Dawn.** Measured against Dawn's own header, exactly these:

| symbol | what happens under Dawn |
|---|---|
| `wgpuGetVersion` | no runtime version accessor exists; the version comes from the pinned tag |
| `wgpuSetLogLevel` | wgpu-native's global logger; Dawn's logging is not in its C API |
| `wgpuDevicePoll` | `wgpuInstanceProcessEvents` does the work, and is already called at every site |

They are bound only when wgpu-native is loaded. `dlopen` binds a symbol table **atomically**, so one
absent name rejects the whole table: listing them unconditionally produced `TypeError: Symbol
"wgpuGetVersion" not found in webgpu_dawn.dll` before a single call.

**An adapter is consumed by `requestDevice()`.** This is what WebGPU specifies; Dawn enforces it and
wgpu-native does not, so code that asks one adapter for a second device — as this package's own test
helper did — passes on wgpu-native and fails on Dawn with

```
adapter is "consumed": it has already been used to create a device
    at CreateDeviceInternal (dawn/native/Adapter.cpp:319)
```

**Dawn has a logging callback that takes a by-value `WGPUStringView`.** `WGPULoggingCallback` is
installed only through `wgpuDeviceSetLoggingCallback`, which this package does not bind; it is exempt
in `test/callback-abi.test.ts` with that reason. Binding it later means giving it a trampoline slot
**first** — on three of the four platforms a naive installation reads the message out of the wrong
registers, and the symptom is garbled log text rather than an error.

That is also why the header is resolved per implementation: the by-value callback population comes
from the `webgpu.h` beside the *loaded* library (`include/` for wgpu-native, `include-dawn/` for
Dawn). One shared directory would check Dawn against wgpu-native's declarations — a check that can
only ever pass.

## Windows: Dawn's dynamically-loaded dependencies

Dawn loads two things at first use, not at library load, and Google's archive contains no DLLs, so
neither travels with it:

| backend | needs | where it comes from |
|---|---|---|
| D3D12 | `dxcompiler.dll` + `dxil.dll` (DXC) | the Windows SDK, or Microsoft's DirectXShaderCompiler releases |
| Vulkan | `vulkan-1.dll` | every GPU driver installation |

Both failures land at `requestAdapter()`/`requestDevice()` as a Win32 number:

```
requestDevice failed (status 3) DynamicLib.Open: dxil.dll Windows Error: 87
    at EnsureDXCLibraries (dawn/native/d3d12/PlatformFunctionsD3D12.cpp:212)
Warning: Couldn't load Vulkan: DynamicLib.Open: vulkan-1.dll Windows Error: 87
```

⚠ That **87 is `ERROR_INVALID_PARAMETER`, not "file not found"**, and it appears for `vulkan-1.dll`
too — a DLL in `System32` on every machine with a driver, that this process can `dlopen` by name,
and that wgpu-native used successfully moments earlier. Dawn resolves these through a search that
does not include the standard directories.

**This package ships neither file, and copies neither.** `dxil.dll` is closed-source Microsoft code,
the shader-signing library only Microsoft can produce: shipping it means adopting someone else's
redistribution terms and adding an unverifiable binary to a supply chain whose pitch is that every
binary traces to a pin. `vulkan-1.dll` belongs to the driver install. Copying either into
`node_modules` would need a postinstall hook, which this package deliberately has not got.

Instead, [`src/dawnRuntime.ts`](../src/dawnRuntime.ts) **preloads whatever the machine already has,
by absolute path, before the instance is created** — beside the library first, then `System32` for
the loader and the Windows SDK for DXC. Once a module is resident, Dawn's own search finds it. Both
paths measured on a real device: preload the system Vulkan loader → Dawn reports an NVIDIA RTX 5070
over Vulkan; preload the SDK's DXC → the same device over D3D12. Nothing installed, nothing copied.

The default backend follows: **D3D12 when DXC is available, Vulkan otherwise**, with one line saying
which and why. An explicit `backend=d3d12` is honoured and still fails without DXC — the backend
changes the feature set here, so silently selecting something else is worse than an error. A machine
with neither gets a message naming both options rather than a Win32 number. (An earlier guess in
this repository, `d3dcompiler_47.dll`, was wrong and unchecked: the archive has no DLLs to notice it
against.)

## Choosing the graphics backend

Independent of the implementation, and the same knob on both:

```sh
WGPU_BUN_BACKEND=vulkan  WGPU_BUN_IMPL=dawn  bun test
create(["backend=d3d12"])            # per instance
requestAdapter({ backendType: … })   # per request
```

**The same GPU exposes different features through different APIs** — `shader-f16` is present on
Vulkan and absent on D3D12 for the reference adapter — so a backend is a correctness knob, not a
preference. Under Dawn on Windows it is also the axis the runtime dependencies sit on, which is why
an override is *refused* rather than redirected when its dependency is missing.

`bun run test:matrix` runs the whole suite across every implementation × backend the host can reach,
one row per cell — on a Windows machine with a real GPU, four of them, all green. CI cannot: every
runner has exactly one usable backend (WARP is D3D12-only, lavapipe Vulkan-only, macOS Metal), which
is why the sweep is worth running by hand. Its first run found a defect both default paths hid — an
explicit `WGPU_BUN_BACKEND` under Dawn never preloaded Dawn's dependency, and reported
`requestAdapter() resolved to null — no GPU on this host` on a machine with a GPU.

## The generation check does not apply

The shim reports the wgpu-native generation its `#[repr(C)]` structs were transcribed from. Under
Dawn that names a *header shape*, not the library being talked to, so it is not compared against the
pinned generation. The `sizeof` agreement still is, at load: the shim's layouts, as a Rust compiler
laid them out, against this package's independently derived ones, on the real target.

## Installing

Dawn is opt-in: `@wgpu-bun/<platform>-dawn` is not an `optionalDependency`, so a default install
pulls nothing extra. ⚠ **Those names are reserved placeholders today** — version `0.0.0`, no library
— registered so npm trusted publishing could be configured before the first Dawn release. Until
then, Dawn comes from a source checkout:

```sh
bun run dawn:fetch     # download + verify the pinned release
bun run dawn:link      # link the shared library, with the shim fused in
WGPU_BUN_IMPL=dawn bun test
```

`WGPU_DAWN_LIB` points at an explicit library and beats every other tier, the same escape hatch
`WGPU_NATIVE_LIB` is for wgpu-native.
