import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import type { LoadedFixer } from "../../../audio/fixer.js";
import type { LadybugBackend } from "../../../graph/backend.js";
import { testBackends } from "../../../graph/test-util.js";
import { importMishearings } from "./_graph.js";
import { memoryDb } from "../memory/_db.js";
import graphSearch from "../graph/graph-search.js";
import lexiconStep from "../memory/lexicon.js";
import add from "./add.js";
import applyChanges from "./apply-changes.js";
import changesSince from "./changes-since.js";
import correction from "./correction.js";
import enable from "./enable.js";
import remove from "./remove.js";
import undo from "./undo.js";

// Dictation's vocabulary on the workspace graph (`memory: "graph"`): the
// same steps, the same outputs, its words and mishearings on Ladybug.
const lb = testBackends().find((b) => b.kind === "ladybug")!;
const hasMemoryDb = await import("@ladybugdb/core").then(() => true, () => false);

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<any> };
const run = (step: Step, cfg: Record<string, unknown>, ctx: unknown): Promise<any> => step.run(step.input.parse(cfg), ctx);
const ctxOf = (services: object) =>
  ({ runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services }) as unknown as StepContext;

// Says yes to a written form with a capital or a digit, as dictation-correction.test.ts.
const fixer: LoadedFixer = {
  id: "fake", learnMargin: 0, ready: async () => {},
  judge: async (qs) => qs.map((q) => (/[\p{Lu}\p{N}]/u.test(q.to) ? 5 : -5)),
  named: async (qs) => qs.map(() => -5),
  everyday: async (ws) => ws.map(() => -5),
  score: async (ss) => ss.map((s) => (s.text.includes(s.name) ? 0 : -10)),
  retract: async () => [],
};
const stt = { fixer: { current: async () => fixer } };

const keys = (o: object) => Object.keys(o).sort();

