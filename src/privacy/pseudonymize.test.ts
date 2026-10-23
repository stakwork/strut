import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectAll, denyStage, ruleStage } from "./detect.js";
import { pseudonymize } from "./pseudonymize.js";
import { restore } from "./restore.js";
import type { Span } from "./types.js";

const run = async (text: string, o: { deny?: string[]; allow?: string[]; extra?: Span[] } = {}) => {
  const spans = await detectAll(text, [denyStage, ruleStage, { name: "x", priority: 3, detect: () => o.extra ?? [] }], { deny: o.deny ?? [], minScore: 0.6, warn: () => {} });
  return pseudonymize(text, spans, { allow: o.allow ?? [] });
};
const at = (text: string, w: string, type: string, src: Span["src"] = "ner"): Span => ({ s: text.indexOf(w), e: text.indexOf(w) + w.length, type, src });

describe("pseudonymize", () => {
  it("numbers tokens per type, reuses one token for a repeated value", async () => {
    const t = "mail a@example.com or b@example.com, again a@example.com";
    const r = await run(t);
    assert.equal(r.out, "mail [EMAIL_1] or [EMAIL_2], again [EMAIL_1]");
    assert.deepEqual(r.counts, { EMAIL: 2 });
    assert.deepEqual(r.map["[EMAIL_1]"], { type: "EMAIL", value: "a@example.com" });
  });
  it("a first name that is part of a full name is an alias [PERSON_1a]; a sweep masks later mentions", async () => {
    const t = "Ravi Patel arrived. Later ravi said hi and Patel left. Ravi Patel again.";
    const r = await run(t, { extra: [at(t, "Ravi Patel", "PERSON")] });
    assert.ok(r.out.startsWith("[PERSON_1] arrived."), r.out);
    assert.ok(!r.out.includes("Patel"), r.out);
    assert.match(r.out, /\[PERSON_1a?\]/);
    assert.equal(r.map["[PERSON_1]"]!.value, "Ravi Patel");
    assert.ok(Object.keys(r.map).some((k) => k === "[PERSON_1a]"), JSON.stringify(r.map));
  });
  it("sweeps other occurrences of a found name the model missed", async () => {
    const t = "Ask Zelda about it. Zelda knows.";
    const r = await run(t, { extra: [at(t, "Zelda", "PERSON")] });
    assert.equal(r.out, "Ask [PERSON_1] about it. [PERSON_1] knows.");
  });
  it("allow list keeps words; deny list masks as PERSON", async () => {
    const t = "Toronto and Paris with Sam";
    const spans = [at(t, "Toronto", "LOC"), at(t, "Paris", "LOC")];
    const r = await run(t, { extra: spans, allow: ["toronto"], deny: ["sam"] });
    assert.equal(r.out, "Toronto and [LOC_1] with [PERSON_1]");
    assert.equal(r.map["[PERSON_1]"]!.value, "Sam");
  });
  it("preserves the original surface of the value in the map", async () => {
    const r = await run("SAM left", { deny: ["sam"] });
    assert.equal(r.map["[PERSON_1]"]!.value, "SAM");
  });
});

describe("restore", () => {
  const map = { "[PERSON_1]": { type: "PERSON", value: "Ann" }, "[PERSON_1a]": { type: "PERSON", value: "Annie" }, "[EMAIL_1]": { type: "EMAIL", value: "a@x.io" } };
  it("restores plain, lowercase, unbracketed and spaced tokens", () => {
    const r = restore("[PERSON_1] [person_1] PERSON_1 [ PERSON 1 ] [person_1a] [EMAIL_1]", map);
    assert.equal(r.text, "Ann Ann Ann Ann Annie a@x.io");
    assert.equal(r.restored, 6);
    assert.equal(r.unknown, 0);
  });
  it("reports unknown tokens and leaves them as written", () => {
    const r = restore("hi [PERSON_7] and [PERSON_8], [ORG_2]", map);
    assert.equal(r.text, "hi [PERSON_7] and [PERSON_8], [ORG_2]");
    assert.equal(r.restored, 0);
    assert.equal(r.unknown, 2); // distinct by type and letter, numbers collapsed
  });
  it("does not treat prototype names as tokens and keeps $ in values literal", () => {
    const r = restore("[CONSTRUCTOR_1] [PERSON_1]", { "[PERSON_1]": { type: "PERSON", value: "$&Ann" } });
    assert.equal(r.text, "[CONSTRUCTOR_1] $&Ann");
  });
});
