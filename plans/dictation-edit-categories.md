# Dictation: what a user's edit teaches

> Status (2026-10-24): proposed. Builds on `plans/dictation-models.md`,
> where `dictation/correction` asks one question of an edit: "was this a
> mishearing?". This plan widens that to "what kind of change is this?",
> with a place to keep each kind and a way to apply it.

## Why

The first thing the user does after dictating is fix what's wrong. Each
fix is evidence about how they write. Today strut learns from only one
kind of fix, a term misheard ("stack work" → "Stakwork"). Recently it also
learns a name spelled the user's way (Katherine → Kathryn, #316). Other
kinds of fix are judged "no" and lost, even though the user would expect
them to stick: casing a brand, preferring "$5" to "five dollars", never
ending a Slack message with a full stop.

Asking "mishearing?" doesn't scale. Each new kind needs another clause in
the prompt, and each clause moves the fragile negatives (PH → P8 is
already only 0.27 nats from being learned). A model that names the kind of
change can be checked kind by kind, and each kind has its own place to be
kept.

## Every fix is one of three things

1. **Vocabulary:** how one particular thing is written. It is kept in the
   memory graph, on the entity it names (a person, a company, a Lingo
   word), so everything else that reads the graph sees it too.
2. **Style:** a habit of the user's, not tied to any one word. It is kept
   as the user's dictation style, per app category.
3. **One-off:** nothing to keep. The user changed their mind, rewrote the
   sentence or fixed their own grammar.

### Vocabulary kinds

| Kind | Example | Kept as | Applied by |
|---|---|---|---|
| `misheard` | stack work → Stakwork, jason → JSON | `heard_as` on the entity (exists) | the rewrite (recall + score), hotwords |
| `spelling` | Katherine → Kathryn, Jon → John | `heard_as`, as now since #316; the graph's name wins when it's a person | the rewrite |
| `casing` | github → GitHub, iphone → iPhone | a written form on the entity; no `heard_as` needed | the rewrite: an exact case-insensitive match takes the entity's casing |
| `acronym` | a p i → API, p eight → P8 | `heard_as` with `form` (exists) | the rewrite |
| `joined` | data base → database, e-mail → email | a written form on a Lingo word | the rewrite |
| `accent` | cafe → café, Zoe → Zoë | a written form on the entity | the rewrite: letters equal once accents are stripped |
| `handle` | stakwork dot com → stakwork.com, at tom → @tom | a written form on the entity it belongs to (the person, the company) | the rewrite, matched on the spoken form |
| `preferred` | Bitcoin → BTC, in this user's writing | the entity's `preferred` form (new attribute) | the rewrite; Known: "Bitcoin, BTC (same thing)" stays a no for *learning* a mishearing |
| `new` | "my wife Kathryn O'Brien", Kathryn unknown | a proposal to the memory (`memory/remember` with `created_by: dictation`), not a silent write | the next transcripts, as any entity |
| `which` | "Jev" meant Jev Smith, not Jev Brown | a mention linked to the entity | recall ranks that entity first next time |

### Style kinds

| Kind | Example | Kept as | Applied by |
|---|---|---|---|
| `end` | removes the final full stop in Slack | `style.end` per app category | a rule on the rewrite's output |
| `case` | lowercases everything in chat | `style.case` per app category | a rule |
| `numbers` | five dollars → $5, ten percent → 10% | `style.numbers` (digits, symbols) | a rule: number words to digits in the text the speech model returns |
| `filler` | always deletes "so", "basically" | `style.drop` (word list) | a rule: the filler pass already exists |
| `lists` | a spoken list turned into lines | `style.lists` | the fixer, generating one edit per item (later) |
| `tone` | formal in email, casual in chat | `style.tone` per app category | the fixer, as a prompt (later; the only kind that needs generation) |

### One-off (learn nothing)

| Kind | Example |
|---|---|
| `chose` | Mark → Mike, Tuesday → Wednesday: a different word, chosen |
| `rewrite` | the sentence said another way |
| `grammar` | their → there, tense, plural, possessive |
| `around` | text outside what dictation typed (Peel already sends only the dictated span) |

## Learn the term, the mapping, or nothing: context decides each time

What a fix teaches comes in three strengths, and none of them is applied
blindly. Every change is scored in the whole sentence (the rewrite's
likelihood comparison), so the same learned item gives different results
in different sentences.

