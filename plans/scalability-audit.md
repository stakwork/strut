# System Scalability & Reliability Audit

Audited at commit `91a87ada` (main, 2026-11-05). Every line reference below was read in that checkout. "Proven" means the behaviour follows directly from the cited code; "theoretical" means it needs a load or race that was not reproduced here. One finding is grounded in a recorded incident: `src/output-cap.ts:4-12` describes swarm38 (2026-10-30) — 100–245 MB run logs, GC storms, then a crash loop through boot-time auto-resume — which is the pattern several findings below generalise.

Scope: `src/` (engine, HTTP, stores, graph layer, steps), `web/src` polling, `docker-compose.yml`, `server.ts`. Read-only; nothing was changed or benchmarked.

---

## 1. Executive summary

Strut is a single Node process that runs workflows in-process, persists each run as an append-only JSONL log, and keeps everything that says "what is running" in process memory. That shape is deliberate (`src/jobs.ts:37-38`, `AGENTS.md` `STRUT_SCHEDULER` row, `plans/automations.md:52`) and fits the deployment it targets: one container on one volume. The per-unit bounds are good — 8 MB step output cap, 64 MB resume cap, bounded event sink, foreach pool, agent `maxSteps`, torn-log repair, cooperative cancel at every boundary. What is missing is almost entirely at the process level. The six systemic risks, in order:

1. **No admission control anywhere.** `POST /workflows/:name/run`, automations, wake, jobs, peers, chat and nested `meta/run-workflow` all end in `launchDetached` → `void runWorkflow(...)` with no count, queue or refusal (`src/createStrut.ts:4997-5120`). No HTTP body limit except voice. No SSE connection cap. No per-provider LLM concurrency limit. One burst of launches is one burst of LLM streams, subprocesses and open files, bounded only by the heap.
2. **Run logs amplify and are read whole, and nothing is ever deleted.** Container steps re-emit their children's outputs, so a foreach's data is written ≈4× (`src/runner.ts:858-865, 1217-1225, 1234`); every control request, in-flight read, transcript fetch and new SSE subscriber reads and parses the entire log (`src/store.ts:684-699, 83-121`); no retention exists for runs, chats, sessions or artifacts. This is the swarm38 incident mechanism.
3. **Boot auto-resume is a recovery storm.** Every eligible stale run is read in full and relaunched inside one loop with no concurrency cap or pacing (`src/createStrut.ts:2208-2247`). The only guards are per-run (age, 5 resumes, 64 MB). A crash with N live runs becomes N simultaneous relaunches, each holding its journal in memory.
4. **Metadata read-modify-write is unlocked and non-atomic.** All 14 `_metadata.json` writers in `src/workspace.ts` are plain `readFile` → mutate → `writeFile` (`src/workspace.ts:962-971`). Two concurrent publishes, releases or automation edits lose one; a crash mid-write turns the workflow into a 404. Chat `meta.json` has the same pattern. `jobs.ts` already does tmp+rename under a lock for exactly this reason.
5. **External calls run on library defaults.** No `maxRetries`, deadline or per-provider limiter reaches the AI SDK (`src/steps/core/llm.ts:70-75`, `src/steps/core/agent.ts:1904-1913`); the `http` step and capability have no default timeout; the Neo4j driver is constructed with only `disableLosslessIntegers` (`src/graph/bolt.ts:102-104`); peer fetches pass no signal. Step retry × SDK retry × stream continuations can reach 72 provider requests from one step.
6. **Horizontal scale is not a configuration away.** Two processes on one `dataDir` — a second replica, or a rolling deploy that overlaps — both resume the same live runs at boot (`src/createStrut.ts:2160-2161, 2211`), both fire every automation, and neither can cancel the other's runs. There is no lease, lock file or leader anywhere in `src/` (zero hits for `lease|flock|O_EXCL|leader`).

Risks 1–4 bite a single instance under load. Risk 6 is by design today and only matters when a second process appears, but nothing refuses that second process.

---

## 1b. Deployment context: the gateway and the swarm

In production strut does not run as the standalone container `docker-compose.yml` describes. It runs embedded in stakgraph's mcp process (`stakgraph/mcp/src/lab/createLabStrut.ts`, mounted at `/lab` by `mount.ts:275`), one per org swarm (`sphinx-swarm/src/images/repo2graph.rs`), with its LLM calls routed through the stakgraph gateway (Bifrost plus the governance plugin) under the Mothership (`STRUT_MOTHERSHIP_REQUIRED`, set by `repo2graph.rs:210`). Checked at stakgraph `1cca9b8b` and sphinx-swarm `dd0f132d`. What each layer takes on, and what it does not:

| Finding | Gateway | Swarm topology | Net |
|---|---|---|---|
| 1.2 run cost cap metadata-only | **Solved.** The Mothership attenuates a macaroon per run with `max_cost_usd`; the gateway's Redis accumulator (`gateway/internal/auth/accumulator.go`) enforces it per run, per delegation and per agent, surviving strut restarts. `max_steps` is deliberately `0`, so no call-count cap (`plans/mothership-cost-control.md`). | — | Closed where the Mothership is on; open on a plain deployment |
| 5.1 no LLM rate limit, retry stacking | **Not yet.** `gateway/internal/ratelimit/doc.go` is a stub ("Until the first feature lands this package exports nothing"); the only rate limit is on the admin login handler. Bifrost's own provider retry/fallback settings are in `data/config.json` (not read here: it carries credentials); if Bifrost retries upstream, stacking gains a multiplier. No client-side deadline either way. | — | Open |
| 5.2 Neo4j defaults, health | — | Neo4j is a sibling container on the swarm; same defaults apply. | Open |
| 6.1–6.4 multi-instance coordination | — | **Moot per org.** One strut per org swarm shards by tenancy, so no two replicas share a `dataDir`. Remains reachable only if a lab restart overlaps itself on one volume. | Closed by topology, not by code |
| 1.3 no body limit | — | **Worse.** The lab mounts strut before `express.json({ limit: "50mb" })` so strut reads the raw stream (`mount.ts:173`); mcp's limit does not cover strut routes. | Open |
| 1.8 fairness, 1.6 blocking | — | **Worse.** Strut shares mcp's event loop, so a blocking parse or embedding pass stalls the graph API too. Recorded: `/lab/health` 0.34 s → 1.74 s during an embedding tick, swarm38 2026-10-11 (`AGENTS.md:211`). | Open, wider blast radius |
| 7.1 auto-resume storm, 4.1 retention, 2.1 amplification, 3.1 metadata | — | **Unchanged, and the incidents happened here.** `repo2graph.rs:236` passes `mem_limit: None` and `secondbrain.rs` leaves `global_mem_limit: None`, so the lab container has no memory cap; with `restart: unless-stopped` a heap blowup becomes the restart loop. Every dated incident in the code (GC storms and the 139 MB log replayed each boot, a step closing the shared graph connection, the Cypher 5.19 write failures) is tagged swarm38. | Open |
| org gateway as a dependency | **New risk.** One Bifrost per org is "a single point of failure for the org's LLM traffic" (`plans/org-gateway.md` §8); throughput is explicitly unmeasured. | — | New |

