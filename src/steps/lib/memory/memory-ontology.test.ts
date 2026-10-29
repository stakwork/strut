import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryDb } from "./_db.js";
import { applyTerms, invalidate, seedMemoryOntology, vocabulary } from "./_ontology.js";
import { ENTITY_BASE, SEED, entityType, predicate } from "./_ontology-seed.js";
import { NO_LADYBUG, memoryWorkspace, type MemoryWorkspace } from "./_test-workspace.js";

const here = dirname(fileURLToPath(import.meta.url));

// Literals that are other words spelt like a term: remember's episode kind "event".
const NOT_TERMS = new Set(["event"]);

/** Seed term names in a string or regex literal, any case: whole, or quoted inside one (Cypher's 'Self'). */
function namedTerms(source: string, names: string[]): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) {
      const text = node.text;
      if (NOT_TERMS.has(text)) return;
      for (const n of names) {
        if (text.toLowerCase() === n.toLowerCase() || new RegExp(`['"\`/^]${n}['"\`/$]`, "i").test(text)) hits.push(`${n} in ${JSON.stringify(text.slice(0, 80))}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return hits;
}

describe("memory: behaviour comes from the ontology, not from names", () => {
  const names = SEED.map((t) => t.name);

  it("the detector catches a name, alone or quoted in Cypher, and not an example in prose", () => {
    assert.equal(namedTerms(`const a = "Self"; const b = \`WHERE e.type = 'Self' AND \${x}\`;`, names).length, 2);
    assert.equal(namedTerms(`const c = /^Self$/.test(t); const d = lower(x) === "self";`, names).length, 2);
    assert.deepEqual(namedTerms(`const d = "An entity type, e.g. Person.";`, names), []);
  });

  it("no step file names a seed type or predicate in a string literal", () => {
    const files = (readdirSync(here, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("_ontology-seed.ts") && !/(^|\/)_lang-/.test(f))
      // The one-off import of the old memory file: its tables' columns (name) and their old defaults.
      .filter((f) => f !== "_migrate.ts");
    assert.ok(files.includes("remember.ts") && files.includes("_db.ts"));
    const hits = files.flatMap((f) => namedTerms(readFileSync(join(here, f), "utf8"), names).map((h) => `${f}: ${h}`));
    assert.deepEqual(hits, []);
  });
});

// Against a real Ladybug workspace graph, as memory-steps.test.ts; skipped where it does not load.
const hasLadybug = !NO_LADYBUG;

