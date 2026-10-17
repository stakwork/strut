import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GraphBackend, Neo4jBackend } from "./backend.js";
import { Bolt } from "./bolt.js";
import { seedStrutDomain } from "./schema-seed.js";
import { NodeWriter, type Embedder } from "./node-writer.js";
import {
  GraphReadError,
  Neo4jReader,
  PROSE_RRF_WEIGHTS,
  RRF_WEIGHTS,
  applyTitleBoost,
  applyUsageTiebreak,
  buildFulltextQuery,
  escapeLucene,
  excludeRegex,
  fetchLimit,
  fuseHits,
  fusionWeights,
  inheritedAttributes,
  isExactQuery,
  linkedClause,
  overfetch,
  parseLinks,
  pyRound,
  rankHits,
  routeIndexes,
  serializeNode,
  splitSchema,
  titleMatchMultiplier,
  type GraphReader,
  type Hit,
  type SearchResult,
} from "./search.js";
import { EMBEDDING_DIM } from "./embeddings.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { SchemaResolver } from "./schema-resolver.js";
import { rawNode, seedConceptSchema, setNodeProps, testBackends, testGraphConfig, wipeGraph } from "./test-util.js";

const cfg = testGraphConfig();

/** Deterministic bag-of-words embedder: each lowercase word hashes to a
 *  dimension; cosine = word overlap. Good enough to make vector ranking
 *  predictable without the model. */
const bow: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        const h = createHash("sha1").update(w).digest();
        v[h.readUInt16BE(0) % EMBEDDING_DIM] += 1;
      }
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n);
    });
  },
};

const hit = (ref_id: string, raw_score: number, extra: Record<string, unknown> = {}): Hit => ({
  node: { labels: ["StrutWorkflow", "Node", "Data_Bank", "Domain_strut"], properties: { ref_id, ...extra } },
  raw_score,
});

