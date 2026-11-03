// The memory benchmark (scripts/bench-memory.json, from stakwork/strut#162's
// scripts/bench-memory.ts) on the workspace graph, through the generic tools
// Peel's assistant uses: `npm run bench:memory-graph [-- --embed] [-- --verbose]`.
//
// Seeds a temp LadybugDB the way the assistant would: graph/resolve each
// entity, graph/create-node when there is none, graph/assert each fact
// (create_schema_if_missing), graph/merge for the fixture's merge. Then runs
// every labelled query through graph/graph-search with `facts: true`, and the
// 48 duplicate probes through graph/resolve and graph/duplicates. Prints the
// same metrics as the original: recall@1, recall@5, MRR, negatives, latency.
//
// The fixture is the old memory's: a fact with no object ("Kate is
// pescatarian") has no node to point at. The graph keeps such a fact as an
// edge to a node holding its value (plans/graph-memory-prd.md: "oat milk
// becomes a Topic"), which a model extracts; VALUES below is that
// extraction, by hand. A name fact becomes the subject's alt_names and a
// summary its description, so their labels are the subject node's. Search
// returns nodes and facts as two ranked lists; one list is made by taking
// them in turn, node first, or with `--rank score` by score across both.
// `--embed` loads MiniLM (all-MiniLM-L6-v2) for the vector half of search;
// without it search is keyword only. Lives in scripts/, outside the build.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../src/core.js";
import { openGraphBackend, type GraphBackend } from "../src/graph/backend.js";
import { PRIVATE_NAMESPACE } from "../src/graph/ladybug/namespaces.js";
import { LADYBUG_EDGE_TYPES } from "../src/graph/ladybug/registry.js";
import type { Embedder } from "../src/graph/node-writer.js";
import { createNodeSchema } from "../src/graph/schema-crud.js";
import { SEED } from "../src/steps/lib/memory/_ontology-seed.js";
import assertStep from "../src/steps/lib/graph/assert.js";
import createNode from "../src/steps/lib/graph/create-node.js";
import deleteNode from "../src/steps/lib/graph/delete-node.js";
import duplicates from "../src/steps/lib/graph/duplicates.js";
import graphSearch from "../src/steps/lib/graph/graph-search.js";
import merge from "../src/steps/lib/graph/merge.js";
import resolve from "../src/steps/lib/graph/resolve.js";

type FactRow = [id: string, subject: string, predicate: string, object: string | null, text: string, supersede?: boolean];
type Episode = { t: string; f: FactRow[] };
type Q = { kind: string; q: string; type?: string; expect: string[]; not?: string[] };
type Fixture = {
  episodes: Episode[];
  merges: [keep: string, duplicate: string][];
  queries: Q[];
  heldout: { episodes: Episode[]; queries: Q[] };
  dedupe: { seed: string[]; probes: { probe: string; match: string | null; auto?: false }[] };
};
type Step = { input: { parse(v: unknown): any }; run(cfg: any, ctx: StepContext): Promise<any> };

