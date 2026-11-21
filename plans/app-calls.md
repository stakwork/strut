# App calls: what a person's open app did

Status: PROPOSED (2026-11-21). Waiting on the four rulings at the end.

## The ask

On swarm38 (2026-11-21), Paul's `tweet-engagement` app took about 15 s to
load in Hive. Jamie had only the console Paul pasted. It read the one red
line (the MCP client's `GET /mcp` 405, which the client expects and drops
without a retry) as the cause, and shipped a fix that could not have fixed
it. Jamie should read what the page actually did, itself: each call, when
it started, how long it took, how it ended, and the page's errors. That
should work in every host (strut's UI, Hive, Peel), with nothing pasted.

## What strut already has

- Every call a page makes reaches strut as `step_run` on `/mcp`, whichever
  host relays it. The door hands each one to the MONITOR
  (`src/apps/monitor.ts`) with the app, version, viewer, type, redacted
  config, status, ms, bytes and error. The monitor keeps only per-minute
  COUNTS and burst warnings, which `app/get` shows as `usage`. So "sqlite/query
  ran 40 times for 480 s in total" is there. "Paul's page waited 12 s on one
  run/list at 10:02" is not.
- The page's errors are `step_run` calls too (`app/report-error`). They are
  kept as runs, and `app/get` lists the last 50 with their actor.
- `app/look` hosts a page in strut's own UI, headless. It has no timings and
  never sees the person's frame.

## Proposal

1. **The monitor keeps a short LOG beside its counts.** For each (app,
   viewer) it keeps the recent calls, each as `{ at, version, type, status,
   ms, doorMs, bytes, error?, config? }`, in memory. There is no new store
   and no client change. Every host is covered, because every host's calls
   pass the door.
   - `at` is when the step started and `ms` is how long the step took.
     `doorMs` is the time from the request reaching `/mcp` to the step
     starting: the door's own cost (auth, building the tool set), which no
     host can see.
   - `app/report-error` is logged like any other call, so the page's errors
     sit in the timeline where they happened.
   - Previews (the builder's looks at a directory) stay out, as they stay
     out of the counts today.
2. **One step, `app/calls { name, since?, limit? }`**, under `app/*` (so the
   builder and jobs already hold it). It returns the reader's own calls on
   that app, oldest first: the newest `limit` (100 by default). Each call
   also carries `t`, the ms since the first listed call started, so a gap
   shows without date arithmetic.
3. **Docs.** `docs/apps.md`, and one line on the `App` Concept page: when
   an app is slow or failing for a person, read `app/calls`. A pasted
   console is not the record.

What it cannot see, which the step's description says: time spent outside
strut. That covers the host's relay (Hive's round trip), the document's
load, the kit's boot and the page's render. Fast calls with a long gap
between them mean the time went there. The page's own timings could come
later through the kit, the way `report-error` does: when the page started,
its first render, and each call as the page timed it (the page's ms minus
strut's ms is the relay). That is not in this change.

## Rulings needed

1. **What to record.** Recommended: the fields above plus `config`,
   redacted (each step's `redact` fields, as the monitor's examples are)
   and cut to 200 chars, because "which query was slow" is what someone
   fixes. The alternative is the type only, with no config.
2. **How long.** Recommended: memory only, for the last hour, with at most
   1,000 calls per viewer and 50 viewers per app (the one seen least
   recently is dropped first). A restart loses the log. A page polling
   three live queries makes about 90 calls a minute, so its load stays
   readable for about 10 minutes. That is about 300 KB per viewer, or
   15 MB for one app in the worst case.
3. **Who may read it.** Recommended: only your own calls. `app/calls`
   returns the calls whose viewer is the run's actor, so Paul's Jamie reads
   Paul's page and nobody reads anyone else's. A strut with no actors (dev)
   reads all of them. The alternative is what `app/get`'s errors do today:
   anyone holding `app/*` reads every viewer's calls, with a `viewer`
   filter.
4. **The counts.** Recommended: the log is the monitor's and counts
   nothing new. The usage report, the warnings and the `.usage/` files stay
   as they are, and `app/calls` reads only the log.
