import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../../../createStrut.js";
import { MemoryRunStore } from "../../../store.js";
import { WorkspaceManager } from "../../../workspace.js";
import type { SttService, TranscribeResult } from "../../../audio/stt.js";
import type { StepContext } from "../../../core.js";
import { memoryDb, memoryWrite } from "../memory/_db.js";
import { invalidate, seed } from "../memory/_ontology.js";
import { SEED } from "../memory/_ontology-seed.js";

// Dictation's vocabulary end to end, through strut's own doors: what an edit
// teaches (POST /steps/dictation/correction/run) and the next transcription
// putting it right (POST /audio/transcribe), on a real LadybugDB.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

describe("dictation: correction and transcription", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-dictation-"));
  const dataDir = join(dir, "data");
  let heard = "";
  const stt = {
    modelDir: "/nowhere", hotwords: {}, sessions: {},
    available: async () => true, models: async () => [], ensureModel: async () => "/nowhere", correct: async () => {},
    openStream: async () => { throw new Error("unused"); },
    transcribe: async (): Promise<TranscribeResult> => ({ text: heard, segments: [{ text: heard, words: [] }], model: "fake", hotwords: null, durationMs: 1 }),
  } as unknown as SttService;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const ctx = { services: { dataDir } } as unknown as StepContext;

  before(async () => {
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")), store: new MemoryRunStore(), dataDir, stt,
      serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, browserWorkflows: false,
    });
  });
  after(async () => {
    await strut.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const step = async (type: string, input: unknown) => {
    const res = await strut.app.request(`/steps/${type}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: input }) });
    const body = (await res.json()) as { status: string; output?: any; error?: string };
    assert.equal(body.status, "success", JSON.stringify(body.error ?? body).slice(0, 600));
    return body.output;
  };
  const correct = (typed: string, edited: string, extra: object = {}) =>
    step("dictation/correction", { typed, edited, ...extra }) as Promise<{ learned: { heard: string; written: string; undo: string[] }[] }>;
  const transcribe = async (text: string, query = "") => {
    heard = text;
    const res = await strut.app.request(`/audio/transcribe${query}`, { method: "POST", body: new Uint8Array(64) });
    assert.equal(res.status, 200);
    return (await res.json()) as TranscribeResult & { heard?: string; changes?: { heard: string; written: string }[] };
  };
  const rows = async (cypher: string) => (await memoryDb(ctx))(cypher);

  it("with nothing taught, a transcript goes out as heard, as before", async () => {
    const out = await transcribe("send p eight now");
    assert.deepEqual(out, { text: "send p eight now", segments: [{ text: "send p eight now", words: [] }], model: "fake", hotwords: null, durationMs: 1 });
  });

  it("dry_run says what an edit would teach and writes nothing", async () => {
    assert.deepEqual(await correct("send p eight now", "send P8 now", { dry_run: true }), { learned: [{ heard: "p eight", written: "P8", undo: [] }] });
    assert.deepEqual(await rows("MATCH (e:Entity) RETURN e.name AS name"), []);
  });

  it("learns a new word as a Lingo, storing only the pair", async () => {
    const out = await correct("I need to send p eight now, before the meeting.", "I need to send P8 now, before the meeting.");
    assert.equal(out.learned.length, 1);
    assert.deepEqual({ ...out.learned[0], undo: undefined }, { heard: "p eight", written: "P8", undo: undefined });
    const [entity] = await rows("MATCH (e:Entity) RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name");
    assert.deepEqual(out.learned[0]!.undo, [entity!.ref_id]);
    assert.deepEqual([entity!.type, entity!.name], ["Lingo", "P8"]);
    const episodes = await rows("MATCH (e:Episode) RETURN e.content AS content, e.kind AS kind, e.created_by AS by");
    assert.deepEqual(episodes, [{ content: "Dictation: corrected “p eight” to “P8”.", kind: "note", by: "dictation" }]);
    const texts = (await rows("MATCH (f:Fact) RETURN f.text AS text, f.value AS value, f.form AS form"));
    assert.deepEqual(texts, [{ text: "Dictation hears P8 as “p eight”.", value: "p eight", form: null }]);
    for (const r of [...episodes, ...texts]) assert.ok(!JSON.stringify(r).includes("meeting"), "the sentence is never stored");
  });

  it("the next transcription puts it right and says what it changed", async () => {
    const out = await transcribe("send p eight now");
    assert.equal(out.text, "send P8 now");
    assert.equal(out.heard, "send p eight now");
    assert.deepEqual(out.changes, [{ heard: "p eight", written: "P8" }]);
    assert.equal(out.segments[0]!.text, "send p eight now");
    assert.equal(out.model, "fake");
    // lingo=0: as heard.
    const raw = await transcribe("send p eight now", "?lingo=0");
    assert.equal(raw.text, "send p eight now");
    assert.equal("heard" in raw || "changes" in raw, false);
  });

  it("learns on the entity that writes the word, with the alias as its form", async () => {
    await step("memory/remember", {
      episode: "Bitcoin, BTC for short.",
      facts: [{ subject: { type: "Lingo", name: "Bitcoin" }, predicate: "name", text: "Bitcoin is also called BTC.", object: { type: "Lingo", name: "BTC" } }],
    });
    const out = await correct("send it in bee tee see", "send it in BTC");
    const [fact] = await rows("MATCH (f:Fact)-[:SUBJECT]->(e:Entity) WHERE f.value = 'bee tee see' RETURN f.ref_id AS ref_id, f.form AS form, e.name AS name");
    assert.deepEqual(out.learned, [{ heard: "bee tee see", written: "BTC", undo: [fact!.ref_id] }]);
    assert.deepEqual([fact!.form, fact!.name], ["BTC", "Bitcoin"]);
    assert.equal((await transcribe("send it in bee tee see")).text, "send it in BTC");
  });

  it("a pair memory already has is reported with nothing to undo", async () => {
    assert.deepEqual(await correct("send it in bee tee see", "send it in BTC"), { learned: [{ heard: "bee tee see", written: "BTC", undo: [] }] });
  });

  it("an undone pair is never learned again", async () => {
    const out = await correct("ask the k p i team", "ask the KPI team");
    assert.equal(out.learned.length, 1);
    assert.deepEqual(await step("dictation/undo", { undo: out.learned[0]!.undo }), { undone: out.learned[0]!.undo });
    assert.deepEqual(await correct("ask the k p i team", "ask the KPI team"), { learned: [] });
  });

  it("a word turned off for dictation is never learned, nor rewritten", async () => {
    const lexicon = await step("memory/lexicon", {});
    const p8 = lexicon.entities.find((e: any) => e.name === "P8");
    await step("memory/attributes", { ref_id: p8.ref_id, set: { dictation: "off" } });
    assert.deepEqual(await correct("send p eight now", "send P8 now"), { learned: [] });
    assert.equal((await transcribe("send p eight now")).text, "send p eight now");
  });

  it("an everyday swap or a rewrite teaches nothing", async () => {
    assert.deepEqual(await correct("their team is here", "there team is here"), { learned: [] });
    assert.deepEqual(await correct("ask the stack work team", "Let's talk tomorrow instead"), { learned: [] });
  });

  it("dictation/add adds a word by hand, and says when it would never apply", async () => {
    const lsat = await step("dictation/add", { written: "LSAT", heard: "el sat" });
    assert.deepEqual([lsat.heard, lsat.written, lsat.applies, lsat.undo.length], ["el sat", "LSAT", true, 1]);
    assert.equal((await transcribe("el sat is on")).text, "LSAT is on");
    const fix = await step("dictation/add", { written: "Sphinx", heard: "fix" });
    assert.equal(fix.applies, false);
    assert.equal((await transcribe("we fix it")).text, "we fix it");
  });

  it("dictation/remove takes a mishearing, a word of dictation's own with its last one, and never another entity", async () => {
    const lexicon = async () => (await step("memory/lexicon", {})).entities as any[];
    const lsat = (await lexicon()).find((e) => e.name === "LSAT");
    // LSAT's only mishearing: the word goes with it.
    assert.deepEqual(await step("dictation/remove", { ref_id: lsat.heard[0].ref_id }), { forgotten: lsat.ref_id });
    assert.equal((await lexicon()).some((e) => e.name === "LSAT"), false);
    assert.equal((await transcribe("el sat is on")).text, "el sat is on");
    // A company keeps itself; only its mishearing goes.
    await step("memory/remember", { episode: "Acme is a client.", mentions: [{ type: "Organization", name: "Acme" }] });
    const added = await step("dictation/add", { written: "Acme", heard: "ack me" });
    const acme = (await lexicon()).find((e) => e.name === "Acme");
    assert.deepEqual(added.undo, [acme.heard[0].ref_id]);
    assert.deepEqual(await step("dictation/remove", { ref_id: acme.heard[0].ref_id }), { forgotten: acme.heard[0].ref_id });
    assert.deepEqual((await lexicon()).find((e) => e.name === "Acme").heard, []);
    const res = await strut.app.request("/steps/dictation/remove/run", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { ref_id: acme.ref_id } }),
    });
    assert.equal(((await res.json()) as { status: string }).status, "error");
    assert.ok((await lexicon()).some((e) => e.name === "Acme"));
  });

  it("dictation/remove keeps a word that is known for more than its mishearing", async () => {
    await step("memory/remember", {
      episode: "Hive is our product.", facts: [{ subject: { type: "Lingo", name: "Hive" }, predicate: "about", text: "Hive is about agents.", object: { type: "Topic", name: "agents" } }],
    });
    await step("dictation/add", { written: "Hive", heard: "hi of" });
    const hive = (await step("memory/lexicon", {})).entities.find((e: any) => e.name === "Hive");
    assert.deepEqual(await step("dictation/remove", { ref_id: hive.heard[0].ref_id }), { forgotten: hive.heard[0].ref_id });
    assert.ok((await step("memory/lexicon", {})).entities.some((e: any) => e.name === "Hive"));
  });

  it("dictation/undo refuses what dictation did not write, and forgets nothing", async () => {
    const acme = (await step("memory/lexicon", {})).entities.find((e: any) => e.name === "Acme");
    const res = await strut.app.request("/steps/dictation/undo/run", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { undo: [acme.ref_id] } }),
    });
    assert.equal(((await res.json()) as { status: string }).status, "error");
    assert.ok((await step("memory/lexicon", {})).entities.some((e: any) => e.name === "Acme"));
  });

  it("memory/lexicon names the lingo type and the mishearing predicate", async () => {
    const lexicon = await step("memory/lexicon", {});
    assert.deepEqual([lexicon.lingo_type, lexicon.mishearing], ["Lingo", "heard_as"]);
  });

  it("a memory seeded before Lingo had its role gets it on the next open", async () => {
    await memoryWrite(ctx, async (q) => {
      await q("MATCH (o:Ontology) WHERE o.key = 'entity_type:Lingo' SET o.role = ''");
      invalidate(q);
    });
    assert.equal((await step("memory/lexicon", {})).lingo_type, null);
    await memoryWrite(ctx, (q) => seed(q, SEED));
    assert.equal((await step("memory/lexicon", {})).lingo_type, "Lingo");
  });
});
