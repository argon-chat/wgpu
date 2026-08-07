/**
 * The layout oracle: every derived offset, checked against a real C compiler.
 *
 * `src/layouts/` derives C struct layouts from a generated member table by applying the C alignment
 * rules. That derivation is a *model* of the ABI, and a model that is never checked is just a
 * confident guess. This test compiles the same pinned `webgpu.h` + `wgpu.h` with Bun's built-in
 * TinyCC and compares the compiler's own `sizeof` / `_Alignof` / `offsetof` against every value the
 * model produces — all 115 aggregates and all of their members, not a sample.
 *
 * What that buys, concretely: bumping the pinned wgpu-native release becomes a **failing test that
 * names the struct**, instead of a field quietly shifting by 4 bytes and surfacing months later as
 * "the renderer is subtly wrong on one platform".
 *
 * ── Why the compiler is not simply used at runtime ──────────────────────────────────────────────
 *
 * Because shipping a C compiler in a binding's import path is a dependency consumers did not ask
 * for, on a Bun subsystem documented as experimental. `cc()` is imported in exactly one file — this
 * one, under `test/` — and {@link "no runtime code imports cc()"} below asserts it stays that way.
 * The runtime path reads the committed tables and nothing else.
 *
 * ── Two obstacles this had to defeat, recorded so the next person does not rediscover them ──────
 *
 *  1. **Bun stages no system headers on Windows.** `#include <stdint.h>` fails outright. The headers
 *     need only the fixed-width integer typedefs plus `INFINITY`/`NAN`, so a tiny shim is written to
 *     a temp directory and put on the include path. `<stddef.h>` (for `offsetof`) *is* staged by Bun
 *     on every platform, so it is used as-is.
 *  2. **`flags` replaces Bun's default flag string, it does not append.** The defaults
 *     (`-std=c11 -Wl,--export-all-symbols -g -O2`) are restated below; dropping
 *     `--export-all-symbols` makes the probe symbol unresolvable at link time.
 *
 * Note that no library is linked: `sizeof` and `offsetof` are compile-time, so this test never loads
 * `wgpu_native` and runs fine on a machine with no GPU.
 */

import { describe, expect, test } from "bun:test";
import { cc, FFIType, ptr } from "bun:ffi";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABI_64,
  ALL_AGGREGATES,
  CStructArray,
  HEADER_DIGESTS,
  LayoutRegistry,
  allocStruct,
  assertHost64Bit,
  registry,
  sizeOf,
  type ICAggregateLayout,
} from "../src/layouts/index.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── 1. Locate the pinned headers ──────────────────────────────────────────────────────────────── */

function locateIncludeDir(): string {
  const override = process.env["WGPU_NATIVE_INCLUDE"];
  if (override) return override;
  const vendor = path.join(PKG_ROOT, "vendor");
  const rids = fs.existsSync(vendor) ? fs.readdirSync(vendor).sort() : [];
  for (const rid of rids) {
    const dir = path.join(vendor, rid, "include");
    if (fs.existsSync(path.join(dir, "webgpu.h"))) return dir;
  }
  throw new Error(
    "The layout oracle needs the vendored headers.\n" +
      "  Run:  bun run fetch\n" +
      "  Or point WGPU_NATIVE_INCLUDE at a directory holding webgpu.h and wgpu.h.\n" +
      "This test deliberately fails rather than skipping: an oracle that quietly does not run is " +
      "indistinguishable from one that passes, which is the exact failure it exists to prevent.",
  );
}

const INCLUDE_DIR = locateIncludeDir();

/* ── 2. The C shim Bun does not provide ────────────────────────────────────────────────────────── */

/**
 * Windows only, and that restriction is load-bearing.
 *
 * The shim exists because Bun stages no system headers on Windows. Everywhere else the platform's
 * real `stdint.h` is present and correct, and putting this one ahead of it does not "also work" — it
 * SHADOWS the real header with definitions that disagree. `intptr_t` here is `long long`; under LP64
 * (Linux, macOS) the system spells it `long`. Same width, different type, so the compiler rejects it
 * outright: `incompatible redefinition of 'intptr_t'`.
 *
 * That is the good outcome. The bad one would have been a shim that redefined a type *compatibly*
 * but differently sized — the probe would compile, report layouts for types the real headers never
 * use, and the oracle would confidently confirm the wrong numbers.
 */
