/**
 * The memory graph's filing rules, checked on a fresh graph: each one a
 * query over what the tools wrote. Found by hand on Peel's own graph
 * (11 Nov 2026): a fact filed under `Thing`, the same thing under two
 * types, a correction not linked to what it replaced, evidence without its
 * session and turn, edge types with no volatility or check, one edge type
 * holding most facts. The scenario is the user's own turns, saved through
 * the tools; it must break none. Each bad shape is what the bug wrote, and
 * must break its rule.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LadybugBackend } from "./backend.js";
import type { Row } from "./engine.js";
import { CLAIM_EDGES, CLAIM_TYPE, EVIDENCE_TYPE } from "./claims.js";
import { factCheckId, factClaimId } from "./ladybug/fact-claims.js";
import { createTemporalEdge, temporalEdgeTypes } from "./ladybug/temporal.js";
import { createNodeSchema } from "./schema-crud.js";
import { THING_TYPE } from "./strut-schemas.js";
import { testBackends } from "./test-util.js";
import type { StepContext } from "../core.js";
import assertStep from "../steps/lib/graph/assert.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import resolveStep from "../steps/lib/graph/resolve.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const run = (step: Step, cfg: Record<string, unknown>, ctx: unknown): Promise<any> => step.run(step.input.parse(cfg), ctx);
/** A tool call in turn `turn` of agent session `session`, as the agent step makes it. */
const turnCtx = (b: LadybugBackend, session: string, turn: number) =>
  ({ runId: `run-${session}-${turn}`, path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services: { graph: b }, actor: "agent", turnOf: { session, turn } }) as unknown as StepContext;

const RULES = [
  "no node is a Thing",
  "no fact points at a Thing",
  "no entity name under two types",
  "every fact has a claim",
  "evidence names session and turn",
  "every fact has a source",
  "every fact edge type has a volatility",
  "every changing fact edge type has a check",
  "an expired fact has a replacement or a refutation",
  "a refuted fact is linked to its replacement",
  "no live fact points at a deleted node",
  "no edge type holds over 30% of current facts",
] as const;
type Rule = (typeof RULES)[number];

interface Fact {
  ref_id: string;
  edge: string;
  source: string;
  target: string;
  source_type: string;
  target_type: string;
  target_deleted: boolean;
  sources: string[];
  expired: boolean;
  superseded_by: string | null;
}

