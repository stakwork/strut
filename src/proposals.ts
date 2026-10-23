import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { accessedNodesOf, takeUsage, type AnyStepDef, type McpServer, type StepContext, type StepRegistry } from "./core.js";
import { withLock } from "./jobs.js";
import { globToRegExp } from "./closure.js";
import { reachPolicyOf, withinReach } from "./reach.js";
import type { JobUpdateInput } from "./jobs.js";

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
 * index is a readdir. No graph node until something must point at one.
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
  /** For the card: the step description's first sentence. */
  title: string;
  status: ProposalStatus;
  createdAt: string;
  /** Who proposed it. */
  by: { workflow: string; runId: string; path: string; job?: string; session?: string; actor?: string; principal?: string };
  decision?: { action: ProposalAction; by?: string; at: string; input?: unknown; reason?: string };
  result?: { output?: unknown; error?: string; cost?: number; nodes?: unknown[]; at: string };
  /** When the proposing session was told of the decision (§5). */
  reportedAt?: string;
}

/** The slim form a host reads: `run.end { proposals }`, the steps' results. */
export interface ProposalBrief {
  id: string;
  step: string;
  title: string;
  status: ProposalStatus;
  url: string;
  rationale?: string;
  createdAt: string;
  decidedAt?: string;
}

export type NewProposal = Pick<Proposal, "step" | "input" | "rationale" | "title" | "by">;

export interface ProposalFilter {
  job?: string;
  session?: string;
  runId?: string;
  status?: ProposalStatus | ProposalStatus[];
}

export const PROPOSAL_RESULT_PREFIX = "[proposal-result]";
const DECIDED: ReadonlySet<ProposalStatus> = new Set(["rejected", "applied", "failed"]);

export function proposalsRoot(dataDir: string): string {
  return join(dataDir, "proposals");
}

export function proposalUrl(id: string): string {
  return `/proposals/${encodeURIComponent(id)}`;
}

export function briefOf(p: Proposal): ProposalBrief {
  return {
    id: p.id,
    step: p.step,
    title: p.title,
    status: p.status,
    url: proposalUrl(p.id),
    ...(p.rationale ? { rationale: p.rationale } : {}),
    createdAt: p.createdAt,
    ...(p.decision ? { decidedAt: p.decision.at } : {}),
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

export async function readProposal(root: string, id: string): Promise<Proposal | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(root, `${id}.json`), "utf-8")) as Proposal;
  } catch {
    return null;
  }
}