/** What a model would make the node of a fact with no object: its value. */
const VALUES: Record<string, string> = {
  me_diet_old: "vegetarian", me_coffee_old: "double espresso", mia_age_old: "six", proj_peel_deadline_old: "end of October",
  task_dentist_due_old: "Friday", me_diet: "vegan", me_coffee: "flat white with oat milk", me_dislikes_coriander: "coriander",
  me_prefers_window: "window seat", me_birthday: "14 March", me_allergy: "penicillin", me_car: "2019 Volkswagen Golf",
  me_morning: "meetings after 10am", me_music: "Radiohead", me_pet: "Biscuit", kate_prefers_cooking: "Thai cooking",
  kate_diet: "pescatarian", kate_birthday: "2 June", kate_kids: "Ollie and Fern", katherine_photos: "wedding photos",
  jon_prefers_cycling: "cycling to work", jon_dislikes: "open-plan offices", priya_diet: "vegetarian", priya_prefers: "jazz records",
  marcus_prefers: "Arsenal", marcus_diet: "no pork", elena_prefers: "opera", dave_prefers: "sourdough baking",
  bob_prefers: "text messages", liz_prefers: "wild swimming", task_tax_due: "31 January", sofia_prefers: "tapas and flamenco",
  rose_birthday: "5 December", rose_prefers: "lemon drizzle cake", task_dentist_due: "next Wednesday", sam_diet: "gluten-free",
  sam_prefers: "hiking in the Brecon Beacons", mia_prefers: "dinosaurs and drawing", mia_allergy: "peanuts", mia_age: "seven",
  leo_prefers: "trains", leo_dislikes: "broccoli", tomasz_prefers: "bank transfer", proj_kitchen: "£18,000",
  proj_kitchen_due: "1 December", org_hangar: "Feeder Road", proj_peel_deadline: "end of November", task_mot: "October",
  task_bill: "the 28th", me_fishing: "sea fishing", me_cake: "rich chocolate cake",
};
const VALUE_TYPE = "Topic";
/** The plain edge types a fresh file holds (ABOUT, PARENT_OF, …): a predicate naming one gets IS_. */
const PLAIN = new Set(LADYBUG_EDGE_TYPES);

const ONE = new Set(SEED.filter((t) => t.kind === "predicate" && t.cardinality === "one").map((t) => t.name));
const NAMING = new Set(SEED.filter((t) => t.kind === "predicate" && t.role === "alias").map((t) => t.name));
const nameIn = (text: string) => /\b(?:name is|named|called)\s+(.+?)\.?$/i.exec(text)?.[1]?.trim();

