/**
 * Opening the native library, once, and asserting that it is the one this package was built for.
 *
 * `wgpuGetVersion()` is called at load and compared against the manifest pin. That check exists
 * because "which wgpu-native" is part of this package's contract with its callers, not an
 * implementation detail: the C ABI, the WGSL the shader front end accepts, and how strict
 * validation is all move between generations. A filename or a directory name is not evidence of
 * any of that; a version read out of the loaded binary is.
 *
 * A supported generation that is not the pinned one is reported once and allowed. A generation this
 * package has never been run against is **refused** — see {@link assertSupportedGeneration} for why
 * warning was not enough — with `WGPU_BUN_ALLOW_UNTESTED_GENERATION=1` as the deliberate escape
 * hatch for someone bisecting an upstream regression. Either way the version is readable from
 * {@link nativeVersion}, so it can never be silent.
 */

import { dlopen } from "bun:ffi";

import { resolveNativeLibrary } from "../resolve.ts";
import { SUPPORTED_GENERATIONS, WGPU_NATIVE_MAJOR, WGPU_NATIVE_TAG } from "../../wgpu-native.manifest.ts";
import type { IResolvedNativeLibrary } from "../types.ts";
import { SYMBOLS, WGPU_NATIVE_ONLY_SYMBOLS, assertNoBlockedSymbols } from "./symbols.ts";
import { currentImpl } from "../impl.ts";

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

/**
 * Bind the portable table, plus wgpu-native's own three entry points when that is what is loaded.
 *
 * `dlopen` binds a table atomically — one absent name rejects all of them — so the extensions cannot
 * simply be listed and left unused under Dawn. The returned type is the union either way, so call
 * sites keep their names; reaching for an extension under Dawn is a missing-key error at that call
 * site, which is where the decision about what to do instead belongs.
 */
function openLibrary(libPath: string) {
  const table = currentImpl() === "dawn" ? SYMBOLS : { ...SYMBOLS, ...WGPU_NATIVE_ONLY_SYMBOLS };
  return dlopen(libPath, table as typeof SYMBOLS & typeof WGPU_NATIVE_ONLY_SYMBOLS);
}

let loaded: {
  lib: IResolvedNativeLibrary;
  symbols: ReturnType<typeof openLibrary>["symbols"];
  version: INativeVersion;
} | null = null;

/**
 * Dawn's version, from the pin rather than from the binary.
 *
 * Dawn's tags are `vYYYYMMDD.HHMMSS` — a timestamp, not a semantic version — so the numeric fields
 * are filled from the date and `text` carries the tag verbatim. `raw` is 0 because there is no
 * version word to report and inventing one would make a fabricated number look measured.
 *
 * The stamp comes from `vendor/<rid>/.dawn-version` or the platform package; when neither is
 * present the version is unknown, and it says that rather than guessing.
 */
function dawnVersion(lib: IResolvedNativeLibrary): INativeVersion {
  const text = lib.version ?? "unknown";
  const m = /^v?(\d{4})(\d{2})(\d{2})\.(\d+)$/.exec(text);
  return {
    major: m ? Number(m[1]) : 0,
    minor: m ? Number(m[2]) : 0,
    patch: m ? Number(m[3]) : 0,
    build: m ? Number(m[4]) : 0,
    raw: 0,
    text,
  };
}

function decodeVersion(raw: number): INativeVersion {
  const major = (raw >>> 24) & 0xff;
  const minor = (raw >>> 16) & 0xff;
  const patch = (raw >>> 8) & 0xff;
  const build = raw & 0xff;
  return { major, minor, patch, build, raw, text: `${major}.${minor}.${patch}.${build}` };
}

/**
 * Environment variable that downgrades an unsupported-generation refusal to a warning.
 *
 * It exists because "unsupported" here means *untested*, not *known broken* — a v25 library may
 * well work. What it may also do is renumber a `wgpu.h` extension enum and silently ignore a
 * chained struct, which is how a backend override stops taking effect without anything failing. A
 * knob a person has to type is the right shape for that: it makes running untested combinations
 * possible and makes doing it by accident impossible.
 */
export const ALLOW_UNTESTED_GENERATION_ENV = "WGPU_BUN_ALLOW_UNTESTED_GENERATION";

/**
 * The loaded library's generation must be one this package has actually been run against.
 *
 * Refusing rather than warning is a deliberate change of posture. A warning on stderr is invisible
 * inside a test runner, and the failure it precedes is not a crash — between generations the
 * observable differences are validation strictness, WGSL acceptance, and extension-struct
 * numbering, all of which produce *plausible wrong answers* rather than errors. A suite that runs
 * green against a library its binding was never tested with has proven nothing, and nothing about
 * it looks wrong.
 */
function assertSupportedGeneration(version: INativeVersion, lib: IResolvedNativeLibrary): void {
  if (SUPPORTED_GENERATIONS.includes(version.major)) {
    if (version.major !== WGPU_NATIVE_MAJOR) {
      // Supported, but not the one that ships. Said out loud once, because "which wgpu is actually
      // running" is the single most useful line in a bug report about this package.
      console.info(
        `wgpu-bun: wgpu-native ${version.text} (generation ${version.major}); this package ships ` +
          `${WGPU_NATIVE_TAG}. Both are supported.\n  Library: ${lib.path} (via ${lib.source})`,
      );
    }
    return;
  }

  const message =
    `wgpu-bun: wgpu-native ${version.text} is generation ${version.major}, which this package has ` +
    `never been tested against.\n` +
    `  Supported: ${SUPPORTED_GENERATIONS.join(", ")} (this build ships ${WGPU_NATIVE_TAG}).\n` +
    `  Library: ${lib.path} (via ${lib.source})\n` +
    `  Generations differ in validation strictness, WGSL acceptance and extension-struct numbering.\n` +
    `  Those produce wrong answers, not errors, so this is refused rather than warned about.\n` +
    `  Set ${ALLOW_UNTESTED_GENERATION_ENV}=1 to proceed anyway, deliberately.`;

  if (process.env[ALLOW_UNTESTED_GENERATION_ENV] === "1") {
    console.warn(`${message}\n  Proceeding: ${ALLOW_UNTESTED_GENERATION_ENV}=1.`);
    return;
  }
  throw new Error(message);
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

  // wgpu-native reports its own version out of the binary, which is the only trustworthy source
  // when a file name can say anything. Dawn exposes no runtime accessor, so the pinned tag beside
  // the library is all there is — recorded as such, rather than fabricated into a version word.
  const version =
    currentImpl() === "dawn"
      ? dawnVersion(lib)
      : decodeVersion(Number(opened.symbols.wgpuGetVersion()));
  if (currentImpl() !== "dawn") assertSupportedGeneration(version, lib);

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
