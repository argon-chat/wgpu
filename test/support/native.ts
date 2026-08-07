/**
 * Talking to the *installed native library* directly, without going through the binding.
 *
 * Two jobs, both of which the binding cannot be trusted to do for us:
 *
 *   1. Decide whether a wgpu-native library is present at all (so "no library" is distinguishable
 *      from "the binding is broken").
 *   2. Ask whether a symbol is exported, **without calling it** — which is the only safe way to
 *      inspect the abort-on-call blocklist, since calling any of those kills the process.
 *
 * `dlopen` is the portability trick for (2). Declaring a symbol that does not exist throws
 * `Symbol "…" not found in "…"`; declaring one that does exist succeeds. Because we never *invoke*
 * the resulting function, the declared signature is irrelevant — `() => void` is fine for every
 * symbol regardless of its real prototype. The alternative, parsing PE / ELF / Mach-O export tables,
 * would mean three format readers to cover four platforms.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";

import { tryResolveNativeLibrary } from "../../src/resolve.ts";
import type { IResolvedNativeLibrary } from "../../src/types.ts";

/** The installed library for this host, or `null` if nothing is installed. */
export function nativeLibrary(): IResolvedNativeLibrary | null {
  return tryResolveNativeLibrary();
}

/** Raw bytes of the installed library. */
export function nativeLibraryBytes(lib: IResolvedNativeLibrary): Uint8Array {
  return new Uint8Array(fs.readFileSync(lib.path));
}

/**
 * Is `symbol` exported by `libPath`?
 *
 * Never calls it. See the module header for why an arbitrary signature is safe here.
 */
export function exportsSymbol(libPath: string, symbol: string): boolean {
  try {
    dlopen(libPath, { [symbol]: { args: [], returns: FFIType.void } });
    return true;
  } catch (err) {
    const message = (err as Error).message ?? "";
    // Distinguish "this symbol is absent" from "the library would not load at all". The latter is
    // a real failure and must not be silently reported as a missing symbol.
    if (/not found/i.test(message)) return false;
    throw err;
  }
}

/**
 * Explains why the native library is unavailable, in a form a human can act on.
 *
 * Deliberately verbose: a test that fails because nothing was installed should say so in one screen
 * rather than sending someone to read the resolver.
 */
export function missingLibraryMessage(): string {
  return [
    "No wgpu-native library is installed for this host.",
    "",
    "  Install one of:",
    "    bun run fetch                    # download + verify the pinned upstream release",
    "    bun add @wgpu-bun/<platform>     # the per-platform npm package, once published",
    "",
    `  Or point WGPU_NATIVE_LIB at a wgpu-native ${process.platform} shared library you built.`,
    "",
    "  These tests inspect the real binary. They cannot be made to pass without it, and a version",
    "  of them that could would not be testing anything.",
  ].join("\n");
}