const NEEDS_SHIM = process.platform === "win32";

function writeShim(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgpu-bun-oracle-"));
  if (!NEEDS_SHIM) return dir; // still a home for layout-probe.c, just not on the include path
  fs.writeFileSync(
    path.join(dir, "stdint.h"),
    `#ifndef WGPU_BUN_ORACLE_STDINT_H
#define WGPU_BUN_ORACLE_STDINT_H
typedef signed char        int8_t;
typedef unsigned char      uint8_t;
typedef short              int16_t;
typedef unsigned short     uint16_t;
typedef int                int32_t;
typedef unsigned int       uint32_t;
typedef long long          int64_t;
typedef unsigned long long uint64_t;
typedef long long          intptr_t;
typedef unsigned long long uintptr_t;
#define INT32_C(x)  x
#define INT64_C(x)  x##LL
#define UINT32_C(x) x##U
#define UINT64_C(x) x##ULL
#endif
`,
  );
  fs.writeFileSync(
    path.join(dir, "math.h"),
    `#ifndef WGPU_BUN_ORACLE_MATH_H
#define WGPU_BUN_ORACLE_MATH_H
#define INFINITY (__builtin_inff())
#define NAN      (__builtin_nanf(""))
#endif
`,
  );
  return dir;
}

/* ── 3. Emit a probe that dumps every size, alignment and offset ───────────────────────────────── */

/**
 * How an aggregate is named in C.
 *
 * Most are plain typedef names. An inline anonymous aggregate (`wgpu.h` has one:
 * `WGPUNativeDisplayHandle.data`) has no type name at all, so it is addressed through its parent as
 * an expression — `sizeof(((WGPUNativeDisplayHandle*)0)->data)` — and its members' offsets are taken
 * relative to it.
 */
interface ICProbeTarget {
  readonly root: string;
  /** Member path from the root, `""` for a top-level typedef. */
  readonly path: string;
}

function probeTarget(name: string): ICProbeTarget {
  const parts = name.split("::");
  return { root: parts[0]!, path: parts.slice(1).join(".") };
}

interface ISlot {
  readonly aggregate: string;
  readonly kind: "size" | "align" | "offset" | "member size" | "member align";
  readonly member: string | null;
  readonly derived: number;
}

function emitProbe(layouts: readonly ICAggregateLayout[]): { source: string; slots: ISlot[] } {
  const slots: ISlot[] = [];
  const body: string[] = [];

  for (const layout of layouts) {
    const t = probeTarget(layout.name);
    const isRoot = t.path === "";
    const expr = isRoot ? null : `((${t.root}*)0)->${t.path}`;

    body.push(`  /* ${layout.name} */`);
    body.push(`  *p++ = ${isRoot ? `sizeof(${t.root})` : `sizeof(${expr})`};`);
    slots.push({ aggregate: layout.name, kind: "size", member: null, derived: layout.size });

    body.push(`  *p++ = ${isRoot ? `RP_ALIGN_T(${t.root})` : `RP_ALIGN_X(${expr})`};`);
    slots.push({ aggregate: layout.name, kind: "align", member: null, derived: layout.align });

    for (const f of layout.fields) {
      const full = isRoot ? f.name : `${t.path}.${f.name}`;
      const base = isRoot ? "0" : `offsetof(${t.root}, ${t.path})`;
      const member = `((${t.root}*)0)->${full}`;

      body.push(`  *p++ = offsetof(${t.root}, ${full}) - ${base};`);
      slots.push({ aggregate: layout.name, kind: "offset", member: f.name, derived: f.offset });

      // Offsets alone do NOT pin a member's type: declaring the 64-bit `WGPUBufferUsage` as a
      // `uint32_t` leaves every offset in the struct unchanged (the next member was 8-aligned
      // anyway) while making the binding write 4 bytes where wgpu-native reads 8. Measuring each
      // member's own size and alignment is what closes that hole, and it is two extra slots.
      body.push(`  *p++ = sizeof(${member});`);
      slots.push({ aggregate: layout.name, kind: "member size", member: f.name, derived: f.size });

      body.push(`  *p++ = RP_ALIGN_X(${member});`);
      slots.push({ aggregate: layout.name, kind: "member align", member: f.name, derived: f.align });
    }
  }

  const source = `#include <stddef.h>
#include "webgpu.h"
#include "wgpu.h"

/* Alignment without _Alignof, which TinyCC's support for we do not want to depend on: the padding a
   compiler inserts before a member of type T, after a single char, IS alignof(T). */
#define RP_ALIGN_T(T)    (sizeof(struct { char c_; T m_; }) - sizeof(T))
#define RP_ALIGN_X(EXPR) (sizeof(struct { char c_; __typeof__(EXPR) m_; }) - sizeof(EXPR))

void wgpu_bun_layout_probe(unsigned long long *out) {
  unsigned long long *p = out;
${body.join("\n")}
}
`;
  return { source, slots };
}