1. **A term.** The user fixes PH → P8. What to keep is that P8 is one of
   their terms (a Lingo written form), not that PH means P8. Each later
   sentence then decides: "ship P8 by Friday" becomes P8, and "the pH of
   the water" stays.
2. **A mapping.** The user fixes stadium → Stadeum, their product. Keep
   that "stadium" is how dictation hears it, and still apply it only where
   the sentence is about the product: "open it in Stadeum", but not "a
   football stadium".
3. **A variant of a known term.** "Stackwork", "p eight" and "P 8" resolve
   to the term at once. Close spellings of lingo the user already has are
   the safest fixes.

So when dictation's text is itself a real word or code the user could
mean (PH, stadium), the edited form is learned as a term, and as a mapping
too when it is a name or product. When dictation's text is not a word
("Stackwork", "stack work"), the mapping is learned as today.

## The judge names the kind

`dictation/correction` keeps its contract, `{ typed, edited }` →
`{ learned: [...] }`, and each learned item gains a `kind`. What changes is
inside strut:

1. **Code first.** Before any model call, the diff is checked for kinds
   that code can name for certain:
   - `casing`: same letters, different case, on a non-dictionary word;
   - `accent`: the same once accents are stripped;
   - `joined`: the same once spaces and hyphens are removed;
   - `numbers` and `end`: digits for number words, a dropped final full stop.

   Rules are fine here: they say *what* changed, not whether it's worth
   keeping.
2. **The model for the rest.** For each remaining change, the judge
   compares the likelihood of one short label per kind (`misheard`,
   `spelling`, `acronym`, `handle`, `preferred`, `chose`, `rewrite`,
   `grammar`) in one forward pass. This is the same scoring as today's
   yes/no, over more labels, so it stays around 60–90 ms on the 1.7B.
3. **Then the guards, as today.** A pair the user undid is never learned,
   nor a word turned off for dictation, nor dictation's text when it is
   already a vocabulary form.

## How much evidence before applying

| Kind | Applied after |
|---|---|
| Vocabulary | one edit, with Undo in the HUD (as today) |
| `new` (a person or company) | one edit, but as a proposal the memory accepts the usual way |
| Style | two edits in agreement, in the same app category, within 30 days. One edit might be a one-off; the HUD says "Got it: no full stops in Slack" only when the second edit lands |

Every learn is undoable from the HUD, and later from the Vocabulary window
or a Style section in the client's settings.

## Applying

The order in `/audio/transcribe` is unchanged, with style added at the end:

1. Speech, with vocabulary forms as hotwords where the model takes them.
2. Recall and score: vocabulary, now including `casing`, `accent`,
   `joined`, `handle` and `preferred` written forms.
3. Fillers and self-corrections, as now, plus the user's `style.drop`.
4. **New:** the style rules for the app category the client names. The
   transcribe request gains `app: { id, category }`, with category one of
   `chat`, `email`, `document`, `code` or `other`. Peel maps bundle ids to
   categories.

The reply's `changes` gain a `kind`, so a client can show why the text
changed.

## Where it's kept

- **Vocabulary:** in the memory graph, on the entities, through
  `memory/remember` facts with `created_by: dictation`. These are the
  `heard_as` facts that already exist, plus written forms and the new
  `preferred` attribute.
- **Style:** facts on the user's own entity under a `dictation_style`
  predicate: `{ category, key, value, evidence: [episode ids] }`. That
  makes them visible, exportable and undoable like any other memory, and
  another client (iOS, a web page) gets the same habits.
- **Nothing else.** No sentence is ever kept, only the pair or the style
  value.

## Telling a mishearing from a slip: "said the same"

Most of this plan rests on one question: did the user say what they
corrected to, and dictation misheard it (Etoy → Itoi), or did they say
something else and change it (Mark → Mike)? A fix the user repeats is
strong evidence of a mishearing, but only if the two sound the same:
correcting a slip of the tongue twice must never teach it. These are the
ways to answer "said the same", cheapest first.

