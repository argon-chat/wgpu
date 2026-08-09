/**
 * What gets published.
 *
 * `files` is an allowlist, and the failure mode of getting it wrong is a published package that
 * installs cleanly and cannot be imported — discovered by a stranger, after the version number is
 * spent. Nothing else in the repository notices, because the source tree is complete; only the
 * tarball is not. That is not something a typechecker or a linter can see, which is why it is
 * asserted here.
 *
 * The same goes for the platform packages: the `exports` map, the `os`/`cpu` fields and the version
 * pinning are only ever exercised at install time, on someone else's machine.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DAWN_LICENSE_FILE,
  optionalDependenciesFor,
  platformPackageManifest,
  SCOPE,
  UPSTREAM_LICENSE_FILE,
} from "../scripts/release-platform-packages.ts";
import { NPM_SCOPE } from "../src/index.ts";
import { platformOf, supportedRids, type Rid } from "../wgpu-native.manifest.ts";
import { dawnRids } from "../dawn.manifest.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8")) as Record<string, any>;

describe("the package name", () => {
  test("is unscoped `wgpu-bun`", () => {
    // The name is free on npm and a scope would buy nothing: a scoped name signals ownership by an
    // organisation, and this is a standalone package. The platform sub-packages are scoped
    // (`@wgpu-bun/<rid>`) because they are namespaced *by* this package, which is the opposite case.
    expect(pkg["name"]).toBe("wgpu-bun");
    expect(String(pkg["name"]).startsWith("@")).toBe(false);
  });

  test("the resolver's scope and the release script's scope are the same string", () => {
    // They are declared in two files that are edited by different people for different reasons.
    // If they drift, the published platform packages become invisible to the resolver — and the
    // symptom is "no library found" on a machine where the library is definitely installed.
    expect(NPM_SCOPE).toBe(SCOPE);
  });
});

describe("the tarball is complete", () => {
  const files = pkg["files"] as string[];

  test("every entry in `files` exists on disk", () => {
    const missing = files.filter((f) => !fs.existsSync(path.join(PKG_ROOT, f)));
    expect(missing).toEqual([]);
  });

  test("every `exports` target exists", () => {
    const targets: string[] = [];
    for (const entry of Object.values(pkg["exports"] as Record<string, Record<string, string>>)) {
      targets.push(...Object.values(entry));
    }
    const missing = [...new Set(targets)].filter((t) => !fs.existsSync(path.join(PKG_ROOT, t)));
    expect(missing).toEqual([]);
  });

  test("`main` and `types` point at shipped files", () => {
    for (const key of ["main", "types"]) {
      expect(fs.existsSync(path.join(PKG_ROOT, pkg[key] as string))).toBe(true);
      expect(coveredByFiles(pkg[key] as string)).toBe(true);
    }
  });

  /** Is `relPath` inside one of the `files` allowlist entries? */
  function coveredByFiles(relPath: string): boolean {
    const normalized = relPath.replace(/^\.\//, "").split(path.sep).join("/");
    return files.some((f) => {
      const entry = f.replace(/^\.\//, "");
      return normalized === entry || normalized.startsWith(`${entry}/`);
    });
  }

  test("every module reachable from the entry point ships", () => {
    // The failure this prevents: `src/index.ts` imports `../wgpu-native.manifest.ts`, the manifest
    // is dropped from `files` during some tidy-up, and the published package throws
    // ERR_MODULE_NOT_FOUND on import. Nothing else in the repo would notice — the source tree is
    // complete, only the tarball is not.
    const seen = new Set<string>();
    const orphans: string[] = [];

    function walk(fileAbs: string): void {
      const rel = path.relative(PKG_ROOT, fileAbs).split(path.sep).join("/");
      if (seen.has(rel)) return;
      seen.add(rel);
      if (!coveredByFiles(rel)) orphans.push(rel);

      const text = fs.readFileSync(fileAbs, "utf-8");
      for (const m of text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(fileAbs), m[1]!);
        if (fs.existsSync(target)) walk(target);
      }
    }

    walk(path.join(PKG_ROOT, pkg["main"] as string));
    expect(orphans).toEqual([]);
  });

  test("there is no install hook of any kind", () => {
    // `bun install` does not run lifecycle scripts of dependencies — a supply-chain defence, and it
    // fails SILENTLY: the package installs, the hook is skipped, and the user meets a
    // library-not-found error at runtime that points nowhere near the cause. For a Bun-targeted
    // package that would be broken-by-default on Bun. The native library ships as per-platform
    // `optionalDependencies` instead, which needs no scripts at all.
    for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
      expect(pkg["scripts"][hook]).toBeUndefined();
    }
  });
});

