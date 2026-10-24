import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fillers, heardOnly, learnInput, lexiconFrom, mishearings, questions, recall, retraction, rewrite, soundsAlike, undoIds,
  type Fixer, type JudgeQuestion, type Lexicon, type NameQuestion, type Retraction, type ScoreSentence,
} from "./lingo.js";

// Dictation's vocabulary pipeline with a fake fixer: the model's scores are
// injected, so what is tested is what code does with them — what is asked,
// what is kept, where an edit lands. The real model is the eval's
// (src/audio/dictation-eval, `npm run eval:dictation`).

const entry = (refId: string, type: string, name: string, written: string[], heard: [string, string, string?][] = [], dictationOff = false) => ({
  refId, type, name, written, dictationOff, facts: heard.length, heard: heard.map(([id, value, form]) => ({ refId: id, value, form: form ?? null })),
});

const lexicon: Lexicon = {
  lingoType: "Lingo",
  mishearing: "heard_as",
  undone: [{ value: "k p eye", written: "KPI" }],
  entries: [
    entry("e1", "Organization", "Stakwork", ["Stakwork"], [["f1", "stack work"]]),
    entry("e2", "Lingo", "Bitcoin", ["Bitcoin", "BTC"], [["f2", "bee tee see", "BTC"]]),
    entry("e3", "Project", "Sphinx", ["Sphinx"], [["f3", "fix"]]),
    entry("e4", "Project", "Peel", ["Peel"]),
    entry("e5", "Lingo", "LSAT", ["LSAT"], [["f5", "el sat"]], true),
  ],
};

/** A fixer whose scores are given: `judge` by "from→to", `named` by
 *  "word@sentence" (unlisted: −5), `score` by sentence text (unlisted: −10),
 *  `retract` by text. Records what it was asked. */
function fake(o: { judge?: Record<string, number>; named?: Record<string, number>; score?: Record<string, number>; retract?: Record<string, Retraction[]>; learnMargin?: number } = {}) {
  const asked = { judge: [] as JudgeQuestion[], named: [] as NameQuestion[], score: [] as ScoreSentence[], retract: [] as string[] };
  const fixer: Fixer = {
    id: "fake",
    learnMargin: o.learnMargin ?? 0,
    judge: async (qs) => (asked.judge.push(...qs), qs.map((q) => o.judge?.[`${q.from}→${q.to}`] ?? -5)),
    named: async (qs) => (asked.named.push(...qs), qs.map((q) => o.named?.[`${q.word}@${q.text}`] ?? -5)),
    score: async (ss) => (asked.score.push(...ss), ss.map((s) => o.score?.[s.text] ?? -10)),
    retract: async (text) => (asked.retract.push(text), o.retract?.[text] ?? []),
  };
  return { fixer, asked };
}

describe("lingo: recall", () => {
  const spans = (text: string, lex = lexicon) => recall(text, lex).map((c) => `${c.span}@${c.at}→${c.written}${c.heardBefore ? "!" : ""}`);

  it("finds a past mishearing exactly, the same letters, and a near spelling", () => {
    assert.deepEqual(spans("ask the stack work team"), ["stack work@8→Stakwork!"]);
    assert.deepEqual(spans("I work for stackwork"), ["stackwork@11→Stakwork"]);
    assert.deepEqual(spans("I work for Stockwork"), ["Stockwork@11→Stakwork"]);
    assert.deepEqual(spans("send it in bee tee see"), ["bee tee see@11→BTC!"]);
  });

  it("an exact past mishearing beats the same letters, which beats a near match; then the shortest span", () => {
    const lex: Lexicon = { undone: [], entries: [entry("a", "Lingo", "HiveMind", ["HiveMind"], [["h", "hive mind"]])] };
    // "hive mind" (heard before) wins over "the hive mind" and "hive mind is" for the same word.
    assert.deepEqual(spans("the hive mind is down", lex), ["hive mind@4→HiveMind!"]);
  });

  it("never across punctuation, never a word turned off, never what is already right", () => {
    assert.deepEqual(spans("We need a stack. Work starts"), []);
    assert.deepEqual(spans("the el sat token"), []);
    assert.deepEqual(spans("Stakwork ships Peel"), []);
    // A written form with a plural or possessive ending is that word, already right.
    assert.deepEqual(spans("Stakwork's team and the stakworks"), []);
  });

  it("a term with no mishearing is found by its sounds, and a code by a letter for a digit", () => {
    const p8: Lexicon = { undone: [], entries: [entry("p", "Lingo", "P8", ["P8"])] };
    assert.deepEqual(spans("send PH now", p8), ["PH@5→P8"]);
    assert.deepEqual(spans("ship P H by Friday", p8), ["P H@5→P8"]);
    assert.deepEqual(spans("the pH of the water", p8), ["pH@4→P8"]);
    assert.deepEqual(spans("send p eight now", p8), ["p eight@5→P8"]);
    assert.deepEqual(spans("send P 8 now", p8), ["P 8@5→P8"]);
    // Two letters apart, or an everyday word: not a candidate.
    const kpi: Lexicon = { undone: [], entries: [entry("k", "Lingo", "KPI", ["KPI"])] };
    assert.deepEqual(spans("The API is slow", kpi), []);
    assert.deepEqual(spans("go to an office", { undone: [], entries: [entry("a", "Lingo", "A6", ["A6"])] }), []);
  });

  it("a repeated word is a candidate at each place it occurs", () => {
    assert.deepEqual(spans("can you fix the fix integration"), ["fix@8→Sphinx!", "fix@16→Sphinx!"]);
  });
});