describe("dictation on the graph (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend, b2: LadybugBackend;
  let ctx: StepContext, ctx2: StepContext;
  const lexicon = async (c = ctx) => (await run(lexiconStep, {}, c)) as { lingo_type: string; mishearing: string; person_type: string; entities: any[]; undone: any[] };
  const entry = async (name: string, c = ctx) => (await lexicon(c)).entities.find((e) => e.name === name);

  before(async () => {
    b = (await lb.open()) as LadybugBackend;
    b2 = (await lb.open()) as LadybugBackend;
    ctx = ctxOf({ graph: b, memory: "graph", stt });
    ctx2 = ctxOf({ graph: b2, memory: "graph", stt });
  });
  after(async () => {
    await lb.close(b);
    await lb.close(b2);
  });
  beforeEach(async () => {
    await lb.clear(b);
    await lb.clear(b2);
  });

  it("adds a word, learns a mishearing from a correction, and reads both as memory/lexicon", async () => {
    const added = await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
    assert.equal(added.undo.length, 1);
    const word = await entry("Stakwork");
    assert.equal(word.type, "Lingo");
    assert.equal(word.ref_id, added.undo[0], "a new word: undo takes the word");
    assert.deepEqual(word.heard.map((h: any) => [h.value, h.form]), [["stack work", null]]);
    assert.deepEqual(await run(add, { heard: "stack work", written: "Stakwork" }, ctx), { heard: "stack work", written: "Stakwork", undo: [] }, "known: nothing written");

    const out = await run(correction, { typed: "ping stack walk now", edited: "ping Stakwork now" }, ctx);
    assert.deepEqual(out.learned.map((l: any) => [l.heard, l.written]), [["stack walk", "Stakwork"]]);
    const after = await entry("Stakwork");
    assert.deepEqual(after.heard.map((h: any) => h.value), ["stack work", "stack walk"]);
    assert.equal(after.heard[1].ref_id, out.learned[0].undo[0], "on a known word: undo takes the mishearing");
    assert.equal(after.facts, 2);

    const lex = await lexicon();
    assert.equal(lex.lingo_type, "Lingo");
    assert.equal(lex.person_type, "Person");
    assert.equal(lex.mishearing, "Mishearing");
  });

  it("keeps a mishearing on a node the graph knows, with its other name as the form", async () => {
    const [kate, tom] = (await b.nodes.writeMany([
      { type: "Person", data: { name: "Kate Smith", alt_names: ["Kate"] } },
      { type: "Person", data: { name: "Tom", is_owner: true } },
    ])).map((r) => r.ref_id);
    const out = await run(add, { heard: "cate", written: "Kate" }, ctx);
    const e = await entry("Kate Smith");
    assert.equal(e.ref_id, kate);
    assert.deepEqual(e.written, ["Kate Smith", "Kate"]);
    assert.deepEqual(e.heard.map((h: any) => [h.value, h.form]), [["cate", "Kate"]]);
    assert.deepEqual(out.undo, [e.heard[0].ref_id]);
    assert.equal((await entry("Tom")).user, true);
    assert.equal(tom, (await entry("Tom")).ref_id);
    // A full name dictation learned is a new person.
    await run(add, { heard: "etoy", written: "Itoi", name: "Paul Itoi" }, ctx);
    const paul = await entry("Paul Itoi");
    assert.equal(paul.type, "Person");
    assert.deepEqual(paul.heard.map((h: any) => [h.value, h.form]), [["etoy", "Itoi"]]);
  });

  it("reads the same shape as the old memory's memory/lexicon", { skip: !hasMemoryDb && "@ladybugdb/core is not installed" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-dictation-legacy-"));
    try {
      const legacy = ctxOf({ secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "graph.lbug") : undefined) } });
      for (const c of [legacy, ctx]) {
        const out = await run(add, { heard: "stack work", written: "Stakwork" }, c);
        await run(undo, { undo: out.undo }, c);
        await run(add, { heard: "bit coin", written: "Bitcoin" }, c);
      }
      const [old, now] = [await lexicon(legacy), await lexicon()];
      assert.deepEqual(keys(now), keys(old));
      const [o, n] = [old.entities.find((e) => e.name === "Bitcoin"), now.entities.find((e) => e.name === "Bitcoin")];
      assert.deepEqual(keys(n), keys(o));
      assert.deepEqual(keys(n.heard[0]), keys(o.heard[0]));
      assert.deepEqual({ ...n, ref_id: 0, heard: n.heard.map((h: any) => ({ ...h, ref_id: 0, created_at: 0 })), updated_at: 0, type: 0 },
        { ...o, ref_id: 0, heard: o.heard.map((h: any) => ({ ...h, ref_id: 0, created_at: 0 })), updated_at: 0, type: 0 });
      assert.equal(now.undone.length, 1);
      assert.equal(old.undone.length, 1);
      assert.deepEqual(keys(now.undone[0]), keys(old.undone[0]));
      assert.deepEqual(keys(now.undone[0].entity), keys(old.undone[0].entity));
      assert.deepEqual([now.undone[0].value, now.undone[0].entity.name], [old.undone[0].value, old.undone[0].entity.name]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("undoes what dictation wrote, never learns it again, and refuses anything else", async () => {
    const kate = (await b.nodes.write({ type: "Person", data: { name: "Kate" } })).ref_id;
    const word = await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
    const pair = await run(add, { heard: "cate", written: "Kate" }, ctx);
    await assert.rejects(run(undo, { undo: [kate] }, ctx), /not written by dictation/);
    assert.deepEqual(await run(undo, { undo: [...word.undo, ...pair.undo] }, ctx), { undone: [...word.undo, ...pair.undo] });
    const lex = await lexicon();
    assert.equal(lex.entities.find((e) => e.name === "Stakwork"), undefined, "the new word went with its mishearing");
    assert.deepEqual(lex.entities.find((e) => e.name === "Kate").heard, [], "the person stays");
    assert.deepEqual(lex.undone.map((u) => [u.value, u.entity.name]).sort(), [["cate", "Kate"], ["stack work", "Stakwork"]]);
    const rows = await b.query("MATCH (n:Node) WHERE n.ref_id IN $ids RETURN n.deleted_reason AS r", { ids: word.undo });
    assert.deepEqual(rows.map((r) => r["r"]), ["undone"]);
    // An undone pair is not learned from an edit again.
    assert.deepEqual((await run(correction, { typed: "ping cate", edited: "ping Kate" }, ctx)).learned, []);
  });

  it("removes a mishearing, and a word with its last one", async () => {
    await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
    await run(add, { heard: "stack walk", written: "Stakwork" }, ctx);
    const kate = (await b.nodes.write({ type: "Person", data: { name: "Kate" } })).ref_id;
    await run(add, { heard: "cate", written: "Kate" }, ctx);
    let w = await entry("Stakwork");
    assert.deepEqual(await run(remove, { ref_id: w.heard[0].ref_id }, ctx), { forgotten: w.heard[0].ref_id });
    w = await entry("Stakwork");
    assert.deepEqual(w.heard.map((h: any) => h.value), ["stack walk"]);
    assert.deepEqual(await run(remove, { ref_id: w.heard[0].ref_id }, ctx), { forgotten: w.ref_id }, "the last one takes the word");
    assert.equal(await entry("Stakwork"), undefined);
    await assert.rejects(run(remove, { ref_id: kate }, ctx), /not a word of dictation's own/);
    const rows = await b.query("MATCH (n:Node {ref_id: $id}) RETURN n.deleted_reason AS r", { id: w.ref_id });
    assert.equal(rows[0]!["r"], "removed");
    assert.deepEqual((await lexicon()).undone, [], "a removal is no undo");
  });

  it("turns a node off for dictation and on again", async () => {
    const kate = (await b.nodes.write({ type: "Person", data: { name: "Kate" } })).ref_id;
    assert.deepEqual(await run(enable, { ref_id: kate, on: true }, ctx), { ref_id: kate, on: true });
    assert.deepEqual(await run(enable, { ref_id: kate, on: false }, ctx), { ref_id: kate, on: false });
    assert.equal((await entry("Kate")).dictation_off, true);
    await run(enable, { ref_id: kate, on: true }, ctx);
    assert.equal((await entry("Kate")).dictation_off, false);
  });

  it("replays its changes on another graph, idempotently", async () => {
    await b2.nodes.write({ type: "Person", data: { name: "Kate" } });
    await b.nodes.write({ type: "Person", data: { name: "Kate" } });
    const word = await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
    await run(add, { heard: "cate", written: "Kate" }, ctx);
    await run(add, { heard: "p eight", written: "P8", term: true }, ctx);
    await run(add, { heard: "bit coin", written: "Bitcoin" }, ctx);
    const bitcoin = await entry("Bitcoin");
    await run(undo, { undo: [bitcoin.ref_id] }, ctx);
    const first = await run(changesSince, {}, ctx);
    assert.deepEqual(first.changes.map((c: any) => [c.op, c.heard ?? null, c.written, c.term ?? false]), [
      ["learn", "stack work", "Stakwork", false],
      ["learn", "cate", "Kate", false],
      ["learn", null, "P8", true],
      ["learn", "bit coin", "Bitcoin", false],
      ["undo", "bit coin", "Bitcoin", false],
    ]);
    assert.equal(first.changes[3].undone, true);

    const applied = await run(applyChanges, { changes: first.changes }, ctx2);
    assert.deepEqual(applied.applied.map((a: any) => a.result), ["learned", "learned", "learned", "learned", "undone"]);
    const there = await lexicon(ctx2);
    assert.deepEqual(there.entities.find((e) => e.name === "Stakwork").heard.map((h: any) => h.value), ["stack work"]);
    assert.deepEqual(there.entities.find((e) => e.name === "Kate").heard.map((h: any) => h.value), ["cate"]);
    assert.ok(there.entities.find((e) => e.name === "P8"));
    assert.equal(there.entities.find((e) => e.name === "Bitcoin"), undefined);
    const again = await run(applyChanges, { changes: first.changes }, ctx2);
    assert.deepEqual(again.applied.map((a: any) => a.result), ["known", "known", "known", "already undone", "already undone"]);

    // From the last read's `until` on: only what came after.
    await run(undo, { undo: word.undo }, ctx);
    const next = await run(changesSince, { since: first.until }, ctx);
    assert.deepEqual(next.changes.map((c: any) => [c.op, c.heard, c.written]), [["undo", "stack work", "Stakwork"]]);
    assert.deepEqual((await run(applyChanges, { changes: next.changes }, ctx2)).applied.map((a: any) => a.result), ["undone"]);
    assert.equal((await lexicon(ctx2)).entities.find((e) => e.name === "Stakwork"), undefined);
  });

  it("keeps non-Latin words apart", async () => {
    for (const w of ["Zoë", "凯特", "東京"]) await run(add, { heard: `${w} heard`, written: w }, ctx);
    const lex = await lexicon();
    for (const w of ["Zoë", "凯特", "東京"]) {
      const e = lex.entities.find((x) => x.name === w);
      assert.ok(e, w);
      assert.deepEqual(e.heard.map((h: any) => h.value), [`${w} heard`]);
    }
    assert.equal(new Set(lex.entities.map((e) => e.ref_id)).size, lex.entities.length);
  });

  it("keeps mishearings out of graph search", async () => {
    await run(add, { heard: "stack work", written: "Stakwork" }, ctx);
    const out = await run(graphSearch, { query: "stack work" }, ctxOf({ graph: b }));
    assert.ok(!JSON.stringify(out).includes("Mishearing"), JSON.stringify(out).slice(0, 400));
  });

  it("imports the old memory's mishearings onto the nodes their subjects became", { skip: !hasMemoryDb && "@ladybugdb/core is not installed" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-dictation-import-"));
    try {
      const legacy = ctxOf({ secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "graph.lbug") : undefined) } });
      await run(add, { heard: "cate", written: "Kate" }, legacy);
      const kait = await run(add, { heard: "kait", written: "Kate" }, legacy);
      await run(undo, { undo: kait.undo }, legacy);
      await run(add, { heard: "nobody", written: "Gone" }, legacy);
      const old = await lexicon(legacy);
      const oldKate = old.entities.find((e) => e.name === "Kate").ref_id;
      const kate = (await b.nodes.write({ type: "Person", data: { name: "Kate" } })).ref_id;
      const nodeOf = new Map([[oldKate, kate]]);
      const oldQuery = await memoryDb(legacy);
      assert.deepEqual(await importMishearings(b, oldQuery, nodeOf), { imported: 2, already: 0, skipped: 1 });
      const lex = await lexicon();
      assert.deepEqual(lex.entities.find((e) => e.name === "Kate").heard.map((h: any) => h.value), ["cate"]);
      assert.deepEqual(lex.undone.map((u) => [u.value, u.entity.name]), [["kait", "Kate"]]);
      assert.deepEqual(await importMishearings(b, oldQuery, nodeOf), { imported: 0, already: 2, skipped: 1 }, "run again, nothing new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
