import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "./_db.js";
import { distance, nameKey, nicknames, similarity, similarName, stem, typo, words } from "./_match.js";

describe("memory matching", () => {
  it("words fold case, accents and apostrophes", () => {
    assert.deepEqual(words("Kate's Café, São Paulo!"), ["kate", "cafe", "sao", "paulo"]);
    assert.deepEqual(words("Katherine’s"), ["katherine"], "a possessive is dropped before the apostrophe");
    assert.deepEqual(words("李明 in 北京, Олег"), ["李明", "in", "北京", "олег"], "letters of any script are kept");
  });

  it("stem brings word forms together, both sides alike", () => {
    for (const [a, b] of [["cycling", "cycles"], ["designers", "design"], ["baked", "baking"], ["swimming", "swim"], ["lecturer", "lectures"], ["hiked", "hiking"], ["coaches", "coach"], ["lives", "live"]]) {
      assert.equal(stem(a!), stem(b!), `${a} / ${b}`);
    }
    assert.equal(stem("class"), "class", "a double s is not a plural");
    assert.equal(stem("cat"), "cat", "short words are left alone");
    assert.equal(stem("олега"), "олега", "only Latin words are stemmed");
  });

  it("distance counts edits and adjacent swaps, and gives up past the limit", () => {
    assert.equal(distance("stakwork", "stakwrok"), 1);
    assert.equal(distance("lisbon", "lisbn"), 1);
    assert.equal(distance("kitten", "sitting", 3), 3);
    assert.equal(distance("abc", "abcdefg", 2), 3);
  });

  it("typo needs five letters for one edit and nine for two", () => {
    assert.ok(typo("priyah", "priya"));
    assert.ok(typo("penicilin", "penicillin"));
    assert.ok(!typo("john", "joan"), "four letters must match exactly");
    assert.ok(!typo("joanna", "joan"));
    assert.ok(typo("bouldring", "bouldering"));
    assert.ok(!typo("same", "same"));
  });

  it("nicknames link short and long forms both ways", () => {
    assert.ok(nicknames("kate").has("katherine"));
    assert.ok(nicknames("katherine").has("kate"));
    assert.ok(nicknames("johnny").has("john") && nicknames("jon").has("jonathan"));
    assert.ok(!nicknames("john").has("jonathan"), "John and Jonathan are different names");
    assert.ok(nicknames("bob").has("robert"));
    assert.ok(nicknames("chris").has("christopher") && nicknames("chris").has("christine"));
    assert.equal(nicknames("zebedee").size, 0);
  });

  it("nameKey ignores case, accents, punctuation, spacing and &", () => {
    assert.equal(nameKey("Dr. Patel"), nameKey("dr patel"));
    assert.equal(nameKey("Novak & Co"), nameKey("Novak and Co"));
    assert.equal(nameKey(" Sofía  Álvarez "), "sofia alvarez");
    assert.notEqual(nameKey("Acme"), nameKey("Acme Corp"));
    assert.equal(nameKey("O'Brien-Smith"), nameKey("obrien smith"));
  });

  it("normalize drops Arabic and Hebrew vowel marks, not Indic vowel signs or Hebrew punctuation", () => {
    assert.equal(normalize("مُحَمَّد علي"), normalize("محمد علي"));
    assert.equal(normalize("محمد علي"), normalize("مُحَمَّد علي"));
    assert.equal(normalize("שָׁלוֹם"), normalize("שלום"));
    assert.equal(nameKey("مُحَمَّد علي"), nameKey("محمد علي"));
    assert.notEqual(normalize("कमल"), normalize("कमला"), "an Indic vowel sign is a letter");
    assert.notEqual(normalize("किताब"), normalize("कताब"));
    assert.ok(normalize("בית־ספר").includes("־"), "maqaf stays");
  });

  it("nameKey keeps every other character, so different names never share a key", () => {
    for (const [a, b] of [["C#", "C++"], ["C#", "C"], ["C++", "C"], ["Олег Petrov", "Иван Petrov"], ["Paweł", "Pawel"], ["J Smith", "Jane Smith"], ["J. Smith", "Jane Smith"], ["李明", "李"]]) {
      assert.notEqual(nameKey(a!), nameKey(b!), `${a} / ${b}`);
    }
    assert.equal(nameKey("Paweł"), "paweł", "ł does not fold");
  });

  it("similarName: people by first and last name, nickname or typo", () => {
    const same = (a: string, b: string) => similarName("Person", a, b);
    assert.ok(same("Kate Moss", "Katherine Moss"));
    assert.ok(same("Jon Price", "Jonathan Price"));
    assert.ok(same("J Smith", "Jane Smith"), "an initial is similar, never a match");
    assert.ok(same("Pawel Nowicki", "Paweł Nowicki"), "a letter that does not fold is a typo");
    assert.ok(same("Priya", "Priya Shah"), "one name against either part");
    assert.ok(same("Rose", "Grandma Rose"), "titles are left out");
    assert.ok(!same("Kate Bush", "Katherine Moss"));
    assert.ok(!same("Joan Price", "Jonathan Price"));
    assert.ok(!same("Jon Ellis", "Joan Ellis"));
    assert.ok(!same("Priyanka Shah", "Priya Shah"));
    assert.ok(!same("Mark Chen", "Marcus Chen"));
    assert.ok(!same("Олег Petrov", "Иван Petrov"));
    assert.ok(!same("Johnny Price", "Jonathan Price"), "John is not Jonathan");
    assert.ok(!same("Pawel Nowicki", "Dr Patel"), "one word never matches by typo");
    assert.ok(!same("J", "Jane Smith"));
  });

  it("similarName: other types by their words in any order, generic words left out", () => {
    const org = (a: string, b: string) => similarName("Organization", a, b);
    assert.ok(org("Acme", "Acme Corp"));
    assert.ok(org("Stakwork Inc.", "Stakwork"));
    assert.ok(org("Bristol University", "University of Bristol"));
    assert.ok(org("Climbing Hangar", "The Climbing Hangar"));
    assert.ok(similarName("Project", "kitchen reno", "Kitchen renovation"), "an abbreviation of four letters or more");
    assert.ok(similarName("Place", "Cornwal", "Cornwall"));
    assert.ok(!org("Acme Bank", "Acme Corp"));
    assert.ok(!org("University of Bath", "University of Bristol"));
    assert.ok(!similarName("Project", "Kitchen garden", "Kitchen renovation"));
    assert.ok(!similarName("Topic", "C#", "C++"));
    assert.ok(!similarName("Topic", "C", "C#"));
  });

  it("similarity ranks closer names higher", () => {
    const p = (a: string, b: string) => similarity("Person", a, b);
    assert.ok(p("Kate Moss", "Kate Moss.") > p("Kate Moss", "Katherine Moss"), "the same words beat a nickname");
    assert.ok(p("Kate Moss", "Katherine Moss") > p("Kate Moss", "K Moss"), "a nickname beats an initial");
    assert.ok(p("Katherine Mossop", "Katherine Mosop") > p("Katherine", "Katherine Mossop"), "two names beat one");
    assert.equal(p("Kate Bush", "Katherine Moss"), 0);
    assert.ok(similarity("Organization", "Acme Corp", "Acme") > similarity("Organization", "Acme Corporation", "Acmee Corp"));
  });
});