/* ── 4. Compile and run, once ──────────────────────────────────────────────────────────────────── */

const layouts = registry.layoutAll();
const { source, slots } = emitProbe(layouts);

const shimDir = writeShim();
const sourcePath = path.join(shimDir, "layout-probe.c");
fs.writeFileSync(sourcePath, source);

// The shim directory goes on the include path only where the shim was actually written. Adding it
// unconditionally is what broke every non-Windows leg: an empty directory would be harmless, but a
// populated one shadows the system headers it was never meant to replace.
const includeDirs = NEEDS_SHIM ? [INCLUDE_DIR, shimDir] : [INCLUDE_DIR];

const { symbols } = cc({
  source: sourcePath,
  include: includeDirs,
  // Bun's defaults, restated, plus our include paths. `flags` REPLACES the default string.
  flags: [
    "-std=c11",
    "-Wl,--export-all-symbols",
    "-g",
    "-O2",
    ...includeDirs.map((d) => `-I${d}`),
  ],
  symbols: {
    wgpu_bun_layout_probe: { args: [FFIType.ptr], returns: FFIType.void },
  },
});

const measured = new BigUint64Array(slots.length);
symbols.wgpu_bun_layout_probe(ptr(measured));

const byAggregate = new Map<string, { slot: ISlot; measured: number }[]>();
slots.forEach((slot, i) => {
  const list = byAggregate.get(slot.aggregate) ?? [];
  list.push({ slot, measured: Number(measured[i]!) });
  byAggregate.set(slot.aggregate, list);
});

/* ── 5. The assertions ─────────────────────────────────────────────────────────────────────────── */

describe("derived C layouts vs. the C compiler", () => {
  test("the headers being compiled are the headers the tables were generated from", () => {
    for (const { file, sha256 } of HEADER_DIGESTS) {
      // LF-normalised, matching how `gen-layouts.ts` computes the digest it stores. Upstream ships
      // the same headers with CRLF in the Windows archive and LF in the others, so a raw-byte hash
      // is a fingerprint of the platform rather than of the header — it would pass on whichever host
      // generated the tables and fail on every other leg of the matrix, for no real difference.
      const text = fs.readFileSync(path.join(INCLUDE_DIR, file)).toString("utf-8").replace(/\r\n/g, "\n");
      const actual = crypto.createHash("sha256").update(text, "utf-8").digest("hex");
      expect(
        actual,
        `${file} has changed since src/layouts/generated/ was produced. ` +
          `Run: bun run scripts/gen-layouts.ts`,
      ).toBe(sha256);
    }
  });

  test("every aggregate in the tables is checked — no sampling", () => {
    const declared = Object.keys(ALL_AGGREGATES).sort();
    const checked = [...byAggregate.keys()].sort();
    expect(checked).toEqual(declared);
    expect(declared.length).toBeGreaterThan(100);
    // Sanity that the probe really produced a value per member, not zeros from an unwritten buffer:
    // size + alignment per aggregate, and offset + size + alignment per member.
    expect(slots.length).toBe(layouts.reduce((n, l) => n + 2 + 3 * l.fields.length, 0));
  });

  for (const layout of layouts) {
    test(`${layout.name} (${layout.kind}, ${layout.fields.length} members)`, () => {
      const rows = byAggregate.get(layout.name)!;
      for (const { slot, measured: c } of rows) {
        const what =
          slot.member === null
            ? `${slot.kind} of ${layout.name}`
            : `${slot.kind} of ${layout.name}.${slot.member}`;
        expect(slot.derived, `${what}: derived ${slot.derived}, C compiler says ${c}`).toBe(c);
      }
    });
  }
});