/** Whole, through a temp file and a rename, as a job record is written. */
async function writeProposal(root: string, p: Proposal): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = join(root, `${p.id}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(p, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
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

export async function listProposals(root: string, filter: ProposalFilter = {}): Promise<Proposal[]> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const statuses = filter.status === undefined ? undefined : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
  const out: Proposal[] = [];
  for (const n of names) {
    const p = await readProposal(root, n.slice(0, -".json".length));
    if (!p) continue;
    if (filter.job !== undefined && p.by.job !== filter.job) continue;
    if (filter.session !== undefined && p.by.session !== filter.session) continue;
    if (filter.runId !== undefined && p.by.runId !== filter.runId) continue;
    if (statuses && !statuses.has(p.status)) continue;
    out.push(p);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function createProposal(root: string, p: NewProposal): Promise<Proposal> {
  const rec: Proposal = { id: randomBytes(9).toString("base64url"), status: "pending", createdAt: new Date().toISOString(), ...p };
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
}

export function proposalsCapability(
  dataDir: string,
  deps: { notify?: (job: string, update: JobUpdateInput) => void; hostApprove?: readonly string[] } = {},
): ProposalsCapability {
  const hostApprove = (deps.hostApprove ?? []).map(globToRegExp);
  const root = proposalsRoot(dataDir);
  const tell = (p: Proposal) => {
    if (p.by.job) deps.notify?.(p.by.job, proposalUpdate(p));
  };
  return {
    async propose(p) {
      const rec = await createProposal(root, p);
      tell(rec);
      return rec;
    },
    get: (id) => readProposal(root, id),
    list: (filter) => listProposals(root, filter),
    unreported: async (session) => (await listProposals(root, { session })).filter((p) => DECIDED.has(p.status) && !p.reportedAt).reverse(),
    async markReported(ids) {
      const at = new Date().toISOString();
      for (const id of ids) await updateProposal(root, id, (p) => void (p.reportedAt ??= at));
    },
    hostGates: (type) => hostApprove.some((re) => re.test(type)),
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
    `${type} needs the person's approval on this strut (its host gates it), and this call is not an approved proposal. ` +
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
): Promise<{ proposal: string; status: ProposalStatus; step: string; title: string; url: string }> {
  const cap = proposalsOf(ctx.services);
  if (!cap) throw new Error(`agent: "${stepType}" is in approve: but this strut has no proposals capability (ctx.services.proposals).`);
  const key = journalKeyOf(ctx);
  const prior = key ? (ctx.journal?.[key] as { proposal?: unknown } | undefined) : undefined;
  if (prior && typeof prior.proposal === "string") {
    const was = await cap.get(prior.proposal);
    if (was) return result(was);
  }
  const rec = await cap.propose({
    step: stepType,
    input: parsed,
    ...(rationale ? { rationale } : {}),
    title: titleOf(stepType, def.description),
    by: {
      workflow: ctx.path.split("/")[0] ?? "",
      runId: ctx.runId,
      path: ctx.path,
      ...(ctx.job ? { job: ctx.job } : {}),
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

const result = (p: Proposal) => ({ proposal: p.id, status: p.status, step: p.step, title: p.title, url: proposalUrl(p.id) });

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
}

export type DecideOutcome = { status: 200 | 400 | 404 | 409; body: Proposal | { error: string; proposal?: Proposal } };

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
  const tell = (p: Proposal) => {
    if (p.by.job) deps.notify?.(p.by.job, proposalUpdate(p));
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
  // `stepFor` first: a name it answers for is never a registry step's.
  const def = (await deps.stepFor?.(rec.step)) ?? deps.registry[rec.step];
  if (!def) return { status: 400, body: { error: `The step "${rec.step}" is not in this strut's registry; the proposal cannot be applied.`, proposal: rec } };
  const merged = decision.input && typeof rec.input === "object" && rec.input !== null ? { ...(rec.input as object), ...decision.input } : decision.input ?? rec.input;
  let input: unknown;
  try {
    input = def.input.parse(merged);
  } catch (e) {
    return { status: 400, body: { error: `invalid input for "${rec.step}": ${(e as Error).message}`, proposal: rec } };
  }
  // A step may apply only after others (`StepDef.after`): a schedule after
  // the publish of its workflow. Accepting it first changes nothing.
  if (def.after) {
    // Not yet applied: pending, being applied, or failed (it may be accepted again).
    const first = (await listProposals(root, { status: ["pending", "accepted", "failed"] })).find((q) => q.id !== rec.id && def.after!(input, q));
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
  const bag = (deps.services ?? {}) as Record<string, unknown>;
  const secrets = bag["secrets"] as { forPrincipal?: (principal: string) => unknown } | undefined;
  const bound = p.by.principal && secrets?.forPrincipal ? { ...bag, secrets: secrets.forPrincipal(p.by.principal) } : bag;
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
    ...(by ? { actor: by } : {}),
    ...(p.by.principal ? { principal: p.by.principal } : {}),
    ...(mcp?.length ? { mcp } : {}),
    // The proposing workflow's reach holds for the apply too (src/reach.ts).
    ...((await reachPolicyOf(bound)?.aiWorkflow(p.by.workflow).catch(() => true)) ? { aiAuthored: true } : {}),
    proposal: { id: p.id, by: { workflow: p.by.workflow, runId: p.by.runId } },
  };
  return def.run(input, withinReach(p.step, input, ctx));
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