| Option | How | Catches | Cost | Status |
|---|---|---|---|---|
| 1. Vowel-aware spelling rules | Normalise spellings that sound alike (oy/oi, ph/f, c/k, a leading e/i, doubled letters), keep the vowels, compare | Etoy/Itoi, Paula Toy/Paul Itoi, Sarah/Sara, Stackworth/Stakwork; keeps Mark/Mike, Jon/Jen, Tom/Tim apart | None; code only | **Now**: the repeat path and the sound gate |
| 2. Metaphone 3 with vowels | The phonetic algorithm Stakwork's Jarvis already uses for names (`jarvis-backend`, `api/helper/metaphone3.py`: `SetEncodeVowels`, `SetEncodeExact`, `ResultRanking`) | Much of English spelling's irregularity in names, tuned over years | A port or library into strut; check its licence and size | Later, if rules miss too much |
| 3. Pronunciation dictionary plus spelling-to-sound | Look words up in a pronunciation dictionary (CMU's has about 134k words, many names). A small model predicts sounds for unknown words. Compare sounds | Real words and names, including ones spelled nothing like they sound | A few MB of data plus a tiny model, local | Later |
| 4. Check the recording | Keep the recording until the edit watch ends. Ask the speech model whether the corrected text fits the audio as well as the transcript did | The only test of what the user actually said. A slip (said "Mark", wrote Mike) fails it however often it repeats | Keep the WAV about 60 s longer (local); needs a speech model that can score given text against audio | The end goal |
| 5. A voice profile | The user reads a few sentences in Settings once (enrolment). Then either the speech model adapts to their voice and accent, or their own pronunciations of their names and terms are kept as sound examples | Fewer mishearings in the first place, especially names said the user's way | An enrolment flow; on-device adaptation or a per-user sound store; privacy of a voice print (local only, deletable) | Research |

Options 4 and 5 move the question from spelling to sound, which is where
the mistake happens. Option 1 ships now because it fixes the cases seen in
use (Paul Itoi) without new dependencies.

## Wispr Flow, for comparison

Wispr publishes little about how it works. From reviews and its
marketing:

| | Wispr Flow | This plan |
|---|---|---|
| Learns words from corrections | yes ("dictionary learns from your fixes"; how it decides is not described) | yes, by kind, with Undo |
| Add a word by hand | yes, with "Correct a Misspelling" for names | yes, the Vocabulary window |
| Tone per app | "Styles": formal, casual, very casual, by app category (English, desktop) | `style.tone` per category, later |
| Snippets (say a phrase, get text) | yes | not in this plan (a natural `snippet` Lingo kind later) |
| Filler and self-correction removal | yes | yes (exists) |
| Shared team dictionary | yes | not yet; the graph could share a team's Lingo words |
| Where it runs | cloud | on the user's Mac, in their own strut |
| What it knows about people | the dictionary only | the memory graph: people, companies, and who the user means |

We differ in two ways:
- The memory graph makes vocabulary entity-aware: "Kathryn O'Brien, my
  wife" is a person, not just a word.
- Everything runs locally, so the judge has to be small and precise rather
  than a large cloud model.

## Phases

1. **The label judge** (strut): replace yes/no with kind labels, keeping
   today's vocabulary kinds plus `casing`, `accent`, `joined` and `handle`.
   Extend the eval with labelled cases per kind. Gate: precision on
   vocabulary kinds no worse than today's 0.93, and the one-off negatives
   held.
2. **Written forms and `preferred`** (strut): store and apply the new
   vocabulary kinds in the rewrite.
3. **`new` and `which`** (strut and memory): propose people and companies,
   and link mentions to the right entity.
4. **Style** (strut and clients): the `dictation_style` facts, the
   two-edit rule, the rules in `/audio/transcribe`, and `app.category` in
   the request. In Peel: send the category, show "Got it" in the HUD, and
   add a Style list in settings.
5. **Tone and lists**: only once 1–4 hold, and only with a model that
   generates well enough. This is the one place generation comes back, and
   it needs its own eval.

## Open questions

- **App categories:** who maps an app to a category, the client or strut?
  Proposal: the client sends a bundle id, strut keeps the map, so every
  client agrees.
- **Style scope:** per user, or per user and app category? Proposal: per
  category, falling back to the user's default.
- **Proposing people:** should `new` ask the user (HUD: "Add Kathryn
  O'Brien to your people?") or write straight to memory as a low-confidence
  fact? Proposal: ask once, in the HUD.
- **Fragile negatives:** PH → P8 sits 0.27 nats from being learned. Does a
  label judge move it? The eval decides before phase 1 lands.

Sources for the Wispr comparison:
[Letterly review](https://letterly.app/blog/wispr-flow-review/),
[Kripesh Adwani review](https://kripeshadwani.com/wispr-flow-review/),
[GrowwStacks tutorial](https://growwstacks.com/blog/wispr-flow-voice-ai-tutorial).