Net: the gateway retires finding 1.2 and will retire part of 5.1 when its rate limiter lands. The swarm answers §2.6 by making it moot per org. Risks 1–4 of the executive summary are unchanged, and two of them have a wider blast radius in production because strut shares mcp's process and the container has no memory limit. Two deployment-level quick wins follow: set a `mem_limit` for the repo2graph container (`host_config` already accepts one), and apply a body limit inside strut (1.3) since mcp's cannot reach it.

---

## 2. Findings by dimension

Severity: **Critical / High / Medium / Low**. Each finding: evidence, failure scenario, quantification, recommendation.

### 2.1 Concurrency, scheduling & backpressure

**1.1 No cap on concurrent runs, from any launch path — High, proven.**
- `src/createStrut.ts:5957-6010` (`POST /workflows/:name/run`): parse → `launchDetached(flow, body, …)` → 202. `launchDetached` (`:4997-5120`) calls `trackRun` then `void (async () => … runWorkflow(…))()`. No check of `controllers.size`, no per-workflow count, no queue.
- Same sink: `run/launch` (`:5684`), scheduler (`src/scheduler.ts:251`), wake (`src/wake.ts:420`), `job/start` (`src/steps/lib/job/_shared.ts`), durable resume (`:2032-2060`), peers (same POST route), chat `run_workflow` after `chatRunWaitMs` (`:329-334`). Nested `meta/run-workflow` runs inline with no depth counter (`src/authoring.ts:819-846`).
- Scenario: 500 `POST /run` in one second, or 500 automations sharing a cron minute → 500 `runWorkflow` instances start at once, each opening LLM streams, subprocesses, browser pages. Memory and file descriptors are O(launches).
- Recommendation: a semaphore in `launchDetached` keyed globally (`STRUT_MAX_RUNS`) and per `flow.name`, returning 429/503 with `Retry-After` from the route and `skipped: at capacity` from `fireOne`. `controllers.size` is already the authoritative in-flight count; the check is a few lines.

**1.2 Run cost cap is enforced only by the opt-in Mothership — Medium, proven.**
- `PUT /workflows/:name/run-cap` stores `maxRunCostUsd` (`src/createStrut.ts:2668-2683`, comment: "Metadata-only like the category; only the Mothership module enforces it"). `grep maxRunCostUsd src` hits only `workspace.ts` setters, `fs-import.ts`, and `src/mothership.ts:186-288`. `runner.ts` never reads it, though it tallies `totals.cost` on every event (`src/runner.ts:357-359`).
- Scenario: operator sets `$5`; without Mothership an agent loop spends `$200`.
- Recommendation: pass the cap through `RunOptions`, compare `totals.cost` in `emit` after `tallyUsage`, and `controller.cancel()` — the cooperative checkpoints already stop the run at the next boundary.

**1.3 No HTTP body limit except voice — High, proven.**
- `grep bodyLimit src` → only `src/voice.ts:45`. `createStrut.ts` has 46 `c.req.json()` sites; the middleware chain (`:1490-1560`) is logger, compress, auth. `serve()` at `:7447` sets no `maxRequestBodySize`.
- Scenario: a 2 GB JSON `input` (or inline `attachments`) → buffered as a string, synchronous `JSON.parse`, heap exhaustion. The event loop is blocked for every run in the process while it parses.
- Recommendation: `app.use("*", bodyLimit({ maxSize: 16 MiB }))` after auth, with explicit larger limits on upload routes.

**1.4 Unbounded fan-out shapes — Medium, proven.**
- DAG width: `src/runner.ts:739` `Promise.allSettled(steps.map(runStep))` starts every dep-less step at once.
- Subflow recursion: `executeSubflow` (`src/runner.ts:1300-1352`) has no depth counter or cycle check. A → B → A recurses until a step errors or the stack goes; every level appends to the same log.
- `foreach`: sequential by default, bounded pool with `concurrency` (`:1257`), but `items.length` is uncapped unless the author sets `maxIterations` (`:1155-1162`); `results` holds every output (`:1178`).
- Recommendation: `frameDepth` on `Exec`, refuse > 16 in `executeSubflow`, detect a name already on the frame stack.

**1.5 Head-of-line in the emit chain — Low/Medium, proven, mostly benign.**
- `src/runner.ts:348-366`: every event does `await store.append` → `await onRunEvent` → `await onEvent`. `FileRunStore.append` (`src/store.ts:557-564`) is `mkdir` + `appendFile` per event — two syscall round trips, the `mkdir` redundant after the first.
- Done well: SSE is not in this chain (`tailEvents` reads the file independently with wake-ups), and the events sink's `push` is synchronous. A host-supplied `services.onRunEvent` that awaits network would be in the hot path for every event of every run.
- Recommendation: cache the `mkdir` per run; document `onRunEvent` must not block, or wrap it in a timeout.

**1.6 Event-loop-blocking work on request paths — Medium, proven.**
- `getRunEvents` (`src/store.ts:684-699`) is `readFile` + `split` + `JSON.parse` per line, synchronously after the read. Callers on request paths: `findRun` (`src/createStrut.ts:2255`, every cancel/pause/resume), in-flight run read (`:1766`), `/events` (`:1787`), transcript fetch (`:1823`), `ownRun` (`:5593`), job launch reading the root run's `run.start` (`:5312-5343`), `/versions` (`:2521-2528`).
- Agent text-editor `view` tool: `readFileSync(target).split("\n")` (`src/steps/core/agent.ts:356,380,395`) with no byte cap — a model viewing a 500 MB file blocks the loop for every run.
- Quantification: a 64 MB log (the resume cap) is roughly 100–300 ms of parse per read; `findRun` pays it on every control request.
- Recommendation: `findRun` only needs the last line — read the last 64 KB (the backward block scan in `repairLog`, `src/store.ts:655-668`, is the pattern); write a `start.json` sidecar at launch so `readRunStart`/`conversationOf`/scheduler never touch the log; byte-cap the `view` tool.

**1.7 Scheduler tick is sequential and O(automations × 100 reads) — Low, proven.**
- `src/scheduler.ts:266-290`: `for … await fireOne`; each `fireOne` → `runFacts` → `listRuns` + up to `SCAN_LIMIT=100` `getRunSummary` reads. A slow tick delays the next (the `ticking` flag skips overlapping ticks). Done well: advance-then-fire (`:275`), `firing` set, memory-only `nextRunAt` so restarts never stampede.

**1.8 Fairness — Low, structural.** No scheduling between runs beyond cooperative checkpoints at step/iteration boundaries (`src/runner.ts:717, 1181`; `agent.ts:1882`). One CPU-heavy step (a large parse, a regex over megabytes) stalls every other run's SSE flush. Only remedy short of worker threads is capping concurrency (1.1).

### 2.2 Computational complexity & data amplification

**2.1 Container steps re-emit child outputs: write amplification ≈ (depth + 2)× — High, proven.**
- `src/runner.ts:858-865` emits `step.end { output }` for every step including containers, and `dispatchStep` (`:946-954`) returns the aggregate: `executeForeach` → `results` (all N outputs, `:1234`), `executeLoop` → `current`, `executeSubflow` → child's last output (`:1352`). Each iteration already emitted its own `step.end { output }` (`:1217-1225`). Then `run.end { output }` (`:494`) and `run.json` (`:495-507`) write the top-level output again. `step.start` for a foreach carries the whole resolved `items` array (`:833-834`), and each iteration's `step.start.input` is the fully resolved body config including `$current` (`:1200-1208`).
- Quantification: a foreach of N items × B bytes writes ≈ N·B (iteration ends) + N·B (foreach end) + N·B (`run.end` if last) + N·B (`run.json`) ≈ 4·N·B; a foreach → subflow → foreach adds N·B per container level. With the 8 MB per-unit cap, 100 items legitimately produce 800 MB of iteration output and a 1.6 GB+ log that `logTooBig` then refuses to resume.
- Recommendation: emit container `step.end` with a reference (`{ items: N, bytes }` or `outputRef`) and let `buildJournal`/`summarizeFromEvents` reconstruct from iteration events; keep the canonical value in `run.json` only.

