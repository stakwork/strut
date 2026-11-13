# The server: createStrut, hosts and peers

`createStrut()` and what surrounds a run over HTTP: callbacks, rooms, the drain, the events sink, the MCP servers a caller or the deployment brings, and peers (other struts).

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Stack

| Concern | Choice |
| --- | --- |
| HTTP        | Hono + @hono/node-server                                                   |

## Key concepts

- **`createStrut()` is the primary entry point** (`src/createStrut.ts`).
  It builds a configured instance — Hono `app`, `workspace`, `store`,
  `services`, plus `run()`/`listen()`/`rebuildRegistry()` helpers — and
  mounts every route (`/workflows`, `/steps`, `/secrets`, `/chat` +
  `/chats`, `/health`, static UI). Everything is injectable via
  `StrutOptions`: pass your own `workspace` (any `WorkspaceStore`),
  `registry` (disables step discovery + publishing), `store` (e.g.
  `MemoryRunStore`), `chatStore`, `secretStore`, `services` bag,
  `dataDir`, or toggle `serveUi`/`enableChat`.
  **Storage boundary:** nothing outside `workspace.ts` reads a workspace
  directory. `WorkspaceStore` exposes custom step code two ways —
  `getStepSource(type)` (text, all tiers) and `materializeCustomSteps()`
  (an importable dir for `buildRegistry`). The inherently-local things —
  run artifacts, step cassettes, the chat builder's shell cwd + scratch/ —
  hang off `dataDir` (default: the file workspace's root, so a
  file-backed deployment keeps one directory). Unspecified store defaults
  follow the workspace's kind (file → file stores under `dataDir`; any
  other impl → memory); an explicitly passed store always wins, and no
  capability is gated on a concrete class. `storage-conformance.test.ts`
  is the boundary's spec — a new backend passes by running it.
  **Graph backend:** `GraphWorkspaceStore` (`src/graph/workspace-store.ts`;
  `Neo4jWorkspaceStore` is its first name, kept as an alias) over any
  `GraphBackend` — Neo4j, or a LadybugDB file (plans/ladybug-backend.md) —
  keeps workflows/steps as `StrutWorkflow`/`StrutWorkflowVersion`/`StrutStep`/
  `StrutStepVersion` nodes (content-addressed versions; soft deletes;
  `USES_STEP`/`DEPENDS_ON` edges) through a dozen pattern-level statements
  written with the backend's dialect helpers, and passes the same
  conformance suite on both (`npm test` on a Ladybug file, `npm run
  test:graph` live on Neo4j). It is the default server's workspace
  (`src/graph/wiring.ts`; connection from `NEO4J_URI` / `NEO4J_HOST` /
  `NEO4J_USER` / `NEO4J_PASSWORD`, defaulting to localhost:7687 / neo4j /
  testtest like the mcp host — so Neo4j is a boot dependency);
  `STRUT_WORKSPACE_BACKEND=ladybug` puts it on one LadybugDB file instead
  (`<dataDir>/graph/graph.lbug`, `STRUT_GRAPH_DB`; `ladybugWorkspaceFromEnv`)
  — the desktop package's default — and a filesystem workspace found under
  the same `dataDir` is imported into the file at that boot
  (`src/graph/fs-import.ts`: every version under its label with its
  metadata, the files then moved to `fs-workspace.imported-<ts>/`, the run
  records left where they are; a failed import boots the fs workspace,
  loudly, and tries again next boot); `STRUT_WORKSPACE_BACKEND=fs` opts back
  into the file workspace. The backend behind the workspace (or
  `createStrut({ graph })`) is `ctx.services.graph`, what the `graph/*`
  steps read and write through. Runs/chats stay in
  their stores; `src/graph/projector.ts` (or the `graph/project` step)
  projects them into `StrutRun`/`StrutAgentSession`/`StrutToolCall`/
  `StrutChat`/`StrutTurn` with `EXECUTED`/`IN_RUN`/`IN_SESSION`/`SPAWNED`/
  `IN_CHAT` edges — summaries + `log_ref` pointers, never payloads, but
  for a CONVERSATION TURN's words, kept whole (`TEXT_MAX_CHARS`, 50k; past
  it the start and the end) and first in the node's search text, so
  keyword search reads what was said and the embedding its first 256
  tokens: a `StrutTurn`'s `user_text` / `assistant_text` (every text of
  the turn's steps, never its thinking), and on a `StrutAgentSession` with
  a `session_id` its `message` (the agent step's `message` config — the
  person's words when the prompt wraps them in more, which the
  orchestrator, job and builder seeds set to `{{ input.prompt }}` — else
  the prompt) and `reply` (a structured reply's `text`, else the result);
  a one-shot agent keeps previews, and no node keeps tool traffic, a
  system prompt or an attachment. Search hits carry the preview
  (`description_key`); `graph/graph-get` reads the whole text;
  idempotent upserts; on a Ladybug file the projector writes `StrutRun`,
  `StrutJob`, `StrutArtifact` and `StrutProposal` with `EXECUTED` / `IN_JOB` /
  `HAS_ARTIFACT` / `DELIVERED` / `IN_RUN` / `ACCESSED` and skips the rest, and its statements are the dialect's. **Every top-level run is projected when it ends**
  (`createStrut`, from the `services.onRunEnd` hook the verify pass rides;
  claims on or off; detached, so a graph that is slow or down never holds
  a teardown) — check runs (`origin: "verify"`) and `run_step` runs
  excepted; a kept step run still reaches the graph only with evidence.
  The verify pass does not project it again: `runRef` joins the projection
  in flight (`projectRunOnce` is single-flighted per run), else takes the
  settled node the graph holds. A `StrutRun` carries, beside its status
  and times, who launched it and from where (`origin`, `automation_id`,
  `actor`, `principal`, `parent_run_id`, `app` + `app_version`), what its
  model calls spent (`cost_usd`, `model_calls`, `input_tokens`,
  `output_tokens`, from `RunSummary.totals`, else summed from the log) and,
  when it failed, `failed_step` (the run overview's rule). Then the
  workflow's RUN COUNTS are
  recounted onto its `StrutWorkflow` (`refreshWorkflowUsage`, one at a time
  per workflow): `usage_count`, `usage_count_30d`, `success_count`,
  `error_count`, `last_run_at`, `last_run_status`, over the live `StrutRun`s
  that `EXECUTED` one of its live versions — never incremented, so a
  re-projection changes nothing and `graph/project` backfills them; the 30-day
  count is as of the workflow's last projected run; a workflow delete clears
  them. **So is every builder chat, when one of
  its turns ends** (`projectChatOnce`, from `launchChatTurn`'s `finally`,
  and again when a detached run it launched settles; one at a time per
  chat, a call during a projection queuing one more): its `StrutChat`, a
  `StrutTurn` per user message, `SPAWNED` to each run it launched — the
  run's projection in flight is waited for. Neo4j only (a Ladybug file
  holds no chat types), and no `ACCESSED`: a chat's tool calls are not
  nodes. **An assistant conversation is the same `StrutChat`** (`kind:
  assistant`; a builder chat's is `builder`): a run that is a turn of one
  (the conversation index's record, `src/conversations.ts`) upserts it from
  the record — title, last status, turn count, who first spoke — and its
  agent session is `IN_CHAT` it, so a conversation is one node whichever
  way strut held it; its turns are the `StrutAgentSession`s, their words
  whole. Neo4j only, for the same reason. Runs cut off before their end, and chats older than this, are
  the `graph/project` step's. **Provenance convention:** a graph-touching step
  marks its output with `withAccessedNodes(output, [{ ref_id, node_type? }])`
  (`core.ts`; a non-enumerable marker — invisible to the model, `{{ }}`
  expressions, and JSON). `wrapToolsWithEmit` lifts it onto the tool call's
  `step.end` event as `nodes`, untruncated — the runner does the same for a
  graph step the workflow itself ran, and a step that launched another run
  reports that run's nodes as its own (`meta/run-workflow` from the child's
  log, `strut/run-workflow` from the peer's tail, peer-tagged;
  `foldAccessedNodes`) — and the projector writes one
  `ACCESSED` edge per ref the graph holds (`StrutToolCall → any node`; a
  workflow step's `nodes` are in the log only). Every
  `graph/*` (and mcp `jarvis/*`) node-touching step does this; a step that
  reports nothing gets no edges — never inferred from prose. **What is
  reported is what the caller NAMED** — fetched by ref or key, expanded,
  created, edited, moved — with its `node_type` and `name` (`describeNodes`
  in `graph/_shared.ts` reads them for a write that only had the ref).
  Never what came back as a list: `graph-search` reports nothing,
  `graph-neighbors` the expanded node only, `graph-edges` nothing (the
  edges among nodes the caller already holds), `graph-get` never its
  `children`, a `walk` hop the node it expanded and what it kept. The run
  flyout lists them per step (`kit/src/folds/accessed-nodes.ts` folds an agent's
  tool calls; filtered to `Concept` by default) and opens one in place
  through `GET /graph/nodes/:ref_id`. The same
  marker mechanism carries an agent step's transcript: `withMessages(output,
  session)` → `step.end.messages` (lifted by the runner for steps and by
  `wrapToolsWithEmit` for tool calls; `messagesOf` reads it).
  `server.ts` is a thin wrapper (`getApp`/`startServer`) over
  `createStrut()` — graph workspace by default, file stores for the rest.

- **Run callbacks — a host hears the result without tailing**
  (`src/callback.ts`; createStrut's `postRunCallback`). `POST
  /workflows/:name/run { …, callback: { url } }` (and the `/:version/run`
  twin) validates the URL — http(s), else 400 and nothing launches — and
  the 202 carries `callback: true`, the host's proof this server honors
  it. When the run settles strut POSTs, once, `{ event: "run.end",
  workflow, runId, status: "success" | "error" | "cancelled", output?,
  error?: { message }, transcripts?: [{ step, stepType, url }], durationMs }`
  — each agent session as a LINK (`GET …/runs/:runId/transcripts/<step
  path>` serves its bare `messages` array), never inline — detached from the run's teardown,
  with the chat callback's delivery rules (a few retries; a 4xx is the
  host refusing it). The URL is the host's credential: `run.start` and
  `run.resumed` record `callback: { origin }` only, so no read endpoint
  (events, stream, summary) can leak it; the URL itself is kept by the run
  store beside the log (`RunStore.setRunCallback` / `getRunCallback` —
  `callback.json` on files — served by nothing), so a durable resume, by
  hand or boot-time auto-resume (§5.3), posts `run.end` the way the launch
  would have (before 2026-10-01 a restart dropped it, and hive learned of a
  resumed run only through its reconcile cron, up to 10 minutes later),
  and a run whose log ended but whose summary the dead process never
  wrote posts it when boot writes the summary. A restart still drops a
  post in flight; the host's fallback is `GET
  /workflows/:name/runs/:runId`. The web UI never sends one.
  **Rooms** (`src/rooms.ts`, plans/chained-orchestrators.md §3): for a host
  that cannot be called (a laptop behind NAT), `callback` and `jobCallback`
  take `{ room: true }` — the launching actor's room, a WebSocket the
  client holds open on `GET /rooms` — kept as `room:<actor>` wherever a URL
  is kept, so the store, a resume and the jobs' inheritance carry it
  unchanged; `run.start` records `callback: { room: true }`. Only a
  request whose actor strut can vouch for asks for or joins one (`full`
  with an actor, or `peer:person`); the shared peer key's actor is a
  header any strut sets. Not durable: a room with no socket open queues
  the newest 1 000 in memory. `strut/run-workflow { room: true }` asks a
  peer for one (`specs/CALLBACKS.md` §8).

- **The caller's MCP servers — a host's way back into itself**
  (`src/mcp-servers.ts`). The pull-direction twin of `callback`: `POST
  …/run { mcp: [{ name, url, token?, headers?, toolFilter? }] }` (Hive's
  `McpServerConfig`, field for field; HTTP only — a caller names a URL,
  never a process for strut to start) hands this run's agents the caller's
  tools — Hive its org's MCP, any other caller its own. Kept exactly as the
  callback is: validated before anything launches (400), the 202 carries
  `mcp: true`, `run.start` / `run.resumed` record `mcp: [{ name, origin }]`
  only, and the entries — credentials included — are kept by the run store
  beside the log (`RunStore.setRunMcp` / `getRunMcp`, `mcp.json` on files,
  owner-only), served by nothing, so a durable resume reconnects. Every step
  sees them as `ctx.mcp` (beside `ctx.job`); the `agent` step's `mcp`
  (default `true`) turns them into tools, and `job/start` / `job/continue`
  / `meta/run-workflow` hand them on to the runs they launch, so a job
  started from a Hive turn reaches the same Hive. `strut/run-workflow`
  never forwards them: they are this caller's, for this strut. An agent
  with `mcp: false` keeps to its own tools and hands its tools a `ctx`
  without them — its sub-agents and the jobs it starts get none. A token
  that expires mid-run (Hive's are 4 h JWTs) makes the call an `Error:`
  text; the host mints for the run's length.

- **Peers — calling a workflow on another strut** (`plans/federation.md`
  §2.2, §3; `src/peers.ts`, `src/steps/lib/strut/run-workflow.ts`). A strut
  knows nothing about other struts; a host may tell it its OWN workspace (`self`: `PUT /self`, `STRUT_SELF`, `createStrut({ self })` — `{ id?, label?, description?, repos? }`, kept apart from the peers). A **peer** is a
  record someone put here — `PUT /peers/:id { baseUrl, token, label?, description?, repos? }`
  (hive pushes one per workspace swarm, id = the workspace slug, what a
  person types as `@slug`) or `STRUT_PEERS` / `createStrut({ peers })` on a
  strut nobody can push to — kept in a fourth encrypted file, `peers.json`.
  `GET /peers` lists ids, labels and base URLs; a token has no read route. `GET`/`PUT`/`DELETE /self` is this strut's own record, never in `/peers`.
  Steps get `ctx.services.peers`: name a peer, make a request, the token
  injected inside; the builder gets `list_peers` and `peer` on
  `list_workflows` / `get_workflow` / `run_workflow`. **`strut/run-workflow`**
  launches `POST {peer}/workflows/:name/run` with this run's principal as
  `x-strut-actor` — so the peer bills that person from its own delegation
  and binds `secrets` to them; nothing crosses — and waits on the peer's
  SSE tail, reattaching with `?skip=N` after a dropped connection. The tail
  is reader-initiated by design: a desktop strut behind NAT can call a cloud
  one, while a callback would need a route back. Cancelling the caller's
  run POSTs cancel to the peer; `wait: false` returns the handle;
  `job` is explicit and never this run's own (no shared directory across
  struts — the peer's job is a different job of the same name, kept there
  as `peer/<job>`). The peer runs only a workflow whose YAML says `peer:
  true`, as published (no `params`). The output
  is the peer's result; each entry of its `artifacts` comes back tagged `{
  peer, job }` (the job as the peer holds it) and is never resolved here —
  `run.end` carries it as it came, the Jobs view badges it and opens it
  through the read-through below, the host resolves it against the peer
  (`specs/CALLBACKS.md` §4). A refused
  launch fails the step with the peer's message (not open to peers,
  `job_busy:`); an id not on
  file is `peer_unknown:`; a peer that stays unreachable is
  `peer_unreachable:`. The token to give a peer record is the peer's
  `STRUT_PEER_KEY` (see "Auth": read, launch, control what it launched),
  never its deployment key. **Read-through, the files slice**
  (plans/chained-orchestrators.md §5): `GET /peers/:id/jobs/:job/files[/…]`
  and `/peers/:id/artifacts/:runId[/…]` fetch that peer's job files and run
  artifacts with this strut's token for it — and `peers/<id>/` before
  either goes one more hop, each with its own token — so an entry tagged
  `{ peer, via, job }` opens from a strut with no record for `via`. And a
  peer's APPS (plans/apps.md §7.4): `GET /peers/:id/apps` and
  `/peers/:id/apps/:name/:version/files[/…]` (the document's `ETag` and a
  host's `If-None-Match` pass through), plus `POST /peers/:id/mcp`, which
  relays an app page's tools/call — with a person token on file, the peer
  answers with `step_run` alone, as that person — so strut's UI hosts a
  peer's app as `?app=@<peer>/<name>`. The UI's viewer reads a peer's file
  with its own credential and shows the bytes (no file token here opens
  the read-through), and `?artifact=/peers/<id>/jobs/<job>/files/<file>&solo=1`
  shows one alone — what Peel opens for an org's deliverable (specs/API.md
  §14.3, "One file alone"). Those paths only; served under this
  strut's artifact headers (no scripts: the peer's file is untrusted
  content on this origin; a host frames a document's text); `?key=` never
  forwarded. Not yet: the rest of read-through (a peer's runs and
  workflows), a Peers dialog.

## Files

What each file and folder in this area is, in the order of the tree.

### `specs/`

design specs — read SPEC.md first; EVAL_, EVOLVE_, RUN_CONTROL_ companions; API.md is the client how-to for the HTTP API (every endpoint, response shapes, a worked run); CALLBACKS.md the one for `POST …/run { callback }`; DESKTOP.md the desktop app's how-to for the chain to a person's orgs (pairing records, rooms, the wake turn, deliverables through the read-through); WALLET.md the wallet contract an app's page and its host speak (NWC over the MCP Apps bridge, plans/app-payments.md), normative in `@strut/kit/wallet`; LIGHTNING.md what the SERVER's wallet must answer (plans/paid-runs.md §9): the Sphinx daemon routes `src/payments/sphinx-daemon.ts` calls (most not in the daemon yet: the sphinx side builds to it), the NIP-47 calls of the NWC provider, the error codes, the exchange rate

### `src/createStrut.ts`

createStrut() factory: Hono HTTP API + detached run launch + SSE run reattach (tail) + detached /chat (launch+reattach) + static serving; injectable registry/store/chatStore/services

### `src/server.ts`

thin wrapper over createStrut() (getApp/startServer) — the default server, on the backend `STRUT_WORKSPACE_BACKEND` names (graph/wiring.ts): Neo4j by default, `ladybug` one LadybugDB file + the fs import (a failed import boots the fs workspace, loudly), `fs` the file stores. Boots itself ONLY when it is the process entry (argv[1]'s realpath == its own file: `tsx src/server.ts`, `node build/server.js`, a symlink to either) — a host whose own entry is called `server.js` and imports the barrel never starts it (server.test.ts spawns that host)

### `src/mcp-servers.ts`

the CALLER's MCP servers (`POST …/run { mcp }`): parseMcpServers (the launch field, Hive's `McpServerConfig` shape: name, url, token?, headers?, toolFilter?; HTTP only), mcpOrigins (what `run.start` records), connectMcpTools (the agent step's client: the SDK's Streamable HTTP client, lazy, one per server for the step; `<server>_<tool>` in name order, a server that fails skipped with a warning, a failed call an `Error:` text, results capped, images as `withMedia`)

### `src/mcp-registry.ts`

MCP servers REGISTERED once (`/mcp-servers` routes, `<dataDir>/mcp-servers.json`, `ctx.services.mcpRegistry`): values by secret NAME (`tokenSecret`, `headerSecrets`), resolved through the run's secrets — the actor's first; an agent's `agentTools: [mcp/<server>/<tool>]` (globs) connects them; a tool not marked `readOnlyHint` nor `ungated`, or named in `approve:`, records a proposal whose apply (`mcpStepDef`, decide's `stepFor`) calls it once. A per-launch `mcp` is untouched (specs/API.md §11.3)

### `src/callback.ts`

host callbacks, shared by `POST …/run { callback }` and `POST /chat { callback }`: parseCallback (http(s) only), callbackOrigin (the loggable part), postCallback (one JSON POST, a few retries, never throws, never awaited by the work it reports on); a run's callbacks may name a ROOM instead (`{ room: true }` → `room:<actor>` kept where a URL is kept, `parseLaunchCallback` / `roomTarget` / `roomActorOf`; `postCallback` hands it to its `room` deliverer)

### `src/rooms.ts`

ROOMS (plans/chained-orchestrators.md §3): the callback contract over a socket the CLIENT holds open — a room per ACTOR, every open socket gets each `run.end` / `job.update`, none open → a bounded in-memory queue (1 000) flushed in order on the next join, a 30 s ping; `roomsFor(dataDir)` (one registry per data directory: the job callbacks' deliverer finds it from the job's root). createStrut's `GET /rooms` + `strut.upgrade(req, socket, head, { basePath })` run the upgrade through the app's own gate and hooks (`env.incoming` = the Node request, as on HTTP), so a standalone strut (`listen()` hooks it) and a host that owns the server (mcp routes `/lab/rooms`) decide the room the same way; only a `full` or `peer:person` request with an actor joins

### `src/drain.ts`

the DRAIN (`GET`/`PUT`/`DELETE /drain`, specs/API.md §8.1): what an updater or a backup turns on before restarting the process — every new ROOT run is refused with a `draining:` error (createStrut's `trackRun`, where every launch path registers, throws `DrainingError` for a run with no live parent; the HTTP launch routes, `POST /chat` and elicitation answers answer 503 + `Retry-After` first; a step run over HTTP that declares `effect: "read"` still answers), a schedule's fire is held, a wake turn stays queued on disk (launched when the drain lifts or at boot), and what is running finishes — a run a run in flight launches still starts. `idle` = no run executing (a paused one is not waited on) and no builder chat turn running and no public tool call in flight (src/public-tools.ts). In memory: a restart starts undrained; `minutes` lifts it by itself

### `src/events-sink.ts`

the EVENTS SINK (`STRUT_EVENTS_SINK`, `createStrut({ eventsSink: { url } })`): every run's events, whoever launched it, batched and POSTed to ONE URL the deployment names as `{ event: "run.events", events }` — telemetry for a server that draws what strut is doing. The ENVELOPE only (`slimRunEvent`, an allowlist: `SINK_FIELDS` + `error.message` + the run's `workflow`): type, when, which run and step, how long, what it spent, which version — never `input`, `output`, `messages`, `params`, `nodes` or a stack; a listener that needs more reads the run by id with the key. Hung on the services bag as `onRunEvent`, the twin of `onRunEnd` the runner calls at every emit (after a host's own). Batched (~1 s or 100), one POST in flight so batches land in order, retried briefly then DROPPED, the oldest dropped when the queue passes 10k — the log is the record; nothing in a run waits on it. A URL that is not http(s) fails the boot

### `src/peers.ts`

PEERS (plans/federation.md §2.2, §3): the other struts this one may call — `{ id, baseUrl, token, label? }` in a fourth encrypted file, peers.json (`P_<hex(id)>`), behind PUT/DELETE/GET /peers (GET: ids, labels, base URLs — never a token) + `STRUT_PEERS` / `createStrut({ peers })`, the paste door for a strut nobody pushes to. `ctx.services.peers` names a peer and makes a request with its token injected (readable by nothing; what a step can do through it is the token's scope on the peer). The client the step and the builder's `peer` tools share: launchOnPeer (POST …/run, `x-strut-actor: ctx.principal`), tailPeerRun (the peer's SSE tail, reattached with `?skip=N` after a drop — reader-initiated, so a strut behind NAT can call a cloud one), cancelOnPeer, runOnPeer, listPeerWorkflows / readPeerWorkflow

### `src/steps/lib/strut/`

strut/list-peers: `self` (this workspace, when set) and the peers on file as an agent chooses one — { self?, peers: [{ id, label?, description?, repos? }] } (what the host said each workspace holds), never a token or URL. strut/run-workflow: dispatch-through (plans/federation.md §2.2) — run a workflow on a PEER and return { peer, workflow, runId, status, output?, error?, durationMs }; waits on the peer's tail, cancel of this run cancels the peer's, `wait: false` returns the handle, `job` is explicit (never this run's own: no shared directory across struts); grantable to an agent as `agentTools: ["strut/*"]`. Three things ride on the tail it reads anyway: the peer run's `step.end.nodes` are folded onto THIS step's `step.end`, each tagged `peer: <id>` (a ref is only meaningful against the graph that recorded it — the projector skips a tagged ref, the flyout badges it, nothing here opens it); each entry of the peer output's `artifacts` comes back tagged `peer` + `job` — the job the peer's `run.start` recorded (`peer/<job>` on its peer key), so a `path` stays the peer's and artifact-refs.ts leaves it alone (an entry already tagged — the peer got it from a third strut — is re-tagged as the NEXT HOP, `{ peer: <this peer>, via: <the third>, job: <the third's> }`, opened through the peer's read-through, plans/chained-orchestrators.md §5; in the plain output, so the builder's pack carries it); and the handle is journaled at launch as a synthetic `step.end` at `<path>#launch` (no stepType) so a resumed caller REATTACHES to the same peer run instead of launching a second one — the child did not die with the caller. A peer run that died there and was not resumed is `peer_run_stale:` (its tail ends with `done { status: "stale" }`, retried with backoff first)
