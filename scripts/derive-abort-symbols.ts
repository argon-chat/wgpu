#!/usr/bin/env bun
/**
 * Re-derive the abort-on-call blocklist from upstream source at the pinned tag.
 *
 *     bun run derive:aborts            # print the derived lists
 *     bun run derive:aborts:source --check   # compare against the checked-in list, exit 1 on drift
 *
 * ── Why this is a script and not a test ─────────────────────────────────────────────────────────
 *
 * 35 of the 40 blocklisted symbols are *bare* `unimplemented!()` bodies. A bare panic leaves no name
 * in the compiled library — only a file-and-line reference into `src/unimplemented.rs` — so there is
 * nothing in the shipped binary to scan for. They can only be derived from upstream's source.
 *
 * That needs network, which a test suite should not. So the split is:
 *
 *   - `test/abort-symbols.test.ts` re-derives the 5 *named* entries from the installed binary on
 *     every run, offline, everywhere.
 *   - this script re-derives all 40 from upstream source, and CI runs it as its own job.
 *
 * Together they mean a wgpu-native version bump cannot quietly add a trap or quietly retire one:
 * one of the two checks fails until someone edits `test/support/abort-symbols.ts` on purpose.
 *
 * The parse is deliberately literal — find `#[no_mangle] pub extern "C" fn <name>` in
 * `src/unimplemented.rs`, and `unimplemented!("<name> is not implemented")` in `src/lib.rs`. If
 * upstream restructures so that either pattern stops matching, this reports *zero* symbols, which
 * `--check` treats as a hard error rather than as "nothing to do". A silently-empty derivation would
 * be the one way this tool could lie.
 */
import {
  BINARY_NAMED_ABORT_SYMBOLS,
  SOURCE_ONLY_ABORT_SYMBOLS,
} from "../test/support/abort-symbols.ts";
import { WGPU_NATIVE_TAG } from "../wgpu-native.manifest.ts";

const RAW = `https://raw.githubusercontent.com/gfx-rs/wgpu-native/${WGPU_NATIVE_TAG}`;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

/** Bare `unimplemented!()` entry points — one `extern "C" fn` per stub in `src/unimplemented.rs`. */
function parseBareStubs(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/extern\s+"C"\s+fn\s+(wgpu[A-Za-z0-9_]+)/g)) names.add(m[1]!);
  return [...names].sort();
}

/** `unimplemented!("<name> is not implemented")` — the ones whose message reaches the binary. */
function parseNamedStubs(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/unimplemented!\("(wgpu[A-Za-z0-9_]+) is not implemented"\)/g)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

function diff(label: string, expected: readonly string[], actual: readonly string[]): string[] {
  const problems: string[] = [];
  const added = actual.filter((n) => !expected.includes(n));
  const removed = expected.filter((n) => !actual.includes(n));
  for (const n of added) problems.push(`${label}: NEW abort-on-call symbol upstream — ${n}`);
  for (const n of removed) problems.push(`${label}: blocklisted symbol no longer stubbed upstream — ${n}`);
  return problems;
}

const check = process.argv.includes("--check");

const [unimplementedRs, libRs] = await Promise.all([
  fetchText(`${RAW}/src/unimplemented.rs`),
  fetchText(`${RAW}/src/lib.rs`),
]);

const bare = parseBareStubs(unimplementedRs);
const named = parseNamedStubs(libRs);

if (!check) {
  console.log(`\nwgpu-native ${WGPU_NATIVE_TAG} — abort-on-call symbols\n`);
  console.log(`bare unimplemented!() in src/unimplemented.rs (${bare.length}):`);
  for (const n of bare) console.log(`  "${n}",`);
  console.log(`\nnamed unimplemented!("…") in src/lib.rs (${named.length}):`);
  for (const n of named) console.log(`  "${n}",`);
  console.log(`\ntotal: ${bare.length + named.length}\n`);
  process.exit(0);
}

const problems: string[] = [];

// A parse that finds nothing means upstream moved, not that the traps are gone. Treating an empty
// result as success is the only way this tool could hand back a false all-clear.
if (bare.length === 0) problems.push("parsed ZERO bare stubs from src/unimplemented.rs — the upstream layout changed");
if (named.length === 0) problems.push('parsed ZERO named stubs from src/lib.rs — the upstream layout changed');

problems.push(...diff("src/unimplemented.rs", SOURCE_ONLY_ABORT_SYMBOLS, bare));
problems.push(...diff("src/lib.rs", BINARY_NAMED_ABORT_SYMBOLS, named));

if (problems.length > 0) {
  console.error(`\nabort-symbol blocklist is out of date for ${WGPU_NATIVE_TAG}:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nUpdate test/support/abort-symbols.ts deliberately — each entry is a symbol that KILLS the\n` +
      `process when called, so adding or removing one is a decision, not a chore.\n` +
      `Run without --check to print the lists ready to paste.\n`,
  );
  process.exit(1);
}

console.log(`abort-symbol blocklist matches wgpu-native ${WGPU_NATIVE_TAG} (${bare.length + named.length} symbols)`);
