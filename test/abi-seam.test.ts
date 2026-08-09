/**
 * The ABI seam, and the compiled shim behind it.
 *
 * Three things are asserted here, and they are three different kinds of claim:
 *
 *   1. **The ABI rule itself** — which hosts can express a by-value aggregate from `bun:ffi` and
 *      which cannot. This is a fact about calling conventions, so it is tested as a pure function of
 *      (platform, arch) for hosts this machine is not. It is the load-bearing premise of the whole
 *      package; if it is wrong, the binding is silently wrong somewhere.
 *
 *   2. **That the two halves of the seam have not drifted.** The Rust crate and the TypeScript
 *      symbol table describe the same seven functions in different languages, edited for different
 *      reasons. Drift does not fail at build time — it fails at first GPU call, on whichever
 *      platform happened to get the mismatched pair. So the Rust source is parsed and compared.
 *
 *   3. **That an installed shim actually agrees with this package about C.** Loaded, interrogated,
 *      and its `sizeof` for every wrapped aggregate checked against the layouts this package derives
 *      from the pinned headers. Two independent descriptions of the same types; agreement is
 *      evidence, and it is evidence gathered on the real target rather than at build time.
 *
 * (3) needs the artefact and skips without it, loudly. (1) and (2) run everywhere, including on
 * runners with no GPU and no shim.
 */
import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AbiUnsupportedError,
  CallbackDeadlineError,
  BY_VALUE_CALLBACK_INFO_FUNCTIONS,
  BY_VALUE_FUNCTIONS,
  SHIM_ABI_VERSION,
  abiExpressesByValueAggregates,
  abiPassesLargeAggregatesByReference,
  abiPassesStringViewByReference,
  seamStatus,
  shimFileName,
  shimIsRequired,
  tryResolveShimLibrary,
  type ISeamStatus,
} from "../src/index.ts";
import { callbackAddress } from "../src/ffi/async.ts";
import { skipIsPermitted } from "./support/gpu.ts";
import { CALLBACK_SLOTS, SHIM_EXPORTS, callbackTrampolines } from "../src/ffi/abiSeam.ts";
import { sizeOf } from "../src/layouts/index.ts";
import { WGPU_NATIVE_MAJOR, supportedRids } from "../wgpu-native.manifest.ts";
import { rustTargetFor, shimRids } from "../shim.manifest.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SOURCE = fs.readFileSync(path.join(PKG_ROOT, "shim", "src", "lib.rs"), "utf-8");

