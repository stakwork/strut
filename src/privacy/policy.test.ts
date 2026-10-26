import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateText } from "ai";
import { DEFAULT_MASK, makeRefine } from "./policy.js";
import { maskText } from "./index.js";
import { pseudonymize } from "./pseudonymize.js";
import { refineDate } from "./refine/date.js";
import { refineUrl } from "./refine/url.js";
import { readPolicy, normalizePrivacy } from "./settings.js";
import { FIX, NER, fakeNer, makeCtx, uid, wrap } from "./testing/harness.js";
import { mockModel, sent } from "./testing/mock-model.js";
import { MemoryTranscriptStore } from "./transcript.js";
import { detectAll, denyStage, ruleStage } from "./detect.js";

const policy = readPolicy("hosted")!;
const ctx = { services: { privacy: { ner: fakeNer(NER) } } };

describe("per-type policy", () => {
  it("the default mask list", () => {
    assert.deepEqual(policy.mask, DEFAULT_MASK);
    for (const t of ["DATE", "TIME", "URL", "LOC"]) assert.ok(!policy.mask.includes(t));
  });

  it("a prompt with a date, a city, a URL and a weekday reaches the provider with those visible; name, email, phone, street, org masked", async () => {
    const model = mockModel({ turns: [[{ type: "text", text: "ok" }]] });
    const prompt = `On Thursday, March 3rd, in ${FIX.city}, open https://news.example.com/world/story?id=8841275&utm=abc . ` +
      `${FIX.person} (${FIX.email}, ${FIX.phone}) lives at ${FIX.street} and works at ${FIX.org}.`;
    await generateText({ model: await wrap(model, { ctx: makeCtx({ privacy: "hosted", services: ctx.services }), session: uid("p") }), prompt });
    const wire = sent(model);
    for (const v of ["Thursday", "March 3rd", FIX.city, "https://news.example.com/world/story"]) assert.ok(wire.includes(v), `${v} should be visible`);
    for (const v of [FIX.person, FIX.email, FIX.phone, FIX.street, FIX.org, "8841275", "utm=abc"]) assert.ok(!wire.includes(v), `${v} should be masked`);
  });

  it("fixtures: URL, date and address cases", async () => {
    const rows = readFileSync(new URL("./fixtures/policy.jsonl", import.meta.url), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    for (const r of rows) {
      const { out } = await maskText(r.text, { policy, map: {} }, ctx);
      for (const v of r.visible) assert.ok(out.includes(v), `visible "${v}" in: ${out}`);
      for (const v of r.masked) assert.ok(!out.includes(v), `masked "${v}" in: ${out}`);
    }
  });

  it("a type the list leaves out is not swept; one it names is", async () => {
    const text = `${FIX.org} is in ${FIX.city}. Later: ${FIX.city} and ${FIX.org} again.`;
    const spans = await detectAll(text, [denyStage, ruleStage, { name: "n", priority: 3, detect: (t) => [{ s: t.indexOf(FIX.org), e: t.indexOf(FIX.org) + FIX.org.length, type: "ORG", src: "ner" as const }, { s: t.indexOf(FIX.city), e: t.indexOf(FIX.city) + 6, type: "LOC", src: "ner" as const }] }], { deny: [], minScore: 0.5, warn: () => {} });
    const out = pseudonymize(text, spans, { allow: [], mask: ["ORG"] }).out;
    assert.equal(out, `[ORG_1] is in ${FIX.city}. Later: ${FIX.city} and [ORG_1] again.`);
  });
});

describe("pseudonymize over an existing map", () => {
  it("reuses tokens for the same value and numbers on after the map's", async () => {
    const map = {};
    const a = await maskText(`${FIX.person} wrote to ${FIX.email}`, { policy, map }, ctx);
    assert.equal(a.out, "[PERSON_1] wrote to [EMAIL_1]");
    const b = await maskText(`Cc ${FIX.email}, ${FIX.person} and ${FIX.org}, new mail bob@example.com`, { policy, map }, ctx);
    assert.equal(b.out, "Cc [EMAIL_1], [PERSON_1] and [ORG_1], new mail [EMAIL_2]");
    assert.deepEqual(b.counts, { ORG: 1, EMAIL: 1 });
    assert.equal(Object.keys(map).length, 4);
  });
});

describe("refiners", () => {
  const url = (u: string) => { const t = `see ${u} ok`; return refineUrl({ s: 4, e: 4 + u.length, type: "URL", src: "rule" }, t).map((s) => [s.type, t.slice(s.s, s.e)]); };
  it("url: personal parts only; scheme, host and path stay", () => {
    assert.deepEqual(url("https://a.example.com/docs/guide"), []);
    assert.deepEqual(url("https://a.example.com/p?q=weather&page=2"), [["ID", "weather"], ["ID", "2"]]);
    assert.deepEqual(url("https://bob:pw@a.example.com/x"), [["ID", "bob:pw"]]);
    assert.deepEqual(url("https://a.example.com/users/ann@example.org/edit"), [["EMAIL", "ann@example.org"]]);
    assert.deepEqual(url("https://a.example.com/@ann.lee/posts"), [["HANDLE", "@ann.lee"]]);
    assert.deepEqual(url("https://a.example.com/o/3f2504e0-4f89-11d3-9a0c-0305e82c3301"), [["ID", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"]]);
    assert.deepEqual(url("https://a.example.com/s/Zx81kQ72mLpA93vTbN5c"), [["ID", "Zx81kQ72mLpA93vTbN5c"]]);
    assert.deepEqual(url("https://a.example.com/cb#access_token=abc"), [["ID", "access_token=abc"]]);
  });
  it("date: only with a birth cue near", () => {
    const d = (t: string, v: string) => refineDate({ s: t.indexOf(v), e: t.indexOf(v) + v.length, type: "DATE", src: "rule" }, t).length;
    assert.equal(d("born on 1984-05-17", "1984-05-17"), 1);
    assert.equal(d("DOB: 05/17/1984", "05/17/1984"), 1);
    assert.equal(d("birthday March 3rd", "March 3rd"), 1);
    assert.equal(d("meet on March 3rd", "March 3rd"), 0);
    assert.equal(d("due 2025-03-03, and she was born long ago", "2025-03-03"), 0);
  });
  it("a refiner never masks a type the mask list lacks", () => {
    const r = makeRefine(["PERSON"]);
    assert.deepEqual(r({ s: 0, e: 30, type: "URL", src: "rule" }, "https://a.example.com/p?q=weather"), []);
  });
});

describe("changing the mask list mid-session", () => {
  it("starts a fresh transcript (epoch bump)", async () => {
    const store = new MemoryTranscriptStore(60_000, Date.now, false);
    const session = uid("mask");
    const model = mockModel({ turns: [[{ type: "text", text: "ok" }]] });
    const mk = (privacy: unknown) => makeCtx({ privacy, services: { privacy: { ner: fakeNer(NER), transcripts: store } } });
    await generateText({ model: await wrap(model, { ctx: mk("hosted"), session }), prompt: `${FIX.person} in ${FIX.city}` });
    assert.equal((await store.load(session))!.epoch, 1);
    await generateText({ model: await wrap(model, { ctx: mk({ mode: "hosted", mask: [...DEFAULT_MASK, "LOC"] }), session }), prompt: `${FIX.person} in ${FIX.city}` });
    assert.equal((await store.load(session))!.epoch, 2);
    assert.ok(model.calls[0]!.includes(FIX.city) && !model.calls[1]!.includes(FIX.city), "LOC masked after the change");
  });
});

describe("settings short forms", () => {
  it("normalise and refuse", () => {
    assert.equal(readPolicy(undefined), null);
    assert.equal(readPolicy("off"), null);
    assert.equal(readPolicy({ mode: "off" } as any), null);
    assert.deepEqual(readPolicy("strict"), { mode: "strict", mask: DEFAULT_MASK, detect: { llm: false } });
    assert.deepEqual(readPolicy({ mode: "hosted", mask: ["PERSON"], detect: { llm: true } }), { mode: "hosted", mask: ["PERSON"], detect: { llm: true } });
    assert.throws(() => readPolicy("on"), /privacy_setting_invalid/);
    assert.throws(() => readPolicy({ mode: "hosted", mask: "PERSON" }), /privacy_setting_invalid/);
    assert.deepEqual(normalizePrivacy("off"), { mode: "off" });
  });
});