describe("search helpers (pure)", () => {
  it("escapes Lucene specials and builds required-term queries", () => {
    assert.equal(escapeLucene("a+b:c"), "a\\+b\\:c");
    assert.equal(buildFulltextQuery("DomainSrchEpisode_74aced4f"), "DomainSrchEpisode_74aced4f");
    assert.equal(buildFulltextQuery("  harvey deliver "), "+harvey +deliver");
    assert.equal(buildFulltextQuery(""), "");
  });
  it("phrases: a quoted span, and a word the analyzer would split; an exact query is one of them alone", () => {
    assert.equal(buildFulltextQuery("x-hub-signature-256"), '"x-hub-signature-256"');
    assert.equal(buildFulltextQuery('return "Invalid signature" from it'), '+return +"Invalid signature" +from +it');
    assert.equal(buildFulltextQuery("how do real-time updates work?"), '+how +do +"real-time" +updates +work\\?');
    assert.equal(buildFulltextQuery("workspace's data"), "+workspace's +data");
    assert.equal(buildFulltextQuery('"Invalid signature'), '+\\"Invalid +signature', "an unclosed quote is a character");
    assert.deepEqual(
      ["x-hub-signature-256", '"Invalid signature"', "Invalid signature", 'return "Invalid signature"', "harvey"].map(isExactQuery),
      [true, true, false, false, false],
    );
  });
  it("fusion weights by shape: a question of four words or more halves the keyword half; a short or exact query keeps jarvis's", () => {
    assert.deepEqual(fusionWeights("how do live updates reach the browser"), { fulltext: 0.5, semantic: 1.0 });
    assert.deepEqual(fusionWeights('where do we return "Invalid signature"'), { fulltext: 0.5, semantic: 1.0 });
    assert.equal(fusionWeights("Invalid signature"), RRF_WEIGHTS);
    assert.equal(fusionWeights("x-hub-signature-256"), RRF_WEIGHTS);
    assert.equal(fusionWeights('"the user is not a member of this workspace"'), RRF_WEIGHTS, "one quoted span is exact, however long");
    // jarvis's weights put a keyword-only first hit above a semantic-only one; the prose weights do not.
    const order = (w?: Record<string, number>) => fuseHits([hit("kw", 9)], [hit("sem", 0.9)], {}, w).map((e) => e.node.properties["ref_id"]);
    assert.deepEqual(order(), ["kw", "sem"]);
    assert.deepEqual(order(PROSE_RRF_WEIGHTS), ["sem", "kw"]);
  });
  /** The paths `exclude` leaves out. Cypher's `=~` is a full match and
   *  `(?i)` its flag: a JS RegExp anchored, with `i`. */
  const leftOut = (entries: string[], files: string[]) => {
    const re = new RegExp(`^(?:${excludeRegex(entries)!.replace(/^\(\?i\)/, "")})$`, "i");
    return files.filter((f) => re.test(f));
  };
  it("exclude: a path part matches whole `/` segments of `file`, in any case; no entries → null", () => {
    assert.deepEqual(
      leftOut(["test"], ["test/a.ts", "src/test/a.ts", "a/test", "src/Test/a.ts", "latest.ts", "contest/x.ts", "testimonials/a.ts", "src/tests/a.ts", "src/a.test.ts"]),
      ["test/a.ts", "src/test/a.ts", "a/test", "src/Test/a.ts"],
    );
    assert.deepEqual(
      leftOut(["__tests__", "mock"], ["src/__tests__/unit/a.test.ts", "src/__tests__x/a.ts", "src/lib/mock/github.ts", "src/lib/mocks/a.ts", "src/lib/mockServer.ts"]),
      ["src/__tests__/unit/a.test.ts", "src/lib/mock/github.ts"],
    );
    assert.deepEqual(
      leftOut(["src/app/api/mock"], ["stakwork/hive/src/app/api/mock/github/route.ts", "src/app/api/mock", "src/app/api/mockups/a.ts", "src/app/api/github/mock.ts", "xsrc/app/api/mock/a.ts"]),
      ["stakwork/hive/src/app/api/mock/github/route.ts", "src/app/api/mock"],
    );
    assert.equal(excludeRegex([" /__tests__/ "]), excludeRegex(["__tests__"]), "trimmed, slashes at either end dropped");
    assert.equal(excludeRegex([]), null);
    assert.equal(excludeRegex(["", "  ", "/"]), null, "blank entries are ignored");
  });
  it("exclude: a pattern with * or ? matches the file name; everything else is literal", () => {
    assert.equal(excludeRegex(["test", "*.test.ts"]), "(?i)(?:.*/)?(?:test(?:/.*)?|[^/]*\\.test\\.ts)");
    assert.deepEqual(
      leftOut(["*.test.ts", "*_test.go"], ["src/a.test.ts", "a.test.ts", "src/A.Test.TS", "pkg/server_test.go", "src/a.test.tsx", "src/atest.ts", "src/test.ts", "src/x.test.ts/a.go", "pkg/server_test.go.bak"]),
      ["src/a.test.ts", "a.test.ts", "src/A.Test.TS", "pkg/server_test.go"],
    );
    assert.deepEqual(leftOut(["?.ts"], ["src/a.ts", "a.ts", "src/ab.ts"]), ["src/a.ts", "a.ts"]);
    // The step's suggested list: `*.test.*` / `*.spec.*` take every extension (.tsx, .js), not just .ts.
    assert.deepEqual(
      leftOut(["*.test.*", "*.spec.*"], ["src/a.test.tsx", "src/a.test.js", "src/a.spec.ts", "src/latest.tsx", "src/test-utils.ts", "src/spec.ts"]),
      ["src/a.test.tsx", "src/a.test.js", "src/a.spec.ts"],
    );
    // Next.js names directories `[slug]` and `(auth)`: brackets and parentheses are characters, not regex.
    assert.deepEqual(
      leftOut(["[slug]", "(auth)", "a+b", "v1.2"], ["src/app/[slug]/page.tsx", "src/app/s/page.tsx", "src/app/(auth)/login.ts", "src/app/auth/login.ts", "x/a+b/y.ts", "x/aab/y.ts", "x/v1.2/y.ts", "x/v1x2/y.ts"]),
      ["src/app/[slug]/page.tsx", "src/app/(auth)/login.ts", "x/a+b/y.ts", "x/v1.2/y.ts"],
    );
  });
  it("linked: EDGE>Type leaves the result, EDGE<Type arrives at it; blanks ignored, anything else refused", () => {
    assert.deepEqual(parseLinks(["MODIFIES>File", " TOUCHES < PullRequest ", "", "  "]), [
      { edge: "MODIFIES", direction: ">", type: "File" },
      { edge: "TOUCHES", direction: "<", type: "PullRequest" },
    ]);
    assert.deepEqual(parseLinks([]), []);
    for (const bad of ["MODIFIES", ">File", "MODIFIES>", "MODIFIES>File>Function", "MODIFIES-File", "MOD IFIES>File", "MODIFIES>`File`", "MODIFIES>File) DETACH DELETE (n"]) {
      assert.throws(() => parseLinks([bad]), (e: unknown) => e instanceof GraphReadError && e.code === "INVALID_INPUT", bad);
    }
  });
  it("linked: one EXISTS per entry, ORed, live edges to live nodes, names backquoted; none → null", () => {
    assert.equal(linkedClause([]), null);
    const live = "WHERE ((e.is_muted IS NULL OR e.is_muted <> true) AND (e.is_deleted IS NULL OR e.is_deleted <> true)) AND (x.deleted_at IS NULL AND (x.is_deleted IS NULL OR x.is_deleted <> true))";
    assert.equal(linkedClause(parseLinks(["MODIFIES>File"])), `(EXISTS { MATCH (n)-[e:\`MODIFIES\`]->(x:\`File\`) ${live} })`);
    assert.equal(
      linkedClause(parseLinks(["MODIFIES>File", "TOUCHES<PullRequest"])),
      `(EXISTS { MATCH (n)-[e:\`MODIFIES\`]->(x:\`File\`) ${live} } OR EXISTS { MATCH (n)<-[e:\`TOUCHES\`]-(x:\`PullRequest\`) ${live} })`,
    );
    // A canonical type name from the graph is written as a name whatever it holds.
    assert.match(linkedClause([{ edge: "A", direction: ">", type: "We`ird" }])!, /\(x:`We``ird`\)/);
  });
  it("fetch limit mirrors jarvis", () => {
    assert.equal(fetchLimit(10, 0), 120);
    assert.equal(fetchLimit(50, 0), 250);
    assert.equal(fetchLimit(2000, 0), 5000);
    assert.equal(fetchLimit(undefined, undefined), 120);
  });
  it("pyRound is half-to-even", () => {
    assert.equal(pyRound(0.5), 0);
    assert.equal(pyRound(1.5), 2);
    assert.equal(pyRound(2.5), 2);
    assert.equal(pyRound(0.123456789, 6), 0.123457);
  });
  it("rankHits keeps the best score per ref_id, descending", () => {
    const r = rankHits([hit("a", 0.2), hit("b", 0.9), hit("a", 0.7)]);
    assert.deepEqual(r.map((h) => [h.node.properties["ref_id"], h.raw_score]), [["b", 0.9], ["a", 0.7]]);
  });
  it("fuseHits: weighted RRF, hybrid beats single-source, scores normalized", () => {
    const ranked = fuseHits([hit("a", 3), hit("b", 2)], [hit("b", 0.9), hit("c", 0.8)], { input: [hit("c", 0.7)] });
    // b: 1.15/61 + 1.0/61 = 0.03525; c: 1.0/62 + 1.2/61 = 0.0358; a: 1.15/61 = 0.01885
    assert.deepEqual(ranked.map((e) => e.node.properties["ref_id"]), ["c", "b", "a"]);
    assert.equal(ranked[0]!.extra.score, 1);
    assert.equal(ranked[0]!.extra.match_type, "hybrid");
    assert.equal(ranked[2]!.extra.match_type, "fulltext");
    assert.ok(Math.abs(ranked[1]!.score - (1.15 / 62 + 1.0 / 61)) < 1e-12, 'b: fulltext rank 2, semantic rank 1');
    assert.equal(ranked[1]!.best_rank, 1);
  });
  it("title boost tiers and re-normalization", () => {
    assert.equal(titleMatchMultiplier("req", "req"), 4);
    assert.equal(titleMatchMultiplier("req", "request"), 2.5);
    assert.equal(titleMatchMultiplier("req", "a request"), 2);
    assert.equal(titleMatchMultiplier("req", "other"), 1);
    const ranked = fuseHits([hit("a", 3, { name: "other" }), hit("b", 2, { name: "Harvey" })], []);
    const boosted = applyTitleBoost(ranked, "harvey", () => "name");
    assert.deepEqual(boosted.map((e) => e.node.properties["ref_id"]), ["b", "a"]);
    assert.equal(boosted[0]!.extra.score, 1);
  });
  it("usage tiebreak reorders only within an epsilon bucket", () => {
    const ranked = fuseHits([hit("a", 3, { usage_count_30d: 1 }), hit("b", 2, { usage_count_30d: 9 })], [hit("a", 1), hit("b", 0.9)]);
    // a and b have identical fused scores (rank 1 & 2 in both → symmetric)? No: a is rank 1 twice, b rank 2 twice.
    assert.equal(ranked[0]!.node.properties["ref_id"], "a");
    const tied = ranked.map((e) => ({ ...e, extra: { ...e.extra, score: 0.995 } }));
    assert.deepEqual(applyUsageTiebreak(tied).map((e) => e.node.properties["ref_id"]), ["b", "a"]);
  });
  it("serializeNode strips generic props and keeps the envelope", () => {
    const env = serializeNode(
      { labels: ["Data_Bank", "StrutRun", "Node", "Domain_strut"], properties: { ref_id: "r", node_key: "k", namespace: "default", Data_Bank: "x", text_embeddings: [1], date_added_to_graph: 5, weight: 2, run_id: "1", image_url: 3 } },
      { score: 1 },
    );
    assert.deepEqual(env, { ref_id: "r", node_type: "StrutRun", date_added_to_graph: 5, weight: 2, properties: { run_id: "1", image_url: "" }, score: 1 });
  });
  it("schema split + inherited attributes", () => {
    const thing = splitSchema({ type: "Thing", ref_id: "t", index: ["name"], name: "string", description: "?string" });
    assert.deepEqual(thing.attributes, { name: "string" }, "description is a core key");
    const run = splitSchema({ type: "StrutRun", parent: "Thing", domain: "Strut", ref_id: "r", run_id: "string", name: "string", description: "?string" });
    const [, runOut] = inheritedAttributes([thing, run]);
    assert.deepEqual(runOut!.attributes, { run_id: "string" });
    // `description` is a jarvis SCHEMA_CORE_PROPERTY, so Thing's
    // `description: "?string"` never surfaces as an attribute (jarvis quirk,
    // mirrored). It is still accepted on node writes.
    assert.deepEqual(runOut!.inherited_attributes, { name: "string" });
    assert.equal(runOut!["description"], "?string");
  });
});

