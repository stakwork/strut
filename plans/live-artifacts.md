# Live artifacts: a job tells its host what changed, as it changes

> **Status (2026-10-15): proposed**, from one design conversation with the
> owner. The rows in "Decided" are his. The rows marked *proposed* are
> mine and open to a ruling. Nothing is built. Companion to `jobs.md` (the
> job, its directory, holds and deliverables), `job-index.md` (the read
> side), `job-claims.md` (the checks and `browser/verify`, which the
> walkthrough extends) and `specs/CALLBACKS.md` (the run callback this sits
> beside). The `browser/*` steps live in the stakgraph repo
> (`mcp/src/lab/browser`). Hive's half is described here only as the
> contract it reads.

## Problem

A job's host learns what happened only when a turn ends. The `run.end`
callback carries the turn's declared `artifacts[]`, and hive renders them
as cards. While a turn runs, or while a verify pass runs, the host sees
nothing. That covers a screenshot the agent just took, a pod it just
claimed, and the evidence a check just wrote. A person who clicks
**Verify** in hive waits for the whole pass (`POST /jobs/:id/verify`
answers only once every check is done) and then gets everything at once.

Separately, the instrument for "this feature works" is one screenshot.
`browser/verify` opens a page, drives a declared step list, and shoots
once, where the page got to (`service.ts` `verify`, mcp). A new sidebar
item is well served by one frame. A flow through three pages isn't: the
person wants to scrub through it, step by step, with a line saying what
each frame is.

| Has | Lacks |
| --- | --- |
| `run.end` callback with the turn's deliverables, resolved to links (`artifact-refs.ts`) | any word from a run before it ends |
| holds on the job record (`jobs.ts`), evidence in the claims ledger, shots as job files | a way for the host to hear that one of them changed |
| `browser/verify`: open → `drive(steps)` → settle → **one** shot → judge | a frame per step, captions, a viewer that scrubs |
| `POST /jobs/:id/verify`, the person's door (`claims-routes.ts`) | an answer before the pass ends |
| hive's artifact index by URL (`StrutJobArtifact`, the artifact-events work) | an entry for anything that isn't an inline deliverable |

## Decided

| Question | Decision |
| --- | --- |
| A walkthrough step, or frames on `browser/verify`? | **A separate `browser/walkthrough` step.** Most UI changes are proven by one screenshot (a new page, a new sidebar item); only some need a sequence, and the agent chooses. The two share `drive()` underneath |
| What a walkthrough is | **A directory of PNGs plus one manifest** (`walkthrough.json`): order, captions, the page URL per frame, where it stopped. A directory listing can't carry those |
| How the host hears about changes | **A callback, not polling.** Live screenshots, walkthroughs, pods and evidence are all the same kind of event, and more kinds will come |
| Does the agent's output change? | **No.** The agent still ends its turn with `{ text, artifacts }` in `job.yaml`'s schema. `pack`, `run.end` and the deliverables fold don't change. Live events come from **tools** (steps) as a side effect of what they do. The model never calls an "event tool" and its prompt doesn't change |
| Is an event the source of truth? | **Never.** Every event points at something that already has a home: a job file, a hold, a piece of evidence, a deliverable. A missed event costs only latency; the host re-reads `GET /jobs/:id` |
| How a live item and a final deliverable are matched | **By URL, not by id.** The step picks the event; the model picks the deliverable's `id`. Both resolve a job file to `/jobs/<job>/files/<path>`, so the URL is what joins them. The id still names versions across turns |
| A contact sheet for the model | **No.** Tiles at model size are too small to read, and the model already saw each page while exploring. It gets the verdict, the last frame (or the one where it stopped), and the frame paths for `job/read` |

## Design in one paragraph

A host that wants live updates registers a **job callback**: a URL stored
on the job, not the run, so every run under the job reaches it. That
includes turns, child runs and verify passes. Strut keeps it beside the
record and never serves it. `ctx.services.jobs.notify(job, update)` posts
a `job.update` event there: the kind, a link, a state and a small detail.
It does nothing when no callback is registered. Strut emits on its own for
what it owns (a hold taken or released, evidence written, a verify pass
ended). Steps emit for files they write: a browser screenshot, and every
frame of the new `browser/walkthrough`. The walkthrough records a
directory with a manifest it rewrites after each frame, and answers the
claim's check contract like `browser/verify`, its locator being the
manifest. Posts are ordered per job and coalesced per thing, so a burst of
frames is one post for the latest state. The host joins a live item to the
turn's declared deliverable by URL. Strut's viewer and hive's card render
`walkthrough.json` as a scrubber. `POST /jobs/:id/verify` can return at
once, so hive's Verify button shows frames and verdicts as they land.