/** What breaks each rule, by rule: empty lists when the graph keeps them all. */
async function brokenRules(b: LadybugBackend): Promise<Record<Rule, string[]>> {
  const q = (c: string, p?: Record<string, unknown>): Promise<Row[]> => b.query(c, p);
  const facts: Fact[] = [];
  for (const edge of await temporalEdgeTypes(q)) {
    for (const r of await q(
      `MATCH (s:Node)-[r:\`${edge}\`]->(t:Node) WHERE r.deleted_at IS NULL AND r.text IS NOT NULL AND s.deleted_at IS NULL
       RETURN r.ref_id AS ref_id, s.ref_id AS s, t.ref_id AS t, s.node_type AS st, t.node_type AS tt, t.deleted_at IS NOT NULL AS gone,
              r.sources AS sources, r.expired_at IS NOT NULL AS expired, r.superseded_by AS by`,
    )) {
      facts.push({
        ref_id: String(r["ref_id"]), edge, source: String(r["s"]), target: String(r["t"]), source_type: String(r["st"]), target_type: String(r["tt"]),
        target_deleted: r["gone"] === true, sources: Array.isArray(r["sources"]) ? (r["sources"] as unknown[]).map(String) : [],
        expired: r["expired"] === true, superseded_by: typeof r["by"] === "string" ? r["by"] : null,
      });
    }
  }
  const claims = new Set((await q(`MATCH (c:Node {node_type: '${CLAIM_TYPE}'}) WHERE c.deleted_at IS NULL RETURN c.id AS id`)).map((r) => String(r["id"])));
  const evidence = await q(
    `MATCH (c:Node {node_type: '${CLAIM_TYPE}'})-[r:${CLAIM_EDGES.EVIDENCED_BY}]->(e:Node {node_type: '${EVIDENCE_TYPE}'}) WHERE e.deleted_at IS NULL
     RETURN c.id AS claim, e.ref_id AS ref_id, e.evidence_mode AS mode, r.context AS context, r.strength AS strength`,
  );
  const refutedClaims = new Set(evidence.filter((e) => Number(e["strength"]) < 0).map((e) => String(e["claim"])));
  const checks = new Set((await q(`MATCH (k:Node {node_type: 'Check'}) WHERE k.deleted_at IS NULL AND k.retired_at IS NULL RETURN k.id AS id`)).map((r) => String(r["id"])));
  const live = facts.filter((f) => !f.expired);
  const claimOf = (f: Fact) => factClaimId(f.source, f.edge, f.target);

  // Entity nodes (and anything filed as Thing) by name: one name, one type.
  const named = await q(`MATCH (n:Node) WHERE n.deleted_at IS NULL AND n.title IS NOT NULL RETURN n.node_type AS type, lower(trim(n.title)) AS name`);
  const typesByName = new Map<string, Set<string>>();
  for (const r of named) {
    const type = String(r["type"]);
    const role = type === THING_TYPE ? "entity" : (await b.schemas.schema(type))?.role;
    if (role !== "entity") continue;
    const set = typesByName.get(String(r["name"])) ?? new Set<string>();
    set.add(type);
    typesByName.set(String(r["name"]), set);
  }

  const volatilityOf = new Map<string, string | undefined>();
  for (const f of facts) {
    if (!volatilityOf.has(f.edge)) volatilityOf.set(f.edge, (await b.schemas.edgeSchema(f.edge, f.source_type, f.target_type))?.rule.volatility);
  }
  const counts = new Map<string, number>();
  for (const f of live) counts.set(f.edge, (counts.get(f.edge) ?? 0) + 1);

  return {
    "no node is a Thing": named.filter((r) => r["type"] === THING_TYPE).map((r) => String(r["name"])),
    "no fact points at a Thing": facts.filter((f) => f.source_type === THING_TYPE || f.target_type === THING_TYPE).map((f) => f.ref_id),
    "no entity name under two types": [...typesByName].filter(([, t]) => t.size > 1).map(([n, t]) => `${n}: ${[...t].sort().join(", ")}`),
    "every fact has a claim": facts.filter((f) => !claims.has(claimOf(f))).map((f) => f.ref_id),
    "evidence names session and turn": evidence
      .filter((e) => e["mode"] === "asserted")
      .filter((e) => {
        const c = JSON.parse(String(e["context"] ?? "{}")) as Record<string, unknown>;
        return typeof c["session"] !== "string" || typeof c["turn"] !== "number";
      })
      .map((e) => String(e["ref_id"])),
    "every fact has a source": facts.filter((f) => !f.sources.length).map((f) => f.ref_id),
    "every fact edge type has a volatility": [...volatilityOf].filter(([, v]) => !v).map(([e]) => e),
    "every changing fact edge type has a check": [...volatilityOf].filter(([e, v]) => (v === "evolving" || v === "volatile") && !checks.has(factCheckId(e))).map(([e]) => e),
    "an expired fact has a replacement or a refutation": facts.filter((f) => f.expired && !f.superseded_by && !refutedClaims.has(claimOf(f))).map((f) => f.ref_id),
    "a refuted fact is linked to its replacement": facts.filter((f) => f.expired && refutedClaims.has(claimOf(f)) && !f.superseded_by).map((f) => f.ref_id),
    "no live fact points at a deleted node": live.filter((f) => f.target_deleted).map((f) => f.ref_id),
    "no edge type holds over 30% of current facts": live.length < 5 ? [] : [...counts].filter(([, n]) => n / live.length > 0.3).map(([e, n]) => `${e}: ${n} of ${live.length}`),
  };
}

const broken = (r: Record<Rule, string[]>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v.length));