for (const tb of testBackends()) {
  describe(`GraphReader (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    let reader: GraphReader;
    const neo = tb.kind === "neo4j";
    const neoOnly = (why: string) => (neo ? false : `neo4j only: ${why}`);
    const ids: Record<string, string> = {};
    before(async () => {
      b = await tb.open({ embedder: bow });
      await tb.wipe(b);
      if (b.kind === "neo4j") await seedStrutDomain(b);
      await seedConceptSchema(b);
      const rs = await b.nodes.writeMany([
        { type: "StrutWorkflow", data: { name: "harvey-deliver", description: "Deliver legal memos to the client portal", usage_count_30d: 5 } },
        { type: "StrutWorkflow", data: { name: "harvey", description: "Legal research assistant" } },
        { type: "StrutWorkflow", data: { name: "gaia-eval", description: "Benchmark runs against GAIA questions", usage_count_30d: 50 } },
        { type: "StrutWorkflow", data: { name: "hidden-one", description: "Deliver memos" } },
        { type: "StrutRun", data: { run_id: "r1", workflow_name: "harvey-deliver", run_status: "success", summary: "Delivered 60 of 60 memos", started_at: 1 } },
        { type: "StrutStep", data: { step_type: "video/transcribe", description: "Transcribe audio", input_schema: "{ video_url: string }", output_schema: "{ transcript: string, words: [] }" } },
        { type: "StrutStep", data: { step_type: "email/send", description: "Send an email", input_schema: "{ to: string, body: string }", output_schema: "{ message_id: string }" } },
        { type: "StrutWorkflowVersion", data: { name: "harvey-deliver", content_hash: "c-1", created_at: 1, input_schema: "{ matterId: string }" } },
        // The Concept tree a desktop keeps: a root, a playbook under it, two
        // summaries of code (one under src/lib, one not), one with no file.
        { type: "Concept", data: { name: "Research", description: "Playbooks for researching a webhook question" } },
        { type: "Concept", data: { name: "Webhook research playbook", description: "Researching a GitHub webhook signature question" } },
        { type: "Concept", data: { name: "GitHub webhooks", description: "How a GitHub webhook signature is checked", file: "src/lib/github/verify.ts" } },
        { type: "Concept", data: { name: "Old webhook summary", description: "How a GitHub webhook signature was checked", file: "src/old/verify.ts" } },
        // The agent session is one of the types the file does not hold.
        ...(neo ? [{ type: "StrutAgentSession", data: { run_id: "r1", path: "harvey-deliver/agent", prompt_preview: "Draft the memo" } }] : []),
      ]);
      ["wf1", "wf2", "wf3", "wfHidden", "run", "stepVideo", "stepEmail", "wfv", "research", "playbook", "summary", "old", "session"].forEach((k, i) => {
        if (rs[i]) ids[k] = rs[i]!.ref_id;
      });
      await b.nodes.softDelete(ids["wfHidden"]!);
      await b.edges.writeMany([
        { edge: "EXECUTED", source_ref_id: ids["run"]!, target_ref_id: ids["wfv"]! },
        { edge: "VERSION_OF", source_ref_id: ids["wfv"]!, target_ref_id: ids["wf1"]! },
        { edge: "ACTIVE_VERSION", source_ref_id: ids["wf1"]!, target_ref_id: ids["wfv"]! },
        { edge: "USES_STEP", source_ref_id: ids["wfv"]!, target_ref_id: ids["stepEmail"]!, properties: { importance: 0.9 } },
        { edge: "CHILD_OF", source_ref_id: ids["playbook"]!, target_ref_id: ids["research"]! },
        ...(neo ? [{ edge: "IN_RUN", source_ref_id: ids["session"]!, target_ref_id: ids["run"]! }] : []),
      ]);
      reader = b.reader;
      // Neo4j's fulltext/vector indexes populate asynchronously; wait for them.
      if (b.kind === "neo4j") await b.bolt.run(`CALL db.awaitIndexes(60)`);
    });
    after(() => tb.close(b));

    it("getNode: jarvis envelope, hidden for soft-deleted", async () => {
      const n = await reader.getNode(ids["wf1"]!);
      assert.ok(n);
      assert.equal(n.node_type, "StrutWorkflow");
      assert.equal(n.name, "harvey-deliver");
      assert.equal(n.ref_id, ids["wf1"]);
      assert.equal(n.properties["description"], "Deliver legal memos to the client portal");
      for (const k of ["Data_Bank", "node_key", "namespace", "text_embeddings", "ref_id", "date_added_to_graph", "node_type", "deleted_at"]) assert.ok(!(k in n.properties), k);
      assert.equal(await reader.getNode(ids["wfHidden"]!), null);
      assert.equal(await reader.getNode("nope"), null);
    });

    it("getNodeByKey: an exact lookup by type + key, never a search", async () => {
      const key = String((await rawNode(b, ids["summary"]!))!.props["node_key"]);
      const n = await reader.getNodeByKey("Concept", key);
      assert.equal(n?.ref_id, ids["summary"]);
      assert.equal(n?.name, "GitHub webhooks");
      assert.equal(await reader.getNodeByKey("Concept", "concept-nope"), null);
      assert.equal(await reader.getNodeByKey("StrutRun", key), null, "the key under another type");
    });

    it("connectionCounts + edgeCounts", async () => {
      assert.deepEqual(await reader.connectionCounts(ids["wfv"]!), [
        { edge_type: "ACTIVE_VERSION", target_type: "StrutWorkflow", direction: "in", count: 1 },
        { edge_type: "EXECUTED", target_type: "StrutRun", direction: "in", count: 1 },
        { edge_type: "USES_STEP", target_type: "StrutStep", direction: "out", count: 1 },
        { edge_type: "VERSION_OF", target_type: "StrutWorkflow", direction: "out", count: 1 },
      ]);
      assert.deepEqual(await reader.edgeCounts([ids["run"]!, ids["wf3"]!], "default"), {
        [ids["run"]!]: neo ? { EXECUTED: 1, IN_RUN: 1 } : { EXECUTED: 1 },
      });
      assert.deepEqual(await reader.edgeCounts([], "default"), {});
    });

    it("a node with only deleted_at is hidden, and counts exclude deleted neighbours", async () => {
      // Backfilled/jarvis-deleted shape: deleted_at, no is_deleted, edges still there.
      await setNodeProps(b, ids["stepEmail"]!, { deleted_at: 1 });
      try {
        assert.equal(await reader.getNode(ids["stepEmail"]!), null);
        assert.ok(!(await reader.connectionCounts(ids["wfv"]!)).some((c) => c.edge_type === "USES_STEP"));
        assert.ok(!("USES_STEP" in ((await reader.edgeCounts([ids["wfv"]!], "default"))[ids["wfv"]!] ?? {})));
        assert.ok(!(await reader.neighbors(ids["wfv"]!)).nodes.some((n) => n.ref_id === ids["stepEmail"]));
      } finally {
        await setNodeProps(b, ids["stepEmail"]!, { deleted_at: null });
      }
      assert.ok(await reader.getNode(ids["stepEmail"]!), "restored");
    });

    it("neighbors: importance order, filters, exclusions, limit, counts; source included", async () => {
      const all = await reader.neighbors(ids["wfv"]!, { include_edge_counts: true });
      assert.equal(all.nodes.length, 4);
      assert.ok(all.nodes.some((n) => n.ref_id === ids["wfv"]));
      assert.equal(all.edges.length, 4);
      const uses = all.edges.find((e) => e.edge_type === "USES_STEP")!;
      assert.equal(uses.source, ids["wfv"]);
      assert.equal(uses.target, ids["stepEmail"]);
      assert.deepEqual(uses.properties, { importance: 0.9, date_added_to_graph: uses.properties["date_added_to_graph"] });
      assert.equal(uses.weight, 1);
      const step = all.nodes.find((n) => n.ref_id === ids["stepEmail"])!;
      assert.deepEqual(step.edges, { USES_STEP: 1 });
      assert.equal(step.properties["step_type"], "email/send");

      const limited = await reader.neighbors(ids["wfv"]!, { limit: 1 });
      assert.equal(limited.edges.length, 1);
      assert.equal(limited.edges[0]!.edge_type, "USES_STEP", "importance-sorted before LIMIT");

      const filtered = await reader.neighbors(ids["wfv"]!, { edge_types: ["VERSION_OF", "EXECUTED"], node_types: ["StrutRun"] });
      assert.deepEqual(filtered.edges.map((e) => e.edge_type), ["EXECUTED"]);
      const excluded = await reader.neighbors(ids["wfv"]!, { exclude_node_types: ["strutrun", "STRUTSTEP"] });
      assert.deepEqual(excluded.edges.map((e) => e.edge_type).sort(), ["ACTIVE_VERSION", "VERSION_OF"]);
      assert.deepEqual(await reader.neighbors("nope"), { nodes: [], edges: [] });
    });

    it("neighbors: the Concept tree by direction — a parent's children arrive, a child's parent leaves", async () => {
      const down = await reader.neighbors(ids["research"]!, { direction: "reverse", edge_types: ["CHILD_OF"] });
      assert.deepEqual(down.edges.map((e) => [e.source, e.target]), [[ids["playbook"], ids["research"]]]);
      assert.deepEqual(down.nodes.map((n) => n.ref_id).sort(), [ids["playbook"], ids["research"]].sort());
      assert.deepEqual((await reader.neighbors(ids["research"]!, { direction: "forward" })).edges, []);
      const up = await reader.neighbors(ids["playbook"]!, { direction: "forward" });
      assert.deepEqual(up.edges.map((e) => e.edge_type), ["CHILD_OF"]);
      assert.deepEqual(await reader.connectionCounts(ids["research"]!), [{ edge_type: "CHILD_OF", target_type: "Concept", direction: "in", count: 1 }]);
    });

    it("search: fulltext + semantic fusion, title boost, envelope, edge counts, soft-delete exclusion", async () => {
      const r = await reader.search({ q: "harvey", include_edge_counts: true });
      assert.ok(r.total >= 2);
      assert.equal(r.nodes[0]!.ref_id, ids["wf2"], "exact title match boosted to the top");
      assert.equal(r.nodes[0]!.score, 1);
      assert.equal(r.nodes[0]!.node_type, "StrutWorkflow");
      assert.ok(["fulltext", "semantic", "hybrid"].includes(r.nodes[0]!.match_type!));
      assert.ok(!("Data_Bank" in r.nodes[0]!.properties));
      assert.ok(!("text_embeddings" in r.nodes[0]!.properties));
      assert.ok(r.nodes.every((n) => n.ref_id !== ids["wfHidden"]), "soft-deleted excluded");
      const wf1 = r.nodes.find((n) => n.ref_id === ids["wf1"])!;
      assert.deepEqual(wf1.edges, { ACTIVE_VERSION: 1, VERSION_OF: 1 });
      assert.equal(r.truncated, false);
      assert.equal(r.warnings, undefined);
    });

    it("search: multi-word required terms, type filter, paging", async () => {
      const multi = await reader.search({ q: "legal memos" });
      assert.deepEqual(multi.nodes.map((n) => n.ref_id).slice(0, 1), [ids["wf1"]]);
      const typed = await reader.search({ q: "harvey", types: ["StrutRun"] });
      assert.deepEqual(typed.nodes.map((n) => n.node_type), ["StrutRun"]);
      assert.deepEqual((await reader.search({ q: "harvey", types: ["strutrun"] })).nodes.map((n) => n.node_type), ["StrutRun"], "a type resolves case-insensitively: the registry on a file, the resolver on Neo4j");
      const page1 = await reader.search({ q: "harvey", limit: 1 });
      const page2 = await reader.search({ q: "harvey", limit: 1, skip: 1 });
      assert.equal(page1.nodes.length, 1);
      assert.equal(page2.nodes.length, 1);
      assert.notEqual(page1.nodes[0]!.ref_id, page2.nodes[0]!.ref_id);
      assert.equal(page1.total, page2.total);
      assert.deepEqual(await reader.search({}), { nodes: [], total: 0, truncated: false });
    });

    it("search: fuzzy fallback on zero keyword hits", { skip: neoOnly("Lucene's ~ operator; the file's FTS has no fuzzy match") }, async () => {
      const fuzzy = await reader.search({ q: "benchmrk" });
      assert.ok(fuzzy.nodes.some((n) => n.ref_id === ids["wf3"]), "fuzzy ~ fallback finds gaia-eval");
    });

    it("search: any-word fallback when no node holds every word", { skip: neo && "ladybug only: Neo4j falls back to fuzzy" }, async () => {
      // No node has both `benchmark` and `memos`; the second pass takes either.
      const r = await reader.search({ q: "benchmark memos" });
      assert.ok(r.nodes.some((n) => n.ref_id === ids["wf3"]), "gaia-eval by `benchmark`");
      assert.ok(r.nodes.some((n) => n.ref_id === ids["wf1"]), "harvey-deliver by `memos`");
      // An exact query (one quoted span) gets no fallback: its words alone
      // are the noise the phrase left out — only the semantic half answers.
      const exact = await reader.search({ q: '"benchmark memos"' });
      assert.ok(exact.total > 0 && exact.nodes.every((n) => n.match_type === "semantic"), JSON.stringify(exact.nodes.map((n) => n.match_type)));
      // The semantic half still answers a keyword miss.
      assert.ok((await reader.search({ q: "benchmrk" })).nodes.every((n) => n.match_type === "semantic"));
    });

    it("search: a retriever layer failing (Lucene clause explosion) degrades to the other layers, like jarvis", { skip: neoOnly("Lucene's clause ceiling") }, async () => {
      // 15-property Strut fulltext index × 150 required terms > Lucene's 1024
      // clause ceiling → TooManyNestedClauses. The semantic layer still finds
      // the workflow; the failure is reported, not thrown.
      const words = Array.from({ length: 150 }, (_, i) => `harvey${i}`).join(" ") + " harvey";
      const r = await reader.search({ q: words });
      assert.ok(r.warnings?.some((w) => /fulltext layer error/.test(w)), JSON.stringify(r.warnings));
      assert.ok(r.nodes.some((n) => n.ref_id === ids["wf2"]), "semantic (bag-of-words) hit survives");
      assert.ok(r.nodes.every((n) => n.match_type === "semantic"));
      const fine = await reader.search({ q: "harvey" });
      assert.equal(fine.warnings, undefined);
    });

    it("search: input_q/output_q hit the per-stem vector indexes (k=50, floor 0.4, weight 1.2)", { skip: neoOnly("per-stem vectors are not in the file") }, async () => {
      const byInput = await reader.search({ input_q: "a video url" });
      assert.equal(byInput.nodes[0]!.ref_id, ids["stepVideo"]);
      assert.equal(byInput.nodes[0]!.match_type, "input");
      assert.ok(byInput.nodes.every((n) => ["StrutStep", "StrutWorkflowVersion"].includes(n.node_type!)));
      const byOutput = await reader.search({ output_q: "message id" });
      assert.equal(byOutput.nodes[0]!.ref_id, ids["stepEmail"]);
      const combined = await reader.search({ q: "transcribe", input_q: "video" });
      assert.equal(combined.nodes[0]!.ref_id, ids["stepVideo"]);
      assert.equal(combined.nodes[0]!.match_type, "hybrid");
    });

    it("search: input_q/output_q alone find nothing on a file, and say so", { skip: neo && "ladybug only" }, async () => {
      const r = await reader.search({ input_q: "a video url" });
      assert.deepEqual(r.nodes, []);
      assert.match(r.warnings![0]!, /per-field vectors/);
      const combined = await reader.search({ q: "transcribe", input_q: "video" });
      assert.equal(combined.nodes[0]!.ref_id, ids["stepVideo"]);
      assert.match(combined.warnings![0]!, /per-field vectors/);
    });

    it("search: exclude leaves Concepts out by their file; one with no file stays", async () => {
      const all = await reader.search({ q: "webhook", types: ["Concept"], limit: 20 });
      assert.deepEqual(all.nodes.map((n) => n.properties["name"]).sort(), ["GitHub webhooks", "Old webhook summary", "Research", "Webhook research playbook"]);
      const r = await reader.search({ q: "webhook", types: ["Concept"], limit: 20, exclude: ["src/lib", "*.spec.ts"] });
      assert.deepEqual(r.nodes.map((n) => n.properties["name"]).sort(), ["Old webhook summary", "Research", "Webhook research playbook"]);
      // `old` is a whole segment: `src/old/` goes, `Old webhook summary`'s name is not a path.
      const seg = await reader.search({ q: "webhook", types: ["Concept"], limit: 20, exclude: ["old", "lib"] });
      assert.deepEqual(seg.nodes.map((n) => n.properties["name"]).sort(), ["Research", "Webhook research playbook"]);
    });

    it("search: linked keeps the Concepts tied by an edge, in its direction; a malformed entry is refused", async () => {
      const names = (r: SearchResult) => r.nodes.map((n) => String(n.properties["name"])).sort();
      const linked = async (...entries: string[]) => names(await reader.search({ q: "webhook", types: ["Concept"], limit: 20, linked: entries }));
      assert.deepEqual(await linked("CHILD_OF>Concept"), ["Webhook research playbook"], "the edge leaves the child");
      assert.deepEqual(await linked("CHILD_OF<Concept"), ["Research"], "and arrives at the parent");
      assert.deepEqual(await linked("CHILD_OF>concept"), ["Webhook research playbook"], "the type resolves like `type`'s");
      assert.deepEqual(await linked("CHILD_OF>StrutRun"), [], "the node at the other end must be of the type");
      assert.deepEqual(await linked("MODIFIES>Concept"), [], "an edge type the graph does not hold");
      assert.deepEqual(await linked("MODIFIES>Concept", "CHILD_OF<Concept"), ["Research"], "any one passes");
      await assert.rejects(reader.search({ q: "webhook", linked: ["CHILD_OF"] }), (e: unknown) => e instanceof GraphReadError && e.code === "INVALID_INPUT");
    });

    it("search: the strut domain, an unknown domain, an unregistered namespace", async () => {
      const strut = await reader.search({ q: "harvey", domains: ["strut"] });
      assert.ok(strut.nodes.length >= 2);
      assert.ok(strut.nodes.every((n) => n.node_type!.startsWith("Strut")));
      assert.equal((await reader.search({ q: "webhook", domains: ["strut"] })).nodes.filter((n) => n.node_type === "Concept").length, 0, "a Concept is outside the domain");
      await assert.rejects(reader.search({ q: "harvey", domains: ["legal"] }), (e: unknown) => e instanceof GraphReadError && e.code === "INVALID_DOMAIN");
      await assert.rejects(reader.search({ q: "harvey", namespace: "tenant-x" }), (e: unknown) => e instanceof GraphReadError && e.code === "INVALID_NAMESPACE");
      assert.equal(await reader.resolveNamespace(undefined), "default");
      assert.equal(await reader.resolveNamespace("DEFAULT"), "default");
    });

    it("namespaces are registered on Neo4j", { skip: neoOnly("the file holds one") }, async () => {
      assert.deepEqual(await reader.registerNamespace("Tenant-X"), { namespace: "tenant-x", created: true });
      assert.deepEqual(await reader.registerNamespace("tenant-x"), { namespace: "tenant-x", created: false });
      assert.deepEqual(await reader.listNamespaces(), ["tenant-x"]);
      const ns = await (b as Neo4jBackend).bolt.run(`MATCH (n:NameSpace) RETURN count(n) AS c, collect(n.data)[0] AS data`);
      assert.deepEqual(ns[0], { c: 1, data: ["tenant-x"] });
      const empty = await reader.search({ q: "harvey", namespace: "tenant-x" });
      assert.equal(empty.total, 0);
    });

    it("a file holds one namespace: none to list, none to register", { skip: neo && "ladybug only" }, async () => {
      assert.deepEqual(await reader.listNamespaces(), []);
      await assert.rejects(reader.registerNamespace("tenant-x"), (e: unknown) => e instanceof GraphReadError && e.code === "INVALID_INPUT");
      await assert.rejects(reader.getNodeByKey("Concept", "concept-research", "tenant-x"), (e: unknown) => e instanceof GraphReadError && e.code === "INVALID_NAMESPACE");
    });

    it("ontology: listSchemas and getSchema mirror jarvis's shapes", { skip: neoOnly("the Schema meta-graph with Thing") }, async () => {
      const { schemas, edges } = await reader.listSchemas();
      assert.equal(schemas.length, 12, "the Strut domain, Thing, and the Concept the suite seeded");
      const run = schemas.find((s) => s.type === "StrutRun")!;
      assert.equal(run["domain"], "Strut");
      assert.equal(run["parent"], "Thing");
      assert.deepEqual(run["index"], ["workflow_name", "run_status", "summary"]);
      assert.equal(run.attributes["run_id"], "string");
      assert.ok(!("name" in run.attributes), "parent attrs moved out");
      assert.equal(run.inherited_attributes["name"], "string");
      assert.equal(run["description"], "?string", "description is a core key in jarvis, not an attribute");
      assert.equal(run["type_description"], "One strut workflow run — status, timings, params, and a pointer to its log");
      assert.ok(edges.some((e) => e.edge_type === "CHILD_OF" && e.source_type === "StrutRun" && e.target_type === "Thing"));
      assert.ok(edges.some((e) => e.edge_type === "IN_RUN" && e.source_type === "StrutAgentSession" && e.target_type === "StrutRun"));
      assert.ok(edges.some((e) => e.edge_type === "ACCESSED" && e.target_type === "Thing"));

      const only = await reader.listSchemas({ domains: ["STRUT"] });
      assert.equal(only.schemas.length, 10);
      assert.ok(only.edges.every((e) => e.source_type !== "Thing" && e.target_type !== "Thing"), "Thing is outside the domain and not a wildcard");
      assert.ok(!only.edges.some((e) => e.edge_type === "ACCESSED" || e.edge_type === "CHILD_OF"));
      assert.ok(only.edges.some((e) => e.edge_type === "IN_RUN"));

      const single = await reader.getSchema("strutrun");
      assert.ok(single);
      assert.equal(single.type, "StrutRun");
      assert.equal(single.attributes["run_id"], "string");
      assert.equal(single.attributes["name"], "string", "single form keeps inherited in attributes");
      assert.deepEqual(Object.keys(single.inherited_attributes).sort(), ["image_url", "is_muted", "name", "unique_source_id", "weight"]);
      // jarvis's get_schema only special-cases the exact string "Thing"; any
      // other spelling falls into the case-insensitive walk and still resolves.
      assert.equal((await reader.getSchema("thing"))?.type, "Thing");
      assert.equal((await reader.getSchema("Thing"))?.type, "Thing");
      assert.equal(await reader.getSchema("Nope"), null);
    });

    it("ontology: the registry's ten types and fifteen edges, in jarvis's shapes", { skip: neo && "ladybug only" }, async () => {
      const { schemas, edges } = await reader.listSchemas();
      assert.deepEqual(schemas.map((s) => s.type).sort(), ["Check", "Claim", "Concept", "Evidence", "StrutJob", "StrutRun", "StrutStep", "StrutStepVersion", "StrutWorkflow", "StrutWorkflowVersion"]);
      const run = schemas.find((s) => s.type === "StrutRun")!;
      assert.equal(run["domain"], "Strut");
      assert.equal(run["parent"], "Thing");
      assert.deepEqual(run["index"], ["workflow_name", "run_status", "summary"]);
      assert.equal(run.attributes["run_id"], "string");
      assert.ok("name" in run.attributes, "Thing's name is an attribute of the type here: there is no Thing node to inherit from");
      assert.ok(!("weight" in run.attributes) && !("is_muted" in run.attributes), "Thing's vestiges are not in the file");
      assert.equal(run["type_description"], "One strut workflow run — status, timings, params, and a pointer to its log");
      const concept = schemas.find((s) => s.type === "Concept")!;
      assert.equal(concept["domain"], undefined);
      assert.equal(concept["node_key"], "concept-name");
      assert.equal(concept.attributes["file"], "?string");
      assert.equal(new Set(edges.map((e) => e.edge_type)).size, 15);
      assert.ok(edges.some((e) => e.edge_type === "CHILD_OF" && e.source_type === "Concept" && e.target_type === "Concept"));
      assert.ok(edges.some((e) => e.edge_type === "PARENT_OF" && e.source_type === "Concept" && e.target_type === "Concept"));
      assert.ok(edges.some((e) => e.edge_type === "ABOUT" && e.source_type === "Claim" && e.target_type === "StrutWorkflow"));
      assert.ok(!edges.some((e) => e.target_type === "Thing" || e.edge_type === "IN_RUN" || e.edge_type === "ACCESSED"));

      const only = await reader.listSchemas({ domains: ["STRUT"] });
      assert.equal(only.schemas.length, 6);
      assert.ok(only.edges.every((e) => e.source_type.startsWith("Strut") && e.target_type.startsWith("Strut")));

      const single = await reader.getSchema("strutrun");
      assert.equal(single?.type, "StrutRun");
      assert.equal(single?.attributes["run_id"], "string");
      assert.equal((await reader.getSchema("CONCEPT"))?.type, "Concept");
      assert.equal(await reader.getSchema("Thing"), null, "no Thing node in the file");
      assert.equal(await reader.getSchema("StrutAgentSession"), null);
      assert.equal(await reader.getSchema("Nope"), null);
    });
  });
}

describe("index routing + typed over-fetch (pure)", () => {
  const existing = new Set(["data_bank_attribute_index_v2", "text_embeddings_vector_index", "domain_strut_vector_index", "domain_codeartifact_vector_index", "domain_strut_attribute_index_v2"]);
  const vec = (r: Partial<Parameters<typeof routeIndexes>[0]>) =>
    routeIndexes({ domains: [], visibleDomains: ["strut", "codeartifact"], existing, suffix: "_vector_index", global: "text_embeddings_vector_index", ...r });

  it("an explicit domains filter → those domains' indexes", () => {
    assert.deepEqual(vec({ domains: ["strut"] }), ["domain_strut_vector_index"]);
    assert.deepEqual(vec({ domains: ["strut", "nope"] }), ["domain_strut_vector_index"], "absent ones dropped");
  });
  it("a typed search → the union of the types' domain indexes; no domain, hidden, or no index → the global one", () => {
    assert.deepEqual(vec({ typeDomains: new Map([["Function", "codeartifact"]]) }), ["domain_codeartifact_vector_index"]);
    assert.deepEqual(vec({ typeDomains: new Map([["Function", "codeartifact"], ["Endpoint", "codeartifact"]]) }), ["domain_codeartifact_vector_index"]);
    assert.deepEqual(vec({ typeDomains: new Map([["Context", null]]) }), ["text_embeddings_vector_index"]);
    assert.deepEqual(vec({ typeDomains: new Map([["Document", "content"]]) }), ["text_embeddings_vector_index"], "a domain whose index is absent");
    assert.deepEqual(vec({ typeDomains: new Map([["Function", "codeartifact"], ["Context", null]]) }), ["domain_codeartifact_vector_index", "text_embeddings_vector_index"]);
  });
  it("neither → the global index, or the visible domains' union where it is absent", () => {
    assert.deepEqual(vec({}), ["text_embeddings_vector_index"]);
    const noGlobal = new Set([...existing].filter((i) => i !== "text_embeddings_vector_index"));
    assert.deepEqual(vec({ existing: noGlobal }), ["domain_strut_vector_index", "domain_codeartifact_vector_index"]);
    assert.deepEqual(vec({ existing: noGlobal, typeDomains: new Map([["Context", null]]) }), ["domain_strut_vector_index", "domain_codeartifact_vector_index"]);
    assert.deepEqual(routeIndexes({ domains: [], visibleDomains: ["strut"], existing, suffix: "_attribute_index_v2", global: "data_bank_attribute_index_v2" }), ["data_bank_attribute_index_v2"]);
  });
  it("overfetch widens from cap × 10 by × 4 until cap survive or k reaches 2000; the query is run with each k", async () => {
    const ks: number[] = [];
    const survivors = (n: number) => Array.from({ length: n }, (_, i) => i);
    assert.equal((await overfetch(120, async (k) => (ks.push(k), survivors(k >= 2000 ? 120 : 3)))).length, 120);
    assert.deepEqual(ks, [1200, 2000]);
    ks.length = 0;
    assert.equal((await overfetch(120, async (k) => (ks.push(k), survivors(120)))).length, 120);
    assert.deepEqual(ks, [1200], "stops as soon as cap survive");
    ks.length = 0;
    assert.equal((await overfetch(5000, async (k) => (ks.push(k), survivors(1)))).length, 1);
    assert.deepEqual(ks, [2000], "a cap past the ceiling is one query at the ceiling");
    ks.length = 0;
    await overfetch(10, async (k) => (ks.push(k), []), { start: 2, growth: 3, maxK: 100 });
    assert.deepEqual(ks, [20, 60, 100]);
  });
});

describe("typed search routes through the type's domain index (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  let resolver: SchemaResolver;
  let reader: Neo4jReader;
  /** Every vector query the reader ran: the index and its k. */
  const calls: Array<{ index: string; k: number }> = [];
  const Q = "workspace access check";
  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
    await wipeGraph(bolt);
    await seedStrutDomain(bolt);
    // Two jarvis-typed Schemas by hand: a code type in CodeArtifact (with
    // the domain's vector index, as jarvis's seed and strut's ontology seed
    // create it) and a type with no domain at all.
    await bolt.run(
      `MATCH (t:Schema {type: "Thing"})
       CREATE (f:Schema {type: "Function", parent: "Thing", domain: "CodeArtifact", node_key: "function-name-file", index: ["name", "summary", "description"], name: "string", file: "string", summary: "?string", description: "?string", ref_id: "schema-function"})-[:CHILD_OF {ref_id: "e1"}]->(t)
       CREATE (c:Schema {type: "Context", parent: "Thing", node_key: "context-name", index: ["name"], name: "string", ref_id: "schema-context"})-[:CHILD_OF {ref_id: "e2"}]->(t)`,
    );
    await bolt.run(
      `CREATE VECTOR INDEX domain_codeartifact_vector_index IF NOT EXISTS FOR (n:Domain_codeartifact) ON n.text_embeddings
       OPTIONS { indexConfig: { \`vector.dimensions\`: 384, \`vector.similarity_function\`: 'cosine' } }`,
    );
    resolver = new SchemaResolver(bolt);
    const nodes = new NodeWriter(bolt, { embedder: bow, resolver });
    await nodes.writeMany([
      { type: "Function", data: { name: "resolveWorkspaceAccess", file: "src/access.ts", description: Q } },
      { type: "Context", data: { name: "unrelated gamma delta" } },
    ]);
    // 1,300 decoys NEARER to the query than the function (their text IS the
    // query), in another domain and on the global index — more than a
    // typed search's first k (cap × 10 = 1,200).
    const [v] = await bow.embed([Q]);
    await bolt.run(
      `UNWIND range(1, 1300) AS i
       CREATE (n:StrutRun:Node:Data_Bank:Domain_strut)
       SET n.node_key = 'strutrun-decoy-' + i, n.ref_id = 'decoy-' + i, n.namespace = 'default', n.run_id = 'decoy-' + i,
           n.Data_Bank = $q, n.text_embeddings = $v, n.date_added_to_graph = 1`,
      { q: Q, v },
    );
    await bolt.run(`CALL db.awaitIndexes(60)`);
    const spy = new Proxy(bolt, {
      get(t, k, r) {
        if (k !== "run") return Reflect.get(t, k, r);
        return (cypher: string, params?: Record<string, unknown>) => {
          if (params && typeof params["index"] === "string" && "k" in params) calls.push({ index: params["index"], k: Number(String(params["k"])) });
          return t.run(cypher, params);
        };
      },
    });
    reader = new Neo4jReader(spy, { embedder: bow, resolver });
  });
  after(async () => {
    await bolt?.close();
  });

  it("a code type is found through its domain index among nearer decoys elsewhere", async () => {
    calls.length = 0;
    const r = await reader.search({ q: Q, types: ["Function"] });
    assert.deepEqual(r.nodes.map((n) => n.properties["name"]), ["resolveWorkspaceAccess"]);
    assert.deepEqual(calls.map((c) => c.index), ["domain_codeartifact_vector_index", "domain_codeartifact_vector_index"]);
    assert.deepEqual(calls.map((c) => c.k), [1200, 2000], "widened once: one node can never make cap");
  });

  it("a type with no domain goes to the global index, and the over-fetch reaches past the decoys", async () => {
    calls.length = 0;
    const r = await reader.search({ q: Q, types: ["Context"] });
    assert.deepEqual(r.nodes.map((n) => n.properties["name"]), ["unrelated gamma delta"]);
    assert.deepEqual(calls, [{ index: "text_embeddings_vector_index", k: 1200 }, { index: "text_embeddings_vector_index", k: 2000 }]);
    calls.length = 0;
    const both = await reader.search({ q: Q, types: ["Function", "Context"] });
    assert.deepEqual(both.nodes.map((n) => n.properties["name"]).sort(), ["resolveWorkspaceAccess", "unrelated gamma delta"]);
    assert.deepEqual(new Set(calls.map((c) => c.index)), new Set(["domain_codeartifact_vector_index", "text_embeddings_vector_index"]));
  });

  it("an untyped search reads the global index with no over-fetch; a domains filter its domain's", async () => {
    calls.length = 0;
    const r = await reader.search({ q: Q, limit: 5 });
    assert.equal(r.nodes.length, 5);
    assert.deepEqual(calls, [{ index: "text_embeddings_vector_index", k: 120 }]);
    calls.length = 0;
    const d = await reader.search({ q: Q, domains: ["codeartifact"] });
    assert.deepEqual(d.nodes.map((n) => n.properties["name"]), ["resolveWorkspaceAccess"]);
    assert.deepEqual(calls.map((c) => c.index), ["domain_codeartifact_vector_index"]);
  });

  it("a hidden domain's types stay out of an untyped search, and a typed search for one falls back to the global index", async () => {
    await bolt.run(`CREATE (:About {hidden_domains: ["CodeArtifact"]})`);
    resolver.invalidate();
    try {
      const r = await reader.search({ q: Q, limit: 2000 });
      assert.ok(!r.nodes.some((n) => n.node_type === "Function"), "hidden");
      calls.length = 0;
      const typed = await reader.search({ q: Q, types: ["Function"] });
      assert.deepEqual(typed.nodes.map((n) => n.properties["name"]), ["resolveWorkspaceAccess"]);
      assert.deepEqual(calls.map((c) => c.index), ["text_embeddings_vector_index", "text_embeddings_vector_index"]);
    } finally {
      await bolt.run(`MATCH (a:About) DELETE a`);
      resolver.invalidate();
    }
  });
});

