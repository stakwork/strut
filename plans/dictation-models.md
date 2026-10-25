# Dictation with models the user picks

> Status (2026-10-23): phases 1–3 built, in #301 (`feat/dictation-lingo`),
> which also carries the model catalog (phase 2, merged in from
> `feat/dictation-models`): the catalog ships with the fixer that uses it.
> The hand rules of #301 (`lingo.ts`'s `lessons` and `Words`, the 51k-word
> `words-en.ts`, `common-words.ts`) are gone; a small local model scores
> edits and the vocabulary in context. Phase 4 (Peel) is next. The client
> contract is `plans/native-dictation-client.md` §7a. 2026-10-24: names
> respelled with another first vowel, re-split into a name, or fixed again
> are learned ("Names respelled, re-split, or fixed again").

## Why

#301 first decided, at the moment of an edit and with no context, whether
the edit was a mishearing. That needed rules (P8/PH, Jon/Jen, "i"/"I",
everyday words) and an everyday-word list, and every new case needed another
rule. A model reading the sentence decides this the way a person would, and
the same model can decide whether a learned fix applies to a new sentence.
Nothing else in the field (Wispr Flow, VoiceInk, Handy) uses rules for this.

## What the user sees

Speak; fix a word in what was typed; the HUD says "Learned Stakwork" with
Undo; the word is in the Vocabulary; next time it comes out right. Fillers
("um", "uh"), a word said twice and a phrase taken back ("Tuesday, no,
Wednesday") are gone from what is typed. New: a Dictation setting to pick
the models, each with its size, Download and Remove. One architecture for
every pick; the picks differ in size, speed and accuracy.

## The pipeline (src/audio/lingo.ts)

**The model scores; it never writes text.** Code finds every span and builds
every edit; the model only answers how likely something is.

1. **Speech** (`/audio/transcribe`): the selected speech model (Kroko, or
   Parakeet TDT 0.6B v2 offline).
2. **Recall** (`recall`, pure): 1–3-word spans of the transcript, never
   across punctuation, matched against every entry's `heard` values and
   `written` forms (not an entry turned off): an exact past mishearing beats
   the same letters or sounds, which beats a near spelling or a code a digit
   off ("PH" or "P H" for a term P8; a letter for a digit only, so "API" is
   not "KPI"); where one word's spans overlap, the better match, then the
   shortest. A person's full name of two or more words is also offered for
   a span whose whole sound is within a quarter of the name's, however it
   is split ("Call itoy" for Paul Itoi; see "The full name, kept and
   recalled"). At most 8.
   It finds; it never decides.
3. **Fix** (`rewrite`, with the selected fixer):
   - Each candidate: the log-likelihood of the sentence with the vocabulary
     form against the sentence as heard, after the line "Dictated by someone
     who often mentions X (a <type>)". Both readings start with a capital (so
     "Peel the oranges" is no evidence for Peel), and a sound-alike is also
     read in its own title case (so "tory" in lower case is no evidence for
     Tauri). Kept when the vocabulary reading is likelier; of two claiming
     one span, the likelier. When the heard text is an everyday word that
     sounds just like the vocabulary form (lower case, spelled otherwise,
     the same sound key: "stadium" for Stadeum, "tory" for Tauri), it must
     be likelier by `SAME_SOUND_MARGIN` (5 nats): see "Real words as names".
   - Fillers and a word said twice in a row: removed by rule, with an
     exception list ("that that", "had had", "very very", …). A removal
     that began a sentence capitalises the word now beginning it ("team?
     Um, about" → "team? About").
   - Dictated text and vocabulary names go into the prompts as text, never
     as special tokens (`<|im_end|>` in a transcript is those characters).
   - A phrase taken back: only when a cue word appears ("no", "sorry", "I
     mean", "actually", "wait", …), a narrow prompt answers `{ wrong, cue }`;
     code removes from `wrong` through the cue, and only when the cue follows
     `wrong` with nothing but punctuation between.
   - Edits carry their offset (`{ from, to, at }`): `{ from, to }` alone is
     ambiguous when a word repeats ("can you fix the fix integration").
4. **No fixer, or no answer within 1.5 s** (`heardOnly`): fillers and
   doubled words are removed by the same rule, and exact learned `heard`
   values of two or more words are applied, as whole words, longest first;
   nothing else. A one-word mishearing ("fix" taught for Sphinx) is an
   everyday word elsewhere, so it waits for the fixer's check in context.
   `fixer` in the reply is null. A cold model starts loading on that call,
   so the next transcript gets it.
5. **Learn** (`mishearings`, the `dictation/correction` step): the edit is
   diffed word by word in code. A change with more than 4 words on a side,
   or a cut or an addition, or one that fails a lenient sound-alike gate
   (`soundsAlike`: letters, a consonant sound key, or the spelled-out sounds
   within 40%, a different first vowel counting for nothing: Etoy / Itoi),
   is not asked. A person's name respelled the way the user
   spells it (Katherine → Kathryn, Jon → John, Steven → Stephen) is the same
   spoken name and is learned; a different name (Mark → Mike, Jon → Jen) is
   not. The rewrite needs nothing special for such a name: after "often
   mentions Kathryn (a person)" the learned spelling outscores the commoner
   one by 1.6 to 8 nats, and a full name already in the graph ("Kathryn
   O'Brien", nothing learned) is recalled and chosen the same way. A first
   name alone ("Katherine said yes") is not matched to a graph's full name,
   and a different name ("Kate O'Brien") is not recalled for it. Each remaining change is asked yes/no on its
   own, in its own sentence (and the one before it, or after it, when it has
   under four words): the typed sentence and the same with only that change
   made. With the edit's other changes in it, "Catherine" → "Kathryn" read as
   part of a rewrite and was turned down; and a long dictation stays a short
   prompt, so a voice dump of several hundred words stays inside the 4k
   context at the same speed (two fixes far apart in 407 words: 199 ms). Also
   asked: what the vocabulary knows of the words ("Bitcoin, BTC (same
   thing)", "(turned off for dictation)"); P(yes) and P(no) come from one
   forward pass, and it is learned when yes outweighs no by the model's
   margin (0 for the 1.7B, 1 nat for the 0.6B, which leans yes). A
   same-sounding change the judge turns down is asked once more (`named`):
   learned when the user's word is a name in the edited sentence and
   dictation's is clearly an everyday word in the typed one, or is a code a
   digit off (see "Real words as names"). A change from a code of its own
   ("PH" → "P8") is learned as a term: the word, with no mapping. A name
   respelled with the same sounds, vowels included (Etoy → Itoi), or the same
   sounds split into words another way (Paula Toy → Paul Itoi), is learned
   when the model reads the user's words as a name; a fix the model turns
   down that is said the same is learned when the user makes it again (see
   "Names respelled, re-split, or fixed again"). A change inside a
   capitalised full name ("Paul Itoi") is kept on that person, made when
   nothing writes the name (see "The full name, kept and recalled"). The write
   path is #301's: undone pairs, words with dictation off, and a change from
   a form already in the vocabulary (two forms of one thing, or "PH" that is
   a word of its own) are never written, whatever the model says, and only
   the pair is stored, never the sentence. With no fixer active
   (`dictation/models`, `active`) nothing is learned and `learned` is empty,
   so a client sends no edits then (Add in the Vocabulary still works). The
   step waits up to 60 s for a cold model to load, then 1.5 s for the
   answer: the client sends an edit once, so a cold model should not lose it.

## Models and where they run

- **Runtime.** node-llama-cpp 3.22 (Metal on a Mac, GGUF), in a
  `ModelWorker` of its own (src/audio/fixer.ts; the worker runs
  src/audio/fixer-engine.ts, which imports only types from strut). Each task
  (judge, score, take-back) keeps its own sequence of one context, so its
  fixed prompt prefix (system prompt and shots) stays in the KV cache. Calls
  run one at a time. The model loads on the first call and unloads after 5
  minutes idle; a changed pick swaps it on the next call (a handle to the
  old model then refuses, rather than start a worker nobody unloads). A
  transcript whose rewrite missed the 1.5 s keeps the fixer out of the next
  ones until that rewrite is done (30 s at most), so a slow model never piles
  up calls. transformers.js
  (privacy's runtime) was measured in the spike and lost on speed.
- **Where node-llama-cpp is.** Not among strut's dependencies: in #301 it
  was one, and every Linux x64 install (CI, the published image, the mcp
  host on the swarms) got all four of its Linux builds, ~740 MB with CUDA
  and Vulkan. It is fixer/'s own (fixer/package.json + fixer/yarn.lock),
  staged at fixer/ by the desktop package alone; fixer-engine.ts types the
  part it calls and fixer/check.ts checks that against the real package in
  the desktop job. A strut without it lists no fixer, refuses to pick one
  and takes the no-fixer path.
- **Catalog** (src/audio/models.ts): like `STT_MODELS`, each entry has id,
  url, sha256, bytes, kind (`speech` | `fixer`), description, and what a
  picker shows (name, summary, recommended); a fixer also
  its learn margin. Fixers: `qwen3-1.7b-q4` (Qwen3 1.7B instruct, unsloth's
  Q4_K_M GGUF, 1.1 GB; the default to offer) and `qwen3-0.6b-q4` (0.4 GB,
  the small option). Speech: Kroko, Parakeet TDT 0.6B v2.
- **Selection and download** (steps, same for any client):
  - `dictation/models {}` → `{ models: [{ id, kind, name, summary,
    recommended, bytes, description, state: "available" | "downloading" |
    "installed", progress?, downloaded?, selected, active, removable,
    error? }] }`: `active` is what strut uses now (it trails `selected`
    while a pick downloads); `removable` is false for an active model and
    the default speech model, which `remove-model` refuses.
  - `dictation/use { speech?, fixer? }` (fixer may be `null`: none) → the
    same list. Selecting a model that is not installed starts its download;
    it is used once installed.
  - `dictation/remove-model { id }` → the same list.
  - `dictation/enable { ref_id, on }` → `{ ref_id, on }`: dictation off or on
    for one entity (the `dictation: "off"` attribute memory/lexicon reads),
    so clients never write that attribute themselves.
  Selection lives in `<dataDir>/audio/dictation.json`. Default: Kroko and no
  fixer: a 1.1 GB download is the user's choice, so "default fixer" means the
  one a client offers first. Models are never bundled with a client.
- **iOS / other clients** call the same steps and endpoints over the network.

Not watched yet (later): a fix to an earlier dictation in the same field
after a new one has started, and a fix made after the edit has settled and
been sent. The client sends one settled edit of one dictation; v1 learns
every fix in it.

## Real words as names

A product or name can share its sound with a real word: Stadeum (a play on
stadium), Peel, Hive. Dictation always writes the real word, and until
2026-10-24 nothing was learned when the user put it right: the judge read
"stadium" → "Stadeum" as a different word. Its prompt said no when
"dictation's text is itself something real the user could have meant", but
that sentence was not what decided it: without it the 1.7B still said no
(−3.6 and −7.6 nats on the two Stadeum cases), a sentence saying it is a
mishearing moved it no further, and a shot of one ("lift" → "Lyft",
"slack" → "Slack") made it say yes to Mark → Mike. So the veto sentence is
gone, the prompt is otherwise as it was, and the case has a question of its
own:

- **Learn.** A change the judge turns down that is the same spoken word
  (the same sound key, a casing change not at a sentence's start, or a code
  a digit off) is asked two more things. Of the user's word in its sentence
  (the typed text with that change alone): "is this word a name, product,
  brand, code or technical term here, or an ordinary word?" (`named`,
  `NAME_SYSTEM`). Of dictation's word alone and in lower case: "is it an
  everyday dictionary word, or only a name?" (`everyday`, `WORD_SYSTEM`),
  four shots each. Learned when the first is yes and the second yes by 2
  nats or more ("stadium", "peel", "hive" by 17 to 22; "jon", "michael",
  "catherine" read as names by 7 to 16, so "jon" → "Jen" is not learned), or
  without the second when either side is a code ("PH" → "P8", "p eight" →
  "P8"). Dictation's word was first asked in its sentence, but there its
  casing decided: "a product called Stadium" read as a name (1.8) and so was
  refused, and lower-cased in the sentence a real name lost it ("email
  michael about it" −9.2, so Michael → Michelle was learned). Only those
  changes pay for it, on the scoring sequence, so the judge's prompt stays
  cached: learn p95 351 ms (the two prompts take turns there).
- **What is kept.** A mapping, as before ("stadium" heard for Stadeum),
  except when dictation's text is a code of its own: "PH" → "P8" keeps P8 as
  a term with no mapping (`term`), and recall offers it for "PH", "P H",
  "p eight" and "P 8". A real pH is then never rewritten by rule.
- **Applying.** The rewrite decides each sentence, but the scoring line
  names the vocabulary word, which favours it: with Stadeum learned (a
  Lingo word), "we watched the game at the stadium" read 3.9 nats likelier
  as Stadeum and "the stadium was full" 1.8, so both were rewritten. "open it
  in stadium", "the stadium workspace" and "deploy to stadium" read 5.8 to
  7.5 likelier. For an everyday word that sounds just like the form, the
  vocabulary reading must win by 5 nats (`SAME_SOUND_MARGIN`); that also
  fixed "the tory party" (0.8). It does not apply to a name dictation
  capitalised (Katherine → Kathryn, 1.6) or to a sound-alike that is not the
  same sound ("fix" for Sphinx, 1.5 and 2.5, which the margin would lose). As
  an Organization the Stadeum margins are similar; as a Project "the stadium
  workspace" reads only 2.5, so it would be left as heard. A term P8: "send
  PH now" 6.6, "we ship PH by Friday" 6.1; "the pH of the water is high"
  −2.9 and "test the PH of the soil" −1.7 stay; "check the PH level" reads
  4.3 as P8 and would be rewritten for someone who uses P8.
- **Still open.** A casing alone (peel → Peel) is learned but not applied:
  "ship it in peel tonight" reads 0.8 nats likelier in lower case after
  "often mentions Peel", as "the peel build" did before.

## Names respelled, re-split, or fixed again

Found in Tom's live test, 2026-10-24 ("Paul Itoi" is his boss; nobody by that
name is in his graph):

1. "His name is Paul Etoy." → "Paul Itoi.": nothing was asked. The sound key
   keeps a word's first letter and drops the later vowels, so "etoy" was
   "et" and "itoi" "it", 1 of 2 apart, over the gate's 40%. The gate now also
   compares the keys with any first vowel the same (Etoy / Itoi, Ellen /
   Allen, Ian / Ean). It only gates what is asked; it decides nothing.
2. "My boss is called Paula Toy" → "Paul Itoi": the judge said no (−8.7):
   it reads Paula → Paul as two names, like Mark → Mike. It is the same
   sounds split another way ("paulatoi" / "paulitoi").
3. The same fix made three times (Etoy → Itoi) taught nothing.

**Said the same, vowels included** (`saidKey`, `saidAlike`, lingo.ts). The
sound key drops vowels, so Jon / Jen and Tom / Tim share one, and the gate
is lenient on purpose: Mark / Mike pass it. What decides "the same name
respelled" needs the vowels. `saidKey`, per word and then joined (spaces
count for nothing): a silent final e goes (after a consonant other than s,
in a word with two other vowel sounds: Katherine, not Mike, Anne, Louise); a
final ee, ea, ey, ie or y is "i", ee is "i" anywhere; a leading e, i or y
before a consonant is "i"; y is "i" but at a word's start or between vowels
(so oy is oi); ph is f, ck and c are k (c before e, i, y is s), q is k, x ks,
z s, gh silent; ch, sh, th are one sound each; an h after a vowel and not
before one is silent; a doubled letter is one. `saidAlike`: the same form,
or on a form of seven sounds or more, one edit apart with the same ending
(both end in the same vowel, or both in a consonant: Robert / Roberta,
Christina / Christine, Antonio / Antonia differ in a final vowel, which is
what makes two names of one root).

| pair | said as | the same |
|---|---|---|
| Etoy / Itoi | itoi / itoi | yes |
| Paula Toy / Paul Itoi | paulatoi / paulitoi | yes |
| Katherine / Kathryn | kaθerin / kaθrin | yes |
| Catherine / Katherine | kaθerin / kaθerin | yes |
| Sarah / Sara | sara / sara | yes |
| Stackworth / Stakwork | stakworθ / stakwork | yes |
| Jon / John | jon / jon | yes |
| Philip / Phillip | filip / filip | yes |
| Brian / Bryan | brian / brian | yes |
| Carl / Karl | karl / karl | yes |
| Lindsay / Lindsey | lindsai / lindsi | yes |
| Kristin / Kristen | kristin / kristen | yes |
| Nicky / Nikki | niki / niki | yes |
| Mary / Marie | mari / mari | yes |
| Caroline / Carolyn | karolin / karolin | yes |
| Mark / Mike | mark / mike | no |
| Jon / Jen | jon / jen | no |
| Tom / Tim | tom / tim | no |
| Michael / Michelle | miçael / miçel | no |
| Mike / Mick | mike / mik | no |
| Robert / Roberta | robert / roberta | no |
| Christina / Christine | çristina / çristin | no |
| Louis / Louise | louis / louise | no |
| Dennis / Denise | denis / denise | no |
| Aaron / Erin | aron / irin | no |
| Dan / Don | dan / don | no |
| Paul / Paula | paul / paula | no |
| Steven / Stephen | steven / stefen | no (the judge learns it) |
| Ellen / Allen | ilen / alen | no |
| their / there | θeir / θere | no |

Spelling is not sound, so some misses are kept on purpose (Steven /
Stephen, Ann / Anne): a miss leaves a pair to the judge, while a false match
could learn a different person. Stakwork's jarvis-backend matches names by
sound with Metaphone 3, vowels encoded and exact (`api/helper/metaphone3.py`);
that is an option for later. Measured here: with vowels encoded it writes
every vowel as A, so Jon / Jen, Tom / Tim, Dan / Don and Mike / Mick come out
the same, and it could not be this bar by itself.

**Learn.**

- *Said the same.* A change the judge turns down that `saidAlike` passes
  (not a casing alone, not a code) is asked the name question of the user's
  word in its sentence (`named`), and learned on a yes. Dictation's word is
  not asked about: the everyday check exists because the consonant key
  cannot tell Jon from Jen, and with the vowels kept a different name never
  gets this far. Etoy → Itoi: judge −6.7, named 3.3, learned. Changes only
  the consonant key matches go the old way, with the everyday check (Jon →
  Jen: named 0.0, everyday −7.8, not learned).
- *Re-split.* More than one word on a side, not one for one, and
  `saidAlike` over the joined words ("Paula Toy" / "Paul Itoi", "a cross" /
  "across"): not put to the judge, which reads it word by word and said yes
  to "a cross" → "across" (5.0) and no to Paula Toy (−8.7). Code names the
  change and the model decides: it is learned when the user's words are a
  name in the edited sentence ("Paul Itoi" 12.9; "across" −19.1, "maybe"
  −17.4). "a cross" → "across" is grammar, not a mishearing: learning it
  would rewrite a real "a cross", so it is a negative case.
- *Fixed again* (dictation/correction, `assess`'s `pending`,
  src/steps/lib/dictation/_pending.ts). A change both questions turn down
  that `saidAlike` passes, whose user's side has a capital not at a
  sentence's start (a name the user capitalised, so "to" → "too" or "a
  cross" → "across" made twice is never learned), is kept as the pair, a
  count and the time, never the sentence. The same pair made in a second
  edit within 30 days (dictation's side without case, the user's as
  written) is learned as usual and comes back in `learned` with its `undo`,
  so the HUD shows "Learned" with Undo; the reply's shape is unchanged. A
  pair counts once an edit. Pairs older than 30 days are dropped on the next
  write. Never kept: a pair outside `saidAlike` (Mark → Mike, Jon → Jen, at
  any count), a pair the user undid, a word turned off for dictation, a
  vocabulary word on dictation's side. The store is a file of the step's
  own, `<dataDir>/audio/dictation-pending.json`, not memory: a pending pair
  is no fact about the user's words (memory/lexicon would list it and recall
  would find it), and it expires.

### The full name, kept and recalled (2026-10-24, later)

Tom's boss came out a new way almost every time: Paul Attoy, Paul Etoy,
Paul Latoy, Paula Toy, Call itoy, Coolitoy. Learning Etoy → Itoi does not
cover Attoy. The audio spike (strut-wt-audio-score,
plans/dictation-audio-check.md, "Applying at transcription") found that the
rewrite already puts nearly all of them right once the full name "Paul
Itoi" is in the vocabulary as a person; it missed only the spans recall
never offered ("Call itoy", "Coolitoy", "Paul Italy").

- **The learn keeps the full name** (`assess`'s `name`, `fullNames`,
  `nameRun`). When a learned or pending change's user's words sit in a run
  of capitalised words (two to four, no punctuation between, no code), the
  model is asked of each word alone, lower case, whether it is an everyday
  word (`everyday`). The run is the largest stretch round the user's words
  whose words all read as only a name (below 0: "paul" −3.1, "kathryn"
  −11.1; "ask" +21.9, "deploy" +16.6). So "Ask Paul Itoi" keeps "Paul
  Itoi", "Stadeum Cloud" is no person, and "Mark Smith" gives no name. The
  mapping is then written on the entity that writes the full name (attached,
  never a second one), else on a new entity of `person_type` (memory/lexicon:
  the user type's parent, Person on the seed ontology), with the user's word
  as its form: Paul Itoi, heard "Etoy" for Itoi. One memory/remember, so
  Undo still forgets everything written: the new person with its facts, or
  the new fact. Paula Toy → Paul Itoi is the name itself, no form. Asking
  the model to tell a person from a product by the scoring line ("often
  mentions Paul Itoi (a person)" against "(a term)") was tried and told
  nothing: −0.1 nats for Paul Itoi. A person made this way is not one
  dictation/remove takes (it is not a Lingo word): it is turned off for
  dictation, or undone.
- **The name question asks the full name.** "My boss is called Paul Itoi."
  was not learned: judge −5.2, `named` of "Itoi" −1.3. Of "Paul Itoi" it
  reads 11.3 (12.7 in "His name is…", 12.3 in "Ask…"). So `named` is asked
  of the capitalised run round the user's words, less a word beginning the
  sentence that is not theirs (`nameWord`).
- **Recall of a full name by its whole sound** (`saidAsName`,
  `NAME_SOUND_DISTANCE`). One rule, for a person's name of two or more
  words: a span (1–3 words, not across punctuation) is offered when its
  whole sound (`saidKey`, spaces counting for nothing, a doubled sound
  across words as one) is within 0.25 of the name's, by edit distance over
  the longer. No first-name or surname rule. For Paul Itoi ("paulitoi", 8
  sounds) that is two sounds: Paul Etoy (0), Paul Attoy, Paul Latoy, Paula
  Toy (1), Call itoy, Call It Oy, Paul Italy (2) are offered; Coolitoy
  ("kolitoi", 3) is not, nor "I'll call Mark", "a toy for Paul", "Paula said
  hi", "call it a day". "I told Paul it was fine" ("paulit", 2) is offered
  and the rewrite leaves it. A one-word name is matched as strictly as
  before (a loose one-word match is where Mark → Mike comes from), and a
  Lingo of the same name is not matched this way. The rewrite decides each
  one as before.
  It replaced a first-name/surname split (the first name one consonant off
  with the same last sound, the surname within one sound, the split
  anywhere), tuned on Tom's six. The threshold, on the 1.7B fix eval (71
  cases):

  | threshold | fix precision | recall | exact | Tom's six | fails among the names |
  |---|---|---|---|---|---|
  | 0.2 | 0.98 | 0.89 | 0.92 | 4 | Call itoy, Coolitoy, Paul Italy missed |
  | 0.25 (0.3 the same) | 0.98 | 0.93 | 0.94 | 5 | Coolitoy missed |
  | 0.4 | 0.96 | 0.96 | 0.94 | 6 | Bill Itoi rewritten to Paul Itoi |

  Coolitoy and Bill Itoi ("bilitoi") are both three sounds off, so no one
  threshold tells them apart: 0.25 misses Tom's run-together name and
  leaves a different person alone; 0.4 does the reverse. A wrong person's
  name rewritten is the worse mistake (the Mark → Mike kind), so 0.25. The
  old split rule also rewrote Bill Itoi (the first name one consonant off)
  and missed Paul Italy.
- **PH → P8 in chemistry** (`CODE_MARGIN`, 2 nats). A code that dictation
  wrote one character off a code in the vocabulary must read likelier by 2
  nats. "The PH of the water is high" reads 0.3 as P8 (Kroko writes PH so);
  the other chemistry sentences read −1.7 to −4.9; "send PH now" 6.6, "we
  ship PH by Friday" 6.1, "check the PH level" 4.3 (still rewritten),
  "Did you deploy PH yet?" 15.1. A spelled-out form ("P H" 18.6, "p eight")
  is no code of its own and needs no margin.
- **"the Tory party" → Tauri: not fixed.** Dictation writes "Tory"
  capitalised, so the same-sound margin (lower case only) does not apply,
  and it reads 0.8 to 1.3 nats likelier as Tauri. Asking `everyday` of
  "tory" does not help: the 1.7B reads it as only a name (−10.1), like
  "katherine" (−15.8). Extending the margin to every capitalised same-sound
  word would drop Katherine → Kathryn (1.6). Doing it by type (not a
  person) would drop it too for a name learned on its own, which is stored
  as a Lingo word. The spike's audio check tells them apart (about −14); the
  text alone does not, so `n-tory-capital` is kept as a known failure.

## Eval (src/audio/dictation-eval)

`cases.jsonl` (synthetic, committed): 71 learn cases (typed, edited, lexicon
→ expected pairs, with the full name a pair is kept on) and 71 fix cases (transcript, lexicon → expected text),
with the hard ones: stack work→Stakwork, stackwork→Stakwork, p eight→P8, P8
typed as PH and put back, their→there (nothing), i→I (nothing), Jon→Jen
(nothing), a sentence rewrite (nothing), "fix" vs Sphinx in and out of
context, tory vs Tauri, stutters, "Tuesday, no, Wednesday", name spellings
(Katherine → Kathryn learned and applied; Kathryn O'Brien from the graph;
Kate O'Brien left alone), and real words as names (stadium → Stadeum
learned and applied in a product's context, left in "we watched the game at
the stadium", "the stadium was full", "a football stadium"; peel → Peel and
hive → Hive learned; "Stadium" and a sentence's "Peel" not; three changes
in one edit, Stackworth, Stadium and Catherine, each learned, "Stadium"
capitalised by dictation too; two fixes far apart in a 407-word dump; PH → P8 learned
as a term, then P8 for "PH", "P H", "p eight", "P 8" in context and pH left
in chemistry; Tom's Etoy → Itoi and Paula Toy → Paul Itoi with Nicky →
Nikki, Ellen → Allen, and "a cross" → "across" and "may be" → "maybe" not
learned; Etoy → Itoi in "My boss is called Paul Itoi." and "Ask Paul Itoi…"
kept on the full name; with Paul Itoi a person in the vocabulary, Tom's
"Paul Attoy", "Paul Etoy", "Paul Latoy", "Paula Toy", "Call itoy",
"Coolitoy" and "Paul Italy" put right, and "I'll call Mark", "a toy for
Paul", "a toy for his birthday", "call it a day", "Paula said hi" (Paula a
person of her own), "Ask Bill Itoi" and "I told Paul it was fine" left; "the Tory party" and Kroko's "The PH of the water is high" left).
`npm run eval:dictation` (opt-in, not in `npm test`) runs them through the
real pipeline and `DictationFixer` (the model in its worker, the 1.5 s
fallback live) against the GGUFs in `./.models/gguf` (gitignored).

On an M-series Mac, 2026-10-23, warm (load measured separately):

| fixer | task | precision | recall | exact | p50 ms | p95 ms | load s |
|---|---|---|---|---|---|---|---|
| qwen3-1.7b-q4 | learn | 0.96 | 0.96 | 0.94 | 59 | 338 | 1.2 |
| qwen3-1.7b-q4 | fix | 0.98 | 0.93 | 0.94 | 70 | 136 | 1.2 |
| qwen3-0.6b-q4 | learn | 0.82 | 0.96 | 0.88 | 37 | 81 | 6.5 |
| qwen3-0.6b-q4 | fix | 1.00 | 0.84 | 0.88 | 78 | 349 | 6.5 |
| none | learn | – | 0.00 | 0.54 | 0 | 0 | – |
| none | fix | 1.00 | 0.60 | 0.71 | 0 | 0 | – |

The 1.7B rows are from 2026-10-24 (later) on the 142 cases, with the full
name kept, full names recalled by their whole sound (0.25) and the code
margin. With the earlier first-name/surname recall the same 142 scored
learn 0.96 / 0.96 / 0.94 (recall does not touch learning) and fix 0.95 /
0.93 / 0.93; the whole-sound rule gains Paul Italy and leaves Bill Itoi,
and loses Coolitoy (above). On the 139 before those three, the split rule's
fix was 0.98 / 0.95 / 0.96. Before them, on
the 124 cases before the 15 new ones, learn was 0.95 / 0.95 / 0.94 and fix
1.00 / 0.95 / 0.96; the same four learn and two fix cases fail on both, and
of the new ones only `n-tory-capital` fails (the Tory party rewritten,
above). The five learn cases whose names now come with their full name
(Etoy, Paula Toy, three Kathryn O'Brien) had their expectations updated.
Before the changes for respelled and re-split names (on the same 124,
learn was 0.93 / 0.91 / 0.90 on them:
Etoy → Itoi and Paula Toy → Paul Itoi missed, "a cross" → "across" learned;
on the 119 before those five, 0.95 / 0.97 / 0.95, and the same cases still
fail there). The 0.6B and none rows are from 2026-10-23 on the earlier 84; the 0.6B GGUF was not at hand to
rerun, so its name questions and margins are unmeasured. Before the
real-word changes the 1.7B scored learn 0.93 / 0.82 / 0.87 and fix 0.92 /
0.87 / 0.85 on the first 115 of them (0.93 / 0.96 / 0.94 and 0.97 / 0.97 /
0.95 on the 94 before them); with them but each change still judged in the
whole edit and dictation's word asked in its sentence, learn was 0.95 /
0.90 / 0.92 on the 119, learning only Stakwork of three changes in one edit
(Stadium → Stadeum and Catherine → Kathryn missed); before the name-spelling line in the judge's prompt it
learned 0.92 / 0.82 / 0.87 on those 94, missing every respelled name. No
case fell back on time. The 1.7B misses: "bee see"→BTC and Ellen → Allen (judge −2.3; not said
the same, so not even on a repeat) not learned,
there→their and "the Stakwork"→"Stakwork's" learned, "the peel build" and
"ship it in peel tonight" left as is. The 0.6B learns more
wrongly (PH→P8, BTC→Bitcoin, apple→Apple) and misses the take-backs. With
no fixer, fillers and doubled words still go and only learned mishearings of
two or more words apply; a one-word one ("fix" for Sphinx) is left as heard,
since only a fixer tells it apart from the everyday word. (Before, every exact
mishearing applied, rewriting "fix" everywhere: fix precision 0.75, recall
0.48, exact 0.53.)

## Phases

1. **Spike: fixer runtime + eval** — done (`spike/dictation-fixer`): picked
   node-llama-cpp, the 1.7B as the default, and scoring over generation (the
   model writing JSON edits was less precise and slower).
2. **Catalog + selection + Parakeet** — done (`feat/dictation-models`,
   merged into #301): the catalog, download/verify/extract into the model
   dir, the three steps, Parakeet offline in `/audio/transcribe`, the
   selected speech model used there.
3. **Recall + fix + judge** — done, in #301: the pipeline above; `lessons`,
   `Words`, `words-en.ts`, `common-words.ts` deleted; `lexiconFrom`,
   `learnInput`, `undoIds` and add/remove/undo kept. Tests run with a fake
   fixer (scores injected); the eval runs the real one.
4. **Peel**: a Dictation settings picker over `dictation/models`; send the
   edit once it settles (drop the `dry_run` polling, which would run the
   model on every re-read).

## Contract changes (§7a)

- `dictation/correction`'s `dry_run` is removed (clients send the settled
  edit once).
- `dictation/add`'s `applies` is removed (no everyday-word rule).
- New: `dictation/models`, `dictation/use`, `dictation/remove-model`,
  `dictation/enable`.
- `/audio/transcribe`: `model` names the speech model used, and a new
  `fixer` names the fixer used (null when none ran). Each entry of `changes`
  gains `at`, its offset in `heard`; a removal has `written: ""`.
