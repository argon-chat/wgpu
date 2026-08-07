/**
 * The guarantee that there is no third site.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 *
 * The same defect has now been found twice, at two different sites, and both times it was silent.
 *
 * Every wgpu-native callback receives its `message` as a `WGPUStringView` — a 16-byte aggregate
 * passed **by value**. Declaring that parameter as a single `FFIType.ptr` is correct on Win64 and
 * wrong on AArch64 and SysV x86-64, where it arrives in **two registers** and every parameter after
 * it shifts by one. The correlation identifier then arrives as half of the message, and the
 * lookup that uses it — `pending.get(ticket)`, `devices.get(id)` — finds nothing and returns.
 *
 * That "returns" is not a bug. It is a deliberate safety property: a callback arriving after
 * teardown must be harmless. But it means **the safety property and the ABI defect are
 * indistinguishable from inside**, which is why neither occurrence produced an error, a crash, or a
 * log line. The first presented as a hang in `requestAdapter` on three platforms at once; the second
 * as an uncaptured-error test observing zero events.
 *
 * A sweep found each one. A sweep is not a guarantee, so this file replaces it with three checked
 * properties:
 *
 *   1. **The set of hazardous callbacks is derived from the pinned header**, not from a list anyone
 *      maintains. Every `typedef void (*WGPU…Callback)` whose parameters include a by-value
 *      `WGPUStringView` must either have a slot in the seam or appear in {@link EXEMPT} with a
 *      reason. An upstream release that adds one fails here.
 *   2. **There is exactly one module in `src/` that constructs a `JSCallback`.** Declaring an
 *      argument shape *is* answering the ABI question, so the answer is confined to the one module
 *      that knows which seam path is bound. A new construction site anywhere else fails here.
 *   3. **Every argument shape is a named constant**, and every named shape is used. An inline
 *      `[u32, ptr, ptr, u64, u64]` at a construction site is exactly what both defects looked like;
 *      forcing a name forces someone to write down which side of the question it falls on.
 *
 * ── The thing worth remembering, since it fooled two readers ───────────────────────────────────
 *
 * **Two different aggregates in this API have two different rules that partition the platforms
 * differently.** A 40-byte `*CallbackInfo` argument is passed by hidden reference on Win64 and
 * AArch64 and on the stack under SysV, so SysV is the outlier. A 16-byte `WGPUStringView` is passed
 * by hidden reference on Win64 and in two registers on both AArch64 and SysV, so **Win64** is the
 * outlier.
 *
 * The practical consequence: **the set of failing platforms will not match the ABI grouping anyone
 * expects.** Three platforms failing identically looked like evidence *against* an ABI cause, twice,
 * because the failing set matched neither documented group. It was an ABI cause both times — it
 * belonged to the other aggregate. When a failure set does not match your model's partitions, the
 * model has the wrong partitions.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CALLBACK_SLOTS } from "../src/ffi/abiSeam.ts";
import { tryResolveNativeLibrary } from "../src/index.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PKG_ROOT, "src");

/** The one module allowed to declare a C callback signature. */
const CALLBACK_MODULE = "ffi/async.ts";

/**
 * Callbacks that take a by-value `WGPUStringView` and are deliberately **not** bound.
 *
 * Each needs a reason, and the reason has to be structural rather than "we did not get to it" —
 * otherwise this map is just the sweep again, written down.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // Their entry points (`wgpuDeviceCreateComputePipelineAsync` / `…RenderPipelineAsync`) are
  // `unimplemented!()` in wgpu-native and abort the process when called. They are on the blocklist,
  // so no code path can install these callbacks in the first place.
  WGPUCreateComputePipelineAsyncCallback: "wgpuDeviceCreateComputePipelineAsync aborts; blocklisted",
  WGPUCreateRenderPipelineAsyncCallback: "wgpuDeviceCreateRenderPipelineAsync aborts; blocklisted",
};

/** `WGPU<Name>Callback` → the seam slot that binds it. */
const TYPEDEF_TO_SLOT: Readonly<Record<string, keyof typeof CALLBACK_SLOTS>> = {
  WGPURequestAdapterCallback: "requestAdapter",
  WGPURequestDeviceCallback: "requestDevice",
  WGPUBufferMapCallback: "bufferMap",
  WGPUPopErrorScopeCallback: "popErrorScope",
  WGPUQueueWorkDoneCallback: "queueWorkDone",
  WGPUUncapturedErrorCallback: "uncapturedError",
  WGPUDeviceLostCallback: "deviceLost",
};

