/**
 * Run + chat PROJECTOR (plans/generic-storage.md §7): a post-hoc consumer of
 * any `RunStore` / `ChatStore` that builds the graph's picture of usage —
 * `StrutRun`, `StrutAgentSession`, `StrutToolCall`, `StrutChat`, `StrutTurn`
 * nodes and the `EXECUTED` / `IN_RUN` / `IN_SESSION` / `SPAWNED` /
 * `IN_CHAT` edges — with summaries and a `log_ref` pointer back to the raw
 * log, never full payloads. The one exception is a conversation turn's
 * words, kept whole so search reads what was said (`TEXT_MAX_CHARS`): a
 * builder chat turn's message and reply, and a thread turn's (an agent step
 * with a `session`) — its `message` (the person's words when its prompt
 * wraps them, else the prompt) and its reply's text. Never the tool
 * traffic, the system prompt or attachments.
 *
 * The raw log stays the store of record (tailing, resume, replay); this is
 * the queryable skeleton on top. Zero coupling to the hot path: `createStrut`
 * projects every top-level run when it ends, and every builder chat when one
 * of its turns ends, DETACHED from the run's teardown and the turn's (graph
 * workspaces only), and it can be run again at boot, on a
 * schedule, as a workflow, or by hand — for runs cut off before their end,
 * and whenever the edge vocabulary grows. Every write is an idempotent
 * `upsert` keyed by the node's identity (`unique_source_id` stamped for
 * cheap reconciliation).
 *
 * Provenance: a tool call whose `step.end` carries `nodes` (the convention
 * in plans/generic-storage.md "v2" — graph-touching steps mark their output
 * with `withAccessedNodes`, and `wrapToolsWithEmit` lifts the marker onto
 * the event untruncated) gets one `ACCESSED` edge per node that exists in
 * this graph. Refs the graph doesn't hold (another database, a deleted
 * node) are counted as `unresolved`, never written — explicit over clever.
 * A ref tagged with a `peer` (another strut's graph, plans/federation.md
 * §2.2) is skipped outright: neither an edge nor `unresolved`.
 *
 * A Ladybug file holds no tool calls, so there the RUN is the record of
 * what was read: one `StrutRun -ACCESSED->` edge per node any step of the
 * run reported (a workflow step's `nodes`, like `context/concept`'s, as well
 * as a tool call's). The edge is in the run's namespace, the writer's rule
 * for an edge that names none. A run may read a node in another namespace
 * (a `private` run opening a `shared` Concept); the edge holds the node's
 * ref and nothing of it, and `runsThatRead` returns a use only when the
 * reader's namespaces hold the run, the edge and the node, so neither a
 * private run nor a private node shows through a shared reader.
 *
 * Threads: a `StrutAgentSession` is ONE execution of an agent step — one
 * turn. An agent that continued a thread (`session`, plans/agent-sessions.md)
 * carries `session_id` + `session_turn`, so a thread is every node with that
 * id, across runs and workflows. A thread that is an assistant CONVERSATION
 * (the index's record, src/conversations.ts) is also a node: one
 * `StrutChat` with `kind: assistant`, every turn's session `IN_CHAT` it —
 * the builder chat's type (`kind: builder`, its turns `StrutTurn`s), so a
 * conversation is one type in the graph however strut held it.
 *
 * Jobs (plans/job-index.md §6): a run under a job upserts its `StrutJob`
 * (`IN_JOB`) and one `StrutArtifact` per current deliverable of the job
 * (`HAS_ARTIFACT`), and gets a `DELIVERED` edge to each artifact its own
 * output declares. An artifact's `from` (plans/work-products.md §2) is a
 * `DERIVED_FROM` edge to each of those nodes the graph holds.
 *
 * Proposals (plans/proposals.md §2): a run's gated tool calls are one
 * `StrutProposal` each, `IN_RUN` the run, with an `ACCESSED` edge to each
 * node its apply wrote. The record (`<dataDir>/proposals/`) stays the store
 * of record and what every list reads; the node is written with the run and
 * again at each change (`projectProposalOnce`: proposed, decided, applied).
 *
 * Not projected: `PROMOTED_FROM` — promotions publish a new version without
 * recording the source run.
 *
 * Only the types the backend's ontology holds are written: every Strut type
 * on Neo4j; on a LadybugDB file (plans/ladybug-backend.md), whose seed
 * leaves the chat and agent-session types out, `StrutRun`, `StrutJob` and
 * `StrutArtifact` and `StrutProposal` with `EXECUTED`, `IN_JOB`,
 * `HAS_ARTIFACT`, `DELIVERED`, `DERIVED_FROM`, `IN_RUN` (a proposal's) and
 * `ACCESSED` (the run's and a proposal's); the
 * agent sessions, tool calls, their edges and the whole chat projection are
 * skipped there, and the report counts what was written. The statements
 * are written with the backend's dialect helpers (`engine.ts`).
 */
import type { AccessedNode, RunEvent, RunSummary } from "../core.js";
import { stepTypeOfRunKey, type RunStore } from "../store.js";
import type { ChatMeta, ChatStore, StoredMessage } from "../chat-store.js";
import { idProblem, peerSessionId } from "../session-store.js";
import { artifactEntriesOf } from "../artifact-refs.js";
import type { JobIndex, JobView } from "../job-index.js";
import type { ConversationRecord, Conversations } from "../conversations.js";
import type { Proposal, ProposalsCapability } from "../proposals.js";
import type { GraphBackend } from "./backend.js";
import type { NodeInput } from "./node-writer.js";
import type { EdgeInput } from "./edge-writer.js";
import { PREVIEW_MAX_CHARS, TEXT_MAX_CHARS, getStrutSchema } from "./strut-schemas.js";

/** Does this backend's ontology hold nodes of `type`? Every type where
 *  Strut's own types come from code (Neo4j: jarvis's meta-graph is open, and
 *  a stand-in with no store); on a Ladybug file, what its Schema rows hold. */
async function holds(backend: GraphBackend, type: string): Promise<boolean> {
  if (!backend.schemaSource?.holdsStrutTypes) return true;
  return (await backend.schemas.schema(type)) !== null;
}

/** The `unique_source_id` reconciliation stamp is jarvis's (Thing's); a type
 *  that leaves it off (a Ladybug file's) gets the nodes without it — identity
 *  is the key there anyway. */
async function fit(backend: GraphBackend, nodes: NodeInput[]): Promise<NodeInput[]> {
  if (!backend.schemaSource?.holdsStrutTypes) return nodes;
  return Promise.all(
    nodes.map(async (n) => ((await backend.schemas.schema(n.type))?.attributes["unique_source_id"] ? n : { ...n, data: Object.fromEntries(Object.entries(n.data).filter(([k]) => k !== "unique_source_id")) })),
  );
}

/** What the projector needs of the job index (plans/job-index.md §6): a
 *  job read back, to upsert its `StrutJob`. `createStrut` hands its
 *  `services.jobs`; a bare caller hands nothing and no job node is written. */
export type JobReader = Pick<Partial<JobIndex>, "get">;