**2.2 Agent transcripts written twice to three places — Medium, proven.**
- A sub-agent as a tool: its own `step.end` carries `messages` (lifted by `markersOf`, `src/runner.ts:186-189`), the parent's `tool:<name>` `step.end` carries the same `messages` again (`src/steps/core/agent.ts:1193, 1205`), and the turn is appended to `sessions/<id>/messages.jsonl` (`src/session-store.ts:305`).
- Recommendation: drop `messages` from the `tool:*` event and point at the child path's transcript URL (`transcriptUrl`, `src/createStrut.ts:1785`, already exists).

**2.3 `GET /workflows/:name/versions` is O(runs) sequential summary reads plus O(old runs) full-log reads — Medium, proven.**
- `src/createStrut.ts:2521-2528`: for every run id, `await store.getRunSummary` (sequential), and for any summary without `workflowHash`, `getRunEvents` of the whole log. 5,000 runs = 5,000 sequential file reads per Versions-tab view.
- Recommendation: paginate, or keep per-version counts in `_metadata.json` updated at `finalize`.

**2.4 `GET /workflows` does a `readdir` + sort of every workflow's `runs/` per request — Low/Medium, proven.**
- `src/createStrut.ts:1626-1632` → `store.lastRunAt` → `listRuns` → `readdir` + `sort` (`src/store.ts:579-588`). W workflows × R runs: O(W · R log R) per sidebar refresh, after the recursive `workflowNames` walk and a `_metadata.json` read per workflow (`src/workspace.ts:733-737, 1702-1714`).
- Recommendation: run ids are millisecond timestamps — record `lastRunAt` in `_metadata.json` at launch, or cache per workflow and invalidate on `append`.

**2.5 Chat turns are O(history) each, O(n²) over a chat — Medium, proven.**
- `loadMessages` reads and parses the whole `messages.jsonl` per turn (`src/createStrut.ts:6806`, `src/chat-store.ts:446-456`); `/chat/:id` serves it whole (`:7119`). `session-store.appendTurn` reads the whole `messages.jsonl` to check for orphan lines on every commit (`src/session-store.ts:295-307`).
- Recommendation: keep a per-chat byte offset; detect orphans from `turns.jsonl`'s last offset plus a `stat`.

**2.6 Scope and journal hold every output for the run's life — Low/Medium, proven.**
- `scope[s.id] = output` (`src/runner.ts:726`) for the whole flow; `buildJournal` keeps every `step.end.output` (`src/journal.ts:14-20`), so a resumed run holds the log's outputs twice (journal + scope). Bounded by the 8 MB per-step and 64 MB resume caps.

**2.7 Subflow YAML re-parsed per execution — Low, proven.** `executeSubflow` → `workspace.getWorkflow` → metadata read + YAML read + `flowFromYaml` every call (`src/runner.ts:1326-1328`, `src/workspace.ts:763-768, 799-802`); inside a foreach that is per iteration. An LRU keyed by `(name, version, mtime)` removes it.

**2.8 Projector cost per run end — Low, proven.** `projectRunOnce` reads the full log (`src/graph/projector.ts:590`), makes 3–4 passes over events (`:279-390`), then 5–8 graph round trips. Detached, so teardown never waits — but at 50 run ends/s that is 50 full-log parses/s in the serving process.

### 2.3 Contention, locking & synchronisation

Inventory of what exists (all in-process): `withLock` promise-chain mutex (`src/jobs.ts:792-813`), `holdJob` one-run-per-job (`:576-597`), one-holder-per-session (`src/session-store.ts:413-425`), Ladybug `exclusive()` write queue (`src/graph/ladybug/db.ts:625-632`), Neo4j managed write tx (`src/graph/bolt.ts:137-141`), `projectRunOnce` single-flight (`src/graph/projector.ts:785-803`), embedding tick single-flight (`src/graph/embeddings.ts:458-469`), scheduler `ticking`/`firing`, secret-store `saving` chain (`src/secret-store.ts:198-199`), `RunController.beginUnit/endUnit`.

**3.1 Workspace and chat metadata read-modify-write is unlocked and non-atomic — High, proven.**
- `src/workspace.ts`: 14 `writeFile(... "_metadata.json")` sites, zero `withLock` and zero tmp+rename. `patchWorkflowMetadata` (`:962-971`), `setWorkflowAutomations` (`:974-984`), `setActiveVersion` (`:986-1003`), `writeAppMetadata` (`:1261-1265`, used by `addAppRelease` and `setAppLive`). `chat-store.setMeta` is the same pattern (`src/chat-store.ts:413-419`).
- Scenario: publish and set-active land together, or the scheduler UI and a chat tool edit automations together → last writer wins, one change lost. A crash mid-`writeFile` truncates the file; `getWorkflow` maps the load throw to 404 (`src/workspace.ts:60-61`), so the workflow disappears.
- Contrast: `src/jobs.ts:156-164` documents and does tmp+rename under `withLock`; `store.ts:573-575` renames `run.json` into place.
- Recommendation: one `writeJsonAtomic(path, value)` + `withLock(path)` helper, used by workspace metadata, chat meta, and `session-store.appendTurn`'s rewrite (`src/session-store.ts:304`).

**3.2 Concurrent `appendFile` to one `events.jsonl` can interleave events over 512 KiB — Medium/High, theoretical but structurally present.**
- `src/store.ts:557-564`: no serialisation around `appendFile`. Parallel DAG branches (`src/runner.ts:739`) and `foreach` workers (`:1257-1258`) all append to one file. Node's `fsPromises.appendFile` writes in 512 KiB chunks (`kWriteFileMaxChunkSize`), so only events under that size are a single `O_APPEND` write. Events above it are reachable: `exec` keeps up to 500k chars per stream (`src/steps/core/exec.ts:118`, `src/shell.ts:229`), and agent `step.end` carries whole transcripts (the code's own note: "can be megabytes", `src/createStrut.ts:1781`). The code already knows `appendFile` chunks (`src/store.ts:634-636`).
- Consequence: two glued lines that `parseJsonlLine` drops silently (`:30-37`) — those steps vanish from the record, the graph projection and the resume journal (they re-execute). `repairLog` only fixes a torn tail.
- Recommendation: serialise appends per run with a promise chain on `Exec` (the Ladybug `exclusive` pattern), or one `FileHandle` per live run with one `write()` per event.

