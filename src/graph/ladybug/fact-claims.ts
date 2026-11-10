/**
 * A memory fact on the truth layer (plans/memory-truth-layer.md), on a
 * Ladybug file: the fact's `Claim`, and one `Evidence` per time something
 * backed it, written by `assert` in its own transaction and read back by
 * the trust read (`reader.ts` `trustOf`, `../fact-score.ts`).
 *
 *   Claim {id: hash(subject, edge type, target)} —EVIDENCED_BY {strength, context}→ Evidence
 *
 * The claim is the statement ("Kate lives in Porto"), whatever edge holds
 * it now: an edge ended and asserted again is the same claim. Its id is
 * found from the fact, so the claim needs no edge to the fact's ends, and
 * neither node is searchable (no search text, no embedding): a graph read
 * never shows them beside the fact. Who said it, the message and the run
 * are the `EVIDENCED_BY` edge's `context` (JSON), as `HAS_SOURCE.context`
 * holds a run check's. An Evidence id is a hash of (claim, message or run,
 * sayer), so a message read again writes nothing.
 *
 * Deleting a fact clears its claim's evidence, so saving it again starts
 * from nothing.
 *
 * A kind of fact may have a `Check` (plans/memory-checks.md): one node per
 * edge type, found by a hash of it, holding what its facts should keep
 * producing (`description`), the step that looks (`step_type`, with
 * `step_config`), and how often (`freshness_days`). What a check finds is
 * `observed` evidence on the fact's claim, `Evidence -PRODUCED_BY-> Check`.
 * Only a read-only `graph/check-*` step can be a check (`isCheckStep`).
 *
 * The vocabulary is the claim layer's (`../claims.ts`, `../seed-types.ts`);
 * times on the nodes are epoch SECONDS, as every jarvis datetime is.
 */
import { createHash, randomUUID } from "node:crypto";
import type { GraphTx, Params } from "../engine.js";
import { CHECK_TYPE, CLAIM_EDGES, CLAIM_TYPE, EVIDENCE_TYPE } from "../claims.js";
import { boundedName } from "../claims-writer.js";
import { edgeKeyFor } from "../edge-writer.js";
import type { EvidenceIn } from "../fact-score.js";

const q = (s: string) => `\`${s}\``;
export const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
/** The INT64 columns these writes set: a JS number is cast. */
const INTS = new Set(["created_at", "updated_at", "belief_valid_from", "observed_at", "freshness_days"]);
export const fields = (props: Record<string, unknown>, params: Params, prefix: string): string =>
  Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v], i) => {
      params[`${prefix}${i}`] = v;
      return `${q(k)}: ${INTS.has(k) ? `CAST($${prefix}${i} AS INT64)` : `$${prefix}${i}`}`;
    })
    .join(", ");

/** A fact's claim id: the statement, not the edge that holds it now. */
export const factClaimId = (subject: string, edge: string, target: string): string => hash(`fact|${subject}|${edge}|${target}`);

export interface FactEvidence {
  subject: string;
  edge: string;
  target: string;
  text: string;
  namespace?: string;
  /** The Person who said it; none, the user. */
  said_by?: string;
  /** The message it was read from, and the run that asserted it. */
  message?: string;
  run?: string;
  /** When the evidence is from (epoch ms). */
  observed_at: number;
  /** 1 backs it; −1 says it is false; a check's finding is weaker. */
  strength: number;
  /** The check that found it (`observed` evidence); absent for something said. */
  check?: { id: string; step: string };
  /** What was found, when not the fact's sentence. */
  content?: string;
  created_by?: string;
  now: number;
}

/** A kind of fact's check, as stored. */
export interface FactCheck {
  id: string;
  edge: string;
  /** What its facts should keep producing while they hold, in plain words. */
  expects: string;
  step: string;
  freshness_days: number;
  window_days: number;
  /** Extra config the step is run with. */
  config: Record<string, unknown>;
}

/** The check for a kind of fact: one per edge type. */
export const factCheckId = (edge: string): string => hash(`fact-check|${edge}`);
/** The steps a check may run: memory's own read-only check steps. The step
 *  runner refuses any other (`checkRunner`); `ensureFactCheck` will not store one. */
export const isCheckStep = (step: string): boolean => /^graph\/check-[a-z0-9-]+$/.test(step);
/** A check's defaults: the first source, Peel's chats; looked at every two weeks, over a month. */
export const CHECK_DEFAULTS = { step: "graph/check-chats", freshness_days: 14, window_days: 30 } as const;