/** What the projector needs of the conversation index (plans/jamie-app.md
 *  §2): a session's record, to project its conversation as a `StrutChat`.
 *  `createStrut` hands its index; without one no conversation is written. */
export type ConversationReader = Pick<Conversations, "record">;

/** What the projector needs of the proposals (plans/proposals.md §2): a
 *  run's, to project with it, and one by id, when it changes. `createStrut`
 *  hands its `services.proposals`; without one no proposal is written. */
export type ProposalReader = Pick<ProposalsCapability, "get" | "list">;

/** The cap on a `StrutJob.summary` — the search text. */
const JOB_SUMMARY_MAX_CHARS = 2000;

export interface ProjectRunsOptions {
  /** Workflows to project. Default: every workflow with runs is unknown to a
   *  bare store, so callers pass the list (e.g. from `workspace.listWorkflows`). */
  workflows: string[];
  /** Newest N runs per workflow (default: all). */
  limitPerWorkflow?: number;
  /** Skip runs the graph already holds with a terminal status (cheap
   *  incremental re-runs; default true). Pass false to force re-projection. */
  skipSettled?: boolean;
  /** The job index, for the `StrutJob` of each run launched under a job. */
  jobs?: JobReader;
  /** The conversation index, for the `StrutChat` of each conversation turn. */
  conversations?: ConversationReader;
  /** The proposals, for the `StrutProposal` of each gated call a run made. */
  proposals?: ProposalReader;
}

export interface ProjectReport {
  runs: number;
  sessions: number;
  toolCalls: number;
  chats: number;
  turns: number;
  /** Every edge written, `ACCESSED` included. */
  edges: number;
  /** `ACCESSED` edges written (tool call → node it touched). */
  accessed: number;
  /** Node refs tool calls reported that this graph does not hold — no edge. */
  unresolved: number;
  skipped: number;
  /** `StrutJob` nodes upserted (one per run of a job, from the index). */
  jobs: number;
  /** `StrutProposal` nodes upserted. */
  proposals: number;
}

const emptyReport = (): ProjectReport => ({ runs: 0, sessions: 0, toolCalls: 0, chats: 0, turns: 0, edges: 0, accessed: 0, unresolved: 0, skipped: 0, jobs: 0, proposals: 0 });

/** A bounded text preview of any value — the shape of payload that reaches
 *  the graph, but for a conversation turn's words (`wholeText`). */
export function preview(v: unknown, max = PREVIEW_MAX_CHARS): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A conversation turn's words, whole up to `TEXT_MAX_CHARS`; past it the
 *  start and the last fifth, the middle left out. Text only. */
export function wholeText(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  if (v.length <= TEXT_MAX_CHARS) return v;
  const tail = TEXT_MAX_CHARS / 5;
  return `${v.slice(0, TEXT_MAX_CHARS - tail - 3)}\n…\n${v.slice(-tail)}`;
}

/** What an agent answered, as text: a structured reply's `text` (the job
 *  and orchestrator reply shape), else its result. */
export function replyText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  const o = output as { object?: { text?: unknown } | null; result?: unknown } | null | undefined;
  if (typeof o?.object?.text === "string") return o.object.text;
  return typeof o?.result === "string" ? o.result : undefined;
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

const TERMINAL = new Set(["run.end", "run.error", "run.cancelled"]);

function isTerminalStatus(s: unknown): boolean {
  return s === "success" || s === "error" || s === "cancelled";
}

/** Status of a run from its summary, else from the last terminal event in
 *  the log, else "stale" (never finalized — crashed or still in flight). */
function runStatus(summary: RunSummary | null, events: RunEvent[]): string {
  if (summary) return summary.status;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "run.resumed") return "stale";
    if (e.type === "run.end") return "success";
    if (e.type === "run.error") return "error";
    if (e.type === "run.cancelled") return "cancelled";
  }
  return "stale";
}

export interface RunProjection {
  run: NodeInput;
  sessions: NodeInput[];
  toolCalls: Array<{ node: NodeInput; sessionPath: string; accessed: AccessedNode[] }>;
  /** Every node any step of the run reported (`step.end` `nodes`: workflow
   *  steps and tool calls alike), once each, peers' left out. */
  accessed: AccessedNode[];
  workflowHash?: string;
  stepHashes?: Record<string, string>;
  /** The job the run was launched under (`run.start.job`), if any. */
  job?: string;
  /** WHO SENT the orchestrator turn: the hive user id taken from the run's
   *  actor (`run.start.actor`, else the summary's) — never from a prompt.
   *  Set only for the `orchestrator` workflow's person launches; `session`
   *  is the ref path of the turn's `StrutAgentSession`. */
  speaker?: { userId: string; actor: string; sessionPath: string };
}

/** The workflow and agent step that is one orchestrator TURN
 *  (`src/orchestrator-seed.ts`, step `turn`). */
export const ORCHESTRATOR_WORKFLOW_NAME = "orchestrator";
export const ORCHESTRATOR_TURN_PATH = "orchestrator/turn";
/** A hive user id is a cuid: `c` + 20–31 lowercase alphanumerics. */
const USER_ID = /^c[a-z0-9]{20,31}$/;

/** The hive user id in an actor of the form `<github_username>-<user_id>`
 *  (the part after the LAST hyphen), or the whole value when it is a bare id.
 *  Anything else — no actor, a non-person principal, an empty id, a bare
 *  handle — names nobody: undefined. */
export function speakerUserId(actor: string | undefined): string | undefined {
  const a = actor?.trim();
  if (!a) return undefined;
  const id = a.slice(a.lastIndexOf("-") + 1);
  return USER_ID.test(id) ? id : undefined;
}