**3.3 Ladybug: one unbounded, untimed write queue per process — Medium, proven serial bottleneck.**
- `src/graph/ladybug/db.ts:625-632`: every write of every run, the projector, embeddings and claims pass through one promise chain on one connection; no depth cap; `setQueryTimeout` is applied only to read connections (`:669`). A hung statement wedges all graph writes, and `close()` waits on the queue (`:713`), so shutdown hangs too. Nested `withWrite` deadlocks by construction (`:70-71`); current writers correctly accept an outer `tx` (`node-writer.ts:581`, `edge-writer.ts:212`).
- Recommendation: `setQueryTimeout` on the write connection; a queue-depth gauge in `/health`.

**3.4 `sweepJobs` runs inline on every `job/dir` and `git/checkout`, unguarded, with a stale read — Medium, proven.**
- `src/steps/lib/job/dir.ts:66`, `src/steps/lib/git/checkout.ts:161` → `sweepJobs` (`src/jobs.ts:643-691`): `readdir` + `readJobRecord` for every job, per call, no single-flight. `rec` is read at `:657` outside the lock and written at `:683` under it after awaited git work; a `hold()`/`recordRun()` in between is overwritten.
- Recommendation: single-flight it (the `inFlight` map pattern from `src/packages/index.ts:448-453`), run at most every N minutes, re-read the record inside the lock.

**3.5 Serial resources independent runs queue behind — Medium, proven.** One `WorkerEmbedder` worker per process (`src/model-worker.ts:76-77`): single-threaded inference that every embedding node write waits on. One Playwright browser with `BROWSER_SESSIONS_MAX` 4 kept pages (`src/browser/service.ts:379, 516`) — an explicit cap that errors rather than queues (good). The Ladybug queue (3.3).

**3.6 Deadlock review — Low, none found.** `checkpoint()` then `beginUnit()` with no interleaving await (`src/runner.ts:1003-1004`); `forUnit().checkpoint` releases the unit while parked (`src/run-control.ts:200-211`); `holdJob` throws rather than waits and ancestors pass via `isAncestorRun` (`src/jobs.ts:588`), so nested `meta/run-workflow` cannot wait on its parent's hold. `withLock` is not re-entrant: `withLock(k)` inside `withLock(k)` hangs forever. No current instance; worth an assertion.

**3.7 Neo4j MERGE contention — Low, mitigated.** Writes go through `executeWrite` with driver retry on transient/deadlock errors (`src/graph/bolt.ts:137-141`); `neo4j-engine.ts:174-176` documents that callbacks may run twice and they are side-effect free.

### 2.4 Resource management & boundedness

**4.1 No disk retention for runs, chats, sessions, artifacts, cassettes — High, proven.**
- The only sweep is `sweepJobs` (`STRUT_WORKDIR_TTL_DAYS`, default 7, `src/jobs.ts:603-608`), which removes job repositories only, and only when a `git/checkout` or `job/dir` step happens to run. No retention for run dirs (`deleteRuns` only on workflow delete, `src/store.ts:504`), artifacts (no `rm` in `capabilities.ts`), chats (`deleteChat` only), sessions, cassettes (`src/cassette.ts:210` write only). Auto-resume's 7-day `maxAgeMs` only skips resuming.
- What one busy agent run writes: `run.start` (input); per tool call a `step.start` (full input) + `step.end` (1.5 KB preview); `reply.delta` every 50 ms while streaming; the full transcript on `step.end` (megabytes); duplicated per 2.2; container re-emission per 2.1; `run.end` + `run.json` with output; `sessions/<id>/messages.jsonl`; artifacts. Observed in-repo: 100–245 MB logs (`src/output-cap.ts:8`).
- Recommendation: a boot + daily sweep over `workflows/*/runs/*` by `run.json.finishedAt` with `STRUT_RUN_RETENTION_DAYS`, the same for `chats/`, `sessions/`, `artifacts/`; at minimum gzip finished logs.

**4.2 Every new live-tail subscriber loads the whole backlog into memory — Medium, proven.**
- `src/store.ts:94-104`: each poll does `Buffer.alloc(size - offset)` and reads it in one call; on first connect (`offset = 0`) that is the entire log per SSE client, before `?skip=` is applied — `skip` suppresses yielding (`:120-121`), not reading or parsing. Memory ≈ clients × log size.
- Recommendation: accept a byte offset (`?from=<bytes>`, returned by `/events`), or seek to the `skip`-th newline from the tail.

**4.3 MCP clients leak on force-cancel — Medium, proven by code path.**
- `src/steps/core/agent.ts:2382-2385`: `closeMcp` only in the step body's `finally`. `raceForce` (`src/run-control.ts:145-157`) rejects the runner's await while the abandoned body keeps running; the body's `finally` runs only if the body returns. Sessions (`:1097-1100`) and leftover processes (`:1463`) register `onRunEnd` disposers; `closeMcp` does not. Same shape in `src/steps/lib/acp/prompt.ts:348-350`; `_client.ts:79-85` sends SIGTERM only, never SIGKILL.
- Recommendation: `ctx.onRunEnd?.(() => closeMcp?.())` beside the session release; SIGKILL fallback in `AcpClient.close`.

**4.4 Per-step 200 ms cancel-watch timers — Low, proven.** `exec.ts:201`, `agent.ts:1517`, `git/_shared.ts:109`, `strut/run-workflow.ts:170`, `acp/prompt.ts:265`: one interval per in-flight unit polling `control.state`, cleared in `finally`. `foreach concurrency: 50` of exec steps = 50 timers per run. The controller's `forceListeners` (`src/run-control.ts:161`) is the listener hook to replace polling.

**4.5 Chat events are appended per text-delta with no wake-up — Medium, proven.**
- `src/createStrut.ts:6507-6509`: `await emit(e)` for every stream part, `text-delta` mapped 1:1 (`:7680-7681`); `appendEvent` is `mkdir` + `appendFile` per event (`src/chat-store.ts:458-465`) and never calls `wakeTails`, so chat SSE runs purely on the 250 ms poll. A 2,000-token reply is 2,000 appends and 2,000 `mkdir` calls. The run log batches `reply.delta` at 50 ms (`src/steps/core/agent.ts:659`); the chat path should do the same.

**4.6 Lifetime Maps — done well, verified.** `controllers`/`controllersByRunId` untracked in `finally` (`src/createStrut.ts:5121, 7429`, `authoring.ts:881-883`); `launchKeys`/`scopedLaunches` swept of dead runs on each launch (`:5679, 5706`); `liveSessions` entries deleted when empty (`:5124-5126`); `turnAborts` and `reconciling` in `finally`; `tailWaiters` self-cleaning (`src/store.ts:166-179`); `jobFeeds` idle-evicted and capped at 1,000 (`src/jobs.ts:272-295`); `LiveFeed` capped by `max`; events sink 10,000 drop-oldest; scheduler `launched` pruned. Unbounded but config-keyed (acceptable): undici `Agent` per CA (`src/peers.ts:279`), rooms per dataDir.

**4.7 Subprocess output and timers — done well.** `OutputSink` head+tail within `maxOutputChars` (`src/shell.ts:187-215`); `capture()` SIGKILLs on overflow; 600 s default timeout with SIGKILL fallback; process groups killed via `onRunEnd`. All 12 `setInterval` sites are paired with clears and process-lifetime ones are `unref`'d. Tails open/stat/read/close per poll, so no long-lived handles.

### 2.5 Distributed systems & dependency resilience