/** Strip `//` and block comments, so prose about `new JSCallback` is not mistaken for one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const lib = tryResolveNativeLibrary();
const headerPath = lib?.includeDir ? path.join(lib.includeDir, "webgpu.h") : null;
const header = headerPath && fs.existsSync(headerPath) ? fs.readFileSync(headerPath, "utf-8") : null;

if (!header) {
  console.error(
    "wgpu-bun: header-derived callback checks SKIPPED — no webgpu.h beside the installed library.\n" +
      "  Run `bun run fetch`. The in-source checks below still run.",
  );
}

describe("the hazardous-callback set comes from the header, not from a list", () => {
  test.skipIf(header === null)("every by-value StringView callback is bound or explicitly exempt", () => {
    // The complete population, read out of the pinned header. This is what makes "there is no third
    // site" a derived fact: a wgpu-native release that adds a callback taking a by-value
    // `WGPUStringView` fails right here, before it can be missed by a person reading a diff.
    const found = new Map<string, string>();
    for (const m of header!.matchAll(/typedef void \(\*(WGPU[A-Za-z]+Callback)\)\(([^;]*?)\)\s*WGPU_FUNCTION_ATTRIBUTE;/g)) {
      const [, name, params] = m;
      // By value, not `WGPUStringView const *` — the pointer form is not the hazard.
      if (/\bWGPUStringView\s+\w/.test(params!)) found.set(name!, params!.trim());
    }

    // Sanity: if this ever drops to zero the regex has stopped matching and the test would pass
    // vacuously, which is the failure mode this whole package exists to refuse.
    expect(found.size).toBeGreaterThanOrEqual(9);

    const unaccounted = [...found.keys()].filter((n) => !(n in TYPEDEF_TO_SLOT) && !(n in EXEMPT));
    expect(
      unaccounted,
      "these callbacks take a by-value WGPUStringView and are neither bound to a seam slot nor " +
        "listed in EXEMPT. Each needs a decision: a trampoline slot, or a documented reason it can " +
        "never be installed.",
    ).toEqual([]);
  });

  test.skipIf(header === null)("every slot the seam declares corresponds to a real header callback", () => {
    // The other direction: a slot for a callback that no longer exists is dead plumbing, and it
    // would keep the count checks passing while binding nothing.
    for (const [typedef, slot] of Object.entries(TYPEDEF_TO_SLOT)) {
      expect(header, `${typedef} is not declared in the pinned header`).toContain(`(*${typedef})(`);
      expect(CALLBACK_SLOTS[slot], `no slot named "${slot}"`).toBeTypeOf("number");
    }
    expect(Object.keys(TYPEDEF_TO_SLOT).length).toBe(Object.keys(CALLBACK_SLOTS).length);
  });

  test.skipIf(header === null)("the one callback WITHOUT a by-value StringView is not treated as hazardous", () => {
    // `WGPUCompilationInfoCallback` takes a `WGPUCompilationInfo const *`. It is the control case:
    // if it ever showed up as hazardous, the detection above is matching on the wrong thing.
    const m = /typedef void \(\*WGPUCompilationInfoCallback\)\(([^;]*?)\)\s*WGPU_FUNCTION_ATTRIBUTE;/.exec(header!);
    expect(m).toBeTruthy();
    expect(/\bWGPUStringView\s+\w/.test(m![1]!)).toBe(false);
    expect("WGPUCompilationInfoCallback" in TYPEDEF_TO_SLOT).toBe(false);
  });
});

describe("declaring a C callback signature happens in exactly one module", () => {
  const files = sourceFiles(SRC);

  test("no module outside the callback module constructs a JSCallback", () => {
    // Comments are stripped first: `src/api/device.ts` *talks* about `new JSCallback` in the comment
    // explaining why it no longer contains one, and a grep-shaped guard would be fooled by exactly
    // the documentation written to prevent the recurrence.
    const offenders = files
      .filter((f) => path.relative(SRC, f).split(path.sep).join("/") !== CALLBACK_MODULE)
      .filter((f) => /new\s+JSCallback\s*\(/.test(stripComments(fs.readFileSync(f, "utf-8"))))
      .map((f) => path.relative(PKG_ROOT, f).split(path.sep).join("/"));

    expect(
      offenders,
      `only src/${CALLBACK_MODULE} may construct a JSCallback. Choosing an argument shape IS ` +
        "answering an ABI question, and it has been answered wrongly twice at sites a sweep did not " +
        "cover. If this module needs a native callback, register a handler instead.",
    ).toEqual([]);
  });

  test("the callback module builds both shapes for every slot and nothing else", () => {
    const source = stripComments(fs.readFileSync(path.join(SRC, CALLBACK_MODULE), "utf-8"));
    const constructions = [...source.matchAll(/new\s+JSCallback\s*\(/g)].length;
    // One flat form and one pointer form per slot. A slot with only one is a slot that will do the
    // wrong thing on whichever seam path was forgotten.
    expect(constructions).toBe(Object.keys(CALLBACK_SLOTS).length * 2);
  });

  test("every argument shape is a named constant, never an inline literal", () => {
    const source = stripComments(fs.readFileSync(path.join(SRC, CALLBACK_MODULE), "utf-8"));
    const inline = [...source.matchAll(/\{\s*args:\s*\[/g)].length;
    expect(
      inline,
      "an inline argument list at a JSCallback construction site is what both ABI defects looked " +
        "like. Name the shape, so the choice is visible where the shapes are compared.",
    ).toBe(0);

    // …and every named shape is actually used, so a stale one cannot sit there looking authoritative.
    const declared = [...source.matchAll(/const (FLAT_ARGS_\w+|PTR_ARGS_\w+) =/g)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      const uses = [...source.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
      expect(uses, `${name} is declared but never used`).toBeGreaterThan(1);
    }
  });

  test("both shapes cover the same slots, in both directions", () => {
    const source = stripComments(fs.readFileSync(path.join(SRC, CALLBACK_MODULE), "utf-8"));
    const slotsIn = (table: string): string[] => {
      const start = source.indexOf(`const ${table}:`);
      expect(start, `${table} not found`).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf("\n};", start));
      return [...body.matchAll(/^ {2}(\w+): \(\) =>$/gm)].map((m) => m[1]!);
    };
    const expected = Object.keys(CALLBACK_SLOTS).sort();
    expect(slotsIn("FLAT_FORM").sort()).toEqual(expected);
    expect(slotsIn("POINTER_FORM").sort()).toEqual(expected);
  });
});