/** Pure: the nodes one run contributes (no graph access). */
export function projectRunEvents(workflow: string, runId: string, events: RunEvent[], summary: RunSummary | null): RunProjection | null {
  if (events.length === 0 && !summary) return null;
  const start = events.find((e) => e.type === "run.start");
  const status = runStatus(summary, events);
  const lastError = [...events].reverse().find((e) => e.type === "step.error" || e.type === "run.error")?.error;
  const stepEnds = events.filter((e) => e.type === "step.end").length;
  const durationMs = summary?.durationMs;
  const errorMessage = summary?.error?.message ?? lastError?.message;
  const summaryText = errorMessage
    ? `${status}: ${errorMessage}`.slice(0, PREVIEW_MAX_CHARS)
    : `${status} · ${stepEnds} step${stepEnds === 1 ? "" : "s"} completed${durationMs != null ? ` in ${durationMs}ms` : ""}`;
  const logRef = `${workflow}/${runId}`;
  // The job (plans/jobs.md §1): on `run.start`, and on the summary.
  const job = typeof start?.job === "string" ? start.job : summary?.job;

  const run: NodeInput = {
    type: "StrutRun",
    data: compact({
      run_id: runId,
      job,
      workflow_name: workflow,
      run_status: status,
      summary: summaryText,
      started_at: summary?.startedAt ?? start?.ts ?? events[0]?.ts ?? new Date(Number(runId) || Date.now()).toISOString(),
      finished_at: summary?.finishedAt,
      duration_ms: durationMs,
      workflow_hash: start?.workflowHash,
      params_json: start?.params ? JSON.stringify(start.params) : undefined,
      input_preview: preview(summary?.input ?? start?.input),
      output_preview: preview(summary?.output),
      error_message: errorMessage,
      log_ref: logRef,
      unique_source_id: `strutrun:${runId}`,
    }),
  };

  // Agent sessions: every `agent` step.start, paired with its end/error at
  // the same path (+ iteration).
  const sessions: NodeInput[] = [];
  const sessionPaths: string[] = [];
  const keyOf = (e: RunEvent) => `${e.path}${e.iteration != null ? `#${e.iteration}` : ""}`;
  const ends = new Map<string, RunEvent>();
  for (const e of events) if ((e.type === "step.end" || e.type === "step.error") && e.stepType === "agent") ends.set(keyOf(e), e);
  // A peer's run opened its sessions under PEER_NAMESPACE (runner.ts
  // `bindPeer`), not under the id its config names — but for a person's
  // own ids, when a person's credential launched it, and the conversation
  // it continues.
  const person = start?.peerPerson ? start.actor : undefined;
  const threadOf = start?.origin === "peer" ? (id: string) => peerSessionId(id, person, start?.continues) : (id: string) => id;
  for (const e of events) {
    if (e.type !== "step.start" || e.stepType !== "agent") continue;
    const end = ends.get(keyOf(e));
    const input = (e.input ?? {}) as Record<string, unknown>;
    // The thread this execution was a turn of (plans/agent-sessions.md). The
    // id is the step's resolved config, so a turn that FAILED is grouped with
    // its thread too; the number is in the output, which only a committed
    // turn has. An id the step refused (a missing template value) names no
    // thread.
    const thread = typeof input["session"] === "string" && !idProblem(input["session"]) ? threadOf(input["session"]) : undefined;
    const turn = (end?.output as { session?: { turn?: unknown } } | null | undefined)?.session?.turn;
    // What the turn answered: the step's `message` (the person's words,
    // when the prompt wraps them in more), else its prompt.
    const asked = input["message"] ?? input["prompt"];
    const reply = replyText(end?.output);
    sessionPaths.push(e.path);
    sessions.push({
      type: "StrutAgentSession",
      data: compact({
        run_id: runId,
        path: keyOf(e),
        step_type: e.stepType,
        model: typeof input["model"] === "string" ? input["model"] : undefined,
        iteration: e.iteration,
        prompt_preview: preview(asked ?? input["system"] ?? e.input),
        result_preview: preview(reply ?? end?.output),
        // A turn of a thread keeps its words whole; a one-shot agent's
        // prompt (a janitor's mandate, a page) stays a preview.
        message: thread !== undefined ? wholeText(asked) : undefined,
        reply: thread !== undefined ? wholeText(reply) : undefined,
        started_at: e.ts,
        duration_ms: end?.durationMs,
        error_message: end?.error?.message,
        log_ref: logRef,
        session_id: thread,
        session_turn: thread !== undefined && typeof turn === "number" ? turn : undefined,
        job,
        unique_source_id: `strutagentsession:${runId}:${keyOf(e)}`,
      }),
    });
  }

  // Tool calls: `tool:<name>` steps nested under a session path, numbered
  // per session in log order. `accessed` is the end event's `nodes` list
  // (the provenance marker), deduplicated by ref_id.
  const toolCalls: RunProjection["toolCalls"] = [];
  const seqBySession = new Map<string, number>();
  const toolEnds = new Map<string, RunEvent>();
  for (const e of events) if ((e.type === "step.end" || e.type === "step.error") && e.stepType?.startsWith("tool:")) toolEnds.set(keyOf(e), e);
  for (const e of events) {
    if (e.type !== "step.start" || !e.stepType?.startsWith("tool:")) continue;
    const session = sessionPaths.filter((p) => e.path.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0];
    if (!session) continue;
    const seq = (seqBySession.get(session) ?? 0) + 1;
    seqBySession.set(session, seq);
    const end = toolEnds.get(keyOf(e));
    const accessed: AccessedNode[] = [];
    const seenRef = new Set<string>();
    for (const n of end?.nodes ?? []) {
      if (!n || typeof n.ref_id !== "string" || !n.ref_id || seenRef.has(n.ref_id)) continue;
      // A ref tagged with a peer is in ANOTHER strut's graph
      // (plans/federation.md §2.2): never resolved here — no edge, and not
      // counted unresolved either; it is simply not this graph's.
      if (n.peer) continue;
      seenRef.add(n.ref_id);
      accessed.push(n);
    }
    toolCalls.push({
      sessionPath: session,
      accessed,
      node: {
        type: "StrutToolCall",
        data: compact({
          run_id: runId,
          path: keyOf(e),
          seq,
          tool_name: e.stepType.slice("tool:".length),
          input_preview: preview(e.input),
          output_preview: preview(end?.output),
          started_at: e.ts,
          duration_ms: end?.durationMs,
          error_message: end?.error?.message,
          log_ref: logRef,
          unique_source_id: `struttoolcall:${runId}:${keyOf(e)}:${seq}`,
        }),
      },
    });
  }

  // The speaker of an orchestrator turn: a PERSON's launch only (a peer's
  // run without a person credential, a schedule's fire and a verify pass
  // are not someone speaking).
  let speaker: RunProjection["speaker"];
  const origin = start?.origin ?? summary?.origin;
  const actor = start?.actor ?? summary?.actor;
  const personLaunch = origin === undefined || origin === "app" || (origin === "peer" && start?.peerPerson === true);
  const userId = speakerUserId(actor);
  if (workflow === ORCHESTRATOR_WORKFLOW_NAME && personLaunch && userId && actor && sessionPaths.includes(ORCHESTRATOR_TURN_PATH)) {
    speaker = { userId, actor, sessionPath: ORCHESTRATOR_TURN_PATH };
  }

  const accessed = new Map<string, AccessedNode>();
  for (const e of events) {
    if (e.type !== "step.end") continue;
    for (const n of e.nodes ?? []) if (n && typeof n.ref_id === "string" && n.ref_id && !n.peer && !accessed.has(n.ref_id)) accessed.set(n.ref_id, n);
  }

  return { run, sessions, toolCalls, accessed: [...accessed.values()], workflowHash: start?.workflowHash, stepHashes: start?.stepHashes, job, speaker };
}

/** The job's node (plans/job-index.md §6), from the index's view: the
 *  title, a summary made of its current deliverables and its latest reply
 *  (the search text), counts, and the id as `log_ref` — `GET /jobs/:id` is
 *  the record. */
export function jobNode(view: JobView): NodeInput {
  const lines = [...view.artifacts.map((a) => [a.title, a.summary].filter(Boolean).join(" — ")), ...(view.text ? [view.text] : [])];
  return {
    type: "StrutJob",
    data: compact({
      job_id: view.job,
      title: view.title ?? view.job,
      summary: preview(lines.join("\n"), JOB_SUMMARY_MAX_CHARS),
      started_at: view.createdAt ?? view.runs[view.runs.length - 1]?.at ?? new Date().toISOString(),
      last_used_at: view.usedAt || undefined,
      run_count: view.runs.length,
      artifact_count: view.artifacts.length,
      log_ref: view.job,
      unique_source_id: `strutjob:${view.job}`,
    }),
    ...(view.createdBy ? { created_by: view.createdBy } : {}),
  };
}

