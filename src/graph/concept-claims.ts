/**
 * Claims about a Concept (plans/dream.md): what a tree of Concept pages
 * should say, each with the things people said that bear on it.
 *
 *   Claim —ABOUT→ Concept                      the page that holds it, or should
 *   Claim —EVIDENCED_BY {strength, context}→ Evidence
 *   Claim —PARENT_OF→ Claim                    a group: claims of one kind
 *
 * The truth layer's own nouns (`claims.ts`), written through the node and
 * edge writers, so the same on a Ladybug file and on Neo4j. The claim is one
 * sentence that should hold ("Summaries are three lines or fewer"). Each
 * piece of evidence is one thing somebody said, and keeps two things apart:
 *
 *   - `strength`, as a fact's evidence has it: +1 the sayer says the claim
 *     is right, −1 that it is wrong. Trust reads it as it reads a fact's;
 *   - `outcome` (in the edge's `context`): what the assistant did there —
 *     no page had it, a page had it and was not opened, it was opened and
 *     not followed, a page said the opposite, or it was followed.
 *
 * "Too long, keep summaries to three lines" says the claim is RIGHT (+1) and
 * that the assistant got it wrong (an outcome): one is not the other.
 *
 * The `context` also names the source, the place in it (`session`, `turn`,
 * `run`), who said it, and the dream that found it. An Evidence id is a hash
 * of (claim, source, place, for or against), so the same words read again
 * write nothing. A parent claim holds no evidence: its counts are its
 * children's, added up on read. Nothing is counted in the graph.
 */
import { createHash } from "node:crypto";
import type { GraphBackend } from "./backend.js";
import { CLAIM_EDGES, CLAIM_TYPE, EVIDENCE_TYPE } from "./claims.js";
import { boundedName } from "./claims-writer.js";
import { CONCEPT_TYPE } from "./seed-types.js";

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const q = (s: string) => `\`${s}\``;
/** The Concept tree's edge (`seed-types.ts`), and a group's. */
const PARENT_OF = "PARENT_OF";

