/**
 * Lessons on the truth layer (plans/dream.md), on a Ladybug file: how the
 * person's assistant should act, learned from what they said to it.
 *
 *   Claim {id: "lesson…"} —EVIDENCED_BY {strength, context}→ Evidence
 *
 * The same three nouns a memory fact uses (`fact-claims.ts`), and nothing
 * new in the ontology. The claim is one sentence that should hold ("Keep
 * summaries to three lines"); its `name` is a short title. Each piece of
 * evidence is one turn of a conversation: the person's words as `content`,
 * −1 when the turn shows the lesson broken (a correction), +1 when it shows
 * it kept (a confirmation). Which turn is the edge's `context` (JSON:
 * `session`, `turn`, `run`, `why`), as a fact's evidence names its message.
 *
 * A lesson's id is a hash of its first wording, prefixed `lesson`, so a
 * read tells a lesson from a fact's claim without another column. An
 * Evidence id is a hash of (lesson, turn, for or against): the same turn
 * read again writes nothing.
 *
 * How often a lesson was broken or kept is counted on read, never stored.
 */
import { randomUUID } from "node:crypto";
import type { GraphTx, Params } from "../engine.js";
import { CLAIM_EDGES, CLAIM_TYPE, EVIDENCE_TYPE } from "../claims.js";
import { boundedName } from "../claims-writer.js";
import { edgeKeyFor } from "../edge-writer.js";
import { fields, hash } from "./fact-claims.js";

const q = (s: string) => `\`${s}\``;

/** What every lesson's claim id starts with. */
export const LESSON_PREFIX = "lesson";
/** A new lesson's id, from its first wording. */
export const lessonId = (text: string): string => `${LESSON_PREFIX}${hash(`lesson|${text.trim().toLowerCase().replace(/\s+/g, " ")}`).slice(0, 24)}`;
export const isLessonId = (id: string): boolean => new RegExp(`^${LESSON_PREFIX}[0-9a-f]{24}$`).test(id);

export interface LessonEvidence {
  /** An existing lesson's id; absent, `text` names a new one (or the one with that wording). */
  lesson?: string;
  /** The lesson, one sentence that should hold. Needed for a new one. */
  text?: string;
  /** A short name for it; default the sentence. */
  title?: string;
  /** The conversation and the turn that shows it. */
  session: string;
  turn: number;
  run?: string;
  /** The person's words in that turn. */
  excerpt: string;
  /** Why the turn bears on the lesson, in a line. */
  why?: string;
  /** −1 the turn shows it broken; +1 shows it kept. */
  strength: 1 | -1;
  /** When the turn was (epoch ms). */
  observed_at: number;
  namespace?: string;
  created_by?: string;
  now: number;
}

export interface LessonWrite {
  lesson: string;
  /** The lesson was made by this call. */
  created: boolean;
  /** The evidence was new: false when this turn already backed it the same way. */
  recorded: boolean;
}

/** The lesson (made the first time) and this turn as evidence, on the caller's transaction. */
export async function recordLesson(tx: GraphTx, l: LessonEvidence): Promise<LessonWrite> {
  const id = l.lesson ?? (l.text?.trim() ? lessonId(l.text) : "");
  if (!isLessonId(id)) throw new Error(l.lesson ? `"${l.lesson}" is not a lesson id` : "a new lesson needs `text`: one sentence that should hold");
  const base = { namespace: l.namespace, created_by: l.created_by, created_at: l.now, updated_at: l.now };
  const held = (await tx.run(`MATCH (c:Node {node_type: '${CLAIM_TYPE}'}) WHERE c.id = $id AND c.deleted_at IS NULL RETURN c.ref_id AS r LIMIT 1`, { id })).length > 0;
  if (!held) {
    if (!l.text?.trim()) throw new Error(`no lesson "${id}": pass \`text\` to make one`);
    const p: Params = {};
    const text = l.text.trim();
    const claim = {
      ref_id: randomUUID(), node_type: CLAIM_TYPE, key: `claim-${id}`, id, name: boundedName(l.title?.trim() || text), claim_text: text,
      speaker_name: l.created_by, belief_valid_from: Math.floor(l.observed_at / 1000), ...base,
    };
    await tx.run(`CREATE (:Node {${fields(claim, p, "c")}})`, p);
  }
  const eid = hash(`${id}|${l.session}#${l.turn}|${l.strength}`);
  if ((await tx.run(`MATCH (e:Node {node_type: '${EVIDENCE_TYPE}'}) WHERE e.id = $eid RETURN e.ref_id AS r LIMIT 1`, { eid })).length) return { lesson: id, created: !held, recorded: false };
  const p: Params = {};
  const ev = {
    ref_id: randomUUID(), node_type: EVIDENCE_TYPE, key: `evidence-${eid}`, id: eid, name: boundedName(l.excerpt), content: l.excerpt,
    evidence_mode: "asserted", evidence_status: "collected", observed_at: Math.floor(l.observed_at / 1000), ...base,
  };
  await tx.run(`CREATE (:Node {${fields(ev, p, "e")}})`, p);
  const context = JSON.stringify({ session: l.session, turn: l.turn, ...(l.run ? { run: l.run } : {}), ...(l.why ? { why: l.why } : {}) });
  const rp: Params = { id, eid };
  const rel = { ref_id: randomUUID(), edge_key: edgeKeyFor(CLAIM_EDGES.EVIDENCED_BY), strength: l.strength, context, ...base };
  await tx.run(
    `MATCH (c:Node {node_type: '${CLAIM_TYPE}'}), (e:Node {node_type: '${EVIDENCE_TYPE}'}) WHERE c.id = $id AND e.id = $eid
     CREATE (c)-[:${q(CLAIM_EDGES.EVIDENCED_BY)} {${fields(rel, rp, "r")}}]->(e)`,
    rp,
  );
  return { lesson: id, created: !held, recorded: true };
}