/**
 * The job's `StrutJob`, upserted from the index's view (plans/job-index.md
 * §6) — one node per job, as fresh as its record. Returns its ref_id, or
 * null when there is no index or no record (the job was deleted: the node
 * the graph holds stays, and nothing is written). Shared by the run-end
 * projection and the claims layer, which needs the node to exist when a
 * claim about a job is written — during the job's first turn, before any
 * run of it ended (plans/job-claims.md §1).
 */
export async function ensureJobNode(backend: GraphBackend, jobs: JobReader | undefined, job: string): Promise<string | null> {
  return (await upsertJob(backend, jobs, job))?.jobRef ?? null;
}

/** An assistant conversation as a `StrutChat` (`kind: assistant`), from the
 *  index's record: the builder chat's node, so a conversation is one type
 *  in the graph whoever held it. Who opened it is the first person who
 *  spoke (a wake turn has no speaker of its own). */
export function conversationNode(rec: ConversationRecord): NodeInput {
  const last = rec.turns[rec.turns.length - 1];
  const by = rec.turns.find((t) => !t.wake && t.by)?.by;
  return {
    type: "StrutChat",
    data: compact({
      chat_id: rec.id,
      kind: "assistant",
      title: rec.title,
      status: last?.status,
      started_at: rec.createdAt,
      last_active_at: rec.updatedAt,
      turn_count: rec.turns.length,
      log_ref: rec.id,
      unique_source_id: `strutchat:${rec.id}`,
    }),
    ...(by ? { created_by: by } : {}),
  };
}

/** One `StrutArtifact` per (job, artifact id), from the index's fold (the
 *  newest version of each id): a re-delivery in a later turn lands on the
 *  same node (see the schema's key comment). `at` is when the run that
 *  delivered that version started. */
export function artifactNode(job: string, a: JobView["artifacts"][number], at?: string): NodeInput {
  return {
    type: "StrutArtifact",
    data: compact({
      job_id: job,
      artifact_id: a.id,
      kind: a.kind,
      label: a.label,
      title: a.title,
      summary: preview(a.summary, JOB_SUMMARY_MAX_CHARS),
      url: a.url,
      path: a.path,
      run_id: a.runId,
      delivered_at: at,
      unique_source_id: `strutartifact:${job}:${a.id}`,
    }),
  };
}

/** The artifact ids a run's output declares, as the fold reads them (an
 *  entry with a string `id` and `title`). */
function declaredArtifactIds(output: unknown): string[] {
  return (artifactEntriesOf(output) ?? []).flatMap((e) => {
    const r = e as Record<string, unknown> | null;
    return r && typeof r === "object" && typeof r["id"] === "string" && typeof r["title"] === "string" ? [r["id"]] : [];
  });
}

interface JobUpsert {
  jobRef: string;
  /** The job's runs, as the index reads them. */
  runs: JobView["runs"];
  /** Artifact ref_ids by artifact id. */
  artifacts: Map<string, string>;
}

/** The job node, plus its artifacts and `HAS_ARTIFACT` edges. Left out: a
 *  deliverable another strut server holds (`peer`: its url and path are
 *  that server's, and its node is on that server's graph — the handle rule,
 *  plans/federation.md §2.2), and one with an `error` (nothing to open).
 *  The artifact part is best effort: a failure there never costs the job
 *  node, the run projection or the turn. */
