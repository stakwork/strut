# Artifact events reach the job — a pod released on merge, auto-fix on failing checks

> **Status (2026-10-08): a plan, nothing built.** Decided with the owner in
> one sitting (§Decided). Strut changes nothing on the critical path: the
> mechanism is the job model's — *an event about an artifact a job reported
> is a turn on that job* — and the policy lives in the seeded `Pod` page,
> so it is written here beside `jobs.md`, which it extends (§6 holds, §8
> the host's closed contract) and does not reopen. A pull request is the
> first artifact with a life of its own, not the shape: the lookup, the
> event line and the door are the same for every kind (§3), and what is
> specific — an event source, a card action — is a plug-in to them. Current behaviour was
> re-read on this checkout (`afc57c6`, main), `hive@69d192719` (master, the
> merge of the live-PR-status change) and `stakgraph@cb1c178e` (main: the
> `job` seed, `mcp/src/lab/pods/`). **Amended the same day** after a second
> read against the code: how a busy job queues an event (§3), the launch as
> a service the webhook and a card both call (§3, §5), check links (§5),
> the hold `pod/push` notes found from `control` (§2), and two one-line
> fixes in the pool API (§2) — each on its work item in §9.

## Problem

A job claims a pod (`pod/claim`, a hold on the job — `jobs.md` §6) and
pushes a pull request from it (`pod/push`). Then:

- **Nothing releases the pod when the pull request merges.** The pod goes
  back to the pool only when the agent calls `pod/release` on a later turn,
  when someone calls `DELETE /jobs/:id` (nobody does), or when strut's idle
  sweep runs — after `STRUT_WORKDIR_TTL_DAYS` (7) of idleness, and only
  when the next `job/dir` or kept checkout on that strut triggers it
  (`sweepJobs`; a periodic sweep was left out, `jobs.md` §10). The `Pod`
  page tells the agent to release when the pull request is merged, but the
  agent learns of a merge only if a person says so in a later turn.
- **Hive hears every merge and tells nobody about a job's.** Its GitHub
  webhook (`src/app/api/github/webhook/[workspaceId]/route.ts`) handles
  `pull_request closed`: it finds TASKS by joining pull-request artifacts
  through chat messages to tasks, marks them done and releases their pods
  (`releaseTaskPod`, ownership-checked); the PR monitor
  (`src/lib/github/pr-monitor.ts`) is the fallback. A job's pull request is
  in neither: it lives in `strut_runs.output` as the turn's artifact, and
  the scan over those outputs by URL (`jobReportedPullRequest`) was deleted
  in the live-PR-status change. Hive's 24 h stale sweep
  (`releaseStaleTaskPods`) is keyed on `Task.podId` and never sees a job's
  pod either.
- **Strut's pods are "used by nobody" in hive.** The pool API stamps a
  claimant on the pod row (`pods.usage_status_marked_by`, a free string,
  via `claim-pod?taskId=`), and `pod/claim` sends nothing — so the
  capacity view (`src/lib/pods/capacity-queries.ts`) shows the pod used,
  with no owner and no time.
- **A late release can drop someone else's pod.** `pod/release` sends only
  `podId`, and hive's no-task drop path calls `releasePodById`
  unconditionally. A pod hive recycled and handed to a task is released
  from under that task by strut's sweep seven days later, or by an agent
  acting on a stale `podId` in its memory.

A first draft said "on merge, hive releases the job's holds". It is wrong
as soon as a job has more than one pull request (§1), which is the common
shape: a pod carries every repository of its workspace.

## Decided

- **The agent decides; hive forwards.** An event about an artifact a job
  reported — first, a pull request merging, closing or failing its checks
  — becomes a TURN on the job, with a machine-written prompt. The agent —
  the one party that knows which pod made which pull request and what else
  is pending in it — releases, fixes or keeps, with the tools it already
  has. Hive models no lifecycle for the artifact; the job's thread is the
  state. Hive's side stays the closed contract of `jobs.md` §8 plus one
  generic thing: deliver an event about an artifact to the job that
  reported it.
- **One door, one lookup, one shape, for every kind of artifact.** The
  lookup is an index of every ref a job reports, by URL, kind-agnostic.
  The event is one first line, `[artifact-event] <kind> <url> <what
  happened>`, specifics below. What is specific stays a plug-in: an event
  SOURCE (the GitHub webhook) is an adapter that names a URL and what
  happened; a card ACTION is a viewer composing a prompt. Neither adds a
  seam. Tasks and Plans became one-offs in hive because hive modelled each
  one's lifecycle; nothing here is modelled.
- **What to do with an event is the Concept page's.** Merge and close:
  release the pod when nothing else from it is open. Failing checks:
  reproduce, fix, push a revision. Later a review asking for changes. The
  `Pod` page evolves on the swarm without a hive PR (`jobs.md` §2: the
  workflow evolves, the host does not).
- **Auto-fix is a button first.** The pull-request card's action composes
  the failing checks into the event and continues the job. Automatic fix turns come later, with a cap, because
  fix → push → fail again is a loop that spends money. Merge and close
  notifications are automatic from the start: they only ask the agent to
  tidy up.
- **The claimant is a job id in the column hive already has.** No new
  column on the pod: `claim-pod?job=<id>` writes `job:<id>` into
  `usage_status_marked_by`, and `drop-pod?job=<id>` releases only a pod
  still marked by that job. A `job_id` column earns its place only if hive
  wants to index pods by job. The one new thing hive stores is the
  artifact index of §3 — a migration, but of refs, never of a lifecycle.
- **Strut is unchanged** on this path. The idle sweep stays the backstop.
  The later, fully generic door — a job inbox in strut any host posts to —
  is named in §3 and not taken now.

## Design in one paragraph

`pod/claim` tells hive which job is claiming; hive's pod list shows it.
`pod/push` records the pull request on the pod's hold. When a job turn
reports artifacts, hive indexes every ref that has a URL. When an external
system tells hive something happened to a URL — GitHub, that a pull
request merged, closed or failed its checks — hive looks the URL up and
launches one more turn on each job that reported it, as the job's owner,
with one `[artifact-event]` line and the specifics below it; the reply
lands on the same Job entry. The `Pod` page tells the agent what each event means: release the
pod when nothing else pushed from it is open; on failing checks, reproduce
in the pod, fix, and push with `stay_on_branch` so the same pull request
gains the commit. A job nobody comes back to is swept by strut as today.

## 1. Why "release on merge" is the wrong rule

A pull request is one deliverable; a pod is a resource. The map between
them is loose in both directions:

- **One pod, many pull requests.** `pod/latest` checks out every
  repository of the workspace, so a change across repositories is one pod
  pushing one pull request per repository. The first merge must not free
  the pod while the second is open.
- **One job, many pods.** The hold model keys holds by id and allows
  several: a parallel sandbox, or a re-claim after a release.
- **Work that is not a pull request yet.** A pod can have one pull request
  merged and unpushed edits in another repository, or a follow-up turn
  planned. No bookkeeping of pull-request states can see that; the agent
  can (`pod/branch-diff`, its own memory).

So neither "release the job's holds on merge" nor "release a pod when all
its pull requests are closed" holds in general, and either would freeze a
pod rule into hive. Forwarding the event and letting the agent judge is
the flattest thing that is right in every case.

## 2. The claimant — hive's pool API, and what the steps send

**Hive** (`claim-pod/[workspaceId]/route.ts`, `drop-pod/[workspaceId]/route.ts`):

| | today | with `?job=<id>` |
| --- | --- | --- |
| claim | `?taskId=` → marks the pod, writes `Task.podId` + agent credentials | marks the pod `job:<id>` (`claimAvailablePod`'s `userInfo`), `usage_status_reason` = the strut run id when given; no task writes |
| drop | with `?taskId=`: `releaseTaskPod`, ownership-checked; without: `releasePodById`, unconditional | with `?job=`: release only when `usage_status_marked_by === "job:<id>"`, else 409 `reassigned` — the task path's rule, for jobs |
| pod list | resolves every claimant in the tasks table; misses show nothing | a `job:` claimant resolves through `strut_runs.jobId` (indexed; `input.title`, `userId`) to a title and a person |

`usage_status_marked_at` is already set on claim, so "since when" is
nearly free: the capacity view (`capacity-queries.ts`) reports the pod's
`createdAt` as `marked_at` today — one line, read the column instead.
The reason is one more argument: `claimAvailablePod` takes `userInfo` and
an exclusion list, so `claimPodAndGetFrontend` threads `reason` through
to the `UPDATE`. The task path is untouched: its ownership check compares
against a task id, which a `job:` value never equals.

**The steps** (`mcp/src/lab/pods/steps/`):

- `pod/claim` sends `?job=<ctx.job>&run=<ctx.runId>` when the run has a
  job (it registers the hold under the same condition). Without a job it
  sends nothing, as today.
- `pod/release` sends `?job=<ctx.job>` and treats 404 (hive let it go) and
  409 `reassigned` (hive gave it to someone else) alike: the pod is not
  this job's any more, drop the hold, return `released: true`. The sweep's
  release — `releaseWith`, a minimal context with the job — goes through
  the same step, so a late sweep can no longer drop a recycled pod.
- `pod/push` re-registers the pod's hold with the pull request on it:
  `jobs.hold(job, { ...existing, note: <pr urls> })`, `since` carried over
  from `jobs.holds` (a `hold` with an id that exists replaces, `jobs.md`
  §6). The step has no `podId` input and gets none: every URL hive hands
  out for a pod is `https://<podId>-<port>.<domain>` (`buildPodUrl`, the
  one function behind `portMappings`), so the hold is the job's `pod`
  hold whose id is the leading label of `control`'s hostname — matched
  against `jobs.holds`, never parsed blind; no match, no note. The agent
  passes nothing new. Strut knows nothing of pull requests — a hold's
  `note` is a string for people and the job index (`jobs.md` §11, later).

## 3. An artifact event is a turn on the job

Three parts, each generic over the KIND of artifact. The pull request is
the first case, not the shape.

**The index.** Hive's `job_turn` handler (`services/strut-runs/job-turn.ts`,
`mapStrutArtifacts`) already parses every ref a turn reports. It records
each one that has a URL — `(jobId, swarmId, artifactId, kind, url)` —
whatever the kind: a pull request, a page, a document, a deploy. One table
— a row per (job, ref), since a row also holds the event waiting on a
busy job (below) — one query: *which jobs reported URL X*. The deleted
`jobReportedPullRequest` scan was this for one kind; this is it for all,
and it carries nothing but the ref and what is waiting on it — never a
token.

**The shape.** One first line any source emits and any Concept page can
read, the specifics on the lines below:

```
[artifact-event] pull_request https://github.com/o/r/pull/12 merged
```

```
[artifact-event] pull_request https://github.com/o/r/pull/12 closed
```

```
[artifact-event] pull_request https://github.com/o/r/pull/12 checks failed
head: a1b2c3d
- lint — https://github.com/o/r/actions/runs/123
- unit tests — https://github.com/o/r/actions/runs/124
```

`<kind> <url> <what happened>`: the kind is the ref's, the URL is the join
key, the rest names the event. A later source — a comment on a document
the job wrote, a failed deploy of its branch — fills the same three slots.
The agent fetches what else it needs itself (its token, `web_fetch`, or
simply `pod/run-tests`). The prompt is the whole message: no "Hive
workspace:" beyond what the `job` workflow adds, and no canvas-agent
rewrite — the first production Plan Mode job came back as a spec because
hive's canvas agent dictated the format.

**The sources** are adapters, one per external system, each small: read
the system's event, name the artifact's URL and what happened, look the
URL up, deliver. The first is the per-workspace GitHub webhook, where
tasks are handled today: `pull_request closed` (merged or not) → one event
per matching job. Check failures (`check_suite` completed) join once
auto-fix is automatic (§5); until then the card action (§5) is the
trigger, composed from the live status route
(`api/orgs/[githubLogin]/strut/pull-request`). A second source adds an
adapter and nothing else.

**The launch** is `launchJobTurn` with the same id — the `continue_job`
path: `dispatchStrutRun` with `job`, `workspace` on the input, the
owner's GitHub token pushed as an actor secret — and the event as the
prompt. Today it is a private function of `lib/ai/strutTools.ts` taking
the tool loop's context; it moves to a service (`services/strut-jobs.ts`,
say) that takes `{ userId, workspaceId, conversationId, publicBaseUrl }`
and nothing of the agent, which the tools, the webhook adapter and the
card route (§5) all call. The conversation is the job's own: the launch
copies `conversationId` from the job's first row, as it copies the owner,
so the reply has somewhere to land.

