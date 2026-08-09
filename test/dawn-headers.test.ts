/**
 * Picking the C API header out of a Dawn release, which contains three files called `webgpu.h`.
 *
 * The rule under test replaced "first match in the directory walk", which is not a rule at all: it
 * returned `include/dawn/webgpu.h` (277 declarations) on NTFS and a 1.6 KB forwarding stub on APFS.
 * The Windows leg linked 277 exports; the darwin leg wrote an empty export list, `ld` obeyed it
 * without a word, and the job produced a real dylib that exported nothing.
 *
 * The fixtures below reproduce that tree, with the decoys placed so that they sort *before* the real
 * header — on a filesystem that walks alphabetically, the old rule fails this suite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { exportedFunctions, findAllByBasename, findApiHeader } from "../scripts/dawnHeaders.ts";

/** A header shaped like the real one: `WGPU_EXPORT` declarations at line start, one per function. */
function apiHeader(count: number): string {
  const lines = ["// Copyright 2026 The Dawn & Tint Authors", "#ifndef WEBGPU_H_", "#define WEBGPU_H_", ""];
  for (let i = 0; i < count; i++) {
    lines.push(`WGPU_EXPORT void wgpuFunctionNumber${i}(WGPUDevice device, size_t size) WGPU_FUNCTION_ATTRIBUTE;`);
  }
  // The macros a looser scan would mistake for symbols. Real header, real trap.
  lines.push("#define WGPU_COMMA ,", "#define wgpu_MAKE_INIT_STRUCT(type, value) value", "#endif");
  return lines.join("\n");
}

/** `include/webgpu/webgpu.h` in the real archive: 1.6 KB, forwards, declares nothing. */
const FORWARDING_STUB = `// Copyright 2022 The Dawn & Tint Authors\n#include "dawn/webgpu.h"\n`;

/** `include/dawn/wire/client/webgpu.h`: real C++ declarations, zero \`WGPU_EXPORT\` functions. */
const WIRE_CLIENT = `#ifndef DAWN_WIRE_CLIENT_WEBGPU_H_\nnamespace dawn::wire::client { class Adapter; }\n#endif\n`;

let root = "";

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-headers-"));
  // Directory names chosen so both decoys sort ahead of the real header: `aaa` and `bbb` before
  // `dawn`. A rule that reads the tree in order gets a decoy; a rule that reads content does not.
  for (const [dir, content] of [
    ["aaa/webgpu", FORWARDING_STUB],
    ["bbb/wire/client", WIRE_CLIENT],
    ["dawn", apiHeader(277)],
  ] as const) {
    fs.mkdirSync(path.join(root, "include", dir), { recursive: true });
    fs.writeFileSync(path.join(root, "include", dir, "webgpu.h"), content);
  }
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "libwebgpu_dawn.a"), "not a real archive");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("finding the Dawn C API header", () => {
  test("all three candidates are in the tree", () => {
    expect(findAllByBasename(root, ["webgpu.h"])).toHaveLength(3);
  });

  test("the one that declares the API wins, whatever the walk order", () => {
    const api = findApiHeader(root);
    expect("error" in api).toBe(false);
    if ("error" in api) return;
    expect(path.basename(path.dirname(api.path))).toBe("dawn");
    expect(api.names).toHaveLength(277);
    expect(api.candidates).toHaveLength(3);
  });

  test("macros are not mistaken for exported functions", () => {
    const api = findApiHeader(root);
    if ("error" in api) throw new Error(api.error);
    expect(api.names.some((n) => n.startsWith("wgpu_"))).toBe(false);
  });

  test("a tree with only decoys is an error naming every candidate", () => {
    const decoysOnly = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-decoys-"));
    try {
      fs.mkdirSync(path.join(decoysOnly, "webgpu"), { recursive: true });
      fs.writeFileSync(path.join(decoysOnly, "webgpu", "webgpu.h"), FORWARDING_STUB);
      const api = findApiHeader(decoysOnly);
      expect("error" in api).toBe(true);
      if (!("error" in api)) return;
      // The failure has to carry the evidence: which files were considered and what each declared.
      expect(api.error).toContain("0 WGPU_EXPORT declarations");
      expect(api.error).toContain(path.join("webgpu", "webgpu.h"));
    } finally {
      fs.rmSync(decoysOnly, { recursive: true, force: true });
    }
  });

  test("a header that declares almost nothing is refused rather than trusted", () => {
    // 199 is a plausible-looking number and still wrong. The guard is what turns "the archive layout
    // changed" into a failure here instead of a library missing half its API.
    const small = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-small-"));
    try {
      fs.writeFileSync(path.join(small, "webgpu.h"), apiHeader(199));
      expect("error" in findApiHeader(small)).toBe(true);
      fs.writeFileSync(path.join(small, "webgpu.h"), apiHeader(200));
      expect("error" in findApiHeader(small)).toBe(false);
    } finally {
      fs.rmSync(small, { recursive: true, force: true });
    }
  });

  test("an empty tree is an error, not an empty answer", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-empty-"));
    try {
      expect("error" in findApiHeader(empty)).toBe(true);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test("declarations are deduplicated and sorted", () => {
    const dup = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-dup-"));
    try {
      const file = path.join(dup, "webgpu.h");
      fs.writeFileSync(file, `${apiHeader(3)}\n${apiHeader(3)}`);
      const names = exportedFunctions(file);
      expect(names).toEqual(["wgpuFunctionNumber0", "wgpuFunctionNumber1", "wgpuFunctionNumber2"]);
    } finally {
      fs.rmSync(dup, { recursive: true, force: true });
    }
  });
});
