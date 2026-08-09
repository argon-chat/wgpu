# Cutting a release

Everything here is owner-side: it needs npmjs.com settings, GitHub repository settings, and a push.
The workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml); this file is the
order to do things in and the traps that are only visible the first time.

## The state today

**`wgpu-bun@29.0.0` is on npm**, published 2026-08-07, together with all four
`@wgpu-bun/<rid>` platform packages at the same version. It carries a **provenance attestation**, so
it went out through trusted publishing over OIDC — the `bootstrap` token path is spent history and
must never be used again.

Verified by installing it the way a stranger would, rather than by reading this file:

```
$ bun add wgpu-bun
installed wgpu-bun@29.0.0            # 3 packages: the binding + @wgpu-bun/win32-x64
$ bun run smoke.ts
wgpu-bun · wgpu-native v29.0.1.1 (generation 29)
native: 29.0.1.1 | seam: shim       # the platform package delivered BOTH libraries
compute: OK                          # dispatch + readback, correct values
```

So the whole `optionalDependencies` argument in [PACKAGING.md](./PACKAGING.md) is not a design
sketch — it is what happens.

### What the published version does *not* have

The registry currently serves the tree as it stood on 2026-08-07. Everything since is unpublished,
and two items are visible to anyone browsing npm right now:

- **The description still reads "Pre-alpha: skeleton only."** That is the line npm search shows under
  the package name, and it describes something that has not been true for a while.
- **The README is the pre-landing-page one** — the 797-line engineering document, not the front page.
- `wgpu-bun/image` (`readTexture` / `encodePng` / `saveTexturePng`) does not resolve.
- Multi-generation support (accepting wgpu-native v27 alongside v29) is not in it.

None of that is a release *problem*; it is a release that has not been cut yet. The next one is an
ordinary version bump — see below. Given the subpath export and the second generation are both
additive features, `29.1.0` is the honest number.

## Cutting the next one

```sh
# bump package.json version, commit, then:
git tag v29.1.0 && git push origin v29.1.0
```

The tag push runs the same workflow over OIDC, with no token anywhere, and npm attaches provenance
itself. A preflight refuses if the tag and `package.json` disagree — without it, tagging `v29.1.0` on
a tree that says `29.0.0` republishes **29.0.0**, which the registry rejects outright, and leaves a
tag naming a version nobody can install. npm versions cannot be reused.

Bumping the wgpu-native pin is a different kind of release: edit `WGPU_NATIVE_TAG` and the URLs, run
`bun run fetch:hashes`, paste the measured hashes, run `bun run gen:layouts`, and move the package's
**major** to match — a test enforces that last part.

## Loose shim artefacts (optional, and not on the critical path)

`shim.manifest.ts` points `bun run shim:fetch` at a `shim-v<version>` GitHub release whose assets do
not exist, which is why every `sha256` there is empty and the fetch refuses. Nothing a consumer does
touches this: the shim ships inside the platform npm package. It is a maintainer convenience for
populating `vendor/` without cargo.

To make it work, publish the four artefacts the release matrix already builds under the tag
`shim-v3.0.0`, then `bun run shim:fetch --update-hashes` and paste the measured hashes. Until then the
empty hashes are correct — an empty hash means *unpinned*, and inventing a plausible one would be
worse than leaving it blank.

## Getting listed: `awesome-bun`

[`oven-sh/awesome-bun`](https://github.com/oven-sh/awesome-bun) is Bun's own curated list, and it
currently contains **no WebGPU or GPU entry at all** — not this package, not `bun-webgpu`, nothing
under Extensions → Libraries touching graphics. That is an empty slot on the list a Bun user reads
first.

The package is installable today, so the only thing still worth waiting for is the repository
rename — do it after that, so the link is the one it will keep.

The rules, from its `CONTRIBUTING.md`, in full: search previous suggestions first; one pull request
per suggestion; title-case the name; use the format `[Title Case Name](link) - Description.`;
descriptions short, starting with a capital and ending with a full stop; check spelling and grammar;
strip trailing whitespace; give the PR a useful title; and **put a link to the repository in the
commit message body**.

The entry, to be added to the `### Libraries` list under `## Extensions`:

```markdown
- [wgpu-bun](https://github.com/argon-chat/wgpu-bun) - WebGPU for Bun via bun:ffi and wgpu-native. Headless compute and offscreen rendering.
```

Worth knowing before submitting: the existing entries do not consistently follow the title-case rule
(`bun-types`, `blipgloss`, `bnx`), so a lowercase package name is in keeping with the list as it
actually reads. The maintainers ask for edits on the existing PR rather than a new one, so expect a
round of review rather than a merge or a close.

## Repository name and discoverability

The npm package is `wgpu-bun`; the repository is `argon-chat/wgpu`. A search for "bun webgpu" on
GitHub does not find the latter, which is the whole audience.

Renaming to `wgpu-bun` costs a redirect GitHub maintains for you, and requires updating in the same
change:

- `repository.url`, `homepage` and `bugs.url` in `package.json` — an npm trusted-publisher
  configuration matches on the repository, so it must be updated on npmjs.com too, for all five
  packages;
- the three badge URLs at the top of `README.md`;
- the `SHIM_ASSETS` release URLs in `shim.manifest.ts`.

Topics, which cost nothing and are how GitHub search actually finds things:

```sh
gh repo edit argon-chat/wgpu --add-topic wgpu,wgpu-native,ffi,bun-ffi,gpu,graphics,typescript,headless-rendering
```

(`webgpu`, `bun` and `rust` are presumably already there — the command is additive.)