**Who it runs as.** A system-launched turn has no caller: it runs as the
job's owner — `StrutRun.userId` of the job's first row — which is whose
GitHub token pushes the fix and whose LLM delegation pays. A job started
by one person is never continued as another by an event.

**Busy.** A turn in flight (a PENDING row of the job — `continue_job`'s
`live` check) makes the launch `job_busy:`. Hive cannot wait it out: the
webhook is a request on Vercel, and a backoff over minutes has nowhere to
run. So a forwarded event that finds the job busy is STORED — on the
artifact's index row, the event text and when it arrived — and the
`job_turn` settle handler, which already runs when a turn of the job
ends, launches what is pending as the next turn: the chat notifier's rule,
hive-side — a notification queues behind a live turn and goes when it
ends; several waiting on one job go as one turn, one `[artifact-event]`
line each. A hive restart between the two loses nothing stored; a row the
reconcile cron settles later (LOST) runs the handler then. The idle sweep
is the backstop. The card action says "a turn is running, try again in a
minute", the note `continue_job` already returns.

**Where the reply lands.** On the same Job entry, through the `job_turn`
handler as any turn's reply: `text` (one line for a release: which pod,
why), `artifacts` with the same `pr` id when the pull request changed.
The row's prompt carries the `[artifact-event]` line, which the card can
show as the turn's origin instead of a person's words.

