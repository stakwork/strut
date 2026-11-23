import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { accessedNodesOf, type ProposalDescription, takeUsage, workflowOf, type AnyStepDef, type McpServer, type StepContext, type StepRegistry } from "./core.js";
import { withLock } from "./jobs.js";
import { globToRegExp } from "./closure.js";
import { reachPolicyOf, withinReach } from "./reach.js";
import type { JobUpdateInput } from "./jobs.js";
import { bindGraph } from "./graph-writes.js";
import { bindBranch, type BranchesCapability } from "./branches.js";
import type { Scope } from "./auth.js";
import { buildCard, type ProposalCard } from "./proposal-card.js";

/**
 * Proposals (plans/proposals.md): a tool call a person approves before it
 * runs. An `agent` step names registry steps in `approve:` beside
 * `agentTools`; a call to one of those does not run the step — it is
 * RECORDED here (the step type, the parsed input, the model's rationale, who
 * proposed it), journaled so a resumed turn finds it, and the model gets
 * `pending` back and goes on. A person decides at `POST
 * /proposals/:id/decide`: on accept strut runs the step then and there with
 * the recorded input (the person's edits merged, re-parsed by the step's
 * own schema) under a minimal context — `releaseWith`'s shape (jobs.ts) —
 * and records the result; on reject it records the reason. Never a model
 * turn. The proposing session is told on its next turn, in code
 * (`[proposal-result]` lines before the prompt).
 *
 * Nothing here knows what is proposed: the step is the contract, its schema
 * the validation, its `run` the apply. There are no proposal types.
 *
 * The record lives at `<dataDir>/proposals/<id>.json`, like a job's; an
 * index is a readdir. On a graph workspace each record is also PROJECTED,
 * a `StrutProposal` node (graph/projector.ts `projectProposalOnce`, told
 * through `changed`): the record stays what every list here reads.
 */

export type ProposalStatus = "pending" | "accepted" | "rejected" | "applied" | "failed";
export type ProposalAction = "accept" | "reject";

export interface Proposal {
  id: string;
  /** The registry step type, bare: the active version applies. */
  step: string;
  /** As parsed by the step's schema at proposal time. */
  input: unknown;
  /** The model's, for the person. */
  rationale?: string;
  /** For the card: the step description's first sentence, or what the
   *  step's `describe` gave (plans/proposals.md §7). */
  title: string;
  /** What the step read at proposal time for the card (`describe`): for
   *  `package/install`, the index's page of the package — what it brings,
   *  what it can reach, what it needs. */
  summary?: string;
  /** What the person decides on, as data (src/proposal-card.ts), computed
   *  once at proposal time. Records from before it have none. */
  card?: ProposalCard;
  /** Who may accept it, copied from the step at proposal time
   *  (`StepDef.approver`): `admin` — only an admin of this strut server, so
   *  a host draws "an admin must approve this" in place of Accept for
   *  anyone else. Absent: whoever may decide it. */
  approver?: "admin";
  status: ProposalStatus;
  createdAt: string;
  /** Who proposed it. `conversation` is the thread the work belongs to,
   *  which decides where the proposal shows (`visibleTo`): the session the
   *  root run's launch named, or, for a job's run, the session of the turn
   *  that started it (`startedBy`). Records from before it have none. */
  by: { workflow: string; runId: string; path: string; job?: string; session?: string; conversation?: string; actor?: string; principal?: string; branch?: string };
  decision?: { action: ProposalAction; by?: string; at: string; input?: unknown; reason?: string };
  result?: { output?: unknown; error?: string; cost?: number; nodes?: unknown[]; at: string };
  /** When the proposing session was told of the decision (§5). */
  reportedAt?: string;
  /** The waiting proposal this one replaced (`ProposalDescription.replaces`). */
  replaces?: string;
  /** The newer proposal that replaced this one while it waited: strut
   *  rejected it then, so a host may leave it out of the thread. */
  replacedBy?: string;
}

/** The slim form a host reads: `run.end { proposals }`, the steps' results. */
export interface ProposalBrief {
  id: string;
  step: string;
  title: string;
  summary?: string;
  card?: ProposalCard;
  approver?: "admin";
  status: ProposalStatus;
  url: string;
  rationale?: string;
  createdAt: string;
  decidedAt?: string;
  /** Replaced by a newer proposal while it waited: a host may leave it out. */
  replacedBy?: string;
}

export type NewProposal = Pick<Proposal, "step" | "input" | "rationale" | "title" | "summary" | "card" | "approver" | "by" | "replaces">;