describe("lingo: the rewrite, with the fixer", () => {
  it("keeps a candidate only when the sentence reads likelier with the word", async () => {
    const { fixer } = fake({ score: { "Ask the Stakwork team.": -20, "Ask the stack work team.": -30, "Ask the Stack Work team.": -28 } });
    assert.deepEqual(await rewrite("Ask the stack work team.", lexicon, fixer), {
      text: "Ask the Stakwork team.", changes: [{ heard: "stack work", written: "Stakwork", at: 8 }],
    });
    const { fixer: unsure } = fake({ score: { "Ask the Stakwork team.": -20, "Ask the stack work team.": -30, "Ask the Stack Work team.": -19 } });
    assert.deepEqual(await rewrite("Ask the stack work team.", lexicon, unsure), { text: "Ask the stack work team.", changes: [] });
  });

  it("an everyday word that sounds just like the word needs a margin: the scoring line names the word, and favours it", async () => {
    const stadeum: Lexicon = { undone: [], entries: [entry("s", "Lingo", "Stadeum", ["Stadeum"], [["h", "stadium"]])] };
    const reads = (vocab: number) => fake({ score: { "Open it in Stadeum": vocab, "Open it in stadium": -30, "Open it in Stadium": -31 } }).fixer;
    assert.equal((await rewrite("open it in stadium", stadeum, reads(-24))).text, "open it in Stadeum");
    assert.equal((await rewrite("open it in stadium", stadeum, reads(-26))).text, "open it in stadium");
    // A name dictation capitalised is not an everyday word: no margin.
    const kathryn: Lexicon = { undone: [], entries: [entry("k", "Person", "Kathryn", ["Kathryn"], [["h", "Katherine"]])] };
    const { fixer } = fake({ score: { "Kathryn said yes": -20, "Katherine said yes": -21 } });
    assert.equal((await rewrite("Katherine said yes", kathryn, fixer)).text, "Kathryn said yes");
  });

  it("scores both readings from a capital, and a sound-alike also in its own capitals, after the word's line", async () => {
    const { fixer, asked } = fake();
    await rewrite("ask the stack work team", lexicon, fixer);
    assert.deepEqual(asked.score, [
      { name: "Stakwork", type: "Organization", text: "Ask the Stakwork team" },
      { name: "Stakwork", type: "Organization", text: "Ask the stack work team" },
      { name: "Stakwork", type: "Organization", text: "Ask the Stack Work team" },
    ]);
    // The same letters: no capitals reading, it would be the word itself.
    const { fixer: f2, asked: a2 } = fake();
    await rewrite("peel it", lexicon, f2);
    assert.deepEqual(a2.score.map((s) => s.text), ["Peel it", "Peel it"]);
  });

  it("an edit lands where its word is: one fix stays, the other is Sphinx", async () => {
    const { fixer } = fake({ score: { "Can you Sphinx the fix integration": -40, "Can you fix the Sphinx integration": -20, "Can you fix the fix integration": -30, "Can you fix the Fix integration": -35 } });
    assert.deepEqual(await rewrite("can you fix the fix integration", lexicon, fixer), {
      text: "can you fix the Sphinx integration", changes: [{ heard: "fix", written: "Sphinx", at: 16 }],
    });
  });

  it("removes fillers and doubled words by rule, and asks nothing for them", async () => {
    const { fixer, asked } = fake();
    assert.equal((await rewrite("um so the deploy is uh done", lexicon, fixer)).text, "So the deploy is done");
    assert.equal((await rewrite("The API is, um, really slow today.", lexicon, fixer)).text, "The API is really slow today.");
    assert.equal((await rewrite("I I think the the build", lexicon, fixer)).text, "I think the build");
    assert.deepEqual(asked.retract, []);
  });

  it("removes a phrase taken back when the model names it right before its cue", async () => {
    const text = "let's meet on Tuesday, no, Wednesday";
    const { fixer, asked } = fake({ retract: { [text]: [{ wrong: "Tuesday", cue: "no" }] } });
    assert.deepEqual(await rewrite(text, lexicon, fixer), { text: "let's meet on Wednesday", changes: [{ heard: "Tuesday, no,", written: "", at: 14 }] });
    assert.deepEqual(asked.retract, [text]);
    // Not before its cue, or not in the text: nothing removed.
    const { fixer: wrong } = fake({ retract: { [text]: [{ wrong: "meet", cue: "no" }, { wrong: "Friday", cue: "no" }] } });
    assert.equal((await rewrite(text, lexicon, wrong)).text, text);
  });

  it("with nothing to ask, the text goes out untouched, spacing and all", async () => {
    const { fixer, asked } = fake();
    assert.deepEqual(await rewrite("  nothing  here ", lexicon, fixer), { text: "  nothing  here ", changes: [] });
    assert.deepEqual([asked.score, asked.retract], [[], []]);
  });
});

