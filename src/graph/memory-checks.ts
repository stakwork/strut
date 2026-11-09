/**
 * Checks for memory facts (plans/memory-checks.md), on a Ladybug file: the
 * evidence a fact should keep producing while it is true, looked for.
 *
 * A kind of fact (an edge type) may have a `Check` (`ladybug/fact-claims.ts`
 * `factCheckOf`): what its facts should keep producing, the step that looks,
 * and how often. The step is an ordinary strut step given the fact, with one
 * contract:
 *
 *   input:  { subject, edge_type, target, text, since, window_days }
 *   output: { supports: true | false, content } | { unavailable: true }
 *
 * Found is `observed` evidence for it, weaker than a person's word; quiet is
 * weakly against it; unavailable, or a check that fails, writes nothing, as
 * a check that cannot run never fails a claim. Only memory's read-only
 * `graph/check-*` steps can be a check.
 *
 * No janitor. As strut runs a check when its subject runs and the evidence is
 * older than `freshness_days` (`policyFires`, `../verify.ts`), a fact's check
 * runs when the fact is read by the user's own agent and its check evidence
 * is that old (`queueFactChecks`, after `graph/graph-search` answers, never
 * holding it up). `verifyFacts` runs the checks on demand
 * (`graph/verify-facts`).
 */
import type { LadybugBackend } from "./backend.js";
import type { Row } from "./engine.js";
import type { FactTrust } from "./fact-score.js";
import { temporalEdgeTypes } from "./ladybug/temporal.js";
import { factCheckOf, factClaimId, factEvidence, isCheckStep, recordFactEvidence, type FactCheck } from "./ladybug/fact-claims.js";

const DAY = 86_400_000;
const q = (s: string) => `\`${s}\``;
const EDGE_TYPE = /^[A-Z][A-Z0-9_]*$/;
/** What a finding counts for a fact, and a quiet source against it. A
 *  keyword hit cannot tell "lives in Porto" from "moved out of Porto", nor an
 *  old mention from a new one, so a finding is kept as evidence but backs
 *  nothing (no sayer, no reset of currency); only quiet counts, weakly against.
 *  A check that judges what it found can give findings weight later. */
export const FOUND = 0;
export const QUIET = -0.5;
/** At most this many checks start from one read. */
const PER_READ = 3;
/** At most this many checks from one on-demand run, `force` or not. */
const PER_VERIFY = 25;

export interface FactEnd {
  ref_id: string;
  name?: string;
  type?: string;
  /** The end is the user. */
  owner?: boolean;
}

/** What a check step is given: the fact, and the window to look in. */
export interface FactCheckInput {
  subject: FactEnd;
  edge_type: string;
  target: FactEnd;
  text: string;
  /** What the fact's kind should keep producing, in plain words. */
  expects: string;
  /** ISO: look for evidence since then. */
  since: string;
  window_days: number;
}

/** Runs one step: what strut's `runSingleStep` gives back, in short. */
export type RunStep = (step: string, input: unknown, config: Record<string, unknown>) => Promise<{ status: string; output?: unknown }>;

/** A fact a read returned, with how far it is trusted now. */
export interface ReadFact {
  ref_id: string;
  edge_type: string;
  subject: FactEnd;
  target: FactEnd;
  text: string;
  namespace?: string;
  trust?: FactTrust;
}

export interface CheckReport {
  checked: number;
  supported: number;
  quiet: number;
  unavailable: number;
  failed: number;
}

const emptyReport = (): CheckReport => ({ checked: 0, supported: 0, quiet: 0, unavailable: 0, failed: 0 });

/** A check's output as evidence: its strength and finding, or none. */
export function checkResultOf(run: { status: string; output?: unknown }): { strength: number; content?: string } | "unavailable" | "failed" {
  if (run.status !== "success" || !run.output || typeof run.output !== "object") return "failed";
  const o = run.output as Record<string, unknown>;
  if (o["unavailable"] === true) return "unavailable";
  if (typeof o["supports"] !== "boolean") return "failed";
  return { strength: o["supports"] ? FOUND : QUIET, ...(typeof o["content"] === "string" && o["content"] ? { content: o["content"] } : {}) };
}

/** The user among these nodes. */
async function ownersOf(b: LadybugBackend, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  // A file with no owner column yet answers with an error: no owner.
  const rows = await b.query(`UNWIND $ids AS id MATCH (n:Node {ref_id: id}) WHERE n.is_owner = true RETURN id`, { ids }).catch(() => [] as Row[]);
  return new Set(rows.map((r) => String(r["id"])));
}

/** Run one fact's check and keep what it found. */
async function runCheck(b: LadybugBackend, check: FactCheck, f: ReadFact, runStep: RunStep, now: number, report: CheckReport): Promise<void> {
  const input: FactCheckInput = {
    subject: f.subject, edge_type: f.edge_type, target: f.target, text: f.text, expects: check.expects,
    since: new Date(now - check.window_days * DAY).toISOString(), window_days: check.window_days,
  };
  // Only memory's own check steps run: a stored check naming anything else is refused here too.
  const result = isCheckStep(check.step) ? checkResultOf(await runStep(check.step, input, check.config).catch(() => ({ status: "error" }))) : "failed";
  report.checked++;
  if (result === "unavailable" || result === "failed") {
    report[result]++;
    return;
  }
  report[result.strength < 0 ? "quiet" : "supported"]++;
  await b.tx((tx) =>
    recordFactEvidence(tx, {
      subject: f.subject.ref_id, edge: f.edge_type, target: f.target.ref_id, text: f.text,
      ...(result.content ? { content: result.content } : {}), ...(f.namespace ? { namespace: f.namespace } : {}),
      check: { id: check.id, step: check.step },
      observed_at: now, strength: result.strength, now,
    }),
  );
}

