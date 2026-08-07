#!/usr/bin/env bun
/**
 * Derive the C-ABI struct declarations in `src/layouts/generated/` from the vendored headers.
 *
 * Run:
 *   bun run scripts/gen-layouts.ts            # write
 *   bun run scripts/gen-layouts.ts --check    # fail if the committed output is stale
 *
 * The headers arrive with the pinned wgpu-native release (`bun run fetch`). This script reads them,
 * resolves every typedef chain down to a C-ABI type tag, and emits a declarative member table — no
 * offsets, no sizes, nothing numeric at all. Offsets are computed from that table at import time by
 * `src/layouts/cabi.ts`, and checked against a real C compiler by `test/layout-oracle.test.ts`.
 *
 * ── Why generate, rather than hand-write a table ────────────────────────────────────────────────
 *
 * There are 114 aggregates across the two headers. A hand-maintained table is not wrong on day one;
 * it is wrong on the day someone bumps the pin and a member is inserted in the middle of
 * `WGPULimits`. Generating means the table cannot disagree with the header it was generated from,
 * and committing the output means consumers still need no toolchain.
 *
 * ── The loud-failure rule ───────────────────────────────────────────────────────────────────────
 *
 * Every unrecognised type spelling is a hard error. Not a `ptr` guess, not a skipped member, not a
 * "probably 4 bytes". A new type in the header must be a build failure, because the alternative — a
 * plausible default — produces a layout that is subtly wrong everywhere after it, and the symptom
 * surfaces as corrupted GPU state rather than as an error.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(PKG_ROOT, "src", "layouts", "generated");

/* ── Header discovery ──────────────────────────────────────────────────────────────────────────── */

interface IHeaderSource {
  readonly file: string;
  readonly text: string;
  readonly sha256: string;
}

/**
 * Find a vendored `include/` directory.
 *
 * Any RID's headers will do: they are byte-identical copies of the same upstream `ffi/` sources, and
 * the layouts derived from them are identical across every 64-bit target (see `cabi.ts`). The RID
 * actually used is recorded in the provenance file so that claim stays checkable rather than
 * assumed.
 */
function locateIncludeDir(): { rid: string; dir: string } {
  const override = process.env["WGPU_NATIVE_INCLUDE"];
  if (override) return { rid: "env:WGPU_NATIVE_INCLUDE", dir: override };

  const vendor = path.join(PKG_ROOT, "vendor");
  const rids = fs.existsSync(vendor) ? fs.readdirSync(vendor).sort() : [];
  for (const rid of rids) {
    const dir = path.join(vendor, rid, "include");
    if (fs.existsSync(path.join(dir, "webgpu.h"))) return { rid, dir };
  }
  throw new Error(
    "No vendored headers found.\n" +
      "  Run:  bun run fetch\n" +
      "  Or point WGPU_NATIVE_INCLUDE at a directory holding webgpu.h and wgpu.h.",
  );
}

