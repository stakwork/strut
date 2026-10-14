# Job claims — evidence that the work got done

> **Status (2026-10-14): built in strut**, from one design conversation
> with the owner. The rulings in "Decided" are his; the rows marked
> *proposed* are mine, built as proposed and open to a ruling; §1's fixed
> point 1 he ruled on (A: on a job an `ai` author may add a check to a
> person's claim), and it is built so. Items 1–5, 7 and 8 of §10 are built; 6 (the web UI) is a
> second PR; 9 (the lab) and 10 (hive) follow the pin bump. Companion to
> `claims.md` (the layer this reuses — read its Design and §4 first),
> `jobs.md` (the job, its directory, holds and deliverables),
> `job-index.md` (the read side this extends) and `job-artifact-events.md`
> (the door a person's feedback comes back through). The lab's `browser/*`
> steps and `pod/*` steps live in the stakgraph repo (`mcp/src/lab`), as
> does the `job` seed's delta.

## Problem

The claims layer verifies TEMPLATES. A claim is `ABOUT` a step type or a
workflow — how it should behave on every run — and a run of `job` is
verified against `job`'s own claims: every declared path resolves, `text`
is non-empty, no secret-looking key in the output. Those say the agent
answered in the right shape. Nothing says the work is done.

What a person who hands strut a job wants verified is the WORK: the page
exists, the app still builds and renders, the new route can be reached,
the endpoint answers as asked. That is a statement about one job's product,
born with the request, satisfied once, and it can be true after a dozen
turns of three workflows and a pod's coding agent — or false again after
the next. Today the person reads the agent's `text`, opens the pod's
frontend, and clicks around. The agent reads nothing: it reports "done"
when its last tool call returned.

The pieces are all there and none of them meets:

| Has | Lacks |
| --- | --- |
| `Claim` / `Check` / `Evidence`, status computed on read, planned slots a person fills, `observed` vs `asserted`, a budget (`claims.md`) | a subject that is a job; a version axis for something that has turns instead of versions |
| the verify pass after every top-level run, `meta/verify-run`, the ledger in tool results | a verify a turn can call on ITSELF before it reports; a ledger anyone sees for a run hive launched (no chat is woken, the callback carries no ledger) |
| `browser/capture` with a declared step list, `browser-explore`, `pod/run-tests`, the `http` step | an instrument that returns the check contract with the screenshot as its locator; one for an endpoint |
| `StrutJob`, `IN_JOB`, the job index with the deliverables fold and the holds | a claim hanging off the node; the pod URL on the hold in a field a template can read |
| hive's artifact cards per turn, the `run_graph` card hive adds itself, the artifact-event door | a card for the job's claims; a way to say "refuted, because…" that becomes a turn |

## Decided

| Question | Decision |
| --- | --- |
| Is this a new layer? | **No — a third subject kind.** The same three nodes, the same edges, the same status rule. `Claim —ABOUT→ StrutJob` already resolves: `ABOUT → Thing` and every Strut schema is Thing-parented. The template claims on `job` the workflow stay what they are |
| The version of a job | **The turn** (*proposed*). Evidence is `ABOUT` the turn's `StrutRun`; the active version is the job's newest top-level run; a later turn makes earlier evidence `stale`. `claimStatus()` is untouched but for one line: a job's stream has one measurement per pass (the newest evidence alone decides), where a step's groups a foreach's iterations by source run — else an appended re-verify (below) could never lift a refutation on the same turn |
| When a check runs | **`manual` by default.** The work agent verifies when it says the work is ready — before it reports, so the verdict rides with the turn — and a person verifies any time from the card. Between verifies the ledger reads `stale`, which is the truth. Intermediate turns are mid-work and a dropped pod is not to be poked |
| The instrument | **A step per surface that returns the check contract**: `browser/verify` (lab) drives a declared step list and shoots, `http/verify` (strut) calls an endpoint, and anything behind a shell is the exit-code mapping that already exists (`exec` in the job directory, `pod/run-tests`). A check is one line of config; a bespoke workflow of atomic `browser/*` steps when the list cannot say it |
| The screenshot | **Is the evidence's locator, not the evidence.** The step decides `supports`; the PNG is a job file the locator points at, what a person audits and what an external check's slot is answered from |
| `StrutArtifact` | **Not now.** Claims are per job; the artifact id is the obvious subject for a later per-deliverable split, and nothing here needs a node to point at |
| What hive shows | **One `claims` card per job**, hive's own like `run_graph`, every turn a version, read from the swarm after the turn beside the artifact list. The check run is neither a turn nor an artifact |
| Feedback | **Supports / Refutes on a slot is a write, no turn. A refutation with a note is a turn**, one line through the artifact-event door, so the agent fixes and re-verifies |
| Fixed point 1 on a job | **Ruled A (2026-10-14): on a job subject an `ai` author may add a check to a person's claim; the person's external check stays beside it** as a separate stream. Edit / retire / detach stay scoped to the author; on a template the rule is untouched |

## Design in one paragraph

The work agent, or the person from hive, states what the job must deliver
as claims `ABOUT` the job — `{ kind: "job", name: <id> }` — each with a
check: a `browser/verify` with the route and the expectations, an
`http/verify` with the request and the expected answer, an `exec` or a
pod test run, or an external check when only a person can tell. Checks on
a job default to `manual`. When the agent believes a turn finished the
work it calls `meta/verify-job`: the pass builds the job's subject from
the index (its directory, its current deliverables, its holds with their
URLs, this turn's output), runs every check whose policy fires, and writes
evidence `ABOUT` this turn's run, each with its screenshot or response
excerpt on the locator; the agent reads the ledger in the tool result,
fixes what is refuted, verifies again, and only then answers. The run's
`run.end` reaches hive as today; the job-turn handler reads
`GET /jobs/:id/claims` beside the artifacts and lands a `claims` card
with the reply: status per claim, the latest evidence, the screenshot
inline, "verified on this turn". A later turn makes it `stale` until
someone verifies again — the agent at its next "done", or the person with
the card's Verify button, which calls the swarm directly and re-reads. A
person's Supports / Refutes fills the slot; a refutation with a note goes
back to the job as `[claim-event]` and the agent picks it up.

## 1. The subject

`SubjectRef` (`src/graph/claims.ts`) gains `{ kind: "job"; id: string }`;
`subjectName` returns the id; `SUBJECT_NODE.job` is `{ label: "StrutJob",
key: "job_id", version: "StrutRun" }`. `subjectsOf`, `claimsFor` and
`evidenceRows` learn the third label; an `ABOUT` target that is a
`StrutRun` reads back as `about: { kind: "job", name: r.job, content_hash:
r.run_id }` (`StrutRun.job` is stamped by the projector since
`job-index.md` §6). `subjectSchema` (`claims-schemas.ts`) adds `job` to the
enum, `name` being the job id, so every door — the nine chat tools, their
`meta/*` twins, the panel's routes, the `claims` publish arg — takes a job
subject with no new tool.

**The node must exist when the claim is written.** The projector upserts
`StrutJob` at run END, and the agent authors during its first turn. The
authoring layer's `subjectRefId` for a job therefore upserts the node from
the record when it is missing (the projector's `StrutJob` write lifted into
a shared `ensureJobNode(jobs.get(id))`; one line in the record is enough —
`recordRun` writes it at `run.start`). A job that is not on file (no
record, no runs) is refused like a workflow that does not exist. Deleting
a job keeps the node and its claims, as `job-index.md` §6 keeps the node.

**Who writes, and fixed point 1.** Three authors, three stamps, the rules
of `claims.md` §4.1:

- the work agent through `meta/add-claim` / `meta/add-check` /
  `meta/list-claims` / `meta/edit-check` (granted by the seed, §10):
  stamped `ai`, scoped — it edits and retires only its own;
- the person from hive or the strut timeline through `POST /claims` and
  its siblings: stamped `person`, unscoped;
- a YAML `claims:` block: never — a job is an instance, not a template.

Fixed point 1 says an `ai` author may add a check only to a claim stamped
`ai`. For a job that bites: the person writes "the settings page renders"
from hive, and the agent cannot hang its `browser/verify` on it.
*Ruled A (2026-10-14; built — `addCheck` skips the ownership check when the claim's subjects include a job):* for a job subject an `ai` author MAY add a check to a person's
claim. The person's own check — an external one, opened as a slot — stays
beside it as a separate stream, the ledger still reports `openSlot` and
`assertedOnly` on their own, and the thing fixed point 1 guards against (a
seeded contract line silenced by an always-passing check) has no seeded
line here: the person's claim is the acceptance criterion and the person
reads the screenshot. (The alternative, not taken: every person's claim
gets an external check by default and the prompt tells the agent to
author its own mirror of the ask.) The scoping on edit / retire / detach
is unchanged.

## 2. The version is the turn

A workflow has versions and runs observe one of them; a job has turns, and
the work is whatever the last turn left. So for a job subject the version
IS the run:

- `Evidence —ABOUT→ StrutRun` (the turn observed) and `—HAS_SOURCE→` the
  same run. `context.path` is unused for a job; `context.turn` carries the
  run id for readers that do not follow the edge;
- the active version is the newest top-level run on the job's RECORD
  (`jobs.get(id).runs`, no `parentRunId`) — written at `run.start`, so a
  turn in flight is already the newest. `ClaimsReader.activeVersion` takes
  a `jobs: Pick<JobIndex, "get">` dep for this kind; createStrut has it;
- `claimStatus()` then reads as it does: a verdict about the active turn
  is `supported` / `refuted`, one about an earlier turn is `stale`, none is
  `unknown`. `on_change` means "fires once per turn".

**Only the newest turn is ever verified** (*proposed*). The pass today
reads logs and can backfill any old run. A job check reads a LIVE app:
verifying turn nine at turn twelve observes turn twelve's app and would
file it under nine. So a job subject whose version is not the active one
is skipped `superseded` (a new `SkipReason`), by the automatic pass and by
an explicit one alike; the run's step and workflow subjects verify as
before. Nothing about a job is backfilled.

**An explicit verify of the same turn appends** (*proposed*). Evidence ids
are `sha256(check | run | path)` so a second pass over one run writes
nothing — right for logs, wrong for a pod that answered a 500 mid-restart
and is up now. For a job subject the pass uses `path = job:<id>#<n>`, `n`
counting this check's evidence on this turn, so an explicit verify writes
a new node and `newestFirst` picks it. The automatic pass is idempotent as
before (`n = 0`, create mode). Racing passes are single-flighted per run
as today.

**A fingerprint instead of the turn** — a hash of the kept checkouts' HEAD
commits, the deliverables' bytes, the pod's branch — would spare a
re-verify after a chat-only turn. The code of a pod job is not on this
disk, so the fingerprint is host-dependent; with `manual` as the default
the turn is enough, and a fingerprint can replace the run on the `ABOUT`
edge later without touching the claims. Left out.

## 3. What a job check reads

The verify pass rebuilds a step's subject from the event log. A job's
subject is its STATE, read from the index (`src/job-index.ts`, `get`) at
verify time:

```ts
interface JobCheckSubject {
  job: string;
  runId: string;          // the turn this evidence will be ABOUT
  dir: string;            // <dataDir>/jobs/<id>/ — an exec check's cwd
  repos: string[];        // checked out into it, relative
  artifacts: JobArtifact[]; // the fold: current deliverables with url + path
  holds: JobHold[];       // id, kind, note, since, url?
  urls: Record<string, string>; // the first hold of each kind that has a url: { pod: "https://…" }
  output?: unknown;       // the turn's output as packed
  text?: string;          // its reply
}
```

So a check's config says `url: "{{ input.urls.pod }}/settings"` and
survives a dropped and re-claimed pod without an edit, `cwd: "{{ input.dir }}"`
runs a script over the job's files, and `{{ input.artifacts }}` names the
page the claim is about. The subject is built once per pass and handed to
every job check, the `artifactsDir` of a step subject's twin.

**`url` on a hold.** `JobHold` (`src/jobs.ts`) gains `url?: string` — the
address of what is held, when it has one. Strut still knows nothing about
pods (`jobs.md` §6): a hold is an id, a kind, a way to be released, and now
where to find it. `pod/claim` (lab) sets it to `frontend` beside the note
it already writes. `urls` is a fold over the holds by kind, first with a
url wins; a job with two pods names them by id in `holds`.

## 4. The instruments

One step per surface, each returning the check contract `{ supports,
content, locator? }` (`claims.md` §4) so a check is one line of config
and `mapCheckResult` needs nothing new. The same steps are tools the work
agent can be granted: it runs the instrument mid-turn, sees the frame or
the response, fixes, then verifies — the pass runs the identical step, so
what the agent saw is what the ledger records.

**`browser/verify`** (lab, beside `capture`, over the same service):

```yaml
type: browser/verify
config:
  url: "{{ input.urls.pod }}/settings"
  steps:                                   # browser/capture's list, verbatim: do + that verb's input
    - { do: click, selector: "text=Sign in" }
    - { do: fill, selector: "#email", value: "demo@example.com" }
    - { do: press, key: Enter }
    - { do: wait, url: "**/settings" }
  expect:
    text: ["Notification preferences"]      # each visible on the page
    url: "**/settings"                       # where the page ended up
    selector: ["form[data-testid=prefs]"]    # each matches at least once
    noErrors: true                           # observe() clean: console, page, failed requests, http errors
    evaluate: "document.querySelectorAll('tr').length >= 3"   # truthy
```

Output `{ supports, content, locator: { path, url }, errors, pageUrl,
title, failed: string[] }`. The rule that makes it a check and not a
capture: **the page failing is a result, the instrument failing is
cannot-run.** A drive step whose target matches nothing, an expectation
that does not hold, a console error with `noErrors` — all `supports:
false`, `failed` naming which, with the shot taken where the page got to.
Only the browser not starting or the URL not opening at all (DNS, refused,
the page's own timeout) throws, which the pass maps to cannot-run, nothing
written. `content` is one line a person reads: "settings reached; 1 of 3
expectations failed: text 'Notification preferences' not visible".

**`http/verify`** (strut, `src/steps/lib/http/verify.ts`, over
`ctx.services.http` so it is cassette-recordable and runs under the pass's
principal):

```yaml
type: http/verify
config:
  url: "{{ input.urls.pod }}/api/settings"
  method: GET
  headers: { Accept: application/json }
  secrets: { Authorization: "Bearer {API_TOKEN}" }   # {NAME} (single braces — the {{ }} engine never sees it) is the secret NAME, resolved through ctx.services.secrets, masked from content and failed
  expect:
    status: 200
    headers: { content-type: "application/json" }
    contains: ["notifications"]
    json: { "settings.notifications.email": true }    # path → equals
    maxMs: 2000
```

Output `{ supports, content, locator: { url }, status, ms, failed }`. A
status that is not the expected one is a refutation, 500 included; a
connection refused, DNS failure or timeout is cannot-run. `content` is
the status, the time, which expectations failed and a bounded excerpt of
the body, so the person sees what came back. A check's config is a graph
property, so a credential may only ever be NAMED here — a missing one
throws (cannot-run), and the secret store's actor binding means the
launching person's token is what resolves. Built: `src/steps/lib/http/verify.ts`.

**Shell and tests** need nothing new. `exec` with `cwd: "{{ input.dir }}"`
maps exit codes as today; `pod/run-tests` returns `{ success, apps }`, so
a check that uses it is a two-step `subflow` ending in a `pack` that says
`supports: "{{ tests.success }}"` — or the lab gives it the contract
shape directly. A test the agent writes INTO the repository and runs this
way is the durable form of a check: it ships with the pull request, while a
`browser/verify` is the job's own and goes with it.

**A bespoke workflow** when the list is not enough — a flow that branches
on what the page shows, several pages, a login that needs a one-time code
— is a workflow of atomic `browser/*` steps the agent publishes and names
in a `subflow` check. The sealed check over the closure applies as it
does; the seed must grant `meta/publish-workflow` for this, which it holds
back today (§10 decides).

**Where the screenshot lands.** `shotSinkOf` writes under the job's
directory when the run carries `ctx.job`. A check run carries no job today
(`claims.md` §4 Triggers). The pass launches job checks with the job id
(`RunStepOptions.job`, stamped on the check run's `run.start` — `origin:
"verify"` still, never recorded on the job's run list, never a turn) and
takes NO hold: a check writes new files and reads the directory, which a
live turn does too, and the shot sink numbers its files. So evidence
screenshots are job files, `shots/NNN.png`, served as
`/jobs/<id>/files/shots/NNN.png` by the route hive already proxies, listed
with the job's files, swept with the job. The locator carries that URL;
`writeEvidence` puts it on `HAS_SOURCE.post_url` as it does.

**The check run is kept when it left something behind** (*proposed*). A
free check runs in memory and is persisted only when it reports cost. A
check whose evidence carries a locator into files is persisted under
`check:<id>` too, so `context.checkRun` names a record a person can open
when a screenshot looks wrong. Still never a turn.

## 5. Policy and the three doors

Defaults for a check on a job subject (`claims-authoring.ts`, the
write-time defaults):

| policy | on a job |
| --- | --- |
| `manual` | **the default**, whatever the step type. Fires only on an explicit verify |
| `on_change` | once per turn (the version is the turn) plus `freshness_days`; opt in for a cheap check someone wants re-measured every turn regardless |
| `always` | the same as `on_change` on a job in practice; allowed |
| `sample` | meaningless on a job; refused at write time |

The automatic pass still runs after every top-level run that carries a
job (the same `services.onRunEnd` hook; `subjectsOfRun` adds one job
subject when `run.start.job` is set) — cheap when every check is `manual`,
and what `on_change` fires from.

**Door one — the agent, mid-turn: `meta/verify-job`.** Input `{ job?,
claims? }` (default: `ctx.job`; `claims` narrows to ids). Runs an explicit
pass with THIS run as the version — the pass accepts an in-flight run for a
job subject: the record line exists, `runRef` projects the run once (a
partial `StrutRun` the run-end projection upserts again) and the evidence
hangs off it. Returns the ledger. The prompt rule (§10): a turn that says
the work is ready ends with this call, and acts on what comes back before
answering. Grantable as an agent tool; the seed grants it. The builder chat
gets no twin until `job` lands on chats (`jobs.md` §7).

**Door two — a person: `POST /jobs/:id/verify`.** `{ claims? }`, behind
`requireApiKey`. An explicit pass against the newest turn, live or
finished; returns the ledger. A pod that is gone is cannot-run on every
check and the ledger keeps what it had. Also the strut timeline's button.

**Door three — the chat's `verify_run`** is unchanged: it knows runs, not
jobs, and a run of `job` it verifies gets its job subject through
`subjectsOfRun` like any other — but `manual` checks on the job fire only
through doors one and two, which say "the job", not "this run".

**Budget** as today: a `browser-explore`-backed check is presumed paid and
counts against the job subject's daily cap; `browser/verify` and
`http/verify` report no cost and are free.

## 6. The ledger, and who reads it

`LedgerClaim.latest` (`src/ledger.ts`) gains `about?: string` (the turn's
run id) and `locator?: { url?, file? }` read off `HAS_SOURCE`; a job's
ledger is one list, keyed by the job id. It is served three ways:

- **`GET /jobs/:id`** carries `claims: LedgerClaim[]` when the layer is on
  (absent on a filesystem workspace, like `GET /claims` answering
  `enabled: false`), and **`GET /jobs/:id/claims`** serves it alone — what
  hive's handler reads beside the artifact list;
- **`job/get`** carries the same, so the work agent reads its contract in
  a tool result at the start of a turn, the forcing function of
  `claims.md` §5 applied to jobs;
- the strut UI: a Claims section in `JobTimeline` rendering `ClaimsPanel`
  with the job subject — slots as to-dos first, as the panel does — plus
  the image behind a locator through `ArtifactViewer`, and a Verify button
  on door two.

The `run.end` callback is unchanged: hive reads, as it reads artifacts.
No chat is woken: a job has no chat.

## 7. The host — hive

One renderer and one forwarding line; after that any claim on any job
shows with no hive change (`jobs.md` §8's rule holding):

- **The `claims` card.** The job-turn handler (`services/strut-runs/
  job-turn.ts`) reads `GET {lab}/jobs/<id>/claims` after the artifact list
  and appends one `ArtifactRef` of kind `claims`, id `claims-<job>`, every
  turn a version — the `run_graph` precedent. Content: the ledger, each
  claim with its status, speaker, the latest evidence's `content` and
  `mode`, "verified on turn N" from `about`, the screenshot as an image
  (its `locator.url` is a strut-relative job file, a `graph` source the
  reader route already serves), the checks under it, and the open slots.
- **Verify** on the card → `POST {lab}/jobs/<id>/verify` as the job's
  owner, then re-read and publish a new version of the card. No turn, no
  agent.
- **Supports / Refutes** on an open slot → `POST {lab}/claims/<id>/evidence
  { job, runId, supports, content, slot }` (`addEvidence` learns a job
  subject: the run named must carry that job). Stamped `person`, no turn.
- **A refutation with a note** → the artifact-event door: `launchJobTurn`
  with `[claim-event] refuted "<claim text>": <note>` on the first line,
  the slot filled first so the ledger the agent reads at the turn's start
  already says refuted. The agent fixes, verifies, answers.
- **A new claim** from the card — the person's acceptance criterion —
  → `POST {lab}/claims { subjects: [{ kind: "job", name }], text, checks:
  [{ description }] }`: an external check by default; the agent may add an
  instrument to it under §1's ruling.

## 8. How it meets the rest of strut

| | |
| --- | --- |
| Cancel | a cancelled turn is still the newest run on the record: the version moves, evidence goes `stale`, nothing is verified for it |
| Durable resume | a resumed turn keeps its run id — same version; a journaled `meta/verify-job` replays its result like any step |
| Sealed | `meta/verify-job` is a `meta/*` step: sealed by namespace, grantable to the job agent as the other `meta/*` reads are; it verifies the job, never a sealed workflow's run |
| Budget | paid job checks count against the job subject's daily cap; `browser/verify` and `http/verify` are free |
| The graph | `Claim —ABOUT→ StrutJob`, `Evidence —ABOUT→ StrutRun` (job turns), `—HAS_SOURCE→` the same run; "which jobs are refuted" is one query; the embedding pass skips nothing new |
| Deleting a job | the record and directory go, the screenshots with them (`post_url` dangles, the content stays); the node and its claims remain, as `job-index.md` §6 keeps the node |
| The filesystem backend | no claims, as today; `GET /jobs/:id` has no `claims` key; the seed's grants are harmless (the tools answer `CLAIMS_OFF`) |
| Peers | a job's claims are the owning strut's; a `strut/run-workflow` child contributes nothing to them |
| The template claims on `job` | unchanged, verified on every turn as today — the shape of the answer, beside the truth of the work |

## 9. Left out

- **Per-deliverable claims** (`StrutArtifact` as a subject, the artifact id
  as the stable identity and the turn as its version). The natural next
  split once a job carries several deliverables with separate verdicts.
- **A fingerprint as the version** (§2).
- **Graduation**: a job claim about the app ("the settings page renders")
  re-attached to a repository or `File` node once the pull request lands,
  so the check outlives the job. The test-in-the-repo route (§4) is the
  manual form.
- **The builder chat as a job driver** with a `verify_job` chat tool —
  with `job` on chats.
- **Automatic re-verify on an artifact event** (a PR merged, checks
  failing): the event is a turn, and the agent decides whether to verify.
- **Reminders / routing a slot to a person**; `claims.md` §7's deferrals.
- **Mid-turn evidence streaming** to hive: the card lands with the turn.

## 10. Work items

**strut** (one PR):

1. ✅ `claims.ts` / `claims-schemas.ts` / `claims-writer.ts` /
   `claims-authoring.ts`: the `job` subject kind, `StrutRun` as its version
   node, `ensureJobNode` on authoring, the `jobs` dep on the reader, the
   write-time defaults (`manual`, `sample` refused), the §1 ruling on
   fixed point 1 as decided.
2. ✅ `verify.ts`: the job subject in `subjectsOfRun` (from `run.start.job`),
   `buildJobSubject` from the index (§3), `superseded`, the `#n` path for
   explicit job verifies, an in-flight run accepted for a job subject,
   `job` handed to the check run and the kept-when-it-left-files rule,
   `addEvidence` taking `{ job, runId }`.
3. ✅ `jobs.ts`: `url?` on `JobHold`; `job-index.ts`: `urls` on the view.
4. ✅ `ledger.ts`: `about` and `locator` on `latest`; `createStrut.ts`:
   `claims` on `GET /jobs/:id`, `GET /jobs/:id/claims`,
   `POST /jobs/:id/verify`; `job/get` carries `claims`;
   `steps/lib/meta/verify-job.ts`.
5. ✅ `steps/lib/http/verify.ts` (§4).
6. ⏳ (a second PR) The web UI: the Claims section in `JobTimeline`, the image behind a
   locator, the Verify button.
7. ✅ `src/workflows/job.yaml`: grant `meta/verify-job`, `meta/add-claim`,
   `meta/add-check`, `meta/list-claims`, `meta/edit-check`, `http/verify`;
   the prompt section: author the claims when the ask is understood,
   verify before saying done, act on the ledger. `meta/publish-workflow`
   stays held back unless the bespoke-workflow route (§4) is wanted now.
8. ✅ `specs/API.md`: the three routes; `AGENTS.md`: one paragraph.

**stakgraph** (the lab), after the strut pin bumps:

9. `browser/verify` (§4) beside `capture`; `pod/claim` sets the hold's
   `url`; the seed's delta grants `browser/verify`; a `Verify` child page
   under the `Job` Concept saying when to author claims, which instrument
   fits which surface, and that a turn that says "done" verifies first.

**hive**:

10. The `claims` card kind and renderer, the handler's second read, the
    Verify / Supports / Refutes actions, the `[claim-event]` line through
    `launchJobTurn`, the new-claim box.

## 11. Validation

- **Unit (strut):** `claimStatus()` over a job subject — supported on the
  active turn, `stale` after a newer record line, refuted wins; a job
  subject on a non-active turn skips `superseded`; an explicit verify of
  the same turn appends and the newest wins; `manual` is the default and
  `sample` is refused for a job; `buildJobSubject` folds `urls` from holds
  by kind; `mapCheckResult` over `http/verify`'s output; `http/verify` —
  status mismatch refutes, refused connection is cannot-run, a secret
  resolved by name never reaches `content`; the check run carries `job`
  on `run.start` and is not on the job's run list; `addEvidence` with a
  job subject refuses a run that does not carry the job.
- **Live graph (`npm run test:graph`):** `POST /claims` on a job whose
  node does not exist yet writes `StrutJob` + `Claim —ABOUT→`;
  `meta/verify-job` from inside a job turn writes `Evidence —ABOUT→` the
  in-flight run, re-upserted at run end; `GET /jobs/:id` carries the
  ledger with `about` and `locator`; a second turn reads `stale`; `POST
  /jobs/:id/verify` writes fresh evidence; a `person` claim with an `ai`
  check, under the §1 ruling.
- **swarm38, one real job:** "add a settings page" with a pod — the agent
  authors two claims (page reachable, no console errors) with
  `browser/verify`, verifies before answering, the hive card shows the
  screenshot; a second turn that only answers a question shows `stale`;
  Verify from the card refreshes it; a refutation with a note launches a
  turn whose ledger already says refuted.
