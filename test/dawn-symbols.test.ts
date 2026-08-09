/**
 * The symbol-table reader, against the real output shape of every tool that feeds it.
 *
 * This exists because of a measured failure, not a hypothetical one. The Dawn link's export check
 * counted names with `/\b(wgpu[A-Za-z0-9_]+)\b/`, which is correct on ELF and on `dumpbin` and
 * matches **nothing** on Mach-O, where every C symbol carries a leading underscore and `\b` cannot
 * fire between `_` and `w`. The darwin-arm64 leg linked a working dylib and the check reported
 * "0 wgpu* symbols exported". Two of three platforms passing is what made it survive review.
 *
 * The fixtures below are shaped like the tools' actual output — column layout included — so that a
 * future edit to the pattern has to keep working against all four rather than against a tidy list of
 * bare names.
 */

import { describe, expect, test } from "bun:test";

import { wgpuSymbolsIn } from "../scripts/symbolTable.ts";

/** macOS: `nm -gU libwebgpu_dawn.dylib`. Note the Mach-O underscore on every name. */
const MACHO_NM = `
0000000000123450 T _wgpuAdapterGetInfo
0000000000123460 T _wgpuDeviceCreateBuffer
0000000000123470 T _wgpuQueueSubmit
`;

/** Linux: `nm -gD libwebgpu_dawn.so`. */
const ELF_NM = `
0000000000123450 T wgpuAdapterGetInfo
0000000000123460 T wgpuDeviceCreateBuffer
0000000000123470 T wgpuQueueSubmit
`;

/** Linux fallback: `objdump -T libwebgpu_dawn.so`. */
const ELF_OBJDUMP = `
DYNAMIC SYMBOL TABLE:
0000000000123450 g    DF .text  0000000000000024  Base        wgpuAdapterGetInfo
0000000000123460 g    DF .text  0000000000000110  Base        wgpuDeviceCreateBuffer
0000000000123470 g    DF .text  0000000000000048  Base        wgpuQueueSubmit
`;

/** Windows: `dumpbin /EXPORTS /NOLOGO webgpu_dawn.dll`. */
const DUMPBIN = `
    ordinal hint RVA      name

          1    0 00123450 wgpuAdapterGetInfo
          2    1 00123460 wgpuDeviceCreateBuffer
          3    2 00123470 wgpuQueueSubmit
`;

const EXPECTED = ["wgpuAdapterGetInfo", "wgpuDeviceCreateBuffer", "wgpuQueueSubmit"];

describe("reading a symbol table", () => {
  for (const [reader, output] of [
    ["nm -gU (Mach-O)", MACHO_NM],
    ["nm -gD (ELF)", ELF_NM],
    ["objdump -T (ELF)", ELF_OBJDUMP],
    ["dumpbin /EXPORTS (PE)", DUMPBIN],
  ] as const) {
    test(`${reader} yields the exported names`, () => {
      expect([...wgpuSymbolsIn(output)].sort()).toEqual(EXPECTED);
    });
  }

  test("the Mach-O underscore is stripped, not carried into the name", () => {
    // The regression was silent because it produced an empty set rather than underscored names.
    // Asserting the *content* is what makes the platform difference visible in the failure message.
    expect(wgpuSymbolsIn("0000000000123450 T _wgpuQueueSubmit").has("wgpuQueueSubmit")).toBe(true);
    expect(wgpuSymbolsIn("0000000000123450 T _wgpuQueueSubmit").has("_wgpuQueueSubmit")).toBe(false);
  });

  test("a name that merely ends in a wgpu-looking suffix is not counted", () => {
    // Guards the other direction: allowing an optional leading underscore must not let the pattern
    // anchor in the middle of an unrelated identifier.
    expect(wgpuSymbolsIn("0000000000123450 T _dawn_wgpuInternalThing").size).toBe(0);
    expect(wgpuSymbolsIn("0000000000123450 T _mywgpuThing").size).toBe(0);
  });

  test("an empty listing is an empty set, not a parse failure", () => {
    // A library that exports nothing is a real answer, and the caller's business — it prints the
    // count and points at the export filter. This function must not conflate it with "unreadable".
    expect(wgpuSymbolsIn("").size).toBe(0);
  });

  test("each name is counted once, however many times the tool prints it", () => {
    expect(wgpuSymbolsIn(`${ELF_NM}\n${ELF_NM}`).size).toBe(EXPECTED.length);
  });
});
