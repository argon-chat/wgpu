/**
 * The upstream watcher: what it is pinned to, and what it decides.
 *
 * ── Why the first block exists ──────────────────────────────────────────────────────────────────
 *
 * The watcher filed issue #1, "Dawn is tracked but nothing is pinned yet", on the same day three
 * linked Dawn libraries went green in CI. Both statements were true of their own file: `dawn.
 * manifest.ts` held the pin the build fetches, and `upstream.manifest.ts` held a separate `adopted:
 * null`. Two records of "which revision do we ship", and they diverged the moment one was updated.
 *
 * wgpu-native never had that problem because its entry imports `WGPU_NATIVE_TAG` instead of
 * repeating it. The test below makes that the rule rather than one entry's good habit: every tracked
 * upstream must derive its pin from the manifest that actually drives the fetch, and a new upstream
 * cannot be added without saying which manifest that is.
 */

import { describe, expect, test } from "bun:test";

import { DAWN_TAG } from "../dawn.manifest.ts";
import { evaluate, parseTag } from "../scripts/upstreamCheck.ts";
import { monthsBetween, TRACKED_UPSTREAMS, upstream } from "../upstream.manifest.ts";
import { WGPU_NATIVE_TAG } from "../wgpu-native.manifest.ts";

/**
 * Where each upstream's pin really lives.
 *
 * `null` means "tracked but not consumed" — a legitimate state, and one this table forces someone to
 * declare deliberately rather than reach by forgetting to wire a new entry up.
 */
const BUILD_PIN: Readonly<Record<string, string | null>> = {
  "wgpu-native": WGPU_NATIVE_TAG,
  dawn: DAWN_TAG,
};

describe("what the watcher thinks is pinned", () => {
  test("every tracked upstream is accounted for here", () => {
    expect(TRACKED_UPSTREAMS.map((u) => u.id).sort()).toEqual(Object.keys(BUILD_PIN).sort());
  });

  for (const u of TRACKED_UPSTREAMS) {
    test(`${u.id}: the adopted tag is the one the build fetches`, () => {
      expect(u.adopted?.tag ?? null).toBe(BUILD_PIN[u.id] ?? null);
    });

    test(`${u.id}: the adoption date is a real past date`, () => {
      if (!u.adopted) return expect(u.adopted).toBeNull();
      // A future date silently disables a cadence policy — `monthsBetween` goes negative and nothing
      // is ever due. Cheap to check, invisible otherwise.
      expect(monthsBetween(u.adopted.date)).toBeGreaterThanOrEqual(0);
    });

    test(`${u.id}: the adopted tag is one the checker can parse`, () => {
      if (!u.adopted) return expect(u.adopted).toBeNull();
      // `evaluate` throws on an unparseable pin, and it throws inside a scheduled workflow where
      // nobody is watching. Both tag shapes in use — `v29.0.1.1` and `v20260807.193620` — go
      // through the same parser.
      expect(parseTag(u.adopted.tag)).not.toBeNull();
    });
  }
});

describe("what the watcher decides", () => {
  const tags = (...list: string[]) => list.map((t) => parseTag(t)!);

  test("a cadence upstream is quiet until the months elapse", () => {
    const dawn = upstream("dawn");
    const fresh = evaluate({ ...dawn, adopted: { tag: DAWN_TAG, date: isoMonthsAgo(2) } }, tags(DAWN_TAG, "v20260901.120000"));
    expect(fresh.kind).toBe("none");

    const due = evaluate({ ...dawn, adopted: { tag: DAWN_TAG, date: isoMonthsAgo(7) } }, tags(DAWN_TAG, "v20260901.120000"));
    expect(due.kind).toBe("cadence-due");
    // The point of a cadence policy: the report is about elapsed time, not about how many releases
    // went past. Dawn tags every commit, so "something is newer" is true forever and worth nothing.
    expect(due.headline).toContain("months since");
  });

  test("a versioned upstream separates a new generation from a routine bump", () => {
    const native = upstream("wgpu-native");
    expect(evaluate(native, tags(WGPU_NATIVE_TAG)).kind).toBe("none");
    expect(evaluate(native, tags(WGPU_NATIVE_TAG, "v29.0.2.1")).kind).toBe("minor");
    expect(evaluate(native, tags(WGPU_NATIVE_TAG, "v30.0.0.1")).kind).toBe("major");
    expect(evaluate(native, tags(WGPU_NATIVE_TAG, "v30.0.0.1")).headline).toContain("NEW GENERATION");
  });

  test("an unadopted upstream reports that state instead of 'up to date'", () => {
    const event = evaluate({ ...upstream("dawn"), adopted: null }, tags("v20260901.120000"));
    expect(event.kind).toBe("not-adopted");
    expect(event.pinned).toBeNull();
  });
});

/** An ISO date roughly `months` in the past — the cadence clock's input. */
function isoMonthsAgo(months: number): string {
  const d = new Date(Date.now() - months * 30.436875 * 86_400_000);
  return d.toISOString().slice(0, 10);
}