async function upsertJob(backend: GraphBackend, jobs: JobReader | undefined, job: string): Promise<JobUpsert | null> {
  if (!jobs?.get) return null;
  const view = await jobs.get(job, { threads: false });
  if (!view) return null;
  const [node] = await backend.nodes.writeMany(await fit(backend, [jobNode(view)]), "upsert");
  const jobRef = node!.ref_id;
  const out: JobUpsert = { jobRef, runs: view.runs, artifacts: new Map() };
  const local = view.artifacts.filter((a) => !a.peer && !a.error);
  if (local.length && (await holds(backend, "StrutArtifact"))) {
    try {
      const written = await backend.nodes.writeMany(await fit(backend, local.map((a) => artifactNode(job, a, view.runs.find((r) => r.runId === a.runId)?.at))), "upsert");
      await backend.edges.writeMany(written.map((w) => ({ edge: "HAS_ARTIFACT", source_ref_id: jobRef, target_ref_id: w.ref_id })));
      written.forEach((w, i) => out.artifacts.set(local[i]!.id, w.ref_id));
    } catch (e) {
      console.warn(`[projector] job ${job}: artifacts not written: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await writeDerivedFrom(backend, local.flatMap((a) => (out.artifacts.has(a.id) && a.from?.length ? [{ ref: out.artifacts.get(a.id)!, from: a.from }] : [])));
    } catch (e) {
      console.warn(`[projector] job ${job}: DERIVED_FROM not written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** `DERIVED_FROM`: each artifact → every node its `from` names that this
 *  graph holds (plans/work-products.md §2) — a ref on another graph, or a
 *  node since deleted, gets no edge (the writer refuses a missing end).
 *  Add-only, like every edge here: one per (artifact, node), so a ref a
 *  later version no longer names keeps its edge. */
async function writeDerivedFrom(backend: GraphBackend, artifacts: { ref: string; from: string[] }[]): Promise<void> {
  const wanted = [...new Set(artifacts.flatMap((a) => a.from))];
  if (!wanted.length) return;
  const present = new Set<string>();
  for (const id of wanted) if (await backend.reader.getNode(id).catch(() => null)) present.add(id);
  const edges = artifacts.flatMap((a) => a.from.filter((id) => present.has(id)).map((id) => ({ edge: "DERIVED_FROM", source_ref_id: a.ref, target_ref_id: id })));
  if (edges.length) await backend.edges.writeMany(edges);
}

/** One `StrutProposal` per proposal, from its record: what it is, why, who
 *  proposed it and what was decided — never its input or its result, which
 *  stay behind `GET /proposals/:id`. A later apply that succeeds keeps the
 *  last failed one's `error_message` (an upsert leaves what it does not set). */
export function proposalNode(p: Proposal): NodeInput {
  return {
    type: "StrutProposal",
    data: compact({
      proposal_id: p.id,
      step: p.step,
      title: p.title,
      proposal_status: p.status,
      rationale: preview(p.rationale),
      summary: preview(p.summary, JOB_SUMMARY_MAX_CHARS),
      workflow_name: p.by?.workflow,
      run_id: p.by?.runId,
      job_id: p.by?.job,
      session_id: p.by?.session,
      conversation_id: p.by?.conversation,
      proposed_by: p.by?.actor,
      proposed_at: p.createdAt,
      decided_by: p.decision?.by,
      decided_at: p.decision?.at,
      reason: preview(p.decision?.reason),
      error_message: p.status === "failed" ? preview(p.result?.error) : undefined,
      log_ref: p.id,
      unique_source_id: `strutproposal:${p.id}`,
    }),
  };
}

/** The refs this graph holds as nodes. A ref may point at another
 *  database or a since-deleted node, and the edge writer refuses a missing
 *  end. Neo4j's `:Data_Bank` is every data node; on a file, any node but a
 *  Schema row (`ladybug/registry.ts` SCHEMA_TYPE, not imported: it would
 *  load the driver), in any namespace. */
async function heldNodes(backend: GraphBackend, ids: string[]): Promise<Set<string>> {
  const want = [...new Set(ids)];
  if (!want.length) return new Set();
  if (backend.kind === "neo4j") {
    const rows = await backend.query(`MATCH (n:Data_Bank) WHERE n.ref_id IN $ids RETURN DISTINCT n.ref_id AS ref_id`, { ids: want });
    return new Set(rows.map((r) => r["ref_id"] as string));
  }
  const held = await backend.tx((tx) => backend.edgeEngine.endpoints(tx, want));
  return new Set(
    want.filter((id) => {
      const type = held.get(id)?.type;
      return !!type && type !== "Schema";
    }),
  );
}

/** The `StrutRun` the graph holds for a run, with its status; null when the
 *  run is not projected (yet). Never projects. */
async function heldRun(backend: GraphBackend, workflow: string, runId: string): Promise<{ ref: string; status: unknown } | null> {
  // Lazy: the writer loads the driver, and this module is imported by hosts
  // that have no graph.
  const { composeNodeKey } = await import("./node-writer.js");
  const rows = await backend.query(
    `MATCH ${backend.dialect.node("r", "StrutRun", { key: "$key", namespace: "$ns" })} WHERE r.workflow_name = $wf RETURN r.ref_id AS ref_id, r.run_status AS status`,
    { key: composeNodeKey(getStrutSchema("StrutRun")!, { run_id: runId }), ns: backend.namespace, wf: workflow },
  );
  const row = rows[0];
  return row && typeof row["ref_id"] === "string" ? { ref: row["ref_id"], status: row["status"] } : null;
}

/** One proposal's node, `IN_RUN` its run when the graph holds it, and
 *  `ACCESSED` to each node its apply wrote (`result.nodes`, what the step
 *  reported) that the graph holds; a peer's ref is skipped outright. Every
 *  write is an upsert or an add-only edge, so writing it again moves the
 *  node to its record's state and adds nothing twice. */
async function projectProposal(backend: GraphBackend, proposals: ProposalReader, id: string): Promise<ProjectReport> {
  const report = emptyReport();
  const p = await proposals.get(id);
  if (!p || !(await holds(backend, "StrutProposal"))) return report;
  const [node] = await backend.nodes.writeMany(await fit(backend, [proposalNode(p)]), "upsert");
  const ref = node!.ref_id;
  report.proposals++;
  const edges: EdgeInput[] = [];
  const run = p.by?.workflow && p.by.runId ? await heldRun(backend, p.by.workflow, p.by.runId) : null;
  if (run) edges.push({ edge: "IN_RUN", source_ref_id: ref, target_ref_id: run.ref });
  const wrote = (p.result?.nodes ?? []).flatMap((n) => {
    const a = n as AccessedNode | null;
    return a && typeof a.ref_id === "string" && !a.peer ? [a.ref_id] : [];
  });
  const held = await heldNodes(backend, wrote);
  for (const target of new Set(wrote)) {
    if (held.has(target)) {
      edges.push({ edge: "ACCESSED", source_ref_id: ref, target_ref_id: target });
      report.accessed++;
    } else report.unresolved++;
  }
  if (edges.length) {
    await backend.edges.writeMany(edges);
    report.edges += edges.length;
  }
  return report;
}

const proposalProjections = new WeakMap<GraphBackend, Map<string, { tail: Promise<ProjectReport>; queued?: Promise<ProjectReport> }>>();

/**
 * `projectProposal`, one at a time per proposal: a call while it is being
 * projected queues ONE more, which every later call joins and which reads
 * the record when it starts — so the last change (a decision, then its
 * apply) is in the graph after it. What createStrut calls at each change,
 * and the run's projection for each proposal the run made.
 */
export function projectProposalOnce(backend: GraphBackend, proposals: ProposalReader, id: string): Promise<ProjectReport> {
  let all = proposalProjections.get(backend);
  if (!all) proposalProjections.set(backend, (all = new Map()));
  const inFlight = all;
  const slot = inFlight.get(id);
  if (slot?.queued) return slot.queued;
  const next: Promise<ProjectReport> = (slot?.tail ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      if (entry.queued === next) delete entry.queued;
      return projectProposal(backend, proposals, id);
    });
  const entry: { tail: Promise<ProjectReport>; queued?: Promise<ProjectReport> } = { tail: next, queued: next };
  inFlight.set(id, entry);
  void next.catch(() => undefined).finally(() => inFlight.get(id) === entry && inFlight.delete(id));
  return next;
}

/** Project runs from a `RunStore` into the graph. */
export async function projectRuns(backend: GraphBackend, store: RunStore, opts: ProjectRunsOptions): Promise<ProjectReport> {
  const report = emptyReport();
  const { namespace: ns, dialect: d } = backend;
  for (const workflow of opts.workflows) {
    let runIds = await store.listRuns(workflow);
    if (opts.limitPerWorkflow != null) runIds = runIds.slice(0, opts.limitPerWorkflow);
    if (runIds.length === 0) continue;

    // Settled runs already in the graph don't need re-reading.
    let settled = new Set<string>();
    if (opts.skipSettled !== false) {
      const rows = await backend.query(
        `MATCH ${d.node("r", "StrutRun", { namespace: "$ns", workflow_name: "$wf" })} WHERE r.run_id IN $ids RETURN r.run_id AS id, r.run_status AS status`,
        { ns, wf: workflow, ids: runIds },
      );
      settled = new Set(rows.filter((r) => isTerminalStatus(r["status"])).map((r) => r["id"] as string));
    }

    for (const runId of runIds) {
      if (settled.has(runId)) {
        report.skipped++;
        continue;
      }
      await projectRun(backend, store, workflow, runId, report, opts.jobs, opts.conversations, opts.proposals);
    }
  }
  return report;
}

/**
 * Project ONE run and return its `StrutRun` ref_id (null for an unknown
 * run). `workflow` is the run-store key: a workflow name, or `step:<type>`
 * for a kept single-step run — which gets `EXECUTED → StrutStepVersion`
 * from `run.start.stepHashes` instead of the workflow-version edge. The
 * verify pass projects the run it is about to attach evidence to
 * (plans/claims.md §3) — the only way a STEP run reaches the graph: one that
 * produced no evidence never does, and `projectRuns` never lists them.
 */
export async function projectRun(
  backend: GraphBackend,
  store: RunStore,
  workflow: string,
  runId: string,
  report: ProjectReport = emptyReport(),
  jobs?: JobReader,
  conversations?: ConversationReader,
  proposals?: ProposalReader,
): Promise<string | null> {
  const { namespace: ns, dialect: d } = backend;
  const [events, summary] = await Promise.all([store.getRunEvents(workflow, runId), store.getRunSummary(workflow, runId)]);
  const p = projectRunEvents(workflow, runId, events, summary);
  if (!p) return null;

  // A file that holds no agent sessions (and so no tool calls) gets the run alone.
  if (!(await holds(backend, "StrutAgentSession"))) {
    p.sessions = [];
    p.toolCalls = [];
  }
  const nodes = await fit(backend, [p.run, ...p.sessions, ...p.toolCalls.map((t) => t.node)]);
  const written = await backend.nodes.writeMany(nodes, "upsert");
  const runRef = written[0]!.ref_id;
  const sessionRef = new Map<string, string>();
  p.sessions.forEach((s, i) => sessionRef.set(String(s.data["path"]).replace(/#\d+$/, ""), written[1 + i]!.ref_id));
  report.runs++;
  report.sessions += p.sessions.length;
  report.toolCalls += p.toolCalls.length;

  const edges: EdgeInput[] = [];
  p.sessions.forEach((s) => {
    const ref = sessionRef.get(String(s.data["path"]).replace(/#\d+$/, ""))!;
    edges.push({ edge: "IN_RUN", source_ref_id: ref, target_ref_id: runRef });
  });
  const toolRef = (i: number) => written[1 + p.sessions.length + i]!.ref_id;
  p.toolCalls.forEach((t, i) => {
    edges.push({ edge: "IN_SESSION", source_ref_id: toolRef(i), target_ref_id: sessionRef.get(t.sessionPath)! });
  });
  // ACCESSED: only toward nodes this graph actually holds (the edge
  // writer treats a missing endpoint as an error, and a ref may point
  // at another database or a since-deleted node). Neo4j's `:Data_Bank` is
  // every data node; tool calls exist nowhere else.
  const wanted = new Set(p.toolCalls.flatMap((t) => t.accessed.map((n) => n.ref_id)));
  if (wanted.size && backend.kind === "neo4j") {
    const present = await heldNodes(backend, [...wanted]);
    p.toolCalls.forEach((t, i) => {
      for (const n of t.accessed) {
        if (present.has(n.ref_id)) {
          edges.push({ edge: "ACCESSED", source_ref_id: toolRef(i), target_ref_id: n.ref_id });
          report.accessed++;
        } else report.unresolved++;
      }
    });
  } else if (p.accessed.length && backend.kind !== "neo4j") {
    // A file: the run → each node it read that the file holds.
    const held = await heldNodes(backend, p.accessed.map((n) => n.ref_id));
    for (const n of p.accessed) {
      if (held.has(n.ref_id)) {
        edges.push({ edge: "ACCESSED", source_ref_id: runRef, target_ref_id: n.ref_id });
        report.accessed++;
      } else report.unresolved++;
    }
  }
  const stepType = stepTypeOfRunKey(workflow);
  const stepHash = stepType ? p.stepHashes?.[stepType] : undefined;
  if (stepType && stepHash) {
    const rows = await backend.query(
      `MATCH ${d.node("v", "StrutStepVersion", { namespace: "$ns", step_type: "$type", content_hash: "$h" })} RETURN v.ref_id AS ref_id LIMIT 1`,
      { ns, type: stepType, h: stepHash },
    );
    if (rows.length) edges.push({ edge: "EXECUTED", source_ref_id: runRef, target_ref_id: rows[0]!["ref_id"] as string });
  } else if (p.workflowHash) {
    const rows = await backend.query(
      `MATCH ${d.node("v", "StrutWorkflowVersion", { namespace: "$ns", name: "$wf", content_hash: "$h" })} RETURN v.ref_id AS ref_id LIMIT 1`,
      { ns, wf: workflow, h: p.workflowHash },
    );
    if (rows.length) edges.push({ edge: "EXECUTED", source_ref_id: runRef, target_ref_id: rows[0]!["ref_id"] as string });
  }
  // The job (plans/job-index.md §6): one `StrutJob` per job, upserted from
  // the index on every run of it — as fresh as the job's last finished run
  // — and `IN_JOB` from this run. No index, or no record (the job was
  // deleted): nothing written, and the node the graph holds stays.
  if (p.job) {
    const up = await upsertJob(backend, jobs, p.job);
    if (up) {
      edges.push({ edge: "IN_JOB", source_ref_id: runRef, target_ref_id: up.jobRef });
      report.jobs++;
      // DELIVERED from this run to each artifact its output declares, read
      // as the fold reads a turn (a top-level, successful run), so
      // projecting any run of the job — in any order — writes its own.
      const line = up.runs.find((r) => r.runId === runId);
      if (line && !line.parentRunId && !line.sealed && summary?.status === "success") {
        for (const id of declaredArtifactIds(summary.output)) {
          const ref = up.artifacts.get(id);
          if (ref) edges.push({ edge: "DELIVERED", source_ref_id: runRef, target_ref_id: ref });
        }
      }
    }
  }
  // The conversation (plans/jamie-app.md §2): each agent session that is a
  // turn of one is `IN_CHAT` its `StrutChat`, upserted from the index's
  // record — as fresh as the turn that just ended. A thread that is no
  // conversation (a job's) has no record: nothing written. Best effort, like
  // a job's artifacts: a failure never costs the run's projection.
  if (conversations && p.sessions.length && (await holds(backend, "StrutChat"))) {
    const threads = new Map<string, string[]>();
    p.sessions.forEach((s, i) => {
      const id = s.data["session_id"];
      if (typeof id === "string") threads.set(id, [...(threads.get(id) ?? []), written[1 + i]!.ref_id]);
    });
    for (const [id, refs] of threads) {
      try {
        const rec = await conversations.record(id);
        if (!rec) continue;
        const [chat] = await backend.nodes.writeMany(await fit(backend, [conversationNode(rec)]), "upsert");
        for (const ref of refs) edges.push({ edge: "IN_CHAT", source_ref_id: ref, target_ref_id: chat!.ref_id });
        report.chats++;
      } catch (e) {
        console.warn(`[projector] conversation ${id}: not written: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (edges.length) {
    await backend.edges.writeMany(edges);
    report.edges += edges.length;
  }
  // The proposals the run made (plans/proposals.md §2), after the run's own
  // node, so each is `IN_RUN` it. Through the per-proposal queue, so a
  // decision landing now never writes beside this. Best effort, like a
  // conversation: a failure never costs the run's projection.
  if (proposals) {
    try {
      for (const q of (await proposals.list({ runId })).filter((q) => q.by?.workflow === workflow)) {
        const r = await projectProposalOnce(backend, proposals, q.id);
        report.proposals += r.proposals;
        report.edges += r.edges;
        report.accessed += r.accessed;
        report.unresolved += r.unresolved;
      }
    } catch (e) {
      console.warn(`[projector] run ${workflow}/${runId}: proposals not written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // WHO SENT the turn — optional, and never allowed to fail the projection.
  if (p.speaker && sessionRef.has(p.speaker.sessionPath)) {
    try {
      report.edges += await writeSpeakerEdges(backend, p.speaker.userId, sessionRef.get(p.speaker.sessionPath)!);
    } catch {
      // The graph has no member type / no SENT edge schema yet: nothing written.
    }
  }
  return runRef;
}

/**
 * `SENT`: the speaker's EXISTING `HiveWorkspaceMember` (matched on `user_id`;
 * one per workspace they belong to, each its own node) → the turn's
 * `StrutAgentSession`. Nothing is ever created: no member, no edge. The edge
 * writer keeps one edge per (source, type, target), so projecting a run again
 * adds none.
 *
 * ONTOLOGY LIMIT: `SENT` is jarvis's (Person→Message/Email). Strut declares
 * and seeds `HiveWorkspaceMember/Person -SENT-> StrutAgentSession`
 * (`STRUT_EDGES`) wherever the source type exists; against a jarvis graph
 * whose ontology lacks that edge schema (and that strut did not seed) the
 * write is refused and swallowed — the schema then has to come from
 * jarvis-backend or a graph proposal. No `Person` fallback: `Person` has no
 * github-handle or user-id field to match on exactly.
 */
async function writeSpeakerEdges(backend: GraphBackend, userId: string, sessionRef: string): Promise<number> {
  if (!(await holds(backend, "HiveWorkspaceMember"))) return 0;
  const { namespace: ns, dialect: d } = backend;
  const rows = await backend.query(
    `MATCH ${d.node("m", "HiveWorkspaceMember", { namespace: "$ns", user_id: "$uid" })} WHERE ${d.live("m")} RETURN DISTINCT m.ref_id AS ref_id`,
    { ns, uid: userId },
  );
  const refs = [...new Set(rows.map((r) => r["ref_id"]).filter((r): r is string => typeof r === "string" && r !== ""))];
  if (!refs.length) return 0;
  await backend.edges.writeMany(refs.map((ref) => ({ edge: "SENT", source_ref_id: ref, target_ref_id: sessionRef })));
  return refs.length;
}

/** One run that read a node (`runsThatRead`). */
export interface NodeRead {
  run_ref_id: string;
  run_id: string;
  workflow_name: string;
  run_status?: string;
}

/**
 * Which runs read this node, newest first: how a Concept's use is read. On
 * a Ladybug file, the run's own `ACCESSED` edge; on Neo4j, a tool call's,
 * up through its session to the run. `namespaces` are the reader's (default
 * the backend's own): a run is returned only when the run, the edge (on a
 * file) and the node are all in them.
 */
export async function runsThatRead(backend: GraphBackend, refId: string, opts: { namespaces?: string[]; limit?: number } = {}): Promise<NodeRead[]> {
  const d = backend.dialect;
  const params = { ref: refId, ns: opts.namespaces ?? [backend.namespace] };
  const limit = Math.max(1, Math.floor(opts.limit ?? 50));
  const ret = `RETURN DISTINCT r.ref_id AS run_ref_id, r.run_id AS run_id, r.workflow_name AS workflow_name, r.run_status AS run_status, r.started_at AS started_at ORDER BY started_at DESC LIMIT ${limit}`;
  const rows =
    backend.kind === "neo4j"
      ? await backend.query(
          `MATCH (r:StrutRun)<-[:IN_RUN]-(:StrutAgentSession)<-[:IN_SESSION]-(:StrutToolCall)-[:ACCESSED]->(n:Data_Bank {ref_id: $ref}) WHERE r.namespace IN $ns AND n.namespace IN $ns AND ${d.live("r")} ${ret}`,
          params,
        )
      : await backend.query(
          `MATCH ${d.node("r", "StrutRun")}-[e:ACCESSED]->(n:Node {ref_id: $ref}) WHERE r.namespace IN $ns AND e.namespace IN $ns AND n.namespace IN $ns AND ${d.live("r")} ${ret}`,
          params,
        );
  return rows.map((r) => ({
    run_ref_id: r["run_ref_id"] as string,
    run_id: r["run_id"] as string,
    workflow_name: r["workflow_name"] as string,
    ...(typeof r["run_status"] === "string" ? { run_status: r["run_status"] } : {}),
  }));
}

const projecting = new WeakMap<GraphBackend, Map<string, Promise<string | null>>>();

/**
 * `projectRun`, one at a time per run: a caller that arrives while the run
 * is being projected joins that projection, so the same nodes are never
 * written side by side. What the run-end hook calls (`createStrut` projects
 * every top-level run); the verify pass goes through `runRef`.
 */
export function projectRunOnce(
  backend: GraphBackend,
  store: RunStore,
  workflow: string,
  runId: string,
  jobs?: JobReader,
  conversations?: ConversationReader,
  proposals?: ProposalReader,
): Promise<string | null> {
  let runs = projecting.get(backend);
  if (!runs) projecting.set(backend, (runs = new Map()));
  const inFlight = runs;
  const key = `${workflow}/${runId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = projectRun(backend, store, workflow, runId, emptyReport(), jobs, conversations, proposals).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * The `StrutRun` of a run that has ended, for a caller that needs the NODE
 * and not a fresh projection — the verify pass, whose evidence points at it.
 * The projection in flight when there is one; else the node the graph
 * already holds in a settled state (every top-level run is projected when it
 * ends); else a projection — a kept step run's first, or an older run's.
 */
export async function runRef(backend: GraphBackend, store: RunStore, workflow: string, runId: string): Promise<string | null> {
  const running = projecting.get(backend)?.get(`${workflow}/${runId}`);
  if (running) return running;
  const held = await heldRun(backend, workflow, runId);
  if (held && isTerminalStatus(held.status)) return held.ref;
  return projectRunOnce(backend, store, workflow, runId);
}

/** Resolves once nothing started through `projectRunOnce`,
 *  `projectChatOnce` or `projectProposalOnce` is in flight — for a caller
 *  about to pull the graph from under it (a test's wipe). */
export async function projectionsSettled(backend: GraphBackend): Promise<void> {
  const runs = projecting.get(backend);
  const chats = chatProjections.get(backend);
  const props = proposalProjections.get(backend);
  while (runs?.size || chats?.size || props?.size)
    await Promise.allSettled([...(runs?.values() ?? []), ...[...(chats?.values() ?? [])].map((c) => c.tail), ...[...(props?.values() ?? [])].map((c) => c.tail)]);
}

/** Resolves once the projections in flight of these runs have — a chat
 *  links only the runs the graph holds, and a run it launched is projected
 *  when it ends, as the turn goes on. */
async function runProjectionsSettled(backend: GraphBackend, runIds: string[]): Promise<void> {
  const runs = projecting.get(backend);
  if (!runs?.size || !runIds.length) return;
  const ids = new Set(runIds);
  await Promise.allSettled([...runs].filter(([key]) => ids.has(key.slice(key.lastIndexOf("/") + 1))).map(([, p]) => p));
}

// ── Chats ─────────────────────────────────────────────────────────────────

/** Plain text of a stored message's content (string, or AI-SDK parts). */
export function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Text parts only: a reasoning part carries `text` too, and the model's
    // thinking is not what it said.
    const texts = content
      .map((p) => {
        const part = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
        return (part["type"] === undefined || part["type"] === "text") && typeof part["text"] === "string" ? part["text"] : "";
      })
      .filter(Boolean);
    return texts.length ? texts.join("\n") : undefined;
  }
  return undefined;
}

/** Run ids launched from this transcript: every `run_workflow` tool result
 *  carrying a `runId` (deep search — the tool-result envelope shape varies
 *  by SDK version). */
export function spawnedRunIds(messages: StoredMessage[]): string[] {
  const ids = new Set<string>();
  const findRunId = (v: unknown, depth = 0): string | undefined => {
    if (!v || typeof v !== "object" || depth > 8) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o["runId"] === "string") return o["runId"];
    for (const x of Object.values(o)) {
      const r = findRunId(x, depth + 1);
      if (r) return r;
    }
    return undefined;
  };
  const walk = (v: unknown, depth = 0): void => {
    if (!v || typeof v !== "object" || depth > 8) return;
    const o = v as Record<string, unknown>;
    if (o["toolName"] === "run_workflow") {
      const id = findRunId(o);
      if (id) ids.add(id);
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const m of messages) if (m.role === "tool" || m.role === "assistant") walk(m.content);
  return [...ids];
}

/** Project every chat (and its turns) from a `ChatStore` into the graph.
 *  Nothing on a backend that holds no chats (a Ladybug file). */
export async function projectChats(backend: GraphBackend, chatStore: ChatStore): Promise<ProjectReport> {
  const report = emptyReport();
  if (!(await holds(backend, "StrutChat"))) return report;
  for (const meta of await chatStore.listChats()) await writeChat(backend, chatStore, meta, report);
  return report;
}

/** Project ONE chat and its turns. Nothing on a backend that holds no chats,
 *  or for a chat the store does not have. */
export async function projectChat(backend: GraphBackend, chatStore: ChatStore, chatId: string): Promise<ProjectReport> {
  const report = emptyReport();
  if (!(await holds(backend, "StrutChat"))) return report;
  const meta = await chatStore.getMeta(chatId);
  if (meta) await writeChat(backend, chatStore, meta, report);
  return report;
}

const chatProjections = new WeakMap<GraphBackend, Map<string, { tail: Promise<ProjectReport>; queued?: Promise<ProjectReport> }>>();

/**
 * `projectChat`, one at a time per chat: a call while the chat is being
 * projected queues ONE more projection, which every later call joins, so
 * what changed during a projection is in the graph after the next. What
 * createStrut calls at the end of every chat turn.
 */
export function projectChatOnce(backend: GraphBackend, chatStore: ChatStore, chatId: string): Promise<ProjectReport> {
  let chats = chatProjections.get(backend);
  if (!chats) chatProjections.set(backend, (chats = new Map()));
  const inFlight = chats;
  const slot = inFlight.get(chatId);
  if (slot?.queued) return slot.queued;
  const next: Promise<ProjectReport> = (slot?.tail ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      if (entry.queued === next) delete entry.queued;
      return projectChat(backend, chatStore, chatId);
    });
  const entry: { tail: Promise<ProjectReport>; queued?: Promise<ProjectReport> } = { tail: next, queued: next };
  inFlight.set(chatId, entry);
  void next.catch(() => undefined).finally(() => inFlight.get(chatId) === entry && inFlight.delete(chatId));
  return next;
}

async function writeChat(backend: GraphBackend, chatStore: ChatStore, meta: ChatMeta, report: ProjectReport): Promise<void> {
  const { namespace: ns, dialect: d } = backend;
  const messages = await chatStore.loadMessages(meta.id);
  const turns: NodeInput[] = [];
  let turn = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    turn++;
    // The reply is every assistant text up to the next user message: a turn
    // narrates across its steps, and the person reads all of it.
    const next = messages.findIndex((x, j) => j > i && x.role === "user");
    const said = messageText(m.content);
    const answered =
      messages
        .slice(i + 1, next < 0 ? undefined : next)
        .filter((x) => x.role === "assistant")
        .map((x) => messageText(x.content))
        .filter(Boolean)
        .join("\n\n") || undefined;
    turns.push({
      type: "StrutTurn",
      data: compact({
        chat_id: meta.id,
        turn,
        user_text_preview: preview(said),
        assistant_text_preview: preview(answered),
        user_text: wholeText(said),
        assistant_text: wholeText(answered),
        log_ref: `${meta.id}/${turn}`,
        unique_source_id: `strutturn:${meta.id}:${turn}`,
      }),
    });
  }
  const chat: NodeInput = {
    type: "StrutChat",
    data: compact({
      chat_id: meta.id,
      kind: "builder",
      title: meta.title,
      summary: preview(turns[0] ? (turns[0].data["user_text_preview"] as string) : undefined),
      status: meta.status,
      model: meta.model,
      started_at: meta.createdAt,
      last_active_at: meta.updatedAt,
      turn_count: turns.length,
      log_ref: meta.id,
      unique_source_id: `strutchat:${meta.id}`,
    }),
    ...(meta.createdBy ? { created_by: meta.createdBy } : {}),
  };
  const written = await backend.nodes.writeMany([chat, ...turns], "upsert");
  const chatRef = written[0]!.ref_id;
  report.chats++;
  report.turns += turns.length;

  const edges: EdgeInput[] = turns.map((_, i) => ({ edge: "IN_CHAT", source_ref_id: written[1 + i]!.ref_id, target_ref_id: chatRef }));
  const runIds = spawnedRunIds(messages);
  if (runIds.length) {
    await runProjectionsSettled(backend, runIds);
    const rows = await backend.query(
      `MATCH ${d.node("r", "StrutRun", { namespace: "$ns" })} WHERE r.run_id IN $ids RETURN r.ref_id AS ref_id`,
      { ns, ids: runIds },
    );
    for (const r of rows) edges.push({ edge: "SPAWNED", source_ref_id: chatRef, target_ref_id: r["ref_id"] as string });
  }
  if (edges.length) {
    await backend.edges.writeMany(edges);
    report.edges += edges.length;
  }
}

/** Runs first (so chats can link to them), then chats. */
export async function projectAll(
  backend: GraphBackend,
  src: { store: RunStore; chatStore?: ChatStore; workflows: string[]; jobs?: JobReader; conversations?: ConversationReader; proposals?: ProposalReader },
  opts: Omit<ProjectRunsOptions, "workflows" | "jobs" | "conversations" | "proposals"> = {},
): Promise<ProjectReport> {
  const a = await projectRuns(backend, src.store, { ...opts, workflows: src.workflows, jobs: src.jobs, conversations: src.conversations, proposals: src.proposals });
  const b = src.chatStore ? await projectChats(backend, src.chatStore) : emptyReport();
  return {
    runs: a.runs + b.runs,
    sessions: a.sessions + b.sessions,
    toolCalls: a.toolCalls + b.toolCalls,
    chats: a.chats + b.chats,
    turns: a.turns + b.turns,
    edges: a.edges + b.edges,
    accessed: a.accessed + b.accessed,
    unresolved: a.unresolved + b.unresolved,
    skipped: a.skipped + b.skipped,
    jobs: a.jobs + b.jobs,
    proposals: a.proposals + b.proposals,
  };
}
