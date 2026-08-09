# Dawn

The default implementation is wgpu-native. Dawn — Chromium's WebGPU — is selectable at runtime from
the same package:

```sh
WGPU_BUN_IMPL=dawn bun run your-thing.ts
```

Both implement the same `webgpu.h`. That is not a hope: the 92 aggregates each header declares were
compared field by field and differ in nothing, which is why `src/layouts`, `src/desc` and `src/api`
are implementation-agnostic and only the loading layer knows there is a choice.

**The whole suite runs against either — 371 pass / 0 fail — on all three platforms, in public CI, on
three different graphics APIs.** Not a smoke test: the same corpus wgpu-native runs, in the same job
that links the library, and a leg that cannot run it does not upload anything.

| platform | adapter | API |
|---|---|---|
| linux-x64 | llvmpipe, Mesa 25.2.8 (LLVM 20.1.2) | Vulkan |
| win32-x64 | Microsoft Basic Render Driver (WARP) | D3D12, with DXC from the Windows SDK |
| darwin-arm64 | Apple Paravirtual device | Metal |

Every leg reached a real device; none skipped. Locally the same suite passes against Dawn on an
NVIDIA RTX 5070 through D3D12, which is where the differences below were found in the first place.

`impl` rather than `backend` throughout, because WebGPU already uses "backend" for Vulkan / D3D12 /
Metal, and both projects use that word that way in their own logs.

## Where the library comes from

Google publishes Dawn as **static archives only** — every release asset is `libwebgpu_dawn.a` or
`webgpu_dawn.lib`, and there is nothing to `dlopen`. So this repository links its own, in public CI
([dawn-build](../.github/workflows/dawn-build.yml)), from two verifiable pins: a git tag and a
sha256, both in [`dawn.manifest.ts`](../dawn.manifest.ts).

The **ABI shim is fused into the same library**. `bun:ffi` cannot express a by-value C aggregate and
the WebGPU C API passes them in both directions, so a Dawn build carrying only the API would still
need a second file to be usable. One `cargo build` produces the objects the standalone shim ships,
and the linker puts them in: a Dawn install is one binary carrying both surfaces.

| platform | exports | library |
|---|---|---|
| linux-x64 | 277 Dawn + 15 shim | `libwebgpu_dawn.so`, 21.1 MiB |
| darwin-arm64 | 277 + 15 | `libwebgpu_dawn.dylib`, 9.9 MiB |
| win32-x64 | 277 + 15 | `webgpu_dawn.dll`, 10.3 MiB |

Three platforms, three different export mechanisms — an ELF version script, a Mach-O
`-exported_symbols_list`, a generated `.def` — and the same 277 + 15 out of each.

`linux-arm64` is absent because Google publishes no arm64 Linux desktop build; that platform needs a
source build, which is a different job.

## What differs from wgpu-native

**Three entry points do not exist in Dawn.** Measured against Dawn's own header, exactly these:

| symbol | what happens under Dawn |
|---|---|
| `wgpuGetVersion` | no runtime version accessor exists; the version comes from the pinned tag |
| `wgpuSetLogLevel` | wgpu-native's global logger; Dawn's logging is not in its C API |
| `wgpuDevicePoll` | `wgpuInstanceProcessEvents` does the work, and is already called at every site |

They are bound only when wgpu-native is loaded. This matters more than it reads: `dlopen` binds a
symbol table **atomically**, so one absent name rejects the whole table. Listing them
unconditionally is what produced the first thing that ever happened when this binding was pointed at
Dawn — `TypeError: Symbol "wgpuGetVersion" not found in webgpu_dawn.dll`, before a single call.

**An adapter is consumed by `requestDevice()`.** This is what WebGPU specifies; Dawn enforces it and
wgpu-native does not. Code that asks one adapter for a second device works on wgpu-native and fails
on Dawn with

```
adapter is "consumed": it has already been used to create a device
    at CreateDeviceInternal (dawn/native/Adapter.cpp:319)
```

This package's own test helper did exactly that, and had done since before there was a second
implementation to notice. It was never a Dawn quirk to work around — it was a spec rule the lenient
implementation allowed us to lean past.

**Dawn has a logging callback that takes a by-value `WGPUStringView`.** `WGPULoggingCallback` is
installed only through `wgpuDeviceSetLoggingCallback`, which this package does not bind. It is listed
as exempt in `test/callback-abi.test.ts` with that reason. Binding that entry point later means
giving it a trampoline slot **first**: on three of the four platforms a naive installation reads the
message out of the wrong registers, and the symptom is garbled log text rather than an error.