/** A raw statement on the workspace's write queue, outside memory's writers (test seeding). */
const rawWrite = (ws: MemoryWorkspace, cypher: string, params: Record<string, unknown> = {}) => ws.graph.lbug.withWrite((tx) => tx.run(cypher, params));
/** Memory's Schema rows, named by type: the WHERE for a raw edit of them. */
const schemaOf = (types: string[]) => `n.node_type = 'Schema' AND n.managed_by = 'memory' AND n.type IN [${types.map((t) => `'${t}'`).join(", ")}]`;
/** Edits memory's Schema rows raw, then drops the vocabulary both caches hold. */
const editSchemas = async (ws: MemoryWorkspace, cypher: string) => {
  await rawWrite(ws, cypher);
  invalidate(await memoryDb(ws.ctx()));
  ws.graph.schemas.invalidate();
};
/** Runs the seed again, as a new seed version would: its stamp removed first. */
const reseed = async (ws: MemoryWorkspace) => {
  await rawWrite(ws, "MATCH (m:Migration) WHERE m.migration_id STARTS WITH 'memory_ontology_seed:' DELETE m");
  await seedMemoryOntology(ws.graph);
  invalidate(await memoryDb(ws.ctx()));
};

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("memory: ontology behaviour", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  let registry: Record<string, unknown>;
  const runIn = (c: () => StepContext) => (type: string, input: unknown) => {
    const def = registry[type] as StepDef;
    return def.run(def.input.parse(input), c());
  };
  before(async () => {
    ({ registry } = await buildRegistry());
  });

  describe("a vocabulary whose user type is Owner, with no Self anywhere", () => {
    let ws: MemoryWorkspace;
    let ctx: StepContext;
    const run = runIn(() => ctx);
    const owner = { type: "Owner", name: "Me" };
    const ids: Record<string, string> = {};

    before(async () => {
      ws = await memoryWorkspace("strut-memory-ontology-");
      ctx = ws.ctx();
      await memoryDb(ctx);
      // The seed's terms out, this vocabulary in (the base types stay).
      await rawWrite(ws, "MATCH (n:Node) WHERE n.node_type = 'Schema' AND n.managed_by = 'memory' AND n.kind IN ['entity_type', 'predicate'] DETACH DELETE n");
      await ws.graph.lbug.withWrite((tx) => applyTerms(ws.graph, tx, [
        entityType({ name: "Being", description: "Anyone.", aliases: [], naming: "person" }),
        entityType({ name: "Owner", description: "The one this memory belongs to.", aliases: ["me"], parent: "Being", role: "user" }),
        entityType({ name: "Spot", description: "Somewhere.", aliases: [] }),
        predicate({ name: "called", description: "A name.", cardinality: "one", subject_types: ["*"], aliases: [], role: "alias" }),
        predicate({ name: "home", description: "Where they live.", cardinality: "one", subject_types: ["Being"], object_types: ["Spot"], aliases: [] }),
      ]));
      invalidate(await memoryDb(ctx));
    });
    after(() => ws.close());

    it("memory/ontology names Owner as the user type and lists no Self", async () => {
      const out = await run("memory/ontology", {});
      assert.equal(out.user_type, "Owner");
      assert.ok(!out.entity_types.some((t: any) => t.name === "Self"));
      const o = out.entity_types.find((t: any) => t.name === "Owner");
      assert.equal(o.parent, "Being");
      assert.equal(o.role, "user");
      assert.equal(out.predicates.find((p: any) => p.name === "called").role, "alias");
    });

    it("the user type is one entity whatever name it is given", async () => {
      const first = await run("memory/remember", { episode: "I'm Tom.", facts: [{ subject: owner, predicate: "called", text: "The user is Tom." }] });
      assert.equal(first.entities[0].status, "created");
      const again = await run("memory/remember", { episode: "Tom here.", mentions: [{ type: "Owner", name: "Tom" }] });
      assert.equal(again.entities[0].ref_id, first.entities[0].ref_id);
      assert.equal(again.entities[0].status, "matched");
      ids.owner = first.entities[0].ref_id;
    });

    it("a fact fits a predicate that lists the user type's ancestor", async () => {
      const out = await run("memory/remember", {
        episode: "I live in Leeds.",
        facts: [{ subject: owner, predicate: "home", object: { type: "Spot", name: "Leeds" }, text: "The user lives in Leeds." }],
      });
      assert.equal(out.ontology, undefined, "no fit note, nothing proposed");
      const off = await run("memory/remember", {
        episode: "Leeds lives in Leeds.",
        facts: [{ subject: { type: "Spot", name: "Leeds" }, predicate: "home", object: { type: "Spot", name: "Leeds" }, text: "Leeds lives in Leeds." }],
      });
      assert.deepEqual(off.ontology.notes, ["home usually starts from Being, not Spot."]);
    });

    it("memory/get with user: true, or the user type alone, returns the user", async () => {
      const user = await run("memory/get", { user: true });
      assert.equal(user.ref_id, ids.owner);
      assert.equal(user.user, true, "the user's node says so");
      const me = await run("memory/get", { type: "Owner" });
      assert.equal(me.ref_id, ids.owner);
      assert.deepEqual(me.facts.map((f: any) => f.predicate).sort(), ["called", "home"]);
    });

    it("memory/get refuses user: true with a type or name", async () => {
      for (const extra of [{ type: "Being" }, { name: "Kate" }]) {
        assert.equal((await run("memory/get", { user: true, ...extra })).error, "invalid_input: pass user: true alone, or a type and name");
      }
    });

    it("forget and merge refuse the user", async () => {
      assert.match((await run("memory/forget", { ref_id: ids.owner, reason: "test" })).error, /^refused/);
      const other = await run("memory/remember", { episode: "Kate.", mentions: [{ type: "Being", name: "Kate" }] });
      assert.match((await run("memory/merge", { keep: other.entities[0].ref_id, duplicate: ids.owner })).error, /^refused/);
      const into = await run("memory/merge", { keep: ids.owner, duplicate: other.entities[0].ref_id });
      assert.equal(into.kept.ref_id, ids.owner, "merging another entity into the user is fine");
    });

    it("a subtype of the user type is not the user: role is not inherited", async () => {
      const query = await memoryDb(ctx);
      await run("memory/remember", { episode: "Alt.", mentions: [{ type: "Alter", name: "Al" }] });
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Alter"])} SET n.parent = 'Owner'`);
      assert.deepEqual((await vocabulary(query)).ancestors("Alter"), ["Owner", "Being"]);
      assert.equal((await vocabulary(query)).role("Alter"), "");
      const two = await run("memory/remember", { episode: "Bo.", mentions: [{ type: "Alter", name: "Bo" }] });
      assert.equal(two.entities[0].status, "created", "not matched as a singleton");
      assert.ok((await run("memory/forget", { ref_id: two.entities[0].ref_id, reason: "test" })).forgotten);
    });

    it("seeding never gives the user role to a second type, so the graph still opens", async () => {
      const query = await memoryDb(ctx);
      await reseed(ws);
      const vocab = await vocabulary(query);
      assert.ok(vocab.term("entity_type", "Self"), "the seed's Self is made");
      assert.equal(vocab.userType(), "Owner");
      assert.equal(vocab.role("Self"), "");
      assert.equal((await run("memory/ontology", {})).user_type, "Owner");
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Self"])} DETACH DELETE n`);
    });
  });

  describe("with the seed vocabulary", () => {
    let ws: MemoryWorkspace;
    let ctx: StepContext;
    const run = runIn(() => ctx);
    before(async () => {
      ws = await memoryWorkspace("strut-memory-ontology-");
      ctx = ws.ctx();
    });
    after(() => ws.close());

    it("a proposed type given parent Person is named like a person and fits people predicates", async () => {
      const query = await memoryDb(ctx);
      const out = await run("memory/remember", { episode: "Jon is a colleague.", mentions: [{ type: "Colleague", name: "Jon" }] });
      assert.deepEqual(out.ontology.proposed, ["type Colleague"]);
      let vocab = await vocabulary(query);
      assert.equal(vocab.naming("Colleague"), "plain");
      assert.equal(vocab.naming("Self"), "person");

      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Colleague"])} SET n.parent = 'Person'`);
      vocab = await vocabulary(query);
      assert.deepEqual(vocab.ancestors("Colleague"), ["Person"]);
      assert.equal(vocab.naming("Colleague"), "person");
      assert.equal(vocab.role("Colleague"), "");

      const fact = await run("memory/remember", {
        episode: "Jon lives in York.",
        facts: [{ subject: { type: "Colleague", name: "Jon" }, predicate: "lives_in", object: { type: "Place", name: "York" }, text: "Jon lives in York." }],
      });
      assert.equal(fact.ontology, undefined, "a subtype of Person fits lives_in");
    });

    it("an agent's proposed type leaves behaviour unset, so a later seed can fill it", async () => {
      // Organization taken out of the vocabulary, so an agent proposes it.
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Organization"])} DETACH DELETE n`);
      const out = await run("memory/remember", { episode: "Acme.", mentions: [{ type: "Organization", name: "Acme" }] });
      assert.deepEqual(out.ontology.proposed, ["type Organization"]);
      const [row] = await ws.graph.lbug.query(`MATCH (n:Node) WHERE ${schemaOf(["Organization"])} RETURN n.parent AS parent, n.naming AS naming, n.role AS role`);
      assert.deepEqual(row, { parent: ENTITY_BASE, naming: null, role: null });
      await reseed(ws);
      assert.equal((await vocabulary(await memoryDb(ctx))).naming("Organization"), "organisation");
    });

    it("a seed description left as an earlier seed wrote it is updated; an edited one is kept", async () => {
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Self"])} SET n.type_description = 'The user. There is one.'`);
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Task"])} SET n.type_description = 'Chores.'`);
      await reseed(ws);
      const rows = await ws.graph.lbug.query(`MATCH (n:Node) WHERE ${schemaOf(["Self", "Task"])} RETURN n.type AS name, n.type_description AS d ORDER BY n.type`);
      assert.match(rows[0]!.d, /^The user: the person this memory belongs to/);
      assert.equal(rows[1]!.d, "Chores.");
    });

    it("an unknown type gets the defaults, and a parent cycle ends", async () => {
      const query = await memoryDb(ctx);
      let vocab = await vocabulary(query);
      assert.deepEqual([vocab.naming("Nope"), vocab.role("Nope"), vocab.ancestors("Nope")], ["plain", "", []]);

      await run("memory/remember", { episode: "Pals.", mentions: [{ type: "Pal", name: "Al" }, { type: "Buddy", name: "Bo" }] });
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Pal"])} SET n.parent = 'Buddy'`);
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Buddy"])} SET n.parent = 'Pal'`);
      vocab = await vocabulary(query);
      assert.deepEqual(vocab.ancestors("Pal"), ["Buddy"]);
      assert.equal(vocab.naming("Pal"), "plain");
    });

    it("the backfill fills an unset property and keeps one someone set, even empty", async () => {
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Self"])} SET n.role = NULL, n.parent = NULL`);
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Person"])} SET n.naming = ''`);
      await editSchemas(ws, `MATCH (n:Node) WHERE ${schemaOf(["Organization"])} SET n.naming = 'plain'`);
      await reseed(ws);
      const rows = await ws.graph.lbug.query(
        `MATCH (n:Node) WHERE ${schemaOf(["Self", "Person", "Organization"])} RETURN n.type AS name, n.parent AS parent, n.naming AS naming, n.role AS role ORDER BY n.type`,
      );
      assert.deepEqual(rows, [
        { name: "Organization", parent: ENTITY_BASE, naming: "plain", role: null },
        { name: "Person", parent: ENTITY_BASE, naming: "", role: null },
        { name: "Self", parent: "Person", naming: "person", role: "user" },
      ]);
      const vocab = await vocabulary(await memoryDb(ctx));
      assert.equal(vocab.userType(), "Self");
      assert.deepEqual(vocab.ancestors("Self"), ["Person"]);
      assert.deepEqual(vocab.predicatesWithRole("alias"), ["name"]);
    });
  });
});