describe("which ABIs can express a by-value aggregate", () => {
  // Two aggregate sizes cross this boundary in opposite directions, and they group the platforms
  // DIFFERENTLY. Collapsing them into one predicate is the bug that produced a binding which hung
  // inside `requestAdapter` on three platforms at once while passing everything on Windows — so the
  // two rules are asserted separately, and the combined answer is derived from them rather than
  // stated a second time.

  // A >16-byte aggregate ARGUMENT (`*CallbackInfo`, 40 B). SysV is the outlier.
  test.each([
    ["win32", "x64", true], // size ∉ {1,2,4,8} → hidden reference. Proven by execution.
    ["win32", "arm64", true], // AAPCS: >16 B is indirect
    ["linux", "arm64", true],
    ["darwin", "arm64", true],
    ["linux", "x64", false], // class MEMORY → copied onto the stack
    ["darwin", "x64", false],
    ["freebsd", "x64", false], // unrecognised: assume the shim is needed rather than guess
  ] as const)("40-byte argument on %s-%s → by reference: %s", (platform, arch, expected) => {
    expect(abiPassesLargeAggregatesByReference(platform, arch)).toBe(expected);
  });

  // A 16-byte two-integer aggregate CALLBACK PARAMETER (`WGPUStringView`). **Win64 is the outlier.**
  test.each([
    ["win32", "x64", true], // 128 bits ∉ {8,16,32,64} → hidden reference
    ["win32", "arm64", false], // AAPCS: ≤16 B → two registers
    ["linux", "arm64", false],
    ["darwin", "arm64", false],
    ["linux", "x64", false], // INTEGER+INTEGER → two registers
    ["darwin", "x64", false],
  ] as const)("16-byte callback parameter on %s-%s → by reference: %s", (platform, arch, expected) => {
    expect(abiPassesStringViewByReference(platform, arch)).toBe(expected);
  });

  test("the two rules disagree about AArch64, and that disagreement is the whole lesson", () => {
    // If these ever became the same function again, the defect comes straight back: AArch64 passes
    // the 40-byte argument by reference (so the direct call is fine) and the 16-byte callback
    // parameter in registers (so the direct callback is not). One predicate cannot say both.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(abiPassesLargeAggregatesByReference(platform, "arm64")).toBe(true);
      expect(abiPassesStringViewByReference(platform, "arm64")).toBe(false);
    }
  });

  test.each([
    ["win32", "x64", true],
    ["win32", "arm64", false],
    ["linux", "arm64", false],
    ["darwin", "arm64", false],
    ["linux", "x64", false],
    ["freebsd", "x64", false],
  ] as const)("the direct path is usable on %s-%s: %s", (platform, arch, expected) => {
    // Both questions must answer yes, which is Win64 and nowhere else.
    expect(abiExpressesByValueAggregates(platform, arch)).toBe(expected);
    expect(shimIsRequired(platform, arch)).toBe(!expected);
  });

  test("three of the four supported RIDs have no correct direct path", () => {
    // An earlier revision put this at one, on the strength of the 40-byte rule alone. The callback
    // rule makes it three — which is why building the shim for every platform stopped being a
    // judgement call about where code gets exercised and became a requirement.
    const required = supportedRids().filter((rid) => {
      const [platform, arch] = rid.split("-");
      return shimIsRequired(platform!, arch!);
    });
    expect([...required].sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
  });

  test("a shim artefact is declared for every supported RID", () => {
    expect([...shimRids()].sort()).toEqual([...supportedRids()].sort());
    for (const rid of supportedRids()) expect(rustTargetFor(rid)).toBeTruthy();
  });
});

describe("the hazard is stated from the header, not from memory", () => {
  test("eight functions take a *CallbackInfo by value; the seam binds seven entry points", () => {
    expect(BY_VALUE_CALLBACK_INFO_FUNCTIONS).toHaveLength(8);
    // Five of the eight, plus the two `*FreeMembers` entry points, which are the same hazard in a
    // different costume. The other three callback-info functions abort on call and are blocklisted.
    expect(BY_VALUE_FUNCTIONS).toHaveLength(7);
    const callable = BY_VALUE_FUNCTIONS.filter((f) => BY_VALUE_CALLBACK_INFO_FUNCTIONS.includes(f));
    expect(callable).toHaveLength(5);
  });

  test("every wrapped function has exactly one shim export standing in for it", () => {
    // 7 argument wrappers + 6 lifecycle/self-description + 2 callback-trampoline entry points.
    expect(SHIM_EXPORTS).toHaveLength(BY_VALUE_FUNCTIONS.length + 8);
    for (const name of SHIM_EXPORTS) expect(name.startsWith("wgpu_bun_shim_")).toBe(true);
  });
});

