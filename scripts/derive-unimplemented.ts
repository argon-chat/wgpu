#!/usr/bin/env bun
/**
 * Derive — by execution — which exported wgpu-native symbols are `unimplemented!()` stubs that
 * **abort the process** when called.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * These stubs are indistinguishable from working functions until you call one: present in the export
 * table, present in `webgpu.h`, typed like their neighbours. The entry points are `extern "C"` and
 * therefore `nounwind`, so the Rust panic cannot unwind and is escalated to `abort` — no return
 * code, no catchable error, no JS stack, and every other suite in the process dies too.
 *
 * The trap is specific: `wgpuBufferReadMappedRange` / `wgpuBufferWriteMappedRange` are the *modern*
 * `webgpu.h` spellings for buffer access, so a binding generated faithfully from the header picks
 * exactly the two that abort and dies on its first pixel readback. The ones that work are the older
 * `wgpuBufferGetMappedRange` / `wgpuBufferGetConstMappedRange`.
 *
 * ── The derivation ──────────────────────────────────────────────────────────────────────────────
 *
 * "The ones we noticed" is not a mechanism, and the export table is precisely what lies. So: **probe
 * every exported symbol, one isolated subprocess each**, with zeroed arguments, and classify by what
 * the child printed on stderr. Sound because `unimplemented!()` is the *first* statement in these
 * bodies — it fires before any argument is touched — and prints the literal Rust panic banner
 * `not implemented`, while a NULL handle passed to a *working* function produces an access violation
 * or a validation complaint, neither containing that string. So:
 *
 *   - child stderr contains "not implemented"  → the symbol is a stub. Certain.
 *   - anything else (clean exit, access violation, timeout, validation error) → not a stub.
 *
 * Signatures are read from the pinned headers that shipped in the same archive as the DLL, so this
 * script has no hand-written knowledge of the API.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────────────────────────
 *
 *   bun run scripts/derive-unimplemented.ts            # sweep, print the list, diff against src/
 *   bun run scripts/derive-unimplemented.ts --json     # sweep, print machine-readable output
 *   bun run scripts/derive-unimplemented.ts --probe X  # internal: call one symbol and exit
 *
 * Run once per wgpu-native pin bump. Deliberately not part of the normal test run: 200+ process
 * spawns is a minute of wall clock, and the answer only changes when the pin does.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { resolveNativeLibrary } from "../src/resolve.ts";
import { UNIMPLEMENTED } from "../src/ffi/unimplemented.ts";

type ArgKind = "ptr" | "u32" | "u64" | "f32" | "f64" | "i32" | "u16";
interface Signature { name: string; args: ArgKind[] }

/** Parse `WGPU_EXPORT` (webgpu.h) and the bare `extern "C"` block (wgpu.h) into FFI signatures. */
function readSignatures(includeDir: string): Signature[] {
  let src = "";
  for (const f of ["webgpu.h", "wgpu.h"]) {
    const p = path.join(includeDir, f);
    if (fs.existsSync(p)) src += "\n" + fs.readFileSync(p, "utf8");
  }
  src = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/WGPU_(STRUCTURE|ENUM|OBJECT|FUNCTION)_ATTRIBUTE/g, "")
    .replace(/\bWGPU_NULLABLE\b/g, "")
    .replace(/\bWGPU_EXPORT\b/g, "");

  const flags = new Set(["WGPUFlags"]);
  for (const m of src.matchAll(/typedef WGPUFlags (\w+)\s*;/g)) flags.add(m[1]!);
  const handles = new Set<string>();
  for (const m of src.matchAll(/typedef struct \w+Impl\s*\*\s*(\w+)\s*;/g)) handles.add(m[1]!);
  const enums = new Set<string>();
  for (const m of src.matchAll(/typedef enum (\w+)\s*\{[\s\S]*?\}\s*\1\s*;/g)) enums.add(m[1]!);
  const structs = new Set<string>();
  for (const m of src.matchAll(/typedef struct (\w+)\s*\{[\s\S]*?\}\s*\1\s*;/g)) structs.add(m[1]!);

  const kindOf = (raw: string): ArgKind | null => {
    const t = raw.replace(/\bconst\b/g, "").replace(/\s+/g, " ").trim();
    if (t.includes("*")) return "ptr";
    if (t === "size_t" || t === "uint64_t" || t === "WGPUSubmissionIndex") return "u64";
    if (t === "uint32_t" || t === "WGPUBool") return "u32";
    if (t === "uint16_t") return "u16";
    if (t === "int32_t") return "i32";
    if (t === "float") return "f32";
    if (t === "double") return "f64";
    if (flags.has(t)) return "u64";
    if (handles.has(t) || enums.has(t) || structs.has(t)) return t === "WGPUFlags" ? "u64" : enums.has(t) ? "u32" : "ptr";
    return null;
  };

  const out: Signature[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/\b([\w]+(?:\s*\*)?)\s+(wgpu\w+)\s*\(([^;{)]*)\)\s*;/g)) {
    const name = m[2]!;
    if (seen.has(name)) continue;
    const params = m[3]!.trim();
    const args: ArgKind[] = [];
    let ok = true;
    if (params && params !== "void") {
      for (const p of params.split(",")) {
        const s = p.trim().replace(/\s+/g, " ");
        const mm = /^(.*?)([A-Za-z_]\w*)$/.exec(s);
        const k = kindOf(mm ? mm[1]! : s);
        if (!k) { ok = false; break; }
        args.push(k);
      }
    }
    if (!ok) continue;
    seen.add(name);
    out.push({ name, args });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function probe(name: string): Promise<never> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const lib = resolveNativeLibrary();
  const sigs = readSignatures(lib.includeDir ?? "");
  const sig = sigs.find((s) => s.name === name);
  if (!sig) { console.error(`no signature for ${name}`); process.exit(3); }
  const map: Record<ArgKind, number> = {
    ptr: FFIType.ptr, u32: FFIType.u32, u64: FFIType.u64,
    f32: FFIType.f32, f64: FFIType.f64, i32: FFIType.i32, u16: FFIType.u16,
  };
  const opened = dlopen(lib.path, {
    [name]: { args: sig.args.map((a) => map[a]), returns: FFIType.u64 },
  });
  // Zeroed arguments. A by-value aggregate reaches the callee by hidden reference on Win64, so a
  // pointer to zeroed memory is the correct shape there; on any ABI it reaches the
  // `unimplemented!()` at the top of the body, which is all this probe needs.
  const scratch = new Uint8Array(256);
  const args = sig.args.map((a) => (a === "ptr" ? ptr(scratch) : a === "u64" ? 0n : 0));
  (opened.symbols as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
  process.exit(0);
}

async function sweep(asJson: boolean): Promise<void> {
  const lib = resolveNativeLibrary();
  if (!lib.includeDir) throw new Error("headers not found next to the library — cannot derive signatures.");
  const sigs = readSignatures(lib.includeDir);
  const self = import.meta.path;
  const stubs: string[] = [];

  process.stderr.write(`probing ${sigs.length} exported symbols, one subprocess each…\n`);
  for (const sig of sigs) {
    const proc = Bun.spawnSync(["bun", "run", self, "--probe", sig.name], {
      stderr: "pipe", stdout: "pipe", timeout: 10_000,
    });
    const err = new TextDecoder().decode(proc.stderr);
    if (/not implemented/.test(err)) {
      stubs.push(sig.name);
      process.stderr.write(`  ABORTS  ${sig.name}\n`);
    }
  }

  const known = new Set(UNIMPLEMENTED);
  const found = new Set(stubs);
  const missing = [...found].filter((s) => !known.has(s));
  const stale = [...known].filter((s) => !found.has(s));

  if (asJson) {
    console.log(JSON.stringify({ wgpuNativeTag: lib.version, count: stubs.length, symbols: stubs }, null, 2));
  } else {
    console.log(`\n// derived by execution against ${lib.path}\n// ${stubs.length} symbols abort when called`);
    for (const s of stubs) console.log(`  "${s}",`);
  }
  if (missing.length) console.error(`\nNOT IN src/ffi/unimplemented.ts (${missing.length}): ${missing.join(", ")}`);
  if (stale.length) console.error(`\nIN src/ffi/unimplemented.ts BUT DID NOT ABORT (${stale.length}): ${stale.join(", ")}`);
  process.exit(missing.length || stale.length ? 1 : 0);
}

const argv = process.argv.slice(2);
const probeIndex = argv.indexOf("--probe");
if (probeIndex >= 0) await probe(argv[probeIndex + 1]!);
else await sweep(argv.includes("--json"));
