/**
 * Which file in an extracted Dawn release is *the* C API header, and what it declares.
 *
 * ── Why this is a module with a test and not a `find` call ──────────────────────────────────────
 *
 * Dawn's release archive contains **three** files named `webgpu.h`, and only one of them declares
 * the API (measured on `v20260807.193620`):
 *
 * | path                              | `WGPU_EXPORT` declarations | size   |
 * |-----------------------------------|----------------------------|--------|
 * | `include/dawn/webgpu.h`           | 277                        | 262 KB |
 * | `include/dawn/wire/client/webgpu.h` | 0                        |  44 KB |
 * | `include/webgpu/webgpu.h`         | 0                          | 1.6 KB |
 *
 * A "first match by basename" probe therefore returns whichever one the directory walk reaches
 * first — and directory order is a filesystem property, not a contract. NTFS handed back
 * `include/dawn/…` and the Windows leg linked 277 exports; APFS handed back a different one and the
 * darwin leg wrote an **empty** export list, which `ld` obeys silently, because exporting nothing is
 * a legal instruction rather than an error. The result linked, produced a real dylib, and exported
 * nothing at all.
 *
 * ⚠ This is the second instance of the same class in this repository — `vendoredHeaders.ts` exists
 * because the layout generator picked the alphabetically-first vendored RID. **When more than one
 * file can answer a question, the answer must come from a rule about content, not from the order the
 * filesystem happens to return.** Both are now content- or host-driven, and both fail loudly when
 * the tree is not the shape they assume.
 *
 * @see test/dawn-headers.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Every file under `dir`, recursively. */
export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every file in the tree whose basename is one of `names`, in `names` order. */
export function findAllByBasename(root: string, names: readonly string[]): string[] {
  const all = walk(root);
  return names.flatMap((name) => all.filter((p) => path.basename(p) === name));
}

/**
 * The C API, read out of a header.
 *
 * Only `WGPU_EXPORT`-declared functions count. A looser scan (`/wgpu[A-Za-z]+\(/`) also picks up the
 * header's own macros — `wgpu_ENUM_ZERO_INIT`, `wgpu_MAKE_INIT_STRUCT` — which are not symbols, and
 * a link against names that never existed fails on every one of them.
 */
export function exportedFunctions(headerPath: string): string[] {
  const text = fs.readFileSync(headerPath, "utf-8");
  const names = new Set<string>();
  for (const m of text.matchAll(/^WGPU_EXPORT\s+[^(;]*?\b(wgpu[A-Za-z0-9_]+)\s*\(/gm)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

/**
 * The API surface is nowhere near this small, and a header that declares less than this is not the
 * one being looked for. The real count is 277; the two decoys declare zero.
 */
const MINIMUM_DECLARATIONS = 200;

export interface IApiHeader {
  /** Absolute path of the header that actually declares the API. */
  readonly path: string;
  /** Its `WGPU_EXPORT` function names, sorted. */
  readonly names: string[];
  /** Every candidate considered, with its declaration count — for the failure message. */
  readonly candidates: readonly { readonly path: string; readonly count: number }[];
}

/**
 * Pick the API header by what it declares, and refuse to guess.
 *
 * Content, not position: the candidate with the most `WGPU_EXPORT` declarations wins, and if even
 * the best one is implausibly small the whole thing is an error rather than a smaller export list.
 * That last part is the half that was missing — the Windows path had a `< 200` guard and the macOS
 * path did not, so the empty list sailed through on exactly one platform.
 */
export function findApiHeader(root: string): IApiHeader | { readonly error: string } {
  const paths = findAllByBasename(root, ["webgpu.h"]);
  if (paths.length === 0) return { error: `no webgpu.h anywhere under ${root}` };

  const candidates = paths
    .map((p) => ({ path: p, count: exportedFunctions(p).length }))
    .sort((a, b) => b.count - a.count);
  const best = candidates[0]!;

  if (best.count < MINIMUM_DECLARATIONS) {
    return {
      error:
        `no webgpu.h under ${root} declares the C API ` +
        `(best candidate has ${best.count} WGPU_EXPORT declarations, expected ≥ ${MINIMUM_DECLARATIONS}).\n` +
        `       Considered:\n` +
        candidates.map((c) => `         ${c.count.toString().padStart(4)}  ${path.relative(root, c.path)}`).join("\n"),
    };
  }

  return { path: best.path, names: exportedFunctions(best.path), candidates };
}
