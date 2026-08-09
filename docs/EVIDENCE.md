# What is proven, what is argued, and how the tests refuse to lie

The distinction this file exists for: **executed** means a machine ran it and the result was
observed. **Argued** means it follows from a document — an ABI specification, a header — and nothing
has run. Both can be true; only one is evidence. Everything below is one or the other, explicitly.

It is worth keeping now that the matrix is green: the separation is what caught a real defect on
three platforms at once (see [ABI.md](./ABI.md#not-being-wrong-a-third-time)).

## Executed

| | |
|---|---|
| The whole suite on `win32-x64` — discrete NVIDIA/D3D12 locally, WARP in CI | adapter → device → compute dispatch → render to texture → readback → error scopes |
| Both seam paths on `win32-x64` | `WGPU_BUN_SEAM=shim` and `=direct` each run the full suite green |
| The shim's trampolines on `win32-x64` | all five installed and firing; a 246-character validation message decoded through the flat `(data, length)` path |
| The shim's `sizeof` against the derived layouts | at runtime, on the real target, for all five aggregates it declares |
| The version-skew guard | a shim reporting the wrong flat-ABI version is refused at load, as `AbiUnsupportedError` |
| The struct-layout oracle on `win32-x64` | all 115 aggregates, `sizeof`/`offsetof` from a real C compiler on the pinned headers |
| **The shim compiles on all four platforms** | CI built and uploaded it on `win32-x64`, `linux-x64`, `linux-arm64` and `darwin-arm64` |
| **The whole suite on every supported platform** | each leg reached a real device and ran: WARP/D3D12, llvmpipe/Vulkan on both architectures, Apple Paravirtual/Metal. All four bound the shim |
| **Both by-value ABI holes, on the platforms each one afflicts** | the 40-byte argument hole on `linux-x64` (SysV), the 16-byte `WGPUStringView` callback hole on all three non-Windows platforms. Each was found by a red CI leg and closed by a green one |
| **AArch64 register assignment for both aggregate sizes** | `linux-arm64` and `darwin-arm64` both green through the shim — the AAPCS rules are now observed behaviour, not a reading of the specification |
| **The layout oracle outside Windows** | it compiles the pinned headers with a real C compiler on every leg; the header-shadowing shim is Windows-only precisely because the other platforms have real system headers |
| **Struct layouts identical across all four platforms** | `check:layouts` green on every leg against that leg's own fetched headers |
| The structural guard against a third site | mutation-tested: a stray `JSCallback`, an inline arg list, and an unbound header callback each make it fail |
| Two of the forty abort-on-call symbols, by hand | `wgpuBufferWriteMappedRange` aborts; `wgpuBufferGetMappedRange` works |

## Argued, not executed

Short, and deliberately kept rather than deleted — a section that empties itself is a section nobody
will repopulate when the next claim outruns its evidence.

| | Basis | What would settle it |
|---|---|---|
| Behaviour on a **discrete** GPU on anything but Windows | every non-Windows leg ran on a software or paravirtualised adapter. Nothing here is adapter-specific, but "nothing here is" is an argument, not a measurement | a run on real hardware, which hosted runners do not offer |
| `win32-arm64` | the AAPCS rules it would follow are now executed on two other AArch64 platforms, but Windows-on-ARM combines them with the Win64 aggregate rule, and that pairing has never run | adding the RID and a runner |
| Thirty-eight of the forty abort-on-call symbols | upstream's Rust source at the pinned tag | the subprocess-per-symbol sweep (`bun run derive:aborts:probe`) |
| That the [three-line upstream change](./ABI.md#why-it-aborts-at-all-and-what-it-would-take-upstream) makes `wgpuQueueSubmit` report instead of abort | the sink is already on `WGPUQueueImpl` and the sibling function already uses it | building a patched wgpu-native and running the negative test that currently kills the process |

## Remaining gaps

Things a reader should know are not done. None of them blocks installing or using the package.

1. **The prebuilt shim artefacts are not released as loose downloads yet**, so every `sha256` in
   `shim.manifest.ts` is empty and `bun run shim:fetch` refuses to install — an empty hash is treated
   as *unpinned*, not as *unchecked*. This is a maintainer convenience path only: the shim reaches
   consumers inside the platform npm package, which is integrity-checked by the registry. From a
   source checkout the acquisition paths are that package, or `bun run shim:build`, which needs cargo.
2. **The behaviour-derived blocklist sweep has not been run** against the shipped binary. The list of
   40 abort-on-call symbols is source-accurate at the pinned tag, and the tag and the shipped build
   can differ by a commit — which is precisely why a second, execution-based derivation exists
   (`bun run derive:aborts:probe`). Two of the forty have been confirmed by hand.
3. **No WebGPU CTS run.** A worthy goal. It will not be claimed before it is measured.
4. **No discrete GPU outside Windows.** Every non-Windows platform was proven on a software or
   paravirtualised adapter, because that is what hosted runners offer. Nothing in the binding is
   adapter-specific — but "nothing is" is an argument, and this file keeps arguments and measurements
   apart.
5. **`win32-arm64` is not a target.** It would pair the Win64 aggregate rule with AAPCS register
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
| The binding is unimplemented | skips | none; see below |

The escapes are environment variables rather than auto-detection, so granting one is a visible,
per-job decision a reviewer can see in the workflow file, and a local run never grants itself one.

**`no-callback` is its own reason too, and for the same argument one level along.** A call that is
issued and never completes used to arrive here as `no-adapter` as well. Wrong twice: the runners that
hit it *had* adapters, and `no-adapter` is escapable by an environment variable two matrix legs are
granted — so a genuine completion defect could be skipped past on exactly the legs most likely to
have one. It is never permitted. A device that never answers and a binding that mis-decodes its own
callback arguments produce the identical symptom, so the thrown error prints the seam's requested /
resolved / bound modes and the shim path, rather than telling the reader to go and find them.

**`abi-unsupported` is its own reason, and that matters more than it looks.** The seam's refusal used
to reach the gate as an untyped throw from `requestAdapter()` and get filed under `no-adapter` — a
diagnosis meaning "this host has no GPU". On the `linux-x64` CI runner that was flatly untrue:
`vulkaninfo` reports `llvmpipe (LLVM 20.1.2) / DRIVER_ID_MESA_LLVMPIPE` on the same machine, so the
software adapter was installed and visible the whole time, and the label sent a reader looking for a
driver problem that did not exist. A binding declining an ABI it cannot express and a machine with no
GPU are different facts. There is no environment variable for it, because "run without the artefact
that makes it correct" is not a decision anyone should be able to grant: it is a permitted skip only
while **no shim is installed for the host**, and if one is installed and the seam still refused, that
is a defect and it goes red. The kind stops being reachable the moment the artefact lands —
mechanically, rather than by anyone remembering to delete it.

The unimplemented-skip would be a permanent loophole — never finish it and nothing ever has to run —
except that the same flag is bound to the package's public claims: while it is set, the README must
carry the status banner and the version must stay `0.0.x`. The way out of the skip is not a knob, it
is shipping.

CI runs a four-platform matrix, and **every leg is now required to find an adapter** — the Linux legs
install Mesa's lavapipe, Windows gets WARP and macOS a paravirtualised Metal device, all three
confirmed by execution. They were permitted to skip only while it was unknown whether those adapters
come up on hosted runners; that question is answered, so the permission is gone. A green matrix means
the suite ran everywhere, not that it was excused somewhere. A final job reads one marker per leg and
**fails the run if no leg anywhere reached a device** — four individually-defensible skips must not
add up to a meaningless pass.