That finding is also the argument for resolving the header per implementation. The by-value callback
population is derived from the `webgpu.h` sitting beside the *loaded* library — `include/` for
wgpu-native, `include-dawn/` for Dawn. A single shared header directory would have checked Dawn
against wgpu-native's declarations, which is a check that cannot fail for the wrong reason.

## Windows: Dawn's dynamically-loaded dependencies

Dawn loads two things at first use rather than at library load, and Google's archive contains no DLLs
at all, so neither travels with it:

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
too — a DLL that is in `System32` on every machine with a driver, that this very process can `dlopen`
by name, and that wgpu-native's Vulkan backend uses successfully in the same process moments earlier.
Dawn resolves these through a search that does not include the standard directories.

**This package ships neither file, and copies neither.** `dxil.dll` is closed-source Microsoft code —
the shader-signing library only Microsoft can produce — and putting it in an npm package would mean
adopting someone else's redistribution terms and adding an unverifiable binary to a supply chain
whose entire pitch is that every binary traces to a pin. `vulkan-1.dll` belongs to the user's driver
install. Copying either into `node_modules` at install time was the other candidate and is worse:
there is no postinstall hook here on purpose.

Instead, [`src/dawnRuntime.ts`](../src/dawnRuntime.ts) **preloads whatever the machine already has,
by absolute path, before the instance is created** — beside the library first, then `System32` for
the loader and the Windows SDK for DXC. Once a module is resident, Dawn's own search finds it. Both
paths measured on a real device: preload the system Vulkan loader → Dawn reports an NVIDIA RTX 5070
over Vulkan; preload the SDK's DXC → the same device over D3D12. Nothing installed, nothing copied.

The default backend follows from that: **D3D12 when DXC is available, Vulkan otherwise**, with one
line saying which and why. An explicit `backend=d3d12` is still honoured and still fails without DXC —
an override that silently selects something else is worse than an error, because on this
implementation the backend changes the feature set. A machine with neither gets a message naming both
options rather than a Win32 number.

The earlier guess recorded in this repository, `d3dcompiler_47.dll`, was never checked by anything —
the archive has no DLLs, so there was nothing to notice it against.

## Choosing the graphics backend

Independent of the implementation, and the same knob on both:

```sh
WGPU_BUN_BACKEND=vulkan  WGPU_BUN_IMPL=dawn  bun test
create(["backend=d3d12"])            # per instance
requestAdapter({ backendType: … })   # per request
```

This matters more here than it would elsewhere: **the same GPU exposes different features through
different APIs** — `shader-f16` is present on Vulkan and absent on D3D12 for the reference adapter —
so a backend is a correctness knob, not a preference. Under Dawn on Windows it is also the axis the
runtime dependencies sit on, which is why an override is *refused* rather than redirected when its
dependency is missing.

`bun run test:matrix` runs the whole suite across every implementation × backend the host can reach
and prints one table. On a Windows machine with a real GPU that is four cells:

```
  win32-x64

  pass  wgpu-native / d3d12      376 pass, 0 fail
  pass  wgpu-native / vulkan     376 pass, 0 fail
  pass  dawn / d3d12             376 pass, 0 fail
  pass  dawn / vulkan            376 pass, 0 fail
```

CI cannot produce that table: every runner has exactly one usable backend — WARP is D3D12-only,
lavapipe is Vulkan-only, macOS is Metal. Which is precisely why the sweep is worth running by hand.
Its first run found a defect both default paths were hiding: an explicit `WGPU_BUN_BACKEND` under
Dawn never preloaded Dawn's dependency, because the preload had been wired into the default-backend
branch only, and the symptom was `requestAdapter() resolved to null — no GPU on this host` on a
machine with a GPU.

## The generation check does not apply

The shim reports the wgpu-native generation its `#[repr(C)]` structs were transcribed from. Under
Dawn that number says which *header shape* the layouts match, not which library is being talked to,
so it is not compared against the pinned generation. What still holds under both, and is still
checked at load, is the `sizeof` agreement: the shim's layouts, as a Rust compiler laid them out,
against this package's independently derived ones, on the real target.

## Installing

Dawn is opt-in. `@wgpu-bun/<platform>-dawn` is not an `optionalDependency` of the main package, so a
default install pulls nothing extra. From a source checkout:

```sh
bun run dawn:fetch     # download + verify the pinned release
bun run dawn:link      # link the shared library, with the shim fused in
WGPU_BUN_IMPL=dawn bun test
```

`WGPU_DAWN_LIB` points at an explicit library and beats every other tier, the same escape hatch
`WGPU_NATIVE_LIB` is for wgpu-native.
