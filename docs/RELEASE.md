# Cutting a release

Owner-side: npmjs.com settings, GitHub repository settings, and a push. The workflow is
[`.github/workflows/release.yml`](../.github/workflows/release.yml); this file is the order to do
things in and the traps that are only visible the first time.

## The state today

**`wgpu-bun@29.0.0` is on npm**, published 2026-08-07, together with all four `@wgpu-bun/<rid>`
platform packages at the same version. All five carry a **SLSA v1 provenance attestation**, so they
went out through trusted publishing over OIDC — the `bootstrap` token path is spent history and must
never be used again.

Verified by installing it the way a stranger would, rather than by reading this file:

```
$ bun add wgpu-bun
installed wgpu-bun@29.0.0
3 packages installed                 # the binding + @wgpu-bun/win32-x64
$ bun run smoke.ts
wgpu-bun · wgpu-native v29.0.1.1 (generation 29)
native: 29.0.1.1 | seam: shim        # the platform package delivered BOTH libraries
compute: [ 0, 3, 6, 9 ]              # dispatch + readback, correct values
```

### What the published version does *not* have

The registry serves the tree as it stood on 2026-08-07. Everything since is unpublished, and two
items are visible to anyone browsing npm right now:

- **The description still reads "Pre-alpha: skeleton only."** That is the line npm search shows under
  the package name.
- **The README is the pre-landing-page one** — the 779-line engineering document, not the front page.
- `wgpu-bun/image` (`readTexture` / `encodePng` / `saveTexturePng`) does not resolve: the published
  `exports` map has no `./image` entry and the tarball no `src/image.ts`.
- Multi-generation support is not in it — the published manifest has no `GENERATIONS` map at all.

The next release is an ordinary version bump. Both the subpath export and the second generation are
additive, so `29.1.0` is the honest number.

## Cutting the next one

```sh
# bump package.json version, commit, then:
git tag v29.1.0 && git push origin v29.1.0
```

The tag push runs the same workflow over OIDC, with no token anywhere, and npm attaches provenance
itself. A preflight refuses if the tag and `package.json` disagree — without it, tagging `v29.1.0` on
a tree that says `29.0.0` republishes **29.0.0**, which the registry rejects, and leaves a tag naming
a version nobody can install. npm versions cannot be reused.

Bumping the wgpu-native pin is a different kind of release: the manifest edit and re-measure from
[PACKAGING.md](./PACKAGING.md#supply-chain), plus moving this package's **major** to match — a test
enforces that last part.

## Loose shim artefacts (optional, and not on the critical path)

`shim.manifest.ts` points `bun run shim:fetch` at a `shim-v<version>` GitHub release whose assets do
not exist, which is why every `sha256` there is empty and the fetch refuses. Nothing a consumer does
touches this — the shim ships inside the platform npm package — it is a maintainer convenience for
populating `vendor/` without cargo. To make it work, publish the four artefacts the release matrix
already builds under the tag `shim-v3.0.0` (`SHIM_VERSION` in `shim.manifest.ts`), then
`bun run shim:fetch --update-hashes` and paste the measured hashes.

## Repository name: deliberately NOT the package name

The npm package is `wgpu-bun`; the repository is `argon-chat/wgpu`, and it stays that way.

The argument for renaming is discoverability — a GitHub search for "bun webgpu" does not find
`argon-chat/wgpu`. Topics answer that, and the owner's roadmap answers the rest: **Dawn and a Node
port are both on the table.** A repository named `wgpu-bun` would then host a binding that is neither
only-wgpu nor only-bun, and renaming a second time costs the same as the first.

Topics are already set: `bun`, `webgpu`, `webgpu-engine`, `bun-ffi`, `ffi`, `gpu`, `graphics`,
`headless-rendering`, `typescript`, `wgpu`, `wgpu-native`. `gh repo edit --add-topic` is additive if
more are wanted.
