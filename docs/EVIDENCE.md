# What is proven, what is argued, and how the tests refuse to lie

**Executed** means a machine ran it and the result was observed. **Argued** means it follows from a
document — an ABI specification, a header — and nothing has run. Both can be true; only one is
evidence. Everything below is one or the other, explicitly.

The separation is what caught a real defect on three platforms at once (see
[ABI.md](./ABI.md#not-being-wrong-a-third-time)).

## Executed

| | |
|---|---|
| The whole suite on `win32-x64` | discrete NVIDIA/D3D12 locally, WARP (Microsoft Basic Render Driver) in CI: adapter → device → compute dispatch → render to texture → readback → error scopes |
| Both seam paths on `win32-x64` | `WGPU_BUN_SEAM=shim` and `=direct` each run the full suite green |
| The shim's trampolines | all **seven** callback slots — the five callable callback-info entry points plus `uncapturedError` and `deviceLost` — resolve to a distinct trampoline address, and that address, not the `JSCallback`, is what lands in `WGPUCallbackInfo.callback` |
| The shim's `sizeof` against the derived layouts | at runtime, on the real target, for all five aggregates it declares |
| The version-skew guard | a shim reporting the wrong flat-ABI version is refused at load, as `AbiUnsupportedError` |
| The struct-layout oracle | all 115 aggregates (92 from `webgpu.h`, 23 from `wgpu.h`), `sizeof`/`offsetof` from a real C compiler on the pinned headers |
| The shim compiles on all four platforms | CI built and uploaded it on `win32-x64`, `linux-x64`, `linux-arm64` and `darwin-arm64` |
| **The whole suite on every supported platform** | each leg reached a real device and ran: WARP/D3D12, llvmpipe/Vulkan on both architectures, Apple Paravirtual/Metal. All four bound the shim |
| **Both by-value ABI holes, on the platforms each one afflicts** | the 40-byte argument hole on `linux-x64` (SysV), the 16-byte `WGPUStringView` callback hole on all three non-Windows platforms. Each was found by a red CI leg and closed by a green one |
| **AArch64 register assignment for both aggregate sizes** | `linux-arm64` and `darwin-arm64` both green through the shim — the AAPCS rules are now observed behaviour, not a reading of the specification |
| **The layout oracle on every platform** | it compiles the pinned headers with a real C compiler on every leg, so the derived offsets are checked against four separate compilers. The header-shadowing shim is Windows-only, because the other platforms have real system headers |
| **The committed layout tables match every leg's own fetched headers** | `check:layouts` green on all four |
| **All 40 abort-on-call symbols, by execution** | the subprocess-per-symbol sweep (`bun run derive:aborts:probe`) called every exported symbol in the shipped binary and classified by the Rust panic banner. Run against `v29.0.1.1` on `win32-x64`; it agrees with the committed list at exactly 40 |
| The structural guard against a third site | no `JSCallback` is constructed outside the callback module, no argument shape is an inline literal, and every by-value-`StringView` callback in the pinned header is bound or explicitly exempt |
| **Dawn's `webgpu.h` lays out the shared aggregates identically** | both pinned headers compiled separately; `sizeof`/`alignof`/`offsetof` compared over all 92 `webgpu.h` aggregates and their members — 1480 measurements, 0 disagreements. Dawn's header is a superset (192 aggregates); the 23 from `wgpu.h` are wgpu-native-only |

## Argued, not executed

Kept rather than deleted — a section that empties itself is a section nobody will repopulate when
the next claim outruns its evidence.

| | Basis | What would settle it |
|---|---|---|
| Behaviour on a **discrete** GPU on anything but Windows | every non-Windows leg ran on a software or paravirtualised adapter. Nothing here is adapter-specific, but "nothing here is" is an argument, not a measurement | a run on real hardware, which hosted runners do not offer |
| `win32-arm64` | the AAPCS rules it would follow are now executed on two other AArch64 platforms, but Windows-on-ARM combines them with the Win64 aggregate rule, and that pairing has never run | adding the RID and a runner |
| The abort sweep on platforms other than `win32-x64` | the sweep is per-binary and has only been run against the Windows build. The blocklist is the union across generations and is cross-checked against upstream source | running `derive:aborts:probe` on the other three legs |
| That the [three-line upstream change](./ABI.md#why-it-aborts-at-all-and-what-it-would-take-upstream) makes `wgpuQueueSubmit` report instead of abort | confirmed by reading `wgpu-native` at the pinned tag: `error_sink` is a field on `WGPUQueueImpl`, and `wgpuQueueWriteBuffer` destructures it and calls `handle_error` where submit calls `handle_error_fatal` | building a patched wgpu-native and running the negative test that currently kills the process |
| That the guards above fail when violated | they are asserted, not mutation-tested — no deliberately broken variant is checked in | a mutation run committed alongside them |
| The [coverage percentages](./COMPATIBILITY.md#how-much-of-webgpu-actually-has-to-work) — ~54% of the method surface, ~32% of the declared surface | a measurement over ~71 000 lines of application and test code that is **not in this repository**. The denominators it quotes do match `src/enums.ts` exactly | re-running the sweep against a corpus a reader can also check |

## Remaining gaps

Things a reader should know are not done. None of them blocks installing or using the package.

1. **The prebuilt shim artefacts are not released as loose downloads yet**, so every `sha256` in
   `shim.manifest.ts` is empty and `bun run shim:fetch` refuses to install — an empty hash is treated
   as *unpinned*, not as *unchecked*. This is a maintainer convenience path only: the shim reaches
   consumers inside the platform npm package, which is integrity-checked by the registry. From a
   source checkout the acquisition paths are that package, or `bun run shim:build`, which needs cargo.
2. **No WebGPU CTS run.** A worthy goal. It will not be claimed before it is measured.
3. **No discrete GPU outside Windows.** Every non-Windows platform was proven on a software or
   paravirtualised adapter, because that is what hosted runners offer. Nothing in the binding is
   adapter-specific — but "nothing is" is an argument, and this file keeps arguments and measurements
   apart.
4. **`win32-arm64` is not a target.** It would pair the Win64 aggregate rule with AAPCS register
   assignment, and that combination has never run here. Adding it is a runner and an entry in the
   manifest, not new code — but it would be a claim without evidence until it runs.

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
| The binding is unimplemented | skips | none; unreachable now that `IMPLEMENTED` is `true` |

The escapes are environment variables rather than auto-detection, so granting one is a visible,
per-job decision a reviewer can see in the workflow file, and a local run never grants itself one.

Two of those kinds exist because they were once mis-filed as `no-adapter`, which is escapable and
therefore skippable:

- **`no-callback`** — a call issued that never completes. The runners that hit it *had* adapters. A
  device that never answers and a binding that mis-decodes its own callback arguments produce the
  identical symptom, so the thrown error prints the seam's requested / resolved / bound modes and the
  shim path. Never permitted.
- **`abi-unsupported`** — the seam declining an ABI it cannot express, which reached the gate as an
  untyped throw from `requestAdapter()`. On `linux-x64` that read as "this host has no GPU" while
  `vulkaninfo` reported `llvmpipe (LLVM 20.1.2) / DRIVER_ID_MESA_LLVMPIPE` on the same machine.
  Permitted only while **no shim is installed for the host**; if one is installed and the seam still
  refused, that is a defect and it goes red.

The unimplemented-skip would have been a permanent loophole — never finish it and nothing ever has
to run — except that the flag is bound to the package's public claims: while it is set, the README
must carry the status banner and the version must stay `0.0.x`. `IMPLEMENTED` is now `true`, so the
skip is unreachable and the GPU suites are mandatory everywhere.

CI runs a **four-platform × two-generation matrix — eight legs**, and every one is required to find
an adapter: the Linux legs install Mesa's lavapipe, Windows gets WARP and macOS a paravirtualised
Metal device, all three confirmed by execution. A green matrix means the suite ran everywhere, not
that it was excused somewhere. A final job reads one marker per leg and **fails the run if no leg
anywhere reached a device** — individually-defensible skips must not add up to a meaningless pass.