describe("query shape: a prose question vs an exact string (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  let reader: Neo4jReader;
  /** Every Lucene query the reader ran. */
  const lucene: string[] = [];
  const names = (r: Awaited<ReturnType<GraphReader["search"]>>) => r.nodes.map((n) => String(n.properties["name"]));
  const matchOf = (r: Awaited<ReturnType<GraphReader["search"]>>, name: string) =>
    (r.nodes.find((n) => n.properties["name"] === name) as { match_type?: string } | undefined)?.match_type;
  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
    await wipeGraph(bolt);
    await seedJarvisOntology(bolt);
    await seedStrutDomain(bolt);
    const resolver = new SchemaResolver(bolt);
    await new NodeWriter(bolt, { embedder: bow, resolver }).writeMany([
      // Wide semantic margins: the vector index scores approximately (by
      // ~0.01 on these sparse vectors), so near-ties can swap.
      { type: "Function", data: { name: "usePusherConnection", file: "src/hooks/usePusherConnection.ts", description: "Pushes live updates to the browser over a websocket" } },
      { type: "Function", data: { name: "handleWebhook", file: "src/app/api/github/webhook/route.ts", description: "Verifies a GitHub webhook", body: 'const signature = req.headers.get("x-hub-signature-256")' } },
      { type: "Function", data: { name: "X", file: "src/x.ts", description: "Posts to X", body: "const x = 256" } },
    ]);
    // A prompt constant (swarm38's getPlannerCapabilitySnippet): its body
    // holds every word of the question, its own text nothing like it. No
    // vector, so only the keyword half finds it — on a graph of thousands
    // it sits far down the semantic list.
    await bolt.run(
      `CREATE (n:Function:Node:Data_Bank:Domain_codeartifact)
       SET n.name = 'getPlannerPrompt', n.file = 'src/prompt.ts', n.node_key = 'function-getplannerprompt', n.ref_id = 'prompt-1',
           n.namespace = 'default', n.Data_Bank = 'getPlannerPrompt', n.body = $body, n.date_added_to_graph = 1`,
      { body: "Explain how we do live updates: they reach the browser while a task is running. " + "More planner prompt text. ".repeat(50) },
    );
    await bolt.run(`CALL db.awaitIndexes(60)`);
    const spy = new Proxy(bolt, {
      get(t, k, r) {
        if (k !== "run") return Reflect.get(t, k, r);
        return (cypher: string, params?: Record<string, unknown>) => {
          if (params && typeof params["q_lucene"] === "string") lucene.push(params["q_lucene"]);
          return t.run(cypher, params);
        };
      },
    });
    reader = new Neo4jReader(spy, { embedder: bow, resolver });
  });
  after(async () => {
    await bolt?.close();
  });

  it("a prose question: the semantic hit ranks above a keyword-only match on a long body", async () => {
    // Six terms after the analyzer: the seeded index spans 158 properties,
    // and Lucene refuses past 1,024 clauses (the keyword half then drops out).
    const r = await reader.search({ q: "how do live updates reach the browser", types: ["Function"] });
    assert.equal(names(r)[0], "usePusherConnection");
    assert.ok(names(r).indexOf("getPlannerPrompt") > 0, names(r).join(", "));
    assert.deepEqual([matchOf(r, "usePusherConnection"), matchOf(r, "getPlannerPrompt")], ["semantic", "fulltext"]);
  });

  it("an exact string is matched as a phrase, not by its fragments, and gets no any-word fallback", async () => {
    lucene.length = 0;
    const r = await reader.search({ q: "x-hub-signature-256", types: ["Function"] });
    assert.equal(names(r)[0], "handleWebhook");
    assert.equal(matchOf(r, "X"), "semantic", "`x` and `256` alone are not a keyword match");
    assert.deepEqual(lucene, ['"x-hub-signature-256"']);
    lucene.length = 0;
    await reader.search({ q: "no-such-header", types: ["Function"] });
    assert.deepEqual(lucene, ['"no-such-header"'], "nothing found, no fallback");
    lucene.length = 0;
    await reader.search({ q: "how are api keys rotated", types: ["Function"] });
    assert.equal(lucene.length, 2, "a question that finds nothing still falls back");
    assert.ok(lucene[1]!.endsWith("~"));
  });
});