export interface ProposalFilter {
  /** One job's, or any of several (the jobs a conversation page's turns started). */
  job?: string | string[];
  session?: string;
  /** The thread it shows in: its `by.conversation`, else its `by.session`. */
  thread?: string;
  /** Only proposals of this step type. */
  step?: string;
  /** Only those a run of this workflow made (`by.workflow`): the dream's, for the Knowledge app. */
  workflow?: string;
  /** One run's, or any of several (a conversation page's turns). */
  runId?: string | string[];
  status?: ProposalStatus | ProposalStatus[];
  /** Whether the proposing session has been told of it (`reportedAt`). */
  reported?: boolean;
  /** Only what this request may see in a list (`visibleTo`), applied on
   *  the index before `limit` and before any file is read. `admin`: strut's
   *  own page's viewer is an admin here, so they also see what no
   *  conversation made (`pageSees`). */
  viewer?: { scope: Scope; actor?: string; admin?: boolean };
  /** At most this many, newest first. Every match by default: a caller
   *  without a narrow filter (a job, a run, a thread) passes one, since
   *  each proposal returned is a file read. */
  limit?: number;
}

export const PROPOSAL_RESULT_PREFIX = "[proposal-result]";
/** `GET /proposals` with no `limit`: the newest this many. */
export const PROPOSAL_LIST_DEFAULT = 200;
const DECIDED: ReadonlySet<ProposalStatus> = new Set(["rejected", "applied", "failed"]);

export function proposalsRoot(dataDir: string): string {
  return join(dataDir, "proposals");
}

export function proposalUrl(id: string): string {
  return `/proposals/${encodeURIComponent(id)}`;
}

/** What a request may see: `full` everything; a person token, in a list,
 *  the proposals made in its OWN threads — its actor's, in a conversation
 *  that person's credential holds (`<actor>`, `<actor>/…`: what the
 *  person's own strut opens here) — and ANY proposal by id (`byId`, `GET
 *  /proposals/:id`); a plain peer none. A proposal shows where it was made:
 *  one from the same person's chat on the host's key (a Hive conversation)
 *  is answered there, never listed to their device. By id because a person
 *  token already reads every run's log here — a gated call's `step.start`
 *  carries its input, its `step.end` the proposal's id — and every job's
 *  files by id; the id is 72 random bits and the lists stay own-only, so "by
 *  id" means someone showed it to you, as with a job. Deciding stays the
 *  proposer's (`decideProposal`). */
export function visibleTo(scope: Scope, actor: string | undefined, p: Pick<Proposal, "by">, opts: { byId?: boolean } = {}): boolean {
  if (scope === "full") return true;
  if (scope !== "peer:person") return false;
  if (opts.byId) return true;
  const thread = p.by.conversation ?? p.by.session;
  return !!actor && p.by.actor === actor && !!thread && (thread === actor || thread.startsWith(`${actor}/`));
}

/** What strut's OWN page shows and lets its viewer decide (`proposal/list`,
 *  `proposal/decide`, a first-party page's own call): their own, as their
 *  person token sees them (`visibleTo`), and, when the viewer is an ADMIN
 *  here, a proposal made in NO conversation — an automation's, such as the
 *  dream's changes to the Concept tree. One of those belongs to no thread, so
 *  it shows where the people who run this strut keep what it changes; an
 *  admin's session already lists and decides it at `/proposals`. A member
 *  sees what they did before. */
export function pageSees(p: Pick<Proposal, "by">, viewer: { actor?: string; admin?: boolean }): boolean {
  return seesInList({ scope: "peer:person", ...viewer }, p);
}

/** A list's viewer check (`ProposalFilter.viewer`): `visibleTo`, and for an
 *  admin on strut's own page what no conversation made. */
function seesInList(viewer: NonNullable<ProposalFilter["viewer"]>, p: Pick<Proposal, "by">): boolean {
  return visibleTo(viewer.scope, viewer.actor, p) || (viewer.admin === true && !threadOf(p));
}

/** The thread a proposal shows in (`visibleTo`): its conversation, else its session. */
const threadOf = (p: Pick<Proposal, "by">) => p.by.conversation ?? p.by.session;

export function briefOf(p: Proposal): ProposalBrief {
  return {
    id: p.id,
    step: p.step,
    title: p.title,
    ...(p.summary ? { summary: p.summary } : {}),
    ...(p.card ? { card: p.card } : {}),
    ...(p.approver ? { approver: p.approver } : {}),
    status: p.status,
    url: proposalUrl(p.id),
    ...(p.rationale ? { rationale: p.rationale } : {}),
    createdAt: p.createdAt,
    ...(p.decision ? { decidedAt: p.decision.at } : {}),
    ...(p.replacedBy ? { replacedBy: p.replacedBy } : {}),
  };
}

/** The job's live event for a proposal (plans/live-artifacts.md): the kind
 *  names the card, the url its record. */
export function proposalUpdate(p: Proposal): JobUpdateInput {
  return {
    kind: "proposal",
    id: p.id,
    url: proposalUrl(p.id),
    title: p.title,
    state: p.status,
    runId: p.by.runId,
    detail: { step: p.step, ...(p.result?.error ? { error: p.result.error } : {}) },
  };
}

// ── the record ─────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const ARCHIVE = "archive";
const READ_CONCURRENCY = 16;

async function readFileProposal(file: string): Promise<Proposal | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as Proposal;
  } catch {
    return null;
  }
}

