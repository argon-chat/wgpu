/**
 * Locating the shared libraries this package loads.
 *
 * Which libraries those are depends on the implementation `src/impl.ts` selected:
 *
 *   **wgpu-native** (default) — two files. Upstream's binary, fetched and pinned by sha256, plus
 *   this project's own ABI shim (`shim/`, a `cdylib`), which supplies the calling sequence
 *   `bun:ffi` cannot express for by-value aggregates. See `src/ffi/abiSeam.ts`.
 *
 *   **Dawn** (`WGPU_BUN_IMPL=dawn`) — one file. `scripts/dawn-link.ts` links Dawn's static release
 *   and the shim's objects into a single library, so the shim "resolves" to the same path as the
 *   implementation. Nothing above this layer notices: the two implementations expose the same
 *   `webgpu.h`.
 *
 * ── Resolution order, identical for every library ───────────────────────────────────────────────
 *
 *   1. `WGPU_NATIVE_LIB` / `WGPU_BUN_SHIM_LIB` / `WGPU_DAWN_LIB`  — explicit absolute path. Escape
 *                               hatch for a locally built library (bisecting an upstream regression,
 *                               testing an unreleased fix, or a shim built straight out of `cargo`).
 *   2. `@wgpu-bun/<rid>`      — the per-platform npm sub-package, if one is installed. It carries
 *                               **both** libraries, which is what keeps them version-locked: a shim
 *                               is only correct for the wgpu-native generation it was written
 *                               against, and shipping them in one tarball makes separating them
 *                               impossible rather than merely discouraged. Dawn's equivalent is
 *                               `@wgpu-bun/<rid>-dawn`, where "both" is one file by construction.
 *   3. `vendor/<rid>/lib/…`   — what `scripts/fetch-wgpu-native.ts`, `scripts/shim.ts` and
 *                               `scripts/dawn-link.ts` produce.
 *
 * Tier 2 is the path a consumer actually takes — the four `@wgpu-bun/<rid>` packages are published.
 * The ordering is deliberate: ordering the
 * resolver so an npm sub-package simply *wins when present* makes publishing an additive change
 * instead of a rewrite. The cost is one `import.meta.resolve` attempt in a `try`.
 *
 * The shim resolves to `null` rather than throwing when it is absent, because absence is a normal
 * state on every platform whose ABI does not need it — the seam, not the resolver, owns the policy.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { currentRid, libFileName, type Rid } from "../wgpu-native.manifest.ts";
import { shimFileName } from "../shim.manifest.ts";
import { dawnLibFileName } from "../dawn.manifest.ts";
import { currentImpl, DEFAULT_IMPL, IMPL_ENV_VAR, type WgpuImpl } from "./impl.ts";
import type { IResolvedNativeLibrary, NativeLibrarySource } from "./types.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Env var holding an explicit absolute path to a wgpu-native shared library. */
export const LIB_ENV_VAR = "WGPU_NATIVE_LIB";

/** Env var holding an explicit absolute path to an ABI shim shared library. */
export const SHIM_ENV_VAR = "WGPU_BUN_SHIM_LIB";

/** Env var holding an explicit absolute path to a linked Dawn shared library. */
export const DAWN_ENV_VAR = "WGPU_DAWN_LIB";

/** npm scope the per-platform sub-packages live under. */
export const NPM_SCOPE = "@wgpu-bun";

/** What a `.version`-style stamp is called for each library. */
const NATIVE_STAMP = ".version";
const SHIM_STAMP = ".shim-version";
const DAWN_STAMP = ".dawn-version";

