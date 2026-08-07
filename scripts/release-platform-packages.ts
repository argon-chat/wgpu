#!/usr/bin/env bun
/**
 * Build the per-platform npm packages that deliver the native library.
 *
 * ── Why sub-packages and not a postinstall hook ─────────────────────────────────────────────────
 *
 * **`bun install` does not run lifecycle scripts of installed dependencies.** That is a deliberate
 * supply-chain defence, not a bug, and unblocking it requires the *consumer* to add this package to
 * `trustedDependencies` or run `bun pm trust`. There is a built-in allowlist of well-known packages;
 * a new one is obviously not on it.
 *
 * Worse, the failure is silent. Bun installs the package, skips the hook, reports success — and the
 * user meets a library-not-found error at runtime that points nowhere near the cause. For a package
 * whose primary audience *is* Bun users, being broken-by-default on Bun, silently, is not shippable.
 *
 * So: `optionalDependencies` with `os`/`cpu` fields, the pattern esbuild, swc, sharp and
 * `bun-webgpu` all use. No install scripts anywhere. It survives `--ignore-scripts`, is
 * integrity-checked by the registry itself, installs from a warm cache offline, and needs no egress
 * to GitHub releases from networks where only a mirrored npm registry is reachable.
 *
 * The cost is publishing N+1 packages instead of 1. That is a one-time release-process cost, not a
 * per-user tax, which is why it wins.
 *
 * ── What this script does ───────────────────────────────────────────────────────────────────────
 *
 *     bun run scripts/release-platform-packages.ts --check          # validate, build nothing
 *     bun run scripts/release-platform-packages.ts                  # stage every RID into dist/npm/
 *     bun run scripts/release-platform-packages.ts --rid linux-x64  # stage one
 *     bun run scripts/release-platform-packages.ts --wire           # write optionalDependencies
 *
 * Staging a RID requires **two** libraries under `vendor/<rid>/lib/`: upstream's wgpu-native, from
 * `bun run fetch --rid <rid>`, and this project's ABI shim, from `bun run shim:build --rid <rid>`.
 *
 * Those two have different portability. wgpu-native cross-fetches happily — it is a file download,
 * so one machine can stage every platform. The shim is compiled here, and cross-linking a `cdylib`
 * for four targets from one host means four target toolchains; the release workflow instead builds
 * each on its matching runner and collects the artefacts. So a release does need four machines, for
 * exactly one of the two artefacts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  libFileName,
  platformOf,
  supportedRids,
  WGPU_NATIVE_TAG,
  type Rid,
} from "../wgpu-native.manifest.ts";
import { SHIM_VERSION, shimFileNameFor, shimIsRequired } from "../shim.manifest.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(PKG_ROOT, "vendor");
const STAGE_DIR = path.join(PKG_ROOT, "dist", "npm");

/** npm scope the per-platform packages live under. Must match `NPM_SCOPE` in `src/resolve.ts`. */
export const SCOPE = "@wgpu-bun";

/** Package name for a RID: `@wgpu-bun/win32-x64`. The RID *is* the package name — no translation. */
export function platformPackageName(rid: Rid): string {
  return `${SCOPE}/${rid}`;
}

/** The `cpu` half of a RID, in npm's spelling (which is Node's, which is why RIDs use it). */
export function cpuOf(rid: Rid): string {
  const dash = rid.indexOf("-");
  return dash === -1 ? "" : rid.slice(dash + 1);
}

/**
 * Filename of the upstream licence text that must travel with every redistributed binary.
 *
 * **Upstream's release archives contain no licence file** — verified against
 * `wgpu-windows-x86_64-msvc-release.zip` at the pinned tag, which holds exactly `include/`, `lib/`
 * and `wgpu-native-meta/` and nothing else. So a package that ships the DLL is redistributing
 * MIT / Apache-2.0 licensed bytes with no accompanying terms, which is a licence violation and not
 * merely untidy.
 *
 * The text therefore has to be committed here, copied verbatim from the wgpu-native repository at
 * the pinned tag. It is not generated: a script that synthesised a licence would be inventing a
 * copyright line, and getting that wrong is worse than having no file at all. Preflight refuses to
 * proceed without it.
 */