/* ── 6. Properties the oracle cannot express ───────────────────────────────────────────────────── */

describe("layout engine invariants", () => {
  test("no runtime code imports cc() — the compiler is a CI tool, never a dependency", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf-8");
          for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']bun:ffi["']/g)) {
            if (/(^|[\s,])cc([\s,]|$)/.test(m[1]!)) offenders.push(path.relative(PKG_ROOT, full));
          }
        }
      }
    };
    walk(path.join(PKG_ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  test("a 32-bit host is refused rather than silently laid out at half width", () => {
    expect(() => assertHost64Bit("ia32")).toThrow(/64-bit/);
    expect(() => assertHost64Bit("arm")).toThrow(/64-bit/);
    expect(() => assertHost64Bit("x64")).not.toThrow();
    expect(() => assertHost64Bit("arm64")).not.toThrow();
  });

  test("the shipped model is the one the oracle measured", () => {
    // If this ever needs changing, the oracle above must be re-run on the new model — the derived
    // numbers it compares are produced by exactly this model.
    expect(registry.model).toBe(ABI_64);
    expect(ABI_64.pointerSize).toBe(8);
    expect(ABI_64.sizeTSize).toBe(8);
    expect(ABI_64.int64Align).toBe(8);
  });

  test("a hypothetical 32-bit model really does move things — the axis is not cosmetic", () => {
    // Guards against the layout engine ignoring its model. Not a claim about any shipped target:
    // no 32-bit RID is supported. It only proves the model is load-bearing.
    const ilp32 = new LayoutRegistry({
      id: "c-abi-32-hypothetical",
      pointerSize: 4,
      sizeTSize: 4,
      int64Align: 4,
    });
    expect(ilp32.layout("WGPUStringView").size).toBe(8);
    expect(registry.layout("WGPUStringView").size).toBe(16);
  });

  /**
   * The oracle above runs on one host. The claim that its numbers also hold on the other four RIDs
   * rests on the headers containing none of the constructs where the target ABIs disagree. That is
   * checkable here, statically, without a Linux or macOS runner — so it is checked rather than
   * asserted in a comment.
   *
   * The four constructs, and why each one matters:
   *   `long` / `unsigned long` — 4 bytes on Win64 (LLP64), 8 on the Unix targets (LP64).
   *   `long double`           — 8, 10 or 16 bytes depending on target and compiler.
   *   bitfields               — allocation order and straddling rules are implementation-defined.
   *   arrays                  — not a divergence themselves, but this package's tables cannot
   *                             express one, so an added array must not pass silently.
   */
  test("the headers contain nothing whose layout differs across the supported RIDs", () => {
    for (const { file } of HEADER_DIGESTS) {
      const text = fs
        .readFileSync(path.join(INCLUDE_DIR, file), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
      // Struct bodies only: `long long` appears freely in prose and in unrelated declarations.
      for (const m of text.matchAll(/\btypedef\s+struct\s*\w*\s*\{([\s\S]*?)\n\}/g)) {
        const body = m[1]!;
        expect(body, `${file}: a struct member uses 'long', whose width differs on Win64 vs LP64`)
          .not.toMatch(/\blong\b/);
        expect(body, `${file}: a struct member is a bitfield`).not.toMatch(/\w\s*:\s*\d/);
        expect(body, `${file}: a struct member is an array`).not.toMatch(/\[\s*\w*\s*\]/);
      }
    }
  });

  test("nothing aligns more strictly than 8 bytes, on any aggregate", () => {
    // The other half of the invariance argument: x86-64 and AArch64 agree on natural alignment for
    // every type present, and 8 is the widest any of them needs.
    for (const l of layouts) {
      expect(l.align, `${l.name} aligns to ${l.align}`).toBeLessThanOrEqual(8);
      for (const f of l.fields) {
        expect(f.align, `${l.name}.${f.name} aligns to ${f.align}`).toBeLessThanOrEqual(8);
      }
    }
  });

  test("an unknown aggregate or member names itself in the error", () => {
    expect(() => registry.layout("WGPUNotAThing")).toThrow(/WGPUNotAThing/);
    expect(() => allocStruct("WGPUBufferDescriptor").getU64("siz" as never)).toThrow(/siz/);
  });
});

/* ── 7. The accessor API agrees with the layouts it is built on ────────────────────────────────── */

describe("CStructView", () => {
  test("writes land at the derived offsets", () => {
    const d = allocStruct("WGPUBufferDescriptor");
    d.setU64("size", 0x1122334455667788n);
    d.setFlags("usage", 0x11n);
    d.setBool("mappedAtCreation", true);

    const at = (m: "size" | "usage" | "mappedAtCreation") => d.field(m).offset;
    const dv = new DataView(d.buffer);
    expect(dv.getBigUint64(at("size"), true)).toBe(0x1122334455667788n);
    expect(dv.getBigUint64(at("usage"), true)).toBe(0x11n);
    expect(dv.getUint32(at("mappedAtCreation"), true)).toBe(1);
    expect(d.getU64("size")).toBe(0x1122334455667788n);
    expect(d.getBool("mappedAtCreation")).toBe(true);
  });

  test("a nested aggregate is written in place, not into a copy", () => {
    const d = allocStruct("WGPUBufferDescriptor");
    const label = d.sub("label");
    label.setPtr("data", 0xdeadbeef).setUsize("length", 7n);

    expect(label.buffer).toBe(d.buffer);
    expect(label.byteOffset).toBe(d.field("label").offset);
    const dv = new DataView(d.buffer);
    expect(dv.getBigUint64(d.field("label").offset, true)).toBe(0xdeadbeefn);
    expect(dv.getBigUint64(d.field("label").offset + 8, true)).toBe(7n);
  });

  test("using the wrong-width accessor throws instead of corrupting a neighbour", () => {
    const d = allocStruct("WGPUBufferDescriptor");
    // `usage` is a 64-bit WGPUFlags in v29; treating it as u32 would leave the high half stale.
    expect(() => d.setU32("usage" as never, 1)).toThrow(/flags64/);
  });

  test("a size_t sentinel refuses to masquerade as a count", () => {
    const s = allocStruct("WGPUStringView");
    s.setUsize("length", 0xffffffffffffffffn); // WGPU_STRLEN
    expect(s.getUsize("length")).toBe(0xffffffffffffffffn);
    expect(() => s.getCount("length")).toThrow(/sentinel/);
  });

  test("arrays are strided by sizeof, and out-of-range indices throw", () => {
    const arr = new CStructArray("WGPUVertexAttribute", 3);
    expect(arr.stride).toBe(sizeOf("WGPUVertexAttribute"));
    expect(arr.bytes.byteLength).toBe(arr.stride * 3);
    arr.at(2).setU32("shaderLocation", 9);
    const dv = new DataView(arr.buffer);
    expect(dv.getUint32(2 * arr.stride + arr.at(0).field("shaderLocation").offset, true)).toBe(9);
    expect(() => arr.at(3)).toThrow(/out of range/);
    expect([...arr].length).toBe(3);
  });

  test("a union puts every member at offset 0", () => {
    const u = registry.layout("WGPUNativeDisplayHandle::data");
    expect(u.kind).toBe("union");
    for (const f of u.fields) expect(f.offset).toBe(0);
  });
});

/* ── 8. Compile-time pins ──────────────────────────────────────────────────────────────────────
 *
 * These assert nothing at runtime; they fail `bun run typecheck`. They are the half of the
 * "callable without seeing a number" claim that a runtime test cannot reach — a mistyped member
 * name or a mismatched accessor must not compile in the first place.
 */

type ExpectNever<T extends never> = T;
type _MemberNamesAreTyped = ExpectNever<
  Exclude<Parameters<ReturnType<typeof allocStruct<"WGPUStringView">>["setPtr"]>[0], "data">
>;
type _AccessorsAreTypeNarrowed = ExpectNever<
  Exclude<Parameters<ReturnType<typeof allocStruct<"WGPUBufferDescriptor">>["setU64"]>[0], "size">
>;

test("compile-time pins are present", () => {
  // The pins above are erased at runtime; this keeps them from reading as dead code.
  const unused: [_MemberNamesAreTyped?, _AccessorsAreTypeNarrowed?] = [];
  expect(unused).toEqual([]);
});