export interface LessonTurn {
  session: string;
  turn: number;
  run?: string;
  excerpt: string;
  why?: string;
  /** The turn shows the lesson broken (a correction), or kept. */
  against: boolean;
  at: string;
}

export interface Lesson {
  id: string;
  title: string;
  text: string;
  /** When it was first learned. */
  since: string;
  /** Turns that showed it broken, and kept. Counted here, never stored. */
  against: number;
  for: number;
  /** The newest piece of evidence. */
  last?: string;
  /** Its evidence, newest first. */
  evidence: LessonTurn[];
}

/** Every lesson in `namespace` with its evidence, the most corrected first. */
export async function listLessons(tx: GraphTx, namespace: string | undefined): Promise<Lesson[]> {
  const rows = await tx.run(
    `MATCH (c:Node {node_type: '${CLAIM_TYPE}'}) WHERE c.id STARTS WITH '${LESSON_PREFIX}' AND c.deleted_at IS NULL${namespace ? " AND c.namespace = $ns" : ""}
     OPTIONAL MATCH (c)-[r:${q(CLAIM_EDGES.EVIDENCED_BY)}]->(e:Node {node_type: '${EVIDENCE_TYPE}'})
     RETURN c.id AS id, c.name AS title, c.claim_text AS text, c.created_at AS made, e.content AS excerpt, e.observed_at AS at, e.deleted_at AS gone, r.strength AS strength, r.context AS context`,
    namespace ? { ns: namespace } : {},
  );
  const out = new Map<string, Lesson>();
  for (const r of rows) {
    const id = String(r["id"]);
    if (!isLessonId(id)) continue;
    const lesson = out.get(id) ?? { id, title: String(r["title"] ?? ""), text: String(r["text"] ?? ""), since: new Date(Number(r["made"] ?? 0)).toISOString(), against: 0, for: 0, evidence: [] };
    out.set(id, lesson);
    if (r["excerpt"] === null || r["excerpt"] === undefined || (r["gone"] !== null && r["gone"] !== undefined)) continue;
    let context: Record<string, unknown> = {};
    try {
      context = JSON.parse(String(r["context"] ?? "{}")) as Record<string, unknown>;
    } catch {
      context = {};
    }
    const against = Number(r["strength"] ?? 0) < 0;
    if (against) lesson.against++;
    else lesson.for++;
    lesson.evidence.push({
      session: String(context["session"] ?? ""),
      turn: Number(context["turn"] ?? 0),
      ...(typeof context["run"] === "string" ? { run: context["run"] } : {}),
      excerpt: String(r["excerpt"]),
      ...(typeof context["why"] === "string" ? { why: context["why"] } : {}),
      against,
      at: new Date(Number(r["at"] ?? 0) * 1000).toISOString(),
    });
  }
  for (const l of out.values()) {
    l.evidence.sort((a, b) => b.at.localeCompare(a.at));
    if (l.evidence[0]) l.last = l.evidence[0].at;
  }
  return [...out.values()].sort((a, b) => b.against - a.against || (b.last ?? b.since).localeCompare(a.last ?? a.since));
}
