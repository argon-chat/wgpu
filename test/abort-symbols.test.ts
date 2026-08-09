/**
 * The abort-on-call blocklist stays unreachable.
 *
 * 40 exported wgpu-native symbols are `unimplemented!()`. Calling one does not throw and cannot be
 * caught — the Rust panic crosses the C ABI non-unwinding and the process dies, taking every
 * remaining suite with it, with no stack and no attribution.
 *
 * They are *exported*, which is what makes them dangerous: `dlopen` finds them, so nothing about
 * writing the binding pushes back. `wgpuBufferReadMappedRange` and `wgpuBufferWriteMappedRange` are
 * the specific trap — they are the modern `webgpu.h` spellings, exactly what a generated binding or
 * a careful reader of the header would pick, and buffer readback is on the hot path of every GPU
 * test that exists. The correct spellings are `wgpuBufferGetMappedRange` and
 * `wgpuBufferGetConstMappedRange`.
 *
 * These tests need no GPU. They read the installed library's export table and the package's own
 * sources, so they run on any machine and in any CI job.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABORT_SYMBOLS,
  ABORT_SYMBOL_NAMES,
  BINARY_NAMED_ABORT_SYMBOLS,
  deriveNamedAbortSymbols,
  REQUIRED_SYMBOLS,
  SOURCE_ONLY_ABORT_SYMBOLS,
} from "./support/abort-symbols.ts";
import { exportsSymbol, missingLibraryMessage, nativeLibraryBytes, wgpuNativeLibrary, wgpuNativeMajor } from "./support/native.ts";
// The generation the *binary* reports, not the one a filename or a manifest claims — the whole
// point of a per-generation partition is that it is checked against what actually loaded.
import { existsInGeneration } from "../src/index.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Pinned to wgpu-native rather than following `WGPU_BUN_IMPL`: this suite asserts wgpu-native's own
// export table and abort partition. Those claims do not stop being true when the process is pointed
// at Dawn — they stop being *about the loaded library*, and a suite that quietly re-aimed would
// report wgpu-native's manifest as wrong on the strength of Dawn's exports.
const lib = wgpuNativeLibrary();

describe("the blocklist itself", () => {
  test("is 40 symbols, 5 derivable from the binary and 35 only from upstream source", () => {
    expect(BINARY_NAMED_ABORT_SYMBOLS).toHaveLength(5);
    expect(SOURCE_ONLY_ABORT_SYMBOLS).toHaveLength(35);
    expect(ABORT_SYMBOLS).toHaveLength(40);
    expect(ABORT_SYMBOL_NAMES.size).toBe(40); // no duplicates across the two halves
  });

  test("names the two trap spellings explicitly", () => {
    // Spelled out rather than left implicit in the 40, because these are the ones a fresh binding
    // reaches for by accident. If a refactor ever thins the list, these must be the last to go.
    expect(ABORT_SYMBOL_NAMES.has("wgpuBufferReadMappedRange")).toBe(true);
    expect(ABORT_SYMBOL_NAMES.has("wgpuBufferWriteMappedRange")).toBe(true);
  });

  test("names the three that shape the package's design", () => {
    // getCompilationInfo cannot be forwarded; device.lost cannot be backed natively; async
    // completion cannot use a timed wait. Each is documented in the README as a consequence.
    expect(ABORT_SYMBOL_NAMES.has("wgpuShaderModuleGetCompilationInfo")).toBe(true);
    expect(ABORT_SYMBOL_NAMES.has("wgpuDeviceGetLostFuture")).toBe(true);
    expect(ABORT_SYMBOL_NAMES.has("wgpuInstanceWaitAny")).toBe(true);
  });

  test("blocklisted and required spellings never overlap", () => {
    const overlap = REQUIRED_SYMBOLS.filter((s) => ABORT_SYMBOL_NAMES.has(s));
    expect(overlap).toEqual([]);
  });
});

describe.skipIf(!lib)("against the installed wgpu-native", () => {
  test("the required spellings are all exported — proving a real wgpu-native is loaded", () => {
    // Runs first on purpose. Without it, every "no blocklisted symbol was reachable" result below
    // would be trivially satisfiable by failing to load anything at all.
    const missing = REQUIRED_SYMBOLS.filter((s) => !exportsSymbol(lib!.path, s));
    expect(missing).toEqual([]);
  });

  test("the binary-derivable half matches a list freshly scanned out of the library", () => {
    // This is the version-bump gate for the 5 named entries: their `unimplemented!("…")` message is
    // compiled into the shared library, so a bump that adds or retires one changes what this scan
    // finds and the assertion fails until someone edits the blocklist deliberately.
    const derived = deriveNamedAbortSymbols(nativeLibraryBytes(lib!));
    expect(derived).toEqual([...BINARY_NAMED_ABORT_SYMBOLS].sort());
  });

  test("every trap the loaded generation has is exported, and every declared absence is absent", () => {
    // If upstream ever *implements* one it stays exported, so this test does not notice — that is
    // what `bun run derive:aborts` is for. What this catches is the opposite and more urgent case:
    // a blocklist entry that no longer exists, which means the list has gone stale and is no longer
    // describing the binary anyone is running.
    //
    // The list is the union across supported generations, so "no longer exists" has two meanings
    // now, and only one of them is a defect. Four symbols were added to `webgpu.h` after v27, and
    // `FIRST_GENERATION` declares them — so this asserts the whole PARTITION rather than weakening
    // to "absences are fine". An undeclared absence still fails; so does a declared absence that
    // turns out to be present, which is how a wrong `FIRST_GENERATION` entry gets caught.
    const major = wgpuNativeMajor()!;
    const expectedAbsent = ABORT_SYMBOLS.map((s) => s.name)
      .filter((n) => !existsInGeneration(n, major))
      .sort();
    const actuallyAbsent = ABORT_SYMBOLS.map((s) => s.name)
      .filter((n) => !exportsSymbol(lib!.path, n))
      .sort();
    expect(actuallyAbsent).toEqual(expectedAbsent);
  });
});

describe("the binding never names a blocklisted symbol", () => {
  /** Every `.ts` file under `src/`, which is the only code that may talk to the native library. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  /**
   * Blank out comments, preserving line structure so reported line numbers stay right.
   *
   * Necessary because the *correct* way to write this binding involves naming the blocklisted
   * symbols in prose — "never use `wgpuBufferWriteMappedRange`" is exactly the comment a careful
   * author writes next to the working spelling. A scan that flagged that would punish the
   * documentation and get switched off. What matters is whether a name reaches the FFI layer, and
   * an FFI symbol is always a *string* or an object key in real code, never a word in a sentence.
   */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  }

  /**
   * The one file allowed to name all 40: the binding's own blocklist declaration.
   *
   * Excluding it by path would be a hole. Instead it is excluded from the *scan* and subjected to a
   * stronger check below — its list must equal this one, symbol for symbol.
   */
  const DECLARATION_FILE = path.join("src", "ffi", "unimplemented.ts");

  test("no blocklisted symbol is declared as an FFI table entry in src/", () => {
    // The static half. It matches the *object-key* form — `wgpuFoo: { args, returns }` or
    // `"wgpuFoo": …` — because that is the shape of every `dlopen` symbol table, and it is the exact
    // shape a careless paste produces. A blocklisted name appearing as a plain array element is
    // left alone: listing one as data (this package's own blocklist does, and so does the by-value
    // callback-info catalogue) is documentation, not a call.
    //
    // The dynamic check below is what covers the cases a regex cannot see.
    const offences: string[] = [];
    for (const file of sourceFiles(path.join(PKG_ROOT, "src"))) {
      const rel = path.relative(PKG_ROOT, file);
      if (rel === DECLARATION_FILE) continue;
      const text = stripComments(fs.readFileSync(file, "utf-8"));
      for (const m of text.matchAll(/["']?(wgpu[A-Z][A-Za-z0-9_]*)["']?\s*:/g)) {
        const name = m[1]!;
        if (!ABORT_SYMBOL_NAMES.has(name)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offences.push(`${rel}:${line}  ${name}`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("no exported symbol table anywhere in src/ffi has a blocklisted key", async () => {
    // The dynamic half, and the one that is actually exact: import every FFI module and inspect the
    // objects it exports. Anything whose keys are `wgpu*` names is a symbol table by definition,
    // wherever it lives and however it was built — including tables assembled at runtime, which no
    // amount of regex would see.
    const offences: string[] = [];
    const ffiDir = path.join(PKG_ROOT, "src", "ffi");
    if (!fs.existsSync(ffiDir)) return;

    for (const file of sourceFiles(ffiDir)) {
      let mod: Record<string, unknown>;
      try {
        mod = (await import(file)) as Record<string, unknown>;
      } catch {
        continue; // a module that needs the native library to import is covered by the GPU suites
      }
      for (const [exportName, value] of Object.entries(mod)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const keys = Object.keys(value as object);
        if (!keys.some((k) => /^wgpu[A-Z]/.test(k))) continue; // not a symbol table
        for (const key of keys) {
          if (ABORT_SYMBOL_NAMES.has(key)) {
            offences.push(`${path.relative(PKG_ROOT, file)} → ${exportName}.${key}`);
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });

  test("the binding's own blocklist agrees with this one, symbol for symbol", async () => {
    // Two independent derivations. This suite's list comes from upstream's Rust source at the
    // pinned tag; the binding derives its own by *calling* every exported symbol in an isolated
    // subprocess and watching for the panic banner. They share no input and no method, so agreement
    // at 40 is real corroboration rather than one list quoting the other.
    //
    // Absence is tolerated (the binding is free to organise itself differently); disagreement is not.
    let declared: readonly string[] | null = null;
    try {
      const mod = (await import("../src/ffi/unimplemented.ts")) as { UNIMPLEMENTED?: readonly string[] };
      declared = mod.UNIMPLEMENTED ?? null;
    } catch {
      declared = null;
    }
    if (!declared) return;

    expect([...declared].sort()).toEqual(ABORT_SYMBOLS.map((s) => s.name).sort());
  });
});

describe.skipIf(Boolean(lib))("without an installed library", () => {
  test("says how to install one", () => {
    // Not an assertion about wgpu — an assertion that the suite explains itself. The tests above
    // skipped; this makes the reason visible in the report instead of leaving a silent gap.
    expect(missingLibraryMessage()).toContain("bun run fetch");
  });
});
