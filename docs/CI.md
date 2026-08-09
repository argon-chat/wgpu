# Running on GitHub Actions

Hosted runners have no GPU. Two of the three platforms ship a software adapter anyway; Linux does
not, and that is where `requestAdapter()` returns `null`.

| runner | adapter | what to install |
|---|---|---|
| `ubuntu-latest`, `ubuntu-24.04-arm` | llvmpipe (Mesa lavapipe), Vulkan | `mesa-vulkan-drivers libvulkan1` |
| `windows-latest` | WARP (Microsoft Basic Render Driver), D3D12 | nothing |
| `macos-15` | Apple Paravirtual device, Metal | nothing |

```yaml
      - name: Install a Vulkan driver
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends mesa-vulkan-drivers libvulkan1
```

Add `vulkan-tools` if you want `vulkaninfo --summary` in the log — worth it the first time, noise
after that.

`ubuntu-24.04-arm` is free for public repositories only.

## Make a missing adapter fail

The failure mode to design against is not a red run, it is a green one. A suite that skips its GPU
tests when `requestAdapter()` returns `null` reports success on a runner where nothing ran, and the
skip is one line in a log nobody reads.

```ts
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter — the runner is missing a driver, not the test");
```

If you deliberately allow a skip, make it loud and per-job: an environment variable someone had to
type, printed in the summary, never a default.

## Dawn on Windows needs one more file

Dawn loads its backend's support library at first use: DXC (`dxcompiler.dll` + `dxil.dll`) for D3D12,
or `vulkan-1.dll` for Vulkan. `windows-latest` has DXC in the Windows SDK and this package preloads
it, so nothing is needed — but on a stripped image, or a self-hosted runner without the SDK, install
one or the other. See [DAWN.md](./DAWN.md).

wgpu-native needs neither.

## Pick the backend explicitly

Each runner has exactly one usable backend, so a matrix cannot sweep them — but stating which one you
are on keeps the log honest, and the same GPU exposes different features through different APIs:

```yaml
    env:
      WGPU_BUN_BACKEND: vulkan   # or d3d12, metal
      WGPU_BUN_IMPL: dawn        # omit for wgpu-native, the default
```

## Full example

```yaml
jobs:
  gpu:
    strategy:
      matrix:
        include:
          - { os: ubuntu-latest, backend: vulkan }
          - { os: windows-latest, backend: d3d12 }
          - { os: macos-15, backend: metal }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends mesa-vulkan-drivers libvulkan1
      - run: bun test
        env:
          WGPU_BUN_BACKEND: ${{ matrix.backend }}
```

## Running this repository's own suite

`WGPU_BUN_ALLOW_NO_ADAPTER=1` permits the GPU suites to skip. It is off by default, so a runner
without a device fails the job. Leave it off.
