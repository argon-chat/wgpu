/**
 * More than one wgpu-native generation.
 *
 * The claim being defended: a consumer whose Rust half is on wgpu 27 can have their JavaScript half
 * validated against wgpu 27, by pointing `WGPU_NATIVE_LIB` at that library or running
 * `bun run fetch --generation 27`. That claim is only worth making because the suite has been run
 * against both — `docs/GENERATIONS.md` records what was measured, and `ci.yml` re-measures it.
 *
 * What *this* file checks is everything about the arrangement that does not need a GPU: that the
 * manifest is internally consistent, that every supported generation is actually installable on
 * every platform, and that the per-generation symbol declarations line up with the blocklist. The
 * behavioural half — "the suite is green on that library" — is the rest of the suite, run again
 * with a different binary underneath it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { FIRST_GENERATION, UNIMPLEMENTED, existsInGeneration } from "../src/ffi/unimplemented.ts";
import { WEBGPU_AGGREGATES } from "../src/layouts/generated/webgpu.structs.ts";
import {
  DEFAULT_GENERATION,
  GENERATION_VARIANT_AGGREGATES,
  GENERATIONS,
  SUPPORTED_GENERATIONS,
  WGPU_NATIVE_MAJOR,
  WGPU_NATIVE_TAG,
  assetFor,
  generation,
  supportedRids,
} from "../wgpu-native.manifest.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8")) as { version: string };

describe("the generation map", () => {
  test("lists more than one, newest first", () => {
    expect(SUPPORTED_GENERATIONS.length).toBeGreaterThan(1);
    expect([...SUPPORTED_GENERATIONS]).toEqual([...SUPPORTED_GENERATIONS].sort((a, b) => b - a));
  });

  test("the default is one of them, and it is the one the package version names", () => {
    // Two statements of the same fact, in files edited for different reasons: the manifest picks
    // what ships, and the version number tells every consumer what they are getting. A release that
    // moved one without the other would advertise an ABI it does not contain.
    expect(SUPPORTED_GENERATIONS).toContain(DEFAULT_GENERATION);
    expect(WGPU_NATIVE_MAJOR).toBe(DEFAULT_GENERATION);
    expect(Number(pkg.version.split(".")[0])).toBe(DEFAULT_GENERATION);
  });

  test.each([...SUPPORTED_GENERATIONS])("generation %i's tag names its own major", (major) => {
    // `v27.0.4.1` under key 27. A transcription slip here would pin the wrong binary while every
    // message in the package kept saying the right number.
    expect(generation(major).tag).toMatch(new RegExp(`^v${major}\\.`));
  });

  test("the default generation's tag is the one exported as WGPU_NATIVE_TAG", () => {
    expect(WGPU_NATIVE_TAG).toBe(generation(DEFAULT_GENERATION).tag);
  });

  test("an unsupported generation is refused by name, not silently defaulted", () => {
    // Falling back to the default would install a library the caller did not ask for and then run a
    // suite that proves nothing about the one they wanted.
    expect(() => generation(28)).toThrow(/not supported/);
  });
});

describe("every supported generation is actually installable", () => {
  test.each([...SUPPORTED_GENERATIONS])("generation %i covers every platform the default does", (major) => {
    // Otherwise `--generation 27` works on the maintainer's machine and fails on a CI leg — and the
    // whole point of the second generation is that CI runs the suite against it, everywhere.
    expect(supportedRids(major).sort()).toEqual(supportedRids(DEFAULT_GENERATION).sort());
  });

  test.each([...SUPPORTED_GENERATIONS])("generation %i is pinned by a real sha256 on every platform", (major) => {
    // An empty hash means *unpinned*, and the fetch script refuses to install one. A generation
    // listed here but not pinned would be a promise the tooling cannot keep.
    const unpinned = supportedRids(major).filter((rid) => !/^[0-9a-f]{64}$/.test(assetFor(rid, major)?.sha256 ?? ""));
    expect(unpinned).toEqual([]);
  });

  test.each([...SUPPORTED_GENERATIONS])("generation %i's URLs all point at its own tag", (major) => {
    const tag = generation(major).tag;
    const wrong = supportedRids(major).filter((rid) => !assetFor(rid, major)!.url.includes(`/${tag}/`));
    expect(wrong).toEqual([]);
  });

  test("no two generations share an archive URL", () => {
    // The failure this prevents is a copy-paste release bump that leaves one platform pointing at
    // the previous generation's binary — which installs, passes its hash, and is the wrong library.
    const urls = SUPPORTED_GENERATIONS.flatMap((major) =>
      supportedRids(major).map((rid) => assetFor(rid, major)!.url),
    );
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("aggregates whose layout moves between generations", () => {
  /** Every `.ts` under `src/`, minus the generated tables — which are where these names live. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") sourceFiles(p, out);
      } else if (p.endsWith(".ts")) {
        out.push(p);
      }
    }
    return out;
  }

  test("not one of them is named anywhere in src/", () => {
    // This is the assertion that makes `check:layouts` safe to relax on a non-default generation.
    // The relaxation says "these may differ"; it is only defensible while the binding never packs,
    // reads or names one of them. The moment it does, the tolerance is hiding a real ABI break —
    // so the tolerance is bound to the fact that justifies it, in the same suite.
    //
    // `src/layouts/generated/**` is excluded because that is the inventory of the headers, not use.
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(PKG_ROOT, "src"))) {
      const src = fs.readFileSync(file, "utf-8");
      for (const [i, line] of src.split("\n").entries()) {
        // A comment naming one as an example is documentation, not use.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const name of GENERATION_VARIANT_AGGREGATES) {
          if (line.includes(name)) {
            offenders.push(`${path.relative(PKG_ROOT, file)}:${i + 1}: ${name}`);
          }
        }
      }
    }
    expect(
      offenders,
      "these aggregates are declared to differ between wgpu-native generations, so the binding " +
        "must not depend on their layout:\n\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  test("each one is a wgpu.h extension, never a core webgpu.h aggregate", () => {
    // The claim being defended is narrow and worth keeping narrow: `webgpu.h` — everything the
    // binding actually packs — is identical across the supported generations, and only
    // wgpu-native's own extension header moves. A core aggregate appearing in this list would mean
    // that claim had quietly become false.
    const core = Object.keys(WEBGPU_AGGREGATES);
    const fromCore = GENERATION_VARIANT_AGGREGATES.filter((name) => core.includes(name));
    expect(fromCore).toEqual([]);
  });
});

describe("symbols that exist in some generations and not others", () => {
  test("every declared late arrival is on the blocklist", () => {
    // The record says "this trap appears in generation N". If the name is not a trap at all, the
    // entry is describing nothing.
    const strays = FIRST_GENERATION.filter((e) => !UNIMPLEMENTED.includes(e.symbol)).map((e) => e.symbol);
    expect(strays).toEqual([]);
  });

  test("every declared arrival generation is one this package supports", () => {
    const unknown = FIRST_GENERATION.filter((e) => !SUPPORTED_GENERATIONS.includes(e.since));
    expect(unknown).toEqual([]);
  });

  test("existsInGeneration partitions on the declared boundary", () => {
    const late = FIRST_GENERATION[0];
    expect(late).toBeDefined();
    expect(existsInGeneration(late!.symbol, late!.since)).toBe(true);
    expect(existsInGeneration(late!.symbol, late!.since - 1)).toBe(false);
    // Anything undeclared is expected in every generation — the union is the default, and only the
    // exceptions are written down.
    expect(existsInGeneration("wgpuBufferReadMappedRange", Math.min(...SUPPORTED_GENERATIONS))).toBe(true);
  });
});
