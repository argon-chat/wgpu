#!/usr/bin/env bun
/**
 * Does any tracked upstream need attention, and what KIND of attention?
 *
 *     bun run check:upstream            # human-readable
 *     bun run check:upstream --json     # machine-readable, for CI
 *
 * Exit codes: 0 nothing due · 10 at least one event · 1 could not determine.
 * The three are deliberately distinct — "could not tell" must never be mistaken for "nothing new",
 * which is the failure mode that lets a watcher sit silently broken for months.
 *
 * The policies live in `upstream.manifest.ts`; the evaluation lives in `upstreamCheck.ts`; this file
 * is only the command.
 */
import { collectEvents, type IUpstreamEvent } from "./upstreamCheck.ts";

async function main(): Promise<number> {
  const json = process.argv.includes("--json");
  let events: IUpstreamEvent[];
  try {
    events = await collectEvents();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`check:upstream — could not determine: ${message}`);
    return 1;
  }

  const actionable = events.filter((e) => e.kind !== "none");
  if (json) {
    console.log(JSON.stringify({ ok: true, events, actionable: actionable.length }));
  } else {
    for (const e of events) {
      console.log(`${e.kind === "none" ? "ok  " : "DUE "} ${e.headline}`);
      if (e.kind !== "none" && e.compareUrl) console.log(`     ${e.compareUrl}`);
    }
  }
  return actionable.length > 0 ? 10 : 0;
}

process.exit(await main());