/** Which of these current facts are due their kind's check: its newest check evidence older than `freshness_days`. */
async function dueChecks(b: LadybugBackend, facts: ReadFact[], now: number): Promise<Array<{ fact: ReadFact; check: FactCheck }>> {
  const run = (c: string, p?: Record<string, unknown>) => b.query(c, p);
  const checks = new Map<string, FactCheck | null>();
  for (const t of new Set(facts.map((f) => f.edge_type))) checks.set(t, await factCheckOf(run, t));
  const withCheck = facts.filter((f) => checks.get(f.edge_type));
  if (!withCheck.length) return [];
  const evidence = await factEvidence(run, withCheck.map((f) => factClaimId(f.subject.ref_id, f.edge_type, f.target.ref_id)));
  return withCheck.flatMap((f) => {
    const check = checks.get(f.edge_type)!;
    const mine = (evidence.get(factClaimId(f.subject.ref_id, f.edge_type, f.target.ref_id)) ?? []).filter((x) => x.check_id === check.id);
    const last = Math.max(0, ...mine.map((x) => x.observed_at));
    return now - last >= check.freshness_days * DAY ? [{ fact: f, check }] : [];
  });
}

/** Checks under way, by claim: one at a time each. */
const inFlight = new Set<string>();

/**
 * After a read by the user's own agent: the due checks of the current facts
 * it returned (a few, one per fact at a time). Never throws; the read does
 * not wait for it. Resolves when done.
 */
export async function queueFactChecks(b: LadybugBackend, facts: ReadFact[], runStep: RunStep, opts: { now?: number } = {}): Promise<CheckReport> {
  const report = emptyReport();
  try {
    const now = opts.now ?? Date.now();
    const current = facts.filter((f) => f.trust?.stance !== undefined);
    if (!current.length) return report;
    const owners = await ownersOf(b, [...new Set(current.flatMap((f) => [f.subject.ref_id, f.target.ref_id]))]);
    const mark = (e: FactEnd): FactEnd => (owners.has(e.ref_id) ? { ...e, owner: true } : e);
    const due = (await dueChecks(b, current, now)).filter(({ fact }) => !inFlight.has(factClaimId(fact.subject.ref_id, fact.edge_type, fact.target.ref_id))).slice(0, PER_READ);
    for (const { fact, check } of due) {
      const claim = factClaimId(fact.subject.ref_id, fact.edge_type, fact.target.ref_id);
      inFlight.add(claim);
      try {
        await runCheck(b, check, { ...fact, subject: mark(fact.subject), target: mark(fact.target) }, runStep, now, report);
      } finally {
        inFlight.delete(claim);
      }
    }
  } catch {
    // A check that cannot run never fails a read.
  }
  return report;
}

/** Every current fact of `edge`, as a read would return it. */
async function currentFacts(b: LadybugBackend, edge: string): Promise<ReadFact[]> {
  if (!EDGE_TYPE.test(edge)) return [];
  const rows = await b.query(
    `MATCH (s:Node)-[r:${q(edge)}]->(t:Node) WHERE r.expired_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL AND t.deleted_at IS NULL
     RETURN r.ref_id AS id, r.text AS text, r.namespace AS ns, s.ref_id AS s_id, coalesce(s.title, s.name) AS s_name, s.node_type AS s_type,
            t.ref_id AS t_id, coalesce(t.title, t.name) AS t_name, t.node_type AS t_type`,
  ).catch(() => [] as Row[]);
  const end = (r: Row, k: "s" | "t"): FactEnd => ({
    ref_id: String(r[`${k}_id`]),
    ...(typeof r[`${k}_name`] === "string" ? { name: String(r[`${k}_name`]) } : {}),
    ...(typeof r[`${k}_type`] === "string" ? { type: String(r[`${k}_type`]) } : {}),
  });
  return rows.map((r) => ({ ref_id: String(r["id"]), edge_type: edge, subject: end(r, "s"), target: end(r, "t"), text: String(r["text"] ?? ""), ...(typeof r["ns"] === "string" ? { namespace: r["ns"] } : {}) }));
}

/** On demand: every current fact whose kind has a check and is due it (or every one, with `force`), checked now. */
export async function verifyFacts(b: LadybugBackend, runStep: RunStep, opts: { now?: number; force?: boolean } = {}): Promise<CheckReport> {
  const report = emptyReport();
  const now = opts.now ?? Date.now();
  // The scoped view's raw query: right while memory holds one namespace per
  // file (Peel's `private`); a graph with more would need the scope applied here.
  const run = (c: string, p?: Record<string, unknown>) => b.query(c, p);
  for (const edge of await temporalEdgeTypes(run)) {
    const check = await factCheckOf(run, edge);
    if (!check) continue;
    const facts = await currentFacts(b, edge);
    const due = opts.force ? facts.map((fact) => ({ fact, check })) : await dueChecks(b, facts, now);
    const owners = await ownersOf(b, [...new Set(facts.flatMap((f) => [f.subject.ref_id, f.target.ref_id]))]);
    const mark = (e: FactEnd): FactEnd => (owners.has(e.ref_id) ? { ...e, owner: true } : e);
    for (const { fact } of due) {
      if (report.checked >= PER_VERIFY) return report;
      await runCheck(b, check, { ...fact, subject: mark(fact.subject), target: mark(fact.target) }, runStep, now, report);
    }
  }
  return report;
}
