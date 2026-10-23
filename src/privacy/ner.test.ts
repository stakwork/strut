import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupAndAlign, nerPostprocess, nerStage, workerNer } from "./ner.js";
import { llmPostprocess, llmStage, parseLlmReply, workerLlm } from "./llm.js";
import { privacyModelOptions } from "./models.js";
import { anonymizeTexts } from "./index.js";
import { chunk } from "./chunk.js";
import { detectAll, ruleStage } from "./detect.js";
import type { LlmEngine, NerEngine, RawNerSpan, Warning } from "./types.js";

const raw = (t: string, w: string, type: string, score = 0.99): RawNerSpan => ({ s: t.indexOf(w), e: t.indexOf(w) + w.length, type, score });
const texts = (t: string, spans: ReturnType<typeof nerPostprocess>) => spans.map((s) => [t.slice(s.s, s.e), s.type]);

describe("ner post-processing (pure)", () => {
  it("min_score filters, unknown types (MISC) are ignored", () => {
    const t = "Ann met Bob in Rome with Fiat";
    const r = nerPostprocess(t, [raw(t, "Ann", "PER", 0.9), raw(t, "Bob", "PER", 0.5), raw(t, "Fiat", "MISC")], 0.6);
    assert.deepEqual(texts(t, r), [["Ann", "PERSON"]]);
  });
  it("grows a sub-word span to whole words", () => {
    const t = "hello Bartholomew";
    const r = nerPostprocess(t, [{ s: 6, e: 10, type: "PER", score: 0.9 }], 0.6);
    assert.deepEqual(texts(t, r), [["Bartholomew", "PERSON"]]);
  });
  it("strips a leading title/greeting from a person", () => {
    const t = "Dr. Alvarez is in, hi";
    const r = nerPostprocess(t, [raw(t, "Dr. Alvarez", "PER")], 0.6);
    assert.deepEqual(texts(t, r), [["Alvarez", "PERSON"]]);
  });
  it("drops leading lowercase filler", () => {
    const t = "so um Ahmed came";
    const r = nerPostprocess(t, [raw(t, "um Ahmed", "PER")], 0.6);
    assert.deepEqual(texts(t, r), [["Ahmed", "PERSON"]]);
  });
  it("STOP words and lowercase spans are filtered", () => {
    const t = "Friday my mum called, Monday too, and bob";
    const r = nerPostprocess(t, [raw(t, "Friday", "PER"), raw(t, "mum", "PER"), raw(t, "Monday", "PER"), raw(t, "bob", "PER")], 0.6);
    assert.deepEqual(r, []);
  });
  it("applies typeFix", () => {
    const t = "I work at Amazon";
    assert.deepEqual(texts(t, nerPostprocess(t, [raw(t, "Amazon", "LOC")], 0.6)), [["Amazon", "ORG"]]);
  });
});

describe("ner grouping and alignment (pure)", () => {
  const tok = (entity: string, word: string, index: number, score = 0.9) => ({ entity, word, index, score });
  it("joins B-/I- and ## pieces, whitespace tolerant, score is the mean", () => {
    const ct = "Hi Sarah  Connor and Bob";
    const r = groupAndAlign(ct, [tok("B-PER", "Sarah", 2, 1), tok("I-PER", "Connor", 3, 0.8), tok("B-PER", "Bo", 5), tok("I-PER", "##b", 6)]);
    assert.equal(r.unaligned, 0);
    assert.deepEqual(r.spans.map((s) => ct.slice(s.s, s.e)), ["Sarah  Connor", "Bob"]);
    assert.ok(Math.abs(r.spans[0]!.score - 0.9) < 1e-9);
  });
  it("counts what cannot be aligned instead of dropping silently", () => {
    const r = groupAndAlign("Hi Sarah", [tok("B-PER", "Sarah", 2), tok("B-PER", "Zed", 4)]);
    assert.equal(r.unaligned, 1);
    assert.equal(r.spans.length, 1);
  });
});

describe("chunk", () => {
  it("covers the whole text with overlap and splits at spaces", () => {
    const t = "word ".repeat(400);
    const cs = chunk(t, 700, 80);
    assert.ok(cs.length >= 3);
    assert.equal(cs[0]![0], 0);
    assert.equal(cs.at(-1)![1], t.length);
    for (let i = 1; i < cs.length; i++) assert.ok(cs[i]![0] < cs[i - 1]![1]);
  });
});