describe("exclude: leaving results out by path (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  let reader: Neo4jReader;
  /** Every index call the reader ran: the index and its k (a keyword call's `limit`). */
  const calls: Array<{ index: string; k: number }> = [];
  const keywordKs = () => calls.filter((c) => c.index.endsWith("_attribute_index_v2")).map((c) => c.k);
  const names = (r: Awaited<ReturnType<GraphReader["search"]>>) => r.nodes.map((n) => String(n.properties["name"]));
  const Q = "github webhook signature";
  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
    await wipeGraph(bolt);
    await seedJarvisOntology(bolt);
    await seedStrutDomain(bolt);
    const resolver = new SchemaResolver(bolt);
    await new NodeWriter(bolt, { embedder: bow, resolver }).writeMany([
      { type: "Function", data: { name: "verifySignature", file: "src/lib/github/verify.ts", description: "Checks a GitHub webhook signature" } },
      { type: "Function", data: { name: "mockVerifySignature", file: "src/app/api/mock/github/verify.ts", description: "Checks a GitHub webhook signature for the mock server" } },
      { type: "Function", data: { name: "verifySignatureTest", file: "src/__tests__/unit/verify.test.ts", description: "Checks a GitHub webhook signature in a test" } },
      { type: "Function", data: { name: "verifySignatureSpec", file: "src/lib/github/verify.spec.ts", description: "Checks a GitHub webhook signature in a spec" } },
      { type: "Function", data: { name: "verifySignatureCapital", file: "src/Test/github/verify.ts", description: "Checks a GitHub webhook signature under a capitalized test directory" } },
      { type: "Function", data: { name: "latestSignature", file: "src/testimonials/latest.ts", description: "Checks the latest GitHub webhook signature" } },
      { type: "Concept", data: { name: "GitHub webhooks", description: "How a GitHub webhook signature is checked" } },
    ]);
    // 130 keyword matches in a test directory, each a better match than the
    // one real function (the query's words in a short description; the real
    // one's in a long one) — more than the index's first `cap` (120). No
    // vectors: only the keyword half finds any of them. `ref_id` and
    // `node_key` are keyword fields too, so neither holds a query word.
    await bolt.run(
      `UNWIND range(1, 130) AS i
       CREATE (n:Function:Node:Data_Bank:Domain_codeartifact)
       SET n.name = 'secretFixture' + i, n.file = 'src/__tests__/fixtures/secret-' + i + '.test.ts', n.node_key = 'function-decoy-' + i,
           n.ref_id = 'decoy-' + i, n.namespace = 'default', n.description = 'Rotate the signing secret', n.date_added_to_graph = 1`,
    );
    await bolt.run(
      `CREATE (n:Function:Node:Data_Bank:Domain_codeartifact)
       SET n.name = 'rotateSigningSecret', n.file = 'src/lib/secrets/rotate.ts', n.node_key = 'function-rotatesigningsecret',
           n.ref_id = 'real-1', n.namespace = 'default', n.description = $description, n.date_added_to_graph = 1`,
      { description: "Rotates the signing secret of a workspace's webhooks when an admin asks. " + "It writes the new value and keeps the old one for an hour. ".repeat(10) },
    );
    await bolt.run(`CALL db.awaitIndexes(60)`);
    const spy = new Proxy(bolt, {
      get(t, k, r) {
        if (k !== "run") return Reflect.get(t, k, r);
        return (cypher: string, params?: Record<string, unknown>) => {
          const limit = params?.["k"] ?? (params?.["fulltext_options"] as { limit?: unknown } | undefined)?.limit;
          if (typeof params?.["index"] === "string" && limit !== undefined) calls.push({ index: params["index"], k: Number(String(limit)) });
          return t.run(cypher, params);
        };
      },
    });
    reader = new Neo4jReader(spy, { embedder: bow, resolver });
  });
  after(async () => {
    await bolt?.close();
  });

  it("a typed search leaves out what an entry matches and keeps the rest", async () => {
    const all = await reader.search({ q: Q, types: ["Function"], limit: 20 });
    assert.equal(all.nodes.length, 6, names(all).join(", "));
    // `test` is a whole segment, in any case: `src/Test/` goes, `src/testimonials/` stays.
    const r = await reader.search({ q: Q, types: ["Function"], limit: 20, exclude: ["__tests__", "test", "src/app/api/mock", "*.spec.ts"] });
    assert.deepEqual(names(r).sort(), ["latestSignature", "verifySignature"]);
  });

  it("a node with no `file` is never left out; an untyped search over-fetches both halves when excluding", async () => {
    calls.length = 0;
    const all = await reader.search({ q: Q, limit: 20 });
    assert.equal(all.nodes.length, 7, names(all).join(", "));
    assert.deepEqual(calls, [{ index: "data_bank_attribute_index_v2", k: 120 }, { index: "text_embeddings_vector_index", k: 120 }], "no exclude: as before");
    calls.length = 0;
    // `src` leaves out every function here; the concept has no `file`.
    const r = await reader.search({ q: Q, limit: 20, exclude: ["src"] });
    assert.deepEqual(names(r), ["GitHub webhooks"]);
    assert.deepEqual(calls, [
      { index: "data_bank_attribute_index_v2", k: 1200 },
      { index: "data_bank_attribute_index_v2", k: 2000 },
      { index: "text_embeddings_vector_index", k: 1200 },
      { index: "text_embeddings_vector_index", k: 2000 },
    ]);
  });

  it("the keyword half over-fetches too: 130 test-directory matches above the one real function", async () => {
    const q = "rotate signing secret";
    calls.length = 0;
    const crowded = await reader.search({ q, types: ["Function"] });
    assert.ok(!names(crowded).includes("rotateSigningSecret"), names(crowded).join(", "));
    assert.ok(crowded.nodes.some((n) => String(n.properties["file"]).includes("/__tests__/")));
    assert.deepEqual(keywordKs(), [120], "the index's first 120 are all fixtures");
    calls.length = 0;
    const r = await reader.search({ q, types: ["Function"], exclude: ["__tests__"] });
    assert.equal(names(r)[0], "rotateSigningSecret");
    assert.ok(r.nodes.every((n) => !String(n.properties["file"]).includes("/__tests__/")), names(r).join(", "));
    assert.deepEqual(keywordKs(), [1200, 2000]);
  });
});