/** The live file, else the archive's (a decided proposal is moved there);
 *  the archive's first when the caller knows it is `decided`. */
export async function readProposal(root: string, id: string, decided = false): Promise<Proposal | null> {
  if (!ID_RE.test(id)) return null;
  const files = [join(root, `${id}.json`), join(root, ARCHIVE, `${id}.json`)];
  if (decided) files.reverse();
  return (await readFileProposal(files[0]!)) ?? (await readFileProposal(files[1]!));
}

/** Run `fn` over `items`, at most `READ_CONCURRENCY` at a time, in order. */
async function mapLimited<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  return out;
}

// ── the index: what a list filters on, in memory, loaded once per root ─────

/** What a list filters on: the record less its payloads (`input`, `card`,
 *  `summary`, `result`). `by` whole, so `visibleTo` runs on the index. */
interface IndexEntry {
  id: string;
  step: string;
  status: ProposalStatus;
  createdAt: string;
  by: Proposal["by"];
  reportedAt?: string;
}
interface RootIndex {
  entries: Map<string, IndexEntry>;
  loaded?: Promise<void>;
}

const indexes = new Map<string, RootIndex>();
const inflight = new Map<string, Promise<Proposal[]>>();

const entryOf = (p: Proposal): IndexEntry => ({
  id: p.id,
  step: p.step,
  status: p.status,
  createdAt: p.createdAt,
  by: p.by ?? ({} as Proposal["by"]),
  ...(p.reportedAt ? { reportedAt: p.reportedAt } : {}),
});

function indexOf(root: string): RootIndex {
  let ix = indexes.get(root);
  if (!ix) indexes.set(root, (ix = { entries: new Map() }));
  return ix;
}

/** Single-flight: the first caller reads every file (live first, then the
 *  archive; corrupt ones skipped); a write that landed meanwhile wins. */
function loadIndex(root: string): Promise<void> {
  const ix = indexOf(root);
  return (ix.loaded ??= (async () => {
    for (const dir of [root, join(root, ARCHIVE)]) {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
      } catch {
        continue;
      }
      await mapLimited(names, async (n) => {
        const id = n.slice(0, -".json".length);
        if (ix.entries.has(id)) return;
        const p = await readFileProposal(join(dir, n));
        if (p && typeof p.createdAt === "string" && !ix.entries.has(id)) ix.entries.set(id, entryOf({ ...p, id }));
      });
    }
  })());
}

/** Whole, through a temp file and a rename, as a job record is written. A
 *  decided proposal then moves to `archive/`; one that comes back to life
 *  (a failed apply accepted again) leaves it. */