/** What the assistant did where the thing was said. */
export const OUTCOMES = ["missing", "not_opened", "not_followed", "contradicted", "followed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** The outcomes that are a correction: every one but `followed`. */
export const isCorrection = (o: Outcome | undefined): boolean => !!o && o !== "followed";

/** What the store needs of a backend: its writers, its dialect, and a query a reader's list does not gate
 *  (`scope.ts` `boundsOf`) — the caller checks the namespace itself. */
export type ClaimGraph = Pick<GraphBackend, "dialect" | "nodes" | "edges"> & { query: GraphBackend["query"] };

/** A claim's id: the sentence on that Concept. The same sentence about another Concept is another claim. */
export const conceptClaimId = (about: string, text: string): string => hash(`concept-claim|${about}|${norm(text)}`);
/** A group's id: its sentence. */
export const groupClaimId = (text: string): string => hash(`claim-group|${norm(text)}`);

export interface Said {
  /** An existing claim's id; absent, `text` and `about` name a new one (or the one with that wording there). */
  claim?: string;
  text?: string;
  title?: string;
  /** The Concept the claim is about: its ref_id. Needed for a new claim. */
  about?: string;
  /** A group to put a NEW claim under: the parent claim's id. */
  parent?: string;
  /** Where it was said: the kind of source, and the place in it. */
  source: string;
  session: string;
  turn: number;
  run?: string;
  /** Who said it; absent, the graph's owner. */
  said_by?: string;
  /** Their words. */
  excerpt: string;
  /** What the assistant did, and what was wanted, in a line. */
  why?: string;
  /** The sayer says the claim is WRONG. Default: they say it is right. */
  denies?: boolean;
  outcome: Outcome;
  /** When it was said (epoch ms). */
  observed_at: number;
  /** The run that found it. */
  dream?: string;
  namespace?: string;
  created_by?: string;
}

export interface SaidWrite {
  claim: string;
  /** The claim was made by this call. */
  created: boolean;
  /** The evidence was new: false when these words already bore on the claim the same way. */
  recorded: boolean;
}

/** The node pattern's properties: the namespace when one is named, with `more`; none at all when there are none. */
const nsProps = (namespace: string | undefined, more: Record<string, string> = {}): Record<string, string> | undefined => {
  const props = { ...(namespace ? { namespace: "$ns" } : {}), ...more };
  return Object.keys(props).length ? props : undefined;
};
const nsParams = (namespace: string | undefined): Record<string, unknown> => (namespace ? { ns: namespace } : {});
const seconds = (ms: number) => Math.floor(ms / 1000);

async function claimRef(g: ClaimGraph, namespace: string | undefined, id: string): Promise<string | null> {
  const d = g.dialect;
  const rows = await g.query(`MATCH ${d.node("c", CLAIM_TYPE, nsProps(namespace, { id: "$id" }))} WHERE ${d.live("c")} RETURN c.ref_id AS r LIMIT 1`, { ...nsParams(namespace), id });
  return typeof rows[0]?.["r"] === "string" ? (rows[0]!["r"] as string) : null;
}

async function conceptRef(g: ClaimGraph, ref: string): Promise<boolean> {
  const d = g.dialect;
  return (await g.query(`MATCH ${d.node("p", CONCEPT_TYPE, { ref_id: "$ref" })} WHERE ${d.live("p")} RETURN p.ref_id AS r LIMIT 1`, { ref })).length > 0;
}

async function writeClaim(g: ClaimGraph, c: { id: string; text: string; title?: string; at: number; speaker?: string; namespace?: string; created_by?: string }): Promise<{ ref_id: string; created: boolean }> {
  const text = c.text.trim();
  const r = await g.nodes.write(
    {
      type: CLAIM_TYPE,
      data: { id: c.id, name: boundedName(c.title?.trim() || text), claim_text: text, belief_valid_from: seconds(c.at), ...(c.speaker ? { speaker_name: c.speaker } : {}) },
      ...(c.created_by ? { created_by: c.created_by } : {}),
    },
    "create",
    c.namespace ? { namespace: c.namespace } : {},
  );
  return { ref_id: r.ref_id, created: r.outcome === "created" };
}

const edgeBase = (s: { namespace?: string; created_by?: string }) => ({ ...(s.namespace ? { namespace: s.namespace } : {}), ...(s.created_by ? { created_by: s.created_by } : {}) });

/** The claim (made the first time, about its Concept and under its group) and these words as evidence. */
export async function recordSaid(g: ClaimGraph, s: Said): Promise<SaidWrite> {
  if (!s.excerpt.trim()) throw new Error("the evidence is what was said: `excerpt` is empty");
  let id = s.claim;
  let ref: string | null = null;
  let created = false;
  if (id) {
    ref = await claimRef(g, s.namespace, id);
    if (!ref) throw new Error(`no claim "${id}": pass \`text\` and \`about\` to make one`);
  } else {
    if (!s.text?.trim() || !s.about) throw new Error("a new claim needs `text` (one sentence that should hold) and `about` (the Concept it belongs on)");
    if (!(await conceptRef(g, s.about))) throw new Error(`"${s.about}" is not a Concept: \`about\` is the ref_id of the page the claim belongs on`);
    const parent = s.parent ? await claimRef(g, s.namespace, s.parent) : null;
    if (s.parent && !parent) throw new Error(`no claim "${s.parent}" to group it under`);
    id = conceptClaimId(s.about, s.text);
    const w = await writeClaim(g, { id, text: s.text, ...(s.title ? { title: s.title } : {}), at: s.observed_at, ...(s.said_by ? { speaker: s.said_by } : {}), ...edgeBase(s) });
    ref = w.ref_id;
    created = w.created;
    if (created) {
      await g.edges.writeMany([
        ...(parent ? [{ edge: PARENT_OF, source_ref_id: parent, target_ref_id: ref, ...edgeBase(s) }] : []),
        // ABOUT last: it is what makes the claim show.
        { edge: CLAIM_EDGES.ABOUT, source_ref_id: ref, target_ref_id: s.about, ...edgeBase(s) },
      ]);
    }
  }
  const strength = s.denies ? -1 : 1;
  const eid = hash(`${id}|${s.source}|${s.session}#${s.turn}|${strength}`);
  const node = await g.nodes.write(
    {
      type: EVIDENCE_TYPE,
      data: { id: eid, name: boundedName(s.excerpt), content: s.excerpt.trim(), evidence_mode: "asserted", evidence_status: "collected", observed_at: seconds(s.observed_at) },
      ...(s.created_by ? { created_by: s.created_by } : {}),
    },
    "create",
    s.namespace ? { namespace: s.namespace } : {},
  );
  if (node.outcome !== "created") return { claim: id, created, recorded: false };
  const context = JSON.stringify({
    source: s.source, session: s.session, turn: s.turn, outcome: s.outcome,
    ...(s.run ? { run: s.run } : {}), ...(s.said_by ? { said_by: s.said_by } : {}), ...(s.why ? { why: s.why } : {}), ...(s.dream ? { dream: s.dream } : {}),
  });
  await g.edges.write({ edge: CLAIM_EDGES.EVIDENCED_BY, source_ref_id: ref, target_ref_id: node.ref_id, properties: { strength, context }, ...edgeBase(s) });
  return { claim: id, created, recorded: true };
}

/** Claims of one kind put under a parent claim, made the first time. A claim already under it stays; one under
 *  another parent, or a parent itself, is refused. The parent is about the Concept `about` names. */
export async function groupClaims(
  g: ClaimGraph,
  input: { text: string; title?: string; about: string; claims: string[]; at: number; namespace?: string; created_by?: string },
): Promise<{ claim: string; created: boolean; grouped: string[] }> {
  if (!input.text.trim()) throw new Error("a group needs `text`: the sentence its claims have in common");
  if (!input.claims.length) throw new Error("a group needs the claims it holds");
  if (!(await conceptRef(g, input.about))) throw new Error(`"${input.about}" is not a Concept`);
  const d = g.dialect;
  const id = groupClaimId(input.text);
  const children: Array<{ id: string; ref: string }> = [];
  for (const c of [...new Set(input.claims)]) {
    const ref = await claimRef(g, input.namespace, c);
    if (!ref) throw new Error(`no claim "${c}"`);
    if (c === id) throw new Error("a group cannot hold itself");
    children.push({ id: c, ref });
  }
  const held = await g.query(
    `MATCH ${d.node("x", CLAIM_TYPE)}-[po:${q(PARENT_OF)}]->${d.node("c", CLAIM_TYPE)} WHERE c.id IN $ids AND ${d.edgeLive("po")} AND ${d.live("x")} RETURN x.id AS parent, c.id AS child`,
    { ids: children.map((c) => c.id) },
  );
  const under = new Map(held.map((r) => [String(r["child"]), String(r["parent"])]));
  const elsewhere = children.find((c) => under.has(c.id) && under.get(c.id) !== id);
  if (elsewhere) throw new Error(`claim "${elsewhere.id}" is already in the group "${under.get(elsewhere.id)}": one level of groups, one group each`);
  const parents = await g.query(
    `MATCH ${d.node("c", CLAIM_TYPE)}-[po:${q(PARENT_OF)}]->${d.node("k", CLAIM_TYPE)} WHERE c.id IN $ids AND ${d.edgeLive("po")} AND ${d.live("k")} RETURN c.id AS id LIMIT 1`,
    { ids: children.map((c) => c.id) },
  );
  if (parents.length) throw new Error(`claim "${String(parents[0]!["id"])}" is a group: one level of groups`);
  const w = await writeClaim(g, { id, text: input.text, ...(input.title ? { title: input.title } : {}), at: input.at, ...edgeBase(input) });
  const fresh = children.filter((c) => !under.has(c.id));
  await g.edges.writeMany([
    ...fresh.map((c) => ({ edge: PARENT_OF, source_ref_id: w.ref_id, target_ref_id: c.ref, ...edgeBase(input) })),
    ...(w.created ? [{ edge: CLAIM_EDGES.ABOUT, source_ref_id: w.ref_id, target_ref_id: input.about, ...edgeBase(input) }] : []),
  ]);
  return { claim: id, created: w.created, grouped: fresh.map((c) => c.id) };
}

export interface SaidRow {
  source: string;
  session: string;
  turn: number;
  run?: string;
  said_by?: string;
  excerpt: string;
  why?: string;
  /** The sayer said the claim is wrong. */
  denies: boolean;
  outcome?: Outcome;
  at: string;
  /** The run that found it. */
  dream?: string;
}

export interface ConceptClaim {
  id: string;
  title: string;
  text: string;
  since: string;
  /** The Concept it is about: its ref_id and name. */
  about: string;
  concept: string;
  /** The group it is under. */
  parent?: string;
  /** The claims under it, when it is a group. */
  children?: string[];
  /** Times the assistant got it wrong, and right: its own evidence, or its children's. Counted here, never stored. */
  corrected: number;
  kept: number;
  /** The newest piece of evidence, its own or a child's. */
  last?: string;
  /** Its own evidence, newest first. A group has none. */
  evidence: SaidRow[];
}

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number((v as { toNumber?: () => number } | null)?.toNumber?.() ?? v ?? 0));