describe("memory filing rules: the user's own turns keep them all (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let tom: string, kate: string;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
    await createNodeSchema(b, b.schemas, { type: "Topic", attributes: {}, role: "entity" });
    await createNodeSchema(b, b.schemas, { type: "Place", attributes: { alt_names: "?list" }, role: "entity" });
    [tom, kate] = (await b.nodes.writeMany([
      { type: "Person", data: { name: "Tom", is_owner: true } },
      { type: "Person", data: { name: "Kate" } },
    ])).map((r) => r.ref_id) as [string, string];
  });
  after(() => lb.close(b));

  it("padel, wash day corrected, 5-a-side moved in a new session, Kate likes tea, and a few more", async () => {
    const say = (cfg: Record<string, unknown>, session: string, turn: number) => run(assertStep, cfg, turnCtx(b, session, turn));
    const changing = (expects: string) => ({ create_schema_if_missing: true, volatility: "evolving", check: { expects } });

    await say({ source_ref_id: tom, edge_type: "PLAYS", target_type: "Topic", target_data: { name: "Padel" }, text: "Tom plays padel every Tuesday at 5:30pm", words: "I play padel every tuesday at 5:30", ...changing("padel comes up in chats") }, "dm-1", 0);
    const wed = await say({ source_ref_id: tom, edge_type: "DOES", target_type: "Topic", target_data: { name: "House washing" }, text: "Tom does the house washing on Wednesdays", words: "wash wednesdays", ...changing("washing comes up in chats") }, "dm-1", 1);

    // "actually we do wash on sundays!": a correction is the new fact, replacing the old one.
    const words = "actually we do wash on sundays!";
    const sun = await say({ source_ref_id: tom, edge_type: "DOES", target_ref_id: wed.target_ref_id, text: "Tom does the house washing on Sundays", replaces: wed.edge_ref_id, words }, "dm-1", 2);
    assert.equal(sun.action, "created", JSON.stringify(sun));
    assert.equal(sun.replaced, wed.edge_ref_id);

    const mon = await say({ source_ref_id: tom, edge_type: "PLAYS", target_type: "Topic", target_data: { name: "5-a-side football" }, text: "Tom plays 5-a-side football every Monday at 7pm", words: "5 a side every monday 7pm" }, "dm-1", 3);
    // A new session: the thing is found whatever type it was filed under, and the Monday fact comes back.
    const found = await run(resolveStep, { name: "5-a-side football" }, turnCtx(b, "dm-2", 0));
    assert.equal(found.match?.ref_id, mon.target_ref_id);
    const sat = { source_ref_id: tom, edge_type: "PLAYS", target_ref_id: found.match.ref_id, text: "Tom plays 5-a-side football on Saturday mornings", words: "5-a-side on saturday mornings" };
    const asked = await say(sat, "dm-2", 0);
    assert.equal(asked.held_text, "Tom plays 5-a-side football every Monday at 7pm", JSON.stringify(asked));
    // The user says it moved.
    const moved = await say({ ...sat, replaces: mon.edge_ref_id }, "dm-2", 1);
    assert.equal(moved.action, "created", JSON.stringify(moved));
    assert.equal(moved.replaced, mon.edge_ref_id);

    assert.match(String(await say({ source_ref_id: kate, edge_type: "LIKES", target_type: "Thing", target_data: { name: "Tea" }, text: "Kate likes tea", create_schema_if_missing: true }, "dm-3", 0)), /ontology's root/);
    await say({ source_ref_id: kate, edge_type: "LIKES", target_type: "Topic", target_data: { name: "Tea" }, text: "Kate likes tea", words: "remember kate likes tea", create_schema_if_missing: true, volatility: "stable" }, "dm-3", 0);
    await say({ source_ref_id: tom, edge_type: "LIVES_IN", target_type: "Place", target_data: { name: "Leeds" }, text: "Tom lives in Leeds", create_schema_if_missing: true, cardinality: "one", volatility: "stable" }, "dm-3", 1);
    await say({ source_ref_id: tom, edge_type: "FROM", target_type: "Place", target_data: { name: "Cardiff" }, text: "Tom is from Cardiff", create_schema_if_missing: true, volatility: "static" }, "dm-3", 2);
    await say({ source_ref_id: kate, edge_type: "VISITS", target_type: "Place", target_data: { name: "Lisbon" }, text: "Kate visits Lisbon every summer", ...changing("Lisbon comes up in chats") }, "dm-3", 3);

    assert.deepEqual(broken(await brokenRules(b)), {});

    // One current wash day.
    const search = await run(graphSearch, { q: "house washing", facts: true }, turnCtx(b, "dm-4", 0));
    const wash = (search.facts as Array<{ ref_id: string; text: string; status?: string }>).filter((f) => /washing/.test(f.text));
    assert.deepEqual(wash.map((f) => f.ref_id), [sun.edge_ref_id], JSON.stringify(search.facts));
    assert.notEqual(wash[0]!.status, "refuted", JSON.stringify(wash[0]));
  });
});