describe("detection with a fake NER engine", () => {
  const run = async (engine: NerEngine, text: string) => {
    const warnings: Warning[] = [];
    const spans = await detectAll(text, [ruleStage, nerStage(engine)], { deny: [], minScore: 0.6, warn: (w) => warnings.push(w) });
    return { spans, warnings };
  };
  it("unaligned spans become a warning with a count and no text", async () => {
    const text = "Jonas called Lucia";
    const engine: NerEngine = { detect: async () => ({ spans: [[raw(text, "Jonas", "PER")]], unaligned: 2 }) };
    const { spans, warnings } = await run(engine, text);
    assert.deepEqual(spans.map((s) => text.slice(s.s, s.e)), ["Jonas"]);
    assert.deepEqual(warnings, [{ code: "ner_unaligned_spans", message: warnings[0]!.message, count: 2 }]);
    assert.ok(!JSON.stringify(warnings).includes("Jonas"));
  });
  it("a rule span beats an overlapping NER span", async () => {
    const text = "mail jo@example.com";
    const engine: NerEngine = { detect: async () => ({ spans: [[raw(text, "jo", "PER")]], unaligned: 0 }) };
    const { spans } = await run(engine, text);
    assert.deepEqual(spans.map((s) => [s.src, text.slice(s.s, s.e)]), [["rule", "jo@example.com"]]);
  });
});

describe("llm detector with a fake engine", () => {
  const run = async (engine: LlmEngine, text: string) => {
    const warnings: Warning[] = [];
    const spans = await detectAll(text, [llmStage(engine)], { deny: [], minScore: 0.6, warn: (w) => warnings.push(w) });
    return { spans, warnings };
  };
  it("invalid JSON from the model is a warning, not silence", async () => {
    const { spans, warnings } = await run({ detect: async () => ({ items: [[]], invalid: 3 }) }, "Bean came");
    assert.deepEqual(spans, []);
    assert.deepEqual(warnings.map((w) => [w.code, w.count]), [["llm_invalid_output", 3]]);
  });
  it("parseLlmReply: null on junk, items on a valid array", () => {
    assert.equal(parseLlmReply("sorry I cannot"), null);
    assert.equal(parseLlmReply("[{oops"), null);
    assert.deepEqual(parseLlmReply('ok [{"text":"Bean","type":"NICKNAME"}] done'), [{ text: "Bean", type: "NICKNAME" }]);
    assert.deepEqual(parseLlmReply("[]"), []);
  });
  it("trusts only short, capitalised, digit-free, verbatim candidates; counts the rejected", async () => {
    const text = "Bean and Bean again, Smitty at Nandos. Nandos opens.";
    const { spans, warnings } = await run(
      { detect: async () => ({ items: [[{ text: "Bean", type: "NICKNAME" }, { text: "bean2", type: "PERSON" }, { text: "Nandos", type: "ORG" }, { text: "not here", type: "PERSON" }, { text: "friday", type: "PERSON" }]], invalid: 0 }) },
      text,
    );
    assert.deepEqual(spans.map((s) => [text.slice(s.s, s.e), s.type]), [["Bean", "PERSON"], ["Bean", "PERSON"], ["Nandos", "ORG"]]);
    assert.deepEqual(warnings.map((w) => [w.code, w.count]), [["llm_rejected_candidates", 1]]);
  });
  it("an org that only starts a sentence is not trusted", () => {
    const { spans } = llmPostprocess("Apple pie. Fine.", [{ text: "Apple", type: "ORG" }]);
    assert.deepEqual(spans, []);
  });
});

describe("where the models run", () => {
  it("their settings are read from the environment by privacyModelOptions", () => {
    assert.deepEqual(privacyModelOptions({ STRUT_MODEL_DIR: "/m", STRUT_PRIVACY_OFFLINE: "1" }), { cacheDir: join("/m", "privacy"), offline: true });
    assert.equal(privacyModelOptions({ STRUT_MODEL_DIR: "/m" }).offline, false);
  });

  it("the default NER and LLM run in worker threads, configured from the main thread, and still fail closed", async () => {
    const models = await mkdtemp(join(tmpdir(), "strut-privacy-models-"));
    const dataDir = await mkdtemp(join(tmpdir(), "strut-privacy-data-"));
    const env = process.env as Record<string, string | undefined>;
    try {
      env["STRUT_MODEL_DIR"] = models;
      env["STRUT_PRIVACY_OFFLINE"] = "1";
      const ner = workerNer();
      const llm = workerLlm();
      // What the env scrub does before a worker starts: the settings are gone
      // from the environment, so offline must reach the worker as an option.
      delete env["STRUT_MODEL_DIR"];
      delete env["STRUT_PRIVACY_OFFLINE"];
      await assert.rejects(ner.detect(["Jonas"]), /^Error: privacy ner worker: .*local_files_only/);
      await assert.rejects(llm.detect(["Jonas"]), /^Error: privacy llm worker: .*local_files_only/);
      assert.equal(workerNer(), ner, "one per process");
      const opts = { vault: "memory" as const, ttlMinutes: 1, deny: [], allow: [], ner: true, llm: false, minScore: 0.6, privacyLevel: "off" as const };
      await assert.rejects(anonymizeTexts(["Jonas"], opts, { services: { dataDir } }), /ner_unavailable: .*privacy ner worker/);
      assert.deepEqual(await readdir(models), [], "nothing downloaded");
    } finally {
      await rm(models, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