describe("lingo: fillers and take-backs", () => {
  it("a filler set off by commas takes both with it", () => {
    assert.deepEqual(fillers("we should, uh, move"), [{ from: ", uh,", to: "", at: 9 }]);
    assert.equal(heardOnly("we should, uh, move", lexicon).text, "we should move");
    assert.equal(heardOnly("we should, uh move", lexicon).text, "we should move");
    assert.equal(heardOnly("Um, we should move", lexicon).text, "We should move");
    assert.equal(heardOnly("so, the plan, um.", lexicon).text, "so, the plan.");
    assert.equal(heardOnly("that is the plan uh.", lexicon).text, "that is the plan.");
  });

  it("a removal that began a sentence capitalises the word that now begins it", () => {
    assert.equal(heardOnly("team? Um, about the release", lexicon).text, "team? About the release");
    assert.equal(heardOnly("Done. uh the next one! um, so", lexicon).text, "Done. The next one! So");
    assert.equal(heardOnly("um about it", lexicon).text, "About it");
    // A doubled word at a sentence's start too.
    assert.equal(heardOnly("Ready. the the plan", lexicon).text, "Ready. The plan");
    // Mid-sentence, the next word keeps its case; a word already cased or not a word is left.
    assert.equal(heardOnly("the team, um, about the release", lexicon).text, "the team about the release");
    assert.equal(heardOnly("Um, iPhone sales", lexicon).text, "iPhone sales");
    assert.equal(heardOnly("Um, 3 things", lexicon).text, "3 things");
  });

  it("fillers in a row all go", () => {
    assert.equal(heardOnly("Um, uh, about the release", lexicon).text, "About the release");
    assert.equal(heardOnly("so, um, uh, the plan", lexicon).text, "so the plan");
  });

  it("keeps a word a speaker can mean twice", () => {
    assert.deepEqual(fillers("I know that that is right and she had had enough"), []);
    assert.deepEqual(fillers("we we go"), [{ from: "we", to: "", at: 0 }]);
    // Not across punctuation: "No. No." is two sentences.
    assert.deepEqual(fillers("Go. Go now"), []);
  });

  it("a take-back spans the wrong words through the cue and its punctuation", () => {
    assert.deepEqual(retraction("the meeting is at three, I mean four", "three", "I mean"), { from: "three, I mean", to: "", at: 18 });
    assert.equal(retraction("three cats, I mean four", "three", "I mean"), null);
    assert.equal(retraction("call me", "", "no"), null);
  });
});

