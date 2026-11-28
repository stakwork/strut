import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { createStrut } from "../../../createStrut.js";
import { MemoryRunStore } from "../../../store.js";
import { WorkspaceManager } from "../../../workspace.js";
import type { SttService, TranscribeResult } from "../../../audio/stt.js";
import type { GraphBackend } from "../../../graph/backend.js";
import { createNodeSchema } from "../../../graph/schema-crud.js";
import { seedStrutDomain } from "../../../graph/schema-seed.js";
import { testBackends } from "../../../graph/test-util.js";
import find from "../graph/find.js";
import graphSearch from "../graph/graph-search.js";
import lexiconStep from "../memory/lexicon.js";
import add from "./add.js";
import applyChanges from "./apply-changes.js";
import changesSince from "./changes-since.js";
import correction from "./correction.js";
import enable from "./enable.js";
import remove from "./remove.js";
import undo from "./undo.js";

// Dictation's vocabulary, the same cases on both engines: a Ladybug file (a
// person's Mac) and Neo4j (a box), with no fixer, as a server runs. On a
// Ladybug file the words are the person's; on Neo4j the graph's own,
// shared. Ladybug-only behaviour (people dictation makes, merges, home sync)
// is in dictation-graph.test.ts and dictation-correction.test.ts.

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<any> };
const run = (step: Step, cfg: Record<string, unknown>, ctx: unknown): Promise<any> => step.run(step.input.parse(cfg), ctx);
const ctxOf = (services: object) =>
  ({ runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services }) as unknown as StepContext;

let heard = "";
const stt = {
  modelDir: "/nowhere", hotwords: {}, sessions: {}, fixer: { current: async () => null },
  available: async () => true, models: async () => [], ensureModel: async () => "/nowhere", correct: async () => {},
  openStream: async () => { throw new Error("unused"); },
  transcribe: async (): Promise<TranscribeResult> => ({ text: heard, segments: [{ text: heard, words: [] }], model: "fake", hotwords: null, durationMs: 1 }),
} as unknown as SttService;

