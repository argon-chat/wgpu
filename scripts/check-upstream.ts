/**
 * Is there a newer wgpu-native release than the one we pin?
 *
 * Run it by hand at any time:
 *     bun run check:upstream            # human-readable
 *     bun run check:upstream --json     # machine-readable, for CI
 *
 * Exit codes: 0 up to date · 10 an update exists · 1 could not determine.
 * The three are deliberately distinct — "could not tell" must never be mistaken for "nothing new",
 * which is the failure mode that lets a watcher sit silently broken for months.
 *
 * WHY NOT `semver`: upstream tags are FOUR components, `vMAJOR.MINOR.PATCH.NATIVE` (e.g. v29.0.1.1),
 * where the last is wgpu-native's own revision over the same wgpu-core. That is not semver, and a
 * semver parser either rejects it or silently drops the fourth number — which is precisely the digit
 * that changes most often. The comparison here is plain component-wise integer ordering.
 */

const REPO = "gfx-rs/wgpu-native";
const MANIFEST = new URL("../wgpu-native.manifest.ts", import.meta.url);

interface Version {
  readonly tag: string;
  readonly parts: readonly number[];
}

/** `v29.0.1.1` → [29,0,1,1]. Returns null for anything that is not a plain numeric tag. */
function parseTag(tag: string): Version | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(tag.trim());
  if (!m) return null;
  const parts = m.slice(1).filter((p): p is string => p !== undefined).map(Number);
  return parts.some(Number.isNaN) ? null : { tag: tag.trim(), parts };
}

/** Component-wise, shorter tag padded with zeros: v29.0.1 sorts below v29.0.1.1. */
function compare(a: Version, b: Version): number {
  const n = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < n; i++) {
    const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function readPinnedTag(): Promise<Version> {
  const src = await Bun.file(MANIFEST).text();
  // Matches the literal declaration; the manifest keeps it un-templated precisely so it stays
  // greppable by tooling like this.
  const m = /WGPU_NATIVE_TAG\s*=\s*["'`](v[^"'`]+)["'`]/.exec(src);
  if (!m?.[1]) throw new Error("WGPU_NATIVE_TAG not found in wgpu-native.manifest.ts");
  const parsed = parseTag(m[1]);
  if (!parsed) throw new Error(`WGPU_NATIVE_TAG is not a numeric tag: ${m[1]}`);
  return parsed;
}

async function fetchUpstreamTags(): Promise<Version[]> {
  // Tags, not releases: a tag exists the moment upstream cuts it, whereas a GitHub *release* may
  // never be created. Paginated because the tag list is long and the newest is not guaranteed first.
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "wgpu-bun-upstream-watch",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["authorization"] = `Bearer ${token}`;

  const out: Version[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} (page ${page})`);
    const batch = (await res.json()) as { name?: string }[];
    if (batch.length === 0) break;
    for (const t of batch) {
      const v = t.name ? parseTag(t.name) : null;
      if (v) out.push(v);
    }
    if (batch.length < 100) break;
  }
  if (out.length === 0) throw new Error("no numeric tags returned — the API shape or tag scheme changed");
  return out;
}

async function main(): Promise<number> {
  const json = process.argv.includes("--json");
  let pinned: Version;
  let latest: Version;
  try {
    pinned = await readPinnedTag();
    const tags = await fetchUpstreamTags();
    latest = tags.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`check:upstream — could not determine: ${message}`);
    return 1;
  }

  const behind = compare(pinned, latest) < 0;
  if (json) {
    console.log(JSON.stringify({ ok: true, behind, pinned: pinned.tag, latest: latest.tag }));
  } else if (behind) {
    console.log(`check:upstream — UPDATE AVAILABLE: pinned ${pinned.tag}, upstream ${latest.tag}`);
    console.log(`  https://github.com/${REPO}/compare/${pinned.tag}...${latest.tag}`);
  } else {
    console.log(`check:upstream — up to date (${pinned.tag})`);
  }
  return behind ? 10 : 0;
}

process.exit(await main());