**5.1 LLM calls: no timeout, no retry configuration, no concurrency limit — High, proven.**
- `generateText({ model, prompt, …, maxOutputTokens })` (`src/steps/core/llm.ts:70-75`); `new ToolLoopAgent({ model, instructions, tools, maxOutputTokens, stopWhen, ...callSettings, prepareStep, onStepEnd })` (`src/steps/core/agent.ts:1904-1913`) with `callSettings = { providerOptions?, reasoning }` (`:1424`). Repo-wide, `maxRetries` appears only as the runner's own step-retry variable (`src/runner.ts:797`). The only abort is run-control's signal (`src/llm.ts:343`); nothing bounds a hung provider connection. No per-provider semaphore exists.
- Retry stacking: step `retry.max` (fixed `delayMs`, no backoff or jitter, `src/runner.ts:797-808`) × SDK default retries (2) × `MAX_STREAM_ERROR_CONTINUATIONS` 5 (`src/steps/core/agent.ts:582`), each continuation replaying the whole conversation (`:576`). `retry: { max: 3 }` → up to 4 × 3 × 6 = 72 provider requests from one step; with `foreach.concurrency: 8` that is a 429 storm from one run.
- Recommendation: pass `maxRetries` and an `abortSignal` combining run-control with `AbortSignal.timeout(perCallMs)` into the SDK; a process-wide per-provider semaphore (8–16 in flight) in `resolveModel`/`llmAuth`; exponential + jittered step retry. Trade-off: a central limiter serialises unrelated runs; a per-run limiter is fairer but does not protect the shared key.

**5.2 Neo4j: driver defaults, unconditional health, synchronous graph awaits at teardown — Medium, proven.**
- Boot awaits `bolt.verify()` then `MiniLMEmbedder.load()` (`src/graph/backend.ts:315-317`); compose makes Neo4j a healthy-dependency and `restart: unless-stopped`, so a boot-time outage is a restart loop (acceptable). `/health` returns `{ ok: true }` without touching anything (`src/createStrut.ts:7304-7305`), so a live Neo4j outage is invisible to the container healthcheck.
- Driver: `neo4j.driver(uri, auth, { disableLosslessIntegers: true })` (`src/graph/bolt.ts:102-104`) — default pool 100, 60 s acquisition timeout, default tx retry time.
- Teardown awaits `graphReports?.flush()` (`src/runner.ts:555`), which resolves node types via `reader.getNode` (`src/graph-writes.ts:168`), and `onRunEnd` awaits `browser.dispose(runId)` (`src/createStrut.ts:1096`). A slow graph delays run completion and the callback by up to the acquisition timeout per lookup.
- Recommendation: explicit `connectionTimeout` 5 s, `connectionAcquisitionTimeout` 15 s, bounded `maxTransactionRetryTime`; `Promise.race` the reporter flush against 2–3 s (it is a report, not the record); `/health?deep=1` that probes the graph.

**5.3 Boot blocks on a model download with no timeout — Medium, proven.** `MiniLMEmbedder.load()` awaited in `open()` (`src/graph/backend.ts:317`), `allowLocalModels = false` (`src/graph/embeddings.ts:75`): first boot fetches ~90 MB with no strut-side timeout. Audio downloads: `await fetchImpl(asset.url)` with no signal (`src/audio/download.ts:73`), though atomic install + sha256 are good. Compose `start_period: 120s` can be exceeded on a slow link → container killed mid-download, loop. Recommendation: load the embedder after `listen`, or bake the model into the image (the `strut-models` volume already exists).

**5.4 `http` step and capability have no default timeout — Medium, proven.** Signal only when the author sets `timeout` (`src/capabilities.ts:207`, `src/steps/core/http.ts:24, 40`). A hung third party holds the run until undici's 300 s. Default 30 s, overridable.

**5.5 Peer struts: no request timeout, per-run poll cost — Medium, proven.** `peersCapability.fetch` passes only the caller's signal (`src/peers.ts:261, 296`); launch POSTs and `steps/lib/home/sync.ts:14` pass none. Each tailed peer run adds a 200 ms watcher (`src/steps/lib/strut/run-workflow.ts:168-175`) plus one SSE; channel bridges a ping per socket (`src/channels-peer.ts:54`). Done well: the peer tail has exponential backoff capped at 30 s and `maxAttempts` 20 (`src/peers.ts:440, 526`).

**5.6 Run-end fan-out is unbounded in count but detached — Low, proven.** Every run end schedules a verify pass via `setImmediate` (`src/verify.ts:908`) that launches check runs; budgets cap spend ($10/run, $100/subject/day, `:403-404, 623-626`), not concurrency. Subscription sync does `Promise.all(subs.map(sync))` every 10 min with no overlap guard (`src/packages/subscriptions.ts:356`, `src/createStrut.ts:3814-3819`). Done well: projection (`:1439`), callback (`:5247`) and chat projection (`:6186`) are `void` with `.catch`; `postCallback` has a 10 s timeout, retries `[1s, 5s, 30s]`, and 4xx short-circuit (`src/callback.ts:89-104`); MCP clients have 15 s connect and 300 s call timeouts (`src/mcp-servers.ts:27-29`); the browser connects with a 30 s timeout and single-flights connection (`src/browser/service.ts:597-620`); all package-index fetches carry `AbortSignal.timeout`.

**5.7 Inbound rate limiting exists only on `/public/*` — Low, proven.** Per-visitor per-minute counter (`src/public-routes.ts:100-121`); nothing on `/run`, `/chat`, or peer routes. The API key is the only gate.

### 2.6 Horizontal scalability & distributed coordination

There is no coordination primitive in `src/` (zero non-test hits for `lease|flock|leader|lockfile|O_EXCL`). The authors state the stance in three places: `src/jobs.ts:37-38`, `src/session-store.ts:401-403`, `src/createStrut.ts:364-365`. The unit of deployment is one data folder + one process; `strut move` copies a stopped strut (`AGENTS.md`, "Moving strut to another host"). `plans/automations.md:327` already names the fix for the scheduler: compare-and-set on a persisted `nextRunAt`.

**6.1 Two instances over one `dataDir` duplicate live runs at boot — Critical if it happens, proven mechanism.**
- `autoResumeStaleRuns.consider` decides "stale" by `!controllers.has(…)` (in-process) and no `run.json` (`src/createStrut.ts:2160-2161`), then `launchDurableResume` (`:2211`). Instance B booting while A has a run in flight sees no summary, a last event seconds old, no pause marker → resumes it. Both append to the same `events.jsonl`, both run side-effecting steps. `wakes.reconcile()` drains every `wakes/*.json` the same way (`src/wake.ts:502-517`). A rolling deploy that overlaps two processes on one volume is enough.
- Recommendation: a per-run lease (owner id + heartbeat) — `StrutRun.lease_owner`/`lease_until` on Neo4j, or a `wx`-created lock file beside `events.jsonl` — and resume only expired leases. Cheapest guard today: a `wx` lock file in `dataDir` at boot, refusing to start while it is held by a live pid.

**6.2 Run control is in-memory; cancel/pause from another instance is impossible — High, proven.**
- `controllers` Map (`src/createStrut.ts:855`) backs `isLive`, `runOf`, `/runs/active`, cancel lookup (`:1001, 1034, 1742, 2267`). Same for `turnAborts` (`:6179`), job holds (`src/jobs.ts:585-589`), session locks (`src/session-store.ts:403`), `launchKeys` idempotency (`:5559, 5679-5704` — a key replayed to instance B launches a second run), rooms/channel sockets.
- Recommendation: persist control intent (`run.cancelling` on the run record, polled at `checkpoint()`) — control is already cooperative, so this is the robust path; sticky routing by `runId` is the cheap one but orphans runs when an instance dies.