for (const tb of testBackends()) {
  describe(`dictation's vocabulary (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    let ctx: StepContext;
    const lexicon = async () => (await run(lexiconStep, {}, ctx)) as { lingo_type: string; mishearing: string; person_type: string; entities: any[]; undone: any[] };
    const entry = async (name: string) => (await lexicon()).entities.find((e) => e.name === name);

    before(async () => {
      b = await tb.open();
      // A Ladybug file seeds the vocabulary at open; Neo4j at boot.
      if (b.kind === "neo4j") {
        await tb.wipe(b);
        await seedStrutDomain(b);
      }
      ctx = ctxOf({ graph: b, stt });
    });
    after(async () => {
      await tb.close(b);
    });
    beforeEach(async () => {
      await tb.clear(b);
    });

    it("adds a word and its mishearing, and reads them back as memory/lexicon", async () => {
      const added = await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
      assert.equal(added.undo.length, 1);
      const lex = await lexicon();
      assert.deepEqual(Object.keys(lex).sort(), ["entities", "lingo_type", "mishearing", "person_type", "undone"]);
      assert.deepEqual([lex.lingo_type, lex.person_type, lex.mishearing], ["Lingo", "Person", "Mishearing"]);
      assert.equal(lex.entities.length, 1);
      const word = lex.entities[0];
      assert.deepEqual(Object.keys(word).sort(), ["dictation_off", "facts", "heard", "known_by_user", "name", "ref_id", "type", "updated_at", "written"]);
      assert.deepEqual([word.type, word.name, word.written, word.dictation_off, word.facts, word.known_by_user], ["Lingo", "Stakwork", ["Stakwork"], false, 1, false]);
      assert.equal(word.ref_id, added.undo[0], "a new word: undo takes the word");
      assert.deepEqual(word.heard.map((h: any) => [h.value, h.form, typeof h.ref_id, /^\d{4}-/.test(h.created_at)]), [["stack work", null, "string", true]]);
      assert.deepEqual(lex.undone, []);

      assert.deepEqual(await run(add, { heard: "stack work", written: "Stakwork" }, ctx), { heard: "stack work", written: "Stakwork", undo: [] }, "known: nothing written");
      const second = await run(add, { heard: "stack walk", written: "Stakwork" }, ctx);
      const after = await entry("Stakwork");
      assert.deepEqual(after.heard.map((h: any) => h.value), ["stack work", "stack walk"]);
      assert.deepEqual(second.undo, [after.heard[1].ref_id], "on a known word: undo takes the mishearing");
    });

    it("keeps a mishearing on a word the graph knows, with its other name as the form", async () => {
      const ref = (await b.nodes.write({ type: "Lingo", data: { name: "Stakwork", alt_names: ["SW"] } })).ref_id;
      const out = await run(add, { heard: "ess double you", written: "SW" }, ctx);
      const e = await entry("Stakwork");
      assert.equal(e.ref_id, ref);
      assert.deepEqual(e.written, ["Stakwork", "SW"]);
      assert.deepEqual(e.heard.map((h: any) => [h.value, h.form]), [["ess double you", "SW"]]);
      assert.deepEqual(out.undo, [e.heard[0].ref_id]);
    });

    it("undoes what dictation wrote, never learns it again, and refuses anything else", async () => {
      const other = (await b.nodes.write({ type: "Lingo", data: { name: "Stadeum" } })).ref_id;
      const word = await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
      const pair = await run(add, { heard: "stadium", written: "Stadeum" }, ctx);
      await assert.rejects(run(undo, { undo: [other] }, ctx), /not written by dictation/);
      assert.deepEqual(await run(undo, { undo: [...word.undo, ...pair.undo] }, ctx), { undone: [...word.undo, ...pair.undo] });
      const lex = await lexicon();
      assert.equal(lex.entities.find((e) => e.name === "Stakwork"), undefined, "the new word went with its mishearing");
      assert.deepEqual(lex.entities.find((e) => e.name === "Stadeum").heard, [], "a word dictation did not make stays");
      assert.deepEqual(lex.undone.map((u) => [u.value, u.entity.name]).sort(), [["stack work", "Stakwork"], ["stadium", "Stadeum"]]);
    });

    it("removes a mishearing, a word with its last one, and nothing dictation did not make", async () => {
      await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
      await run(add, { heard: "stack walk", written: "Stakwork" }, ctx);
      let w = await entry("Stakwork");
      assert.deepEqual(await run(remove, { ref_id: w.heard[0].ref_id }, ctx), { forgotten: w.heard[0].ref_id });
      w = await entry("Stakwork");
      assert.deepEqual(w.heard.map((h: any) => h.value), ["stack walk"]);
      assert.deepEqual(await run(remove, { ref_id: w.heard[0].ref_id }, ctx), { forgotten: w.ref_id }, "the last one takes the word");
      assert.equal(await entry("Stakwork"), undefined);
      assert.deepEqual((await lexicon()).undone, [], "a removal is no undo");
      await assert.rejects(run(remove, { ref_id: "no-such-ref" }, ctx), /no word or mishearing/);
    });

    it("turns a word off for dictation and on again", async () => {
      const ref = (await b.nodes.write({ type: "Lingo", data: { name: "Stakwork" } })).ref_id;
      assert.deepEqual(await run(enable, { ref_id: ref, on: false }, ctx), { ref_id: ref, on: false });
      assert.equal((await entry("Stakwork")).dictation_off, true);
      await run(enable, { ref_id: ref, on: true }, ctx);
      assert.equal((await entry("Stakwork")).dictation_off, false);
      await assert.rejects(run(enable, { ref_id: "no-such-ref", on: false }, ctx), /no node/);
    });

    it("with no fixer, a correction learns nothing", async () => {
      assert.deepEqual(await run(correction, { typed: "ping stack work now", edited: "ping Stakwork now" }, ctx), { learned: [] });
      assert.deepEqual((await lexicon()).entities, []);
    });

    it("a fix inside a full name nothing here writes: a new person on a Ladybug file, refused on a shared graph", async () => {
      const name = { heard: "etoy", written: "Itoi", name: "Paul Itoi" };
      if (b.kind === "ladybug") {
        await run(add, name, ctx);
        assert.equal((await entry("Paul Itoi")).type, "Person");
        return;
      }
      await assert.rejects(run(add, name, ctx), /dictation makes no person/);
      await run(add, { heard: "paul itoi", written: "Paul Itoi", term: true }, ctx);
      await run(add, name, ctx);
      const e = await entry("Paul Itoi");
      assert.equal(e.type, "Lingo");
      assert.deepEqual(e.heard.map((h: any) => [h.value, h.form]), [["etoy", "Itoi"]]);
    });

    it("reads its changes, and replays them idempotently", async () => {
      await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
      await run(add, { heard: "p eight", written: "P8", term: true }, ctx);
      const bitcoin = await run(add, { heard: "bit coin", written: "Bitcoin" }, ctx);
      await run(undo, { undo: bitcoin.undo }, ctx);
      const first = await run(changesSince, {}, ctx);
      assert.deepEqual(first.changes.map((c: any) => [c.op, c.heard ?? null, c.written, c.term ?? false, c.undone ?? false]), [
        ["learn", "stack work", "Stakwork", false, false],
        ["learn", null, "P8", true, false],
        ["learn", "bit coin", "Bitcoin", false, true],
        ["undo", "bit coin", "Bitcoin", false, false],
      ]);
      // On a graph that has none of it, the same changes put it back.
      await tb.clear(b);
      assert.deepEqual((await run(applyChanges, { changes: first.changes }, ctx)).applied.map((a: any) => a.result), ["learned", "learned", "learned", "undone"]);
      const lex = await lexicon();
      assert.deepEqual(lex.entities.map((e) => [e.name, e.heard.map((h: any) => h.value)]).sort(), [["P8", []], ["Stakwork", ["stack work"]]]);
      assert.deepEqual((await run(applyChanges, { changes: first.changes }, ctx)).applied.map((a: any) => a.result), ["known", "known", "already undone", "already undone"]);
      const next = await run(changesSince, { since: first.until }, ctx);
      assert.ok(next.changes.every((c: any) => Date.parse(c.at) >= Date.parse(first.until)));
    });

    it("keeps mishearings out of graph search and graph/find, and finds the word", async () => {
      await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
      const search = (q: string) => run(graphSearch, { q }, ctxOf({ graph: b })) as Promise<Array<{ node_type: string; name?: string }>>;
      const heard = await search("stack work");
      assert.ok(Array.isArray(heard), JSON.stringify(heard).slice(0, 400));
      assert.ok(!heard.some((n) => n.node_type === "Mishearing"), JSON.stringify(heard).slice(0, 400));
      assert.deepEqual((await search("Stakwork")).map((n) => n.node_type), ["Lingo"]);
      assert.match(JSON.stringify(await run(find, { node_type: "Mishearing" }, ctxOf({ graph: b }))), /unknown node type/);
    });

    describe("POST /audio/transcribe, with no fixer", () => {
      const dir = mkdtempSync(join(tmpdir(), "strut-vocabulary-"));
      let strut: Awaited<ReturnType<typeof createStrut>>;
      before(async () => {
        strut = await createStrut({
          workspace: new WorkspaceManager(join(dir, "ws")), graph: b, store: new MemoryRunStore(), dataDir: join(dir, "data"), stt,
          serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, browserWorkflows: false,
        });
      });
      after(async () => {
        await strut.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const transcribe = async (text: string, query = "") => {
        heard = text;
        const res = await strut.app.request(`/audio/transcribe${query}`, { method: "POST", body: new Uint8Array(64) });
        assert.equal(res.status, 200);
        return (await res.json()) as TranscribeResult & { heard?: string; changes?: { heard: string; written: string }[]; fixer: string | null };
      };

      it("puts right an exact learned mishearing of two words or more, and nothing else", async () => {
        await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
        await run(add, { heard: "stadium", written: "Stadeum" }, ctx);
        const out = await transcribe("ping stack work at the stadium");
        assert.deepEqual([out.text, out.heard, out.fixer], ["ping Stakwork at the stadium", "ping stack work at the stadium", null]);
        assert.deepEqual(out.changes?.map((c) => [c.heard, c.written]), [["stack work", "Stakwork"]]);
        assert.equal((await transcribe("ping stack work", "?lingo=0")).text, "ping stack work");
      });
    });
  });
}

// A Neo4j graph that already holds another `Lingo` (an app's own, keyed by
// its name and requiring what the app saves): replaced by dictation's when
// nothing of it is there, else left as it is, and dictation writes nothing.
const neo = testBackends().find((t) => t.kind === "neo4j")!;
describe("dictation's vocabulary beside another Lingo (neo4j)", { skip: neo.skip }, () => {
  let b: GraphBackend;
  before(async () => {
    b = await neo.open();
  });
  beforeEach(async () => {
    await neo.wipe(b);
    // A graph seeded before the vocabulary was, where an app declared its own Lingo.
    await seedStrutDomain(b);
    await b.tx((tx) => tx.run("MATCH (s:Schema {type: 'Lingo'}) DETACH DELETE s"));
    b.schemas.invalidate();
  });
  after(async () => {
    await neo.wipe(b);
    await neo.close(b);
  });
  const appLingo = {
    type: "Lingo",
    attributes: { name: "string", heard: "string", corrected: "string", call: "?string", line: "?float" },
    key_spec: "name",
    index: ["name", "heard", "corrected"],
  };
  const ctx = () => ctxOf({ graph: b });

  it("replaces one with nothing of it by dictation's, which then takes words", async () => {
    await createNodeSchema(b, b.schemas, appLingo);
    const seed = await seedStrutDomain(b);
    assert.match(seed.replaced["Lingo"] ?? "", /keyed by lingo-name, not ref_id/);
    assert.deepEqual(seed.foreign, {});
    b.schemas.invalidate();
    const now = await b.schemas.schema("Lingo");
    assert.equal(now?.key_spec, "ref_id");
    assert.equal(now?.attributes["heard"], undefined, "none of the app's attributes are left");
    assert.equal(now?.role, "entity");
    await run(add, { heard: "stack work", written: "Stakwork" }, ctx());
    assert.deepEqual((await run(lexiconStep, {}, ctx())).entities.map((e: any) => e.name), ["Stakwork"]);
    const again = await seedStrutDomain(b);
    assert.deepEqual([again.replaced, again.foreign, again.createdSchemas], [{}, {}, []], "a second boot changes nothing");
  });

  it("leaves one another type's edge rule names as it is (jarvis's Lingo is the end of DefinedTerm's)", async () => {
    await createNodeSchema(b, b.schemas, appLingo);
    await createNodeSchema(b, b.schemas, { type: "DefinedTerm", attributes: { name: "string" } });
    await b.schemas.createEdgeSchema("DefinedTerm", "RELATED_TO", "Lingo");
    const seed = await seedStrutDomain(b);
    assert.match(seed.foreign["Lingo"] ?? "", /keyed by lingo-name, not ref_id/);
    assert.deepEqual(seed.replaced, {});
    assert.ok(await b.schemas.edgeSchema("RELATED_TO", "DefinedTerm", "Lingo"), "its rule stays");
  });

  it("on a graph jarvis shares, leaves one with nothing of it as it is too: jarvis's own Lingo is jarvis's", async () => {
    await createNodeSchema(b, b.schemas, appLingo);
    await b.query("CREATE (:About {hidden_domains: []})");
    b.schemas.invalidate();
    const seed = await seedStrutDomain(b);
    assert.match(seed.foreign["Lingo"] ?? "", /keyed by lingo-name, not ref_id/);
    assert.deepEqual(seed.replaced, {});
    await assert.rejects(run(add, { heard: "stack work", written: "Stakwork" }, ctx()), /Lingo is not dictation's/);
  });

  it("leaves one with a node of it, even a deleted one, as it is, and refuses to write a word into it", async () => {
    await createNodeSchema(b, b.schemas, appLingo);
    const ref = (await b.nodes.write({ type: "Lingo", data: { name: "Stakwork", heard: "stack work", corrected: "Stakwork" } })).ref_id;
    await b.nodes.deleteNode(ref);
    const held = await b.schemas.schema("Lingo");

    const seed = await seedStrutDomain(b);
    assert.match(seed.foreign["Lingo"] ?? "", /keyed by lingo-name, not ref_id/);
    assert.deepEqual(seed.replaced, {});
    assert.equal(seed.reconciled["Lingo"], undefined, "nothing added to it");
    b.schemas.invalidate();
    assert.deepEqual(await b.schemas.schema("Lingo"), held);

    await assert.rejects(run(add, { heard: "stack work", written: "Stakwork" }, ctx()), /Lingo is not dictation's \(keyed by lingo-name, not ref_id\)/);
    assert.deepEqual((await run(lexiconStep, {}, ctx())).entities, [], "it reads, empty");
    assert.deepEqual((await b.query("MATCH (n:Data_Bank) RETURN n.ref_id AS r")).map((r) => r["r"]), [ref], "nothing written");
  });

  it("extends one that is dictation's, add-only", async () => {
    await createNodeSchema(b, b.schemas, { type: "Lingo", attributes: { name: "string" }, key: "ref_id", role: "entity" });
    const seed = await seedStrutDomain(b);
    assert.deepEqual([seed.foreign, seed.replaced], [{}, {}]);
    assert.deepEqual(seed.reconciled["Lingo"], ["alt_names", "description"]);
    await run(add, { heard: "stack work", written: "Stakwork" }, ctx());
    assert.deepEqual((await run(lexiconStep, {}, ctx())).entities.map((e: any) => e.name), ["Stakwork"]);
  });
});