describe("lingo: with no fixer", () => {
  it("applies exact learned mishearings of two or more words only, longest first, never across punctuation or for a word turned off", () => {
    assert.deepEqual(heardOnly("Ask the stack work team, in bee tee see.", lexicon), {
      text: "Ask the Stakwork team, in BTC.",
      changes: [{ heard: "stack work", written: "Stakwork", at: 8 }, { heard: "bee tee see", written: "BTC", at: 28 }],
    });
    assert.equal(heardOnly("I work for stackwork", lexicon).text, "I work for stackwork");
    assert.equal(heardOnly("We need a stack. Work starts", lexicon).text, "We need a stack. Work starts");
    assert.equal(heardOnly("the el sat token", lexicon).text, "the el sat token");
    assert.deepEqual(heardOnly("  nothing  here ", lexicon), { text: "  nothing  here ", changes: [] });
  });

  it("leaves a one-word mishearing as heard: only the fixer can tell it from the everyday word", () => {
    assert.deepEqual(heardOnly("can you fix the build", lexicon), { text: "can you fix the build", changes: [] });
  });

  it("still removes fillers and doubled words", () => {
    assert.deepEqual(heardOnly("um so the the stack work deploy", lexicon), {
      text: "So the Stakwork deploy",
      changes: [{ heard: "um", written: "", at: 0 }, { heard: "the", written: "", at: 6 }, { heard: "stack work", written: "Stakwork", at: 14 }],
    });
  });

  it("a mishearing with no letters matches nothing", () => {
    const amp: Lexicon = { undone: [], entries: [entry("a", "Organization", "Acme", ["Acme"], [["f", "&"]])] };
    assert.equal(heardOnly("salt & pepper", amp).text, "salt & pepper");
  });

  it("marks belong to their letter", () => {
    const hindi: Lexicon = { undone: [], entries: [entry("h", "Lingo", "Hindi", ["Hindi"], [["f", "हिंदी में"]])] };
    assert.equal(heardOnly("मैं हिंदी में बोलता", hindi).text, "मैं Hindi बोलता");
  });
});

