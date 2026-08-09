/**
 * Read `wgpu*` symbol names out of whatever a platform's symbol-table tool printed.
 *
 * Its own module, and not three lines inside `dawn-link.ts`, because the naive spelling of this is
 * wrong on exactly one of the three platforms and wrong *silently* — see below. A rule that has a
 * platform-specific trap in it needs a test, and a test needs something it can import.
 *
 * ── The trap ────────────────────────────────────────────────────────────────────────────────────
 *
 * Mach-O prefixes every C symbol with an underscore, so macOS `nm` prints `_wgpuAdapterGetInfo`
 * where ELF `nm` and `dumpbin` both print `wgpuAdapterGetInfo`. The obvious pattern —
 * `/\b(wgpu[A-Za-z0-9_]+)\b/` — therefore matches **nothing at all** on macOS: `_` is a word
 * character, so there is no word boundary between `_` and `w`.
 *
 * Measured, not reasoned about: the darwin-arm64 leg linked a perfectly good dylib and this counter
 * reported `0 wgpu* symbols exported`. Two platforms agreeing is not coverage when the third one is
 * the one with the different convention.
 *
 * @see test/dawn-symbols.test.ts — real output shapes from all four readers, including the one that
 * regressed.
 */

/**
 * Accepts an optional Mach-O underscore, and refuses a name that is the tail of a longer identifier.
 *
 * The lookbehind rejects `[A-Za-z0-9_]` so that `foo_wgpuBar` matches at neither the `_` (preceded by
 * `o`) nor the `w` (preceded by `_`). Without it, `_?` would happily anchor mid-identifier.
 */
const SYMBOL = /(?<![A-Za-z0-9_])_?(wgpu[A-Za-z0-9_]+)/g;

/** Every distinct `wgpu*` name in a symbol listing, with the platform prefix stripped. */
export function wgpuSymbolsIn(text: string): Set<string> {
  return new Set([...text.matchAll(SYMBOL)].map((m) => m[1]!));
}
