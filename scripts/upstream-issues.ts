#!/usr/bin/env bun
/**
 * File one tracking issue per actionable upstream event.
 *
 *     bun run scripts/upstream-issues.ts            # needs `gh` authenticated
 *     bun run scripts/upstream-issues.ts --dry-run  # print what it would file
 *
 * Run by `.github/workflows/upstream-watch.yml`; runnable by hand.
 *
 * ── Two properties that must survive any edit ───────────────────────────────────────────────────
 *
 * **It must not file the same issue every morning.** Before creating one it looks for an OPEN issue
 * with the identical title and does nothing if it finds one. The title is therefore deterministic
 * and load-bearing — it is the event's own headline, which names the tag. Making titles prettier
 * without updating the search reintroduces a daily duplicate.
 *
 * **A run that cannot determine the state FAILS.** It never reports "nothing due". A watcher that
 * cannot tell "nothing new" from "I am broken" sits silently broken for months, which is worse than
 * not having one.
 */
import { collectEvents, type IUpstreamEvent } from "./upstreamCheck.ts";

const DRY = process.argv.includes("--dry-run");

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} → exit ${code}\n${err.trim()}`);
  return out;
}

/** The checklist a bump actually costs, which differs by event kind rather than by upstream. */
function body(e: IUpstreamEvent): string {
  const table = [
    "| | |",
    "|---|---|",
    `| pinned | ${e.pinned ? `\`${e.pinned}\`` : "_nothing yet_"} |`,
    `| upstream | \`${e.latest}\` |`,
    e.compareUrl ? `| changes | ${e.compareUrl} |` : "",
    e.monthsSinceAdoption !== null ? `| elapsed | ${e.monthsSinceAdoption} months |` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const common = [
    "- [ ] `bun run fetch --update-hashes` — new URLs and sha256 for every platform",
    "- [ ] `bun run gen:layouts`, then `bun test test/layout-oracle.test.ts` — layouts are derived",
    "      from the vendored headers and checked against a real C compiler; a bumped pin with stale",
    "      generated tables is exactly the silent-offset-shift this setup exists to prevent",
    "- [ ] confirm the upstream archive still ships no licence text, and that the committed copy",
    "      still matches the new tag",
    "- [ ] full suite on every platform the matrix covers",
  ];

  const perKind: Record<string, string[]> = {
    major: [
      "**This is a new generation, not a version bump.** The C ABI, the WGSL front end and the set",
      "of exported-but-unimplemented symbols all move between majors, and this package's own major",
      "moves with it.",
      "",
      ...common,
      "- [ ] re-derive the abort-on-call symbol list and diff it — a release may add or, better,",
      "      remove one; `bun test test/abort-symbols.test.ts`",
      "- [ ] decide whether the outgoing generation stays in `GENERATIONS` as a supported one, and",
      "      if it does, that the CI matrix still runs it (`docs/GENERATIONS.md`)",
      "- [ ] move `version` in `package.json` to the new major — a test asserts the two agree",
    ],
    minor: [
      "A minor over the same generation. Cheaper than a major, and not free: the pin still carries",
      "measured artefacts that have to be re-measured together.",
      "",
      ...common,
    ],
    "cadence-due": [
      "**Time-based, not version-based.** This upstream releases continuously and carries no semver,",
      "so the policy is to adopt whatever is current on a fixed cadence rather than to chase tags.",
      "",
      "- [ ] pick the current release and record it, with today's date, in `upstream.manifest.ts` —",
      "      the date is what the next cadence measures from, so it must be the adoption date and",
      "      not the upstream release date",
      ...common,
    ],
    "not-adopted": [
      "This upstream is **tracked but not yet consumed**. Nothing is pinned, so there is nothing to",
      "compare against and no cadence running yet.",
      "",
      "This issue exists so the state is visible rather than implicit. Either adopt a revision —",
      "record it with today's date in `upstream.manifest.ts`, which starts the cadence clock — or",
      "remove the entry if the plan changed.",
    ],
  };

  return [
    `@0xf6 — ${e.headline}`,
    "",
    table,
    "",
    e.bumpCost,
    "",
    ...(perKind[e.kind] ?? []),
    "",
    "---",
    "",
    "Opened automatically by `.github/workflows/upstream-watch.yml`. It will not file a second issue",
    "with this title while this one is open; close it to acknowledge, or keep it as the tracking",
    "issue for the work.",
  ].join("\n");
}

async function main(): Promise<number> {
  let events: IUpstreamEvent[];
  try {
    events = await collectEvents();
  } catch (e) {
    console.error(`upstream-issues — could not determine the state: ${e instanceof Error ? e.message : String(e)}`);
    console.error("A watcher that cannot tell 'nothing new' from 'I am broken' is worse than none.");
    return 1;
  }

  const actionable = events.filter((e) => e.kind !== "none");
  for (const e of events.filter((x) => x.kind === "none")) console.log(`ok   ${e.headline}`);
  if (actionable.length === 0) return 0;

  if (!DRY) {
    // Convenience, not structure: the dedupe below matches on title, so a missing or manually
    // deleted label can never cause a duplicate.
    await gh([
      "label", "create", "upstream-update",
      "--color", "0E8A16",
      "--description", "A tracked upstream needs attention",
    ]).catch(() => "");
  }

  for (const e of actionable) {
    const title = e.headline;
    if (DRY) {
      console.log(`\n──── would file ────\n${title}\n\n${body(e)}\n`);
      continue;
    }
    const open = await gh([
      "issue", "list", "--state", "open", "--search", `in:title ${e.latest}`,
      "--json", "number,title",
      "--jq", `.[] | select(.title == ${JSON.stringify(title)}) | .number`,
    ]);
    const existing = open.trim().split("\n").filter(Boolean)[0];
    if (existing) {
      console.log(`dup  #${existing} already tracks: ${title}`);
      continue;
    }
    await gh(["issue", "create", "--title", title, "--label", "upstream-update", "--body", body(e)]);
    console.log(`filed ${title}`);
  }
  return 0;
}

process.exit(await main());