async function writeProposal(root: string, p: Proposal): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = join(root, `${p.id}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(p, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  if (DECIDED.has(p.status)) {
    await mkdir(join(root, ARCHIVE), { recursive: true, mode: 0o700 });
    await rename(file, join(root, ARCHIVE, `${p.id}.json`));
  } else {
    await unlink(join(root, ARCHIVE, `${p.id}.json`)).catch(() => {});
  }
  indexOf(root).entries.set(p.id, entryOf(p));
  for (const k of [...inflight.keys()]) if (k.startsWith(`${root}\0`)) inflight.delete(k);
}

/** Close the waiting proposal `id` that `rec` replaces: rejected by strut,
 *  "Replaced by a newer card", `replacedBy` the new one, and reported at
 *  once (the proposer made the replacement itself). Only a PENDING one of
 *  the same step in the same thread; null when there is nothing to close. */
async function replaceProposal(root: string, id: string, rec: Proposal): Promise<Proposal | null> {
  const fits = (q: Proposal) => q.id !== rec.id && q.status === "pending" && q.step === rec.step && !!threadOf(q) && threadOf(q) === threadOf(rec);
  const was = await readProposal(root, id);
  if (!was || !fits(was)) return null;
  let closed = false;
  const p = await updateProposal(root, id, (q) => {
    if (!fits(q)) return;
    const at = new Date().toISOString();
    q.status = "rejected";
    q.decision = { action: "reject", by: "strut", at, reason: "Replaced by a newer card" };
    q.replacedBy = rec.id;
    q.reportedAt = at;
    closed = true;
  });
  return closed ? p : null;
}

async function updateProposal(root: string, id: string, edit: (p: Proposal) => void): Promise<Proposal | null> {
  return withLock(join(root, `${id}.json`), async () => {
    const p = await readProposal(root, id);
    if (!p) return null;
    edit(p);
    await writeProposal(root, p);
    return p;
  });
}

export function listProposals(root: string, filter: ProposalFilter = {}): Promise<Proposal[]> {
  const { viewer } = filter;
  const key = `${root}\0${JSON.stringify([filter.job, filter.session, filter.thread, filter.step, filter.workflow, filter.runId, filter.status, filter.reported, viewer?.scope, viewer?.actor, viewer?.admin, filter.limit])}`;
  let p = inflight.get(key);
  if (!p) {
    p = runList(root, filter).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
  }
  return p.then((r) => r.slice());
}

async function runList(root: string, filter: ProposalFilter): Promise<Proposal[]> {
  await loadIndex(root);
  const statuses = filter.status === undefined ? undefined : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
  const runIds = filter.runId === undefined ? undefined : new Set(Array.isArray(filter.runId) ? filter.runId : [filter.runId]);
  const jobs = filter.job === undefined ? undefined : new Set(Array.isArray(filter.job) ? filter.job : [filter.job]);
  const { viewer } = filter;
  let hits = [...indexOf(root).entries.values()].filter(
    (e) =>
      (!jobs || (e.by.job !== undefined && jobs.has(e.by.job))) &&
      (filter.session === undefined || e.by.session === filter.session) &&
      (filter.thread === undefined || threadOf(e) === filter.thread) &&
      (filter.step === undefined || e.step === filter.step) &&
      (filter.workflow === undefined || e.by.workflow === filter.workflow) &&
      (!runIds || runIds.has(e.by.runId)) &&
      (!statuses || statuses.has(e.status)) &&
      (filter.reported === undefined || !!e.reportedAt === filter.reported) &&
      (!viewer || seesInList(viewer, e)),
  );
  hits.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  if (filter.limit !== undefined) hits = hits.slice(0, filter.limit);
  const read = await mapLimited(hits, (e) => readProposal(root, e.id, DECIDED.has(e.status)));
  return read.filter((p): p is Proposal => p !== null);
}

/** The last `createdAt` handed out, in ms. The lists order by it, and an
 *  agent's parallel tool calls propose within one millisecond: each new
 *  proposal is stamped at least 1 ms after the one before, so the order
 *  is the order they were made, never `readdir`'s. */
let lastCreatedMs = 0;

export async function createProposal(root: string, p: NewProposal): Promise<Proposal> {
  lastCreatedMs = Math.max(Date.now(), lastCreatedMs + 1);
  const rec: Proposal = { id: randomBytes(9).toString("base64url"), status: "pending", createdAt: new Date(lastCreatedMs).toISOString(), ...p };
  await writeProposal(root, rec);
  return rec;
}

// ── the capability (ctx.services.proposals) ────────────────────────────────

/** What a step reaches: the record's writer and reads. Deciding is the
 *  server's (`decideProposal`), never a step's — a person decides. */
export interface ProposalsCapability {
  propose(p: NewProposal): Promise<Proposal>;
  get(id: string): Promise<Proposal | null>;
  list(filter?: ProposalFilter): Promise<Proposal[]>;
  /** The decided proposals of a session its agent has not been told of. */
  unreported(session: string): Promise<Proposal[]>;
  markReported(ids: string[]): Promise<void>;
  /** Does the HOST gate this step type: is it in an `approve:` list of its
   *  delta (`createStrut({ job, orchestrator, builder })`)? */
  hostGates?(type: string): boolean;
  /** A person's decision (`decideProposal`), as `POST /proposals/:id/decide`
   *  applies it: what `proposal/decide` calls for a first-party page
   *  (plans/jamie-app.md §3). Set by the standard server. */
  decide?(id: string, decision: Decision): Promise<DecideOutcome>;
  /** Is the person the run `runId` is for an ADMIN here, as its records
   *  say (`adminStanding`)? Undefined when they do not say. */
  personIsAdmin?(runId: string): Promise<boolean | undefined>;
  /** The proposals of `step` still WAITING in the thread the run belongs
   *  to (else, when no thread is known, its job's: a job is one thread's),
   *  newest first: what a step's `describe` may build a new ask on and
   *  replace (`ProposalDescription.replaces`). None with neither. */
  waiting?(step: string, run: { runId: string; job?: string }): Promise<Proposal[]>;
}

export function proposalsCapability(
  dataDir: string,
  deps: {
    notify?: (job: string, update: JobUpdateInput) => void;
    hostApprove?: readonly string[];
    /** The thread the run `runId` belongs to (`Proposal.by.conversation`). */
    conversationOf?: (runId: string) => Promise<string | undefined>;
    /** Told of every new record: its `StrutProposal` and the proposal feed (createStrut). */
    changed?: (p: Proposal) => void;
    /** Whether the person the run `runId` is for is an admin, read off its
     *  records (createStrut): what a proposal only an admin accepts asks. */
    personIsAdmin?: (runId: string) => Promise<boolean | undefined>;
  } = {},
): ProposalsCapability {
  const hostApprove = (deps.hostApprove ?? []).map(globToRegExp);
  const root = proposalsRoot(dataDir);
  const tell = (p: Proposal) => {
    if (p.by.job) deps.notify?.(p.by.job, proposalUpdate(p));
    deps.changed?.(p);
  };
  return {
    async propose(p) {
      const { replaces, ...ask } = p;
      const conversation = ask.by.conversation ?? (await deps.conversationOf?.(ask.by.runId).catch(() => undefined));
      let rec = await createProposal(root, conversation ? { ...ask, by: { ...ask.by, conversation } } : ask);
      // `replaces` is recorded only when the waiting one was in fact closed.
      const old = replaces ? await replaceProposal(root, replaces, rec) : null;
      if (old) rec = (await updateProposal(root, rec.id, (q) => void (q.replaces = old.id))) ?? rec;
      tell(rec);
      if (old) tell(old);
      return rec;
    },
    async waiting(step, run) {
      const thread = await deps.conversationOf?.(run.runId).catch(() => undefined);
      if (!thread && !run.job) return [];
      return listProposals(root, { status: "pending", step, ...(thread ? { thread } : { job: run.job! }) });
    },
    get: (id) => readProposal(root, id),
    list: (filter) => listProposals(root, filter),
    unreported: async (session) => (await listProposals(root, { session, status: [...DECIDED], reported: false })).reverse(),
    async markReported(ids) {
      const at = new Date().toISOString();
      for (const id of ids) await updateProposal(root, id, (p) => void (p.reportedAt ??= at));
    },
    hostGates: (type) => hostApprove.some((re) => re.test(type)),
    ...(deps.personIsAdmin ? { personIsAdmin: deps.personIsAdmin } : {}),
  };
}

/**
 * A step that reaches past this strut (`strut/run-workflow`: another org's
 * strut) runs only on a person's yes when the HOST gates it — whatever the
 * route. A host's `approve:` holds back the agent's TOOL call; the same
 * step can also be reached as a workflow step (the builder's `remote`, a
 * builder job started with `peer` by `job/start` or `meta/run-workflow`),
 * through `meta/run-step`, or as an ungated tool of another agent. So the
 * step itself refuses unless it runs as an accepted proposal
 * (`ctx.proposal`). No host gate: nothing changes.
 */
export function requireApproval(type: string, ctx: StepContext): void {
  if (ctx.proposal || !proposalsOf(ctx.services)?.hostGates?.(type)) return;
  throw new Error(
    `${type} needs the person's approval on this strut server (its host gates it), and this call is not an approved proposal. ` +
      `Ask for it as a tool call the person approves; a workflow step, meta/run-step or a launch with \`peer\` cannot reach it.`,
  );
}

