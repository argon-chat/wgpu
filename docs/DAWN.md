# Dawn

The default implementation is wgpu-native. Dawn — Chromium's WebGPU — is selectable at runtime from
the same package:

```sh
WGPU_BUN_IMPL=dawn bun run your-thing.ts
```

Both implement the same `webgpu.h`. That is not a hope: the 92 aggregates each header declares were
compared field by field and differ in nothing, which is why `src/layouts`, `src/desc` and `src/api`
are implementation-agnostic and only the loading layer knows there is a choice. The whole suite runs
against either — **369 pass / 0 fail on both**, same tests, same machine, same GPU.

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

**Windows needs DXC.** Dawn's D3D12 backend compiles WGSL to DXIL through the DirectX shader
compiler, loaded dynamically, so `dxcompiler.dll` and `dxil.dll` must sit beside the library:

```
requestDevice failed (status 3) DynamicLib.Open: dxil.dll Windows Error: 87
    at EnsureDXCLibraries (dawn/native/d3d12/PlatformFunctionsD3D12.cpp:212)
```

Both ship in the Windows SDK (`Windows Kits/10/bin/<version>/x64`) and in Microsoft's
DirectXShaderCompiler releases. Neither is in Google's archive — which also means the earlier guess
recorded in this repository, `d3dcompiler_47.dll`, was never checked by anything. It is now what Dawn
itself reported.

⚠ Unresolved for distribution: a published `@wgpu-bun/win32-x64-dawn` has to carry these files or say
where to get them, and that is a licensing question rather than a technical one.

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