/** Read a version stamp sitting beside a vendored library, if there is one. */
function readVersionStamp(libDir: string, stampName: string): string | null {
  const stamp = path.join(path.dirname(libDir), stampName);
  try {
    return fs.readFileSync(stamp, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** `<dir>/../<name>` when it exists and holds headers. */
function siblingIncludeDir(libDir: string, name: string): string | null {
  const inc = path.join(path.dirname(libDir), name);
  try {
    return fs.readdirSync(inc).length > 0 ? inc : null;
  } catch {
    return null;
  }
}

/** One library's identity, as the tier walk needs it. */
interface ILibraryKind {
  readonly envVar: string;
  readonly stamp: string;
  readonly fileName: (platform: string) => string;
  /**
   * Sibling directory holding this library's own `webgpu.h`, or `null` when it has none.
   *
   * Named per kind rather than fixed, because both implementations land in the same
   * `vendor/<rid>/lib` and their headers are **not** interchangeable in the direction that matters:
   * the header-derived checks in `test/callback-abi.test.ts` read this to enumerate the by-value
   * callbacks of the library actually loaded. One shared `include/` would have Dawn checked against
   * wgpu-native's declarations — a check that cannot fail for the wrong reason, which is the worst
   * kind of check to have.
   */
  readonly includeDirName: string | null;
}

const NATIVE: ILibraryKind = {
  envVar: LIB_ENV_VAR,
  stamp: NATIVE_STAMP,
  fileName: libFileName,
  includeDirName: "include",
};

/**
 * Dawn, when `WGPU_BUN_IMPL=dawn` selects it.
 *
 * A separate kind rather than a flag on {@link NATIVE}, because every field differs: its own env
 * override, its own file name, its own version stamp, and — see {@link npmPackageFor} — its own npm
 * package, which is opt-in rather than an `optionalDependency` of the main one. What it does *not*
 * differ in is the C API it exposes, which is why nothing above this layer branches on it.
 */
const DAWN: ILibraryKind = {
  envVar: DAWN_ENV_VAR,
  stamp: DAWN_STAMP,
  fileName: dawnLibFileName,
  // Copied out of the release archive by `scripts/dawn-link.ts` into a directory of its own, so it
  // cannot be confused with wgpu-native's headers sitting beside it in the same tree.
  includeDirName: "include-dawn",
};

/** The library kind a given implementation loads. */
function kindFor(impl: WgpuImpl): ILibraryKind {
  return impl === "dawn" ? DAWN : NATIVE;
}

/**
 * The per-platform npm package for an implementation.
 *
 * `@wgpu-bun/<rid>` carries wgpu-native plus the standalone shim; `@wgpu-bun/<rid>-dawn` carries a
 * single library with both surfaces fused into it. The suffix rather than a separate scope so that
 * one `optionalDependencies` block can name every platform of both, and so an install that lacks
 * Dawn fails with a name that can be searched for rather than with "not found".
 */
export function npmPackageFor(rid: Rid, impl: WgpuImpl = currentImpl()): string {
  return impl === "dawn" ? `${NPM_SCOPE}/${rid}-dawn` : `${NPM_SCOPE}/${rid}`;
}

const SHIM: ILibraryKind = {
  envVar: SHIM_ENV_VAR,
  stamp: SHIM_STAMP,
  fileName: shimFileName,
  includeDirName: null,
};

function describe(kind: ILibraryKind, libPath: string, source: NativeLibrarySource): IResolvedNativeLibrary {
  const dir = path.dirname(libPath);
  return {
    path: libPath,
    source,
    includeDir: kind.includeDirName ? siblingIncludeDir(dir, kind.includeDirName) : null,
    version: readVersionStamp(dir, kind.stamp),
  };
}

/** Tier 1 — explicit override. Throws when set-but-wrong: the user asserted a path. */
function fromEnv(kind: ILibraryKind): IResolvedNativeLibrary | null {
  const explicit = process.env[kind.envVar];
  if (!explicit) return null;
  if (!fs.existsSync(explicit)) {
    throw new Error(
      `${kind.envVar} is set to "${explicit}" but no file exists there. ` +
        `Unset it or point it at a ${kind === SHIM ? "wgpu-bun ABI shim" : "wgpu-native"} shared library.`,
    );
  }
  return describe(kind, path.resolve(explicit), "env");
}

/** Tier 2 — a per-platform npm sub-package, if one is installed. */
function fromNpm(kind: ILibraryKind, rid: Rid, platform: string): IResolvedNativeLibrary | null {
  const pkg = kind === DAWN ? npmPackageFor(rid, "dawn") : npmPackageFor(rid, "wgpu-native");
  const specifier = `${pkg}/lib/${kind.fileName(platform)}`;
  try {
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    if (!fs.existsSync(resolved)) return null;
    return describe(kind, resolved, "npm");
  } catch {
    // Not installed: an unsupported platform, or a source checkout that never ran `bun run fetch`.
    return null;
  }
}

/** Tier 3 — the fetched/built vendor tree. */
function fromVendor(kind: ILibraryKind, rid: Rid, platform: string): IResolvedNativeLibrary | null {
  const libPath = path.join(PKG_ROOT, "vendor", rid, "lib", kind.fileName(platform));
  if (!fs.existsSync(libPath)) return null;
  return describe(kind, libPath, "vendor");
}

function walkTiers(kind: ILibraryKind, rid: Rid, platform: string): IResolvedNativeLibrary | null {
  return fromEnv(kind) ?? fromNpm(kind, rid, platform) ?? fromVendor(kind, rid, platform);
}

/**
 * Locate the wgpu-native shared library for this host, or `null` if none of the tiers hit.
 *
 * Returns `null` rather than throwing so callers can distinguish "not installed" (actionable: run
 * the fetch script) from "installed but broken" (which throws from tier 1, the only tier where the
 * user asserted a path that must exist).
 */
export function tryResolveNativeLibrary(
  rid: Rid = currentRid(),
  platform: string = process.platform,
  impl: WgpuImpl = currentImpl(),
): IResolvedNativeLibrary | null {
  return walkTiers(kindFor(impl), rid, platform);
}

/**
 * {@link tryResolveNativeLibrary}, but throws an actionable error instead of returning `null`.
 *
 * @throws when no wgpu-native library can be found for this host.
 */
export function resolveNativeLibrary(
  rid: Rid = currentRid(),
  platform: string = process.platform,
  impl: WgpuImpl = currentImpl(),
): IResolvedNativeLibrary {
  const found = tryResolveNativeLibrary(rid, platform, impl);
  if (found) return found;
  const kind = kindFor(impl);
  // Every tier that was tried is named, including the npm sub-package. That matters more than it
  // looks: `optionalDependencies` fail SILENTLY when no entry matches the platform, so on an
  // unsupported host this message is the only diagnostic anyone will ever see. Omitting the
  // package name would leave a user staring at "not found" with nothing to search for.
  const fix =
    impl === "dawn"
      ? `    bun add ${npmPackageFor(rid, impl)}          (Dawn is opt-in; it is not installed by default)\n` +
        `    bun run dawn:fetch && bun run dawn:link  (builds it from the pinned release, into vendor/)\n` +
        `    export ${kind.envVar}=/path/to/${kind.fileName(platform)}\n` +
        `  Or unset $${IMPL_ENV_VAR} to use the default implementation (${DEFAULT_IMPL}).`
      : `    bun run scripts/fetch-wgpu-native.ts   (downloads the pinned release into vendor/)\n` +
        `    export ${kind.envVar}=/path/to/${kind.fileName(platform)}`;
  throw new Error(
    `${impl} was not found for ${rid}.\n` +
      `  Looked for, in order:\n` +
      `    1. $${kind.envVar}            — an explicit absolute path (currently ${
        process.env[kind.envVar] ? `"${process.env[kind.envVar]}"` : "unset"
      })\n` +
      `    2. ${npmPackageFor(rid, impl)}   — the per-platform npm package for this host\n` +
      `    3. vendor/${rid}/lib/${kind.fileName(platform)}\n` +
      `  Fix it with one of:\n` +
      fix +
      `\n  If ${rid} is not a platform this package publishes, note that an optionalDependency for an\n` +
      `  unmatched platform installs nothing and reports nothing — this error is the notification.`,
  );
}

/**
 * Locate the ABI shim for this host, or `null` if it is not installed.
 *
 * There is deliberately no throwing variant. On Win64 and AArch64 an absent shim is not an error —
 * the direct path is correct there — and on SysV the refusal that follows has to explain the ABI, not
 * just the filesystem. Both of those judgements belong to `src/ffi/abiSeam.ts`, which is why this
 * function reports and does not decide.
 */
export function tryResolveShimLibrary(
  rid: Rid = currentRid(),
  platform: string = process.platform,
  impl: WgpuImpl = currentImpl(),
): IResolvedNativeLibrary | null {
  // Under Dawn the shim is not a separate file: `scripts/dawn-link.ts` links the same Rust objects
  // into the Dawn library itself, so a Dawn install is one binary carrying both surfaces. Resolving
  // it to that library is therefore not a shortcut — it is where the trampolines are. A Dawn library
  // built without the fuse resolves here too and then fails at the seam's first check, naming the
  // flat-ABI symbol it could not find, which is the diagnosis worth having.
  if (impl === "dawn") return tryResolveNativeLibrary(rid, platform, impl);
  return walkTiers(SHIM, rid, platform);
}

/** The tiers the shim was looked for in, spelled out for an error message. */
export function shimSearchPath(
  rid: Rid = currentRid(),
  platform: string = process.platform,
  impl: WgpuImpl = currentImpl(),
): string {
  if (impl === "dawn") {
    return (
      `    the Dawn library itself — the shim is linked into it, so it is not looked for separately.\n` +
      `    Resolved as: ${npmPackageFor(rid, impl)} or vendor/${rid}/lib/${dawnLibFileName(platform)}`
    );
  }
  return (
    `    1. $${SHIM_ENV_VAR}        — an explicit absolute path (currently ${
      process.env[SHIM_ENV_VAR] ? `"${process.env[SHIM_ENV_VAR]}"` : "unset"
    })\n` +
    `    2. ${npmPackageFor(rid, impl)}   — the per-platform npm package for this host\n` +
    `    3. vendor/${rid}/lib/${shimFileName(platform)}`
  );
}
