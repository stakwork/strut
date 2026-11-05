import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../../../createStrut.js";
import { MemoryRunStore } from "../../../store.js";
import { WorkspaceManager } from "../../../workspace.js";
import type { SttService, TranscribeResult } from "../../../audio/stt.js";
import type { LoadedFixer } from "../../../audio/fixer.js";
import type { LadybugBackend } from "../../../graph/backend.js";
import { testBackends } from "../../../graph/test-util.js";
import { createNodeSchema } from "../../../graph/schema-crud.js";
import { PENDING_DAYS, pendingFile, recordPending } from "./_pending.js";

// Dictation's vocabulary end to end, through strut's own doors: what an edit
// teaches (POST /steps/dictation/correction/run) and the next transcription
// putting it right (POST /audio/transcribe), on a Ladybug workspace graph,
// with a fake fixer: it says yes to a written form with a capital or a
// digit, and finds a sentence likelier with the vocabulary word in it.
const lb = testBackends().find((b) => b.kind === "ladybug")!;

describe("dictation: correction and transcription (ladybug)", { skip: lb.skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-dictation-"));
  const dataDir = join(dir, "data");
  let heard = "";
  const judged: string[] = [];
  const fake: LoadedFixer = {
    id: "fake", learnMargin: 0, ready: async () => {},
    judge: async (qs) => qs.map((q) => (judged.push(`${q.from}→${q.to}`), /[\p{Lu}\p{N}]/u.test(q.to) ? 5 : -5)),
    named: async (qs) => qs.map(() => -5),
    everyday: async (ws) => ws.map(() => -5),
    score: async (ss) => ss.map((s) => (s.text.includes(s.name) ? 0 : -10)),
    retract: async () => [],
  };
  let fixer: LoadedFixer | null = fake;
  const stt = {
    modelDir: "/nowhere", hotwords: {}, sessions: {}, fixer: { current: async () => fixer },
    available: async () => true, models: async () => [], ensureModel: async () => "/nowhere", correct: async () => {},
    openStream: async () => { throw new Error("unused"); },
    transcribe: async (): Promise<TranscribeResult> => ({ text: heard, segments: [{ text: heard, words: [] }], model: "fake", hotwords: null, durationMs: 1 }),
  } as unknown as SttService;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let graph: LadybugBackend;

  before(async () => {
    graph = (await lb.open()) as LadybugBackend;
    // Types the memory ontology would bring: a company, and what a fact is about.
    for (const type of ["Organization", "Topic"]) await createNodeSchema(graph, graph.schemas, { type, attributes: { name: "string" }, role: "entity" });
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")), graph, store: new MemoryRunStore(), dataDir, stt,
      serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, browserWorkflows: false,
    });
  });
  after(async () => {
    await strut.close();
    await lb.close(graph);
    rmSync(dir, { recursive: true, force: true });
  });

  const step = async (type: string, input: unknown) => {
    const res = await strut.app.request(`/steps/${type}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: input }) });
    const body = (await res.json()) as { status: string; output?: any; error?: string };
    assert.equal(body.status, "success", JSON.stringify(body.error ?? body).slice(0, 600));
    return body.output;
  };
  const correct = (typed: string, edited: string) =>
    step("dictation/correction", { typed, edited }) as Promise<{ learned: { heard: string; written: string; undo: string[] }[] }>;
  const transcribe = async (text: string, query = "") => {
    heard = text;
    const res = await strut.app.request(`/audio/transcribe${query}`, { method: "POST", body: new Uint8Array(64) });
    assert.equal(res.status, 200);
    return (await res.json()) as TranscribeResult & { heard?: string; changes?: { heard: string; written: string; at: number }[]; fixer: string | null };
  };
  const rows = (cypher: string, params: Record<string, unknown> = {}) => graph.query(cypher, params);
  /** A node the memory knows of its own, as the assistant would make it. */
  const node = async (node_type: string, node_data: Record<string, unknown>): Promise<string> => {
    const out = await step("graph/create-node", { node_type, node_data });
    assert.equal(out.status, "Success", JSON.stringify(out));
    return out.ref_id;
  };
  const pick = (o: { text: string; fixer: string | null }) => ({ text: o.text, fixer: o.fixer });

  it("with nothing taught, a transcript goes out as heard, naming the fixer that read it", async () => {
    const out = await transcribe("send p eight now");
    assert.deepEqual(out, { text: "send p eight now", segments: [{ text: "send p eight now", words: [] }], model: "fake", hotwords: null, durationMs: 1, fixer: "fake" });
  });

  it("with no fixer, an edit teaches nothing", async () => {
    fixer = null;
    try {
      assert.deepEqual(await correct("send p eight now", "send P8 now"), { learned: [] });
      assert.deepEqual(await rows("MATCH (n:Node {node_type: 'Lingo'}) RETURN n.name AS name"), []);
    } finally {
      fixer = fake;
    }
  });

  it("learns a new word as a Lingo, storing only the pair", async () => {
    const out = await correct("I need to send p eight now, before the meeting.", "I need to send P8 now, before the meeting.");
    assert.equal(out.learned.length, 1);
    assert.deepEqual({ ...out.learned[0], undo: undefined }, { heard: "p eight", written: "P8", undo: undefined });
    const [word] = await rows("MATCH (n:Node {node_type: 'Lingo'}) RETURN n.ref_id AS ref_id, n.name AS name, n.created_by AS by");
    assert.deepEqual(out.learned[0]!.undo, [word!.ref_id]);
    assert.deepEqual([word!.name, word!.by], ["P8", "dictation"]);
    const heard = await rows("MATCH (h:Node {node_type: 'Mishearing'}) RETURN h.entity_ref_id AS entity, h.value AS value, h.form AS form");
    assert.deepEqual(heard, [{ entity: word!.ref_id, value: "p eight", form: null }]);
    const all = await rows("MATCH (n:Node) WHERE n.node_type <> 'Schema' RETURN n");
    assert.ok(!JSON.stringify(all).includes("meeting"), "the sentence is never stored");
  });

  it("the next transcription puts it right and says what it changed", async () => {
    const out = await transcribe("send p eight now");
    assert.equal(out.text, "send P8 now");
    assert.equal(out.heard, "send p eight now");
    assert.deepEqual(out.changes, [{ heard: "p eight", written: "P8", at: 5 }]);
    assert.equal(out.segments[0]!.text, "send p eight now");
    assert.deepEqual([out.model, out.fixer], ["fake", "fake"]);
    // lingo=0: as heard.
    const raw = await transcribe("send p eight now", "?lingo=0");
    assert.equal(raw.text, "send p eight now");
    assert.equal(raw.fixer, null);
    assert.equal("heard" in raw || "changes" in raw, false);
  });

  it("with no fixer, or one too slow, only exact learned mishearings are applied", async () => {
    fixer = null;
    let release = (_: number[]) => {};
    try {
      assert.deepEqual(pick(await transcribe("send p eight now")), { text: "send P8 now", fixer: null });
      // A new spelling needs the fixer.
      assert.deepEqual(pick(await transcribe("send p8 now")), { text: "send p8 now", fixer: null });
      let scored = 0;
      fixer = { ...fake, score: () => (scored++, new Promise((r) => (release = r))) };
      const started = Date.now();
      assert.deepEqual(pick(await transcribe("send p eight now")), { text: "send P8 now", fixer: null });
      assert.ok(Date.now() - started < 3000, "it waited for the fixer only so long");
      // While that one is still running, the next goes without the fixer: calls never pile up.
      const again = Date.now();
      assert.deepEqual(pick(await transcribe("send p eight now")), { text: "send P8 now", fixer: null });
      assert.ok(Date.now() - again < 1000, "it did not wait again");
      assert.equal(scored, 1);
    } finally {
      // The late rewrite ends, so the transcripts of the tests after this one get the fixer.
      release([]);
      await new Promise((r) => setImmediate(r));
      fixer = fake;
    }
  });

  it("learns on the entity that writes the word, with the alias as its form", async () => {
    await node("Lingo", { name: "Bitcoin", alt_names: ["BTC"] });
    const out = await correct("send it in bee tee see", "send it in BTC");
    const [fact] = await rows(
      "MATCH (h:Node {node_type: 'Mishearing'}), (e:Node {ref_id: h.entity_ref_id}) WHERE h.value = 'bee tee see' RETURN h.ref_id AS ref_id, h.form AS form, e.name AS name",
    );
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
    assert.deepEqual(await step("dictation/enable", { ref_id: p8.ref_id, on: false }), { ref_id: p8.ref_id, on: false });
    assert.equal((await step("memory/lexicon", {})).entities.find((e: any) => e.name === "P8").dictation_off, true);
    assert.deepEqual(await correct("send p eight now", "send P8 now"), { learned: [] });
    assert.equal((await transcribe("send p eight now")).text, "send p eight now");
  });

  it("dictation/enable turns a word back on, and refuses an entity memory does not have", async () => {
    const p8 = (await step("memory/lexicon", {})).entities.find((e: any) => e.name === "P8");
    assert.deepEqual(await step("dictation/enable", { ref_id: p8.ref_id, on: true }), { ref_id: p8.ref_id, on: true });
    assert.equal((await step("memory/lexicon", {})).entities.find((e: any) => e.name === "P8").dictation_off, false);
    const res = await strut.app.request("/steps/dictation/enable/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { ref_id: "nope", on: false } }) });
    assert.match(JSON.stringify(await res.json()), /no node nope/);
    await step("dictation/enable", { ref_id: p8.ref_id, on: false });
  });

  it("an everyday swap or a rewrite teaches nothing; only a change that sounds alike is asked", async () => {
    judged.length = 0;
    assert.deepEqual(await correct("their team is here", "there team is here"), { learned: [] });
    assert.deepEqual(await correct("ask the stack work team", "Let's talk tomorrow instead"), { learned: [] });
    assert.deepEqual(judged, ["their→there"]);
  });

  it("dictation/add adds a word by hand", async () => {
    const lsat = await step("dictation/add", { written: "LSAT", heard: "el sat" });
    assert.deepEqual([lsat.heard, lsat.written, lsat.undo.length, "applies" in lsat], ["el sat", "LSAT", 1, false]);
    assert.equal((await transcribe("el sat is on")).text, "LSAT is on");
  });

  it("dictation/remove takes a mishearing, a word of dictation's own with its last one, and never another entity", async () => {
    const lexicon = async () => (await step("memory/lexicon", {})).entities as any[];
    const lsat = (await lexicon()).find((e) => e.name === "LSAT");
    // LSAT's only mishearing: the word goes with it.
    assert.deepEqual(await step("dictation/remove", { ref_id: lsat.heard[0].ref_id }), { forgotten: lsat.ref_id });
    assert.equal((await lexicon()).some((e) => e.name === "LSAT"), false);
    assert.equal((await transcribe("el sat is on")).text, "el sat is on");
    // A company keeps itself; only its mishearing goes.
    await node("Organization", { name: "Acme" });
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
    const hiveId = await node("Lingo", { name: "Hive" });
    const about = await step("graph/assert", { source_ref_id: hiveId, edge_type: "covers", target_type: "Topic", target_data: { name: "agents" }, text: "Hive is about agents.", create_schema_if_missing: true });
    assert.equal(about.status, "Success", JSON.stringify(about));
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

  it("a fix inside a full name keeps the person, so the next misspelling of the whole name is put right; Undo forgets both", async () => {
    const out = await correct("My boss is called Paul Itoy.", "My boss is called Paul Itoi.");
    assert.deepEqual(out.learned.map((l) => [l.heard, l.written, l.undo.length]), [["Itoy", "Itoi", 1]]);
    const paul = (await step("memory/lexicon", {})).entities.find((e: any) => e.name === "Paul Itoi");
    assert.deepEqual([paul.type, paul.heard.map((h: any) => [h.value, h.form])], ["Person", [["Itoy", "Itoi"]]]);
    assert.equal((await rows("MATCH (n:Node) WHERE n.name = 'Itoi' RETURN n.ref_id AS id")).length, 0);
    assert.equal((await transcribe("Ask Call itoy about it.")).text, "Ask Paul Itoi about it.");
    // A second fix attaches to the same person.
    const again = await correct("Paul Attoy is out today.", "Paul Itoi is out today.");
    assert.deepEqual(again.learned.map((l) => [l.heard, l.written]), [["Attoy", "Itoi"]]);
    assert.equal((await rows("MATCH (n:Node) WHERE n.name = 'Paul Itoi' AND n.deleted_at IS NULL RETURN n.ref_id AS id")).length, 1);
    await step("dictation/undo", { undo: [...again.learned[0]!.undo, ...out.learned[0]!.undo] });
    assert.ok(!(await step("memory/lexicon", {})).entities.some((e: any) => e.name === "Paul Itoi"));
    assert.equal((await transcribe("Ask Call itoy about it.")).text, "Ask Call itoy about it.");
  });

  it("a code dictation wrote of its own is learned as a term, with no mapping, and found by its near spellings", async () => {
    const out = await correct("check QH today", "check Q8 today");
    assert.deepEqual(out.learned.map((l) => [l.heard, l.written, l.undo.length]), [["QH", "Q8", 1]]);
    const q8 = (await step("memory/lexicon", {})).entities.find((e: any) => e.name === "Q8");
    assert.deepEqual([q8.type, q8.heard], ["Lingo", []]);
    assert.equal((await transcribe("check QH today")).text, "check Q8 today");
  });

  describe("the same fix made again", () => {
    // A fixer that turns every change down: what is learned is the repeat's.
    const doubting: LoadedFixer = { ...fake, judge: async (qs) => qs.map(() => -5) };
    const pending = () => JSON.parse(readFileSync(pendingFile(dataDir), "utf8")) as Record<string, unknown>[];
    before(() => (fixer = doubting));
    after(() => (fixer = fake));

    it("a turned-down fix said the same is kept as the pair alone, and learned, with Undo, the second time", async () => {
      assert.deepEqual(await correct("His name is Paul Etoy.", "His name is Paul Itoi."), { learned: [] });
      const stored = readFileSync(pendingFile(dataDir), "utf8");
      assert.deepEqual(pending().map((r) => [r.heard, r.written, r.count]), [["Etoy", "Itoi", 1]]);
      assert.deepEqual(Object.keys(pending()[0]!).sort(), ["at", "count", "heard", "written"]);
      assert.ok(!/name|Paul/.test(stored), stored);
      const again = await correct("I met Etoy today.", "I met Itoi today.");
      assert.deepEqual(again.learned.map((l) => [l.heard, l.written, l.undo.length]), [["Etoy", "Itoi", 1]]);
      assert.deepEqual(pending(), []);
      // Undone, it is never learned again, however often it is made.
      await step("dictation/undo", { undo: again.learned[0]!.undo });
      for (let i = 0; i < 3; i++) assert.deepEqual(await correct("His name is Paul Etoy.", "His name is Paul Itoi."), { learned: [] });
      assert.deepEqual(pending(), []);
    });

    it("a different name is never kept nor learned, however often it is made", async () => {
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await correct("tell Mark the deck is ready", "tell Mike the deck is ready"), { learned: [] });
        assert.deepEqual(await correct("ask jon now", "ask Jen now"), { learned: [] });
      }
      assert.deepEqual(pending(), []);
    });

    it("a fix counts once an edit, and is forgotten after 30 days", () => {
      const at = Date.parse("2026-01-01");
      const day = 86_400_000;
      const pair = { heard: "Etoy", written: "Itoi" };
      assert.deepEqual(recordPending(dataDir, [pair, { ...pair, heard: "etoy" }], at), []);
      assert.deepEqual(recordPending(dataDir, [pair], at + (PENDING_DAYS + 1) * day), []);
      // The user's casing is the pair's: "itoi" is another fix.
      assert.deepEqual(recordPending(dataDir, [{ heard: "Etoy", written: "itoi" }], at + (PENDING_DAYS + 2) * day), []);
      assert.deepEqual(recordPending(dataDir, [pair], at + (PENDING_DAYS + 3) * day), [pair]);
      assert.deepEqual(recordPending(dataDir, [], at + (2 * PENDING_DAYS + 4) * day), []);
      assert.deepEqual(pending(), []);
    });
  });

  it("memory/lexicon names the lingo type and the mishearing's record type", async () => {
    const lexicon = await step("memory/lexicon", {});
    assert.deepEqual([lexicon.lingo_type, lexicon.person_type, lexicon.mishearing], ["Lingo", "Person", "Mishearing"]);
  });
});