describe("platform packages", () => {
  test("optionalDependencies, when present, exactly match the manifest RIDs", () => {
    // Absent today on purpose: none of the platform packages exist on npm yet, and declaring five
    // dependencies that resolve to 404 would be a claim the install cannot satisfy.
    // `bun run release:wire` writes the block as part of cutting a release.
    const declared = pkg["optionalDependencies"] as Record<string, string> | undefined;
    if (!declared) return;
    expect(declared).toEqual(optionalDependenciesFor(pkg["version"] as string));
  });

  test.each(supportedRids())("%s produces a well-formed platform manifest", (rid) => {
    const m = platformPackageManifest(rid, "1.2.3", null);

    expect(m["name"]).toBe(`${SCOPE}/${rid}`);
    expect(m["version"]).toBe("1.2.3");
    // os/cpu are what make the package manager pick exactly one of the five.
    expect(m["os"]).toEqual([platformOf(rid)]);
    expect(m["cpu"]).toEqual([rid.slice(rid.indexOf("-") + 1)]);

    // The deep-import escape hatch. `src/resolve.ts` resolves `<pkg>/lib/<file>`, which an
    // `exports` map without a `./lib/*` entry makes unresolvable — the package would install
    // correctly and still be invisible to the thing that needs it.
    const exports = m["exports"] as Record<string, string>;
    expect(exports["./lib/*"]).toBe("./lib/*");
    expect(exports["./package.json"]).toBe("./package.json");

    expect(m["files"]).toContain("lib");

    // The ABI shim ships in the same package as wgpu-native, deliberately. A shim transcribes one
    // wgpu-native generation's struct layouts by hand, so the two are only correct as a pair; one
    // tarball makes separating them impossible rather than merely inadvisable.
    expect(m["files"]).toContain(".shim-version");
    expect(m["description"]).toContain("ABI shim");

    // The package is almost entirely someone else's binary. Declaring this repository's licence
    // alone would understate the terms a consumer accepts by installing it.
    expect(m["license"]).toBe("MIT OR Apache-2.0");
    expect(m["files"]).toContain(UPSTREAM_LICENSE_FILE);
  });

  test("the upstream licence text is what the platform packages will ship", () => {
    // wgpu-native's release archives contain no licence file at all — verified against the pinned
    // Windows archive, which holds only `include/`, `lib/` and `wgpu-native-meta/`. So this copy is
    // the only one that reaches a consumer, and shipping the shared library without it would be a
    // licence violation rather than an oversight.
    //
    // Failing here before the file exists is the point: it is a release blocker, and
    // `bun run release:check` reports it as one.
    expect(fs.existsSync(path.join(PKG_ROOT, UPSTREAM_LICENSE_FILE))).toBe(true);
  });

  test.each(dawnRids())("%s produces a well-formed Dawn platform manifest", (rid: Rid) => {
    const m = platformPackageManifest(rid, "1.2.3", null, "dawn");

    // A separate package name, not a separate scope: one `optionalDependencies` block could name
    // every platform of both if it ever needed to, and a missing Dawn install fails with a name
    // that can be searched for.
    expect(m["name"]).toBe(`${SCOPE}/${rid}-dawn`);
    expect(m["os"]).toEqual([platformOf(rid)]);
    expect(m["cpu"]).toEqual([rid.slice(rid.indexOf("-") + 1)]);

    // Headers live under `include-dawn`, and the exports map has to name it. `src/resolve.ts`
    // resolves this implementation's header directory by that name — one shared `include/` would
    // have Dawn checked against wgpu-native's declarations, which is a check that cannot fail for
    // the wrong reason.
    const exports = m["exports"] as Record<string, string>;
    expect(exports["./lib/*"]).toBe("./lib/*");
    expect(exports["./include-dawn/*"]).toBe("./include-dawn/*");
    expect(m["files"]).toContain("include-dawn");
    expect(m["files"]).toContain(".dawn-version");

    // ONE library. The shim is linked into it by `dawn:link`, so there is no second file and no
    // `.shim-version`: the pair cannot be separated because it is not a pair.
    expect(m["files"]).not.toContain(".shim-version");
    expect(m["description"]).toContain("linked in");

    // Dawn and Tint are BSD-3-Clause with Apache-2.0 components; the shim is MIT. Declaring
    // wgpu-native's dual licence here would state terms the consumer is not actually accepting.
    expect(m["license"]).toBe("BSD-3-Clause AND Apache-2.0 AND MIT");
    expect(m["files"]).toContain(DAWN_LICENSE_FILE);
  });

  test("Dawn's licence text is committed, like wgpu-native's and for the same reason", () => {
    // Google's archive holds exactly bin/, include/ and lib/ — no licence text — so this copy is the
    // only one that reaches a consumer of `@wgpu-bun/<rid>-dawn`.
    expect(fs.existsSync(path.join(PKG_ROOT, DAWN_LICENSE_FILE))).toBe(true);
  });

  test("Dawn packages are never wired into optionalDependencies", () => {
    // The load-bearing asymmetry. An optionalDependency installs by default, and a consumer who
    // never types WGPU_BUN_IMPL=dawn should not be downloading a second WebGPU implementation.
    const declared = pkg["optionalDependencies"] as Record<string, string> | undefined;
    for (const name of Object.keys(declared ?? {})) expect(name.endsWith("-dawn")).toBe(false);
    for (const name of Object.keys(optionalDependenciesFor("1.2.3"))) {
      expect(name.endsWith("-dawn")).toBe(false);
    }
  });

  test("a platform manifest omits repository rather than guessing one", () => {
    // npm trusted publishing matches `repository.url` against the GitHub repository, and a wrong
    // value fails with an authorization error that names nothing useful. Absent is recoverable;
    // fabricated is a debugging session.
    expect(platformPackageManifest("linux-x64", "1.0.0", null)["repository"]).toBeUndefined();
    expect(
      (platformPackageManifest("linux-x64", "1.0.0", "git+https://github.com/o/r.git")["repository"] as any).url,
    ).toBe("git+https://github.com/o/r.git");
  });
});

describe("publishing prerequisites", () => {
  test("repository.url, if set, is a GitHub URL", () => {
    // npm trusted publishing requires an exact match with the GitHub repository. Nothing here can
    // verify the match, but it can rule out the shapes that definitely will not work.
    const repo = pkg["repository"] as { url?: string } | undefined;
    if (!repo?.url) return;
    expect(repo.url).toMatch(/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
  });

  test("private:true is still set while the package is unpublishable", () => {
    // The interlock. `npm publish` refuses a private package, so no accident can put a
    // pre-alpha binding on the registry. `bun run release:check` names this as a release-time
    // checklist item so the flip is deliberate rather than forgotten.
    if (pkg["repository"]?.url) return; // release prep has begun; the flip is expected there
    expect(pkg["private"]).toBe(true);
  });
});
