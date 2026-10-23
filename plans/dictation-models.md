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
   the same letters or sounds, which beats a near spelling; where one word's
   spans overlap, the better match, then the shortest. At most 8. It finds;
   it never decides.
3. **Fix** (`rewrite`, with the selected fixer):
   - Each candidate: the log-likelihood of the sentence with the vocabulary
     form against the sentence as heard, after the line "Dictated by someone
     who often mentions X (a <type>)". Both readings start with a capital (so
     "Peel the oranges" is no evidence for Peel), and a sound-alike is also
     read in its own title case (so "tory" in lower case is no evidence for
     Tauri). Kept when the vocabulary reading is likelier; of two claiming
     one span, the likelier.
   - Fillers and a word said twice in a row: removed by rule, with an
     exception list ("that that", "had had", "very very", …).
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
   within 40%), is not asked. Each remaining change is asked yes/no with the
   sentence and what the vocabulary knows of the words ("Bitcoin, BTC (same
   thing)", "(turned off for dictation)"); P(yes) and P(no) come from one
   forward pass, and it is learned when yes outweighs no by the model's
   margin (0 for the 1.7B, 1 nat for the 0.6B, which leans yes). The write
   path is #301's: undone pairs and words with dictation off are never
   written, and only the pair is stored, never the sentence. With no fixer
   installed nothing is learned (Add in the Vocabulary still works). The
   step waits up to 60 s for a cold model to load, then 1.5 s for the
   answer: the client sends an edit once, so a cold model should not lose it.

## Models and where they run

- **Runtime.** node-llama-cpp 3.22 (Metal on a Mac, GGUF), in a
  `ModelWorker` of its own (src/audio/fixer.ts; the worker runs
  src/audio/fixer-engine.ts, which imports only types from strut). Each task
  (judge, score, take-back) keeps its own sequence of one context, so its
  fixed prompt prefix (system prompt and shots) stays in the KV cache. Calls
  run one at a time. The model loads on the first call and unloads after 5
  minutes idle; a changed pick swaps it on the next call. transformers.js
  (privacy's runtime) was measured in the spike and lost on speed.
- **Catalog** (src/audio/models.ts): like `STT_MODELS`, each entry has id,
  url, sha256, bytes, kind (`speech` | `fixer`), description; a fixer also
  its learn margin. Fixers: `qwen3-1.7b-q4` (Qwen3 1.7B instruct, unsloth's
  Q4_K_M GGUF, 1.1 GB; the default to offer) and `qwen3-0.6b-q4` (0.4 GB,
  the small option). Speech: Kroko, Parakeet TDT 0.6B v2.
- **Selection and download** (steps, same for any client):
  - `dictation/models {}` → `{ models: [{ id, kind, bytes, description,
    state: "available" | "downloading" | "installed", progress?, selected,
    error? }] }`
  - `dictation/use { speech?, fixer? }` (fixer may be `null`: none) → the
    same list. Selecting a model that is not installed starts its download;
    it is used once installed.
  - `dictation/remove-model { id }` → the same list.
  Selection lives in `<dataDir>/audio/dictation.json`. Default: Kroko and no
  fixer: a 1.1 GB download is the user's choice, so "default fixer" means the
  one a client offers first. Models are never bundled with a client.
- **iOS / other clients** call the same steps and endpoints over the network.

## Eval (src/audio/dictation-eval)

`cases.jsonl` (synthetic, committed): 50 learn cases (typed, edited, lexicon
→ expected pairs) and 34 fix cases (transcript, lexicon → expected text),
with the hard ones: stack work→Stakwork, stackwork→Stakwork, p eight→P8, P8
typed as PH and put back, their→there (nothing), i→I (nothing), Jon→Jen
(nothing), a sentence rewrite (nothing), "fix" vs Sphinx in and out of
context, tory vs Tauri, stutters, "Tuesday, no, Wednesday".
`npm run eval:dictation` (opt-in, not in `npm test`) runs them through the
real pipeline and `DictationFixer` (the model in its worker, the 1.5 s
fallback live) against the GGUFs in `./.models/gguf` (gitignored).

On an M-series Mac, 2026-10-23, warm (load measured separately):

| fixer | task | precision | recall | exact | p50 ms | p95 ms | load s |
|---|---|---|---|---|---|---|---|
| qwen3-1.7b-q4 | learn | 0.92 | 0.96 | 0.94 | 62 | 90 | 4.2 |
| qwen3-1.7b-q4 | fix | 0.96 | 0.96 | 0.94 | 96 | 232 | 4.2 |
| qwen3-0.6b-q4 | learn | 0.82 | 0.96 | 0.88 | 37 | 81 | 6.5 |
| qwen3-0.6b-q4 | fix | 1.00 | 0.84 | 0.88 | 78 | 349 | 6.5 |
| none | learn | – | 0.00 | 0.54 | 0 | 0 | – |
| none | fix | 1.00 | 0.60 | 0.71 | 0 | 0 | – |

No case fell back on time. The 1.7B misses: "bee see"→BTC not learned,
there→their and "the Stakwork"→"Stakwork's" learned, "the tory party"
rewritten to Tauri, "the peel build" left as is. The 0.6B learns more
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
- New: `dictation/models`, `dictation/use`, `dictation/remove-model`.
- `/audio/transcribe`: `model` names the speech model used, and a new
  `fixer` names the fixer used (null when none ran). Each entry of `changes`
  gains `at`, its offset in `heard`; a removal has `written: ""`.
