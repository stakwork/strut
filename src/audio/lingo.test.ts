import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCommon as everyday } from "./common-words.js";
import { lessons, learnInput, lexiconFrom, rewrite, undoIds, type Lesson, type Lexicon } from "./lingo.js";

// Dictation's vocabulary: the rewrite before the text is typed, and what an
// edit of it teaches. Peel's LingoTests.swift, case for case.

/** Everyday words, as a spell checker would say. */
const COMMON = new Set([
  "a", "i", "ask", "the", "team", "about", "stack", "work", "their", "there", "eight", "meeting", "fix",
  "bit", "coin", "sat", "peel", "for", "to", "is", "on", "we", "go", "hive", "and", "apple", "pie", "think",
  "so", "now", "number", "it", "push",
]);
const isCommon = (w: string) => COMMON.has(w);

const entry = (refId: string, type: string, name: string, written: string[], heard: [string, string, string?][] = [], dictationOff = false) => ({
  refId, type, name, written, dictationOff, facts: heard.length, heard: heard.map(([id, value, form]) => ({ refId: id, value, form: form ?? null })),
});

const lexicon: Lexicon = {
  lingoType: "Lingo",
  mishearing: "heard_as",
  undone: [],
  entries: [
    entry("e1", "Organization", "Stakwork", ["Stakwork"], [["f1", "stack work"]]),
    entry("e2", "Lingo", "Bitcoin", ["Bitcoin", "BTC"], [["f2", "bee tee see", "BTC"]]),
    entry("e3", "Project", "Sphinx", ["Sphinx"], [["f3", "fix"]]),
    entry("e4", "Project", "Peel", ["Peel"]),
    entry("e5", "Lingo", "LSAT", ["LSAT"], [["f5", "el sat"]], true),
    // An agent stored it in its own casing; nobody taught it to dictation.
    entry("e6", "Organization", "github", ["github"]),
  ],
};

const REWRITES: [string, string][] = [
  // A mishearing, with the punctuation around it kept.
  ["Ask the stack work team.", "Ask the Stakwork team."],
  // One standing for an alias.
  ["send it in bee tee see", "send it in BTC"],
  // A single everyday word is never rewritten: "fix" stays "fix".
  ["we fix it", "we fix it"],
  // Casing for a written form that is not an everyday word; "peel" stays.
  ["ask stakwork about bitcoin and peel", "ask Stakwork about Bitcoin and peel"],
  // Off for dictation: left as it is.
  ["el sat is on", "el sat is on"],
  // A new spelling of a taught name: its letters, or nearly ("Stockwork").
  ["Hello, I work for Stockwork.", "Hello, I work for Stakwork."],
  ["I work for stackwork", "I work for Stakwork"],
  ["I work for StackWork now", "I work for Stakwork now"],
  // Not a different word: "stadium" and "network" stay.
  ["I work at the stadium network", "I work at the stadium network"],
  // Not across a sentence break.
  ["We need a stack. Work starts", "We need a stack. Work starts"],
  // A name nobody taught dictation keeps the user's casing.
  ["push it to GitHub", "push it to GitHub"],
  // Nothing known: untouched, spacing and all.
  ["  nothing  here ", "  nothing  here "],
];

const misheard = (heard: string, written: string): Lesson => ({ kind: "misheard", heard, written });
const nothing: Lesson = { kind: "nothing" };