/** The check for `edge`, if it has one. */
export async function factCheckOf(run: (cypher: string, params?: Params) => Promise<Array<Record<string, unknown>>>, edge: string): Promise<FactCheck | null> {
  const [r] = await run(
    `MATCH (k:Node {node_type: '${CHECK_TYPE}'}) WHERE k.id = $id AND k.deleted_at IS NULL AND k.retired_at IS NULL
     RETURN k.description AS expects, k.step_type AS step, k.step_config AS config, k.freshness_days AS fresh LIMIT 1`,
    { id: factCheckId(edge) },
  );
  if (!r || typeof r["step"] !== "string") return null;
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(String(r["config"] ?? "{}")) as Record<string, unknown>;
  } catch {
    config = {};
  }
  const { window_days, ...rest } = config;
  return {
    id: factCheckId(edge), edge, expects: String(r["expects"] ?? ""), step: r["step"],
    freshness_days: Number(r["fresh"] ?? CHECK_DEFAULTS.freshness_days) || CHECK_DEFAULTS.freshness_days,
    window_days: typeof window_days === "number" && window_days > 0 ? window_days : CHECK_DEFAULTS.window_days,
    config: rest,
  };
}

/** The check for `edge`, made the first time it is given; an existing one is never changed. Returns whether it made one. */
export async function ensureFactCheck(
  tx: GraphTx,
  edge: string,
  c: { expects: string; step?: string; freshness_days?: number; window_days?: number },
  now: number,
  where: { namespace?: string; created_by?: string } = {},
): Promise<boolean> {
  const step = c.step ?? CHECK_DEFAULTS.step;
  if (!isCheckStep(step)) throw new Error(`${step} is not a check step: a check runs one of memory's read-only graph/check-* steps`);
  const id = factCheckId(edge);
  if ((await tx.run(`MATCH (k:Node {node_type: '${CHECK_TYPE}'}) WHERE k.id = $id RETURN k.ref_id AS r LIMIT 1`, { id })).length) return false;
  const p: Params = {};
  const props = {
    ref_id: randomUUID(), node_type: CHECK_TYPE, key: `check-${id}`, id, name: boundedName(`${edge}: ${c.expects}`), description: c.expects,
    step_type: step, step_config: JSON.stringify({ window_days: c.window_days ?? CHECK_DEFAULTS.window_days }),
    freshness_days: c.freshness_days ?? CHECK_DEFAULTS.freshness_days, policy: "on_change", run_when: "run",
    namespace: where.namespace, created_by: where.created_by, created_at: now, updated_at: now,
  };
  await tx.run(`CREATE (:Node {${fields(props, p, "k")}})`, p);
  return true;
}

const claimRow = (claim: string) => `MATCH (c:Node {node_type: '${CLAIM_TYPE}'}) WHERE c.id = $claim`;

/** The fact's claim, made the first time it is backed. */
async function ensureClaim(tx: GraphTx, claim: string, f: Pick<FactEvidence, "text" | "namespace" | "created_by" | "now" | "observed_at">): Promise<void> {
  if ((await tx.run(`${claimRow(claim)} RETURN c.ref_id AS r LIMIT 1`, { claim })).length) return;
  const p: Params = {};
  const props = {
    ref_id: randomUUID(), node_type: CLAIM_TYPE, key: `claim-${claim}`, id: claim, name: boundedName(f.text), claim_text: f.text,
    belief_valid_from: Math.floor(f.observed_at / 1000), namespace: f.namespace, created_by: f.created_by, created_at: f.now, updated_at: f.now,
  };
  await tx.run(`CREATE (:Node {${fields(props, p, "c")}})`, p);
}