**6.3 Scheduler double-fires with two instances — High, proven, acknowledged.** `nextRunAt` memory-only (`src/scheduler.ts:8-9, 146`); in-flight guard is in-process (`:53, 197, 211`). Mitigation exists: `STRUT_SCHEDULER=0` / `scheduler: false` for a host that owns the clock (`src/createStrut.ts:362-363`). Leader lease on the `Automation` node later.

**6.4 Live feeds and tails are epoch-scoped per process — Medium, proven.** `FEED_EPOCH = Date.now().toString(36)` (`src/live-feed.ts:26`); a foreign-epoch cursor resets (`:173`). Run tails wake via in-process `wakeTails` (`src/store.ts:563`). Cross-instance needs pub/sub or sticky sessions.

**6.5 Dual write, no transaction: run store vs graph projection — Medium, proven.** `finalize` renames `run.json` into place (`src/store.ts:573-575`), then `onRunEnd` fires `void projectRunOnce` (`src/createStrut.ts:1439`). A crash between them leaves a finished run never projected (auto-resume returns `"seen"` on a summary, `:2161`). Projection is idempotent and single-flighted (`src/graph/projector.ts:831-833`), so a boot sweep "runs with `run.json` and no `StrutRun`" is cheap.

**6.6 Shared-disk safety by store — Medium, mixed.** `FileRunStore.append` is single-writer safe (3.2 aside); `finalize` is atomic. `FileSecretStore.set` is whole-file read-modify-write with no cross-process lock (in-process `saving` chain only). Ladybug is opened once per path per process with an in-process queue (`src/graph/ladybug/db.ts:1-13`) and is not shareable. Auth sessions are stateless HMAC cookies (`src/auth.ts:345-405`) — the one request-scoped state that already shares.

What two instances behind a load balancer would take:

| State | Today | Would need |
|---|---|---|
| controllers, cancel/pause, in-flight | process Map | persisted control intent + lease table, or sticky-by-runId |
| boot auto-resume, wake reconcile | scan + in-process check | per-run lease with heartbeat |
| scheduler | every instance ticks | one leader (env flag now; leased `nextRunAt` later) |
| live feeds, tails, rooms, channels | process epoch + sockets | pub/sub or sticky sessions |
| launchKeys, turnAborts, job holds, session locks | process Maps | rows with TTL |
| run/chat/wake/secret files | local disk | shared disk only under single-writer lease; secrets need a lock |
| Ladybug | embedded, one process | not shareable; Neo4j only |
| auth sessions | HMAC cookie | already shareable |

### 2.7 Fault tolerance, recovery & load shedding

**7.1 Boot auto-resume is unbounded and unstaggered — High, proven, incident-backed.**
- `src/createStrut.ts:2208-2247`: for every workflow, `listRuns`, then `consider()` each; eligible runs hit `launchDurableResume(prepared)` inline. No count cap, no pacing, no concurrency budget. Per-run guards only: age ≤ 7 d, `maxResumes` 5, log ≤ 64 MB. When `boot.json` exists the loop does not stop at the first finished run (`:2246`), so it visits every run directory of every workflow — O(total runs) summary reads per boot. Each resume reads the full log, builds the journal (every `step.end` output in memory), clears the summary and relaunches. `autoResumeStaleChats` (`:6658-6680`) does the same per stale chat.
- Scenario: the process dies with 1,000 live runs → after the 3 s delay (`:7535`) up to 1,000 logs are read (realistically several GB) and 1,000 runs launched in one loop; if that OOMs, the next boot repeats until each run's resume counter hits 5. This is the swarm38 crash loop.
- Recommendation: `maxConcurrentResumes` (e.g. 10) with pacing; newest first; leave the rest "stale" (resumable by hand). `consider()` is already cheap-first (summary before log) — keep that.

**7.2 No graceful shutdown drain — Medium, proven.**
- `src/server.ts:271-280`: SIGTERM/SIGINT → `setTimeout(process.exit, 1500)` + `closeAllLadybug()` → exit. `strut.close()` (`src/createStrut.ts:7470-7507`) is never called from the signal path, and it does not cancel or await controllers either. Runs are cut mid-step (relying on 7.1), SSE clients see a reset, `ownSink.close()` never flushes (up to 10,000 sink events dropped).
- Recommendation: on SIGTERM call `strut.close()`, then `controller.cancel()` for every live controller, wait up to N seconds, then exit. The `run.cancelling` marker path already lets boot finalise these cleanly (`:2186-2190`).

**7.3 No load shedding — Medium, proven.** `grep "429\|503\|overload"` in `createStrut.ts` → only a 503 for unconfigured voice. No SSE connection counter (two `streamSSE` routes, `:1864, 6963`), no per-client rate limit on `/run`, no event-loop-lag breaker. With 1.1 and 1.3 the process can be driven to OOM by one key-holding client.

**7.4 Crash loses in-memory state — Medium, mostly expected.** Lost: `controllers`, `launchKeys` (a client retry after restart launches a duplicate), `scopedLaunches`, `liveSessions`, job `held`, scheduler `launched`/`fireErrors`, `turnAborts`, job outboxes (unsent `job.update` callbacks, `src/jobs.ts:264`), events-sink queue. Persisted well: wakes (`wakes/*.json`), run callback/mcp/jobCallback beside the log (`src/store.ts:515-550`), `boot.json` cursor. Recommendation: persist `launchKeys` to the run dir or derive from `run.start`.

**7.5 Journal replay — Low, done well.** `buildJournal` is one O(n) pass; `invalidateFrom` bounded by flow size; torn-tail repair before every read (`:1954-1957`); replayed foreach iterations keyed by `#i` (`src/runner.ts:1185-1197`). Residual risk is memory: the journal holds every output of a 64 MB log during replay.

### 2.8 I/O efficiency, streaming & fan-out

**8.1 Per-subscriber tail reopens the file every 250 ms even when idle — Medium, proven.** `src/store.ts:94-105`: `open` + `fstat` + `close` per iteration regardless of appends; the wake-up only shortens the sleep. V viewers × L live runs = 4·V·L syscall triples per second. No shared tailer per run: each SSE subscriber is its own generator. Recommendation: `stat(path)` and open only when `size > offset`; or one tailer per `(workflow, runId)` fanned out to N subscribers (the `tailWaiters` keying already exists).

**8.2 SSE `?skip=N` still reads and parses the whole history — Medium, proven.** `tailJsonl` starts at `offset = 0` (`src/store.ts:83`) and only suppresses yielding (`:120-121`); every byte is read and every line parsed, then `withTranscriptLink` re-stringifies each event (`src/createStrut.ts:1881`). Each new subscriber of a 60 MB log costs a 60 MB read + parse before its first live frame.

**8.3 Chat SSE replays every earlier turn and has no wake-up — Medium, proven.** `FileChatStore.tailEvents` tails the whole `events.jsonl` from byte 0 and filters by `turn` (`src/chat-store.ts:472-483`); `appendEvent` never calls `wakeTails` (`:458-465`), so chat streams run on the 250 ms poll alone. Reattaching to turn 200 reads 199 turns' token deltas.