**Later, the door moves into strut.** The fully generic form is a job
inbox — `POST /jobs/:id/events { text }` — with strut launching the turn
and queuing it behind a live one, the chat notifier's way, for any host.
Not now: hive's launch does what strut cannot, refreshing the owner's
GitHub token before each turn (`ensureStrutActorSecrets`). Keeping hive's
side to "look up by URL, post text" is what keeps that move open.

## 4. The policy — the `Pod` page

`mcp/src/lab/pods/concepts/Pod.md` gains, after the push section:

- **On `[artifact-event] pull_request … merged` or `… closed`:** look at
  the pod that pushed it. Release it (`pod/release`) when nothing else you
  pushed from it is still open and no work is pending in it; otherwise
  keep it and say what it is still for. Report the pull request's card
  with its new `state`. One line of `text`; no other artifacts.
- **On `[artifact-event] pull_request … checks failed`:** the pod is usually still on
  the pull request's branch. Reproduce (`pod/run-tests`, or the check's
  own command), hand the fix to the agent in the pod with the failure
  standing alone, judge it, then `pod/push { stay_on_branch: true }` so the
  same pull request gains the commit — never a second pull request. Report
  the same `pr` id. If the pod is gone (password rejected, or released
  after a merge), claim again and give `pod/latest` the pull request's
  branch as `base_branch`, as the page already says for a revision.