export const UPSTREAM_LICENSE_FILE = "LICENSE-WGPU-NATIVE";

/**
 * The `package.json` of one platform package.
 *
 * The `exports` map is load-bearing and easy to omit. `src/resolve.ts` locates the library with
 * `import.meta.resolve('@wgpu-bun/<rid>/lib/<file>')`, and a package with no `exports` map — or one
 * that only names `"."` — makes that deep specifier unresolvable. The package would install
 * correctly and still be invisible.
 */
export function platformPackageManifest(
  rid: Rid,
  version: string,
  repositoryUrl: string | null,
): Record<string, unknown> {
  const platform = platformOf(rid);
  const manifest: Record<string, unknown> = {
    name: platformPackageName(rid),
    version,
    description: `wgpu-native ${WGPU_NATIVE_TAG} and the wgpu-bun ABI shim ${SHIM_VERSION} for ${rid}. Installed automatically by wgpu-bun.`,
    // The package is almost entirely someone else's binary, so the SPDX expression is wgpu-native's
    // dual licence, not this repository's. Declaring MIT alone would understate the terms a consumer
    // is actually accepting.
    license: "MIT OR Apache-2.0",
    os: [platform],
    cpu: [cpuOf(rid)],
    exports: {
      "./lib/*": "./lib/*",
      "./include/*": "./include/*",
      "./package.json": "./package.json",
    },
    files: ["lib", "include", ".version", ".shim-version", "README.md", UPSTREAM_LICENSE_FILE],
  };
  // Never fabricated: an incorrect `repository.url` breaks npm trusted publishing with an
  // authorization error that names nothing useful, so absent is strictly better than guessed.
  if (repositoryUrl) manifest["repository"] = { type: "git", url: repositoryUrl, directory: `dist/npm/${rid}` };
  return manifest;
}

/** The `optionalDependencies` block the root package.json carries once the platforms are published. */
export function optionalDependenciesFor(version: string, rids: Rid[] = supportedRids()): Record<string, string> {
  // Exact versions, not ranges. The native library and the binding move together by definition —
  // a range would let a lockfile pair a binding with a library it was never tested against.
  return Object.fromEntries([...rids].sort().map((rid) => [platformPackageName(rid), version]));
}

/** Human-readable README shipped inside each platform package. */
function platformReadme(rid: Rid): string {
  return [
    `# ${platformPackageName(rid)}`,
    "",
    `Two shared libraries for \`${rid}\`:`,
    "",
    `- \`lib/${libFileName(platformOf(rid))}\` — [wgpu-native](https://github.com/gfx-rs/wgpu-native) \`${WGPU_NATIVE_TAG}\`,`,
    "  upstream's own release artifact, unmodified. Dual-licensed MIT / Apache-2.0 by the gfx-rs",
    "  project; see `LICENSE-WGPU-NATIVE`.",
    `- \`lib/${shimFileNameFor(rid)}\` — the \`wgpu-bun\` ABI shim \`${SHIM_VERSION}\`, MIT, built from`,
    "  the `wgpu-bun` repository. It supplies the calling sequence `bun:ffi` cannot express for the",
    "  handful of wgpu-native entry points that take a C aggregate by value.",
    "",
    "They ship together because the shim transcribes one wgpu-native generation's struct layouts and",
    "is only correct paired with it.",
    "",
    "You do not install this directly. It is an `optionalDependency` of",
    "[`wgpu-bun`](https://www.npmjs.com/package/wgpu-bun) and your package manager picks the one",
    "matching your platform via the `os` and `cpu` fields.",
    "",
  ].join("\n");
}

// ── staging ─────────────────────────────────────────────────────────────────────────────────────

