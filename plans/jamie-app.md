# Jamie as a strut app, and one wake for every host

> **Status (2026-11-05): proposed; §1 (one wake) built — §1.6; §2 (conversations) built — §2.1; §3 (first-party apps) built — §3.1; §4 (the host panel) built — §4.1; §5 (the app) built — §5.1, named Jamie with jobs in the list and pull requests — §5.2; Hive's wake half (§6.1) built — stakwork/hive#5705.** Written after a read of strut `main`
> @e1c45ad, hive `origin/master` @c692b96bf, sphinx `origin/master`
> @74c12954 (Peel's bridge) and sphinx-voice `origin/main` @ba18f12. The
> owner agreed four things in conversation, marked **agreed** below: a
> first-party tier for apps strut ships, strut owning the job wake for
> every host, conversations named in the person's own session namespace,
> and the build order. Everything else is mine and open. Companions:
> `org-home-swarm.md` (this is its first step: "the Jamie chat becomes a
> strut app"), `apps.md` (apps, hosts, `strut/views`),
> `chained-orchestrators.md` (person tokens, rooms, the local wake),
> `specs/DESKTOP.md` §5 (the wake as a host does it today),
> `specs/CALLBACKS.md` (`startedBy`, inherited callbacks).

## Problem

Jamie, the assistant in Hive's org page, already runs on strut: since
2026-10-23 every turn is one run of the `orchestrator` workflow on the
org's default swarm, its `session` the conversation's id. But almost
everything that makes it feel good runs on Hive's servers, not in strut
and not in the browser:

| What the person sees | Where it happens today |
|---|---|
| The conversation list (by day, search, rename, archive, unread, each chat's jobs) | Hive Postgres `SharedConversation` + `StrutRun`, `GET /api/orgs/:login/control-panel` |
| The reply arriving | strut POSTs `run.end` to Hive's webhook; Hive appends rows to the conversation and nudges the browser over Pusher (`src/services/strut-orchestrator.ts`, `src/services/strut-runs/orchestrator-turn.ts`) |
| Jamie telling you a job finished | Hive's **wake**: a second orchestrator turn launched when the job's `run.end` lands (`src/services/strut-orchestrator-wake.ts`) |
| Job cards, the live strip | Hive reads the turn's events for `job_start` calls, receives `job.update` at `/api/strut-jobs/events`, forwards over Pusher |
| Proposal cards | Hive reads `GET …/runs/:id/proposals` at settle, proxies `GET /proposals/:id` and `POST …/decide` |
| Artifacts | Hive maps the run's artifacts to refs in its rows; a Hive route proxies each file with the swarm key |
| Attachments | S3, read by Hive at launch and sent as `attachments` |
| The model, the time zone | `User.chatAgentModel`, `User.timezone`, sent as `params.model` and `context.line` |

A strut app can call only strut steps (`step_run`), holds no socket, and
fetches nothing (`connect-src 'none'`). So the question is not whether
the UI ports. It does: Hive's org page and the kit are the same stack
(React 19, Tailwind 4, shadcn, zustand), and `strut/views` already draws
most artifact kinds. The question is what of Hive's server must move into
strut first. Four things, in this order: the wake (§1), a conversation
index (§2), a first-party tier for apps strut ships (§3), and a panel in
the host for what an app cannot frame (§4). Then the app (§5) and the
hosts' halves (§6).

The wake is the largest, and it is not only the app's: four surfaces wake
the orchestrator today, in three implementations that have already
drifted (§1.1).

## Decided

| Question | Decision |
|---|---|
| Built in | **agreed.** A strut app seeded by strut on every swarm, as `strut/views` is (`src/apps/views-seed.ts`), framed by Hive as the org-home plan proposes. |
| Trust | **agreed.** A **first-party tier**: an app strut ships acts with the viewer's own rights, which the app rules for model-written pages deny (§3). |
| The wake | **agreed.** Strut owns the job wake, for every host (§1). |
| Session names | **agreed.** A conversation is the person's own session, `<actor>/<conversation>`, the namespace Peel's hand-offs already use (`peerSessionId`, `src/session-store.ts`), never `app/<name>/<viewer>/…`. |
| Order | **agreed.** Wake and conversation index first (server-side, testable with no UI, Hive can use them before the app exists), then the tier, then the app, then the host panel and Hive's frame. |
| Canvas, initiatives | Out of scope here. `org-home-swarm.md` makes them apps of their own. |
| Shared conversations | **Kept** (owner, 2026-11-04; open question 1). A conversation can have several people: it is listed for everyone who took a turn in it (its turns' actor, else principal), and a `shared` flag makes it readable to any actor on this strut before their first turn. Strut cannot check org membership; on a swarm every token holder is an org member. Taking a turn makes you a participant. Calls (one conversation per call, each turn as its speaker), tribe threads and Hive's share links already work this way. |
| Continuing a conversation | **Ruled** (owner, 2026-11-04). A person's turn — through a person token, or strut's own app — may continue any conversation they took a turn in, or a shared one, under whatever id it has: Hive's bare ids included. Another person's is refused. Reading it while it was shared is not a turn. Built in §2.2. |

## 1. One wake (proposed)

### 1.1 What exists

| Surface | Who wakes | What it does |
|---|---|---|
| Hive's web chat | Hive, `invokeOrchestratorOnJobTurn` (`strut-orchestrator-wake.ts`), scheduled from the job's `run.end` (`strut-runs/job-turn.ts:1021`) | the prompt below; gates in `canvas-strut-autoturn.ts` |
| A Sphinx tribe (the Jamie daemon) | **the same Hive wake.** The daemon (`sphinx/wasm/daemon`) has no wake logic: it posts what Hive's outbox hands it | the prompt says the reply is all the tribe reads; the outbox threads the reply under the mention that started the job (`src/lib/tribes/tribeOutbox.ts`) |
| A Hive group call | **the same Hive wake** | voice long-polls `GET /api/calls/messages` (`src/lib/calls/callMessages.ts`) and says the first paragraph, ~350 chars, the question last (`sphinx-voice/src/replies.ts`) |
| Peel's DM | Peel's bridge, `runner/src/bridge/wake.rs`, from a local `run.end` callback, an org's room, or catch-up after a reconnect | a copy of strut's `DESKTOP.md` §5 prompt |
| A 1:1 call (voice → strut directly) | **nobody** | voice says a 280-char line from the job's own `output.summary ?? output.text` (`sphinx-voice/src/strut/callbacks.ts`), notes it for the next turn (`noteSaid`), drops it when no call is open |

The deciding logic is the same everywhere (the job's reply inline;
summarize, continue or stay silent; a loop cap). The copies have drifted:

- **The prompt.** Hive's was rewritten on 2026-10-31 (hive#5683, #5684)
  after the owner found tribe replies too long: the job's reply is "its
  note to YOU, not a draft"; say what is NEW; leave out how the job
  worked; offer no next step. Strut's own `DESKTOP.md` §5, and Peel's
  bridge copied from it, still say "one short paragraph … what it
  produced, its question if it asked one, the next step".
- **Busy.** Hive retries twice, 15 s apart, then drops the wake
  (`ORCHESTRATOR_WAKE_RETRY_DELAYS_MS`). Peel queues it behind the live
  turn.
- **The loop cap.** Hive: 4 job rows in a row, then skip
  (`MAX_CONSECUTIVE_STRUT_DISPATCHES`). Peel: 3, then send the job's words
  as they are, with no model turn (`MAX_WAKES`).
- **Who it runs as.** Hive: the conversation's owner. In a tribe or a
  call, where each turn runs as its speaker (`call-turns-run-as-starter`,
  hive#5688, #5699), that is not the person who asked for the job.
- **The question.** The 1:1 call never reads the job's `ask`. A question
  that lives only there is never said, and the orchestrator never sees
  it: the "ok, do it" that follows reaches an agent that never saw what
  was asked, the failure Hive's wake header names as the reason a wake
  exists.

Only Hive's has the medium sentence (where the reply is read:
`whereRead`, `conversationMedium`), the owner's model pick, and EVENT
wakes (a job turn Hive started because something happened to an artifact,
answered in one line, never continued). Only Peel's has catch-up and the
chained rule (an org's job continues by handing the go-ahead to that
org's assistant).

### 1.2 The trigger

A job turn's run ends (`job`, `builder`; never `orchestrator`) and the run
names a conversation on this strut:

- **In process.** `job/start` and `job/continue` already record
  `startedBy { workflow, runId, session }` on the job run's `run.start`,
  its record line and its `run.end` (`src/core.ts` `StartedBy`,
  strut#290). The run-end hook that posts callbacks
  (`services.onRunEnd`) is where the wake is queued: no callback, no
  host, no page needed.
- **A job a host launched.** Hive's card actions (Verify, a captcha
  answer, an artifact event) launch `job` turns with `POST
  /workflows/job/run`, which carry no `startedBy`. A launch may name the
  conversation: `POST …/run { conversation: "<session>" }`, full scope
  only, recorded on `run.start` and read wherever `startedBy.session` is
  (`StartedBy` itself names a launching run, which a host's launch does
  not have). A host that
  names none gets no wake from strut and keeps waking itself (this is how
  Hive's event wakes stay Hive's until they move; §6.1).
- **A job that ran elsewhere.** Peel's local strut never sees an org's
  job end: the bridge hears it on the org's room. A door for the host:
  `POST /conversations/wake { session, source, end }` (full scope; `end`
  the `run.end` payload as it came; `source` the peer id it came from),
  which runs the same wake on the local session, its Continue branch
  "hand the go-ahead to @<source>'s assistant, naming job `<job>`".

Not woken: a session opened through a person token (`peerPerson` on the
run). Those are relays in a chain whose head is another strut, and the
head wakes itself (ruled 2026-10-22, `chained-orchestrators.md`): central
waking its own relay thread would answer into a conversation nobody reads.

### 1.3 The turn

- **Prompt.** Hive's current text, both branches (the job's turn; an
  event), moved into the orchestrator template as `params.wake` so it
  evolves like `params.system`. The job's reply inline (capped at 6 000
  chars), marked as data (Peel's `<<<job reply … >>>`, `unmarked`); its
  question; what it produced (titles and kinds); Summarize, Continue
  (`job/continue`, or the peer hand-off), Silent (`[silent]`). `job/get`
  named for the rest. `DESKTOP.md` §5 then points at the template instead
  of carrying a copy.
- **Where it is read.** Each host already says, every turn, where the
  conversation is read, in free text inside `context.line`, mixed with the
  time. Add it alone beside `line`, which keeps it too (§1.6): `context:
  { line, where?, timeZone? }`. A wake builds
  its line from the latest human turn's `context` (it is on that run's
  `run.start` input): the current time in `timeZone`, then `where`. Hive
  sends its web, tribe and call sentences as `where` (today's
  `whereRead`), Peel its DM sentence, voice its call sentence. No `where`:
  nothing is said.
- **Model and person.** The model of the turn that started the job (its
  `params.model`), so a conversation runs on one model (hive#5684's fix,
  in one place). The actor and principal of the job run: the person who
  asked for it, billed to their delegation.
- **Marked.** `run.start` and `run.end` carry `wake: { job, runId }` (the
  job run it woke on), and the session's turn line `wake: true`, so a
  host renders it as a wake, the loop cap counts it, and a page tells it
  from a person's message.

### 1.4 The gates

- **Once per job run.** Keyed by the job's run id. Pending wakes are
  written beside the session (one small file) before anything launches and
  cleared when the wake's turn commits, so a restart between the job's end
  and the wake launches it at boot, as auto-resume finishes a chat's dead
  turn (`STRUT_AUTO_RESUME`).
- **Queued, never dropped.** While a turn holds the session (a person's
  message, the turn that started the job still ending), the end waits and
  goes when the session is free. Several ends that waited go as ONE turn,
  each job's reply in it, as the builder chat's notifier drains
  notifications (`src/ai/notifier.ts`).
- **Loop cap.** Past `orchestrator.wakeMax` (default 4) wake turns since
  the last human turn, no turn. The job's `run.end`, which reaches the
  host anyway (it inherits the launching turn's callback), carries
  `wake: "capped"`, so the host shows the job's words as they are (Peel's
  behaviour, every host). The same field says `"launched"` (a reply will
  follow) or `"none"` (strut will not wake: no conversation, a relay, the
  wake turned off), so a host knows whether to wait.
- **Off.** `createStrut({ orchestrator: { wake: false } })` and
  `STRUT_HOST_CONFIG`'s `orchestrator.wake`, for a host that is not ready
  (§7).

### 1.5 Delivery stays the host's

The wake turn's `run.end` goes where the turn that started the job sent
its own: the callback and job callback that turn was launched with (the
run store keeps both, `RunStore.getRunCallback`, `setRunJobCallback`),
or its room. Each host draws it as it draws a reply today: Hive appends
the row (and the tribe outbox and the call feed read it from there), the
bridge sends the Sphinx DM with the job and its deliverables as
metadata, voice says it on the member's current call. The Jamie app reads
it from the conversation (§2). Hive's webhook refuses it today: a
`run.end` for workflow `orchestrator` at an orchestrator row's URL whose
`runId` is not the row's is a `Run mismatch` 400
(`src/app/api/strut-runs/webhook/route.ts:131-150`); it needs the
adoption job runs already get (§6.1).

### 1.6 As built (2026-11-04, branch `feature/one-wake`)

Work item 1 and the strut half of §7 and item 8: `src/wake.ts` (the pure
prompt, context and door parsers, and the queue), wired in `createStrut`;
`params.wake` and `context.where` in `src/workflows/orchestrator.yaml`;
`CALLBACKS.md` §9, `API.md` §3, `DESKTOP.md` §5. Where the plan was open
or vague, and where it differs:

- **Where the trigger sits.** Not `services.onRunEnd`: in the launcher's
  settle (`launchDetached`), where the job's `run.end` is posted, so the
  outcome is decided before it goes out; and in the boot's finalize of a
  dead run (`finalizeDeadRun`). Every root launch passes through the first.
  A crash between the job's summary and the wake file loses that wake, as
  it loses a `run.end` in flight.
- **A conversation workflow is one with `params.wake`**, not the name
  `orchestrator`. The wake runs the launching turn's workflow, else the
  session's latest turn's, else `orchestrator`; one without `params.wake`
  is `"none"`. The 202's `wake: true` follows the same rule (and needs
  `input.session` and the deployment's scope).
- **The relay rule is wider than `peerPerson`**: a launching (or latest
  person's) turn with `origin: "peer"` or `"app"` is `"none"`. A plain
  peer's sessions open as `peer/<id>` and an app's as
  `app/<name>/<viewer>/…`, so `startedBy.session` (the raw input) does not
  name the thread at all. §3's first-party tier will have to revisit `app`.
- **Prompt.** Hive's job branch only (event wakes stay Hive's, open question
  6). One template for one or many jobs: the part between `{each}` and
  `{/each}` repeats per job; placeholders `{job} {title} {on} {started}
  {outcome} {produced} {reply} {question} {continue}` and `{silent}`, each
  piece filled once so a job's words are never read as one. "Hive's entry
  is COLLAPSED" became the host's `context.where`, and so did the tribe and
  call sentences. `where` is read by the WAKE alone, which puts it in its
  own `context.line` after the time; a person's turn reads `line` only, so
  a host keeps the medium in `line` too (changed 2026-11-04, after hive#5705
  moved the tribe and call postures out of `line`: an orchestrator template
  from before #490 reads `line` alone, so those turns would have lost them
  on every swarm not yet bumped).
- **The wake's line**: "Wed 4 Nov 14:02, Europe/London. " in the person's
  latest turn's `context.timeZone`, UTC when it has none or a bad one.
- **Several ends in one turn** (open question 4: one turn): the mark is the
  first end's `{ job, runId, peer? }` plus `also: […]` for the rest; the
  turn runs as the first end's asker and on its starting turn's model.
- **Who** (open question 3): the job run's actor and principal. For the
  door, the request's actor, else the person's latest turn's.
- **Model**: the starting turn's `params.model`, else the person's latest
  turn's; none, the template's.
- **Callbacks**: the newest person's turn (up to 20 back) that has a
  `callback`, with its `jobCallback`; the starting turn last, for one that
  has not committed.
- **Busy** is the session held OR any run launched on it (`input.session`)
  still in flight in this process: a turn's steps before and after its
  agent hold no lock. A wake turn that still fails `session_busy:` (a
  person got there between the check and the open) puts its ends back. A
  busy session that no run of ours will free is looked at again every 2 s.
- **The cap** counts trailing `wake: true` turn lines plus a wake turn in
  flight not yet committed; a person's turn in flight starts it over; an
  end that joins one already waiting never caps (open question 2: strut
  says `"capped"`, the host shows the job's words).
- **Durable state** is `<dataDir>/wakes/<session>.json` (`queued`, `turn`,
  and `seen`, the last 500 job runs woken on), not inside the session
  store's directory: that store may be in memory. Boot reconciles after the
  runs scan, behind the run auto-resume gate: a wake turn still live (the
  scan resumed it) is waited on, one that finished is cleared, one that
  died unresumed goes again.
- **`wake` on the log** is on `run.start` (and `ctx.wake`, the turn line's
  `wake: true`) only; the `run.end` that carries it is the callback's. A
  job turn's `run.end` always carries `wake`, `"none"` included (a job run
  with no conversation, or the wake off).
- **The door** answers `200 { wake }`; `source` must be a peer id and
  `end.workflow` a job's; the run is keyed `<source>/<runId>`.
- **Opt-in per launch** (changed in review, 2026-11-04; §7 as it was
  written assumed every host would switch its own wake off on the 202's
  `wake: true`, which an older host never does). Built on by default, the
  wake would have reached Hive's conversations before Hive could show it:
  Hive's webhook refuses the wake turn's `run.end` (`Run mismatch`), so the
  reply sits in the session as if the person had read it, and Hive's own
  wake then meets `session_busy` and drops, or runs as a second wake turn.
  So a host ASKS on the launches it makes: `POST …/run { wake: true }`
  (full scope; a peer's is dropped), recorded on `run.start` as
  `wakeAsked`. A job job/start started wakes its conversation when the turn
  that started it asked (a job a wake turn started: the person's latest
  turn); a job a host launched itself, when that launch asked beside its
  `conversation`; the door is a host asking. The 202 says `wake: true` only
  for a launch that asked. Each host switches over when its half is ready,
  one launch at a time; `orchestrator: { wake: false }` still turns it all
  off.

## 2. Conversations (built — §2.1)

`useAssistant` (`kit/src/hooks.ts:490`) rebuilds a chat from the last ten
(at most twenty) orchestrator runs, and to find the viewer's it reads the
summary of every orchestrator run on the swarm (`runsCap.list` →
`ownRun`, `src/createStrut.ts`). There is no list of conversations, no
title, no history past twenty turns. The session store has what a list
needs and no more: per session, turn lines with the run, actor, principal,
job and time of each turn (`SessionTurn`), and no title or owner check.

A conversation is a session whose turns are orchestrator turns. Its
messages are not the session's model transcript (tool calls, prompt
prefixes, `[proposal-result]` lines) but its TURNS, each read from its
run: the person's words (`input.prompt`, or a wake), the reply (`text`,
`ask`, `artifacts` resolved), the proposals the turn made, the jobs it
started (`assistantJobs` over its events), status while in flight.

- **Steps**, over `ctx.services.conversations`: `conversation/list
  { q?, archived?, limit?, before? }` (the viewer's, newest first: id,
  title, updatedAt, unread, a running turn, the jobs), `conversation/get
  { session, limit?, before? }` (its turns, newest first, paged),
  `conversation/rename`, `conversation/archive`, `conversation/seen`.
  Routes beside them (`GET /conversations`, `GET /conversations/:id`), for
  a host and for Peel's person token.
- **The viewer's conversations.** Sessions `<actor>/…`, and the
  sessions whose turn 0 was the viewer's (`createdBy`): Hive's
  conversations are bare ids (`SharedConversation.id`) whose turns ran as
  the person's strut actor, the same actor Hive's frame carries (the
  embed token's `sub` is `target.actor`, `src/services/strut-embed.ts`).
- **Kept per actor.** An index written when a turn commits (session id,
  title, last turn, its status), so a list reads one file, not every
  session.
- **Title.** The first message, cut, as Hive's Jamie chats get today
  (`generateTitle`, `src/lib/ai/conversationHelpers.ts`, truncates; Jamie
  gets no LLM title). Hive's prompts start with its `@<workspace>` line
  (`orchestratorPrompt`), which the title leaves out. A rename replaces
  it.
- **Archive and seen** per viewer, beside the index.
- **Fork.** A new session whose messages are the source's (history is
  append-only, so a copy is safe), so the agent keeps the memory; Hive's
  fork gets a new id and starts the agent cold.
- **Live.** `conversation/get` takes `wait`, held until a turn of it
  lands or settles, as `run/get` waits; the page asks again on each
  answer, at most once a second. Job progress stays `job/updates`.

### 2.1 As built (2026-11-04, branch `feature/conversation-index`)

`src/conversations.ts`, the `conversation/*` steps, the routes in
`createStrut` (`API.md` §9.1). Where it differs from the text above:

- **Four steps, not seven**: `conversation/list`, `conversation/get`,
  `conversation/update { title?, archived?, seen?, shared? }` (rename,
  archive, seen and share are one write of flags), `conversation/fork`.
  Refused under `ctx.app` until the first-party tier (§3).
- **Routes**: `GET /conversations`, `GET /conversations/item?id=` (the id
  may hold `/`, as `/sessions` takes it), `POST /conversations/update`,
  `POST /conversations/fork` (POST, so a person token may make them: the
  gate lets it POST these two). A plain peer reads the routes like any
  peer and sees no conversation.
- **Written when a turn launches and when it ends**, not when it commits:
  a turn that fails commits nothing to the session, and its message would
  vanish from the chat. The launcher (`launchDetached`) records every run
  of a `params.wake` workflow with an `input.session` that opens as itself
  (not a plain peer's `peer/…`, not an app's `app/…`; a person token's own
  session yes) — every host launch, `run/launch`, a wake, an automation.
  The launch is on record before the run starts; the end is recorded from
  the run's terminal event (`RunOptions.onEvent`), before its summary is
  written, so whoever sees the run done sees the conversation say so.
- **Who it is listed for**: who took a turn (the launch's actor, else its
  principal), the first segment of an id with a `/` (`<actor>/…`), and
  whoever opened it while shared. The deployment's key with no actor reads
  any conversation; its list is the no-actor viewer's.
- **Files**: `<dataDir>/conversations/sessions/<id>.json` (the record:
  title, `renamed`, `shared`, `forkedFrom`, viewers, the turns as run ids
  with who, when and status, `rev`) and `viewers/<actor>.json` (a person's
  list: the record's facts copied onto each row, plus their own `archived`
  and `seenAt`), so a list reads one file (open question 8: files).
- **The lazy build** reads turn lines (`SessionStore.turns`, new): a
  session is built when it is first read, and every session at the first
  list (once, stamped `built.json`). Its viewers have read its history
  (no unread). A failed turn from before the index is not there: the
  session never recorded it.
- **A turn** is read from its run: summary and log, settled ones once per
  process. The person's words are `input.prompt` as sent (Hive's
  `@<workspace>` line included; only the title leaves it out); a wake has
  no `prompt` and carries `run.start.wake`. Jobs are `turnJobs`, the
  kit's `assistantJobs` logic copied (the server cannot import the kit).
  Proposals are listed per page, as a person token sees them in a list
  (`visibleTo`).
- **Unread** is `seenAt < updatedAt`, `updatedAt` the last turn's launch
  or end; launching a turn marks it seen for its launcher, so the reply is
  what is new. `running` is the launcher's in-process set.
- **`wait` takes `since`**: `get` answers `rev`, and `wait` holds until it
  moves past `since` (default: the rev now), so a change between two
  polls is never missed.
- **Fork** copies the source's session turn by turn (`appendTurn` per
  turn line, each with its own messages), so the fork replays the same
  thread and reads the same runs; its finished turns show. Its id is
  `<actor>/<12 hex>` unless named (a person token's must be its own).
- **In the graph** (a follow-up, on Neo4j): a conversation is a
  `StrutChat` of `kind: assistant`, the builder chat's type, so a
  conversation is one node however strut holds it. The run projection
  upserts it from the record (title, last status, turn count, who first
  spoke) and draws `IN_CHAT` from each turn's `StrutAgentSession`; a
  rename reaches it with the next turn. Not on a Ladybug file, which holds
  neither agent sessions nor chats.
- **Not built**: the jobs in a list row (read per turn in `get`), the one-off
  export of Hive's renamed titles and archived flags (§7).

### 2.2 Continuing a conversation (ruled and built 2026-11-04)

A person token's turn and a first-party page's open the person's own ids
(`<actor>`, `<actor>/…`) as they are, and any other under their own
namespace (`peer/…`, `app/<name>/<viewer>/…`). Hive's conversations are
bare ids, so the app could read them and not continue them, and a shared
conversation could be read by everyone and continued by its starter
alone. Now the index decides the rest (`continuesFor`, createStrut;
`Conversations.mayContinue`):

- **Who.** A launch of a conversation workflow (`params.wake`) whose
  `input.session` is not the person's own id: a person token's (`POST
  …/run`, either route) or a first-party page's (`run/launch`).
- **May.** A conversation the person took a turn in (a turn whose `by`
  is theirs), or a shared one, opens as it is. The launch records
  `continues: <id>` on `run.start`; `bindPeer` and `bindApp` open that id
  as it is, a resume reads it back (`readRunStart`), and the projection
  maps the run's thread to it. Their turn makes them a participant, so
  unsharing it later leaves it theirs.
- **May not.** Another person's conversation is refused before anything
  launches: `403` from the route, a step error from `run/launch`,
  `conversation_not_yours: "<id>" is another person's conversation …`.
  Having opened it while it was shared is reading, not a turn.
- **No conversation** (no record, and none built from the session): as
  before, the id opens in the caller's namespace. A new conversation's id
  is the person's own (`<actor>/<id>`).
- **Unchanged.** The deployment's key (Hive) opens any id as it is; a
  plain peer's ids stay under `peer/`; a model-written page's under
  `app/`.

## 3. First-party apps (built — §3.1)

The app rules assume a model wrote the page. For an app strut ships, five
of them are wrong:

| Rule | Where | For the assistant app |
|---|---|---|
| Sessions open under `app/<name>/<viewer>/` | `appSessionId`, `src/session-store.ts:99`; `bindApp`, `src/runner.ts` | the conversations are the person's own (`<actor>/…`), shared with Peel and Hive |
| A turn launched from an app drops every tool its `approve:` gates | `appGated`, `src/steps/core/agent.ts:1635` | Jamie proposes graph and Concept writes, as in Hive |
| No step decides a proposal | `proposal/list`, `proposal/get` only | the app shows the cards and decides them |
| Jobs and job ids live under `app/<name>/` | `scopeAppJobs`, `src/apps/tools.ts` | the person's jobs, wherever they were started |
| A sealed workflow opens to a page only through a person's grant, scoped to the app's own runs | `openFlow`, `ownRun`, `src/createStrut.ts` | no grant; the viewer's runs, whoever launched them |

**The tier.** An app is first-party when its name is under `strut/` and
its active version is strut's seed (`source: "seed"`). Its `step_run`
calls act with what the viewer's own person token has (`peer:person`,
`src/auth.ts`), and no more: its actor's sessions, its own proposals (a
`proposal/decide` step, first-party only, the same rule as a person token
at `POST /proposals/:id/decide`), its own jobs and runs. What stays:
no `llm`, `agent`, `exec` or `acp/prompt` from the page (the workflow is
the unit of spend), no authoring, nothing past the viewer.