describe("memory filing rules: each bug's shape breaks its rule (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let tom: string, padel: string;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
    await createNodeSchema(b, b.schemas, { type: "Topic", attributes: {}, role: "entity" });
    await createNodeSchema(b, b.schemas, { type: "Place", attributes: {}, role: "entity" });
    await b.schemas.createEdgeSchema("Person", "PLAYS", "Topic", { temporal: true, volatility: "evolving" });
    await b.schemas.createEdgeSchema("Person", "WORKS_ON", "Topic", { temporal: true });
  });
  after(() => lb.close(b));
  beforeEach(async () => {
    await lb.clear(b);
    [tom, padel] = (await b.nodes.writeMany([
      { type: "Person", data: { name: "Tom", is_owner: true } },
      { type: "Topic", data: { name: "Padel" } },
    ])).map((r) => r.ref_id) as [string, string];
  });

  const ctx = () => turnCtx(b, "dm-1", 0);
  /** A node as the old writer let one be made, past every guard. */
  const rawNode = async (type: string, title: string) => {
    const ref_id = randomUUID();
    await b.query("CREATE (:Node {ref_id: $r, node_type: $t, title: $n, name: $n, namespace: $ns})", { r: ref_id, t: type, n: title, ns: b.namespace });
    return ref_id;
  };
  const rawFact = (edge: string, s: string, t: string, props: Record<string, unknown> = {}) =>
    b.tx((tx) => createTemporalEdge(tx, edge, s, t, { ref_id: randomUUID(), text: `${edge} fact`, sources: ["run:x"], created_at: Date.now(), ...props }));
  const breaks = async (rule: Rule) => {
    const r = await brokenRules(b);
    assert.ok(r[rule].length > 0, `${rule}: ${JSON.stringify(r)}`);
  };

  it("no node is a Thing; no fact points at a Thing", async () => {
    const tea = await rawNode(THING_TYPE, "Tea");
    await breaks("no node is a Thing");
    await rawFact("PLAYS", tom, tea);
    await breaks("no fact points at a Thing");
  });

  it("no entity name under two types: 5-a-side as a Topic and as a Thing", async () => {
    await b.nodes.write({ type: "Topic", data: { name: "5-a-side football" } });
    await rawNode(THING_TYPE, "5-a-side football");
    await breaks("no entity name under two types");
  });

  it("every fact has a claim; every fact has a source", async () => {
    await rawFact("PLAYS", tom, padel, { sources: [] });
    await breaks("every fact has a claim");
    await breaks("every fact has a source");
  });

  it("evidence names session and turn: a fact saved with the run alone", async () => {
    const noTurn = { ...ctx(), turnOf: undefined };
    await run(assertStep, { source_ref_id: tom, edge_type: "PLAYS", target_ref_id: padel, text: "Tom plays padel" }, noTurn);
    await breaks("evidence names session and turn");
  });

  it("every fact edge type has a volatility; a changing one has a check", async () => {
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_ON", target_ref_id: padel, text: "Tom plays padel" }, ctx());
    await breaks("every fact edge type has a volatility");
    await run(assertStep, { source_ref_id: tom, edge_type: "PLAYS", target_ref_id: padel, text: "Tom plays padel" }, ctx());
    await breaks("every changing fact edge type has a check");
  });

  it("an expired fact has a replacement or a refutation", async () => {
    await rawFact("PLAYS", tom, padel, { expired_at: Date.now() });
    await breaks("an expired fact has a replacement or a refutation");
  });

  it("a refuted fact is linked to its replacement: a correction saved as a refutation and an unrelated fact", async () => {
    const [wed, sun] = (await b.nodes.writeMany([{ type: "Topic", data: { name: "Wash Wednesdays" } }, { type: "Topic", data: { name: "Wash Sundays" } }])).map((r) => r.ref_id);
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_ON", target_ref_id: wed, text: "Tom washes on Wednesdays" }, ctx());
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_ON", target_ref_id: wed, text: "Tom washes on Wednesdays", refuted: true }, ctx());
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_ON", target_ref_id: sun, text: "Tom washes on Sundays" }, ctx());
    await breaks("a refuted fact is linked to its replacement");
  });

  it("no live fact points at a deleted node", async () => {
    await run(assertStep, { source_ref_id: tom, edge_type: "PLAYS", target_ref_id: padel, text: "Tom plays padel" }, ctx());
    await b.query("MATCH (n:Node {ref_id: $r}) SET n.deleted_at = 1", { r: padel });
    await breaks("no live fact points at a deleted node");
  });

  it("no edge type holds over 30% of current facts: WORKS_ON for everything", async () => {
    for (const name of ["Running", "Washing", "Knee injury", "Running shoes", "Peel"]) {
      await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_ON", target_type: "Topic", target_data: { name }, text: `Tom works on ${name}` }, ctx());
    }
    await breaks("no edge type holds over 30% of current facts");
  });

  it("every rule is checked", () => assert.equal(RULES.length, 12));
});