export function proposalsOf(services: unknown): ProposalsCapability | undefined {
  return (services as { proposals?: ProposalsCapability } | undefined)?.proposals;
}

// ── the gate ───────────────────────────────────────────────────────────────

/** The sentence a gated tool's description gains. */
export const GATE_NOTE =
  " [PROPOSED, not run: calling this records a proposal the person accepts or rejects later, and returns { proposal, status: \"pending\" }. " +
  "Nothing changes until they accept. Say in your reply what you proposed and why; do not call it again for the same change, and do not wait for the decision — it reaches you on a later turn.]";

const RATIONALE = z.string().optional().describe("One or two sentences for the person: why this change, in their terms.");

/** The step's schema with `rationale` beside its fields, when it is an object. */
export function gatedSchema(input: z.ZodTypeAny): z.ZodTypeAny {
  return input instanceof z.ZodObject ? input.extend({ rationale: RATIONALE }) : input;
}

/** The first sentence of a step's description, for the card. */
export function titleOf(stepType: string, description: string | undefined): string {
  const first = (description ?? "").split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? "";
  const text = first.length > 120 ? `${first.slice(0, 117).trimEnd()}…` : first;
  return text || stepType;
}

export interface ProposeCallOptions {
  /** The agent's session, so the thread is told the decision (§5). */
  session?: string;
}

/**
 * What a gated tool's `execute` does in place of the step's `run`: journal
 * replay (a resumed turn making the same call gets the proposal it made),
 * else the record. `parsed` is the input the step's schema accepted,
 * without `rationale`. The journal key is the call's own —
 * `<agent path>#<call>`, as `job/start` journals (job/_shared.ts).
 */