const LESSONS: [string, string, Lesson[]][] = [
  // Dictation broke a name up: learned.
  ["Ask the stack work team", "Ask the Stakwork team", [misheard("stack work", "Stakwork")]],
  // Spelled out what was said as P8: learned (nobody writes "p eight").
  ["send p eight now", "send P8 now", [misheard("p eight", "P8")]],
  // Letters run apart: learned.
  ["the k p i number", "the KPI number", [misheard("k p i", "KPI")]],
  // Casing only, on a name not known yet: learned.
  ["ask hivemind now", "ask HiveMind now", [misheard("hivemind", "HiveMind")]],
  // Casing on a known name: the rewrite already cases it, nothing new.
  ["ask stakwork now", "ask Stakwork now", [nothing]],
  // Dictation wrote PH for P8: PH is something you could mean, so nothing is learned.
  ["send PH now", "send P8 now", [nothing]],
  // An everyday swap.
  ["their team", "there team", [nothing]],
  // Two right ways to write one thing.
  ["send BTC now", "send Bitcoin now", [nothing]],
  // A changed mind: a name that sounds nothing like what was said.
  ["ask the meeting team", "ask the Stakwork team", [nothing]],
  // Capitalising an everyday word or a letter teaches nothing.
  ["i think so", "I think so", [nothing]],
  ["apple pie", "Apple pie", [nothing]],
  // One name swapped for another like it: a different person, not a mishearing.
  ["ask jon now", "ask Jen now", [nothing]],
  // A word turned off for dictation is left alone.
  ["the el sat token", "the LSAT token", [nothing]],
  // A one-word dictation can still teach.
  ["hivemind", "HiveMind", [misheard("hivemind", "HiveMind")]],
  // A long word misspelt: learned ("Stackwork", "stockwork" → Stakwork).
  ["Hello I work for Stackwork", "Hello I work for Stakwork", [misheard("Stackwork", "Stakwork")]],
  ["I work for stockwork", "I work for Stakwork", [misheard("stockwork", "Stakwork")]],
  // A different word altogether is not.
  ["I work for stadium", "I work for Stakwork", [nothing]],
  // A short name swapped for one like it is a different person.
  ["ask sarah now", "ask Sara now", [nothing]],
  // A cut at the end, kept the rest.
  ["ask the team about it", "ask the team", [nothing]],
];

describe("lingo: the rewrite", () => {
  for (const [heard, typed] of REWRITES) {
    it(JSON.stringify(heard), () => assert.equal(rewrite(heard, lexicon, isCommon).text, typed));
  }

  it("says what it changed", () => {
    assert.deepEqual(rewrite("the stack work team", lexicon, isCommon).changes, [{ heard: "stack work", written: "Stakwork" }]);
  });

  it("gives the same results with the shipped word list", () => {
    for (const [heard, typed] of REWRITES) assert.equal(rewrite(heard, lexicon, everyday).text, typed, heard);
  });
});

describe("lingo: learning from an edit", () => {
  for (const [typed, edited, expected] of LESSONS) {
    it(`${JSON.stringify(typed)} → ${JSON.stringify(edited)}`, () => assert.deepEqual(lessons(typed, edited, lexicon, isCommon), expected));
  }

  it("gives the same results with the shipped word list", () => {
    for (const [typed, edited, expected] of LESSONS) assert.deepEqual(lessons(typed, edited, lexicon, everyday), expected, typed);
  });

  it("a rewrite of the whole thing teaches nothing", () => {
    assert.deepEqual(lessons("ask the stack work team", "Let's talk tomorrow instead", lexicon, isCommon), []);
  });

  it("an undone pair is not learned again", () => {
    const undone = { ...lexicon, undone: [{ value: "p eight", written: "P8" }] };
    assert.deepEqual(lessons("send p eight now", "send P8 now", undone, isCommon), [nothing]);
  });
});

// Not in Peel's tests: edges the word list or a hand-added word can reach.
describe("lingo: edges", () => {
  const with_ = (...more: ReturnType<typeof entry>[]): Lexicon => ({ ...lexicon, entries: [...lexicon.entries, ...more] });

  it("a known word with a plural or possessive ending is left as it is", () => {
    assert.equal(rewrite("stakwork's team and stakworks", lexicon, everyday).text, "stakwork's team and stakworks");
    const k8s = with_(entry("e7", "Lingo", "Kubernetes", ["Kubernetes"]));
    assert.equal(rewrite("Kubernetes's pods", k8s, everyday).text, "Kubernetes's pods");
  });

  it("a one-letter form never takes over a lone letter", () => {
    const forms = with_(entry("e8", "Lingo", "C#", ["C#"]), entry("e9", "Lingo", "X", ["X"]));
    assert.equal(rewrite("take vitamin c daily, x marks it", forms, everyday).text, "take vitamin c daily, x marks it");
  });

  it("a mishearing with no letters matches nothing", () => {
    const amp = with_(entry("e10", "Organization", "Acme", ["Acme"], [["f10", "&"]]));
    assert.equal(rewrite("salt & pepper - fine", amp, everyday).text, "salt & pepper - fine");
  });

  it("a learn says why it cannot be written when the memory lacks the roles", () => {
    assert.throws(() => learnInput("p eight", "P8", { ...lexicon, lingoType: undefined }), /role dictation/);
    assert.throws(() => learnInput("bee see", "BTC", { ...lexicon, mishearing: undefined }), /role mishearing/);
  });

  it("marks belong to their letter", () => {
    const hindi = with_(entry("e11", "Lingo", "Hindi", ["Hindi"], [["f11", "हिंदी में"]]));
    assert.equal(rewrite("मैं हिंदी में बोलता", hindi, everyday).text, "मैं Hindi बोलता");
  });
});