**Its name is reserved.** Today nothing stops a publish over a `strut/`
name: `validateAppName` (`src/apps/files.ts`) and `apps.publish`
(`src/apps/apps.ts`) check neither, so the builder could publish over
`strut/views` until the next boot puts it back. With a tier attached to
the name, every door refuses a `strut/` name that is not strut's seed:
`app/publish`, `POST /apps`, a package install.

**What it does not change.** A builder's app that imports
`strut/views` or the assistant's components compiles them into its own
document, which runs on its own grants: rights belong to the document's
identity (`app:<name>@<vN>`), never to the code in it. Deliverables the
assistant shows are untrusted content and stay in sanitized views or the
host's sandboxed panel (§4), never in its own document.

### 3.1 As built (2026-11-05, branch `feature/first-party-apps`)

- **The tier** is a mark on the call: the app door (`src/apps/tools.ts`
  `firstPartyApp`) sets `ctx.app.firstParty` when the app is a `strut/`
  name at a version whose `source` is `seed`, the connection has an actor,
  and it is not the public door. Every run the page launches carries it
  (`run.start.app`, and so a resume). With no actor, a `strut/` app is an
  app like any other: the tier is the person's rights, and there is no
  person.
- **The five rules**, each where it was:
  - Sessions: `appSessionId(…, firstParty)` opens `<actor>` and
    `<actor>/…` as they are, as a person token does; any other id stays
    under `app/<name>/<viewer>/`. So a first-party turn is recorded in the
    conversation index (launchDetached reads the same function).
  - Gated tools: the agent keeps its `approve:` tools when `ctx.app` is
    first-party.
  - Proposals: `proposal/decide`, a new step over the capability's
    `decide` (the decide route's code, `decideProposal`), as a person
    token: the viewer's own proposals. It runs only as a first-party page's
    own call (a one-step run), never as an agent's tool: a run the page
    launched carries the page's app too. `proposal/list` under any
    `ctx.app` lists the viewer's own.
  - Jobs: no `app/<name>/` scoping (`scopeAppJobs`, `job/start`,
    `job/continue`).
  - Sealed workflows: `openFlow` opens one with no grant, scoped to the
    viewer's runs whoever launched them (`ownRun`, by actor).
- **The wake**, which §3 left out: a first-party turn is not a relay
  (`wake.ts`), and `run/launch` from the page asks for strut's wake
  (`wakeAsked`), since strut is the page's host.
- **`conversation/*`** under a first-party page, as a person token.
- **The reserved name**: `reservedAppName` (`src/apps/files.ts`) in
  `apps.publish` (a source other than `seed`), `apps.preview`, `POST /apps`
  and the package install's checks.
- Hive's bare-id conversations (every one it has today) are listed in the
  app and readable by their participants; continuing one was ruled and
  built after this (§2.2): a participant's turn, or anyone's in a shared
  one, opens it as it is.

## 4. What the app cannot frame (built — §4.1)

The app's CSP has `frame-src 'none'` (`src/apps/build.ts:176`), and
`run/files` returns base64, 2 MB at most. So the app cannot show, in its
own document: an HTML page an agent wrote with its scripts running, an app
the builder made, a pod's browser, a PDF, a video. Hive shows all of them
beside the chat.

Strut's own UI already renders each of them safely (`ArtifactViewer.tsx`,
`AppHost.tsx`, peers' files through the read-through). The app host gains
a **side panel**: a `ui/open-link` from a hosted app to a strut deep link
`?artifact=<served path>` or `?app=<key>` opens it beside the app instead
of navigating away (today `?artifact=` without `solo` is ignored). In
Hive's frame the whole strut page is the frame, so the panel is inside
it too. The assistant app draws inline what `strut/views` draws
(markdown, text, sanitized HTML, images, sheets, work products, the run
graph, spot checks) and hands the rest to the panel.

### 4.1 As built (2026-11-05, branch `feature/app-host-panel`)

- **The contract for the app** (what item 5 builds on): `useHost().openLink`
  with `?artifact=<encodeURIComponent(served path)>` or `appLink(key,
  input)`. A served path is what `isServedFilePath` takes: a job's files,
  a run's artifacts, either behind `/peers/<id>` hops (a peer-tagged
  deliverable's path is `peerArtifactPath`). Nothing new in the kit.
- **Which links** (`panelTarget`, `web/src/app-links.ts`, tested in
  `web/src/app-host.test.ts`): `?artifact=` with a served path, else
  `?app=` naming an app not on screen. A link to the page itself stays its
  input in place, and `?wf=`, `?run=`, `?job=` keep today's behavior: the
  full UI navigates, the page alone opens a new tab. `artifact` joined
  `strutLink`'s params. A peer's page names files where it lives, so its
  `?artifact=<path>` becomes `/peers/<peer><path>` (`peerAppLink`), as its
  `?app=<name>` already became `@<peer>/<name>`.
- **The panel** (`web/src/components/AppWithPanel.tsx`) wraps `AppHost`
  in the canvas area (`app.tsx`) and alone (`SoloApp.tsx`). The page's frame
  is never moved, so it keeps its state. A file opens in `ArtifactViewer`
  (`solo` with `onClose`), so it gets the viewer's rules: a page strut
  serves runs under its file token (`?t=`; a strut with no secret to sign
  one falls back to `?key=`, as the viewer does everywhere), and a peer's
  file is shown from its bytes, scripts off, with no credential in any URL. An app opens in
  `AppHost` under a title bar; its version comes from the one listing it is
  in (`useListedApp`, `web/src/use-listed-app.ts`, now SoloApp's lookup
  too). A new link replaces the content, and an app's new input goes to it
  in place. ✕ closes the panel. Its left edge resizes it: `WidthResizer`,
  which `FlyoutResizer` is now one config of; frames take no pointer
  events while a drag is on. Below 760 px of container (a container query)
  the panel lies over the page. The panel's own app routes links the same
  way.
- **Left as they were:** the job timeline's app and the viewer's app keep
  `navigateFromApp`, which now returns false for a link it does not open
  (a file), so the link opens in a new tab as before. A visitor's page
  (`&public=1`) has no panel. The panel is not in the address bar, so a
  reload closes it.
- **Checked in the browser pane** against a scratch strut and a peer: a job
  file (markdown), a peer's HTML (static), `strut/views`, `@p2/strut/views`,
  resize, close, the narrow overlay, the canvas area and the page alone.
  The pane refuses any sandboxed frame with a `src` (`ERR_BLOCKED_BY_CLIENT`;
  the modal viewer's frame is refused the same way), so a local HTML page
  with its scripts was checked only as far as its tokened URL serving `200`
  with `sandbox allow-scripts`.

## 5. The app (proposed)

`strut/assistant`, seeded at boot by tree hash beside `strut/views`; its
title is the deployment's (Hive's org page says "Jamie"). (Named
`strut/jamie`, titled Jamie everywhere, since: §5.2.) Ported from
Hive's org page (`src/app/org/[githubLogin]/_components/`):

| Part | From Hive | Over |
|---|---|---|
| Chat list: by day, search, show more, rename, archive, unread | `ChatsLayout.tsx`, `control-panel/`, `mobile/MobileChatList.tsx` | `conversation/*` |
| The thread: bubbles with attachment chips, reply markdown, the question, the working card, Stop, the busy notice | `SidebarChat.tsx`, `SidebarChatMessage.tsx`, `OrchestratorTurnCard.tsx` | `conversation/get { wait }`, `run/launch` (`input: { prompt, session, context }`, `attachments`, `params.model`), `run/cancel`; `session_busy:` |
| Composer: attachments, model picker, slash Concepts, the time zone | `SidebarChat.tsx`, `ModelPicker.tsx`, `slashConceptTrigger.ts` | `run/launch`; an `llm/models` step (new, the list `GET /llm/models` serves); `graph/find` on `Concept`; the host's `timeZone` |
| Job cards and the live strip | `JobTurnCard.tsx`, `JobLiveStrip.tsx`, `jobLiveStore.ts` | the turn's jobs, `job/get`, `job/updates` |
| Proposal cards | `StrutProposalCard.tsx` (bodies from `ProposalCard.tsx`) | `proposal/get`, `proposal/decide` |
| The artifact panel | `artifacts/ArtifactPanel.tsx`, `viewers/` | `strut/views`, `run/files`, the host panel (§4) |
| The claims card, captcha, walkthrough | `viewers/claims.tsx`, `captcha.tsx`, `walkthrough.tsx` | `job/get`'s claims and `run/files`; new first-party steps over the routes Hive calls today (`POST /jobs/:id/verify`, `POST /claims/:id/evidence`), and the captcha answer as a `job` turn naming the conversation |

Not ported: the attention list (nothing imports it), deferred check-backs
(Jamie no longer creates them: `schedule_check` is Hive's own agent's),
LLM titles (Jamie never had them), the legacy `StrutChatCard`, the
batch actions (they cover Hive's pre-strut proposals only), Hive-only
kinds (stored HTML pages, research docs, task pills, the brainstorm tree
over stakgraph's Cypher). Later: pull requests' live state and Merge (the
viewer's GitHub token; a `github/*` read step, Merge as a proposal),
automations from an app (`apps.md` work item 7).

### 5.1 As built (2026-11-05, branch `feature/assistant-app`)

`src/apps/assistant/` (`API.md` §14.11), seeded by
`src/apps/assistant-seed.ts` after `strut/views`; `createStrut({ assistant:
false | { title } })` and `STRUT_HOST_CONFIG`'s `assistant`. Every part of
the table, in one app. Where it differs from the text above, or the text
was open:

- **The seed** is `strut/views`' generalized (`seedBundledApp`,
  `src/apps/views-seed.ts`): the build is cached per (sources, kit, the
  hashes of the installed apps it imports), and a known version whose
  `strut/views` moved is rebuilt in place (the document carries it
  compiled in), never a new version; without `strut/views` (`views:
  false`) there is nothing to build it against and nothing is seeded. **The title** is staged into
  `app.yaml` and `src/deployment.ts` before hashing, so another title is
  another version; "Assistant" by default (Hive's "Jamie" is Hive's to set:
  mcp's `createStrut` call, a follow-up there).
- **New conversations** are `<viewer>/<12 hex>`, the fork's form. The page
  does not know its viewer, so `conversation/list` now answers `viewer`
  (the step only; the capability is unchanged). With nothing open, the
  page opens the newest conversation, else a new one; the open one is kept
  per viewer (`useAppState`), and `?input=session%3D<id>` opens one.
- **Hive's bare-id conversations** (§3.1 "Not built"; ruled 2026-11-05,
  built apart — §2.2): the page sends into whatever `conversation/list`
  shows, bare ids included, and the server decides. A
  `conversation_not_yours:` refusal (someone who read a conversation while
  it was shared, since unshared) is a plain notice. A captcha's answer
  names its conversation the same way: `run/launch { conversation }` takes
  one the viewer may continue (`mayContinue`: their own, one they took a
  turn in, a shared one).
- **The model picker** is `llm/models` (new, `src/steps/lib/llm/models.ts`,
  over `ctx.services.llmModels`, the catalog `GET /llm/models` now reads
  too), its choice per viewer (`useAppState`, Hive's per-user preference),
  sent as `params.model`; "Default" sends none, so the turn runs on the
  template's model.
- **The context**: `{ line, where, timeZone }` — `line` Hive's time format
  (`Wed 4 Nov 2026, 14:02, Europe/London. `; ICU may add a comma after the
  weekday) then `where`, which says the reply is read in full with each job
  as a card; the zone is the host's (`ui/initialize`'s `timeZone`).
- **Live**: the list is read every 5 s; the open conversation is held with
  `conversation/get { wait: 25 s, since: rev }` (the kit feeds' 25 s), a
  call a second at most, none while hidden, and marked seen while open.
  A job card follows its run with the kit's `useRun { live }` and, while it
  runs, `job/updates` for the strip (the job's line, then shots,
  recordings, holds and verdicts counted).
- **A wake** is a quiet line ("hello.md finished") over the reply; a
  `[silent]` reply shows nothing. The job's own card stays under the turn
  that started it, Done once it is.
- **Claims and captcha**: `job/verify` and `job/evidence` (new) are what
  `POST /jobs/:id/verify` and `POST /claims/:id/evidence { job }` do, over
  `ctx.services.jobs.verify` / `.evidence` (createStrut, where the claims
  layer is on); a first-party page's own call only, on a job the viewer ran
  (`actors`). Verify goes detached and ends on the job's `verify` update. A
  claim waiting on a person's look gets "It does" / "It doesn't" (its slot
  answered). The captcha is drawn from its manifest through `run/files`;
  the answer is a job turn (`run/launch { job, input: { prompt:
  "[captcha-answer] {…}" } }`) that names the conversation — `run/launch`
  now takes `conversation`, from a first-party page only and only one
  the viewer may continue, so the wake finds it. Only a person who ran the job is
  offered the answer.
- **Deliverables**: inline what `strut/views` draws (`ArtifactView`,
  `SheetView`, `DocumentView`) through `run/files` on the run that made
  them — the turn's own, a job's from the turn's jobs, else the job's newest
  (`job/get`); "Open" hands any served file to the host (`?artifact=`), and
  a PDF, a video, an app (`?app=<name>@<vN>`) or a peer's file (the kit's
  `peerArtifactPath`) go there only. Item 4's panel opens them beside the
  app; without it they navigate.
- **Replies** are markdown in the bubble (react-markdown, links through the
  host); a file is DocumentView's box.
- **Not built**: adding a claim from the card, Hive's attention and recap
  cards, voice input. (The jobs under each list row and pull requests were
  first left out here; built in §5.2.)

### 5.2 Jamie, jobs in the list, pull requests (2026-11-05, branch `feature/jamie-jobs-prs`)

Ruled 2026-11-05: the app is **Jamie** (open question 5), and the list and
pull requests are Hive's, not later items.

- **The name.** `strut/jamie` (`src/apps/jamie/`, `src/apps/jamie-seed.ts`),
  titled Jamie everywhere; the deployment's title is gone
  (`createStrut({ jamie: false })` and `STRUT_HOST_CONFIG`'s `jamie: false`
  turn it off). `strut/assistant`, its name before, is removed at boot,
  grants and page state with it: no host linked to it yet.
- **Jobs in the list** (Hive's `ControlPanelList`): the conversation record
  keeps the jobs its turns started or continued (`jobs`, least recently
  first), read once from each turn's log when it ends (`turnJobs`); a
  record from before is filled in the background at its next list.
  `conversation/list` answers each row's jobs, newest first, at most 10
  (`moreJobs` for the rest), each with its record's title, whether a turn
  of it is live, and the pull requests its turns delivered (artifacts of
  kind `pull_request` with a GitHub link, settled runs read once). The row
  shows the newest job, the rest behind "N more", a pulse while one runs,
  and the conversation's pull requests counted; a job opens the
  conversation at its card.
- **Pull requests** (Hive's `pullRequest.tsx`): `github/pr-status` reads one
  as GitHub has it now — state, branches, checks (check runs and commit
  statuses, failed first), mergeable — with the viewer's own `GITHUB_TOKEN`
  (the actor secret a host pushes), again every 30 s while it is open or a
  draft. **Merge** is `github/merge-pr`: the person's click, never a
  proposal, squash by default and the first method the repository allows
  when it refuses squash, at the head the person saw (`pr_head_moved:`
  otherwise), refused for a closed, draft or conflicting one. It runs only
  as a first-party page's own call or as an accepted proposal, so an agent
  can ask for a merge and never make one. **Fix**, when checks failed: the
  job's next turn, told which checks and the branch, naming the
  conversation so its end wakes it. One card per pull request per thread,
  at its newest mention; a collapsed job card keeps its own in sight unless
  the thread shows them. Without a token the card says GitHub cannot be
  read, and Merge says why.

## 6. The hosts' halves (proposed)

### 6.1 Hive

Ruled 2026-11-05: Hive goes once Jamie is fully in strut. Until then it
has to keep working, and nothing more: the items below are only what it
needs to frame the app and not double its replies.

The wake half is built (stakwork/hive#5705, 2026-11-05): Hive asks for
strut's wake, adopts its wake turn, and skips its own when `run.end` says
`wake: "launched"`; its own wake stays for a swarm on an older strut.

- Name the conversation on every job turn it launches itself (`POST
  …/run { conversation }`), except event turns while their wake stays
  Hive's.
- Adopt a strut-launched wake turn in the webhook (§1.5), writing the
  rows its own wake writes today (the launch marker with the wake's id,
  the reply), so the tribe outbox and the call feed thread and read it as
  now.
- Send `context.where` and `context.timeZone` beside `context.line`
  (done on Hive's master).
- Stop waking for a job whose `run.end` says `wake: "launched"`;
  `"capped"` shows the job's words.
- Frame `?app=strut/jamie&solo=1` through the embed URL it already
  mints, behind a flag, then in place of the chat.

### 6.2 Peel's bridge

Forward an org's job `run.end` from its room to the local strut's
`POST /conversations/wake`; keep catch-up (it decides what to forward)
and delivery (the DM, the job and deliverables as metadata). Drop its own
prompt and gates.

### 6.3 Voice

Deferred (2026-11-05). The 1:1 call moves onto the wake, as group calls already are: the wake
turn's `run.end` reaches the member's callback and is said like a reply,
its question last. The instant line from the job's own output may stay
as a "the job finished" ping before it; it never stands in for the
question.

## 7. Turning it on

Two wakes for one job is two replies. A host asks for strut's wake on
each launch it makes (`wake: true`, as built: §1.6), and strut answers
that it honors it: the 202 carries `wake: true` (as it carries
`callback: true`; an older strut ignores the field and never wakes), and
every job `run.end` says what strut did (§1.4). A host turns its own wake
off for the conversations it asked for, never by a deploy date, so a
swarm on an older strut keeps the host's wake, and a host that has not
moved yet is never woken by strut.

Existing conversations need no export to appear in the app: each already
has its session on the swarm, its turns ran as the person's actor, and
nearly every card Hive draws comes from runs (artifacts, proposals,
`job_start` calls, wakes). What Hive alone holds: renamed titles, the
archived flag, and the conversation of a job turn Hive launched before
it named conversations. A small one-off export carries the three, or they
are lost.

## Work items

1. **The wake** (strut, §1): trigger in the run-end hook, the
   `conversation` launch field, `POST /conversations/wake`, `params.wake`
   in the orchestrator template, `context.where` / `timeZone`, the gates,
   the `wake` fields on `run.start` / `run.end` / the turn line, `wake:
   true` in the 202. Tests with a stand-in provider.
2. **Conversations** (strut, §2): the per-actor index, the
   `conversation/*` steps and routes, fork, `wait`.
3. **First-party apps** (strut, §3; built — §3.1): the reserved `strut/`
   name on every door, the tier's rights in `step_run`, `proposal/decide`.
4. **The host panel** (strut web, §4; built — §4.1).
5. **`strut/jamie`** (strut, §5; built — §5.1, §5.2), the `llm/models`
   step, jobs in the list, pull requests.
6. **Hive** (§6.1), behind the 202's `wake: true`.
7. **Peel's bridge, voice** (§6.2, §6.3).
8. **`DESKTOP.md` §5** points at the template's prompt.

1, 2 and 6's wake half land without the app, and fix the drift in §1.1 on
their own.

## Open questions

1. ~~**Shared conversations.**~~ Kept (2026-11-04, Decided): several
   people, listed for each participant, a `shared` flag readable to any
   actor here; built in §2.1.
2. **The loop cap's fallback**: the host shows the job's words as they
   are (proposed, Peel's), or nothing (Hive's).
3. ~~**Who a wake runs as**~~: ruled 2026-11-05 as built (§1.6) — the
   person who asked for the job; for an end from another strut, which
   names nobody here, the last person who took a turn.
4. **Queued ends**: one turn for every job that ended meanwhile
   (proposed), or one turn each (Peel).
5. ~~**The app's name**~~: Jamie, `strut/jamie` (ruled 2026-11-05; §5.2).
6. **Event wakes** (a job turn started by something that happened to an
   artifact) stay Hive's until artifact events move to strut.
7. **GitHub tokens.** Hive pushes the person's `GITHUB_TOKEN` before
   every turn it launches; its GitHub App's user tokens do not expire (an
   earlier draft said 8 hours: wrong), so a wake or a Merge uses the one on
   file. What is open: a person Hive never launched a turn for has none on
   the swarm, and once Hive goes nothing pushes one. Strut then needs its
   own way to connect a person's GitHub (`org-home-swarm.md`).
8. ~~**Where the conversation index lives**~~: files under `dataDir`, on
   every backend (§2.1).