- **When an event names an artifact you do not know:** say so
  and do nothing — never release a pod on a guess.

The page is content on the swarm: a sharper rule next month is an edit to
it, not a release of anything.

## 5. Card actions — auto-fix from the artifact view

A card in hive's org canvas belongs to a Job entry, so the job id is at
hand for any action on it (the live-status change removed `jobId` /
`swarmId` from the ref on purpose; the entry carries the job). The generic
action is *send to the job*: compose a prompt from the card's current
state and `continue_job` — the same launch as "also rename the helper".
Each viewer decides what its prompt says; nothing else is per kind.

The pull-request card's action is "Fix". It already polls the live status
route (`useArtifactContent`) and shows failing checks, so the prompt is
§3's `checks failed` event composed from what the card has: the pull
request, the head sha, the failing checks, their URLs. One gap: a
`PullRequestCheck` is `{ name, status }` today — `pullRequestStatus.ts`
gains `url` (a check run's `html_url`, a commit status's `target_url`) so
the event can point at the run; the webhook's `check_suite` payload
carries the same. The button needs a door: `continue_job` is a tool of
the canvas agent, not a route, so the card POSTs to a route of its own
that calls the launch service of §3 as the person who clicked, into the
Job entry's conversation — exactly what a `continue_job` message would
do, a click instead of prose. Nothing strut-side; the job's next turn is
the fix.

**Automatic, later.** A source forwards failures as §3 events, with a cap
that is hive's and generic: one automatic event per (artifact, state) —
for a pull request the state is the head sha, so a `synchronize` is new
and a failure on a sha the job already fixed once is not forwarded again —
and never while the job has a turn in flight. A loop guard, the twin of
`STRUT_CHAT_MAX_AUTO_TURNS`.

Not reused: hive's task-side auto-fix in the PR monitor
(`claimPRFixInProgress` → `triggerAgentModeFix`) drives the stakwork
agent-mode path. A job's fix is the job's own next turn.

## 6. Strut

Nothing on the critical path. What strut has is what this stands on:

- a hold with a release step (`jobs.md` §6, built) — the pod survives
  between turns and is let go by the agent, the sweep, or the delete;
- the sweep (`sweepJobs`), lazy, after `STRUT_WORKDIR_TTL_DAYS` — the
  backstop for a job nobody comes back to and pull requests that never
  close;
- `DELETE /jobs/:id` — the ops door for "free everything this job holds".

Worth doing when it earns its place, none required here:

- **A hold TTL shorter than the repository one.** Holds cost money while
  idle; a pod sitting a week is the price of the lazy sweep. `sweepJobs`
  releasing holds older than `STRUT_HOLD_TTL_DAYS` (say 2) and keeping the
  repositories until 7, or the scheduler tick calling the sweep
  (`jobs.md` §10). Decide after the first week of jobs on a swarm.
- **`DELETE /jobs/:id/holds[/:id]`** — release the holds and keep the
  directory and files. `releaseHolds` does the work; an earlier draft had
  it as the merge mechanism, and it is not; as an ops door it is fine.
- **The job index** (`GET /jobs`, `jobs.md` §11, later) listing holds with
  their `note` — where "what is this pod waiting on" shows without hive.

## 7. Costs and failure modes

- **A turn per event.** A notification turn replays the job's whole
  thread; `cacheTtl: 1h` on the `job` agent means a merge that arrives an
  hour after the last turn pays a cold full-context input call. Cents to
  a dollar on sonnet for a long job; a release is otherwise a few tool
  calls.
- **Judgment.** The agent can keep a pod it should release. The sweep is
  for that. It can also release one it should keep; the page's rule errs
  on keeping, and a re-claim is cheap.
- **A pull request the job never reported** (pushed but not listed as an
  artifact) is invisible to hive and never forwarded. The page already
  demands the `pr` card; the sweep covers the rest.
- **Hive restarts** drop a retry in flight, like a run callback. Backstop
  as above.

## 8. Left out

- A review asking for changes as an event (`pull_request_review`
  `changes_requested` → `[artifact-event] pull_request … changes requested`
  with the review body). The same door; add when a job is asked for it.
- Other sources — a comment on a document the job wrote, a deploy of its
  branch — each an adapter emitting the §3 line; none needs a new piece.
- Forwarding to the builder chat (`POST /chat { job }`, `jobs.md` §7).
- Binding the workspace to the job record so the launch stops carrying
  it (a follow-up from the pods work); unrelated, noted so it is not
  folded in here.

## 9. Work items

In this order; each lands on its own.

1. **Hive, pool API** — `?job=` on claim and drop (§2): the stamp, the
   `reason` argument through `claimPodAndGetFrontend`, the ownership
   check, the pod list resolving `job:` claimants and reading
   `usage_status_marked_at` for `marked_at`. One PR, the pool's contract,
   not a per-capability change.
2. **mcp, pod steps** — `pod/claim` / `pod/release` send the job and run;
   `pod/release` treats 404 and 409 as released; `pod/push` notes the pull
   request on the hold it finds from `control` (§2). `Pod.md` §4. Seeded
   as the next versions. Deploy after 1: before that hive ignores `?job=`,
   harmlessly, and the 409 does not exist yet.
3. **Hive, the door** — `launchJobTurn` as a service (§3); the index of
   every artifact ref with a URL, written at settle (a migration); the
   GitHub adapter in the webhook's `closed` branch, launching as the owner
   into the job's conversation with the `[artifact-event]` line; the
   pending event on the index row and its launch from the settle handler
   (§3). The card shows the origin.
4. **Hive, the Fix action** on the pull-request card (§5): `url` on
   `PullRequestCheck`, the card's route onto the service of 3, the button.
5. **Later** — automatic check-failure forwarding with the per-(artifact,
   state) cap (§5); strut's hold TTL if pods are seen idling (§6); the job
   inbox in strut when a second host wants the door (§3).

## 10. Validation

On swarm38, with a job in a two-repository workspace (hive's webhook
installed on both repositories — `WebhookService` — or no event arrives):

- Turn 1: a change across both repositories from one pod → two pull
  requests, two `pr` cards; hive's pod list shows the pod held by
  `job:<id>` since the claim.
- Merge the first → a notification turn → the reply says the pod is kept
  for the open pull request; the first card reads merged.
- Merge the second → a notification turn → `pod/release`; the pod is
  UNUSED in hive's list; `GET /jobs/:id/files` still serves the job's
  files.
- Merge while a turn is running → nothing launches; the event sits on the
  index row; when the turn settles, the next turn opens with the
  `[artifact-event]` line.
- A pull request whose checks fail → "Fix" → a commit on the same branch,
  the same `pr` card, checks green.
- A stale release: release the pod by hand in hive, let a task claim it,
  then `pod/release` from the job → 409 `reassigned`, the task keeps its
  pod, the job's hold is dropped.
- A job left alone with a pod → swept after the TTL, the pod back in the
  pool, the directory kept.