/** Is there a Concept named `name` (a tree's root) in `namespace`? */
export async function conceptNamed(g: ClaimGraph, namespace: string | undefined, name: string): Promise<boolean> {
  const d = g.dialect;
  return (await g.query(`MATCH ${d.node("r", CONCEPT_TYPE, nsProps(namespace, { name: "$name" }))} WHERE ${d.live("r")} RETURN r.ref_id AS r LIMIT 1`, { ...nsParams(namespace), name })).length > 0;
}

/** The ref_ids of `root` (a Concept's name) and every Concept under it; null when there is no such root. */
async function treeOf(g: ClaimGraph, namespace: string | undefined, root: string): Promise<Set<string> | null> {
  const d = g.dialect;
  const roots = await g.query(`MATCH ${d.node("r", CONCEPT_TYPE, nsProps(namespace, { name: "$root" }))} WHERE ${d.live("r")} RETURN r.ref_id AS r`, { ...nsParams(namespace), root });
  if (!roots.length) return null;
  const edges = await g.query(
    `MATCH ${d.node("a", CONCEPT_TYPE)}-[po:${q(PARENT_OF)}]->${d.node("b", CONCEPT_TYPE)} WHERE ${d.edgeLive("po")} AND ${d.live("a")} AND ${d.live("b")} RETURN a.ref_id AS a, b.ref_id AS b`,
  );
  const kids = new Map<string, string[]>();
  for (const e of edges) kids.set(String(e["a"]), [...(kids.get(String(e["a"])) ?? []), String(e["b"])]);
  const seen = new Set<string>(roots.map((r) => String(r["r"])));
  const todo = [...seen];
  while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) if (!seen.has(k)) (seen.add(k), todo.push(k));
  return seen;
}

