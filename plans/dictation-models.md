# Dictation with models the user picks

> Status (2026-10-23): phases 1–3 built, in #301 (`feat/dictation-lingo`),
> which also carries the model catalog (phase 2, merged in from
> `feat/dictation-models`): the catalog ships with the fixer that uses it.
> The hand rules of #301 (`lingo.ts`'s `lessons` and `Words`, the 51k-word
> `words-en.ts`, `common-words.ts`) are gone; a small local model scores
> edits and the vocabulary in context. Phase 4 (Peel) is next. The client
> contract is `plans/native-dictation-client.md` §7a.

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
   shortest. At most 8. It finds; it never decides.
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
   within 40%), is not asked. A person's name respelled the way the user
   spells it (Katherine → Kathryn, Jon → John, Steven → Stephen) is the same
   spoken name and is learned; a different name (Mark → Mike, Jon → Jen) is
   not. The rewrite needs nothing special for such a name: after "often
   mentions Kathryn (a person)" the learned spelling outscores the commoner
   one by 1.6 to 8 nats, and a full name already in the graph ("Kathryn
   O'Brien", nothing learned) is recalled and chosen the same way. A first
   name alone ("Katherine said yes") is not matched to a graph's full name,
   and a different name ("Kate O'Brien") is not recalled for it. Each remaining change is asked yes/no with the
   sentence and what the vocabulary knows of the words ("Bitcoin, BTC (same
   thing)", "(turned off for dictation)"); P(yes) and P(no) come from one
   forward pass, and it is learned when yes outweighs no by the model's
   margin (0 for the 1.7B, 1 nat for the 0.6B, which leans yes). A
   same-sounding change the judge turns down is asked once more (`named`):
   learned when the user's word is a name in the edited sentence and
   dictation's is clearly an everyday word in the typed one, or is a code a
   digit off (see "Real words as names"). A change from a code of its own
   ("PH" → "P8") is learned as a term: the word, with no mapping. The write
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
  a digit off) is asked "is this word a name, product, brand, code or
  technical term here, or an ordinary word?" (`NAME_SYSTEM`, four shots), of
  the user's word in the edited sentence and of dictation's in the typed one.
  Learned when the first is yes and the second is no by 2 nats or more
  ("stadium", "peel", "hive" read ordinary by 8 to 18; "jon" reads as a name,
  so "jon" → "Jen" is not learned), or dictation's is a code ("PH"). Only
  those changes pay for it, on the scoring sequence, so the judge's prompt
  stays cached: learn p95 131 ms.
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

## Eval (src/audio/dictation-eval)

`cases.jsonl` (synthetic, committed): 60 learn cases (typed, edited, lexicon
→ expected pairs) and 55 fix cases (transcript, lexicon → expected text),
with the hard ones: stack work→Stakwork, stackwork→Stakwork, p eight→P8, P8
typed as PH and put back, their→there (nothing), i→I (nothing), Jon→Jen
(nothing), a sentence rewrite (nothing), "fix" vs Sphinx in and out of
context, tory vs Tauri, stutters, "Tuesday, no, Wednesday", name spellings
(Katherine → Kathryn learned and applied; Kathryn O'Brien from the graph;
Kate O'Brien left alone), and real words as names (stadium → Stadeum
learned and applied in a product's context, left in "we watched the game at
the stadium", "the stadium was full", "a football stadium"; peel → Peel and
hive → Hive learned; "Stadium" and a sentence's "Peel" not; PH → P8 learned
as a term, then P8 for "PH", "P H", "p eight", "P 8" in context and pH left
in chemistry).
`npm run eval:dictation` (opt-in, not in `npm test`) runs them through the
real pipeline and `DictationFixer` (the model in its worker, the 1.5 s
fallback live) against the GGUFs in `./.models/gguf` (gitignored).

On an M-series Mac, 2026-10-23, warm (load measured separately):

| fixer | task | precision | recall | exact | p50 ms | p95 ms | load s |
|---|---|---|---|---|---|---|---|
| qwen3-1.7b-q4 | learn | 0.94 | 0.97 | 0.95 | 58 | 131 | 1.2 |
| qwen3-1.7b-q4 | fix | 1.00 | 0.95 | 0.96 | 69 | 140 | 1.2 |
| qwen3-0.6b-q4 | learn | 0.82 | 0.96 | 0.88 | 37 | 81 | 6.5 |
| qwen3-0.6b-q4 | fix | 1.00 | 0.84 | 0.88 | 78 | 349 | 6.5 |
| none | learn | – | 0.00 | 0.54 | 0 | 0 | – |
| none | fix | 1.00 | 0.60 | 0.71 | 0 | 0 | – |

The 1.7B rows are from 2026-10-24 on the 115 cases (the 0.6B and none rows
are from 2026-10-23 on the earlier 84; the 0.6B GGUF was not at hand to
rerun, so its name question and margins are unmeasured). Before the
real-word changes the 1.7B scored learn 0.93 / 0.82 / 0.87 and fix 0.92 /
0.87 / 0.85 on the same 115 (0.93 / 0.96 / 0.94 and 0.97 / 0.97 / 0.95 on the
94 before them); before the name-spelling line in the judge's prompt it
learned 0.92 / 0.82 / 0.87 on those 94, missing every respelled name. No
case fell back on time. The 1.7B misses: "bee see"→BTC not learned,
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
