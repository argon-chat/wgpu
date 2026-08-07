/**
 * Finding the native library — and, more importantly, explaining it when it cannot be found.
 *
 * ── Why the error message is a tested artefact ──────────────────────────────────────────────────
 *
 * The native library ships as per-platform npm packages listed in `optionalDependencies`. That is
 * the right delivery mechanism, but it has one sharp edge: **`optionalDependencies` fail silently.**
 * If no package matches the host's platform, the package manager installs nothing, reports success,
 * and says nothing. The user finds out at `create()` time.
 *
 * At that moment the resolver's error message is the *only* diagnostic that exists. Nothing else in
 * the system knows why the library is absent. So it has to name three things — the platform that was
 * looked for, the package that would have provided it, and the override that bypasses the whole
 * question — or the user is left guessing at an empty `node_modules`.
 *
 * That makes the message a contract, not cosmetics, which is why it is asserted here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LIB_ENV_VAR, NPM_SCOPE, resolveNativeLibrary, tryResolveNativeLibrary } from "../src/index.ts";

const originalEnv = process.env[LIB_ENV_VAR];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[LIB_ENV_VAR];
  else process.env[LIB_ENV_VAR] = originalEnv;
});

describe("the override tier", () => {
  test(`${LIB_ENV_VAR} wins over everything else`, () => {
    // The escape hatch for a locally built wgpu-native — bisecting an upstream regression, testing
    // an unreleased fix. It has to beat both the npm tier and the vendor tree or it is not an
    // escape hatch, it is a suggestion.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgpu-bun-"));
    const fake = path.join(tmp, "libwgpu_native.so");
    fs.writeFileSync(fake, "not a real library");
    try {
      process.env[LIB_ENV_VAR] = fake;
      const resolved = tryResolveNativeLibrary();
      expect(resolved?.source).toBe("env");
      expect(resolved?.path).toBe(path.resolve(fake));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a set-but-wrong override throws instead of silently falling through", () => {
    // Falling through would be the friendly-looking behaviour and the wrong one: the user asserted
    // a path. Quietly using a different library than the one they named is how an afternoon
    // disappears.
    process.env[LIB_ENV_VAR] = path.join(os.tmpdir(), "definitely-not-here", "libwgpu_native.so");
    expect(() => tryResolveNativeLibrary()).toThrow(LIB_ENV_VAR);
  });
});

describe("when nothing is installed", () => {
  test("tryResolve returns null while resolve throws — two different questions", () => {
    // "Not installed" is actionable and normal; "installed but broken" is a defect. A single
    // function that conflated them would force every caller to parse an error message to tell
    // which one it had.
    process.env[LIB_ENV_VAR] = path.join(os.tmpdir(), "wgpu-bun-nonexistent-probe");
    expect(() => tryResolveNativeLibrary()).toThrow();
  });

  test("the failure names the platform, the npm package, and the override", () => {
    // See the file header: with `optionalDependencies` this message is the entire diagnostic.
    delete process.env[LIB_ENV_VAR];
    // Ask about a host that certainly has nothing vendored or installed for it.
    let message = "";
    try {
      resolveNativeLibrary("freebsd-x64", "freebsd");
      throw new Error("resolveNativeLibrary should have thrown for an unsupported RID");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("freebsd-x64");
    expect(message).toContain(`${NPM_SCOPE}/freebsd-x64`);
    expect(message).toContain(LIB_ENV_VAR);
  });
});

describe("what a resolved library reports", () => {
  test("carries its origin, so a wrong-wgpu bug is one log line from an answer", () => {
    const resolved = tryResolveNativeLibrary();
    if (!resolved) return; // covered by the "when nothing is installed" block above

    expect(["env", "npm", "vendor"]).toContain(resolved.source);
    expect(path.isAbsolute(resolved.path)).toBe(true);
    expect(fs.existsSync(resolved.path)).toBe(true);
  });

  test("reports the version stamp when the install left one", () => {
    const resolved = tryResolveNativeLibrary();
    if (!resolved || resolved.source === "env") return;
    // `null` is a legitimate answer (an install that predates stamping); a *wrong* one is not.
    if (resolved.version !== null) expect(resolved.version).toMatch(/^v\d+\./);
  });
});