/** Every claim about a Concept with what was said for it, the most corrected first; with `root`, those about a
 *  Concept of that tree. A group lists its children and adds up their counts. */
export async function listClaims(g: ClaimGraph, namespace: string | undefined, root?: string): Promise<ConceptClaim[]> {
  const d = g.dialect;
  const tree = root ? await treeOf(g, namespace, root) : undefined;
  if (tree === null) return [];
  const rows = await g.query(
    `MATCH ${d.node("c", CLAIM_TYPE, nsProps(namespace))}-[a:${q(CLAIM_EDGES.ABOUT)}]->${d.node("p", CONCEPT_TYPE)}
     WHERE ${d.live("c")} AND ${d.edgeLive("a")} AND ${d.live("p")} AND c.belief_valid_to IS NULL
     RETURN c.id AS id, c.name AS title, c.claim_text AS text, c.belief_valid_from AS since, p.ref_id AS about, p.name AS concept`,
    nsParams(namespace),
  );
  const out = new Map<string, ConceptClaim>();
  for (const r of rows) {
    if (tree && !tree.has(String(r["about"]))) continue;
    out.set(String(r["id"]), {
      id: String(r["id"]), title: String(r["title"] ?? ""), text: String(r["text"] ?? ""), since: new Date(num(r["since"]) * 1000).toISOString(),
      about: String(r["about"]), concept: String(r["concept"] ?? ""), corrected: 0, kept: 0, evidence: [],
    });
  }
  const ids = [...out.keys()];
  if (!ids.length) return [];
  const said = await g.query(
    `MATCH ${d.node("c", CLAIM_TYPE)}-[eb:${q(CLAIM_EDGES.EVIDENCED_BY)}]->${d.node("e", EVIDENCE_TYPE)}
     WHERE c.id IN $ids AND ${d.edgeLive("eb")} AND ${d.live("e")}
     RETURN c.id AS id, e.content AS excerpt, e.observed_at AS at, eb.strength AS strength, eb.context AS context`,
    { ids },
  );
  for (const r of said) {
    const claim = out.get(String(r["id"]));
    if (!claim) continue;
    let context: Record<string, unknown> = {};
    try {
      context = JSON.parse(String(r["context"] ?? "{}")) as Record<string, unknown>;
    } catch {
      context = {};
    }
    const outcome = (OUTCOMES as readonly string[]).includes(String(context["outcome"])) ? (context["outcome"] as Outcome) : undefined;
    if (outcome === "followed") claim.kept++;
    else if (isCorrection(outcome)) claim.corrected++;
    const str = (k: string) => (typeof context[k] === "string" ? { [k]: context[k] as string } : {});
    claim.evidence.push({
      source: String(context["source"] ?? ""), session: String(context["session"] ?? ""), turn: num(context["turn"]),
      ...str("run"), ...str("said_by"), excerpt: String(r["excerpt"] ?? ""), ...str("why"),
      denies: num(r["strength"]) < 0, ...(outcome ? { outcome } : {}), at: new Date(num(r["at"]) * 1000).toISOString(), ...str("dream"),
    } as SaidRow);
  }
  const groups = await g.query(
    `MATCH ${d.node("x", CLAIM_TYPE)}-[po:${q(PARENT_OF)}]->${d.node("c", CLAIM_TYPE)} WHERE c.id IN $ids AND x.id IN $ids AND ${d.edgeLive("po")} RETURN x.id AS parent, c.id AS child`,
    { ids },
  );
  for (const r of groups) {
    const parent = out.get(String(r["parent"]));
    const child = out.get(String(r["child"]));
    if (!parent || !child) continue;
    child.parent = parent.id;
    parent.children = [...(parent.children ?? []), child.id];
  }
  for (const c of out.values()) {
    c.evidence.sort((a, b) => b.at.localeCompare(a.at));
    if (c.evidence[0]) c.last = c.evidence[0].at;
  }
  for (const c of out.values()) {
    if (!c.children) continue;
    for (const k of c.children.map((id) => out.get(id)!)) {
      c.corrected += k.corrected;
      c.kept += k.kept;
      if (k.last && (!c.last || k.last > c.last)) c.last = k.last;
    }
    c.children.sort();
  }
  return [...out.values()].sort((a, b) => b.corrected - a.corrected || (b.last ?? b.since).localeCompare(a.last ?? a.since));
}

/** The Concepts a run opened (the projector's `StrutRun -ACCESSED-> Concept`), by name; null when the run is not
 *  on the graph, so "opened none" and "not known" are told apart. */
export async function conceptsOpenedBy(g: ClaimGraph, runId: string): Promise<string[] | null> {
  const d = g.dialect;
  if (!(await g.query(`MATCH ${d.node("r", "StrutRun", { run_id: "$run" })} RETURN r.ref_id AS r LIMIT 1`, { run: runId })).length) return null;
  const rows = await g.query(
    `MATCH ${d.node("r", "StrutRun", { run_id: "$run" })}-[ac:${q("ACCESSED")}]->${d.node("p", CONCEPT_TYPE)} WHERE ${d.live("p")} RETURN DISTINCT p.name AS name`,
    { run: runId },
  );
  return rows.map((r) => String(r["name"] ?? "")).filter(Boolean).sort();
}