export async function proposeCall(
  stepType: string,
  def: AnyStepDef,
  parsed: unknown,
  rationale: string | undefined,
  ctx: StepContext,
  opts: ProposeCallOptions = {},
): Promise<{ proposal: string; status: ProposalStatus; step: string; title: string; url: string; held?: true }> {
  // A trial proposes nothing (src/trials.ts): no card reaches a person, and
  // the model reads the answer a recorded proposal would have given it.
  if (ctx.trial) return { proposal: "", status: "pending", step: stepType, title: titleOf(stepType, def.description), url: "", held: true };
  const cap = proposalsOf(ctx.services);
  if (!cap) throw new Error(`agent: "${stepType}" is in approve: but this strut server has no proposals capability (ctx.services.proposals).`);
  const key = journalKeyOf(ctx);
  const prior = key ? (ctx.journal?.[key] as { proposal?: unknown } | undefined) : undefined;
  if (prior && typeof prior.proposal === "string") {
    const was = await cap.get(prior.proposal);
    if (was) return result(was);
  }
  // Only an admin accepts it (`StepDef.approver`): a turn whose person is
  // known not to be one proposes nothing — the person they would ask never
  // sees it (`visibleTo`: a proposal shows where it was made), so it would
  // wait forever. The model reads why and tells them to ask an admin.
  if (def.approver === "admin" && (await adminStanding(ctx, cap)) === false) {
    throw new Error(
      `admin_required: ${stepType} is an admin's decision on this strut server, and the person this turn is for is not an admin here, so nothing was proposed. ` +
        `Tell them in their words that an admin of this server does it, and to ask one.`,
    );
  }
  // The step's own words for the card (§7), read now, best effort.
  let described: ProposalDescription | undefined;
  if (def.describe) {
    try {
      described = await def.describe(parsed, ctx);
    } catch {
      described = undefined;
    }
  }
  const title = described?.title?.trim() || titleOf(stepType, def.description);
  const summary = described?.summary?.trim() || undefined;
  // A default the step read now, kept on the record (`ProposalDescription.input`):
  // the yes applies what the card showed.
  const pinned = described?.input !== undefined ? def.input.safeParse(described.input) : undefined;
  const input: unknown = pinned?.success ? pinned.data : parsed;
  let card: ProposalCard | undefined;
  try {
    card = buildCard({ input, title, ...(summary ? { summary } : {}), ...(described ? { described } : {}) });
  } catch {
    card = undefined;
  }
  const rec = await cap.propose({
    step: stepType,
    input,
    ...(rationale ? { rationale } : {}),
    title,
    ...(summary ? { summary } : {}),
    ...(card ? { card } : {}),
    ...(def.approver ? { approver: def.approver } : {}),
    ...(described?.replaces ? { replaces: described.replaces } : {}),
    by: {
      workflow: workflowOf(ctx),
      runId: ctx.runId,
      path: ctx.path,
      ...(ctx.job ? { job: ctx.job } : {}),
      // A proposal made on a Concept branch applies on it (src/branches.ts).
      ...(ctx.branch ? { branch: ctx.branch } : {}),
      ...(opts.session ? { session: opts.session } : {}),
      ...(ctx.actor ? { actor: ctx.actor } : {}),
      ...(ctx.principal ? { principal: ctx.principal } : {}),
    },
  });
  if (key && ctx.emit) {
    // The runner stamps ts/runId (job/_shared.ts's cast).
    await (ctx.emit as unknown as (e: { type: "step.end"; path: string; output: unknown }) => Promise<void>)({ type: "step.end", path: key, output: { proposal: rec.id } });
  }
  return result(rec);
}

/** What the proposing agent reads back; `replaced`, the waiting card this
 *  one closed and stands in for, so its reply never sends the person to it. */
const result = (p: Proposal) => ({ proposal: p.id, status: p.status, step: p.step, title: p.title, url: proposalUrl(p.id), ...(p.replaces ? { replaced: p.replaces } : {}) });

/** Is the person the turn `ctx` is for an ADMIN of this strut server
 *  (plans/member-rights.md)? A page's turn says (`ctx.app.admin`, the app
 *  door's); any other asks the records (`personIsAdmin`: a peer's launch is
 *  not one, a job's run asks the turn that started it). Undefined when
 *  nothing says — a host's launch with the key, an automation — and the
 *  decision decides. */
export async function adminStanding(ctx: StepContext, cap: ProposalsCapability | undefined): Promise<boolean | undefined> {
  if (ctx.app) return ctx.app.admin === true;
  return cap?.personIsAdmin ? cap.personIsAdmin(ctx.runId).catch(() => undefined) : undefined;
}

/** `<agent path>#<call>` for a tool call (the agent's journal slice), else
 *  `<path>#propose`; undefined outside a run. */
function journalKeyOf(ctx: StepContext): string | undefined {
  if (!ctx.path) return undefined;
  const cut = ctx.path.lastIndexOf("/");
  return ctx.agentTool && cut > 0 ? `${ctx.path.slice(0, cut)}#${ctx.path.slice(cut + 1)}` : `${ctx.path}#propose`;
}

// ── the decision ───────────────────────────────────────────────────────────

export interface Decision {
  action: ProposalAction;
  /** The person's edits, merged one level onto the recorded input on accept. */
  input?: Record<string, unknown>;
  reason?: string;
  /** Who decided (the request's actor). */
  by?: string;
  /** The request's scope. A person token (`peer:person`) and a host
   *  (`host`, as the person it names) decide only a proposal their actor
   *  made; a plain `peer` decides none. Absent or `full`: unchanged. */
  scope?: Scope;
  /** Is the decider an ADMIN of this strut server (plans/member-rights.md)?
   *  Only an admin accepts a proposal of a step with `approver: "admin"`.
   *  Default: the scope is `full` (or absent) — the deployment key, an
   *  admin's session, a host's server with the key. A person token is not
   *  one: it names a person, never their role here. `proposal/decide` says
   *  it from the page's viewer (`AppRef.admin`), since it decides as
   *  `peer:person` — the viewer's own proposals — whatever their role. */
  admin?: boolean;
}