/** Evidence node `id` under the claim, with its edge, and `PRODUCED_BY` its check when a check found it. */
async function writeEvidence(tx: GraphTx, claim: string, id: string, f: FactEvidence): Promise<void> {
  const base = { namespace: f.namespace, created_by: f.created_by, created_at: f.now, updated_at: f.now };
  const p: Params = { claim };
  const text = f.content ?? f.text;
  const ev = {
    ref_id: randomUUID(), node_type: EVIDENCE_TYPE, key: `evidence-${id}`, id, name: boundedName(text), content: text,
    evidence_mode: f.check ? "observed" : "asserted", evidence_status: "collected", observed_at: Math.floor(f.observed_at / 1000), ...base,
  };
  await tx.run(`CREATE (:Node {${fields(ev, p, "e")}})`, p);
  const context = JSON.stringify({
    ...(f.said_by ? { said_by: f.said_by } : {}), ...(f.message ? { message: f.message } : {}), ...(f.run ? { run: f.run } : {}),
    ...(f.check ? { check: f.check.step, check_id: f.check.id } : {}),
  });
  const rel = { ref_id: randomUUID(), edge_key: edgeKeyFor(CLAIM_EDGES.EVIDENCED_BY), strength: f.strength, context, ...base };
  await tx.run(
    `MATCH (c:Node {node_type: '${CLAIM_TYPE}'}), (e:Node {node_type: '${EVIDENCE_TYPE}'}) WHERE c.id = $claim AND e.id = $eid
     CREATE (c)-[:${q(CLAIM_EDGES.EVIDENCED_BY)} {${fields(rel, p, "r")}}]->(e)`,
    { ...p, eid: id },
  );
  if (f.check) {
    const pb = { ref_id: randomUUID(), edge_key: edgeKeyFor(CLAIM_EDGES.PRODUCED_BY), ...base };
    const pp: Params = { eid: id, kid: f.check.id };
    await tx.run(
      `MATCH (e:Node {node_type: '${EVIDENCE_TYPE}'}), (k:Node {node_type: '${CHECK_TYPE}'}) WHERE e.id = $eid AND k.id = $kid
       CREATE (e)-[:${q(CLAIM_EDGES.PRODUCED_BY)} {${fields(pb, pp, "b")}}]->(k)`,
      pp,
    );
  }
}


/**
 * The fact's claim (made the first time) and this piece of evidence, on the
 * caller's transaction. The same piece again (the same message or run from the same sayer, or the
 * same check on the same day) writes nothing. Returns whether it wrote.
 */
export async function recordFactEvidence(tx: GraphTx, f: FactEvidence): Promise<boolean> {
  const claim = factClaimId(f.subject, f.edge, f.target);
  const where = f.check ? `check:${f.check.id}:${Math.floor(f.observed_at / 86_400_000)}` : (f.message ?? f.run ?? `at:${f.observed_at}`);
  const id = hash(`${claim}|${where}|${f.said_by ?? ""}|${Math.sign(f.strength)}`);
  if ((await tx.run(`MATCH (e:Node {node_type: '${EVIDENCE_TYPE}'}) WHERE e.id = $id RETURN e.ref_id AS r LIMIT 1`, { id })).length) return false;
  await ensureClaim(tx, claim, f);
  await writeEvidence(tx, claim, id, f);
  return true;
}

/** A deleted fact's evidence, removed: saved again, it starts from nothing. */
export async function clearFactEvidence(tx: GraphTx, subject: string, edge: string, target: string): Promise<void> {
  const claim = factClaimId(subject, edge, target);
  await tx.run(`${claimRow(claim)} MATCH (c)-[:${q(CLAIM_EDGES.EVIDENCED_BY)}]->(e:Node {node_type: '${EVIDENCE_TYPE}'}) DETACH DELETE e`, { claim });
}

/** Each claim's live evidence (by claim id), for the trust read. */
export async function factEvidence(run: (cypher: string, params?: Params) => Promise<Array<Record<string, unknown>>>, claims: string[]): Promise<Map<string, EvidenceIn[]>> {
  const out = new Map<string, EvidenceIn[]>();
  if (!claims.length) return out;
  const rows = await run(
    `UNWIND $ids AS id MATCH (c:Node {node_type: '${CLAIM_TYPE}'})-[r:${q(CLAIM_EDGES.EVIDENCED_BY)}]->(e:Node {node_type: '${EVIDENCE_TYPE}'})
     WHERE c.id = id AND c.deleted_at IS NULL AND e.deleted_at IS NULL
     RETURN id AS claim, e.id AS id, e.observed_at AS at, e.created_at AS made, r.strength AS strength, r.context AS context`,
    { ids: claims },
  );
  for (const r of rows) {
    let context: Record<string, unknown> = {};
    try {
      context = JSON.parse(String(r["context"] ?? "{}")) as Record<string, unknown>;
    } catch {
      context = {};
    }
    const at = r["at"] === null || r["at"] === undefined ? Number(r["made"] ?? 0) : Number(r["at"]) * 1000;
    const list = out.get(String(r["claim"])) ?? [];
    list.push({
      id: String(r["id"]),
      ...(typeof context["said_by"] === "string" ? { said_by: context["said_by"] } : {}),
      ...(typeof context["check"] === "string" ? { check: context["check"] } : {}),
      ...(typeof context["check_id"] === "string" ? { check_id: context["check_id"] } : {}),
      observed_at: at,
      strength: Number(r["strength"] ?? 0),
    });
    out.set(String(r["claim"]), list);
  }
  return out;
}
