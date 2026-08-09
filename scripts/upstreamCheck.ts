/**
 * Evaluating the upstream policies — the logic, with no CLI and no side effects.
 *
 * Two callers share it: `check-upstream.ts` (the human/CI command) and `upstream-issues.ts` (the
 * watcher's issue filing). They must agree about what counts as an event, so neither owns the rule.
 *
 * ── What changed, and why ───────────────────────────────────────────────────────────────────────
 *
 * This used to ask one question about one upstream: is any tag newer than the pinned one. That is
 * the wrong question for both projects tracked here, in opposite directions.
 *
 * For **wgpu-native** it flattens two different events into one. A new major is a different
 * wgpu-core generation and moves this package's own major; a new minor over the same generation is
 * an afternoon. Both were reported as "an update is available".
 *
 * For **Dawn** it is useless: Dawn tags every commit, roughly weekly, with no semver. "Is there
 * something newer" answers yes forever, and a watcher that is always right is a watcher nobody
 * reads. The useful question there is whether enough time has passed to take the current tip.
 *
 * The policies live in `upstream.manifest.ts`; this file only evaluates them.
 *
 * WHY NOT `semver`: neither tag scheme is semver. wgpu-native's are FOUR components
 * (`vMAJOR.MINOR.PATCH.NATIVE`, e.g. `v29.0.1.1`, where the last is its own revision over the same
 * wgpu-core); Dawn's are `vYYYYMMDD.HHMMSS`. A semver parser rejects both or silently drops a
 * component. Comparison here is plain component-wise integer ordering, which handles both.
 */

import {
  TRACKED_UPSTREAMS,
  monthsBetween,
  type IUpstream,
} from "../upstream.manifest.ts";

export interface IVersion {
  readonly tag: string;
  readonly parts: readonly number[];
}

/** `v29.0.1.1` → [29,0,1,1]; `v20260807.193620` → [20260807,193620]. Null if not a numeric tag. */
export function parseTag(tag: string): IVersion | null {
  const trimmed = tag.trim();
  if (!/^v\d+(\.\d+)*$/.test(trimmed)) return null;
  const parts = trimmed.slice(1).split(".").map(Number);
  return parts.some(Number.isNaN) ? null : { tag: trimmed, parts };
}

/** Component-wise, shorter tag padded with zeros: `v29.0.1` sorts below `v29.0.1.1`. */
function compare(a: IVersion, b: IVersion): number {
  const n = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < n; i++) {
    const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function fetchTags(repo: string): Promise<IVersion[]> {
  // Tags, not releases: a tag exists the moment upstream cuts it, whereas a GitHub *release* may
  // never be created. Paginated because the list is long and the newest is not guaranteed first.
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "wgpu-bun-upstream-watch",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["authorization"] = `Bearer ${token}`;

  const out: IVersion[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`${repo}: GitHub API ${res.status} ${res.statusText} (page ${page})`);
    const batch = (await res.json()) as { name?: string }[];
    if (batch.length === 0) break;
    for (const t of batch) {
      const v = t.name ? parseTag(t.name) : null;
      if (v) out.push(v);
    }
    if (batch.length < 100) break;
  }
  if (out.length === 0) throw new Error(`${repo}: no numeric tags returned — the API shape or tag scheme changed`);
  return out;
}

/**
 * What kind of attention an upstream needs.
 *
 * `none` is reported explicitly rather than by omission, so a run can be read as "these four were
 * checked and three were quiet" instead of "something printed nothing".
 */
export type EventKind = "none" | "major" | "minor" | "cadence-due" | "not-adopted";

export interface IUpstreamEvent {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly kind: EventKind;
  /** The tag in use, or `null` when nothing is adopted yet. */
  readonly pinned: string | null;
  /** Newest tag upstream has. */
  readonly latest: string;
  /** One sentence naming what happened — goes straight into the issue title. */
  readonly headline: string;
  /** Months since adoption, for a cadence policy; `null` otherwise. */
  readonly monthsSinceAdoption: number | null;
  readonly bumpCost: string;
  readonly compareUrl: string | null;
}

export function evaluate(u: IUpstream, tags: readonly IVersion[]): IUpstreamEvent {
  const latest = tags.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  const base = {
    id: u.id,
    name: u.name,
    repo: u.repo,
    latest: latest.tag,
    bumpCost: u.bumpCost,
  } as const;

  if (!u.adopted) {
    return {
      ...base,
      kind: "not-adopted",
      pinned: null,
      headline: `${u.name} is tracked but nothing is pinned yet — latest is ${latest.tag}`,
      monthsSinceAdoption: null,
      compareUrl: null,
    };
  }

  const pinned = parseTag(u.adopted.tag);
  if (!pinned) throw new Error(`${u.id}: adopted tag is not a numeric tag: ${u.adopted.tag}`);
  const compareUrl = `https://github.com/${u.repo}/compare/${pinned.tag}...${latest.tag}`;

  if (u.policy.kind === "cadence") {
    const months = monthsBetween(u.adopted.date);
    const due = months >= u.policy.everyMonths;
    return {
      ...base,
      kind: due ? "cadence-due" : "none",
      pinned: pinned.tag,
      monthsSinceAdoption: Number(months.toFixed(1)),
      compareUrl,
      headline: due
        ? `${u.name}: ${months.toFixed(1)} months since ${pinned.tag} — due to take the current tip (${latest.tag})`
        : `${u.name}: ${months.toFixed(1)} of ${u.policy.everyMonths} months elapsed since ${pinned.tag}`,
    };
  }

  // Versioned. A new major and a new minor are different events and are named differently, because
  // one is a week and the other is an afternoon.
  const newerMajor = (latest.parts[0] ?? 0) > (pinned.parts[0] ?? 0);
  const newer = compare(pinned, latest) < 0;
  const kind: EventKind = newerMajor ? "major" : newer ? "minor" : "none";
  return {
    ...base,
    kind,
    pinned: pinned.tag,
    monthsSinceAdoption: null,
    compareUrl,
    headline:
      kind === "major"
        ? `${u.name} ${latest.tag} is a NEW GENERATION (pinned: ${pinned.tag})`
        : kind === "minor"
          ? `${u.name} ${latest.tag} is available (pinned: ${pinned.tag})`
          : `${u.name}: up to date (${pinned.tag})`,
  };
}

/** Evaluate every tracked upstream. Throws if any of them cannot be determined. */
export async function collectEvents(): Promise<IUpstreamEvent[]> {
  return await Promise.all(TRACKED_UPSTREAMS.map(async (u) => evaluate(u, await fetchTags(u.repo))));
}