**8.4 Polling inventory (non-test).** 250 ms: run tail fallback, memory chat tail, `run/get { wait }` (`src/createStrut.ts:5648`), conversations long-poll (`src/conversations.ts:610`). 200 ms: cancel watchers per in-flight exec/agent-bash/git/run-workflow (4.4). 1 s: channel tick (`src/channels.ts:63, 454`). 15 s: scheduler. 60 s: embedding tick, 15 s budget, batch 100 (`src/graph/embeddings.ts:310-312`). 10 min: distro poll + index crawl. `findRun` spins at 10 ms up to 2 s (`:2265`). Web UI: `/runs/active` every 5 s (`web/src/app.tsx:649`, served from the Map — cheap), apps every 30 s, automations panel every 10 s.

**8.5 Network batching — done well.** Events sink batches 100 / 1 s, one POST in flight (`src/events-sink.ts:116-163`); graph reporter debounced 1 s / 5 s max (`src/graph-writes.ts:116-118`); projector writes nodes and edges with one `writeMany` each (`src/graph/projector.ts:600, 706`); reply deltas batched at 50 ms (`src/steps/core/agent.ts:659`); HTTP compression on JSON reads (`src/createStrut.ts:1495`); `/events` strips `messages` into a transcript link (`:1782-1786`).

---

## 3. Scaling characteristics

Baseline: one process, one volume, a handful of concurrent runs, a few viewers, runs measured in hundreds per workflow.

**10× (tens of concurrent runs, thousands of runs per workflow, a dozen viewers).**
- CPU: fine. The event loop absorbs tens of runs; checkpoints at step boundaries keep SSE responsive unless one step parses something huge (1.6).
- Disk: agent-heavy workflows cross 100 MB logs routinely (2.1, 4.1). The Versions tab and `GET /workflows` become noticeably slow (thousands of sequential `stat`/`read` calls per view, 2.3–2.4). No retention, so the volume grows linearly with run count × amplification.
- Recovery: a restart with tens of live runs re-reads tens of logs and relaunches them together — survivable, but each relaunch replays its whole LLM context.
- Correctness: parallel branches with large outputs begin to have a real chance of interleaved appends (3.2); two operators editing one workflow's metadata can lose a change (3.1).

**100× (hundreds of concurrent runs, tens of thousands of runs, dozens of viewers).**
- Memory: hundreds of in-flight scopes (each up to Σ outputs ≤ 8 MB per step) plus hundreds of LLM streams and subprocess buffers (500k chars × 2 per exec) plus per-viewer tail buffers equal to log size (4.2). The heap is the admission controller. This is the swarm38 regime.
- Provider: with no per-provider limiter, hundreds of concurrent agents × retry stacking (5.1) produce 429 storms; each continuation replays the whole conversation, so retries cost tokens superlinearly.
- Disk I/O: hundreds of runs × (2 syscalls per event) + viewers × 4 syscalls/s per tail + per-token chat appends (4.5). The Ladybug write queue (3.3) serialises every graph write in the process behind one connection.
- Recovery: a crash now relaunches hundreds of runs at boot in one loop with no pacing (7.1). If the relaunch OOMs, the process loops until each run's 5-resume counter trips — minutes to hours of unavailability with side effects re-executed on each pass.
- Listing: `GET /workflows` is O(W · R log R) per sidebar refresh with R in the tens of thousands (2.4); `/versions` reads tens of thousands of summaries sequentially (2.3).

**1,000× (thousands of concurrent runs, hundreds of thousands of runs).**
- Not reachable in one process regardless of tuning: thousands of LLM streams, subprocesses and open sockets exceed the heap and file-descriptor budget of a single Node process, and one event loop cannot fairly serve thousands of runs plus their viewers. The architecture must shard runs across processes.
- Sharding is blocked by 6.1–6.4: there is no lease, no shared control plane, no shared feed. Two processes on one volume today is a correctness failure (duplicate execution), not a performance one.
- Storage: run directories in the hundreds of thousands make `readdir` + sort per listing (2.4) and per-boot scans (7.1) multi-second operations; a flat `runs/` directory per workflow is itself a limit on most filesystems.

---

## 4. Architectural bottlenecks

These are the components that bound scale by construction, not by a missing guard.

1. **In-process run execution with in-memory control (`controllers` Map, `RunController`).** Every run shares one event loop and one heap; "in flight" is defined as "in this Map". This caps throughput at what one Node process can hold and makes a second process unsafe (6.1–6.3). Moving control intent and leases to the graph (which is already the shared store) is the structural change that unlocks sharding; the cooperative-checkpoint design makes it feasible without touching step code.
2. **Append-only JSONL as both the record and the read model.** Every read — control, listing, transcript, resume, projection, each SSE subscriber — reparses the whole file (1.6, 2.3, 4.2, 8.2). Container re-emission multiplies the file (2.1). An index (byte offset per event, `start.json`, `lastEvent`) and a reference-only container `step.end` turn most O(log) reads into O(1) without replacing the format.
3. **Flat filesystem metadata without atomic writes or locks (`_metadata.json`, chat `meta.json`).** Fine for one careful writer; a data-loss class under concurrent requests (3.1). The graph workspace backend does not have this problem; the fs and Ladybug paths do.
4. **One serial writer per heavy resource:** Ladybug write connection (3.3), embedding worker (3.5), browser session cap. Independent runs queue behind each. Acceptable for the desktop target; a server target needs either Neo4j or a per-run budget on these.
5. **No admission or shedding layer in front of `launchDetached`.** Every scaling failure above is reached by launching more; nothing in the system says no (1.1, 1.3, 7.3).

---

## 5. Recommended actions

### Quick wins (each a small, local change; ordered by risk retired per line of code)

1. **Global and per-workflow run semaphore in `launchDetached`** (1.1): refuse with 429/503 + `Retry-After`; `fireOne` logs `skipped: at capacity`. Retires 1.8 and 7.3 largely as well.
2. **`bodyLimit` middleware** after auth (1.3), 16 MiB default, larger on upload routes.
3. **Bounded, paced boot auto-resume** (7.1): `maxConcurrentResumes` 10, newest first, the rest left stale.
4. **Atomic + locked JSON writes** for workspace metadata, chat meta, session rewrite (3.1): one helper, reused from `jobs.ts`'s pattern.
5. **Serialise `store.append` per run** (3.2): a promise chain on `Exec`, or one `FileHandle` per live run.
6. **SIGTERM → `strut.close()` + cancel all controllers + bounded wait** (7.2).
7. **Container `step.end` as a reference, not the aggregate** (2.1); drop `messages` from `tool:*` events (2.2).
8. **Retention sweep** (4.1): `STRUT_RUN_RETENTION_DAYS` for runs, chats, sessions, artifacts; gzip finished logs at minimum.
9. **LLM call hygiene** (5.1): `maxRetries` and a per-call deadline into the SDK; exponential + jittered step retry; per-provider semaphore.
10. **Defaults on outbound calls** (5.2, 5.4, 5.5): Neo4j driver timeouts, `http` step 30 s default, `peers.fetch` 30 s for non-stream calls, reporter flush raced against 2–3 s.
11. **Tail-read for `findRun`; `start.json` sidecar at launch** (1.6): removes whole-log parses from every control request and from the scheduler/job-launch paths.
12. **`closeMcp` via `ctx.onRunEnd`; SIGKILL fallback for ACP** (4.3).
13. **Chat path parity** (4.5, 8.3): batch deltas at 50 ms like `createReplyTap`, call `wakeTails` in `appendEvent`, per-turn offsets.
14. **Enforce `maxRunCostUsd` in `emit` without Mothership** (1.2).
15. **Single-flight and throttle `sweepJobs`; re-read the record under the lock** (3.4). Single-flight subscription `syncAll` (5.6).
16. **`/health?deep=1`** probing the graph (5.2); boot lock file in `dataDir` refusing a second live process (6.1 cheapest guard).

