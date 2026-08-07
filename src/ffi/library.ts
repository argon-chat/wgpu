/**
 * Opening the native library, once, and asserting that it is the one this package was built for.
 *
 * `wgpuGetVersion()` is called at load and compared against the manifest pin. That check exists
 * because "which wgpu-native" is part of this package's contract with its callers, not an
 * implementation detail: the C ABI, the WGSL the shader front end accepts, and how strict
 * validation is all move between generations. A filename or a directory name is not evidence of
 * any of that; a version read out of the loaded binary is.
 *
 * The check is a **warning, not a hard failure**, for one reason: a caller who points
 * `WGPU_NATIVE_LIB` at a locally-built wgpu-native is usually doing so deliberately (bisecting an
 * upstream regression), and refusing to run would remove the escape hatch. The mismatch is loud on
 * stderr and readable from {@link nativeVersion}, so it can never be silent.
 */

import { dlopen } from "bun:ffi";

import { resolveNativeLibrary } from "../resolve.ts";
import { WGPU_NATIVE_MAJOR, WGPU_NATIVE_TAG } from "../../wgpu-native.manifest.ts";
import type { IResolvedNativeLibrary } from "../types.ts";
import { SYMBOLS, assertNoBlockedSymbols } from "./symbols.ts";

export type { Ptr } from "./pointer.ts";

/** wgpu-native's packed version word, decoded. */
export interface INativeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly build: number;
  /** Dotted form, e.g. `"29.0.1.1"`. */
  readonly text: string;
  /** The raw `wgpuGetVersion()` word. */
  readonly raw: number;
}

function openLibrary(libPath: string) {
  return dlopen(libPath, SYMBOLS);
}

let loaded: {
  lib: IResolvedNativeLibrary;
  symbols: ReturnType<typeof openLibrary>["symbols"];
  version: INativeVersion;
} | null = null;

function decodeVersion(raw: number): INativeVersion {
  const major = (raw >>> 24) & 0xff;
  const minor = (raw >>> 16) & 0xff;
  const patch = (raw >>> 8) & 0xff;
  const build = raw & 0xff;
  return { major, minor, patch, build, raw, text: `${major}.${minor}.${patch}.${build}` };
}

function load() {
  if (loaded) return loaded;

  assertNoBlockedSymbols();

  const lib = resolveNativeLibrary();
  let opened: ReturnType<typeof openLibrary>;
  try {
    opened = openLibrary(lib.path);
  } catch (cause) {
    throw new Error(
      `wgpu-bun: failed to load "${lib.path}" (found via ${lib.source}).\n` +
        `  On Windows this usually means a missing dependent DLL or a non-Win32 path form — ` +
        `an MSYS-style path such as /c/... fails with error code 126.\n  Cause: ${String(cause)}`,
      { cause },
    );
  }

  const version = decodeVersion(Number(opened.symbols.wgpuGetVersion()));
  if (version.major !== WGPU_NATIVE_MAJOR) {
    console.warn(
      `wgpu-bun: loaded wgpu-native ${version.text} but this package pins ${WGPU_NATIVE_TAG} ` +
        `(generation ${WGPU_NATIVE_MAJOR}). The C ABI, the accepted WGSL and the validation rules ` +
        `all move between generations — expect divergence.\n  Library: ${lib.path} (via ${lib.source})`,
    );
  }

  loaded = { lib, symbols: opened.symbols, version };
  return loaded;
}

/**
 * The bound wgpu-native entry points.
 *
 * Deliberately a function, not a module-level constant: importing this module must not have the
 * side effect of loading a 9 MB DLL, because `src/resolve.ts` is also useful as a pure diagnostic
 * ("did the pinned binary land on this machine?") in environments that have no GPU at all.
 */
export function wgpu(): ReturnType<typeof openLibrary>["symbols"] {
  return load().symbols;
}

/** Where the loaded library came from. */
export function nativeLibrary(): IResolvedNativeLibrary {
  return load().lib;
}

/** The version reported by the loaded binary itself — not by a filename. */
export function nativeVersion(): INativeVersion {
  return load().version;
}