describe("lingo: strut's memory steps", () => {
  /** memory/lexicon's output. */
  const reply = {
    lingo_type: "Lingo", mishearing: "heard_as",
    entities: [
      {
        ref_id: "e2", type: "Lingo", name: "Bitcoin", written: ["Bitcoin", "BTC"],
        heard: [
          { ref_id: "f2", value: "bee tee see", form: "BTC", created_at: "2026-10-23T14:02:11.000Z" },
          { ref_id: "f9", value: "bit coin", form: null, created_at: "2026-10-23T14:03:00.000Z" },
        ],
        dictation_off: false, facts: 4, updated_at: "2026-10-23T14:03:00.000Z", known_by_user: true,
      },
      { ref_id: "e5", type: "Lingo", name: "LSAT", written: ["LSAT"], heard: [], dictation_off: true, facts: 1 },
    ],
    undone: [{ ref_id: "f7", value: "el sat", form: null, entity: { ref_id: "e5", name: "LSAT" }, undone_at: "2026-10-23T14:05:00.000Z" }],
  };

  it("reads memory/lexicon's output", () => {
    const read = lexiconFrom(reply);
    assert.deepEqual(read.entries.map((e) => e.name), ["Bitcoin", "LSAT"]);
    assert.deepEqual(read.entries[0]!.written, ["Bitcoin", "BTC"]);
    assert.deepEqual(read.entries[0]!.heard, [{ refId: "f2", value: "bee tee see", form: "BTC" }, { refId: "f9", value: "bit coin", form: null }]);
    assert.equal(read.entries[1]!.dictationOff, true);
    assert.deepEqual(read.undone, [{ value: "el sat", written: "LSAT" }]);
    assert.equal(read.lingoType, "Lingo");
    assert.equal(read.mishearing, "heard_as");
    assert.equal(rewrite("a bit coin", read, isCommon).text, "a Bitcoin");
  });

  it("a learn says only the pair, on the right entity", () => {
    // A known name: on its entity, with the alias as its form.
    const alias = learnInput("bee see", "BTC", lexicon) as any;
    assert.equal(alias.episode, "Dictation: corrected “bee see” to “BTC”.");
    assert.equal(alias.kind, "note");
    assert.equal(alias.created_by, "dictation");
    const fact = alias.facts[0];
    assert.deepEqual(fact.subject, { ref_id: "e2", type: "Lingo", name: "Bitcoin" });
    assert.equal(fact.predicate, "heard_as");
    assert.equal(fact.value, "bee see");
    assert.equal(fact.form, "BTC");
    // An unknown word: a new Lingo, no form.
    const made = learnInput("p eight", "P8", lexicon) as any;
    assert.deepEqual(made.facts[0].subject, { type: "Lingo", name: "P8" });
    assert.equal("form" in made.facts[0], false);
  });

  it("undo forgets what the learn made", () => {
    assert.deepEqual(undoIds({ entities: [{ ref_id: "e9", status: "created" }], facts: [{ ref_id: "f9", status: "created" }] }), ["e9"]);
    assert.deepEqual(undoIds({ entities: [{ ref_id: "e1", status: "matched" }], facts: [{ ref_id: "f9", status: "created" }] }), ["f9"]);
    assert.deepEqual(undoIds({ entities: [{ ref_id: "e1", status: "matched" }], facts: [{ ref_id: "f1", status: "existing" }] }), []);
  });
});

describe("lingo: everyday words", () => {
  it("knows everyday English, and no single letter but a and i", () => {
    for (const w of ["the", "network", "stadium", "colour", "color", "don't", "don’t", "a", "i"]) assert.equal(everyday(w), true, w);
    for (const w of ["stakwork", "bitcoin", "hivemind", "github", "b", "p", "kpi", ""]) assert.equal(everyday(w), false, w);
  });
});
