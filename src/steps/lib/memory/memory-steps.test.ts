import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryDb } from "./_db.js";
import { resolve } from "./_ontology.js";

// Against a real LadybugDB in a temp folder. @ladybugdb/core is an optional
// dependency with a native addon; where it does not load, the suite skips.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("memory/* steps", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-memory-"));
  const ctxWith = (services: unknown) =>
    ({ runId: "test", path: "test", scope: {}, input: undefined, emit: async () => {}, services }) as unknown as StepContext;
  const ctx = ctxWith({ secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "db", "graph.lbug") : undefined) } });
  let run: (type: string, input: unknown, c?: StepContext) => Promise<any>;
  let types: string[];

  before(async () => {
    const { registry } = await buildRegistry();
    types = Object.keys(registry).filter((t) => t.startsWith("memory/"));
    run = (type, input, c = ctx) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const me = { type: "Self", name: "Me" };
  const ids: Record<string, string> = {};

  it("registers the six steps, and not the shared modules", () => {
    assert.deepEqual(types.sort(), ["memory/forget", "memory/get", "memory/merge", "memory/ontology", "memory/recall", "memory/remember"]);
  });

  it("remember creates Self and the fact, resolving an alias predicate", async () => {
    const out = await run("memory/remember", {
      episode: "My name is Tom.",
      facts: [{ subject: me, predicate: "full_name", text: "The user's name is Tom." }],
    });
    assert.equal(out.entities.length, 1);
    assert.equal(out.entities[0].type, "Self");
    assert.equal(out.entities[0].status, "created");
    assert.equal(out.facts[0].status, "created");
    assert.equal(out.facts[0].predicate, "name");
    assert.deepEqual(out.ontology.resolved, ["full_name → name"]);
    ids.self = out.entities[0].ref_id;
    ids.tom = out.facts[0].ref_id;
    assert.equal((statSync(join(dir, "db")).mode & 0o777), 0o700, "memory folder is owner-only");
  });

  it("a one-value predicate supersedes the current fact", async () => {
    const out = await run("memory/remember", {
      episode: "Actually, call me Thomas.",
      facts: [{ subject: me, predicate: "name", text: "The user's name is Thomas." }],
    });
    assert.equal(out.entities[0].ref_id, ids.self, "the same Self");
    assert.equal(out.entities[0].status, "matched");
    assert.deepEqual(out.facts[0].superseded, [ids.tom]);
    ids.thomas = out.facts[0].ref_id;

    const self = await run("memory/get", { type: "Self" });
    assert.deepEqual(self.facts.map((f: any) => f.text), ["The user's name is Thomas."]);
    const old = await run("memory/get", { ref_id: ids.tom });
    assert.ok(old.expired_at);
    assert.deepEqual(old.superseded_by.map((f: any) => f.ref_id), [ids.thomas]);
  });

  it("recall finds the current fact, and the superseded one only when asked", async () => {
    const hits = await run("memory/recall", { q: "name", type: "Fact" });
    assert.deepEqual(hits.map((h: any) => h.ref_id), [ids.thomas]);
    assert.equal(hits[0].node_type, "Fact");
    const all = await run("memory/recall", { q: "name", type: "Fact", include_expired: true });
    assert.deepEqual(all.map((h: any) => h.ref_id).sort(), [ids.thomas, ids.tom].sort());
  });

  it("an unknown predicate is kept as proposed and listed by memory/ontology", async () => {
    const out = await run("memory/remember", {
      episode: "I play chess with Kate on Sundays.",
      facts: [{ subject: me, predicate: "plays chess with", object: { type: "Person", name: "Kate" }, text: "The user plays chess with Kate." }],
    });
    assert.deepEqual(out.ontology.proposed, ["predicate plays_chess_with"]);
    ids.kate = out.entities.find((e: any) => e.name === "Kate").ref_id;
    ids.chess = out.facts[0].ref_id;

    const ontology = await run("memory/ontology", {});
    const term = ontology.predicates.find((p: any) => p.name === "plays_chess_with");
    assert.equal(term.status, "proposed");
    assert.deepEqual(term.subject_types, ["Self"]);
    assert.deepEqual(term.object_types, ["Person"]);
    assert.equal(term.used, 1);
    assert.equal(ontology.predicates.find((p: any) => p.name === "name").cardinality, "one");
    const active = await run("memory/ontology", { include_proposed: false });
    assert.ok(!active.predicates.some((p: any) => p.name === "plays_chess_with"));
  });

  it("names with no letters or digits are refused, not stored empty", async () => {
    const out = await run("memory/remember", {
      episode: "noise",
      facts: [{ subject: me, predicate: "!!!", text: "Nothing." }, { subject: { type: "???", name: "X" }, predicate: "knows", text: "Nothing." }],
    });
    assert.match(out.error, /^invalid_input: .*type "\?\?\?".*predicate "!!!"/);
    await assert.rejects(async () => run("memory/remember", { episode: "x", mentions: [{ type: "", name: "X" }] }));
    await assert.rejects(async () => run("memory/remember", { episode: "x", facts: [{ subject: me, predicate: "", text: "x" }] }));
    await assert.rejects(resolve(await memoryDb(ctx), "predicate", "--", "test"), /invalid_input/);
    const ontology = await run("memory/ontology", {});
    assert.ok(![...ontology.entity_types, ...ontology.predicates].some((t: any) => !t.name));
    assert.equal((await run("memory/recall", { q: "noise" })).length, 0, "no episode was written");
  });

  it("one entity given by ref_id and by name is listed once", async () => {
    const out = await run("memory/remember", {
      episode: "Kate cooks.",
      mentions: [{ ref_id: ids.kate, type: "Person", name: "Kate" }],
      facts: [{ subject: { type: "Person", name: "kate" }, predicate: "prefers", text: "Kate likes cooking." }],
    });
    assert.deepEqual(out.entities.map((e: any) => e.ref_id), [ids.kate]);
    const kate = await run("memory/get", { ref_id: ids.kate });
    assert.equal(kate.mentioned_in_episodes, 2);
  });

  it("forget soft-deletes a fact, and refuses Self", async () => {
    const out = await run("memory/forget", { ref_id: ids.chess, reason: "the user asked" });
    assert.equal(out.forgotten.node_type, "Fact");
    assert.match((await run("memory/get", { ref_id: ids.chess })).error, /^not_found/);
    const kate = await run("memory/get", { ref_id: ids.kate });
    assert.deepEqual(kate.facts.map((f: any) => f.text), ["Kate likes cooking."]);
    assert.match((await run("memory/forget", { ref_id: ids.self, reason: "test" })).error, /^refused/);
  });

  it("merge repoints the duplicate's facts and leaves it as an alias", async () => {
    const dup = await run("memory/remember", {
      episode: "Katherine lives in Leeds.",
      facts: [{ subject: { type: "Person", name: "Katherine" }, predicate: "lives_in", object: { type: "Place", name: "Leeds" }, text: "Katherine lives in Leeds." }],
    });
    const katherine = dup.entities.find((e: any) => e.name === "Katherine");
    assert.notEqual(katherine.ref_id, ids.kate);
    await run("memory/remember", {
      episode: "Kate knows Katherine.",
      facts: [{ subject: { ref_id: ids.kate, type: "Person", name: "Kate" }, predicate: "knows", object: { ref_id: katherine.ref_id, type: "Person", name: "Katherine" }, text: "Kate knows Katherine." }],
    });

    const out = await run("memory/merge", { keep: ids.kate, duplicate: katherine.ref_id });
    assert.equal(out.moved.subject_of, 1);
    assert.ok(out.aliases.includes("katherine"));

    const via = await run("memory/get", { ref_id: katherine.ref_id });
    assert.equal(via.ref_id, ids.kate);
    assert.equal(via.merged_from, katherine.ref_id);
    assert.deepEqual(via.facts.map((f: any) => f.text).sort(), ["Kate knows Katherine.", "Kate likes cooking.", "Katherine lives in Leeds."]);
    const self = via.facts.find((f: any) => f.predicate === "knows");
    assert.equal(self.role, "subject", "a fact about Kate and herself is listed once, as its subject");
    const byName = await run("memory/get", { type: "Person", name: "Katherine" });
    assert.equal(byName.ref_id, ids.kate);
    ids.katherine = katherine.ref_id;
  });

  it("forget of a merged-away id forgets the entity it was merged into", async () => {
    const out = await run("memory/forget", { ref_id: ids.katherine, reason: "test" });
    assert.equal(out.forgotten.ref_id, ids.kate);
    assert.equal(out.merged_from, ids.katherine);
    assert.equal(out.with_facts, 3);
    assert.match((await run("memory/get", { ref_id: ids.kate })).error, /^not_found/);
  });

  it("without STRUT_MEMORY_DB the graph lives under dataDir/memory", async () => {
    const dataDir = join(dir, "data");
    await run("memory/remember", { episode: "hello", mentions: [me] }, ctxWith({ dataDir }));
    assert.equal(statSync(join(dataDir, "memory")).mode & 0o777, 0o700);
    assert.ok(statSync(join(dataDir, "memory", "graph.lbug")));
  });

  it("with neither STRUT_MEMORY_DB nor a dataDir the steps fail and say so", async () => {
    await assert.rejects(async () => run("memory/recall", { q: "x" }, ctxWith({})), /dataDir.*STRUT_MEMORY_DB/);
  });
});
