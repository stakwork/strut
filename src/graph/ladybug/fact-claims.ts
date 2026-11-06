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
 * A check (its type's `expects`, `../memory-verify.ts`) writes `observed`
 * evidence named by its step. An `ask` is an external check: a `planned`
 * Evidence with no strength (a question waiting on the user), closed when
 * the claim's next evidence arrives. Deleting a fact clears its claim's
 * evidence, so saving it again starts from nothing.
 *
 * The vocabulary is the claim layer's (`../claims.ts`, `../seed-types.ts`);
 * times on the nodes are epoch SECONDS, as every jarvis datetime is.
 */
import { createHash, randomUUID } from "node:crypto";
import type { GraphTx, Params } from "../engine.js";
import { CLAIM_EDGES, CLAIM_TYPE, EVIDENCE_TYPE } from "../claims.js";
import { boundedName } from "../claims-writer.js";
import { edgeKeyFor } from "../edge-writer.js";
import type { EvidenceIn } from "../fact-score.js";

const q = (s: string) => `\`${s}\``;
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
/** The INT64 columns these writes set: a JS number is cast. */
const INTS = new Set(["created_at", "updated_at", "belief_valid_from", "observed_at"]);
const fields = (props: Record<string, unknown>, params: Params, prefix: string): string =>
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
  /** 1 backs it; −1 says it is false; a check's quiet result is weaker. */
  strength: number;
  /** The check step that observed it (`observed` evidence); absent for something said. */
  check?: string;
  /** What was observed, when not the fact's sentence (a check's finding). */
  content?: string;
  created_by?: string;
  now: number;
}

const claimRow = (claim: string) => `MATCH (c:Node {node_type: '${CLAIM_TYPE}'}) WHERE c.id = $claim`;

/** The claim's open question, if any: a planned slot waits on the user. */
async function closeSlots(tx: GraphTx, claim: string): Promise<void> {
  await tx.run(`${claimRow(claim)} MATCH (c)-[r:${q(CLAIM_EDGES.EVIDENCED_BY)}]->(e:Node) WHERE e.evidence_status = 'planned' DETACH DELETE e`, { claim });
}

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

/** Evidence node `id` under the claim, with its edge. */
async function writeEvidence(tx: GraphTx, claim: string, id: string, f: FactEvidence, status: "collected" | "planned"): Promise<void> {
  const base = { namespace: f.namespace, created_by: f.created_by, created_at: f.now, updated_at: f.now };
  const p: Params = { claim };
  const mode = f.check ? "observed" : "asserted";
  const ev = { ref_id: randomUUID(), node_type: EVIDENCE_TYPE, key: `evidence-${id}`, id, name: boundedName(f.content ?? f.text), content: f.content ?? f.text, evidence_mode: mode, evidence_status: status, observed_at: Math.floor(f.observed_at / 1000), ...base };
  await tx.run(`CREATE (:Node {${fields(ev, p, "e")}})`, p);
  const context = JSON.stringify({ ...(f.said_by ? { said_by: f.said_by } : {}), ...(f.message ? { message: f.message } : {}), ...(f.run ? { run: f.run } : {}), ...(f.check ? { check: f.check } : {}) });
  const rel = { ref_id: randomUUID(), edge_key: edgeKeyFor(CLAIM_EDGES.EVIDENCED_BY), ...(status === "collected" ? { strength: f.strength } : {}), context, ...base };
  await tx.run(
    `MATCH (c:Node {node_type: '${CLAIM_TYPE}'}), (e:Node {node_type: '${EVIDENCE_TYPE}'}) WHERE c.id = $claim AND e.id = $eid
     CREATE (c)-[:${q(CLAIM_EDGES.EVIDENCED_BY)} {${fields(rel, p, "r")}}]->(e)`,
    { ...p, eid: id },
  );
}

/**
 * The fact's claim (made the first time) and this piece of evidence, on the
 * caller's transaction; an open question on the claim is closed by it. The
 * same piece again (the same message or run from the same sayer, or the
 * same check on the same day) writes nothing. Returns whether it wrote.
 */
export async function recordFactEvidence(tx: GraphTx, f: FactEvidence): Promise<boolean> {
  const claim = factClaimId(f.subject, f.edge, f.target);
  const where = f.check ? `check:${f.check}:${Math.floor(f.observed_at / 86_400_000)}` : (f.message ?? f.run ?? `at:${f.observed_at}`);
  const id = hash(`${claim}|${where}|${f.said_by ?? ""}|${Math.sign(f.strength)}`);
  if ((await tx.run(`MATCH (e:Node {node_type: '${EVIDENCE_TYPE}'}) WHERE e.id = $id RETURN e.ref_id AS r LIMIT 1`, { id })).length) return false;
  await ensureClaim(tx, claim, f);
  await closeSlots(tx, claim);
  await writeEvidence(tx, claim, id, f, "collected");
  return true;
}

/** An open question on the fact's claim (an `ask`), unless one is open already. Returns whether it opened one. */
export async function openFactQuestion(tx: GraphTx, f: Omit<FactEvidence, "strength">): Promise<boolean> {
  const claim = factClaimId(f.subject, f.edge, f.target);
  const open = await tx.run(`${claimRow(claim)} MATCH (c)-[:${q(CLAIM_EDGES.EVIDENCED_BY)}]->(e:Node) WHERE e.evidence_status = 'planned' RETURN e.id AS id LIMIT 1`, { claim });
  if (open.length) return false;
  await ensureClaim(tx, claim, f);
  await writeEvidence(tx, claim, hash(`${claim}|ask|${f.observed_at}`), { ...f, strength: 0 }, "planned");
  return true;
}

/** A deleted fact's evidence, removed: saved again, it starts from nothing. */
export async function clearFactEvidence(tx: GraphTx, subject: string, edge: string, target: string): Promise<void> {
  const claim = factClaimId(subject, edge, target);
  await tx.run(`${claimRow(claim)} MATCH (c)-[:${q(CLAIM_EDGES.EVIDENCED_BY)}]->(e:Node {node_type: '${EVIDENCE_TYPE}'}) DETACH DELETE e`, { claim });
}

/** Each claim's collected evidence (by claim id), and the claims with an open question, for the trust read. */
export async function factEvidence(
  run: (cypher: string, params?: Params) => Promise<Array<Record<string, unknown>>>,
  claims: string[],
): Promise<{ evidence: Map<string, EvidenceIn[]>; open: Set<string> }> {
  const out = new Map<string, EvidenceIn[]>();
  const open = new Set<string>();
  if (!claims.length) return { evidence: out, open };
  const rows = await run(
    `UNWIND $ids AS id MATCH (c:Node {node_type: '${CLAIM_TYPE}'})-[r:${q(CLAIM_EDGES.EVIDENCED_BY)}]->(e:Node {node_type: '${EVIDENCE_TYPE}'})
     WHERE c.id = id AND c.deleted_at IS NULL AND e.deleted_at IS NULL
     RETURN id AS claim, e.id AS id, e.observed_at AS at, e.created_at AS made, e.evidence_status AS status, r.strength AS strength, r.context AS context`,
    { ids: claims },
  );
  for (const r of rows) {
    if (r["status"] === "planned") {
      open.add(String(r["claim"]));
      continue;
    }
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
      observed_at: at,
      strength: Number(r["strength"] ?? 0),
    });
    out.set(String(r["claim"]), list);
  }
  return { evidence: out, open };
}
