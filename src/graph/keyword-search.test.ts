/**
 * Keyword search on a Ladybug file (src/graph/text-match.ts): any query
 * word finds a candidate, nodes and facts are ranked together by how rare
 * the words they match are, and a word may meet a typo, a
 * node's `alt_names`, the edge type a fact is of, or the user. Keyword
 * only, as Peel's desktop build searches (no embedder).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { assertEdge } from "./temporal.js";
import { testBackends } from "./test-util.js";
import graphSearch from "../steps/lib/graph/graph-search.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const run = (cfg: Record<string, unknown>, b: LadybugBackend): Promise<any> =>
  graphSearch.run(graphSearch.input.parse(cfg), { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: { graph: b } } as any);

describe("keyword search on a ladybug file", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  const id: Record<string, string> = {};
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
    for (const type of ["Company", "Place"]) {
      await createNodeSchema(b, b.schemas, { type, attributes: { description: "?string", alt_names: "?list" }, index: ["name", "description"], role: "entity" });
    }
    await b.schemas.createEdgeSchema("Person", "WORKS_AT", "Company", { temporal: true, cardinality: "one" });
    await b.schemas.createEdgeSchema("Person", "LIVES_IN", "Place", { temporal: true, cardinality: "one" });
    // An edge type's aliases: words a search reads as naming it.
    await b.schemas.createEdgeSchema("Person", "WORKS_AT", "Company", undefined, { aliases: ["job_at", "employed_by"] });
    const nodes: Array<[string, string, Record<string, unknown>]> = [
      ["me", "Person", { name: "Me", is_owner: true }],
      ["kate", "Person", { name: "Kate", alt_names: ["Katherine Moss"] }],
      ["jon", "Person", { name: "Jon" }],
      ["will", "Person", { name: "Will Grant" }],
      ["zed", "Person", { name: "Zed", description: "Plumber in Bath" }],
      ["acme", "Company", { name: "Acme" }],
      ["figma", "Company", { name: "Figma" }],
      ["lisbon", "Place", { name: "Lisbon" }],
      ["bath", "Place", { name: "Bath" }],
    ];
    for (const [k, type, data] of nodes) id[k] = (await b.nodes.write({ type, data })).ref_id;
    const fact = (s: string, edge: string, t: string, text: string) => assertEdge(b, b.schemas, { edge, source_ref_id: id[s]!, target_ref_id: id[t]!, text });
    await fact("me", "WORKS_AT", "acme", "The user works at Acme.");
    await fact("jon", "WORKS_AT", "acme", "Jon works at Acme as an engineer.");
    await fact("kate", "WORKS_AT", "figma", "Kate joined Figma as a design lead.");
    await fact("kate", "LIVES_IN", "bath", "Kate moved to Bath.");
    await fact("me", "LIVES_IN", "lisbon", "The user lives in Lisbon.");
  });
  after(async () => {
    await lb.close(b);
  });
  const titles = (out: any) => out.nodes.map((n: any) => n.name);
  /** The node titles a search without facts returns (a plain list). */
  const found = async (q: string) => ((await run({ q }, b)) as any[]).map((n) => n.name);
  const texts = (out: any) => out.facts.map((f: any) => f.text);

  it("a typo finds the word it misspells, through the entities' names", async () => {
    const out = await run({ q: "Lisbn", facts: true }, b);
    assert.equal(titles(out)[0], "Lisbon");
    assert.ok(texts(out).includes("The user lives in Lisbon."), "and the facts of the node it names");
  });

  it("alt_names are searched: Moss finds Kate", async () => {
    assert.equal((await found("Moss"))[0], "Kate");
  });

  it("every field's first word is searched (the index splits on spaces alone)", async () => {
    assert.equal((await found("plumber"))[0], "Zed");
  });

  it("a name the index drops as a stop word is still found: Will", async () => {
    assert.equal((await found("Will"))[0], "Will Grant");
  });

  it("a word naming the edge type, and I, put the user's fact first, above any node", async () => {
    const out = await run({ q: "where do I work", facts: true }, b);
    assert.equal(texts(out)[0], "The user works at Acme.");
    assert.ok(out.facts[0].score >= Math.max(0, ...out.nodes.map((n: any) => n.score)), "facts and nodes share a scale");
  });

  it("a fact that answers the question outranks its subject", async () => {
    const out = await run({ q: "where does Kate work", facts: true }, b);
    assert.equal(texts(out)[0], "Kate joined Figma as a design lead.");
    const kate = out.nodes.find((n: any) => n.name === "Kate");
    assert.ok(out.facts[0].score > kate.score);
  });

  it("an edge type's alias finds its facts, though no sentence says the word: my job", async () => {
    assert.deepEqual((await b.schemaSource.edgeAliases()).get("WORKS_AT"), ["job_at", "employed_by"]);
    const out = await run({ q: "what's my job", facts: true }, b);
    assert.equal(texts(out)[0], "The user works at Acme.");
    assert.equal(texts(await run({ q: "Kate's job", facts: true }, b))[0], "Kate joined Figma as a design lead.");
  });

  it("who works with me: the facts sharing the user's employer", async () => {
    const out = await run({ q: "who works with me", facts: true }, b);
    assert.equal(texts(out)[0], "Jon works at Acme as an engineer.");
  });

  it("a quoted query still requires its words", async () => {
    const out = await run({ q: '"Kate Figma"', facts: true }, b);
    assert.deepEqual(titles(out), []);
  });
});