/** Why the decider may not ACCEPT `p` — only an admin accepts it, and they
 *  are not one — or undefined. Rejecting is never refused for it. */
/** Whether a person decides proposal `p` as its card shows it to them: the
 *  person whose ask made it — accepting runs it as them, with their
 *  connectors and their bill, so nobody else does — and, for one only an
 *  admin accepts (`approver: "admin"`, the step's word else the record's:
 *  a task type, a package, a grant), any ADMIN here, accept or reject: that
 *  is what it waits for, wherever it was made (an admin's session already
 *  decides it at /proposals). `decideProposal` holds a person token to it;
 *  `proposal/get` tells the page (`viewer.decides`). */
export function decides(p: Pick<Proposal, "by" | "approver">, viewer: { actor?: string; admin?: boolean }, def?: Pick<AnyStepDef, "approver">): boolean {
  if (viewer.actor && p.by.actor === viewer.actor) return true;
  return viewer.admin === true && (def?.approver ?? p.approver) === "admin";
}

export function acceptRefusal(p: Pick<Proposal, "step" | "title" | "approver">, def: Pick<AnyStepDef, "approver"> | undefined, admin: boolean): string | undefined {
  if (admin || (def?.approver ?? p.approver) !== "admin") return undefined;
  return `admin_required: only an admin of this strut server accepts "${p.title}" (${p.step}) — ask one to accept it. You may still reject it.`;
}

export interface DecideDeps {
  registry: StepRegistry;
  services: unknown;
  /** The proposing run's MCP servers, when the store kept them (best effort:
   *  a token may have expired since the launch). */
  mcpOf?: (workflow: string, runId: string) => Promise<McpServer[] | null>;
  notify?: (job: string, update: JobUpdateInput) => void;
  /** A gated tool that is not a registry step — an MCP server's
   *  (`mcp/<server>/<tool>`, src/mcp-registry.ts) — as a def to apply. */
  stepFor?: (type: string) => Promise<AnyStepDef | undefined>;
  /** Told of each change the decision makes: its `StrutProposal` and the proposal feed (createStrut). */
  changed?: (p: Proposal) => void;
}

export type DecideOutcome = { status: 200 | 400 | 403 | 404 | 409; body: Proposal | { error: string; proposal?: Proposal } };

/**
 * Decide a proposal: `reject` records the reason and runs nothing; `accept`
 * records the decision, then APPLIES — the step run with the recorded input
 * (edits merged, re-parsed by the step's own schema; a bad merge is 400 and
 * the proposal stays pending) under a minimal context, the decider as
 * `ctx.actor`, the proposing run's principal binding its secrets. A decided
 * proposal answers 409 with the record (a double click does nothing twice);
 * a `failed` apply may be accepted again once the cause is fixed.
 */
export async function decideProposal(root: string, id: string, decision: Decision, deps: DecideDeps): Promise<DecideOutcome> {
  const rec = await readProposal(root, id);
  if (!rec) return { status: 404, body: { error: `No proposal "${id}"` } };
  if (decision.scope === "peer") return { status: 403, body: { error: "forbidden: a peer without a person cannot decide a proposal" } };
  // `stepFor` first: a name it answers for is never a registry step's.
  const def = (await deps.stepFor?.(rec.step)) ?? deps.registry[rec.step];
  if ((decision.scope === "peer:person" || decision.scope === "host") && !decides(rec, { ...(decision.by ? { actor: decision.by } : {}), ...(decision.scope === "peer:person" && decision.admin ? { admin: true } : {}) }, def)) {
    return { status: 403, body: { error: `forbidden: proposal "${id}" is not yours to decide` } };
  }
  const tell = (p: Proposal) => {
    if (p.by.job) deps.notify?.(p.by.job, proposalUpdate(p));
    deps.changed?.(p);
  };

  if (decision.action === "reject") {
    if (rec.status !== "pending") return { status: 409, body: { error: `Proposal "${id}" is ${rec.status}`, proposal: rec } };
    const p = (await updateProposal(root, id, (p) => {
      p.status = "rejected";
      p.decision = { action: "reject", at: new Date().toISOString(), ...(decision.by ? { by: decision.by } : {}), ...(decision.reason ? { reason: decision.reason } : {}) };
    }))!;
    tell(p);
    return { status: 200, body: p };
  }

  if (rec.status !== "pending" && rec.status !== "failed") return { status: 409, body: { error: `Proposal "${id}" is ${rec.status}`, proposal: rec } };
  // Only an admin accepts it (`StepDef.approver`): the step's word now, else
  // the record's, so neither a step that lost it nor a record from before
  // it opens the door. Before anything is written: it stays as it was.
  const admin = decision.admin ?? (decision.scope === undefined || decision.scope === "full");
  const refused = acceptRefusal(rec, def, admin);
  if (refused) return { status: 403, body: { error: refused, proposal: rec } };
  if (!def) return { status: 400, body: { error: `The step "${rec.step}" is not in this strut server's registry; the proposal cannot be applied.`, proposal: rec } };
  const merged = decision.input && typeof rec.input === "object" && rec.input !== null ? { ...(rec.input as object), ...decision.input } : decision.input ?? rec.input;
  let input: unknown;
  try {
    input = def.input.parse(merged);
  } catch (e) {
    return { status: 400, body: { error: `invalid input for "${rec.step}": ${(e as Error).message}`, proposal: rec } };
  }
  // A step may apply only after others (`StepDef.after`): a schedule after
  // the publish of its workflow. Accepting it first changes nothing. Only
  // the proposals of the step it names are read.
  if (def.after) {
    const { step, when } = def.after;
    // Not yet applied: pending, being applied, or failed (it may be accepted again).
    const first = (await listProposals(root, { step, status: ["pending", "accepted", "failed"] })).find((q) => q.id !== rec.id && when(input, q.input));
    if (first) {
      return { status: 409, body: { error: `Proposal "${rec.id}" applies after "${first.id}" (${first.step}), which is ${first.status}: decide that one first.`, proposal: rec } };
    }
  }

  let p = (await updateProposal(root, id, (p) => {
    p.status = "accepted";
    p.decision = { action: "accept", at: new Date().toISOString(), ...(decision.by ? { by: decision.by } : {}), ...(decision.input ? { input: decision.input } : {}) };
    delete p.result;
  }))!;
  tell(p);

  const at = new Date().toISOString();
  try {
    const output = await applyProposal(p, def, input, decision.by, deps);
    const cost = takeUsage(output).cost;
    const nodes = accessedNodesOf(output);
    p = (await updateProposal(root, id, (q) => {
      q.status = "applied";
      q.result = { output, at, ...(typeof cost === "number" ? { cost } : {}), ...(nodes?.length ? { nodes } : {}) };
    }))!;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    p = (await updateProposal(root, id, (q) => {
      q.status = "failed";
      q.result = { error, at };
    }))!;
  }
  tell(p);
  return { status: 200, body: p };
}

