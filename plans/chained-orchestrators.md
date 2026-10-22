# Chained orchestrators: a desktop strut, its orgs, rooms and pairing

> **Status (2026-10-22): proposed, the shape ruled.** From one design
> conversation with the owner. The rows in "Decided" marked **ruled** are
> his; the rows marked *proposed* are mine and open until he says
> otherwise. Nothing is built. Written against strut `main` @4150016
> (this worktree); hive and stakgraph are cited from memory of their
> merged state on 2026-10-21 and described only as the contract strut
> reads. Companion to `federation.md` (peers, dispatch-through, the
> deferred read-through, `peer: true`), `builder-job.md` (the `job` /
> `builder` split and the peer build), `jobs.md` + `live-artifacts.md` +
> `specs/CALLBACKS.md` (what a run tells its host, and when),
> `local-desktop-and-stt.md` (strut as a desktop app's child process),
> `mothership-cost-control.md` + `org-gateway.md` (who pays), and
> `apps.md` §6 (the job app this plan retires).

## Problem

Strut is about to run in two places for one person: on their laptop, as
a desktop app's child process (`local-desktop-and-stt.md` §2), and on
each of their orgs' swarms, where hive's Jamie already runs the
`orchestrator` workflow on the org's central strut. The person wants ONE
conversation that feels intelligent: it knows what is being worked on in
every org they are in, it can build a workflow on any of those orgs'
swarms, and it can do work on their own machine against their own
checkouts. Today:

| Has | Lacks |
| --- | --- |
| the `orchestrator` seed: one turn of a conversation, routes by the `Job` and `Workflow Builder` kinds, starts jobs detached (`src/workflows/orchestrator.yaml`) | any way for one orchestrator to reach another: it is `sealed: true` and not `peer: true` |
| dispatch-through: `strut/run-workflow` runs a `peer: true` workflow on a peer and waits on its SSE tail, reattaching (`federation.md` §2.2; the peer build in `builder.yaml`) | a NAT'd caller hearing about a job it started THERE once its own run has ended: `run.end` goes to the launching run's callback, an http(s) URL (`src/callback.ts`), and a laptop has none |
| peers on file: `PUT /peers/:id`, `STRUT_PEERS`, hive's nightly cron filling the org strut's list with its spokes (hive#5470) | a way for a laptop, which hive cannot push to, to get a credential for an org's central strut |
| `lab:peer` tokens minted by mcp with a `sub` (`mcp/src/repo/events.ts`, stakgraph#1754) | tokens minted FOR A PERSON to hold about a swarm: hive mints them for central to hold about spokes, unscoped to the person (an open issue since 2026-10-21) |
| a peer's deliverables tagged `{ peer, job }` and left unresolved (`strut/run-workflow` `tagArtifacts`; `artifact-refs.ts`) | a tag that survives two hops: the laptop has no record for a spoke, only for central |
| a job's app (`apps.md` §6, strut#262): a third way to get an app, beside an HTML file in the job's folder and a workspace app the builder publishes | a reason for it: a page that only shows the job's results is an HTML file; a page that does things is a workspace app |

## Decided

| Question | Decision |
| --- | --- |
| Flat or chained peering for the laptop? | **Ruled: chained.** The laptop holds ONE peer per org: that org's central strut. It never holds a spoke. The local orchestrator decides only WHICH ORG a request belongs to (or that it is local); everything past that is the org's to decide. |
| What does the laptop call on central? | **Ruled (a consequence the owner accepted): the org's `orchestrator`.** Not `job`, not `builder`. The org orchestrator already has the routing brain: both kinds lists, its job index, its peers, its lookups, `ask`. Teaching central's `job` agent to pick swarms would duplicate it. One orchestrator per SCOPE: the laptop's is the person's across orgs, central's is the org's; a call goes DOWN the chain, never sideways or up. |
| Does `job` become peer-executable? | **Ruled: no.** A job runs where its orchestrator is: on central beside the org's pods and secrets, on the laptop against the person's own checkouts. What crosses struts is a WORKFLOW that lives elsewhere (`builder` with `peer`) or a READ of what is elsewhere (`explore`, any `peer: true` lookup). The `peer` refusal on `job/start { workflow: job }` stays; its reason is this sentence, not the old "no shell for a peer". |
| How does a job's result reach the laptop? | **Ruled: the callback contract over a different transport, a WebSocket ROOM on central**, not a tail-watcher. Same payloads (`run.end`, `job.update`, `turn.end`), same inheritance (the jobs a run starts post to the launching run's callback). The laptop dials in and stays; central never dials out. |
| How does the laptop get a credential for central? | **Ruled: a pairing flow in hive**, shown as a QR / magic code / short device code. Hive is the only party that can mint on every org's mcp and knows the person's orgs. Strut's paste door (`PUT /peers/:id`) is the sink; nothing in strut's auth changes. |
| Is `Job App` kept? | **Agreed: retire the kind now; remove the runtime later.** The middle category is empty (§6). The runtime from strut#262 stays until hive's job-app path (`StrutAppFrame`, hive#5585) is confirmed dead, then goes whole. **Checked the same day (a forked session read strut and hive):** a builder-PUBLISHED app reaches a hive conversation only as text today, and hive's frame in conversations accepts only the job-directory form of `kind: "app"`, so the retirement ships WITH a workspace-app deliverable, `{ kind: "app", app: <name>, version? }` (§6), or the only live-app path into a conversation goes with it. |
| Which session does the laptop's call open on central? | *Proposed:* with a PERSON-scoped token, the person's OWN session, not `peer/<id>` (§2). Then the laptop and hive's web share one conversation per org. The one place the peer namespace should bend. |
| Who is a room? | *Proposed:* the actor. The room id is the token's `sub`, never chosen by the client; a second device of the same person joins the same room. `callback: { room: true }` means "the launching actor's room" (§3). |
| Where does the laptop's own model call bill? | *Proposed:* the person's own key under Secrets, or a delegation from their default org's gateway carried in the pairing payload (§4). Which org bills a local turn before an org is chosen is a product call. |
| How does a spoke's deliverable open from the laptop? | *Proposed:* as a link through central, never a copy: a tag means the NEXT hop, and central's read-through (`federation.md` §2.1, deferred) serves a spoke's file (§5). |

## Design in one paragraph

A person's laptop runs strut with the same `orchestrator` seed the org's
central strut runs. Its peer list holds one record per org, the org's
central, each with a `lab:peer` token minted FOR THE PERSON by hive at
pairing. A local turn decides whether the request is about this machine
(a local job against the person's checkouts) or about an org; for an org
it runs that central's `orchestrator` through `strut/run-workflow`, on a
stable per-person session, waits on the tail (an orchestrator turn is
short by design: it asks, answers from what it knows, or starts jobs
detached and ends), and relays the reply verbatim, its `ask` as its own.
Central's orchestrator does what it does for Jamie: routes by its two
kinds lists, starts `job` here and `builder` here or on a spoke. What
those jobs produce later reaches the laptop the way it reaches hive, as
callbacks, except that the transport is a WebSocket room on central the
laptop keeps open, keyed by the person. The desktop app plays hive's
role at the laptop's scope: it receives the room's events, shows the
deliverables (links, resolved through central), and launches the local
orchestrator's wake turn with a job's reply. Memory is per scope: the
person's on the laptop, the org's on central.

## 1. Two orchestrators, one chain

```
person ──── desktop app ──── local strut: orchestrator (the person's, across orgs)
                                  │  decides: local, or which org
                                  │  local job ──► job (own checkouts, own tokens)
                                  │
                                  └─ strut/run-workflow { peer: @org, workflow: orchestrator,
                                                          input: { prompt, session: <person/org> } }
                                                   │ waits on the tail (short turn)
                                                   ▼
                                     central strut: orchestrator (the org's)
                                                   │ routes by Job + Workflow Builder kinds
                                                   ├─ job/start ──► job (here: pods, org secrets)
                                                   └─ job/start { workflow: builder, peer: @spoke }
                                                                  │ builder.yaml: strut/run-workflow
                                                                  ▼
                                                        spoke strut: builder (the workflow lives here)
```

What each hub knows, and what it needs to know, is deliberately small:

- **The laptop's orchestrator** needs enough to pick an org: one line
  per peer. The peer record's `label`, `description` and `repos` already
  carry that (`strut/list-peers`). It does NOT need the org's spoke
  list, kinds or job index: that context lives on central, and central
  reads it. Its own kinds lists are what a local deployment seeds
  (strut's `Job` and `Workflow Builder` roots; nothing org-specific).
- **Central's orchestrator** is unchanged in what it reads and does. It
  gains one caller. Its host tools (hive's MCP, Peel's grants) ride on
  the LAUNCH (`mcp`, the host's delta), so a turn the laptop launches
  has none of them: fine for v1, those are the host's, not the org's
  work.
- **No hub calls up or sideways.** Central never calls the laptop
  (NAT, and nothing to say). A spoke never calls central. The chain is
  one direction, and the orchestrator is the only workflow that calls
  an orchestrator.

The local orchestrator's seed is the SAME workflow. Its routing question
is different ("my machine, or one of my orgs?"), which is the host's
section of `params.system` (`createStrut({ orchestrator: { system } })`,
`STRUT_HOST_CONFIG`): the desktop app writes it, as Peel and the lab
write theirs. No second seed.

**Relay, never retell.** The local turn's `text` for an org request IS
the org orchestrator's `text`; its `ask` passes through as the local
`ask`; its `artifacts` pass through as they came. The prompt says so in
one line. A conversation agent paraphrasing a conversation agent is the
telephone game this design otherwise invites.

## 2. Opening the orchestrator to a peer, on the person's own session

`orchestrator.yaml` gains `peer: true`. It stays `sealed: true`: sealed
is what the META surface may not run (`sealed.ts`); `peer` is what
another strut may launch. The two are independent today and stay so.

A peer launch runs the workflow as published (no `params`; `peerLaunchBody`
in `createStrut.ts`) and namespaces what it names: the `job` as
`peer/<job>`, every agent session as `peer/<id>` (`bindPeer`, `runner.ts`;
`peerScoped`, `session-store.ts`). For the orchestrator that namespace
is wrong in one case and right in every other:

- **Right:** a peer's token that stands for a STRUT (hive's cron-minted
  tokens, no `sub` or `sub` = a strut) must never open a local person's
  thread. Keep `peer/`.
- **Wrong:** a token minted for a PERSON (§4: `sub` = the person, by
  hive, at pairing) opening the person's own conversation with the org.
  If the laptop's session is `peer/<person>/<org>` and Jamie's is the
  person's, the person has two conversations with the same org that
  never meet. The whole point was one.

*Proposed rule:* a peer request whose actor is a person (the token's
`sub`, honored as `x-strut-actor` is today) may name a session that
belongs to that actor: `bindPeer` leaves `<actor>/…` ids alone and
namespaces the rest. The session id the laptop uses is
`<person>/<org-slug>`; hive's Jamie uses the same when it launches for
that person (today Jamie's session id is hive's own; one line there).
Nothing else bends: `job` stays `peer/<job>` (a peer-launched
orchestrator turn starts jobs through `job/start`, which mints LOCAL
job ids on central, so the person's jobs are central's jobs, found by
`GET /jobs?mine=1` as hive finds them).

## 3. Rooms: the callback contract over a socket the client holds open

The contract does not change. `specs/CALLBACKS.md` says what a run tells
its host: `run.end` with the deliverables resolved to links, `job.update`
as things change (`live-artifacts.md`), `turn.end` for a chat. Every
job a run starts inherits the launching run's callback
(`rootCallbackOf` / `setRunJobCallback`, `createStrut.ts`; CALLBACKS.md
§5). What changes is that a callback may name a ROOM instead of a URL.

- **A room is an actor.** `GET /rooms` upgrades to a WebSocket (the
  `ws` server `audio/ws.ts` already hangs on the listener; a second
  path there). The credential is a Bearer header on the upgrade: a Node
  client can set one, so no `?key=` (mcp's `labAuth` refuses a peer
  token in a query string, rightly). The room id is the request's actor
  as the gate resolves it (`resolveActor`, the token's `sub` on a swarm).
  A client never names a room. Two devices of one person share one room.
- **`callback: { room: true }`** on a launch (beside `url`, exclusive
  with it) means "deliver to the launching actor's room". `parseCallback`
  accepts the shape; the run store keeps `callback.json` as `{ room:
  <actor> }`; `postCallback` gains a second delivery: write the same JSON
  to every open socket of that room. `run.start` records
  `callback: { room: true }` (no actor, as it records an origin and no URL
  today). Inheritance is untouched: a job started by a room-called run
  posts to the room.
- **The chain needs ONE room, on central.** The laptop launches central's
  orchestrator with `callback: { room: true }`; `strut/run-workflow` gains
  a `callback` pass-through for exactly that value (today it forwards no
  callback, since a URL of the caller's is meaningless to the peer; a
  room is the peer's own). The org orchestrator's jobs inherit it. A
  spoke's build returns to central through the tail central's builder
  run already holds (`builder.yaml`'s `strut/run-workflow` branch), and
  central posts. Spokes know nothing about rooms.
- **Buffer while away; reads are the backstop.** A laptop asleep must not
  lose a `run.end`. Per room, a bounded in-memory queue (the events
  sink's posture, `events-sink.ts`: oldest dropped past a cap, nothing in
  a run waits on it), flushed in order on reconnect. On reconnect the
  client also reconciles with `GET /jobs?mine=1` and `GET /jobs/:id`, the
  fallback the URL callback already names. Not a durable queue: the log
  is the record.
- **Who does the waking.** The DESKTOP APP joins the room, not the local
  strut. It is hive's twin at the laptop's scope: it shows the
  deliverables and, on a job's `run.end`, launches the local
  orchestrator's next turn with the job's reply inline, as hive's
  orchestrator wake does (hive#5563, `strut-orchestrator-wake.ts`). That
  keeps the `[job-result]` injection out of strut, the reason it was
  withdrawn on 2026-10-21: the host wakes at every scope, and no reply
  arrives twice.

## 4. Pairing: hive's device flow, a person-scoped token per org

Two layers, kept apart: **may you call** (strut's request auth: the
deployment key, the peer key, mcp's `lab:peer` JWT whose `sub` is the
actor) and **who pays** (the Mothership: a delegation per person per
strut, pushed by hive, read only when a model is called). Pairing needs
the first and may carry the second. Hive issues both: it holds every
swarm's admin token and knows the person's orgs.

The shape is the OAuth device flow, built for a device that can reach
out and cannot be reached:

1. The desktop app asks hive for a pairing code and shows it: a short
   code, and a QR of the same link. A phone (Peel) scans; a desktop
   types the code or opens the link in the browser that is already
   signed in to hive through GitHub.
2. Hive's pair page says "connect this device to orgs A, B"; the person
   approves.
3. The desktop polls hive's pair endpoint with the code and receives
   **one peer record per org**: `{ id: <org slug>, baseUrl: <central's
   /lab>, token: <lab:peer, sub = person>, label, description, repos }`.
   It writes each through `PUT /peers/:id` on the local strut.

Two details make it last:

- **A device credential in hive, short peer tokens on the swarms.** At
  pairing hive issues the device its own long-lived credential; the
  per-org `lab:peer` tokens are short (a week). The desktop renews them
  daily through one hive endpoint, "my strut peers", which is also how
  it learns a new org, a rotated token or a swarm that moved. Revoking
  the device in hive stops the renewal; the tokens age out. A `dev`
  claim beside `sub` tells central's devices apart; the room stays
  keyed by `sub`.
- **The same payload may carry a delegation for the laptop's own model
  calls.** The local orchestrator needs a model. A person may paste a
  key under Secrets; a laptop with none can receive, at pairing, a
  delegation from their default org's gateway and `PUT
  /llm/delegations/:actor` on itself (`mothership-cost-control.md`).
  Which org bills a local turn made before an org is chosen is a product
  call, not a mechanism.

What this fixes on the way: hive's peer records are today unscoped to
the person (`otherSwarms`, every active org workspace, open since
2026-10-21). A token minted for a person at pairing is scoped by
construction; the cron's strut-to-strut tokens can follow the same
`sub` rule later.

Nothing in strut changes for pairing. mcp's `/mint-token` already takes
`sub` for `lab:peer`. The pairing endpoints and the device credential
are hive's; the pairing screen is the desktop app's.

## 5. Deliverables across two hops: links, next-hop tags, read-through

A deliverable is one live file behind one link (`jobs.md` §3); the chain
keeps that and copies nothing. Three cases:

- **Central's own.** `run.end` carries `/jobs/<id>/files/…?t=` on central;
  the desktop opens it with central's file token. Nothing new.
- **A spoke's, through central.** The spoke's builder returns `artifacts`
  that central's `strut/run-workflow` tags `{ peer: <spoke>, job }` and
  leaves unresolved. Central's orchestrator hands them on. The laptop has
  no record for the spoke, so the tag must mean the NEXT HOP, not the
  origin: central re-tags what it forwards as `{ peer: <central>, via:
  <spoke>, job }` (*proposed*; `tagArtifacts` today keeps an existing tag,
  the right rule within one hop and the wrong one across two), and the
  file opens through central's read-through:
  `GET /peers/<spoke>/jobs/<job>/files/…`, served with central's token.
  That is `federation.md` §2.1, deferred when dispatch went first; the
  chain is what makes it necessary.
- **Inline content.** As it came.

The same next-hop rule holds for `nodes` (a peer-tagged `ref_id` is
opened through the strut that can resolve it) and for a transcript link.

## 6. Retiring the job app

Three doors to an app was one too many, and the orchestrator showed it on
2026-10-22 (it told a person apps cannot be built on a peer). The job
app's one distinction was a page that calls strut back live, through the
job's narrowed token. But a page that only SHOWS the job's results is an
HTML file in the job's folder with its data beside it, which the artifact
route already serves with scripts allowed (`artifactHeaders`); and a page
that DOES things (launches a workflow, reads the graph) is a workspace
app, the builder's by the 2026-10-22 ruling. The middle is empty.

- **Now (small):** retire the `Job App` Concept (`STRUT_CONCEPTS.retired`,
  soft-deleted at boot, as `Workflow Build` was); drop `app/init`,
  `app/build`, `app/get` from the `job` seed's tools; the `Job` page's
  "an app that shows THIS job's own results is yours" sentence goes, and
  "show me this interactively" points at an HTML page in the job's
  folder. The runtime from strut#262 stays, unused.
- **With it, not after: a WORKSPACE-APP deliverable.** Today the builder
  reports an app it published in its reply's TEXT; `kind: "app"` in
  `artifact-refs.ts` covers only a directory inside a job (`path`), and
  hive's conversation mapper frames only that form (its `StrutAppFrame`
  takes a workspace-app source too, but only the benchmark page uses
  it). So retiring the kind alone removes the one way an app appears
  live in a conversation. The builder's `artifacts` gain `{ id, kind:
  "app", title, app: <name>, version? }`: a pointer to the published
  version, never a directory; `resolveArtifactRefs` resolves it to the
  version's document (`/apps/<name>/<vN>/files/dist/index.html` with its
  file token) and puts `app: { name, version }` beside the url, the
  shape hive's frame already reads for a workspace app; the `App` page
  tells the builder to hand one back. Hive maps the new form onto the
  frame source it has. Small on both sides; the host's half is one
  mapper case.
- **Later (whole):** the `{ job, path }` identity (`AppRef` union,
  `jobAppIdentity`), the job's narrowed file tokens, `kind: "app"`
  deliverables, `JobAppPanel` and "Publish as an app", the kit's job
  variant of `useApp`, the `Job App` page file. Only once hive's
  `StrutAppFrame` job path (hive#5585) is confirmed to have no caller;
  the published-app path there keeps working. Never in pieces: a
  half-removed identity type is worse than an unused one.

## Non-goals (v1)

- The laptop reaching a spoke directly, or holding one as a peer.
- Central calling the laptop, for anything.
- A durable room queue. The log is the record; the client reconciles by
  reading.
- Hive's host tools on a laptop-launched central turn.
- A merged `job` + `builder` agent. Two manuals, two tool sets, one verb
  to the person: unchanged (`builder-job.md`, amended 2026-10-21).
- `peer: true` on `job`.
- Pairing without hive (a strut nobody hosts): `STRUT_PEERS` is still
  the paste door.

## Work items

Strut, in order; each its own PR, each testable with two struts from one
checkout as strut#261 did (a third for the spoke in item 5).

1. **Retire the `Job App` kind, and ship the workspace-app deliverable
   in the same PR** (§6). Concept retired, seed tools dropped, `Job.md`
   reworded, tests on the seeds; `{ kind: "app", app, version? }` through
   `resolveArtifactRefs` with `app: { name, version }` beside the url,
   the `App` page's handover line, a test on the resolution. Hive's
   mapper case lands beside it so a conversation never loses the frame.
2. **The orchestrator open to peers, on the person's session** (§2).
   `peer: true` on `orchestrator.yaml` (content: the version hash moves,
   the seed republishes); the `bindPeer` exception for a person-scoped
   actor; `strut/run-workflow` carries `session` through `input` as any
   field. Test: strut A launches B's orchestrator twice on one session
   and the second turn remembers the first; a strut-scoped token on the
   same session lands in `peer/`.
3. **Rooms** (§3). `GET /rooms` on the ws server, Bearer-only; `callback:
   { room: true }` through `parseCallback`, the run store, `postCallback`;
   inheritance unchanged; the bounded per-room queue; `strut/run-workflow`'s
   `callback` pass-through for the room value only. `specs/CALLBACKS.md`
   gains a section. Test: A launches B's orchestrator with a room, B's
   turn starts a job, A's socket receives the job's `run.end`; A asleep
   through it receives it on reconnect; a job started by a room-less run
   posts nothing.
4. **The local orchestrator's host section** (§1). Nothing in strut but
   a documented delta: the desktop app's `STRUT_HOST_CONFIG.orchestrator`
   text ("my machine, or one of my orgs; relay verbatim"). A fixture test
   that the seed renders it. The desktop side is `local-desktop-and-stt.md`'s.
5. **Next-hop tags + read-through for files** (§5). `tagArtifacts`
   re-tags on forward; `GET /peers/:id/jobs/:job/files/…` and
   `/peers/:id/artifacts/:runId/…` proxied with the peer's token
   (`federation.md` §2.1, the files slice only). Test: three struts, a
   spoke's deliverable opened from the laptop through central.
6. **Remove the job-app runtime** (§6, the whole half), after the hive
   check.

Hive: the pairing endpoints and device credential (§4), person-scoped
`lab:peer` minting, Jamie's session id = `<person>/<org>`, the
conversation mapper's case for `{ kind: "app", app, version }` onto the
workspace-app frame source (§6), then `StrutAppFrame`'s job path retired. Desktop app: the pairing screen, the room client, the
wake turn, the peer refresh. Described here only as what strut reads.

## Validation

| Case | Expect |
| --- | --- |
| laptop in two orgs asks "what is X working on in @acme" | local turn picks `acme`, runs central's orchestrator on `<person>/acme`, relays its text; nothing local ran |
| "fix the typo in my local checkout of foo" | a local `job`, the person's own token; central never called |
| "build a nightly report workflow on the billing swarm" | central's orchestrator starts `builder` with `peer: @billing`; the laptop's room gets `run.end` with the deliverable tagged next-hop; the link opens through central |
| the laptop sleeps for an hour mid-job | on reconnect the room flushes the `run.end` in order; `GET /jobs?mine=1` agrees |
| the same person asks Jamie on the web, then the laptop | one session per org: the laptop's turn sees Jamie's |
| a strut-scoped peer token names `<person>/acme` | lands in `peer/`, as today |
| a device revoked in hive | its tokens stop renewing; within a week every `PUT /peers` it made is dead; the room refuses the stale token |
| a job agent asked for "a dashboard over these results" | an HTML page in the job's folder, opened as an artifact; no `app/*` tool offered |
| the builder publishes an app from a conversation | `run.end` carries `{ kind: "app", app, version, url }`; hive frames it live; the same `id` next turn is the next version |

## Open questions

- Does a peer-launched orchestrator turn on central count against the
  org's auto-turn / wake guards the way Jamie's does? Hive's guards are
  hive's; a laptop-launched turn bypasses them. Probably right, since the
  laptop's host has its own.
- A `[compaction]` of the shared org session happens on central under
  whichever turn crosses the mark, Jamie's or the laptop's. Both replay
  from `replayFrom`; nothing to do unless the summarizer needs the
  launching host's section.
- The local turn waits on central's tail. An orchestrator turn that runs
  a slow lookup holds the laptop's turn with it. Acceptable until it
  isn't; `wait: false` plus the room is the escape.