const call = (step: unknown, input: unknown, ctx: StepContext) => (step as Step).run((step as Step).input.parse(input), ctx);
const ok = <T>(out: T, what: string): T => {
  if (typeof out === "string") throw new Error(`${what}: ${out}`);
  return out;
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const split = (s: string) => {
  const i = s.indexOf(":");
  return { type: s.slice(0, i), name: s.slice(i + 1) };
};

type Scores = {
  byKind: Record<string, { n: number; r1: number; r5: number; mrr: number }>;
  overall: { n: number; r1: number; r5: number; mrr: number; noise5: number };
  negatives: { n: number; withHits: number };
  notViolations: number;
  latency: { p50: number; p95: number };
  misses: string[];
};
type PR = { tp: number; fp: number; positives: number; precision: number; recall: number };
const pr = (x: { tp: number; fp: number; positives: number }): PR => ({ ...x, precision: x.tp + x.fp ? x.tp / (x.tp + x.fp) : 1, recall: x.positives ? x.tp / x.positives : 1 });

/** A seeded graph, read through the tools. Labels: e:Type:Name for an
 *  entity, f:<id> for a fact; one ref may carry several (a value node holds
 *  its facts' values, a subject its name and summary facts). */
class Seeded {
  readonly labels = new Map<string, Set<string>>();
  readonly ids = new Map<string, string>();
  constructor(readonly ctx: StepContext) {}
  tag(ref: string, label: string) {
    if (!this.ids.has(label)) this.ids.set(label, ref);
    (this.labels.get(ref) ?? this.labels.set(ref, new Set()).get(ref)!).add(label);
  }
  of(ref: string) {
    return [...(this.labels.get(ref) ?? [ref])];
  }
}

async function ensureType(b: GraphBackend, type: string) {
  if (type === "Person" || (await b.schemas.schema(type))) return;
  await createNodeSchema(b, b.schemas, { type, attributes: { description: "?string", alt_names: "?list" }, index: ["name", "description", "alt_names"], role: "entity", key: "ref_id" });
}

/** The node an entity reference is: the user, or what graph/resolve finds, or a new one. */
async function entity(s: Seeded, b: GraphBackend, ref: string, owner: string): Promise<string> {
  const known = s.ids.get(`e:${ref}`);
  if (known) return known;
  const { type, name } = split(ref);
  if (type === "Self") return owner;
  await ensureType(b, type);
  const r = ok(await call(resolve, { node_type: type, name }, s.ctx), "resolve");
  const id = r.match?.ref_id ?? ok(await call(createNode, { node_type: type, node_data: { name } }, s.ctx), "create-node").ref_id;
  s.tag(id, `e:${ref}`);
  return id;
}

async function addName(b: GraphBackend, ref: string, name: string) {
  const n = await b.reader.getNode(ref);
  const alts = Array.isArray(n?.properties["alt_names"]) ? (n!.properties["alt_names"] as string[]) : [];
  if (!alts.includes(name)) await b.nodes.update(ref, { set: { alt_names: [...alts, name] } });
}

async function seed(b: GraphBackend, ctx: StepContext, fixture: Fixture): Promise<Seeded> {
  const s = new Seeded(ctx);
  const owner = ok(await call(createNode, { node_type: "Person", node_data: { name: "Me", is_owner: true } }, ctx), "owner").ref_id;
  s.tag(owner, "e:Self:Me");
  const facts = [...fixture.episodes, ...fixture.heldout.episodes].flatMap((e) => e.f);
  const one = new Set([...ONE, ...facts.filter((f) => f[5]).map((f) => f[2])]);
  const values = new Map<string, string>();
  for (const [id, subject, predicate, object, text] of facts) {
    const from = await entity(s, b, subject, owner);
    if (!object && NAMING.has(predicate)) {
      const name = nameIn(text);
      if (name) await addName(b, from, name);
      s.tag(from, `f:${id}`);
      continue;
    }
    if (!object && predicate === "summary") {
      await b.nodes.update(from, { set: { description: text } });
      s.tag(from, `f:${id}`);
      continue;
    }
    let to: string;
    if (object) to = await entity(s, b, object, owner);
    else {
      const value = VALUES[id];
      if (!value) throw new Error(`no value for ${id}`);
      await ensureType(b, VALUE_TYPE);
      to = values.get(value.toLowerCase()) ?? "";
      if (!to) {
        const r = ok(await call(resolve, { node_type: VALUE_TYPE, name: value }, ctx), "resolve");
        to = r.match?.ref_id ?? ok(await call(createNode, { node_type: VALUE_TYPE, node_data: { name: value } }, ctx), "create-node").ref_id;
        values.set(value.toLowerCase(), to);
      }
      s.tag(to, `f:${id}`);
    }
    // As graph/import-memory names it: a name a plain edge type holds gets IS_.
    const edge = PLAIN.has(predicate.toUpperCase()) ? `IS_${predicate.toUpperCase()}` : predicate;
    const out = ok(await call(assertStep, {
      source_ref_id: from, edge_type: edge, target_ref_id: to, text,
      create_schema_if_missing: true, cardinality: one.has(predicate) ? "one" : "many",
    }, ctx), `assert ${id}`);
    s.tag(out.edge_ref_id, `f:${id}`);
  }
  for (const [keep, dup] of fixture.merges) {
    ok(await call(merge, { keep: s.ids.get(`e:${keep}`), duplicate: s.ids.get(`e:${dup}`) }, ctx), "merge");
    // The duplicate's ref_id now leads to the kept node; its facts are copies there (relabelCopies).
    s.tag(s.ids.get(`e:${keep}`)!, `e:${dup}`);
  }
  return s;
}

/** The fact labels of an edge merge copied: its sentence names the fact. */
async function relabelCopies(b: GraphBackend, s: Seeded, facts: FactRow[]) {
  const byText = new Map(facts.map((f) => [f[4], `f:${f[0]}`]));
  const rows = await b.query("MATCH (n:Node {node_type: 'EdgeText'}) WHERE n.deleted_at IS NULL RETURN n.edge_ref_id AS e, n.text AS t");
  for (const r of rows) if (!s.labels.has(String(r["e"])) && byText.has(String(r["t"]))) s.tag(String(r["e"]), byText.get(String(r["t"]))!);
}

async function score(queries: Q[], s: Seeded): Promise<Scores> {
  const byKind: Scores["byKind"] = {};
  const positives: { r1: number; r5: number; mrr: number; noise5: number }[] = [];
  const times: number[] = [];
  const misses: string[] = [];
  let negN = 0, negHits = 0, notViolations = 0;
  for (const q of queries) {
    for (const l of [...q.expect, ...(q.not ?? [])]) if (!s.ids.has(l)) misses.push(`[seed] ${q.q}: ${l} has no node or edge`);
    const t0 = performance.now();
    const out = ok(await call(graphSearch, { q: q.q, limit: 10, ...(q.type ? { type: q.type } : { facts: true }) }, s.ctx), "search");
    times.push(performance.now() - t0);
    const nodes: { ref_id: string; score?: number }[] = Array.isArray(out) ? out : out.nodes;
    const facts: { ref_id: string; score?: number }[] = Array.isArray(out) ? [] : out.facts;
    // Two lists, each ranked: by score across both (`--rank score`), or
    // taken in turn, node first (default), as a reader sees both tops.
    const ranked = (RANK === "score"
      ? [...nodes, ...facts].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      : Array.from({ length: Math.max(nodes.length, facts.length) }, (_, i) => [nodes[i], facts[i]]).flat().filter((h): h is { ref_id: string } => !!h)
    ).slice(0, 10);
    const got = ranked.map((h) => s.of(h.ref_id));
    const show = (k: number) => got.slice(0, k).map((ls) => ls.join("|")).join(", ");
    const want = new Set(q.expect);
    const relevant = (ls: string[]) => ls.some((l) => want.has(l));
    if ((q.not ?? []).some((l) => got.slice(0, 5).some((ls) => ls.includes(l)))) {
      notViolations++;
      misses.push(`[${q.kind} must-not] ${q.q} → ${show(5)}`);
    }
    if (!q.expect.length) {
      negN++;
      if (got.length) {
        negHits++;
        misses.push(`[${q.kind}] ${q.q} → ${show(3)}`);
      }
      continue;
    }
    const at = (k: number) => new Set(got.slice(0, k).flat().filter((l) => want.has(l))).size / Math.min(want.size, k);
    const first = got.findIndex(relevant);
    const m = { r1: at(1), r5: at(5), mrr: first < 0 ? 0 : 1 / (first + 1), noise5: got.slice(0, 5).filter((ls) => !relevant(ls)).length };
    positives.push(m);
    const k = (byKind[q.kind] ??= { n: 0, r1: 0, r5: 0, mrr: 0 });
    k.n++; k.r1 += m.r1; k.r5 += m.r5; k.mrr += m.mrr;
    if (m.r5 < 1 || m.r1 < 1) misses.push(`[${q.kind}${m.r5 < 1 ? "" : " @1"}] ${q.q} → want ${q.expect.join(", ")}; got ${show(5) || "nothing"}`);
  }
  for (const k of Object.values(byKind)) { k.r1 /= k.n; k.r5 /= k.n; k.mrr /= k.n; }
  return {
    byKind,
    overall: { n: positives.length, r1: mean(positives.map((m) => m.r1)), r5: mean(positives.map((m) => m.r5)), mrr: mean(positives.map((m) => m.mrr)), noise5: mean(positives.map((m) => m.noise5)) },
    negatives: { n: negN, withHits: negHits },
    notViolations,
    latency: { p50: pct(times, 50), p95: pct(times, 95) },
    misses,
  };
}

/** Each probe through graph/resolve (match = automatic, candidates = similar),
 *  then made and run through graph/duplicates (a pair with its seed offered). */
async function dedupe(b: GraphBackend, ctx: StepContext, fixture: Fixture) {
  const seedId = new Map<string, string>();
  const misses: string[] = [];
  // The user, as on Peel: graph/duplicates matches people only beside them.
  ok(await call(createNode, { node_type: "Person", node_data: { name: "Me", is_owner: true } }, ctx), "owner");
  for (const sd of fixture.dedupe.seed) {
    const { type, name } = split(sd);
    await ensureType(b, type);
    const r = ok(await call(resolve, { node_type: type, name }, ctx), "resolve");
    if (r.match) misses.push(`[dedupe] seed ${sd} matched ${r.match.title}: two entities became one`);
    seedId.set(sd, r.match?.ref_id ?? ok(await call(createNode, { node_type: type, node_data: { name } }, ctx), "create-node").ref_id);
  }
  const label = (id: string) => [...seedId].find(([, v]) => v === id)?.[0] ?? id;
  const auto = { tp: 0, fp: 0, positives: 0 }, cand = { tp: 0, fp: 0, positives: 0 }, dup = { tp: 0, fp: 0, positives: 0 };
  const times: number[] = [];
  for (const p of fixture.dedupe.probes) {
    const { type, name } = split(p.probe);
    await ensureType(b, type);
    const target = p.match ? seedId.get(p.match) : undefined;
    if (p.match && !target) throw new Error(`dedupe: unknown seed ${p.match}`);
    const t0 = performance.now();
    const r = ok(await call(resolve, { node_type: type, name, limit: 3 }, ctx), "resolve");
    times.push(performance.now() - t0);
    const matched: string | undefined = r.match?.ref_id;
    const candidates = new Set<string>([...(matched ? [matched] : []), ...r.candidates.map((c: { ref_id: string }) => c.ref_id)]);
    if (target) {
      cand.positives++;
      dup.positives++;
      if (p.auto !== false) auto.positives++;
    }
    if (matched) matched === target && p.auto !== false ? auto.tp++ : auto.fp++;
    if (target && candidates.has(target)) cand.tp++;
    if ([...candidates].some((id) => id !== target)) cand.fp++;
    const fine = (target ? candidates.has(target) && ![...candidates].some((id) => id !== target) : candidates.size === 0) && !(matched && p.auto === false);
    if (!fine) misses.push(`[resolve] ${p.probe} (want ${p.match ?? "none"}${p.auto === false ? ", not automatic" : ""}) → ${matched ? `matched ${label(matched)}` : "no match"}${r.candidates.length ? `, candidates ${r.candidates.map((c: { ref_id: string }) => label(c.ref_id)).join(", ")}` : ""}`);

    // graph/duplicates over the graph with the probe in it.
    const made = ok(await call(createNode, { node_type: type, node_data: { name } }, ctx), "create-node");
    const fresh = made.status === "Success";
    const pairs: { a: { ref_id: string }; b: { ref_id: string } }[] = ok(await call(duplicates, { limit: 500 }, ctx), "duplicates");
    const withProbe = pairs.filter((x) => x.a.ref_id === made.ref_id || x.b.ref_id === made.ref_id).map((x) => (x.a.ref_id === made.ref_id ? x.b.ref_id : x.a.ref_id));
    if (target && (withProbe.includes(target) || made.ref_id === target)) dup.tp++;
    if (withProbe.some((id) => id !== target)) dup.fp++;
    if ((target && !withProbe.includes(target) && made.ref_id !== target) || withProbe.some((id) => id !== target)) {
      misses.push(`[duplicates] ${p.probe} (want ${p.match ?? "none"}) → ${made.ref_id === target ? "same node" : withProbe.map(label).join(", ") || "no pair"}`);
    }
    if (fresh) ok(await call(deleteNode, { ref_id: made.ref_id, reason: "bench probe" }, ctx), "delete-node");
  }
  return { auto: pr(auto), candidates: pr(cand), duplicates: pr(dup), p50: pct(times, 50), misses };
}

const f3 = (x: number) => x.toFixed(3);
function scoresTable(title: string, r: Scores): string[] {
  return [
    `| ${title} | n | recall@1 | recall@5 | MRR |`,
    "|---|---:|---:|---:|---:|",
    ...Object.entries(r.byKind).map(([k, v]) => `| ${k} | ${v.n} | ${f3(v.r1)} | ${f3(v.r5)} | ${f3(v.mrr)} |`),
    `| **all positive** | ${r.overall.n} | **${f3(r.overall.r1)}** | **${f3(r.overall.r5)}** | **${f3(r.overall.mrr)}** |`,
    `| negatives with any hit | ${r.negatives.withHits}/${r.negatives.n} | | | |`,
    `| must-not hit in top 5 | ${r.notViolations} | | | |`,
    `| non-relevant in top 5, mean | ${r.overall.noise5.toFixed(2)} | | | |`,
    `| latency p50 / p95 (ms) | ${r.latency.p50.toFixed(1)} / ${r.latency.p95.toFixed(1)} | | | |`,
  ];
}

async function open(dir: string, embedder: Embedder | false) {
  return openGraphBackend({ kind: "ladybug", path: join(dir, "graph.lbug"), namespace: PRIVATE_NAMESPACE }, { embeddings: embedder, skipBoot: true });
}

const args = process.argv.slice(2);
const RANK = args.includes("--rank") ? args[args.indexOf("--rank") + 1] : "turns";
const fixture = JSON.parse(readFileSync(new URL("./bench-memory.json", import.meta.url), "utf8")) as Fixture;
let embedder: Embedder | false = false;
if (args.includes("--embed")) {
  const { loadMiniLM } = await import("../src/graph/embeddings.js");
  embedder = await loadMiniLM();
}
const dir = mkdtempSync(join(tmpdir(), "strut-memory-graph-bench-"));
try {
  const b = await open(join(dir, "recall"), embedder);
  const ctx = { runId: "bench", path: "bench", scope: {}, input: undefined, emit: async () => {}, actor: "bench", services: { graph: b } } as unknown as StepContext;
  const t0 = performance.now();
  const s = await seed(b, ctx, fixture);
  await relabelCopies(b, s, [...fixture.episodes, ...fixture.heldout.episodes].flatMap((e) => e.f));
  // Rows written keyword-only are embedded in the background: wait for them.
  if (embedder) {
    const { embedPendingEdgeRows } = await import("../src/graph/temporal.js");
    while ((await embedPendingEdgeRows(b)) > 0);
  }
  const seedMs = performance.now() - t0;
  const main = await score(fixture.queries, s);
  const heldout = await score(fixture.heldout.queries, s);
  await b.close();

  const d = await open(join(dir, "dedupe"), false);
  const dctx = { ...ctx, services: { graph: d } } as unknown as StepContext;
  const dd = await dedupe(d, dctx, fixture);
  await d.close();

  const md = [
    `Search: ${embedder ? "keyword + vector (MiniLM)" : "keyword only"}; nodes and facts ${RANK === "score" ? "ranked by score together" : "taken in turn, node first"}. Seeded ${[...fixture.episodes, ...fixture.heldout.episodes].flatMap((e) => e.f).length} facts in ${(seedMs / 1000).toFixed(1)} s.`,
    "",
    ...scoresTable("main queries", main),
    "",
    ...scoresTable("held-out queries", heldout),
    "",
    "| dedupe | value |",
    "|---|---:|",
    `| resolve auto-match precision / recall | ${f3(dd.auto.precision)} / ${f3(dd.auto.recall)} (${dd.auto.tp} tp, ${dd.auto.fp} fp of ${dd.auto.positives}) |`,
    `| resolve matched-or-candidate precision / recall | ${f3(dd.candidates.precision)} / ${f3(dd.candidates.recall)} (${dd.candidates.tp} tp, ${dd.candidates.fp} fp of ${dd.candidates.positives}) |`,
    `| graph/duplicates pair precision / recall | ${f3(dd.duplicates.precision)} / ${f3(dd.duplicates.recall)} (${dd.duplicates.tp} tp, ${dd.duplicates.fp} fp of ${dd.duplicates.positives}) |`,
    `| resolve p50, one name (ms) | ${dd.p50.toFixed(1)} |`,
  ].join("\n");
  const misses = [...main.misses, ...heldout.misses.map((m) => `(held-out) ${m}`), ...dd.misses];
  console.log(md);
  if (args.includes("--verbose")) console.log(`\n${misses.join("\n")}`);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  if (out) writeFileSync(out, `${md}\n\n### Misses\n\n${misses.map((m) => `- ${m}`).join("\n")}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
