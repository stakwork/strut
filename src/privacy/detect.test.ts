import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ruleSpans, resolve, typeFix, detectAll, denyStage, ruleStage, type Stage } from "./detect.js";
import type { Span } from "./types.js";

const found = (text: string) => ruleSpans(text).map((s) => [s.type, text.slice(s.s, s.e), s.src] as const);
const has = (text: string, type: string, value: string) =>
  assert.ok(found(text).some(([t, v]) => t === type && v === value), `${type} "${value}" in ${JSON.stringify(found(text))}`);
const none = (text: string, ...types: string[]) =>
  assert.deepEqual(found(text).filter(([t]) => types.includes(t)), [], text);

describe("rules", () => {
  it("email, spoken email, handle, url", () => {
    has("write to ann.lee+x@example.co.uk now", "EMAIL", "ann.lee+x@example.co.uk");
    has("it is jo dot smith at mail dot com", "EMAIL", "jo dot smith at mail dot com");
    has("ping @some_user please", "HANDLE", "@some_user");
    has("see https://example.com/a/b?c=1, ok", "URL", "https://example.com/a/b?c=1");
    none("a@b is not mail", "EMAIL");
  });
  it("ids: SSN, card, ticket, IBAN, IP, cue codes", () => {
    has("ssn 123-45-6789", "ID", "123-45-6789");
    has("card 4111 1111 1111 1111 expires", "ID", "4111 1111 1111 1111");
    has("ref ABC-12345 done", "ID", "ABC-12345");
    has("pay GB82 WEST 1234 5698 7654 32 today", "ID", "GB82 WEST 1234 5698 7654 32");
    has("host 192.168.1.20 down", "ID", "192.168.1.20");
    has("my confirmation code is XK29TQ7 ok", "ID", "XK29TQ7");
    has("passport number: AB123456", "ID", "AB123456");
    none("we have two cats and 12 apples", "ID");
  });
  it("phones: NANP, international, french, spoken digits", () => {
    has("call (416) 555-0199 today", "PHONE", "(416) 555-0199");
    has("call 416-555-0199", "PHONE", "416-555-0199");
    has("reach me on +44 20 7946 0958 later", "PHONE", "+44 20 7946 0958");
    has("au 06 12 34 56 78 voila", "PHONE", "06 12 34 56 78");
    has("it is five five five one two three four", "PHONE", "five five five one two three four");
    none("we paid 1234 dollars", "PHONE");
  });
  it("dates in several languages and formats", () => {
    has("on 2024-03-05 we met", "DATE", "2024-03-05");
    has("on 3/5/2024 we met", "DATE", "3/5/2024");
    has("on March 5th, 2024 we met", "DATE", "March 5th, 2024");
    has("on 5th of March 2024 we met", "DATE", "5th of March 2024");
    has("in June 2023 we met", "DATE", "June 2023");
    has("am 5.3.2024 trafen wir", "DATE", "5.3.2024");
    has("el 12 de marzo de 2024 fue", "DATE", "12 de marzo de 2024");
    has("le 3 janvier 2022 c'était", "DATE", "3 janvier 2022");
    has("il 4 agosto 2021 era", "DATE", "4 agosto 2021");
    none("we have three dogs", "DATE");
  });
  it("addresses: street, postal codes, es/de forms", () => {
    has("I live at 42 Maple Street now", "ADDRESS", "42 Maple Street");
    has("at 7 Oak Lane Gardens ok", "ADDRESS", "7 Oak Lane Gardens");
    has("code M5V 2T6 here", "ADDRESS", "M5V 2T6");
    has("postcode SW1A 1AA here", "ADDRESS", "SW1A 1AA");
    has("vivo en Calle de Alcalá 25 ahora", "ADDRESS", "Calle de Alcalá 25");
    has("wohne in Hauptstraße 12 jetzt", "ADDRESS", "Hauptstraße 12");
    none("the street was long", "ADDRESS");
  });
});

