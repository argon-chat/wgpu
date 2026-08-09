# Packaging, versioning and supply chain

How the native binaries reach you, why the version number says `29`, and what is pinned.

## How the native libraries reach you

Via **per-platform npm packages in `optionalDependencies`** — `@wgpu-bun/win32-x64`,
`@wgpu-bun/linux-x64`, and so on, each declaring `os` / `cpu` so your package manager installs
exactly the matching one. This is what esbuild, swc, sharp and `bun-webgpu` all do.

Each carries **two** shared libraries: upstream's `wgpu_native`, and this project's ABI shim. They
ship in one tarball rather than two packages because a shim transcribes one wgpu-native generation's
struct layouts by hand and is only correct paired with it — one package makes the two impossible to
separate, where two packages would merely make separating them a bad idea. The binding does check for
skew at load and refuses, but never being able to reach that state is better than refusing well.

Neither library is fetched at install time, and **no consumer needs a Rust toolchain**: the shim is
built by CI, one platform per matching runner, and published as a prebuilt artefact.

### Why not a postinstall hook

**`bun install` does not run lifecycle scripts of installed dependencies.** That is a deliberate
supply-chain defence, and unblocking it requires *the consumer* to add this package to
`trustedDependencies` or run `bun pm trust`. There is a built-in allowlist of well-known packages; a
new one is obviously not on it.

Worse, the failure is silent. Bun installs the package, skips the hook, and reports success — the
user then meets a library-not-found error at runtime that points nowhere near the cause. For a
package whose primary audience *is* Bun users, being broken-by-default on Bun, silently, is not
shippable.

Sub-packages also survive `--ignore-scripts`, are integrity-checked by the registry itself, install
from a warm cache offline, and need no egress to GitHub releases from networks where only a mirrored
npm registry is reachable. The cost is publishing N+1 packages instead of 1 — a one-time
release-process cost, not a per-user tax.

There is therefore **no `postinstall` hook** in `package.json`, and there will not be one.

### The sharp edge, stated plainly

**`optionalDependencies` fail silently.** On a platform with no matching package, your package manager
installs nothing, reports success, and says nothing. The first thing that notices is this package's
own resolver, which is why its error message names the platform it looked for, the package that would
have provided it, and the `WGPU_NATIVE_LIB` override — that message is the *only* diagnostic that
exists at that moment.

Resolution order is `WGPU_NATIVE_LIB` → `@wgpu-bun/<rid>` → `vendor/<rid>/`, so an explicitly built
library always wins and a development checkout works with no publishing at all.

`bun run fetch` keeps its job: it is what populates the platform packages at release time, and it
remains the development path.

## Versioning

**The major version is the wgpu-native generation this package binds.**

```
wgpu-bun@29.0.0
         ││ └── patch — this binding's own changes
         │└──── minor — this binding's own changes
         └───── major — wgpu-native v29. Not ours to pick.
```

Pick the major that matches the native behaviour you want; the rest is ordinary semver. A bump from
`29.x` to `30.x` means the native library changed generation — expect different validation, possibly
different WGSL acceptance — and it will happen even if not one line of this binding changed. That
digit is not a marketing choice and not a maturity signal: it names the native library inside, which
is what decides ABI, validation strictness and WGSL acceptance.

**Shipping one generation is not the same as accepting one.** The major names what the platform
packages carry; the binding loads any generation in `SUPPORTED_GENERATIONS`, and refuses the rest at
load. See [GENERATIONS.md](./GENERATIONS.md).

**Why not mirror the upstream tag exactly.** wgpu-native tags have four components (`v29.0.1.1`:
wgpu-core `29.0.1`, then upstream's own revision) and semver has three. Something had to give, so
the exact tag lives where it can be read in full instead — [`wgpu-native.manifest.ts`](../wgpu-native.manifest.ts),
the README, and the `.version` stamp written next to the installed library. The one part that could
have rotted silently is enforced instead: a test asserts this package's major **is**
`WGPU_NATIVE_MAJOR`, so a pin bump to v30 cannot ship as `29.x` and tell every consumer the ABI did
not move.

**Why not track the [`webgpu`](https://www.npmjs.com/package/webgpu) package's version**, given this
is API-compatible with it: that number moves for its own reasons — Dawn updates, its own fixes — and
would say nothing about which native library is inside. Between "what API shape do I get" and "what
implementation will actually run my shaders", the second is the one people are choosing a binding
for, and the second is what this number answers.

## Supply chain

Native binaries are **fetched, never committed** — upstream's and ours alike. Every download is
pinned to an exact URL and an exact sha256, in [`wgpu-native.manifest.ts`](../wgpu-native.manifest.ts)
for upstream's archives and [`shim.manifest.ts`](../shim.manifest.ts) for the ABI shim, and a mismatch
always hard-fails — including under `--soft`, which exists so a fresh clone without network can still
proceed, not to wave through an unexpected binary.

The same rule covers the shim's *absence* of a pin: every shim `sha256` is empty because no shim
release has been cut, an empty hash means unpinned, and `bun run shim:fetch` refuses to install an
unpinned binary and says why. A plausible-looking invented hash in a supply-chain file is worse than
a blank one.

That refusal is a **maintainer-path** refusal, not a consumer one. `shim:fetch` downloads a loose
artefact from a GitHub release; the way a consumer gets the shim is the platform npm package, which
carries it beside wgpu-native and is integrity-checked by the registry. Nobody installing `wgpu-bun`
ever reaches this code path.

```sh
bun run fetch                      # this host
bun run fetch --rid linux-arm64    # cross-fetch another platform
bun run fetch --force              # re-download even if the version stamp matches
bun run fetch:hashes               # re-measure every pinned archive's sha256, print, write nothing
```

Archive layout is **probed, not hardcoded**: the script searches the extracted tree for
`wgpu_native.{dll,so,dylib}` and the `webgpu.h` / `wgpu.h` headers by name. An upstream reshuffle
surfaces as a clear "not found in archive" rather than a silently-empty directory.

Bumping the pinned release is a two-line edit (`WGPU_NATIVE_TAG` + the URLs) followed by
`bun run fetch:hashes` to re-measure, then `bun run gen:layouts` to regenerate the struct tables.
Hashes are pasted by a human, never written by the tool — pinning should stay a deliberate,
reviewable act.

### Provenance, and what it does not cover

Releases are published from CI with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):
OIDC-issued, short-lived, workflow-specific credentials, with no long-lived `NPM_TOKEN` anywhere. npm
generates and attaches provenance attestations automatically.

**That attestation covers *this* build.** It binds a commit in this repository to the bytes published
under this name. It says **nothing** about the origin of the bundled `wgpu_native` library — that is
covered separately, by the pinned URL and sha256 in `wgpu-native.manifest.ts`, which anyone can verify
against upstream's own release page. Two different guarantees; neither substitutes for the other. A
reader who sees the provenance badge should not conclude the native binary is attested.

### Licence redistribution

**Upstream's release archives contain no licence text at all** — the pinned Windows archive holds
exactly `include/`, `lib/` and `wgpu-native-meta/`. Shipping the shared library without accompanying
terms would be a licence violation, not untidiness, so [`LICENSE-WGPU-NATIVE`](../LICENSE-WGPU-NATIVE)
is committed here verbatim from the wgpu-native repository at the pinned tag and copied into every
platform package, which declare `MIT OR Apache-2.0` accordingly. It is deliberately not generated: a
synthesised licence would mean an invented copyright line. `bun run release:check` refuses to stage a
release without it.