### Structural changes (each a design, with the trade-off)

1. **Persisted run leases and control intent.** `StrutRun.lease_owner`/`lease_until` with heartbeat; `cancel`/`pause` written to the record and read at `checkpoint()`. Unlocks multi-instance resume safety (6.1), cross-instance control (6.2), and makes "in flight" a durable fact. Trade-off: fs and Ladybug backends need their own lease store (a `wx` lock file per run works on local disk, not reliably on NFS); the graph becomes a hard dependency for control, not just the workspace.
2. **Leader election for the scheduler** via compare-and-set on a persisted `nextRunAt` (already named in `plans/automations.md:327`). Trade-off: a leased leader adds a failover window equal to the lease TTL; the env-flag approach (one instance ticks) is zero-cost but manual.
3. **Event index beside the log**: byte offset per event, `start.json`, `lastEvent`, per-event-type offsets for transcripts. Turns O(log) reads into O(1) seeks and lets SSE resume at a byte. Trade-off: a second file to keep consistent; append-only index means a torn index needs the same repair logic as the log.
4. **Shared tailer per run + pub/sub for live feeds** (one reader per `(workflow, runId)` fanning out to N subscribers; Redis/NATS or the graph's own change feed for cross-instance). Trade-off: an extra moving part for the single-instance deployment that does not need it — make it a backend behind the existing `LiveFeed`/`tailWaiters` interfaces.
5. **Run-store backend on the graph (or a database) for metadata and summaries**, keeping JSONL for the event body. Removes `readdir`-per-listing (2.4), sequential summary scans (2.3), unlocked metadata (3.1), and the dual-write gap (6.5) in one move. Trade-off: the fs-only deployment (`STRUT_WORKSPACE_BACKEND=fs`) loses its "no database" property unless the index is SQLite.
6. **Worker-thread or child-process isolation for CPU-heavy steps** (large parses, regex over megabytes, the `view` tool) to restore fairness (1.8) without capping concurrency harder than necessary. Trade-off: serialisation cost across the boundary; only worth it once 1.1 shows the loop, not the heap, is the limit.

---

## 6. Validation plan

Each experiment names the finding it confirms or refutes and the signal to watch. All are runnable against `npm run dev` or `docker compose up` with the fs or ladybug backend unless noted.

**Load tests**
1. **Launch burst** (1.1, 1.3, 7.3): 500 `POST /workflows/:name/run` within 1 s against a workflow with one `wait` step and one with an `exec` sleeping 60 s. Watch RSS, open file descriptors (`lsof -p`), event-loop lag (`perf_hooks.monitorEventLoopDelay`), and whether any launch is refused. Expect: none refused, RSS and FDs linear in launches.
2. **Viewer fan-out** (4.2, 8.1, 8.2): one live agent run with a 50 MB log; open 50 SSE subscribers with `?skip=<n>`. Measure time-to-first-live-frame per subscriber, bytes read (`strace -e openat,read` or `fs_usage`), and heap delta. Expect: each subscriber reads the full file; 4 syscalls/s per subscriber while idle.
3. **Listing cost** (2.3, 2.4): seed one workflow with 20,000 finished runs (empty logs are fine). Time `GET /workflows` and `GET /workflows/:name/versions`; count syscalls. Expect: `/versions` in seconds, sequential; `/workflows` dominated by `readdir` + sort.
4. **Chat turn growth** (2.5, 4.5): a chat with 300 turns of 1,000 tokens each; time turn N's `loadMessages`, count appends per reply. Expect linear-per-turn growth and ~1 append per token.

**Benchmarks / profiling**
5. **Write amplification** (2.1, 2.2): a foreach of 100 items each producing a 1 MB string, nested one level in a subflow; measure `events.jsonl` bytes vs. Σ iteration outputs. Expect ≈ 4–5×. Repeat with a sub-agent-as-tool and count transcript copies (expect 3).
6. **Whole-log read on control** (1.6): a 64 MB log; `POST …/cancel` with `--cpu-prof`. Expect 100–300 ms of parse in `getRunEvents` per control request.
7. **LLM retry stacking** (5.1): a mock provider (the `cassette` layer or a local proxy) returning 529/transient errors; one `llm` step with `retry: { max: 3 }`, one `agent` step. Count provider requests. Expect up to 4 × 3 × (1 + continuations). Then set a budget and confirm it holds.
8. **Append interleaving** (3.2): a DAG with 8 parallel `exec` steps each returning 2 MB of stdout; run 50 times; `getRunEvents` and count dropped-line warnings and missing `step.end`s. Theoretical today — this test decides whether it is proven.

**Failure injection**
9. **Recovery storm** (7.1): start 200 runs of a 10-minute workflow, `kill -9` the process, restart with `--max-old-space-size=512`. Watch boot time, heap, whether boot completes, and the resume counter on each run across repeated restarts. Expect a crash loop until counters reach 5. Repeat with a paced resume to confirm the fix.
10. **Two processes, one volume** (6.1, 6.3): start a run on instance A; boot instance B on the same `dataDir` (`STRUT_HOST_PORT=3100`). Check whether B resumes A's run (`run.resumed` in the log with two writers), and whether an automation fires twice in one tick window. Expect both.
11. **Concurrent metadata edits** (3.1): 20 parallel `PUT /workflows/:name/category` + `POST /workflows/:name` publishes; diff `_metadata.json` versions against the requests. Expect lost versions. Kill the process mid-`writeFile` (a `writeFile` hook or `SIGKILL` loop) and confirm a truncated file turns the workflow into a 404.
12. **Dependency slowness** (5.2, 5.4): `tc`/toxiproxy a 20 s delay on Neo4j bolt and on an `http` step's target. Measure run completion time and callback delay; confirm `/health` stays `ok: true` with Neo4j unreachable.
13. **SIGTERM under load** (7.2): 50 live runs, `docker stop` (10 s grace). Count runs left stale, sink events dropped, and SSE clients reset. Expect: all 50 stale, up to 10k sink events lost, no `run.cancelling` markers.
14. **Force-cancel leak** (4.3): an agent step whose MCP tool hangs; force-cancel the run; `lsof` for the MCP client's socket/pipe after cancel. Expect it held until `CALL_TIMEOUT_MS`.

**Instrumentation to add before testing**
- `/health?deep=1` returning graph probe, `controllers.size`, Ladybug queue depth, sink queue depth, event-loop lag p99.
- A counter of dropped JSONL lines per run (already warned to console in `parseJsonlLine`; surface it on `/runs/:id`).
- Bytes written per run (sum of appended line lengths) on `run.json`, to track amplification in production.