## 1. The job callback

**Registration** (*proposed*): a launch field beside `job`, `title` and
`callback`. It is never in `input`, for the reason `title` isn't: strut
writes it onto the job without knowing the workflow.

```
POST /workflows/job/run
{ "job": "j-123", "title": "…", "input": {…},
  "callback":    { "url": "https://hive…/api/strut-runs/webhook?id=…&token=…" },
  "jobCallback": { "url": "https://hive…/api/strut-jobs/events?job=…&token=…" } }
```

The two URLs are different on purpose. Hive's run webhook is per run (a
row id and a token, claimed `PENDING → terminal` once). The job's events
need a job-scoped endpoint and token. The latest launch that carries
`jobCallback` wins, so hive can rotate its token with any turn;
`jobCallback: null` clears it. The 202 carries `jobCallback: true`, the
host's proof this server honors it, as `callback: true` does today.

**Storage**: the URL is a credential, the run callback's rule. It is kept
in a file beside the record, `<dataDir>/jobs/<encoded id>.callback.json`,
not in `JobRecord`, so the index (`GET /jobs[/:id]`, `job/get`) can't serve
it by accident. The record's other readers never see it. `run.start`
records `jobCallback: { origin }` only. `DELETE /jobs/:id` and the sweep
remove the file with the record.

**Gate**: no callback on the job, no post. A plain run, a job launched
without one, and a desktop strut behave exactly as today.

## 2. The event

```ts
interface JobUpdate {
  event: "job.update";
  job: string;
  at: string;                 // ISO, when strut made the change
  runId?: string;             // the run that made it, when one did
  kind: string;               // passed through: "walkthrough" | "image" | "pod" | "evidence" | "verify" | …
  url?: string;               // the thing's link: a job file as /jobs/<job>/files/<path>, a hold's url
  id?: string;                // the thing's own id where it has one: a hold id, a claim id
  title?: string;
  state?: string;             // "recording" | "done" | "stopped" | "held" | "released" | "supported" | "refuted" | …
  detail?: Record<string, unknown>;  // small and kind-specific: { frames: 3 }, { claim, check }
}
```

It carries metadata and links, never bytes. The host fetches content the
way it fetches a deliverable today. `kind` and `state` are passed through;
strut reads neither.

**Delivery**: `postCallback` (`callback.ts`) as for runs and chats: one
JSON POST, a few retries, never throws, never awaited by the work it
reports on. The URL is logged by origin only.

**Order and coalescing** (*proposed*): posts for one job go through one
chain, in order. Before a post leaves, a newer update for the same thing
(`kind` + `url ?? id`) replaces it in the queue. A walkthrough recording
ten frames while one post is in flight therefore sends at most two: the
one in flight and the latest. Nothing is lost by merging, since every
update points at the current state. No timers, no sequence numbers.

**What a restart drops**: the queue is in-process, the notifier's posture.
A post in flight at a crash is gone. The host's fallback is the read
(`GET /jobs/:id`, the claims ledger, the manifest), and the turn's
`run.end` still arrives (a resumed run posts it, `CALLBACKS.md`).

## 3. Who emits

`JobsCapability` gains one method:

```ts
/** Tell the job's host that something changed (plans/live-artifacts.md).
 *  Fire and forget: never throws, never waits, a no-op without a job callback. */
notify?(job: string, update: Omit<JobUpdate, "event" | "job" | "at">): void;
```

It is optional, like `claims`: a bare bag has none, and a step calls
`ctx.services.jobs?.notify?.(ctx.job, …)` only when `ctx.job` is set.

| Emitter | When | `kind` / `state` | `url` / `id` |
| --- | --- | --- | --- |
| strut, `jobs.hold` | a hold is taken or replaced | the hold's `kind` (`pod`) / `held` | the hold's `url` / its `id` |
| strut, `jobs.release` and the sweep | a hold is let go | the hold's `kind` / `released` | the hold's `url` / its `id` |
| strut, the verify pass | a check's evidence is written for a job subject | `evidence` / the verdict | the evidence locator's url / the claim id; `detail: { check, status }` |
| strut, the verify pass | a job's pass ends | `verify` / `done` | — / —; `detail` the per-claim statuses (the ledger's shape, slim) |
| lab, `browser/screenshot`, `capture`, `verify` | a shot is written on a job run | `image` / `done` | the shot's url (`shot.ts`) |
| lab, `browser/walkthrough` | after each frame, and at the end | `walkthrough` / `recording` → `done` or `stopped` | the manifest's url; `detail: { frames }` |

