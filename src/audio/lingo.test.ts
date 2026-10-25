import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assess, fillers, heardOnly, learnInput, lexiconFrom, mishearings, questions, recall, retraction, rewrite, saidAlike, soundsAlike, undoIds,
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
 *  "word@sentence", `everyday` by word (unlisted: −5), `score` by sentence
 *  text (unlisted: −10), `retract` by text. Records what it was asked. */
function fake(o: { judge?: Record<string, number>; named?: Record<string, number>; everyday?: Record<string, number>; score?: Record<string, number>; retract?: Record<string, Retraction[]>; learnMargin?: number } = {}) {
  const asked = { judge: [] as JudgeQuestion[], named: [] as NameQuestion[], everyday: [] as string[], score: [] as ScoreSentence[], retract: [] as string[] };
  const fixer: Fixer = {
    id: "fake",
    learnMargin: o.learnMargin ?? 0,
    judge: async (qs) => (asked.judge.push(...qs), qs.map((q) => o.judge?.[`${q.from}→${q.to}`] ?? -5)),
    named: async (qs) => (asked.named.push(...qs), qs.map((q) => o.named?.[`${q.word}@${q.text}`] ?? -5)),
    everyday: async (ws) => (asked.everyday.push(...ws), ws.map((w) => o.everyday?.[w] ?? -5)),
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

  it("a person's full name is offered when a span's whole sound is within a quarter of the name's, however it is split", () => {
    const boss: Lexicon = { undone: [], personType: "Person", entries: [entry("p", "Person", "Paul Itoi", ["Paul Itoi"]), entry("m", "Person", "Mike", ["Mike"]), entry("a", "Person", "Paula", ["Paula"])] };
    const to = (text: string) => recall(text, boss).filter((c) => c.written === "Paul Itoi").map((c) => c.span);
    for (const [text, span] of [["My boss is called Paul Attoy.", "Paul Attoy"], ["Paul Latoy will review it", "Paul Latoy"], ["My boss is called Paula Toy.", "Paula Toy"],
      ["My boss is called Call itoy.", "Call itoy"], ["ask Call It Oy", "Call It Oy"], ["Paul Italy is my boss.", "Paul Italy"]]) {
      assert.deepEqual(to(text!), [span], text);
    }
    // Three sounds off of eight: Coolitoy, and Bill Itoi, a different person, are not offered.
    for (const text of ["I'll call Mark tomorrow.", "I bought a toy for Paul.", "Paula said hi.", "Let's call it a day.", "My son wants a toy.", "Send it to Coolitoy.", "Ask Bill Itoi about it."]) {
      assert.deepEqual(to(text), [], text);
    }
    // A one-word name stays strict: Mark is not offered for Mike.
    assert.deepEqual(recall("I'll call Mark tomorrow.", boss), []);
    // Only a person: the same name as a term is matched as before.
    const term: Lexicon = { ...boss, entries: [entry("t", "Lingo", "Paul Itoi", ["Paul Itoi"])] };
    assert.deepEqual(recall("My boss is called Call itoy.", term), []);
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

  it("a code dictation wrote a character off needs a margin: chemistry's PH reads a little likelier as P8", async () => {
    const p8: Lexicon = { undone: [], entries: [entry("p", "Lingo", "P8", ["P8"])] };
    assert.equal((await rewrite("The PH of the water is high.", p8, fake({ score: { "The P8 of the water is high.": -29.7, "The PH of the water is high.": -30 } }).fixer)).text, "The PH of the water is high.");
    assert.equal((await rewrite("send PH now", p8, fake({ score: { "Send P8 now": -14, "Send PH now": -20 } }).fixer)).text, "send P8 now");
    // Spelled out, it is no code of its own: no margin.
    assert.equal((await rewrite("send P H now", p8, fake({ score: { "Send P8 now": -19.5, "Send P H now": -20 } }).fixer)).text, "send P8 now");
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
    const { fixer } = fake({ judge: { "Stockwork→Stakwork": 3, "k p i→KPI": 0.5 } });
    assert.deepEqual(await mishearings("ask the Stockwork team about the k p i", "ask the Stakwork team about the KPI", lexicon, fixer), [
      { heard: "Stockwork", written: "Stakwork" }, { heard: "k p i", written: "KPI" },
    ]);
    const { fixer: wary } = fake({ judge: { "Stockwork→Stakwork": 3, "k p i→KPI": 0.5 }, learnMargin: 1 });
    assert.deepEqual(await mishearings("ask the Stockwork team about the k p i", "ask the Stakwork team about the KPI", lexicon, wary), [
      { heard: "Stockwork", written: "Stakwork" },
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
    const { fixer, asked } = fake({ named: { "Stadeum@a product called Stadeum": 6 }, everyday: { stadium: 20 } });
    assert.deepEqual(await mishearings("a product called Stadium", "a product called Stadeum", empty, fixer), [{ heard: "Stadium", written: "Stadeum" }]);
    // The user's word in its sentence; said the same, vowels included, so dictation's word is not asked about.
    assert.deepEqual([asked.named, asked.everyday], [[{ text: "a product called Stadeum", word: "Stadeum" }], []]);
    // Only the consonants alike: dictation's word is asked alone and in lower case, so its casing does not make it a
    // name; it is a name too, so a different person.
    const { fixer: jen, asked: aj } = fake({ named: { "Jen@ask Jen now": 6 }, everyday: { jon: -8 } });
    assert.deepEqual(await mishearings("ask jon now", "ask Jen now", empty, jen), []);
    assert.deepEqual(aj.everyday, ["jon"]);
    // The user's word is an everyday word: capitalised, not a name.
    const { fixer: cap } = fake({ named: { "Stadium@at the Stadium": -9 }, everyday: { stadium: 20 } });
    assert.deepEqual(await mishearings("at the stadium", "at the Stadium", empty, cap), []);
    // A code a digit off: learned as a term, with no mapping; dictation's code is not asked about.
    const { fixer: code, asked: a3 } = fake({ named: { "P8@send P8 now": 6 } });
    assert.deepEqual(await mishearings("send PH now", "send P8 now", empty, code), [{ heard: "PH", written: "P8", term: true }]);
    assert.deepEqual(a3.everyday, []);
    // A sentence's first letter, a different sound, or a judge's yes: not asked.
    const { fixer: none, asked: a2 } = fake({ judge: { "Stockwork→Stakwork": 3 } });
    await mishearings("peel the oranges", "Peel the oranges", empty, none);
    await mishearings("tell Mark the deck is ready", "tell Mike the deck is ready", empty, none);
    await mishearings("ask the Stockwork team", "ask the Stakwork team", empty, none);
    assert.deepEqual(a2.named, []);
  });

  it("a change said the same, vowels included, is learned when the user's word is a name; a different name never is", async () => {
    const empty: Lexicon = { undone: [], entries: [], lingoType: "Lingo", mishearing: "heard_as" };
    const { fixer, asked } = fake({ named: { "Paul Itoi@His name is Paul Itoi.": 3 } });
    assert.deepEqual(await mishearings("His name is Paul Etoy.", "His name is Paul Itoi.", empty, fixer), [{ heard: "Etoy", written: "Itoi", name: "Paul Itoi" }]);
    // A surname is asked as the full name it is part of; a word beginning the sentence is not part of it.
    assert.deepEqual(asked.named.map((q) => q.word), ["Paul Itoi"]);
    const { fixer: ask, asked: a2 } = fake();
    await mishearings("Ask Paul Etoy now.", "Ask Paul Itoi now.", empty, ask);
    assert.deepEqual(a2.named.map((q) => q.word), ["Paul Itoi"]);
    // Said the same: dictation's word is not asked about (the full name's words are).
    assert.deepEqual(asked.everyday, ["paul", "itoi"]);
    // Turned down by both: kept as pending, so the same fix again learns it.
    const { fixer: no } = fake();
    assert.deepEqual(await assess("His name is Paul Etoy.", "His name is Paul Itoi.", empty, no), { learned: [], pending: [{ heard: "Etoy", written: "Itoi", name: "Paul Itoi" }] });
    // A different name, or an ordinary word the user did not capitalise, is never pending.
    for (const [typed, edited] of [["tell Mark the deck is ready", "tell Mike the deck is ready"], ["ask jon now", "ask Jen now"], ["email Michael about it", "email Michelle about it"], ["I want to", "I want too"]]) {
      assert.deepEqual((await assess(typed!, edited!, empty, no)).pending, [], typed);
    }
    // Undone or turned off: not pending either.
    const undone: Lexicon = { ...empty, undone: [{ value: "Etoy", written: "Itoi" }] };
    assert.deepEqual(await assess("His name is Paul Etoy.", "His name is Paul Itoi.", undone, no), { learned: [], pending: [] });
  });

  it("the same sounds split another way are asked only whether the user's words are a name", async () => {
    const empty: Lexicon = { undone: [], entries: [], lingoType: "Lingo", mishearing: "heard_as" };
    const typed = "My boss is called Paula Toy and his wife is Nicky.", edited = "My boss is called Paul Itoi and his wife is Nikki.";
    const { fixer, asked } = fake({ judge: { "Nicky→Nikki": 4, "Paula Toy→Paul Itoi": 9 }, named: { "Paul Itoi@My boss is called Paul Itoi and his wife is Nicky.": 12 } });
    assert.deepEqual(await mishearings(typed, edited, empty, fixer), [{ heard: "Paula Toy", written: "Paul Itoi", name: "Paul Itoi" }, { heard: "Nicky", written: "Nikki" }]);
    assert.deepEqual(asked.judge.map((q) => q.from), ["Nicky"]);
    // An ordinary word: not learned, whatever the judge would say.
    const { fixer: yes } = fake({ judge: { "a cross→across": 9 }, named: { "across@we walked across the bridge": -19 } });
    assert.deepEqual(await mishearings("we walked a cross the bridge", "we walked across the bridge", empty, yes), []);
  });

  it("a change inside a capitalised full name keeps the name, when the model reads each word as only a name", async () => {
    const empty: Lexicon = { undone: [], entries: [], lingoType: "Lingo", mishearing: "heard_as", personType: "Person" };
    const yes = { judge: { "Etoy→Itoi": 4, "Stadium→Stadeum": 4 } };
    const learn = async (typed: string, edited: string, everyday: Record<string, number> = {}, lex = empty) => mishearings(typed, edited, lex, fake({ ...yes, everyday }).fixer);
    assert.deepEqual(await learn("My boss is called Paul Etoy.", "My boss is called Paul Itoi."), [{ heard: "Etoy", written: "Itoi", name: "Paul Itoi" }]);
    // A word beginning the sentence is part of it only when it too reads as a name.
    assert.deepEqual(await learn("Ask Paul Etoy about it.", "Ask Paul Itoi about it.", { ask: 20 }), [{ heard: "Etoy", written: "Itoi", name: "Paul Itoi" }]);
    assert.deepEqual(await learn("I sent Paul Etoy the deck.", "I sent Paul Itoi the deck."), [{ heard: "Etoy", written: "Itoi", name: "Paul Itoi" }]);
    // An everyday word beside it, punctuation between, or a word alone: no full name.
    assert.deepEqual(await learn("Deploy Stadium Cloud now.", "Deploy Stadeum Cloud now.", { deploy: 20, cloud: 20 }), [{ heard: "Stadium", written: "Stadeum" }]);
    assert.deepEqual(await learn("I met Paul, Etoy said.", "I met Paul, Itoi said."), [{ heard: "Etoy", written: "Itoi" }]);
    assert.deepEqual(await learn("I met Etoy today.", "I met Itoi today."), [{ heard: "Etoy", written: "Itoi" }]);
    // The user's own word must read as a name too.
    assert.deepEqual(await learn("My boss is called Paul Etoy.", "My boss is called Paul Itoi.", { itoi: 3 }), [{ heard: "Etoy", written: "Itoi" }]);
    // A name turned off for dictation keeps only the pair.
    const off: Lexicon = { ...empty, entries: [entry("p", "Person", "Paul Itoi", ["Paul Itoi"], [], true)] };
    assert.deepEqual(await learn("My boss is called Paul Etoy.", "My boss is called Paul Itoi.", {}, off), [{ heard: "Etoy", written: "Itoi" }]);
  });

  it("said the same, vowels included, is strict: the same name respelled, never a different one", () => {
    for (const [a, b] of [["Etoy", "Itoi"], ["Paula Toy", "Paul Itoi"], ["Katherine", "Kathryn"], ["Catherine", "Kathryn"], ["Sarah", "Sara"], ["Stackworth", "Stakwork"], ["Jon", "John"], ["Brian", "Bryan"], ["Nicky", "Nikki"]]) {
      assert.equal(saidAlike(a!, b!), true, `${a} / ${b}`);
    }
    for (const [a, b] of [["Mark", "Mike"], ["Jon", "Jen"], ["Tom", "Tim"], ["Michael", "Michelle"], ["Mike", "Mick"], ["Robert", "Roberta"], ["Christina", "Christine"], ["Louis", "Louise"], ["Dan", "Don"], ["their", "there"]]) {
      assert.equal(saidAlike(a!, b!), false, `${a} / ${b}`);
    }
  });

  it("asks each change alone: the typed text with only that change made", async () => {
    const empty: Lexicon = { undone: [], entries: [], lingoType: "Lingo", mishearing: "heard_as" };
    const { fixer, asked } = fake();
    await mishearings("I work for Stackworth and my wife is Catherine.", "I work for Stakwork and my wife is Kathryn.", empty, fixer);
    assert.deepEqual(asked.judge.map((q) => [q.from, q.to, q.edited, q.at]), [
      ["Stackworth", "Stakwork", "I work for Stakwork and my wife is Catherine.", 11],
      ["Catherine", "Kathryn", "I work for Stackworth and my wife is Kathryn.", 37],
    ]);
  });

  it("asks each change in its own sentence, with a neighbour when that is under four words", () => {
    const asked = (typed: string, edited: string) => questions(typed, edited, lexicon).map((q) => [q.typed, q.edited, q.at]);
    assert.deepEqual(asked("Long day. I work for Stackworth now. My wife is Catherine.", "Long day. I work for Stakwork now. My wife is Kathryn."), [
      ["I work for Stackworth now.", "I work for Stakwork now.", 11],
      ["My wife is Catherine.", "My wife is Kathryn.", 11],
    ]);
    assert.deepEqual(asked("We met today. Use stadium!", "We met today. Use Stadeum!"), [["We met today. Use stadium!", "We met today. Use Stadeum!", 18]]);
    assert.deepEqual(asked("Use stadium! We met today.", "Use Stadeum! We met today."), [["Use stadium! We met today.", "Use Stadeum! We met today.", 4]]);
  });

  it("an edit with nothing to ask asks nothing", async () => {
    const { fixer, asked } = fake();
    assert.deepEqual(await mishearings("same text", "same text", lexicon, fixer), []);
    assert.deepEqual(asked.judge, []);
  });

  it("sounding alike is lenient: split, run together, spelled out, misspelt, another first vowel; not a different word", () => {
    for (const [a, b] of [["stack work", "Stakwork"], ["p eight", "P8"], ["k p i", "KPI"], ["Stockwork", "Stakwork"], ["cooper netties", "Kubernetes"], ["Etoy", "Itoi"], ["Ellen", "Allen"], ["Ian", "Ean"]]) {
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
    assert.equal(lexiconFrom({ ...reply, person_type: "Person" }).personType, "Person");
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

  it("a learn inside a full name is kept on that person: made when nothing writes the name, else on the entity that does", () => {
    const people: Lexicon = { ...lexicon, personType: "Person" };
    const made = learnInput("Etoy", "Itoi", people, false, "Paul Itoi") as any;
    assert.equal(made.episode, "Dictation: corrected “Etoy” to “Itoi” in Paul Itoi.");
    assert.deepEqual(made.facts, [{ subject: { type: "Person", name: "Paul Itoi" }, predicate: "heard_as", text: "Dictation hears Itoi as “Etoy”.", value: "Etoy", form: "Itoi" }]);
    assert.equal("mentions" in made, false);
    // The whole name respelled: the name itself, no form.
    assert.equal("form" in (learnInput("Paula Toy", "Paul Itoi", people, false, "Paul Itoi") as any).facts[0], false);
    // A person the memory knows by that name: attached, never a second one.
    const known: Lexicon = { ...people, entries: [...people.entries, entry("p1", "Person", "Paul Itoi", ["Paul Itoi"])] };
    assert.deepEqual((learnInput("Atoy", "Itoi", known, false, "Paul Itoi") as any).facts[0].subject, { ref_id: "p1", type: "Person", name: "Paul Itoi" });
    // No person type: a word of dictation's own.
    assert.deepEqual((learnInput("Etoy", "Itoi", lexicon, false, "Paul Itoi") as any).facts[0].subject, { type: "Lingo", name: "Paul Itoi" });
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