describe("linked: keeping results tied by an edge (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  let reader: Neo4jReader;
  /** Every index call the reader ran: the index and its k (a keyword call's `limit`). */
  const calls: Array<{ index: string; k: number }> = [];
  const names = (r: Awaited<ReturnType<GraphReader["search"]>>) => r.nodes.map((n) => String(n.properties["name"])).sort();
  const Q = "github webhook signature";
  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
    await wipeGraph(bolt);
    await seedJarvisOntology(bolt);
    await seedStrutDomain(bolt);
    const resolver = new SchemaResolver(bolt);
    // The Concepts a swarm holds: a summary of code (gitree's, tied to the
    // files it covers), an agent's learning, a playbook in a tree — all
    // about the same words.
    const [summary, learning, playbook, root, stale, verify, old] = await new NodeWriter(bolt, { embedder: bow, resolver }).writeMany([
      { type: "Concept", data: { name: "GitHub webhooks", description: "How a GitHub webhook signature is checked" } },
      { type: "Concept", data: { name: "Webhook reply etiquette", description: "How to answer a question about a GitHub webhook signature" } },
      { type: "Concept", data: { name: "Webhook research playbook", description: "Researching a GitHub webhook signature question" } },
      { type: "Concept", data: { name: "Research", description: "Playbooks" } },
      { type: "Concept", data: { name: "Old webhook summary", description: "How a GitHub webhook signature was checked" } },
      { type: "File", data: { name: "verify.ts", file: "src/lib/github/verify.ts" } },
      { type: "File", data: { name: "old.ts", file: "src/lib/github/old.ts" } },
    ]).then((rs) => rs.map((r) => r.ref_id));
    const pr = "pr-12";
    await bolt.run(`CREATE (p:PullRequest:Data_Bank {ref_id: $pr, name: 'Verify webhook signatures', namespace: 'default'})`, { pr });
    const edge = (a: string | undefined, type: string, b: string | undefined, props: Record<string, unknown> = {}) =>
      bolt.run(`MATCH (a:Data_Bank {ref_id: $a}), (b:Data_Bank {ref_id: $b}) CREATE (a)-[r:${type}]->(b) SET r = $props`, { a, b, props });
    await edge(summary, "MODIFIES", verify, { importance: 0.5 });
    // A legacy muted edge, and an edge to a deleted file, count for nothing.
    await edge(learning, "MODIFIES", verify, { is_muted: true });
    await edge(stale, "MODIFIES", old);
    await edge(pr, "TOUCHES", summary);
    await edge(root, "PARENT_OF", playbook);
    await bolt.run(`MATCH (f:File {ref_id: $old}) SET f.deleted_at = 1`, { old });
    await bolt.run(`CALL db.awaitIndexes(60)`);
    const spy = new Proxy(bolt, {
      get(t, k, r) {
        if (k !== "run") return Reflect.get(t, k, r);
        return (cypher: string, params?: Record<string, unknown>) => {
          const limit = params?.["k"] ?? (params?.["fulltext_options"] as { limit?: unknown } | undefined)?.limit;
          if (typeof params?.["index"] === "string" && limit !== undefined) calls.push({ index: params["index"], k: Number(String(limit)) });
          return t.run(cypher, params);
        };
      },
    });
    reader = new Neo4jReader(spy, { embedder: bow, resolver });
  });
  after(async () => {
    await bolt?.close();
  });

  it("a typed search keeps only the results with a live edge of that type, in that direction, to a live node of that type", async () => {
    const all = await reader.search({ q: Q, types: ["Concept"], limit: 20 });
    assert.deepEqual(names(all), ["GitHub webhooks", "Old webhook summary", "Research", "Webhook reply etiquette", "Webhook research playbook"], "every Concept, without `linked`");
    const linked = async (...entries: string[]) => names(await reader.search({ q: Q, types: ["Concept"], limit: 20, linked: entries }));
    assert.deepEqual(await linked("MODIFIES>File"), ["GitHub webhooks"], "the muted edge and the deleted file count for nothing");
    assert.deepEqual(await linked("MODIFIES<File"), [], "the edge leaves the Concept");
    assert.deepEqual(await linked("TOUCHES<PullRequest"), ["GitHub webhooks"]);
    assert.deepEqual(await linked("MODIFIES>Function"), [], "the node at the other end must be of the type");
    assert.deepEqual(await linked("MODIFIES>File", "PARENT_OF<Concept"), ["GitHub webhooks", "Webhook research playbook"], "any one passes");
    assert.deepEqual(await linked("MODIFIES>file"), ["GitHub webhooks"], "the type resolves like `type`'s");
  });

  it("an untyped search over-fetches both halves when linked; a malformed entry is refused before any index call", async () => {
    calls.length = 0;
    const r = await reader.search({ q: Q, limit: 20, linked: ["MODIFIES>File"] });
    assert.deepEqual(names(r), ["GitHub webhooks"]);
    assert.deepEqual(calls, [
      { index: "data_bank_attribute_index_v2", k: 1200 },
      { index: "data_bank_attribute_index_v2", k: 2000 },
      { index: "text_embeddings_vector_index", k: 1200 },
      { index: "text_embeddings_vector_index", k: 2000 },
    ]);
    calls.length = 0;
    await assert.rejects(reader.search({ q: Q, linked: ["MODIFIES"] }), (e: unknown) => e instanceof GraphReadError && e.code === "INVALID_INPUT");
    assert.deepEqual(calls, []);
  });
});