Strut emits for holds and evidence by itself (*proposed*), so `pod/*` and
the instruments need no change for those. A verify pass's check run
carries the job (`RunStepOptions.job`), so a `browser/walkthrough` run as a
check emits its frames like one run mid-turn.

## 4. `browser/walkthrough` (lab)

**Input**: `browser/verify`'s, with one addition per step and one at the
top.

```yaml
type: browser/walkthrough
config:
  title: Switch billing to annual
  url: "{{ input.urls.pod }}/settings"
  caption: Open settings                # the opening frame's caption (default: the page title)
  steps:
    - { do: click, selector: "text=Billing", caption: Click Billing }
    - { do: wait,  text: "Plan" }          # no caption: no frame
    - { do: click, selector: "text=Annual", caption: Switch to annual }
  expect: { text: ["Billed yearly"], noErrors: true }
```

**Frames**: frame 1 is the opened page. After each step that has a
`caption`, the page settles (`settlePage`) and a frame is taken. A step
with no caption (a `wait`, a `fill`) takes none. If the last step had no
caption, a final frame is taken where the page got to, as `verify` does.
On a step that fails, or an expectation that does not hold, a final frame
of where the page got to is marked `failed` with the reason, and the
recording ends `stopped`. Frames are capped (*proposed*: 30); a list
asking for more is refused before anything runs.

Settling before each frame removes loading states. Dead ends are removed
by construction: the agent explores with the atomic `browser/*` steps,
then writes down the path that worked, and the walkthrough replays only
that list.

**On disk**: a new directory per recording, next free number, under the
shot sink's root (the job's directory on a job run, else the run's
artifacts):

```
walkthroughs/004/
  walkthrough.json
  01.png  02.png  03.png
```

```json
{
  "title": "Switch billing to annual",
  "url": "https://…/settings",
  "status": "recording",
  "frames": [
    { "file": "01.png", "caption": "Open settings",   "pageUrl": "…/settings",         "ms": 0 },
    { "file": "02.png", "caption": "Click Billing",   "pageUrl": "…/settings/billing", "ms": 1840,
      "step": { "do": "click", "selector": "text=Billing" } },
    { "file": "03.png", "caption": "Switch to annual", "pageUrl": "…/settings/billing", "ms": 3120,
      "step": { "do": "click", "selector": "text=Annual" } }
  ],
  "failed": []
}
```

The manifest is written after each frame (to a temp file, then renamed, so
a reader never sees half a file) and once more at the end with `status`
`done` or `stopped`. Each write is one `notify`. A directory is never
overwritten: turn 3's evidence keeps showing turn 3's frames. A
deliverable `id` the model reuses across turns points at the newest
directory, the existing "same id = newer version" rule.

**Output**: the check contract, as `browser/verify` returns it, plus the
frames.

```ts
{ supports, content, failed, errors, pageUrl, title,
  locator: { path: "walkthroughs/004/walkthrough.json", url: "/jobs/<job>/files/walkthroughs/004/walkthrough.json" },
  frames: [{ file, caption, url }], kind: "walkthrough" }
```

As a claim's check, the evidence's locator is the manifest, so the claims
card opens the scrubber, and a refutation shows the frames up to the one
that broke. As an agent tool, the model sees the JSON and **one** frame at
0.6× (the last, or the failed one) via `withMedia`. Any other frame is a
`job/read` away.

**Cost**: a settle plus a screenshot per frame, roughly 0.5–1 s each,
counted against the run's browser budget like any other call.

## 5. Matching a live item to a deliverable

The agent declares a walkthrough it wants the person to keep the way it
declares any file: `{ id, title, path: "walkthroughs/004/walkthrough.json" }`.
That path resolves to `/jobs/<job>/files/walkthroughs/004/walkthrough.json`
(`artifact-refs.ts`), the same URL the step's events carried. The host
upserts live items by URL and, when `run.end` arrives, lets a deliverable
with a matching URL take the live item's place (the model's `id` and
`title` win). A live item no deliverable claims is progress: hive shows it
in an activity strip or drops it at turn end, its choice.

