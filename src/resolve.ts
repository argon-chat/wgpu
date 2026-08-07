/**
 * Locating the wgpu-native shared library.
 *
 * This is the one part of the package that can be written *before* the FFI mechanism is decided,
 * because all three candidates (hand-packed ArrayBuffer descriptors over `bun:ffi`, `bun:ffi`'s
 * `cc()`, a Rust shim crate) need the same thing from the filesystem: an absolute path to a shared
 * library, and optionally the headers next to it. A Rust shim would change *which* library is loaded
 * — the shim's own `.so`/`.dll` rather than wgpu-native's — but not how a path is found, so this
 * module stays correct either way.
 *
 * ── Resolution order ────────────────────────────────────────────────────────────────────────────
 *
 *   1. `WGPU_NATIVE_LIB`      — explicit absolute path. Escape hatch for a locally-built wgpu-native
 *                               (bisecting an upstream regression, testing an unreleased fix).
 *   2. `@wgpu-bun/<rid>`      — a per-platform npm sub-package, if one is installed.
 *   3. `vendor/<rid>/lib/…`   — what `scripts/fetch-wgpu-native.ts` produces.
 *
 * Tier 2 exists today even though no such sub-package is published. That is deliberate: the
 * acquisition question (optional npm sub-packages vs. a pinned postinstall fetch — see README
 * §Acquiring the binary) is genuinely open, and ordering the resolver so that an npm sub-package
 * simply *wins when present* makes the eventual answer an additive change instead of a rewrite. The
 * cost is one `import.meta.resolve` attempt in a `try`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { currentRid, libFileName, type Rid } from "../wgpu-native.manifest.ts";
import type { IResolvedNativeLibrary } from "./types.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Env var holding an explicit absolute path to a wgpu-native shared library. */
export const LIB_ENV_VAR = "WGPU_NATIVE_LIB";

/** npm scope the per-platform sub-packages would live under, were they published. */
export const NPM_SCOPE = "@wgpu-bun";

/** Read the `.version` stamp sitting beside a vendored library, if there is one. */
function readVersionStamp(libDir: string): string | null {
  const stamp = path.join(path.dirname(libDir), ".version");
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

/** Tier 1 — explicit override. */
function fromEnv(): IResolvedNativeLibrary | null {
  const explicit = process.env[LIB_ENV_VAR];
  if (!explicit) return null;
  if (!fs.existsSync(explicit)) {
    throw new Error(
      `${LIB_ENV_VAR} is set to "${explicit}" but no file exists there. ` +
        `Unset it or point it at a wgpu-native shared library.`,
    );
  }
  const dir = path.dirname(explicit);
  return {
    path: path.resolve(explicit),
    source: "env",
    includeDir: siblingIncludeDir(dir),
    version: readVersionStamp(dir),
  };
}

/** Tier 2 — a per-platform npm sub-package, if one is installed. */
function fromNpm(rid: Rid, platform: string): IResolvedNativeLibrary | null {
  const specifier = `${NPM_SCOPE}/${rid}/lib/${libFileName(platform)}`;
  try {
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    if (!fs.existsSync(resolved)) return null;
    const dir = path.dirname(resolved);
    return {
      path: resolved,
      source: "npm",
      includeDir: siblingIncludeDir(dir),
      version: readVersionStamp(dir),
    };
  } catch {
    // Not installed. Expected on every host today — no sub-package has been published.
    return null;
  }
}

/** Tier 3 — the fetched vendor tree. */
function fromVendor(rid: Rid, platform: string): IResolvedNativeLibrary | null {
  const libPath = path.join(PKG_ROOT, "vendor", rid, "lib", libFileName(platform));
  if (!fs.existsSync(libPath)) return null;
  const dir = path.dirname(libPath);
  return {
    path: libPath,
    source: "vendor",
    includeDir: siblingIncludeDir(dir),
    version: readVersionStamp(dir),
  };
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
  return fromEnv() ?? fromNpm(rid, platform) ?? fromVendor(rid, platform);
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