function readHeader(dir: string, file: string): IHeaderSource {
  const buf = fs.readFileSync(path.join(dir, file));
  return {
    file,
    text: buf.toString("utf-8"),
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

/* ── Lexical cleanup ───────────────────────────────────────────────────────────────────────────── */

/**
 * Remove C comments while respecting string and character literals.
 *
 * A regex would be shorter and would also delete the `//` out of a URL inside a `#define`. Neither
 * header contains one today; a scanner means neither header has to keep not containing one.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += " ";
    } else if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i + 2);
      i = end === -1 ? src.length : end;
    } else if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/* ── Aggregate extraction ──────────────────────────────────────────────────────────────────────── */

interface IRawMember {
  readonly name: string;
  /** Everything before the member name, with qualifiers stripped. */
  readonly spelling: string;
  readonly pointer: boolean;
  /** Set when the member is an inline anonymous union; names the synthesised aggregate. */
  readonly inlineAggregate: string | null;
}

interface IRawAggregate {
  readonly name: string;
  readonly kind: "struct" | "union";
  readonly members: readonly IRawMember[];
}

/** Index of the `}` matching the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i;
  }
  throw new Error(`Unbalanced brace starting at offset ${open}.`);
}

/**
 * Split an aggregate body into member declarations, lifting inline anonymous unions out as their own
 * aggregates named `Parent::member`.
 *
 * `webgpu.h` has none; `wgpu.h` has exactly one (`WGPUNativeDisplayHandle.data`). Handling it
 * structurally rather than special-casing that name means the next one costs nothing.
 */
function parseMembers(parent: string, body: string, out: IRawAggregate[]): IRawMember[] {
  const members: IRawMember[] = [];

  /** Append the ordinary `;`-separated declarations in a run of plain text. */
  const pushPlain = (text: string): void => {
    for (const raw of text.split(";")) {
      const decl = raw.replace(/\bWGPU_NULLABLE\b/g, " ").replace(/\s+/g, " ").trim();
      if (!decl) continue;
      const m = /^(.*?)([A-Za-z_]\w*)$/.exec(decl);
      if (!m) throw new Error(`${parent}: cannot parse member declaration "${decl}".`);
      const spelling = m[1]!
        .replace(/\*/g, " ")
        .replace(/\b(const|volatile|struct|enum|union)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      members.push({ name: m[2]!, spelling, pointer: decl.includes("*"), inlineAggregate: null });
    }
  };

  let i = 0;
  for (;;) {
    const nested = /\b(union|struct)\s*\{/.exec(body.slice(i));
    if (!nested) {
      pushPlain(body.slice(i));
      break;
    }
    pushPlain(body.slice(i, i + nested.index));

    const open = i + nested.index + nested[0].length - 1;
    const close = matchBrace(body, open);
    const named = /^\s*(\w+)\s*;/.exec(body.slice(close + 1));
    if (!named) {
      throw new Error(
        `${parent}: an inline ${nested[1]} has no member name. A fully anonymous member has no ` +
          `accessor name to expose, so it is refused rather than flattened.`,
      );
    }
    const memberName = named[1]!;
    const synthetic = `${parent}::${memberName}`;
    out.push({
      name: synthetic,
      kind: nested[1] === "union" ? "union" : "struct",
      members: parseMembers(synthetic, body.slice(open + 1, close), out),
    });
    members.push({ name: memberName, spelling: synthetic, pointer: false, inlineAggregate: synthetic });
    i = close + 1 + named[0].length;
  }

  return members;
}

/** Every `typedef struct <tag>? { … } <Name>;` in a header, plus any inline aggregates they hold. */
function extractAggregates(src: string): IRawAggregate[] {
  const out: IRawAggregate[] = [];
  const re = /\btypedef\s+struct\s*(\w+)?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = re.lastIndex - 1;
    const close = matchBrace(src, open);
    const tail = /^\s*(\w+)/.exec(src.slice(close + 1));
    if (!tail) throw new Error(`typedef struct at offset ${m.index} has no typedef name.`);
    const name = tail[1]!;
    const members = parseMembers(name, src.slice(open + 1, close), out);
    out.push({ name, kind: "struct", members });
    re.lastIndex = close + 1;
  }
  return out;
}

/* ── Type resolution ───────────────────────────────────────────────────────────────────────────── */

/** Fixed-width and built-in C spellings this header vocabulary uses. */
const PRIMITIVES: Readonly<Record<string, string>> = {
  int8_t: "i8",
  uint8_t: "u8",
  int16_t: "i16",
  uint16_t: "u16",
  int32_t: "i32",
  uint32_t: "u32",
  int64_t: "i64",
  uint64_t: "u64",
  size_t: "usize",
  uintptr_t: "usize",
  intptr_t: "usize",
  float: "f32",
  double: "f64",
  int: "i32",
  "unsigned int": "u32",
  char: "i8",
  "signed char": "i8",
  "unsigned char": "u8",
};

class TypeResolver {
  readonly enums = new Set<string>();
  readonly handles = new Set<string>();
  readonly callbacks = new Set<string>();
  readonly aggregates = new Set<string>();
  readonly aliases = new Map<string, string>();

  /** Learn every typedef in a header. Called for both before any member is resolved. */
  scan(src: string): void {
    for (const m of src.matchAll(/\btypedef\s+enum\s*\w*\s*\{[^}]*\}\s*(\w+)/g)) {
      this.enums.add(m[1]!);
    }
    for (const m of src.matchAll(/\btypedef\s+struct\s+\w+\s*\*\s*(\w+)/g)) {
      this.handles.add(m[1]!);
    }
    for (const m of src.matchAll(/\btypedef\s+[\w\s*]+?\(\s*\*\s*(\w+)\s*\)\s*\(/g)) {
      this.callbacks.add(m[1]!);
    }
    for (const m of src.matchAll(/\btypedef\s+([A-Za-z_][\w]*(?:\s+[A-Za-z_][\w]*)*)\s+(\w+)\s*;/g)) {
      const from = m[1]!.trim();
      const to = m[2]!;
      if (from.startsWith("struct") || from.startsWith("enum") || from.startsWith("union")) continue;
      if (!this.aliases.has(to)) this.aliases.set(to, from);
    }
  }

  /**
   * Map a member to its C-ABI tag.
   *
   * @throws on any spelling this resolver does not recognise — see the loud-failure rule up top.
   */
  resolve(owner: string, member: IRawMember): string {
    if (member.inlineAggregate) return `@${member.inlineAggregate}`;
    if (member.pointer) return "ptr";
    return this.resolveSpelling(member.spelling, `${owner}.${member.name}`);
  }

  private resolveSpelling(spelling: string, where: string, seen: string[] = []): string {
    if (this.aggregates.has(spelling)) return `@${spelling}`;
    if (this.enums.has(spelling)) return "enum32";
    if (this.handles.has(spelling) || this.callbacks.has(spelling)) return "ptr";

    const alias = this.aliases.get(spelling);
    if (alias !== undefined) {
      if (seen.includes(spelling)) {
        throw new Error(`${where}: typedef cycle through "${spelling}".`);
      }
      // Two aliases carry meaning beyond their width, and the accessor API exposes both as their own
      // operation, so they must not collapse into the underlying integer.
      if (spelling === "WGPUFlags") return "flags64";
      if (spelling === "WGPUBool") return "bool32";
      return this.resolveSpelling(alias, where, [...seen, spelling]);
    }

    const prim = PRIMITIVES[spelling];
    if (prim) return prim;

    throw new Error(
      `${where}: unrecognised C type "${spelling}".\n` +
        `  The header has introduced a spelling this generator does not model. Add it to PRIMITIVES\n` +
        `  (with its real size and alignment) rather than letting it default to anything.`,
    );
  }
}

/* ── Emission ──────────────────────────────────────────────────────────────────────────────────── */

const BANNER = (source: string) =>
  `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Derived from ${source} by \`bun run scripts/gen-layouts.ts\`.
 *
 * Contains member names and C-ABI type tags only. Offsets and sizes are computed from this table at
 * import time (\`src/layouts/cabi.ts\`) and verified against a real C compiler in CI
 * (\`test/layout-oracle.test.ts\`), so this file is structurally incapable of carrying a wrong number.
 */
`;

function emitAggregates(constName: string, aggs: readonly IRawAggregate[], resolver: TypeResolver): string {
  const lines: string[] = [`export const ${constName} = {`];
  for (const agg of aggs) {
    const decls = agg.members.map((m) => `"${m.name}:${resolver.resolve(agg.name, m)}"`);
    const key = /^[A-Za-z_]\w*$/.test(agg.name) ? agg.name : JSON.stringify(agg.name);
    const oneLine = `  ${key}: [${decls.join(", ")}],`;
    if (oneLine.length <= 108) {
      lines.push(oneLine);
      continue;
    }
    lines.push(`  ${key}: [`);
    let row = "   ";
    for (const d of decls) {
      if (row.length + d.length + 2 > 106) {
        lines.push(`${row}`);
        row = "   ";
      }
      row += ` ${d},`;
    }
    if (row.trim()) lines.push(row);
    lines.push("  ],");
  }
  lines.push("} as const;", "");
  return lines.join("\n");
}

function emitProvenance(rid: string, headers: readonly IHeaderSource[], counts: Record<string, number>): string {
  const entries = headers
    .map((h) => `  { file: ${JSON.stringify(h.file)}, sha256: ${JSON.stringify(h.sha256)} },`)
    .join("\n");
  return `${BANNER("the vendored wgpu-native headers")}
/** The vendored RID whose headers were read. Layouts are identical across every 64-bit RID. */
export const SOURCE_RID = ${JSON.stringify(rid)};

/**
 * sha256 of each header this table was derived from.
 *
 * The oracle test hashes the headers it compiles and compares them to this. A mismatch means the
 * pinned binary moved without the table being regenerated — which is exactly the silent-offset-shift
 * scenario the whole derivation exists to prevent, so it fails the test rather than being tolerated.
 */
export const HEADER_DIGESTS: readonly { readonly file: string; readonly sha256: string }[] = [
${entries}
];

/** Aggregate counts, per header. A bump that adds or removes structs shows up here in review. */
export const AGGREGATE_COUNTS = ${JSON.stringify(counts, null, 2)} as const;
`;
}

const INDEX_SOURCE = `${BANNER("webgpu.structs.ts + wgpu.structs.ts")}
import { WEBGPU_AGGREGATES } from "./webgpu.structs.ts";
import { WGPU_NATIVE_AGGREGATES } from "./wgpu.structs.ts";
import { UNION_NAMES } from "./unions.ts";

export { WEBGPU_AGGREGATES } from "./webgpu.structs.ts";
export { WGPU_NATIVE_AGGREGATES } from "./wgpu.structs.ts";
export { UNION_NAMES } from "./unions.ts";
export * from "./provenance.ts";

/**
 * Every aggregate from both headers, keyed by its C name.
 *
 * \`wgpu.h\` only adds types; it never redefines one from \`webgpu.h\`, so the merge cannot lose an
 * entry. If upstream ever changes that, the duplicate-key check in \`registry.ts\` catches it.
 */
export const ALL_AGGREGATES = { ...WEBGPU_AGGREGATES, ...WGPU_NATIVE_AGGREGATES };

/** Every C aggregate name this package can lay out. */
export type AggregateName = keyof typeof ALL_AGGREGATES;

/** The member declarations of one aggregate. */
export type MembersOf<N extends AggregateName> = (typeof ALL_AGGREGATES)[N];

/** \`true\` when an aggregate is a C \`union\` (members all at offset 0) rather than a \`struct\`. */
export function isUnion(name: string): boolean {
  return (UNION_NAMES as readonly string[]).includes(name);
}
`;

/* ── Entry point ───────────────────────────────────────────────────────────────────────────────── */

function build(): Map<string, string> {
  const { rid, dir } = locateIncludeDir();
  const webgpu = readHeader(dir, "webgpu.h");
  const wgpu = readHeader(dir, "wgpu.h");

  const webgpuSrc = stripComments(webgpu.text);
  const wgpuSrc = stripComments(wgpu.text);

  const resolver = new TypeResolver();
  resolver.scan(webgpuSrc);
  resolver.scan(wgpuSrc);

  const webgpuAggs = extractAggregates(webgpuSrc);
  const wgpuAggs = extractAggregates(wgpuSrc);
  for (const a of [...webgpuAggs, ...wgpuAggs]) resolver.aggregates.add(a.name);

  const unions = [...webgpuAggs, ...wgpuAggs].filter((a) => a.kind === "union").map((a) => a.name);

  const files = new Map<string, string>();
  files.set(
    "webgpu.structs.ts",
    `${BANNER("webgpu.h (the Khronos webgpu-native header)")}\n${emitAggregates("WEBGPU_AGGREGATES", webgpuAggs, resolver)}`,
  );
  files.set(
    "wgpu.structs.ts",
    `${BANNER("wgpu.h (wgpu-native's own extensions)")}\n${emitAggregates("WGPU_NATIVE_AGGREGATES", wgpuAggs, resolver)}`,
  );
  files.set(
    "unions.ts",
    `${BANNER("both headers")}
/**
 * Aggregates that are C \`union\`s, where every member starts at offset 0.
 *
 * Emitted as a list rather than inferred from the name because "is this a union" changes the layout
 * completely and must not be guessable.
 */
export const UNION_NAMES = ${JSON.stringify(unions)} as const;
`,
  );
  files.set(
    "provenance.ts",
    emitProvenance(rid, [webgpu, wgpu], {
      "webgpu.h": webgpuAggs.length,
      "wgpu.h": wgpuAggs.length,
    }),
  );
  files.set("index.ts", INDEX_SOURCE);
  return files;
}

function main(): void {
  const check = process.argv.includes("--check");
  const files = build();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let stale = 0;
  for (const [name, text] of files) {
    const dest = path.join(OUT_DIR, name);
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf-8") : null;
    if (existing === text) continue;
    if (check) {
      stale += 1;
      console.error(`stale: src/layouts/generated/${name}`);
      continue;
    }
    fs.writeFileSync(dest, text);
    console.log(`wrote src/layouts/generated/${name}`);
  }

  if (check && stale > 0) {
    console.error(
      `\n${stale} generated file(s) differ from the vendored headers.\n` +
        `Run: bun run scripts/gen-layouts.ts`,
    );
    process.exit(1);
  }
  if (check) console.log("generated layouts are up to date with the vendored headers");
}

main();