describe("heuristics", () => {
  it("titles and relationship cues give PERSON", () => {
    has("thanks to Dr Marlowe for that", "PERSON", "Marlowe");
    has("Mrs. Okafor-Smith called", "PERSON", "Okafor-Smith");
    has("my sister Brenda came", "PERSON", "Brenda");
    has("our late uncle Ravi Patel left", "PERSON", "Ravi Patel");
    has("they call him Ziggy", "PERSON", "Ziggy");
  });
  it("stopwords never become names", () => {
    none("Dr Monday came", "PERSON");
    none("my friend Friday said", "PERSON");
  });
  it("gazetteer and suffix rules give ORG and LOC", () => {
    has("we flew to Toronto", "LOC", "Toronto");
    has("works at Mercy Hospital now", "ORG", "Mercy Hospital");
    has("ordered on Amazon today", "ORG", "Amazon");
    has("she uses Uber Eats a lot", "ORG", "Uber Eats");
    has("studied at University of Leeds", "ORG", "University of Leeds");
    none("a quiet afternoon at home", "ORG", "LOC", "PERSON");
  });
});

describe("typeFix", () => {
  it("fixes org/loc confusions and leaves persons", () => {
    const fix = (t: string, w: string, type: string) => typeFix(t, t.indexOf(w), t.indexOf(w) + w.length, type);
    assert.equal(fix("I use Amazon", "Amazon", "LOC"), "ORG");
    assert.equal(fix("flew to Paris", "Paris", "ORG"), "LOC");
    assert.equal(fix("at Mercy Hospital", "Mercy Hospital", "LOC"), "ORG");
    assert.equal(fix("he works at Brightside", "Brightside", "LOC"), "ORG");
    assert.equal(fix("we moved to Brightside", "Brightside", "ORG"), "LOC");
    assert.equal(fix("Maple Park", "Maple Park", "ORG"), "LOC");
    assert.equal(fix("Ann", "Ann", "PERSON"), "PERSON");
  });
});

describe("resolve", () => {
  const sp = (s: number, e: number, src: Span["src"], type = "X"): Span => ({ s, e, type, src });
  it("priority deny > rule > heur > ner > llm, regardless of length", () => {
    const r = resolve([sp(0, 20, "llm"), sp(2, 6, "ner"), sp(3, 6, "heur"), sp(4, 9, "rule"), sp(5, 7, "deny")]);
    assert.deepEqual(r.map((x) => x.src), ["deny"]);
    assert.deepEqual(resolve([sp(0, 20, "llm"), sp(2, 6, "ner")]).map((x) => x.src), ["ner"]);
    // heur and ner share a level: the longer wins, a tie goes to heur
    assert.deepEqual(resolve([sp(0, 20, "ner"), sp(2, 6, "heur")]).map((x) => x.src), ["ner"]);
    assert.deepEqual(resolve([sp(0, 4, "ner"), sp(0, 4, "heur")]).map((x) => x.src), ["heur"]);
  });
  it("same priority: longest wins; disjoint spans all kept and sorted", () => {
    assert.deepEqual(resolve([sp(0, 3, "ner"), sp(1, 8, "ner")]).map((x) => [x.s, x.e]), [[1, 8]]);
    assert.deepEqual(resolve([sp(10, 12, "ner"), sp(0, 3, "rule"), sp(3, 10, "heur")]).map((x) => x.s), [0, 3, 10]);
  });
  it("touching spans do not overlap", () => {
    assert.equal(resolve([sp(0, 5, "rule"), sp(5, 9, "rule")]).length, 2);
  });
  it("is fast on many candidates", () => {
    const many = Array.from({ length: 20000 }, (_, i) => sp(i * 3, i * 3 + 2, "rule"));
    const t0 = Date.now();
    assert.equal(resolve(many).length, 20000);
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe("detectAll / stages", () => {
  it("merges stages through resolve and honours a custom stage", async () => {
    const clue: Stage = { name: "clue", priority: 2, detect: () => [{ s: 0, e: 3, type: "CLUE", src: "clue" }] };
    const text = "Ann wrote to bob@example.com";
    const spans = await detectAll(text, [ruleStage, denyStage, clue], { deny: ["ann"], minScore: 0.6, warn: () => {} });
    assert.deepEqual(spans.map((s) => [text.slice(s.s, s.e), s.src]), [["Ann", "deny"], ["bob@example.com", "rule"]]);
    const only = await detectAll(text, [clue], { deny: [], minScore: 0, warn: () => {} });
    assert.deepEqual(only.map((s) => s.type), ["CLUE"]);
  });
});
