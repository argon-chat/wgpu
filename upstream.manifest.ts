/**
 * Which upstreams this repository tracks, and on what terms.
 *
 * ── Why a policy per upstream, rather than "is there something newer" ───────────────────────────
 *
 * The old watcher asked one question — is any tag newer than the pinned one — and that question is
 * wrong for both of the projects here, in opposite directions.
 *
 * **wgpu-native** publishes rarely and every release is a decision. A new *major* is a different
 * wgpu-core generation: different validation, possibly different WGSL acceptance, and this package's
 * own major moves with it. A new *minor* over the same generation is an ordinary bump. Reporting
 * both as "an update is available" flattens a week of work and an afternoon into one sentence.
 *
 * **Dawn** publishes a release per commit, roughly weekly, with no semver and no LTS line. Asking
 * "is there something newer" answers *yes* forever, and a watcher that is always right is a watcher
 * nobody reads. What is worth knowing there is not whether Dawn moved — it always did — but whether
 * **enough time has passed** that taking the current tip is due.
 *
 * So each upstream carries a policy, and the checker reports an *event kind* rather than a boolean.
 */

import { WGPU_NATIVE_TAG } from "./wgpu-native.manifest.ts";

/** How to decide that an upstream needs attention. */
export type UpstreamPolicy =
  /**
   * Version-driven. Every new **major** is an upgrade project; every new **minor or patch** within
   * the pinned major is a routine bump. Both are reported, and they are reported differently.
   */
  | { readonly kind: "versioned" }
  /**
   * Time-driven. The upstream releases continuously, so the trigger is the calendar: adopt whatever
   * is current every `everyMonths` months. Nothing is reported in between, however many releases go
   * past.
   */
  | { readonly kind: "cadence"; readonly everyMonths: number };

/** What this repository currently builds against, and when that was decided. */
export interface IAdoption {
  /** The upstream tag in use. */
  readonly tag: string;
  /** ISO date the adoption landed — the clock a `cadence` policy measures from. */
  readonly date: string;
}

export interface IUpstream {
  /** Stable id, used in issue titles and as the dedupe key. Never rename casually. */
  readonly id: string;
  /** `owner/repo` on GitHub. */
  readonly repo: string;
  /** Human name for messages. */
  readonly name: string;
  readonly policy: UpstreamPolicy;
  /**
   * What is pinned today, or `null` when this upstream is tracked but not yet consumed — which is a
   * real state and is reported as such rather than as "up to date".
   */
  readonly adopted: IAdoption | null;
  /** One line on what a bump costs, quoted into the issue so the reader does not have to look. */
  readonly bumpCost: string;
}

export const TRACKED_UPSTREAMS: readonly IUpstream[] = [
  {
    id: "wgpu-native",
    repo: "gfx-rs/wgpu-native",
    name: "wgpu-native",
    policy: { kind: "versioned" },
    // Read from the manifest that actually drives the fetch, so the two cannot disagree. The date is
    // the day this pin was adopted, not the day upstream cut it.
    adopted: { tag: WGPU_NATIVE_TAG, date: "2026-08-07" },
    bumpCost:
      "A major is a new wgpu-core generation: re-measure hashes, regenerate layouts, re-derive the " +
      "abort-symbol list, and move this package's own major. A minor over the same generation is " +
      "hashes, layouts and a full suite run.",
  },
  {
    id: "dawn",
    repo: "google/dawn",
    name: "Dawn",
    // Six months. Dawn tags are `vYYYYMMDD.HHMMSS` per commit, so there is no version signal to
    // react to — only a date to measure against.
    policy: { kind: "cadence", everyMonths: 6 },
    // Not adopted yet: no Dawn binding ships from this repository. Tracking starts before consuming
    // on purpose — the first adoption then has a recorded date for the cadence to run from, instead
    // of the clock starting at whatever moment someone remembers to add it.
    adopted: null,
    bumpCost:
      "Dawn ships static archives only, so a bump is re-linking the shared library per platform " +
      "against the new release, then the full suite.",
  },
];

/** Look up a tracked upstream by id, or throw naming the ones that exist. */
export function upstream(id: string): IUpstream {
  const found = TRACKED_UPSTREAMS.find((u) => u.id === id);
  if (!found) {
    throw new Error(
      `unknown upstream "${id}". Tracked: ${TRACKED_UPSTREAMS.map((u) => u.id).join(", ")}.`,
    );
  }
  return found;
}

/** Months between two ISO dates, as a real number — the cadence comparison, in one place. */
export function monthsBetween(fromIso: string, to: Date = new Date()): number {
  const from = new Date(`${fromIso}T00:00:00Z`);
  if (Number.isNaN(from.getTime())) throw new Error(`adoption date is not an ISO date: ${fromIso}`);
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  // Average Gregorian month. Precision beyond this is meaningless for a six-month cadence, and a
  // calendar-exact implementation would only add edge cases nobody will ever check.
  return days / 30.436875;
}