interface IStageResult {
  readonly rid: Rid;
  readonly staged: boolean;
  readonly reason?: string;
}

function stage(rid: Rid, version: string, repositoryUrl: string | null): IStageResult {
  const srcDir = path.join(VENDOR_DIR, rid);
  const libName = libFileName(platformOf(rid));
  const srcLib = path.join(srcDir, "lib", libName);
  if (!fs.existsSync(srcLib)) {
    return { rid, staged: false, reason: `vendor/${rid}/lib/${libName} is missing — run: bun run fetch --rid ${rid}` };
  }

  // The ABI shim rides in the SAME package as wgpu-native, not in one of its own. That is what makes
  // the two impossible to separate: a shim transcribes one wgpu-native generation's struct layouts,
  // so a consumer who ended up with a shim from one release and a library from another would hit
  // version skew — which the seam does refuse at load, but refusing is worse than never being able
  // to get there. One tarball, one version, one `os`/`cpu` match.
  const shimName = shimFileNameFor(rid);
  const srcShim = path.join(srcDir, "lib", shimName);
  if (!fs.existsSync(srcShim)) {
    return {
      rid,
      staged: false,
      reason: `vendor/${rid}/lib/${shimName} is missing — run: bun run shim:build --rid ${rid} (or shim:fetch)`,
    };
  }

  const outDir = path.join(STAGE_DIR, rid);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "include"), { recursive: true });

  fs.copyFileSync(srcLib, path.join(outDir, "lib", libName));
  fs.copyFileSync(srcShim, path.join(outDir, "lib", shimName));
  const shimStamp = path.join(srcDir, ".shim-version");
  if (fs.existsSync(shimStamp)) fs.copyFileSync(shimStamp, path.join(outDir, ".shim-version"));
  const incDir = path.join(srcDir, "include");
  if (fs.existsSync(incDir)) {
    for (const header of fs.readdirSync(incDir)) {
      fs.copyFileSync(path.join(incDir, header), path.join(outDir, "include", header));
    }
  }
  const stamp = path.join(srcDir, ".version");
  fs.copyFileSync(fs.existsSync(stamp) ? stamp : path.join(srcDir, ".version"), path.join(outDir, ".version"));

  // Upstream ships no licence text in its archives, so this is the only copy that reaches a
  // consumer. Staging without it would publish someone else's binary with no terms attached.
  const license = path.join(PKG_ROOT, UPSTREAM_LICENSE_FILE);
  if (!fs.existsSync(license)) {
    return { rid, staged: false, reason: `${UPSTREAM_LICENSE_FILE} is missing from the package root` };
  }
  fs.copyFileSync(license, path.join(outDir, UPSTREAM_LICENSE_FILE));

  fs.writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify(platformPackageManifest(rid, version, repositoryUrl), null, 2)}\n`,
  );
  fs.writeFileSync(path.join(outDir, "README.md"), platformReadme(rid));
  return { rid, staged: true };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

function main(argv: string[]): void {
  const rootPkgPath = path.join(PKG_ROOT, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8")) as {
    version: string;
    private?: boolean;
    repository?: { url?: string };
  };
  const version = rootPkg.version;
  const repositoryUrl = rootPkg.repository?.url ?? null;

  const only = argv.indexOf("--rid") !== -1 ? argv[argv.indexOf("--rid") + 1] : null;
  const rids = only ? [only] : supportedRids();

  if (argv.includes("--wire")) {
    // Writing the block is a release action, not a repo default. Until the platform packages exist
    // on npm, declaring them would mean every `bun install` tries to resolve four 404s.
    const next = { ...rootPkg, optionalDependencies: optionalDependenciesFor(version, rids) };
    fs.writeFileSync(rootPkgPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wired optionalDependencies for ${rids.length} platform(s) at ${version}`);
    return;
  }

  const problems: string[] = [];
  if (!repositoryUrl) {
    problems.push(
      "package.json has no `repository.url`.\n" +
        "  npm trusted publishing requires it to match the GitHub repository exactly, and a wrong\n" +
        "  value fails with an authorization error that names nothing useful. Set it before the\n" +
        "  first publish — for the root package AND for every platform package.",
    );
  }
  if (!/^0\.|^\d+\.\d+\.\d+/.test(version)) problems.push(`package.json version "${version}" is not a semver release`);
  if (rootPkg.private) {
    // The deliberate interlock: `npm publish` refuses a private package, so a pre-alpha binding
    // cannot reach the registry by accident. Clearing it is a release decision and belongs in the
    // release commit, next to the version bump — not left switched off for convenience.
    problems.push(
      'package.json still has `"private": true`.\n' +
        "  That is intentional while the binding is unfinished — it makes an accidental publish\n" +
        "  impossible. Remove it in the release commit, together with the version bump and\n" +
        "  `repository.url`, once the package is actually worth installing.",
    );
  }

  if (argv.includes("--check")) {
    if (!fs.existsSync(path.join(PKG_ROOT, UPSTREAM_LICENSE_FILE))) {
      problems.push(
        `${UPSTREAM_LICENSE_FILE} is missing from the package root.\n` +
          "  wgpu-native's release archives contain no licence text — only include/, lib/ and\n" +
          "  wgpu-native-meta/ — so redistributing the shared library without it ships MIT /\n" +
          "  Apache-2.0 bytes with no accompanying terms.\n" +
          "  Copy the licence verbatim from the wgpu-native repository at the pinned tag. It is not\n" +
          "  generated on purpose: a synthesised licence would mean an invented copyright line.",
      );
    }
    for (const rid of rids) {
      const libPath = path.join(VENDOR_DIR, rid, "lib", libFileName(platformOf(rid)));
      if (!fs.existsSync(libPath)) problems.push(`${rid}: not fetched (bun run fetch --rid ${rid})`);
      const shimPath = path.join(VENDOR_DIR, rid, "lib", shimFileNameFor(rid));
      if (!fs.existsSync(shimPath)) {
        // A release without the shim is not a partial release. On a SysV host the package simply
        // does not run; everywhere else it silently takes the fallback path, so what ships is not
        // what CI exercised. Both are blockers, and saying which one applies is the difference
        // between an actionable message and a chore.
        const [platform, arch] = rid.split("-");
        problems.push(
          `${rid}: no ABI shim (bun run shim:build --rid ${rid}).\n` +
            (shimIsRequired(platform!, arch!)
              ? `    This ABI cannot express a by-value aggregate from bun:ffi, so without the shim\n` +
                `    the package refuses to run on ${rid} at all.`
              : `    This ABI can take the direct path, so it would still work — but it would then be\n` +
                `    running a different calling path from the one CI exercised, which is not what\n` +
                `    "tested" means.`),
        );
      }
    }
    if (problems.length) {
      console.error(`\nrelease preflight FAILED:\n\n  - ${problems.join("\n  - ")}\n`);
      process.exit(1);
    }
    console.log(`release preflight ok — ${rids.length} platform package(s) ready at ${version}`);
    return;
  }

  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const results = rids.map((rid) => stage(rid, version, repositoryUrl));
  for (const r of results) {
    if (r.staged) console.log(`ok    ${platformPackageName(r.rid)} → dist/npm/${r.rid}`);
    else console.warn(`skip  ${platformPackageName(r.rid)}: ${r.reason}`);
  }
  const staged = results.filter((r) => r.staged).length;
  if (staged === 0) {
    console.error("\nnothing staged — no vendored library for any requested RID.\n");
    process.exit(1);
  }
  console.log(
    `\n${staged}/${results.length} staged. Publish each with:\n` +
      `  cd dist/npm/<rid> && npm publish --access public\n` +
      `Unstaged platforms are UNPUBLISHED for this release — say so in the release notes rather\n` +
      `than leaving an optionalDependency the install cannot satisfy.`,
  );
}

if (import.meta.main) main(process.argv.slice(2));