/** The step run once, outside any run: the bag (secrets bound to the
 *  proposing run's principal), the registry, the job, the decider as actor. */
async function applyProposal(p: Proposal, def: AnyStepDef, input: unknown, by: string | undefined, deps: DecideDeps): Promise<unknown> {
  const all = (deps.services ?? {}) as Record<string, unknown>;
  // Made on a Concept branch: applied on it, while it exists (src/branches.ts).
  if (p.by.branch && !(await (all["branches"] as BranchesCapability | undefined)?.get(p.by.branch))) {
    throw new Error(`no_branch: this proposal was made on Concept branch "${p.by.branch}", which is gone — nothing applied`);
  }
  const bag = p.by.branch ? bindBranch(all, p.by.branch) : all;
  const secrets = bag["secrets"] as { forPrincipal?: (principal: string) => unknown } | undefined;
  // Its graph writes are heard like a run's (plans/live-feeds.md §2): the
  // proposing job's host reads the canvas again when a person's yes lands.
  const { services: bound, reporter } = bindGraph(
    p.by.principal && secrets?.forPrincipal ? { ...bag, secrets: secrets.forPrincipal(p.by.principal) } : bag,
    { id: `proposal:${p.id}`, ...(p.by.job ? { job: p.by.job } : {}), ...(by ? { actor: by } : {}) },
  );
  const mcp = deps.mcpOf ? await deps.mcpOf(p.by.workflow, p.by.runId).catch(() => null) : null;
  const ctx: StepContext<unknown> = {
    runId: `proposal:${p.id}`,
    path: `proposals/${p.id}`,
    scope: {},
    input,
    emit: async () => {},
    services: bound,
    registry: deps.registry,
    ...(p.by.job ? { job: p.by.job } : {}),
    ...(p.by.branch ? { branch: p.by.branch } : {}),
    ...(by ? { actor: by } : {}),
    ...(p.by.principal ? { principal: p.by.principal } : {}),
    ...(mcp?.length ? { mcp } : {}),
    // The proposing workflow's reach holds for the apply too (src/reach.ts).
    ...((await reachPolicyOf(bound)?.aiWorkflow(p.by.workflow).catch(() => true)) ? { aiAuthored: true } : {}),
    proposal: { id: p.id, by: { workflow: p.by.workflow, runId: p.by.runId } },
  };
  try {
    return await def.run(input, withinReach(p.step, input, ctx));
  } finally {
    await reporter?.flush();
  }
}

// ── what the agent is told (§5) ────────────────────────────────────────────

/** One line per decided proposal the session has not been told of. */
export function proposalResultLines(decided: Proposal[]): string[] {
  return decided.map((p) => {
    const tail =
      p.status === "rejected"
        ? p.decision?.reason
          ? ` · "${p.decision.reason}"`
          : ""
        : p.status === "failed"
          ? ` · ${p.result?.error ?? "the apply failed"}`
          : "";
    return `${PROPOSAL_RESULT_PREFIX} ${p.id} ${p.status} · ${p.step} "${p.title}"${tail}`;
  });
}