describe("the Rust crate and the TypeScript seam describe the same shim", () => {
  test("every symbol the seam binds is `#[no_mangle]`-exported by the crate", () => {
    const exported = new Set(
      [...RUST_SOURCE.matchAll(/pub(?:\s+unsafe)?\s+extern\s+"C"\s+fn\s+(wgpu_bun_shim_\w+)/g)].map(
        (m) => m[1]!,
      ),
    );
    const missing = SHIM_EXPORTS.filter((name) => !exported.has(name));
    expect(missing).toEqual([]);
  });

  test("the crate exports nothing the seam does not know about", () => {
    // The other direction matters too: an export the seam never binds is either dead code or a
    // half-finished change, and both are worth noticing while they are cheap.
    const exported = [
      ...RUST_SOURCE.matchAll(/pub(?:\s+unsafe)?\s+extern\s+"C"\s+fn\s+(wgpu_bun_shim_\w+)/g),
    ].map((m) => m[1]!);
    expect([...exported].sort()).toEqual([...SHIM_EXPORTS].sort());
  });

  test("the callback slot numbers are the same on both sides", () => {
    // These cross a C boundary as bare integers on every registration. A drift here does not fail
    // loudly: it installs the wrong trampoline, wgpu-native calls a C function with the wrong
    // prototype, and the result is a corrupted stack or a callback that quietly never matches.
    const rustSlots: Record<string, number> = {};
    for (const m of RUST_SOURCE.matchAll(/const SLOT_([A-Z_]+):\s*u32\s*=\s*(\d+)/g)) {
      rustSlots[m[1]!] = Number(m[2]);
    }
    expect(rustSlots).toEqual({
      REQUEST_ADAPTER: CALLBACK_SLOTS.requestAdapter,
      REQUEST_DEVICE: CALLBACK_SLOTS.requestDevice,
      BUFFER_MAP: CALLBACK_SLOTS.bufferMap,
      POP_ERROR_SCOPE: CALLBACK_SLOTS.popErrorScope,
      QUEUE_WORK_DONE: CALLBACK_SLOTS.queueWorkDone,
      UNCAPTURED_ERROR: CALLBACK_SLOTS.uncapturedError,
      DEVICE_LOST: CALLBACK_SLOTS.deviceLost,
    });
  });

  test("the crate declares a trampoline for every slot the seam can ask for", () => {
    const trampolines = [...RUST_SOURCE.matchAll(/unsafe extern "C" fn (tramp_\w+)\(/g)].map((m) => m[1]!);
    expect(trampolines).toHaveLength(Object.keys(CALLBACK_SLOTS).length);
    // And each one takes the message BY VALUE — a `WGPUStringView` parameter, not a pointer. That
    // is the entire reason they exist; a trampoline declared with `*const WGPUStringView` would
    // compile, run, and reintroduce the defect.
    for (const name of trampolines) {
      const body = RUST_SOURCE.slice(RUST_SOURCE.indexOf(`fn ${name}(`));
      const signature = body.slice(0, body.indexOf(")"));
      expect(signature, `${name} must take message: WGPUStringView by value`).toContain(
        "message: WGPUStringView",
      );
    }
  });

  test("the flat-ABI version is the same number on both sides", () => {
    // A mismatch here would mean the seam calls the shim with the wrong arguments, which corrupts a
    // stack rather than raising anything. It is checked again at load, against the built binary;
    // this catches it in a run with no artefact at all.
    const declared = /const\s+SHIM_ABI_VERSION:\s*u32\s*=\s*(\d+)/.exec(RUST_SOURCE);
    expect(declared).toBeTruthy();
    expect(Number(declared![1])).toBe(SHIM_ABI_VERSION);
  });

  test("the crate targets the wgpu-native generation this package pins", () => {
    const declared = /const\s+SHIM_TARGET_GENERATION:\s*u32\s*=\s*(\d+)/.exec(RUST_SOURCE);
    expect(declared).toBeTruthy();
    expect(Number(declared![1])).toBe(WGPU_NATIVE_MAJOR);
  });

  test("the crate hard-codes the same aggregate sizes this package derives", () => {
    // The crate's own unit test asserts these against `size_of`; this asserts that the numbers it
    // asserts are the ones the pinned headers actually produce. Neither test alone closes the loop.
    for (const [aggregate, name] of [
      ["WGPUStringView", "WGPUStringView"],
      ["WGPURequestAdapterCallbackInfo", "WGPUCallbackInfo"],
      ["WGPUAdapterInfo", "WGPUAdapterInfo"],
      ["WGPUSupportedFeatures", "WGPUSupportedFeatures"],
      ["WGPUFuture", "WGPUFuture"],
    ] as const) {
      // Same line only. `[ \t]*` rather than `\s*`: the crate's `sizeof` dispatch also contains
      // `size_of::<T>(),` at the end of a match arm, and a newline-crossing pattern would happily
      // read the *next* arm's selector as the size.
      const pattern = new RegExp(`size_of::<${name}>\\(\\),[ \\t]*(\\d+)`);
      const found = pattern.exec(RUST_SOURCE);
      expect(found, `shim/src/lib.rs asserts no size for ${name}`).toBeTruthy();
      expect(Number(found![1])).toBe(sizeOf(aggregate));
    }
  });
});

describe("the seam's verdict", () => {
  test("resolving a strategy never throws, whatever is installed", () => {
    // `test/support/gpu.ts` calls this at import time to classify a refusal. If it could throw, the
    // gate would fail for the wrong reason on exactly the hosts the classification exists for.
    const status = seamStatus();
    expect(["shim", "direct", "refuse"]).toContain(status.mode);
    expect(status.reason.length).toBeGreaterThan(0);
    expect(status.shimRequired).toBe(shimIsRequired());
  });

  test("a refusal is its own error class, not a generic failure", () => {
    // The taxonomy this exists to protect: an ABI refusal used to reach the GPU gate as an untyped
    // throw from `requestAdapter`, be filed as `no-adapter`, and send a reader after a driver
    // problem that did not exist. Classification by type is what makes that impossible.
    const err = new AbiUnsupportedError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AbiUnsupportedError");
  });

  test("this host has a correct path, or explains why not", () => {
    const status = seamStatus();
    if (status.mode === "refuse") {
      // Only legitimate on a SysV host with no shim installed.
      expect(shimIsRequired()).toBe(true);
      expect(status.shim).toBeNull();
    } else if (status.mode === "direct") {
      expect(abiExpressesByValueAggregates()).toBe(true);
    } else {
      expect(status.shim).not.toBeNull();
    }
  });
});

describe("the skip policy distinguishes an absent shim from a rejected one", () => {
  // Both of these produce `abi-unsupported`, and they must be treated as opposites. The reason they
  // share an error class at all is that the alternative was worse: a rejected shim thrown as a plain
  // Error reaches the gate as `no-adapter`, which IS escapable by an environment variable CI grants
  // on some legs — so a shim that failed its version check could be skipped past in silence.
  const gate = { kind: "abi-unsupported", detail: "" } as const;

  test("no shim installed → a permitted skip", () => {
    const absent: ISeamStatus = { mode: "refuse", shim: null, shimRequired: true, reason: "" };
    expect(skipIsPermitted(gate, absent)).toBe(true);
  });

  test("a shim installed but the seam still refused → a defect, and it goes red", () => {
    // Wrong flat-ABI version, wrong wgpu-native generation, a `sizeof` disagreement, or wgpu-native
    // could not be opened. Every one of those is a bug in the pairing, not a property of the host.
    const present: ISeamStatus = {
      mode: "refuse",
      shim: { path: "/somewhere/libwgpu_bun_shim.so", source: "vendor", includeDir: null, version: "1.0.0" },
      shimRequired: true,
      reason: "",
    };
    expect(skipIsPermitted(gate, present)).toBe(false);
  });

  test("`no-callback` is never permitted, shim or no shim", () => {
    // The third member of this family. A callback that never arrives was also being filed as
    // `no-adapter` — which is escapable by an env var two CI legs are granted, so the one failure
    // mode most likely to appear on those legs was the one most easily skipped past.
    const absent: ISeamStatus = { mode: "refuse", shim: null, shimRequired: true, reason: "" };
    const present: ISeamStatus = {
      mode: "shim",
      shim: { path: "/x/libwgpu_bun_shim.so", source: "vendor", includeDir: null, version: "2.0.0" },
      shimRequired: true,
      reason: "",
    };
    expect(skipIsPermitted({ kind: "no-callback", detail: "" }, absent)).toBe(false);
    expect(skipIsPermitted({ kind: "no-callback", detail: "" }, present)).toBe(false);
  });

  test("the deadline error is its own class, so the gate can tell it from a driver problem", () => {
    const err = new CallbackDeadlineError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CallbackDeadlineError");
    // And it is NOT an ABI refusal: the two have different policies (one skips while an artefact is
    // missing, the other never skips), so collapsing them would re-open the hole.
    expect(err).not.toBeInstanceOf(AbiUnsupportedError);
  });

  test("`no-device` is never permitted, shim or no shim", () => {
    // The control case: proof the policy is not simply returning whatever was asked of it.
    const absent: ISeamStatus = { mode: "refuse", shim: null, shimRequired: true, reason: "" };
    expect(skipIsPermitted({ kind: "no-device", detail: "" }, absent)).toBe(false);
  });
});

// ── the installed artefact ──────────────────────────────────────────────────────────────────────

const shim = tryResolveShimLibrary();

if (!shim) {
  console.error(
    `wgpu-bun: shim binary tests SKIPPED — no ${shimFileName()} installed.\n` +
      `  Build it with \`bun run shim:build\` (needs cargo) or fetch the pinned prebuilt one.`,
  );
}

describe.skipIf(shim === null)("the installed shim agrees with this package about C", () => {
  const symbols = {
    wgpu_bun_shim_abi_version: { args: [], returns: FFIType.u32 },
    wgpu_bun_shim_target_generation: { args: [], returns: FFIType.u32 },
    wgpu_bun_shim_sizeof: { args: [FFIType.u32], returns: FFIType.u64 },
    wgpu_bun_shim_is_open: { args: [], returns: FFIType.i32 },
  } as const;

  test("it reports the flat-ABI version this build speaks", () => {
    const s = dlopen(shim!.path, symbols).symbols;
    expect(Number(s.wgpu_bun_shim_abi_version())).toBe(SHIM_ABI_VERSION);
  });

  test("it was written against the pinned wgpu-native generation", () => {
    // Version skew — a shim built for one generation loaded beside another's library — is the one
    // runtime failure mode a compiled shim adds over the direct path. It is refused at load; this
    // proves the number it is refused against is readable at all.
    const s = dlopen(shim!.path, symbols).symbols;
    expect(Number(s.wgpu_bun_shim_target_generation())).toBe(WGPU_NATIVE_MAJOR);
  });

  test.each([
    [0, "WGPUStringView"],
    [1, "WGPURequestAdapterCallbackInfo"],
    [2, "WGPUAdapterInfo"],
    [3, "WGPUSupportedFeatures"],
    [4, "WGPUFuture"],
  ] as const)("sizeof selector %i == derived sizeof(%s)", (selector, aggregate) => {
    // The Rust compiler laid these out; this package derived them from the pinned headers; neither
    // consulted the other. This is the cross-check the header oracle cannot perform for a platform
    // the developer is not sitting on — here it runs wherever the artefact does.
    const s = dlopen(shim!.path, symbols).symbols;
    expect(Number(s.wgpu_bun_shim_sizeof(selector))).toBe(sizeOf(aggregate));
  });

  test("an unknown sizeof selector answers 0 rather than guessing", () => {
    const s = dlopen(shim!.path, symbols).symbols;
    expect(Number(s.wgpu_bun_shim_sizeof(999))).toBe(0);
  });

  test("what gets installed in WGPUCallbackInfo.callback is the trampoline, not the JSCallback", () => {
    // The check that the indirection is actually happening. If `callbackAddress` ever returned the
    // JSCallback's own pointer while the shim was bound, wgpu-native would call a bun:ffi callback
    // with a by-value WGPUStringView — which is the original defect, restored, on a build that
    // otherwise looks correct.
    const trampolines = callbackTrampolines();
    if (!trampolines) return; // direct path bound on this host; covered by the truth table above
    for (const slot of Object.keys(CALLBACK_SLOTS) as (keyof typeof CALLBACK_SLOTS)[]) {
      const installed = callbackAddress(slot);
      expect(installed).toBe(trampolines.address(slot));
      expect(installed).toBeGreaterThan(0);
    }
    // Seven distinct trampolines, not one shared one — each has a different C prototype.
    const all = (Object.keys(CALLBACK_SLOTS) as (keyof typeof CALLBACK_SLOTS)[]).map(callbackAddress);
    expect(new Set(all).size).toBe(all.length);
  });
});
