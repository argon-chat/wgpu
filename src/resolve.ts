/**
 * Locating the shared libraries this package loads.
 *
 * There are two of them and they are found the same way:
 *
 *   - **wgpu-native** — upstream's binary, fetched and pinned by sha256.
 *   - **the ABI shim** — this project's own `cdylib` (`shim/`), which supplies the calling sequence
 *     `bun:ffi` cannot express for by-value aggregates. See `src/ffi/abiSeam.ts`.
 *
 * ── Resolution order, identical for both ────────────────────────────────────────────────────────
 *
 *   1. `WGPU_NATIVE_LIB` / `WGPU_BUN_SHIM_LIB`  — explicit absolute path. Escape hatch for a locally
 *                               built library (bisecting an upstream regression, testing an
 *                               unreleased fix, or a shim built straight out of `cargo`).
 *   2. `@wgpu-bun/<rid>`      — the per-platform npm sub-package, if one is installed. It carries
 *                               **both** libraries, which is what keeps them version-locked: a shim
 *                               is only correct for the wgpu-native generation it was written
 *                               against, and shipping them in one tarball makes separating them
 *                               impossible rather than merely discouraged.
 *   3. `vendor/<rid>/lib/…`   — what `scripts/fetch-wgpu-native.ts` and `scripts/shim.ts` produce.
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
import type { IResolvedNativeLibrary, NativeLibrarySource } from "./types.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Env var holding an explicit absolute path to a wgpu-native shared library. */
export const LIB_ENV_VAR = "WGPU_NATIVE_LIB";

/** Env var holding an explicit absolute path to an ABI shim shared library. */
export const SHIM_ENV_VAR = "WGPU_BUN_SHIM_LIB";

/** npm scope the per-platform sub-packages live under. */
export const NPM_SCOPE = "@wgpu-bun";

/** What a `.version`-style stamp is called for each library. */
const NATIVE_STAMP = ".version";
const SHIM_STAMP = ".shim-version";

/** Read a version stamp sitting beside a vendored library, if there is one. */
function readVersionStamp(libDir: string, stampName: string): string | null {
  const stamp = path.join(path.dirname(libDir), stampName);
  try {
    return fs.readFileSync(stamp, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** `<dir>/../include` when it exists and holds headers. */
function siblingIncludeDir(libDir: string): string | null {
  const inc = path.join(path.dirname(libDir), "include");
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
  /** Headers ship next to wgpu-native; the shim has none. */
  readonly wantsInclude: boolean;
}

const NATIVE: ILibraryKind = {
  envVar: LIB_ENV_VAR,
  stamp: NATIVE_STAMP,
  fileName: libFileName,
  wantsInclude: true,
};

const SHIM: ILibraryKind = {
  envVar: SHIM_ENV_VAR,
  stamp: SHIM_STAMP,
  fileName: shimFileName,
  wantsInclude: false,
};

function describe(kind: ILibraryKind, libPath: string, source: NativeLibrarySource): IResolvedNativeLibrary {
  const dir = path.dirname(libPath);
  return {
    path: libPath,
    source,
    includeDir: kind.wantsInclude ? siblingIncludeDir(dir) : null,
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
  const specifier = `${NPM_SCOPE}/${rid}/lib/${kind.fileName(platform)}`;
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
): IResolvedNativeLibrary | null {
  return walkTiers(NATIVE, rid, platform);
}

/**
 * {@link tryResolveNativeLibrary}, but throws an actionable error instead of returning `null`.
 *
 * @throws when no wgpu-native library can be found for this host.
 */
export function resolveNativeLibrary(
  rid: Rid = currentRid(),
  platform: string = process.platform,
): IResolvedNativeLibrary {
  const found = tryResolveNativeLibrary(rid, platform);
  if (found) return found;
  // Every tier that was tried is named, including the npm sub-package. That matters more than it
  // looks: `optionalDependencies` fail SILENTLY when no entry matches the platform, so on an
  // unsupported host this message is the only diagnostic anyone will ever see. Omitting the
  // package name would leave a user staring at "not found" with nothing to search for.
  throw new Error(
    `wgpu-native was not found for ${rid}.\n` +
      `  Looked for, in order:\n` +
      `    1. $${LIB_ENV_VAR}            — an explicit absolute path (currently ${
        process.env[LIB_ENV_VAR] ? `"${process.env[LIB_ENV_VAR]}"` : "unset"
      })\n` +
      `    2. ${NPM_SCOPE}/${rid}   — the per-platform npm package for this host\n` +
      `    3. vendor/${rid}/lib/${libFileName(platform)}\n` +
      `  Fix it with one of:\n` +
      `    bun run scripts/fetch-wgpu-native.ts   (downloads the pinned release into vendor/)\n` +
      `    export ${LIB_ENV_VAR}=/path/to/${libFileName(platform)}\n` +
      `  If ${rid} is not a platform this package publishes, note that an optionalDependency for an\n` +
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
): IResolvedNativeLibrary | null {
  return walkTiers(SHIM, rid, platform);
}

/** The tiers the shim was looked for in, spelled out for an error message. */
export function shimSearchPath(rid: Rid = currentRid(), platform: string = process.platform): string {
  return (
    `    1. $${SHIM_ENV_VAR}        — an explicit absolute path (currently ${
      process.env[SHIM_ENV_VAR] ? `"${process.env[SHIM_ENV_VAR]}"` : "unset"
    })\n` +
    `    2. ${NPM_SCOPE}/${rid}   — the per-platform npm package for this host\n` +
    `    3. vendor/${rid}/lib/${shimFileName(platform)}`
  );
}
