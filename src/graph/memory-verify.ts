/**
 * Memory facts' checks (plans/memory-truth-layer.md, "Expectations"), on a
 * Ladybug file: the pass `graph/verify-facts` runs, as the verify pass runs a
 * step's checks (`../verify.ts`).
 *
 *   1. For each fact type whose rule `expects` evidence, each current fact
 *      whose last check is older than `every_days` runs the check: a strut
 *      step given the fact. It returns `{ supports, content }` — the
 *      expected activity is there (+1 observed evidence) or the source is
 *      readable and quiet (evidence against, weaker) — or `{ unavailable:
 *      true }` when it cannot see its source: no evidence, so silence it could
 *      not have heard means nothing. A check that errors writes nothing, as a
 *      check that cannot run never fails a claim.
 *   2. Each current fact whose stance is `ask` gets one open question on its
 *      claim (an external check's planned slot), unless it has one: the read
 *      reports it, so the agent does not ask twice, and the claim's next
 *      evidence (the user's answer) closes it.
 *
 * Nothing is scored or stored here beyond the evidence and the question;
 * the trust read does the rest. The step runner is passed in.
 */
import type { LadybugBackend } from "./backend.js";
import type { LadybugReader } from "./ladybug/reader.js";
import type { Row } from "./engine.js";
import { edgeRule } from "./ladybug/ontology.js";
import { temporalEdgeTypes } from "./ladybug/temporal.js";
import { factClaimId, factEvidence, openFactQuestion, recordFactEvidence } from "./ladybug/fact-claims.js";
import { edgeRuleOf } from "./schema-resolver.js";
import type { Expectation } from "./fact-score.js";

const DAY = 86_400_000;
const q = (s: string) => `\`${s}\``;
const EDGE_TYPE = /^[A-Z][A-Z0-9_]*$/;
/** A quiet source counts against a fact, but less than someone saying it is false. */
const QUIET = -0.5;

/** What a check step is given: the fact, and the window to look in. */
export interface FactCheckInput {
  subject: { ref_id: string; name?: string; type?: string };
  edge_type: string;
  target: { ref_id: string; name?: string; type?: string };
  text: string;
  /** ISO: look for evidence since then. */
  since: string;
  window_days: number;
}

/** Runs one check step: what `runSingleStep` gives back, in short. */
export type RunCheck = (step: string, input: FactCheckInput, config: Record<string, unknown>) => Promise<{ status: string; output?: unknown }>;

export interface VerifyFactsReport {
  checked: number;
  supported: number;
  quiet: number;
  unavailable: number;
  failed: number;
  asked: number;
}

interface Held {
  ref_id: string;
  edge: string;
  text: string;
  namespace?: string;
  s: { ref_id: string; name?: string; type?: string };
  t: { ref_id: string; name?: string; type?: string };
}

const end = (r: Row, k: "s" | "t") => ({
  ref_id: String(r[`${k}_id`]),
  ...(typeof r[`${k}_name`] === "string" ? { name: String(r[`${k}_name`]) } : {}),
  ...(typeof r[`${k}_type`] === "string" ? { type: String(r[`${k}_type`]) } : {}),
});

/** Every current, live fact of `edge`. */
async function currentFacts(b: LadybugBackend, edge: string): Promise<Held[]> {
  if (!EDGE_TYPE.test(edge)) return [];
  const rows = await b.query(
    `MATCH (s:Node)-[r:${q(edge)}]->(t:Node) WHERE r.expired_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL AND t.deleted_at IS NULL
     RETURN r.ref_id AS id, r.text AS text, r.namespace AS ns, s.ref_id AS s_id, coalesce(s.title, s.name) AS s_name, s.node_type AS s_type,
            t.ref_id AS t_id, coalesce(t.title, t.name) AS t_name, t.node_type AS t_type`,
  ).catch(() => [] as Row[]);
  return rows.map((r) => ({
    ref_id: String(r["id"]),
    edge,
    text: String(r["text"] ?? ""),
    ...(typeof r["ns"] === "string" ? { namespace: r["ns"] } : {}),
    s: end(r, "s"),
    t: end(r, "t"),
  }));
}

/** A check's output as evidence: its strength and finding, or none. */
function resultOf(run: { status: string; output?: unknown }): { strength: number; content?: string } | "unavailable" | "failed" {
  if (run.status !== "success" || !run.output || typeof run.output !== "object") return "failed";
  const o = run.output as Record<string, unknown>;
  if (o["unavailable"] === true) return "unavailable";
  if (typeof o["supports"] !== "boolean") return "failed";
  return { strength: o["supports"] ? 1 : QUIET, ...(typeof o["content"] === "string" && o["content"] ? { content: o["content"] } : {}) };
}

/** Run the due checks and open the questions; `now` for tests. */
export async function verifyFacts(b: LadybugBackend, runCheck: RunCheck, opts: { now?: number } = {}): Promise<VerifyFactsReport> {
  const now = opts.now ?? Date.now();
  const report: VerifyFactsReport = { checked: 0, supported: 0, quiet: 0, unavailable: 0, failed: 0, asked: 0 };
  const run = (c: string, p?: Record<string, unknown>) => b.query(c, p);
  const types = await temporalEdgeTypes(run);
  const all: Held[] = [];
  for (const edge of types) {
    const facts = await currentFacts(b, edge);
    all.push(...facts);
    const expects: Expectation | undefined = edgeRuleOf((await edgeRule(run, edge)) ?? {}).expects;
    if (!expects || !facts.length) continue;
    const { evidence } = await factEvidence(run, facts.map((f) => factClaimId(f.s.ref_id, edge, f.t.ref_id)));
    for (const f of facts) {
      const mine = (evidence.get(factClaimId(f.s.ref_id, edge, f.t.ref_id)) ?? []).filter((x) => x.check === expects.step);
      const last = Math.max(0, ...mine.map((x) => x.observed_at));
      if (now - last < expects.every_days * DAY) continue;
      const window = expects.window_days ?? expects.every_days;
      const input: FactCheckInput = { subject: f.s, edge_type: edge, target: f.t, text: f.text, since: new Date(now - window * DAY).toISOString(), window_days: window };
      const result = resultOf(await runCheck(expects.step, input, expects.config ?? {}).catch(() => ({ status: "error" })));
      report.checked++;
      if (result === "unavailable" || result === "failed") {
        report[result]++;
        continue;
      }
      report[result.strength > 0 ? "supported" : "quiet"]++;
      await b.tx((tx) =>
        recordFactEvidence(tx, {
          subject: f.s.ref_id, edge, target: f.t.ref_id, text: f.text, ...(result.content ? { content: result.content } : {}),
          ...(f.namespace ? { namespace: f.namespace } : {}), check: expects.step, observed_at: now, strength: result.strength, now,
        }),
      );
    }
  }
  // An open question on each fact the read says to ask about, once.
  const trust = await (b.reader as LadybugReader).factTrust(all.map((f) => ({ ref_id: f.ref_id, edge_type: f.edge, subject: f.s.ref_id })));
  for (const f of all) {
    const t = trust.get(f.ref_id);
    if (t?.stance !== "ask" || t.open_check) continue;
    const opened = await b.tx((tx) =>
      openFactQuestion(tx, { subject: f.s.ref_id, edge: f.edge, target: f.t.ref_id, text: f.text, ...(f.namespace ? { namespace: f.namespace } : {}), observed_at: now, now }),
    );
    if (opened) report.asked++;
  }
  return report;
}