Two small changes keep the URLs equal:

- **One helper** (*proposed*), `jobFileUrl(job, rel)` in strut, used by
  `artifact-refs.ts` and exported for the lab's shot sink (`shot.ts`), so
  the two can never encode a path differently.
- **The kind by filename** (*proposed*): `artifactKind` in
  `artifact-refs.ts` and in `web/src/artifact-view.ts` reads a file named
  `walkthrough.json` as `walkthrough`. Otherwise `.json` is plain JSON, and
  the model would have to remember to set `kind`.

The job prompt gets one line: list a file by the path the tool gave you.
A copy or a rename only means two items, one of them progress.

## 6. Viewing

**Strut**: `ArtifactViewer` gains a `walkthrough` view. It reads the
manifest, resolves each frame against the manifest's directory
(`resolveArtifactLink`), and shows the frame large, a slider and filmstrip
under it, the caption and page URL, arrow keys to step, and a stopped
recording's last frame marked with its reason. Until then, pointing at the
directory already works: the viewer lists one level of files, the frames
in order with no captions. Strut's own UI reads on open; live updates in
strut's UI are not part of this plan.

**Hive** (its half, as the contract it reads):

- an endpoint for `job.update` with a job-scoped token, registered as
  `jobCallback` on every turn launch;
- the event forwarded to the browser over hive's existing realtime
  channel, merged into the job's view by URL;
- a `walkthrough` renderer: fetch the manifest and the frames by URL,
  the same scrubber;
- **Verify** calls the detached verify below and renders `evidence` and
  `walkthrough` events as they arrive, then re-reads the claims when
  `verify / done` lands.

No new table is needed for this: everything that outlives the moment
(deliverables, holds, evidence) already has a home hive reads.

## 7. Detached verify

`POST /jobs/:id/verify { claims?, detach: true }` (*proposed*) starts
`verifyJob` without awaiting it and answers 202 `{ started: true }`. The
pass emits `evidence` per check and `verify / done` at the end (§3). The
synchronous form stays the default for strut's own UI and scripts. A
second detached verify of a job while one is in flight is 409 (an
in-process set, like the chat's liveness).

## 8. Not now

- **A contact sheet** for the model (Decided).
- **A video** (MP4/GIF from the frames): an `ffmpeg` pass beside the
  directory if someone asks; the directory stays the source.
- **The agent pushing a draft mid-turn** (`plan.html` half-written): a
  grantable `job/publish { id, path }` step making the same `notify` call.
  Not needed for walkthroughs or pods.
- **Sequence numbers and replay**: hive reconciles by reading. Add them if
  a host ever needs an exact event history.
- **Live updates in strut's own UI** (`JobTimeline`): it reads on open.
- **A strut-side event log for jobs**: events are notifications, not
  records.

## 9. Work order

1. **strut** (one PR): `jobCallback` on the launch + its file + delete/sweep;
   `JobsCapability.notify` with the per-job ordered, coalescing queue;
   emits from `hold` / `release` / the sweep and from the verify pass;
   `POST /jobs/:id/verify { detach }`; `jobFileUrl`; the `walkthrough.json`
   kind in both `artifactKind`s and the `ArtifactViewer` scrubber; docs in
   `specs/CALLBACKS.md` (a §5 for `job.update`) and `specs/API.md`; tests
   for the gate, the coalescing, the never-served URL and the viewer's
   pure parts.
2. **mcp** (after 1 merges, a pin bump): `browser/walkthrough` + the
   service's frame loop; `notify` from the shot sink on job runs; the job
   seed's prompt line about paths.
3. **hive** (after 2 deploys): the events endpoint and token, `jobCallback`
   on `launchJobTurn`, the realtime forward, the URL merge, the
   `walkthrough` renderer, Verify through the detached door.

## Open for a ruling

1. `jobCallback` as a launch field (latest wins), or a `PUT /jobs/:id/callback`
   of its own?
2. Strut emitting for holds and evidence on its own (§3), or only what a
   step asks for?
3. The kind from the filename `walkthrough.json` (§5), or always explicit?
4. The frame cap (30), and frame 1 always being the opened page?
5. A detached verify as `{ detach: true }` on the existing route, or a
   default change (202 always) once hive is the only caller that needs the
   wait gone?