describe("lingo: learning from an edit", () => {
  it("asks only short changes that sound alike, with what the vocabulary knows of them", () => {
    const asked = (typed: string, edited: string) => questions(typed, edited, lexicon).map((q) => `${q.from}→${q.to}${q.known ? ` [${q.known}]` : ""}`);
    assert.deepEqual(asked("send p eight now", "send P8 now"), ["p eight→P8"]);
    assert.deepEqual(asked("send BTC now", "send Bitcoin now"), ["BTC→Bitcoin [Bitcoin, BTC (same thing)]"]);
    assert.deepEqual(asked("the el sat token", "the LSAT token"), ["el sat→LSAT [LSAT (turned off for dictation)]"]);
    // A changed mind, a cut, an addition, a rewrite: not asked.
    assert.deepEqual(asked("ask the meeting team", "ask the Stakwork team"), []);
    assert.deepEqual(asked("ask the team about it", "ask the team"), []);
    assert.deepEqual(asked("ask the stack work team", "Let's talk tomorrow instead, as we agreed"), []);
  });

  it("learns what the fixer says yes to, by more than its margin", async () => {
    const { fixer } = fake({ judge: { "stack work→Stakwork": 3, "k p i→KPI": 0.5 } });
    assert.deepEqual(await mishearings("ask the stack work team about the k p i", "ask the Stakwork team about the KPI", lexicon, fixer), [
      { heard: "stack work", written: "Stakwork" }, { heard: "k p i", written: "KPI" },
    ]);
    const { fixer: wary } = fake({ judge: { "stack work→Stakwork": 3, "k p i→KPI": 0.5 }, learnMargin: 1 });
    assert.deepEqual(await mishearings("ask the stack work team about the k p i", "ask the Stakwork team about the KPI", lexicon, wary), [
      { heard: "stack work", written: "Stakwork" },
    ]);
  });

  it("never a pair the user undid, nor a word turned off, whatever the fixer says", async () => {
    const { fixer } = fake({ judge: { "k p eye→KPI": 9, "el sat→LSAT": 9 } });
    assert.deepEqual(await mishearings("the k p eye number", "the KPI number", lexicon, fixer), []);
    assert.deepEqual(await mishearings("the el sat token", "the LSAT token", lexicon, fixer), []);
  });

  it("never dictation's text when it is already a vocabulary word: two forms of one thing, or a word of its own", async () => {
    const { fixer } = fake({ judge: { "BTC→Bitcoin": 9, "Peel→P8": 9 } });
    assert.deepEqual(await mishearings("send BTC now", "send Bitcoin now", lexicon, fixer), []);
    assert.deepEqual(await mishearings("send Peel now", "send P8 now", lexicon, fixer), []);
  });

  it("a same-sounding change the judge turns down is learned when the user's word is a name and dictation's an everyday word", async () => {
    const empty: Lexicon = { undone: [], entries: [], lingoType: "Lingo", mishearing: "heard_as" };
    const { fixer, asked } = fake({ named: { "Stadeum@Let's open it in Stadeum": 6, "stadium@Let's open it in stadium": -9 } });
    assert.deepEqual(await mishearings("Let's open it in stadium", "Let's open it in Stadeum", empty, fixer), [{ heard: "stadium", written: "Stadeum" }]);
    assert.deepEqual(asked.named, [{ text: "Let's open it in Stadeum", word: "Stadeum" }, { text: "Let's open it in stadium", word: "stadium" }]);
    // Dictation's word is a name too: a different person.
    const { fixer: jen } = fake({ named: { "Jen@ask Jen now": 6, "jon@ask jon now": 1 } });
    assert.deepEqual(await mishearings("ask jon now", "ask Jen now", empty, jen), []);
    // The user's word is an everyday word: capitalised, not a name.
    const { fixer: cap } = fake({ named: { "Stadium@at the Stadium": -9, "stadium@at the stadium": -9 } });
    assert.deepEqual(await mishearings("at the stadium", "at the Stadium", empty, cap), []);
    // A code a digit off: learned as a term, with no mapping; dictation's code need not be an everyday word.
    const { fixer: code } = fake({ named: { "P8@send P8 now": 6, "PH@send PH now": 8 } });
    assert.deepEqual(await mishearings("send PH now", "send P8 now", empty, code), [{ heard: "PH", written: "P8", term: true }]);
    // A sentence's first letter, a different sound, or a judge's yes: not asked.
    const { fixer: none, asked: a2 } = fake({ judge: { "stack work→Stakwork": 3 } });
    await mishearings("peel the oranges", "Peel the oranges", empty, none);
    await mishearings("tell Mark the deck is ready", "tell Mike the deck is ready", empty, none);
    await mishearings("ask the stack work team", "ask the Stakwork team", empty, none);
    assert.deepEqual(a2.named, []);
  });

  it("an edit with nothing to ask asks nothing", async () => {
    const { fixer, asked } = fake();
    assert.deepEqual(await mishearings("same text", "same text", lexicon, fixer), []);
    assert.deepEqual(asked.judge, []);
  });

  it("sounding alike is lenient: split, run together, spelled out, misspelt; not a different word", () => {
    for (const [a, b] of [["stack work", "Stakwork"], ["p eight", "P8"], ["k p i", "KPI"], ["Stockwork", "Stakwork"], ["cooper netties", "Kubernetes"]]) {
      assert.equal(soundsAlike(a!, b!), true, `${a} / ${b}`);
    }
    for (const [a, b] of [["meeting", "Stakwork"], ["stadium", "Stakwork"]]) assert.equal(soundsAlike(a!, b!), false, `${a} / ${b}`);
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
    assert.equal(heardOnly("a bit coin", read).text, "a Bitcoin");
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

  it("a term learn makes the new word alone, and nothing when the vocabulary writes it", () => {
    assert.deepEqual(learnInput("PH", "P8", lexicon, true), {
      episode: "Dictation: corrected “PH” to “P8”.", kind: "note", created_by: "dictation", mentions: [{ type: "Lingo", name: "P8" }],
    });
    assert.equal(learnInput("PH", "Peel", lexicon, true), null);
  });

  it("a learn says why it cannot be written when the memory lacks the roles", () => {
    assert.throws(() => learnInput("p eight", "P8", { ...lexicon, lingoType: undefined }), /role dictation/);
    assert.throws(() => learnInput("bee see", "BTC", { ...lexicon, mishearing: undefined }), /role mishearing/);
  });

  it("undo forgets what the learn made", () => {
    assert.deepEqual(undoIds({ entities: [{ ref_id: "e9", status: "created" }], facts: [{ ref_id: "f9", status: "created" }] }), ["e9"]);
    assert.deepEqual(undoIds({ entities: [{ ref_id: "e1", status: "matched" }], facts: [{ ref_id: "f9", status: "created" }] }), ["f9"]);
    assert.deepEqual(undoIds({ entities: [{ ref_id: "e1", status: "matched" }], facts: [{ ref_id: "f1", status: "existing" }] }), []);
  });
});
