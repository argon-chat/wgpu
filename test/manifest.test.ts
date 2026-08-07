/**
 * The binary pin.
 *
 * `wgpu-native.manifest.ts` is the supply chain: it decides which bytes this package binds to. The
 * doctrine it encodes — exact URL, exact sha256, hard-fail on mismatch, never commit the binary — is
 * only worth anything if it cannot be quietly relaxed, so the invariants are asserted rather than
 * documented.
 *
 * The one that matters most is the empty-hash rule. An entry with no sha256 is *unpinned*, and the
 * fetch script refuses to install it. That is deliberate: a plausible-looking invented hash in a
 * supply-chain file is worse than a blank one, because it looks checked.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSETS,
  assetFor,
  currentRid,
  HEADER_BASENAMES,
  libFileName,
  platformOf,
  supportedRids,
  WGPU_NATIVE_MAJOR,
  WGPU_NATIVE_TAG,
} from "../wgpu-native.manifest.ts";

/** The platforms this package claims to support. Changing this list is a release decision. */
const EXPECTED_RIDS = ["win32-x64", "darwin-arm64", "linux-x64", "linux-arm64"] as const;

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the pinned release", () => {
  test("the tag and the major agree", () => {
    // WGPU_NATIVE_MAJOR is the wgpu-core generation, which is what determines ABI and validation
    // behaviour. If it ever disagrees with the tag, every "targets wgpu-native N" claim is wrong.
    expect(WGPU_NATIVE_TAG).toMatch(/^v\d+\.\d+\.\d+\.\d+$/);
    expect(WGPU_NATIVE_TAG.slice(1).split(".")[0]).toBe(String(WGPU_NATIVE_MAJOR));
  });

  test("covers exactly the RIDs the package advertises", () => {
    expect([...supportedRids()].sort()).toEqual([...EXPECTED_RIDS].sort());
  });

  test("the package's major version IS the wgpu-native generation it binds", () => {
    // The versioning contract, enforced rather than documented.
    //
    // `wgpu-bun@29.x.y` binds wgpu-native v29. The major is not ours to choose: it names the native
    // generation, which is what actually decides ABI, validation strictness and WGSL acceptance —
    // the things a consumer is choosing this package *for*. Minor and patch are ours.
    //
    // Upstream's tag has four components (`v29.0.1.1`) and semver has three, so the exact tag
    // cannot live in the version string. It lives in `WGPU_NATIVE_TAG`, in the README, and in the
    // `.version` stamp beside the installed library — three places a reader can reach. What this
    // test guarantees is the part that would otherwise rot silently: that a pin bump to v30 cannot
    // ship as `29.x` and quietly tell every consumer the ABI did not move.
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8")) as {
      version: string;
    };
    const major = Number(pkg.version.split(".")[0]);
    expect(Number.isInteger(major)).toBe(true);
    expect(major).toBe(WGPU_NATIVE_MAJOR);
  });
});

describe.each([...EXPECTED_RIDS])("%s", (rid) => {
  const asset = assetFor(rid)!;

  test("is pinned by a real sha256, not a placeholder", () => {
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("downloads over https from upstream's own release page", () => {
    // Not a mirror, not a rewritten host: the bytes must be upstream's, from a URL a reader can
    // check by hand. That is the entire argument for pinning rather than vendoring.
    expect(asset.url.startsWith("https://github.com/gfx-rs/wgpu-native/releases/download/")).toBe(true);
  });

  test("the URL names the pinned tag", () => {
    // Kept literal rather than templated from the version so it stays greppable — but that means a
    // bump can update the tag and forget a URL, which is precisely what this catches.
    expect(asset.url).toContain(`/${WGPU_NATIVE_TAG}/`);
  });

  test("is a release build, never a debug one", () => {
    // A debug wgpu-native is roughly ten times the size and its assertion behaviour differs, which
    // is the wrong thing for a test gate to depend on.
    expect(asset.url).toContain("-release.zip");
    expect(asset.url).not.toContain("-debug");
  });
});

describe("no two platforms share bytes", () => {
  test("every pinned sha256 is distinct", () => {
    // A copy-paste during a bump is the realistic way this file goes wrong, and a duplicated hash
    // would make one platform silently install another's library — which then fails at dlopen with
    // an error about the file format rather than about the manifest.
    const hashes = Object.values(ASSETS).map((a) => a!.sha256);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("every pinned URL is distinct", () => {
    const urls = Object.values(ASSETS).map((a) => a!.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("RID helpers", () => {
  test("RIDs use Node's spelling, because npm os/cpu fields do", () => {
    for (const rid of supportedRids()) {
      const [platform, arch] = rid.split("-");
      expect(["win32", "darwin", "linux"]).toContain(platform ?? "");
      expect(["x64", "arm64"]).toContain(arch ?? "");
    }
  });

  test("platformOf splits on the first dash only", () => {
    expect(platformOf("win32-x64")).toBe("win32");
    expect(platformOf("linux-arm64")).toBe("linux");
    expect(platformOf("darwin")).toBe("darwin");
  });

  test("libFileName follows each platform's convention", () => {
    expect(libFileName("win32")).toBe("wgpu_native.dll");
    expect(libFileName("darwin")).toBe("libwgpu_native.dylib");
    expect(libFileName("linux")).toBe("libwgpu_native.so");
  });

  test("currentRid composes platform and arch", () => {
    expect(currentRid("linux", "arm64")).toBe("linux-arm64");
    expect(currentRid()).toBe(`${process.platform}-${process.arch}`);
  });

  test("an unsupported RID is undefined rather than a guessed asset name", () => {
    // Guessing would produce a 404 at download time, attributed to the network rather than to the
    // fact that nobody has ever pinned a build for that host.
    expect(assetFor("freebsd-x64")).toBeUndefined();
  });
});

describe("headers", () => {
  test("both upstream headers are requested", () => {
    // Kept even though the shipped package does not compile C: they are what a reader consults when
    // checking a struct layout, and what a future bindgen step would run over.
    expect([...HEADER_BASENAMES]).toEqual(["webgpu.h", "wgpu.h"]);
  });
});
