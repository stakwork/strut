import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryDb } from "./_db.js";
import { invalidate, seed, vocabulary } from "./_ontology.js";
import { SEED, entityType, predicate } from "./_ontology-seed.js";

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
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("_ontology-seed.ts") && !/(^|\/)_lang-/.test(f));
    assert.ok(files.includes("remember.ts") && files.includes("_db.ts"));
    const hits = files.flatMap((f) => namedTerms(readFileSync(join(here, f), "utf8"), names).map((h) => `${f}: ${h}`));
    assert.deepEqual(hits, []);
  });
});

// Against a real LadybugDB, as memory-steps.test.ts; skipped where it does not load.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("memory: ontology behaviour", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-memory-ontology-"));
  const ctxFor = (file: string) =>
    ({
      runId: "test", path: "test", scope: {}, input: undefined, emit: async () => {},
      services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, file, "graph.lbug") : undefined) } },
    }) as unknown as StepContext;
  let registry: Record<string, unknown>;
  const runIn = (c: StepContext) => (type: string, input: unknown) => {
    const def = registry[type] as StepDef;
    return def.run(def.input.parse(input), c);
  };
  before(async () => {
    ({ registry } = await buildRegistry());
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  describe("a vocabulary whose user type is Owner, with no Self anywhere", () => {
    const ctx = ctxFor("owner");
    const run = runIn(ctx);
    const owner = { type: "Owner", name: "Me" };
    const ids: Record<string, string> = {};

    before(async () => {
      const query = await memoryDb(ctx);
      await query("MATCH (o:Ontology) DELETE o");
      await seed(query, [
        entityType({ name: "Being", description: "Anyone.", aliases: [], naming: "person" }),
        entityType({ name: "Owner", description: "The one this memory belongs to.", aliases: ["me"], parent: "Being", role: "user" }),
        entityType({ name: "Spot", description: "Somewhere.", aliases: [] }),
        predicate({ name: "called", description: "A name.", cardinality: "one", subject_types: ["*"], aliases: [], role: "alias" }),
        predicate({ name: "home", description: "Where they live.", cardinality: "one", subject_types: ["Being"], object_types: ["Spot"], aliases: [] }),
      ]);
    });

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
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Alter' SET o.parent = 'Owner'");
      invalidate(query);
      assert.equal((await vocabulary(query)).role("Alter"), "");
      const two = await run("memory/remember", { episode: "Bo.", mentions: [{ type: "Alter", name: "Bo" }] });
      assert.equal(two.entities[0].status, "created", "not matched as a singleton");
      assert.ok((await run("memory/forget", { ref_id: two.entities[0].ref_id, reason: "test" })).forgotten);
    });

    it("seeding never gives the user role to a second type, so the database still opens", async () => {
      const query = await memoryDb(ctx);
      await seed(query, SEED);
      await seed(query, [entityType({ name: "Twin", description: "Also the user.", aliases: [], role: "user" })]);
      const vocab = await vocabulary(query);
      assert.equal(vocab.userType(), "Owner");
      assert.equal(vocab.role("Self"), "");
      assert.equal(vocab.role("Twin"), "");
      assert.equal((await run("memory/ontology", {})).user_type, "Owner");
      await query("MATCH (o:Ontology) WHERE o.key IN ['entity_type:Twin', 'entity_type:Self'] DELETE o");
      invalidate(query);
    });
  });

  describe("with the seed vocabulary", () => {
    const ctx = ctxFor("seed");
    const run = runIn(ctx);

    it("a proposed type given parent Person is named like a person and fits people predicates", async () => {
      const query = await memoryDb(ctx);
      const out = await run("memory/remember", { episode: "Jon is a colleague.", mentions: [{ type: "Colleague", name: "Jon" }] });
      assert.deepEqual(out.ontology.proposed, ["type Colleague"]);
      let vocab = await vocabulary(query);
      assert.equal(vocab.naming("Colleague"), "plain");
      assert.equal(vocab.naming("Self"), "person");

      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Colleague' SET o.parent = 'Person'");
      invalidate(query);
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
      const query = await memoryDb(ctx);
      const out = await run("memory/remember", { episode: "Rex.", mentions: [{ type: "Pet", name: "Rex" }] });
      assert.deepEqual(out.ontology.proposed, ["type Pet"]);
      const [row] = await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Pet' RETURN o.parent AS parent, o.naming AS naming, o.role AS role");
      assert.deepEqual(row, { parent: null, naming: null, role: null });
      await seed(query, [...SEED, entityType({ name: "Pet", description: "An animal.", aliases: [], naming: "person" })]);
      assert.equal((await vocabulary(query)).naming("Pet"), "person");
    });

    it("a seed description left as an earlier seed wrote it is updated; an edited one is kept", async () => {
      const query = await memoryDb(ctx);
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Self' SET o.description = 'The user. There is one.'");
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Task' SET o.description = 'Chores.'");
      await seed(query, SEED);
      const rows = await query("MATCH (o:Ontology) WHERE o.key IN ['entity_type:Self', 'entity_type:Task'] RETURN o.name AS name, o.description AS d ORDER BY o.name");
      assert.match(rows[0]!.d, /^The user: the person this memory belongs to/);
      assert.equal(rows[1]!.d, "Chores.");
    });

    it("an unknown type gets the defaults, and a parent cycle ends", async () => {
      const query = await memoryDb(ctx);
      let vocab = await vocabulary(query);
      assert.deepEqual([vocab.naming("Nope"), vocab.role("Nope"), vocab.ancestors("Nope")], ["plain", "", []]);

      await run("memory/remember", { episode: "Pals.", mentions: [{ type: "Pal", name: "Al" }, { type: "Buddy", name: "Bo" }] });
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Pal' SET o.parent = 'Buddy'");
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Buddy' SET o.parent = 'Pal'");
      invalidate(query);
      vocab = await vocabulary(query);
      assert.deepEqual(vocab.ancestors("Pal"), ["Buddy"]);
      assert.equal(vocab.naming("Pal"), "plain");
    });

    it("the backfill fills an unset property and keeps one someone set, even empty", async () => {
      const query = await memoryDb(ctx);
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Self' SET o.role = NULL, o.parent = NULL");
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Person' SET o.naming = ''");
      await query("MATCH (o:Ontology) WHERE o.key = 'entity_type:Organization' SET o.naming = 'plain'");
      await seed(query, SEED);
      const rows = await query(
        "MATCH (o:Ontology) WHERE o.kind = 'entity_type' AND o.name IN ['Self', 'Person', 'Organization'] RETURN o.name AS name, o.parent AS parent, o.naming AS naming, o.role AS role ORDER BY o.name",
      );
      assert.deepEqual(rows, [
        { name: "Organization", parent: "", naming: "plain", role: "" },
        { name: "Person", parent: "", naming: "", role: "" },
        { name: "Self", parent: "Person", naming: "person", role: "user" },
      ]);
      const vocab = await vocabulary(query);
      assert.equal(vocab.userType(), "Self");
      assert.deepEqual(vocab.predicatesWithRole("alias"), ["name"]);
    });
  });
});
