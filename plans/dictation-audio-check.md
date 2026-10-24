# Dictation: does a correction fit what was said? (spike)

> Status (2026-10-24): spike, not built. The scripts are
> `src/audio/dictation-eval/audio-score.ts` (learning) and `audio-apply.ts`
> (applying at transcription), both opt-in and not in `npm test`. The
> numbers below come from macOS `say` voices, not real speakers. Read them as
> evidence that the method works, not as tuned thresholds.

## Question

When the user edits what dictation typed, `dictation/correction` decides
whether the edit was a mishearing (learn it) or a changed mind (ignore it).
Today that decision uses `lingo.ts`'s sound rules (`soundsAlike`,
`soundKey`, `nearCode`), then the fixer model's judge, then its name and
everyday questions. Each new kind of case has needed another rule or prompt
change.

The idea is to check the correction against the recording itself. If
"Paul Itoi" fits the audio about as well as the transcript "Paul Etoy" did,
the edit was a mishearing. If the user said "Mark" and changed it to
"Mike", "Mike" should fit clearly worse. It then can never be learned,
however often the user repeats the edit, because each edit is scored against
its own recording.

## Method

**Score a text against a recording, locally, in Node.** We run the NeMo
models' ONNX exports directly on `onnxruntime-node`, which is already in
strut's tree. Sherpa does not expose encoder outputs or a way to score a
given text.

1. **Features.** We compute NeMo's log-mel in TypeScript: pre-emphasis 0.97,
   512-point FFT, 25 ms Hann window, 10 ms hop, Slaney mel bank, log with a
   2^-24 guard, per-feature normalisation. That is 128 mels for the 0.6B
   model and 80 for the 110M models. Check: greedy decoding of our features
   gives the same text as sherpa on every clip we looked at.
2. **Tokens.** Each word is split into the fewest pieces from `tokens.txt`,
   because sherpa's exports ship no sentencepiece model. The typed text and
   the edited text are split the same way.
3. **Likelihood: the TDT forward pass.** Parakeet TDT's exported joiner takes
   the whole encoder output `[1, H, T]` and the prediction-net outputs
   `[1, 640, U+1]`, and returns `[T, U+1, 1025 + 5]`: token logits plus five
   duration logits (0 to 4 frames). We run the token-and-duration transducer
   forward recursion over that lattice in JavaScript and get
   log P(audio | text). Long clips run the joiner in blocks.
4. **Take out the model's spelling prior.** The raw likelihood includes the
   prediction net's opinion of the spelling. A rare spelling ("Supabase",
   "Stakwork") scores worse even when it sounds right. We estimate the
   internal LM (ILME: the joiner with the acoustic input zeroed, softmax over
   non-blank tokens) and use fit = raw − λ·ILM, with λ = 1. This was the step
   that mattered: on the pairs below, λ = 0 cannot separate positives from
   negatives, and λ = 0.75 to 1.25 separates every clip.
5. **Score.** Δ = fit(typed text with this change) − fit(text as typed), in
   nats. Each word change ("hunk") is scored on its own, with the rest of the
   sentence as typed. **Learn when Δ ≥ −8.**

Candidates tried:

| scorer | what | size | verdict |
|---|---|---|---|
| (b) **Parakeet TDT 0.6B v2**, transducer forward | the offline model strut already ships | 661 MB int8, nothing new | **works**: separates every pair clip; best on the benchmark |
| (b) Parakeet TDT 110M, transducer forward | sherpa `parakeet_tdt_transducer_110m-en-36000-int8` | 136 MB new | works, but weaker: Mark → Mike fits at −7.4, and codes ("PH → P8", "k p i → KPI") fail |
| (a) Parakeet TDT-CTC 110M, CTC head | sherpa `parakeet_tdt_ctc_110m-en-36000-int8` | 132 MB new | **does not work**: no λ (token-prior division) separates the pairs, with best clip accuracy 0.68. CTC's token priors are a poor stand-in for the encoder's own spelling preferences |
| (b) Kroko streaming zipformer | strut's default finals model | — | not tried: its encoder is a streaming export with dozens of cached-state inputs, and the TDT result made it unnecessary |
| (c) hotword flip | — | — | not needed |

## Results: the spike's pairs

The audio is what was said. Each row is scored in five `say` voices
(Samantha en-US, Daniel en-GB, Karen en-AU, Moira en-IE, Rishi en-IN), 16 kHz
mono via `afconvert`. Δ is the median over the voices, with min and max in
brackets. TDT 0.6B, λ = 1:

| pair (audio says) | typed → edited | Δ raw | Δ | verdict at −8 |
|---|---|---|---|---|
| His name is Paul Itoi | Etoy → Itoi | +3.1 | **+3.6** [+0.3, +5.7] | learn ✓ 5/5 |
| My wife is Kathryn O'Brien | Katherine → Kathryn | −3.2 | **−1.2** [−1.3, +0.6] | learn ✓ 5/5 |
| I work for Stakwork | Stack work → Stakwork | −4.2 | **−5.4** [−5.8, −3.3] | learn ✓ 5/5 |
| We use Supabase | super base → Supabase | −8.0 | **−2.0** [−6.2, +0.5] | learn ✓ 5/5 |
| Ship P8 by Friday | PH → P8 | +8.3 | **+9.4** [+5.6, +10.1] | learn ✓ 5/5 |
| I'll call Mark tomorrow | Mark → Mike | −11.0 | **−12.0** [−13.5, −9.5] | ignore ✓ 0/5 |
| Ask Jon about it | Jon → Jen | −10.0 | **−13.0** [−14.7, −12.3] | ignore ✓ 0/5 |
| Tell Tom the deck is ready | Tom → Tim | −13.8 | **−12.0** [−14.9, −10.6] | ignore ✓ 0/5 |

All 40 clips are right. The lowest positive clip is −6.2 and the highest
negative clip is −9.5. The −8 threshold sits in a gap of about 3 nats: real,
but narrow.

The same pairs on the other scorers (per-clip accuracy at their best
threshold): TDT 110M 0.82 (0.90 at λ = 1.25), CTC 110M 0.68.

**What the transcript typed on these clips.** These are the clips where the
fix matters. Parakeet 0.6B typed 15 of 40 exactly (case and punctuation
aside) and Kroko 11 of 40. Every voice heard "Kathryn" as "Catherine" and
"Jon" as "John". "Paul Itoi" came out as "Paula Toy", "Paulifai", "Paul
Iti", and so on. On the 56 benchmark sentences below (280 clips), Parakeet
typed 136 exactly and Kroko 109.

## Results: the benchmark (cases.jsonl learn cases)

For each learn case we generate the audio of what the user meant. For a
mishearing, the edited sentence is spoken. For a changed word, the typed
sentence is spoken. `l-mixed` is "ask jon at Stakwork": the name changed,
the company was misheard. `l-kates` is spoken as "kates". Each word change is
an item, which gives 62 items from 57 cases (cases.jsonl as of #319).

Cases left out, because they have no sensible audio version: `n-cut`,
`n-add`, `n-filler` (cuts and additions: nothing new to score); `n-rewrite`,
`n-rewrite-2` (rewrites); `n-punct`, `n-format`, `n-possessive`
(punctuation, number format, grammar); `n-btc-bitcoin` (two right ways to
write one thing, and which one was said is unknown); `n-lsat-off`, `n-undone`
(filtered by the lexicon, not by judgement); and `l-long-two` (a one-minute
dictation, used for the latency runs instead).

Policies on the same 62 items. Audio verdicts use the median over five
voices.

| policy | precision | recall | accuracy | wrong |
|---|---|---|---|---|
| **judge, Qwen3 1.7B** (today) | 0.98 | 0.95 | 0.95 | l-bee-see, l-ellen, n-there |
| judge, Qwen3 0.6B | 0.91 | 0.93 | 0.89 | l-fix-sphinx, l-peel-product, l-ellen, n-apple, n-stadium-capital, n-across, n-maybe |
| audio alone, TDT 0.6B | 0.80 | 0.93 | 0.79 | same-sound negatives (n-their, n-there, n-two, n-i, n-apple, n-peel-start, n-stadium-capital, n-across, n-maybe), n-tense; l-stackwork, l-github, l-pytorch |
| audio alone, TDT 110M | 0.74 | 0.88 | 0.71 | the above, plus codes and n-mark, n-michael, n-number |
| judge 1.7B and audio 0.6B (audio as a veto) | 0.97 | 0.88 | 0.90 | l-stackwork, l-github, l-pytorch, l-bee-see, l-ellen, n-there |
| **audio 0.6B, then the 1.7B's name and everyday questions, no judge** | **0.97** | **0.93** | **0.94** | l-stackwork, l-github, l-pytorch, n-across |
| audio 0.6B, then the 0.6B's name and everyday questions | 0.81 | 0.93 | 0.81 | the homophones get through: the everyday margin was tuned on the 1.7B |
| audio 110M, then the 1.7B's questions | 0.90 | 0.88 | 0.85 | codes, n-mark, n-michael, n-number, n-across |

On all 69 learn cases, `npm run eval:dictation -- --task learn` gives the
1.7B judge precision 0.95, recall 0.95, exact 0.94, and the 0.6B judge 0.87,
0.93, 0.87.

In the "no judge" policy, the audio decides whether the change sounds like
what was said. What sound cannot tell is left to two one-word questions the
fixer already has. If both words are everyday words ("their" → "there",
"apple" → "Apple"), the change is not learned unless the user's word reads as
a name where it stands, and never at the start of a sentence. A code on
either side skips the questions. The one false learn, `n-across` ("a cross"
→ "across"), is a multi-word everyday rejoin that this simple rule does not
ask about. A real port would ask the everyday question of the joined word.

Per-item Δ for TDT 0.6B, λ = 1 (median [min, max] over five voices):

| item | learn? | typed → edited | Δ | verdict |
|---|---|---|---|---|
| l-stack-work | yes | stack work → Stakwork | −1.8 [−5.2, −0.5] | ok |
| l-stackwork | yes | Stackwork → Stakwork | −12.7 [−15.9, −10.3] | **miss** |
| l-stockwork | yes | stockwork → Stakwork | +8.5 | ok |
| l-p-eight / -long | yes | p eight → P8 | −0.3 / +5.3 | ok |
| l-kpi | yes | k p i → KPI | −1.6 | ok |
| l-hivemind / -alone | yes | hivemind → HiveMind | +2.1 / +7.0 | ok |
| l-bee-see | yes | bee see → BTC | +19.0 | ok |
| l-supabase | yes | super base → Supabase | −5.5 [−7.7, +2.5] | ok |
| l-kubernetes | yes | cooper netties → Kubernetes | +14.8 | ok |
| l-tauri | yes | tory → Tauri | −3.7 [−10.9, +3.4] | ok (4/5 clips) |
| l-sphinks | yes | sphinks → Sphinx | +6.5 | ok |
| l-fix-sphinx | yes | fix → Sphinx | +13.9 | ok |
| l-ollama | yes | oh llama → Ollama | +8.2 | ok |
| l-two-pairs | yes | stack work → Stakwork; k p i → KPI | −1.6; +1.4 | ok |
| l-github | yes | get hub → GitHub | −8.2 [−9.3, −4.7] | **miss** (borderline) |
| l-langchain | yes | lang chain → LangChain | −4.9 | ok |
| l-pytorch | yes | pie torch → PyTorch | −9.0 [−11.2, −3.3] | **miss** (borderline) |
| l-vercel | yes | ver cell → Vercel | +2.9 | ok |
| l-postgres | yes | post gres → Postgres | −1.5 | ok |
| l-mixed | no / yes | jon → Jen; stack work → Stakwork | −15.0; −5.4 | ok, ok |
| l-etoy | yes | Etoy → Itoi | +3.6 | ok |
| l-paula-toy | yes | Paula Toy → Paul Itoi; Nicky → Nikki | +8.2; +2.0 | ok |
| l-ellen | yes | Ellen → Allen | +6.9 | ok (the 1.7B judge misses it) |
| l-kates | yes | kates → k8s | −0.4 | ok |
| l-ph-term | yes | PH → P8 | +6.0 | ok |
| l-sara | yes | Sara → Sarah | +1.7 | ok |
| l-kathryn / l-catherine | yes | Katherine/Catherine → Kathryn | −1.2 / +0.7 | ok |
| l-john | yes | Jon → John | +0.4 | ok |
| l-stephen | yes | Steven → Stephen | −1.4 | ok |
| l-stadeum / -deploy / -called | yes | stadium → Stadeum | +2.9 / +0.5 / +4.4 | ok |
| l-peel-product | yes | peel → Peel | −2.4 | ok |
| l-hive | yes | hive → Hive | +0.3 | ok |
| l-three | yes | Stackworth → Stakwork; Stadium → Stadeum; Catherine → Kathryn | −6.9; +2.1; −0.1 | ok |
| n-jon | no | jon → Jen | −12.8 | ok |
| n-mark | no | Mark → Mike | −10.3 [−12.5, −8.2] | ok |
| n-michael | no | Michael → Michelle | −12.2 | ok |
| n-number | no | 3 → 4 | −11.7 | ok |
| n-meeting / n-stadium | no | → Stakwork | −42.4 / −26.7 | ok |
| n-synonym / n-fix-patch / n-day | no | big → major, fix → patch, Tuesday → Wednesday | −19.0 / −25.3 / −19.4 | ok |
| n-tense | no | fix → fixed | −7.7 | fits (the "-d" before "it" is nearly silent) |
| n-their / n-there / n-two | no | homophones | −3.6 / −3.8 / +0.1 | fits, as it should |
| n-i / n-apple / n-peel-start / n-stadium-capital | no | casing | −3.3 / +3.1 / +2.9 / −7.8 | fits, as it should |
| n-across / n-maybe | no | a cross → across, may be → maybe | −2.8 / 0.0 | fits, as it should |

The audio does its job. Every "different word" negative fits clearly worse
than −8: names, numbers, days, synonyms. Every homophone, casing and rejoin
negative fits, which is correct, because they sound the same. Those need a text
question, not a sound question.

The three misses share one cause. The typed spelling is a very natural token
sequence ("Stackwork", "get hub", "pie torch"), and the user's spelling is
odd. ILME takes out most of the prediction net's preference but not the
encoder's. They sit at −8 to −13. Lowering the threshold to −10 would recover
two of them but would put it within reach of Mark → Mike (−8.2 on its worst
voice).

**One real voice.** On sherpa's LibriSpeech sample ("…observed Phebe…"), the
0.6B gives: Phebe → Phoebe −8.2, → Feebee −15.1, → Bebe −14.9, → Fiona −33.6,
→ Penny −30.9; portrait → portraits −14.9, → painting −28.6. Different words
land far below −8, but a true respelling lands right on the threshold. Real
speech may need the threshold nearer −10 to −12, and only real recordings can
settle that.

## Latency and memory (Apple M2 Pro, CPU, 2 threads)

| | TDT 0.6B (ships today) | TDT 110M |
|---|---|---|
| on disk | 661 MB (already downloaded with Parakeet) | 136 MB new |
| load | ~1.0 s | ~0.5 s |
| resident after load (onnxruntime) | +1.25 GB RSS (first measured as 1.7 to 1.8 GB: the script read every model file into memory to size it; fixed) | +0.31 GB RSS |
| encode, benchmark clips (1.5 s median, 7.3 s max) | p50 81 ms, p95 203 ms | p50 29 ms, p95 67 ms |
| score one text after encoding | p50 3.5 ms, p95 20 ms | p50 3.0 ms, p95 17 ms |
| 12.5 s clip: encode + one text | 591 + 143 ms | 189 + 126 ms |
| 21 s clip | 952 + 396 ms | 325 + 365 ms |
| 40 s clip | 2.0 + 1.5 s | 0.7 + 1.3 s |
| 95 s clip | 6.1 + 7.9 s | 2.3 + 7.4 s |

Scoring is O(T·U) for the joiner and the JavaScript forward pass, so a long
dictation must be cropped to the edited sentence. Sherpa's word timestamps
(`segments[].words`) give the span. Pad it by about half a second each side.
Δ for the same change barely moves between a 2-sentence and a 16-sentence
context (−7.7 to −6.5), so cropping costs nothing in accuracy.

**What it adds to a correction:** one encode of the edited sentence's audio
(~80 to 200 ms for a sentence) plus about 2 × 3 to 20 ms per change, and a
one-time ~1 s load. For comparison, the 1.7B judge took p50 58 ms and p95
292 ms per case on the same benchmark (load 2.7 s; the 0.6B took 27 / 113 ms),
and the "no judge"
policy's two one-word questions took p50 279 ms on the 1.7B and 108 ms on the
0.6B (asked unbatched here; they batch). Correction is off the typing path
(the step runs after the edit settles), so a few hundred milliseconds is fine.

The 110M is three times faster and a quarter of the memory, but on this test
it does not reliably separate close names (Mark → Mike) or codes. **The
0.6B is the scorer.** The TDT 110M is not the "light" option it looks like.

On the text side: with the audio deciding "does it sound like what was said",
the remaining questions are lexical (is this an everyday word, is it a name
here). The 1.7B answers those well. The 0.6B lets the homophones through at
the 1.7B's margins, and may need its own margin before a lighter text model
is enough.

## Could it replace the judge, the questions, and the sound rules?

- **The sound rules for learning** (`soundsAlike`, `soundKey`, `nearCode`
  in `questions()` and `sameWord()`): **yes.** The audio is the ground truth
  these rules approximate. It handles codes (PH → P8, kates → k8s, bee see →
  BTC), split words, and names where a sound key misses ("Paul Etoy" →
  "Itoi"). The text rules still have a place in the rewrite (applying a
  learned fix to a new sentence has no audio of the user's intent) and as the
  fallback when there is no audio.
- **The judge** (`fixer.judge`): **largely yes, for learning.** On the
  benchmark, audio plus the two existing one-word questions gives precision
  0.97 and recall 0.93, against the judge's 0.98 / 0.95. Its misses are three
  odd spellings and one rejoin the simple everyday rule does not ask about.
  It also catches Ellen → Allen, which the judge misses. And it gives the
  property we want and the judge cannot guarantee: a changed name never fits,
  so it is never learned, however often it is repeated.
- **The name and everyday questions:** **no, keep them.** Homophones and
  casing fit the audio by definition. Something must still ask whether
  "there" for "their" is a word to learn. Those two questions are all that is
  left, and they are single-word, cached-prefix calls.

## What strut and Peel would need

The audio is already in strut: `/audio/transcribe` receives the WAV, writes
it to `dataDir/audio/tmp`, and deletes it after decoding. `dictation/correction`
gets only `typed` and `edited`. The smallest change keeps Peel light (strut
is the brain):

1. `/audio/transcribe` keeps the decoded PCM **in memory** and returns a
   handle (`audio: "<id>"`) with the transcript and the word timestamps. No
   file is written beyond today's temp file.
2. `dictation/correction` takes an optional `audio` handle. When present and
   still held, it crops to each change's sentence, encodes once, and scores
   each change. Δ < −8 means the change is never learned. Δ ≥ −8 means only
   the name and everyday questions remain. When the handle is missing or has
   expired, it falls back to today's path.
3. **Peel:** pass the handle from the transcribe response back on the
   correction, and nothing else. Peel already watches the edit for about
   60 s, so strut holds each clip for the watch plus a margin (90 s) and drops
   it. Peel stores no audio.
4. The scorer runs in a worker thread, like the recognizer: about 1.2 GB
   resident while loaded. It should load on the first correction that carries
   audio and unload when idle, like the fixer. It cannot share the sherpa
   recognizer's copy of Parakeet, even when Parakeet is the user's speech
   model.

Port note: the forward pass and log-mel are about 300 lines of TypeScript
with no new dependencies. A production port should move the T×U forward loop
into the worker (or WASM) and batch the joiner blocks, which is where long
clips spend their time.

## Privacy

- Everything is local. The audio never leaves the Mac, the model is a local
  ONNX file, and no audio is sent to any service.
- **Retention.** Two options, both in memory only and never on disk:
  (a) drop each clip when its edit watch ends (about 60 s after the
  transcript), or when the correction has been scored, whichever is first.
  This is the recommended option. (b) a short rolling window (for example,
  the last N clips or the last 2 minutes), if a later correction can arrive
  for an earlier final. Either way a restart clears everything.
- Only the learned pair is stored, as today. No audio, score or sentence goes
  into the vocabulary, the session log or any log line.
- Today's temp WAV (`dataDir/audio/tmp`) is unchanged and is still deleted
  after decoding.

## Honest limits

- `say` is not a person. TTS is clean, has no accent drift, and pronounces a
  spelling the way a spelling rule does. That favours spellings like
  "Stadeum" and probably makes margins look cleaner than they will be.
  Accented voices (Moira, Rishi, Karen) widened the spread but did not break
  the result. One real LibriSpeech voice put a true respelling at −8.2, right
  on the threshold.
- The threshold (−8 at λ = 1) is fitted to these clips. The gap between
  positives and negatives is about 3 nats.
- Odd spellings of natural phrases ("Stakwork" for "Stackwork") are the
  method's weak spot, because the encoder carries a spelling preference that
  ILME does not remove.
- The transcript in a real session is what the recognizer typed. Here, for
  the pairs, "typed" is given (for example "Jon", which the recognizer
  actually hears as "John").

## Recommendation

Build the audio check as a **gate on learning** with Parakeet TDT 0.6B. It
needs no new model download for users who have Parakeet; Kroko users would
download it (661 MB). It takes the sound rules and the judge out of the
learning path: Δ < −8 means never learn, and otherwise the existing name and
everyday questions decide. Keep today's path as the fallback when no audio is
held. Before switching it on:

1. Record about 50 real corrections from Tom (names, products, codes, and
   changed-mind negatives) and refit λ and the threshold on them. Expect
   −10 or so.
2. Run it in shadow first: log Δ next to the judge's verdict, as pairs only,
   and switch over when they agree on real use.
3. Keep the 1.7B for the name and everyday questions until the 0.6B's margins
   are refitted.

Do not adopt the CTC 110M or the TDT 110M as the scorer: the first does not
separate, and the second is not reliable on close names and codes.

## Applying at transcription

**Question.** Tom's boss is "Paul Itoi". Dictation writes the name a new way
almost every time ("Paulatoy", "Paula Toy", "Paul Latoy", "Call itoy",
"Coolitoy", "Paul Italy"), so learning one misspelling at a time can't keep
up. Given the user's vocabulary names, can the scorer decide at transcription
time that a name fits the audio better than what the speech model typed, and
rewrite any misspelling to it?

**Method** (`src/audio/dictation-eval/audio-apply.ts`):

1. **Real transcripts.** Each clip (`say`, five voices) is transcribed by
   sherpa's Parakeet TDT 0.6B and by Kroko, as `/audio/transcribe` does it
   (no hotwords). Every misspelling below is one the models really typed.
2. **Candidates.** lingo.ts `recall` as it is, plus a looser match: any span,
   of no more words than the name, that `soundsAlike` one of the name's
   written forms and is 0.6 to 1.6 times its length. (A span with more words
   than the name swallows a neighbour: "in peel" → "Peel".) The looser match
   reaches "Call itoy", "Coolitoy", "Stack Whoop", "Tori" and "KP", and also
   "Mark" → Mike and "John" → Jen.
3. **Audio Δ** = fit(sentence with the name) − the better of fit(sentence as
   typed) and fit(sentence with the span title-cased), on TDT 0.6B at λ = 1.
   The clip is encoded once and every candidate is scored against that
   encoding. Title-casing the span means a capital letter alone is no
   evidence for the name.
4. **Text Δ** is today's rewrite test on the same candidate: the 1.7B's
   in-context score with the name minus without it, less
   `SAME_SOUND_MARGIN` when the span is a lower-case word that sounds the
   same. Today's fixer is `rewrite()` itself, run on the same transcript.
5. **Scoring.** Only vocabulary names are counted. A written form the speaker
   said and the transcript lacks is "needed". Gaining it is a true positive.
   Gaining a written form the speaker did not say is a false positive.
   *Exact* means a clip has no false positive and no false negative.

**Test set.** The new set has 14 sentences. The vocabulary holds only names:
Paul Itoi, Kathryn O'Brien, Stadeum, Supabase, Stakwork, P8 and Mike.

- Positives: "My boss is called Paul Itoi", "Ask Paul Itoi about it", "Paul
  Itoi will review the deck on Monday", "Kathryn O'Brien is my wife",
  "Deploy it to Stadeum", "We use Supabase", "I work for Stakwork", "Ship
  P8 by Friday".
- Negatives: "I met Paul Etoy…", "I met Paula Toy…", "We watched the game
  at the stadium", "The pH of the water is high", "I'll call Mark tomorrow",
  "My son wants a toy for his birthday".

The test also runs the 48 cases.jsonl fix cases that have a vocabulary word
and a sensible audio version. The fillers, doubled words, self-corrections
and `n-lsat-off` are left out. That makes 62 sentences × 5 voices = 310 clips
per speech model.

### Results (310 clips per speech model)

| policy | Parakeet: P / R / exact | Kroko: P / R / exact |
|---|---|---|
| **text only: today's `rewrite`, 1.7B** | 0.86 / 0.72 / 0.82 | 0.87 / 0.68 / 0.77 |
| audio only, rewrite when Δ ≥ −2 | 1.00 / 0.40 / 0.75 | 0.91 / 0.51 / 0.71 |
| audio only, Δ ≥ 0 | 1.00 / 0.29 / 0.71 | 0.93 / 0.39 / 0.67 |
| audio Δ ≥ −2, plus the text test on lower-case spans | 1.00 / 0.34 / 0.72 | 0.95 / 0.46 / 0.70 |
| today's text test, audio veto at Δ < −12 | 0.91 / 0.64 / 0.81 | 0.94 / 0.65 / 0.79 |
| today's text test, audio veto at Δ < −8 | 0.91 / 0.54 / 0.78 | 0.95 / 0.57 / 0.75 |
| looser candidates, text test, no audio | 0.72 / 0.85 / 0.81 | 0.71 / 0.80 / 0.73 |
| **looser candidates, text test, audio veto at Δ < −12** | **0.90 / 0.76 / 0.85** | **0.86 / 0.77 / 0.81** |
| looser candidates, text test, audio veto at Δ < −8 | 0.93 / 0.63 / 0.82 | 0.91 / 0.67 / 0.78 |

Split by set, for today's fixer → looser candidates + veto at −12 (exact):
on the cases.jsonl fix cases, Parakeet goes 0.83 → 0.89 and Kroko 0.77 →
0.81. On the 14 new sentences, Parakeet goes 0.79 → 0.73 and Kroko 0.80 →
0.79.

**Audio cannot be the trigger.** A vocabulary name almost never fits
*better* than what the speech model typed. On Parakeet's own transcripts,
the scorer is the model that chose that spelling. The best Δ for "Paul Itoi"
over "Paulatoy" / "Paula Toy" / "Paul Latoy" runs from −16 to +5, with
median −2 to −3. "Stackwork" → "Stakwork" runs −8 to −15, the encoder
spelling bias already seen when learning. Kroko's transcripts are scored by
a different model, and there the name does sometimes win (up to +21), but
not reliably. At every threshold, audio as the trigger has about half of
today's recall.

**Today's text fixer already does most of the job.** With "Paul Itoi" in
the vocabulary as a Person, `rewrite` turns "Paulatoy", "Paulitoy", "Paula
Toy", "Paul Litoy", "Paulidoy", "Paul Itoy", "Paul Etoy" and "Paul A toy"
into Paul Itoi on 10 of 10 clips of each of the first two sentences, on both
speech models, with nothing learned. It misses only where `recall` does not
offer the span ("Call itoy", "Call It Oy", "Coolitoy", "Paul Italy"). The
premise is half right: learning can't keep up, but the in-context rewrite
mostly doesn't need it to.

**What the audio is good for: a veto.** A different-sounding word fits far
worse:

| should not rewrite | audio Δ | text Δ |
|---|---|---|
| pH → P8 | −14 to −24 | −3 to +0.3. Today rewrites Kroko's "PH" on 6 of its 10 clips |
| Tory → Tauri ("the Tory party") | about −14 | +1 to +3. Today rewrites it on 9 of 10 |
| strut ("strot") → Strut | about −14 | +7.5 |
| Mark → Mike (looser match only) | −9.5 to −13.5 | +9.3: the text test **would** rewrite it |
| John → Jen (looser match only) | −9 to −13 | −0.1 to +1.1 |

The looser candidates find real misses ("Tori" → Tauri on 9 of 10 clips,
"KP" → KPI, "BDC" → BTC, "B8" → P8, "Call itoy" → Paul Itoi). On their own,
they let the text test rewrite Mark to Mike, and precision falls to 0.72.
The audio veto takes most of that back. But the gap is not clean.

**The veto threshold has no safe value.** The true "Stackwork" → "Stakwork"
sits at −8 to −15. That is as low as Mark → Mike (−9.5 to −13.5) and Tory →
Tauri (about −14). At −12, the veto still lets Mark → Mike through on 6
clips and John → Jen on 5. It also blocks Stackwork → Stakwork on 14 clips
where today's fixer gets it right. At −8, it blocks the close names but
loses most of the Stakwork rewrites and recall drops to today's level or
below. Compared clip by clip with today's fixer, looser candidates + veto
at −12 fixes 53 clips and breaks 33.

**What sound cannot tell.**

- "Paula Toy" or "Paul Etoy" said as a different person. Audio Δ is −7 to +3
  against the positives' −16 to +21, so audio cannot separate them. The text
  test always prefers the known name (+20 or more). Neither can tell, and
  both rewrite. That is arguably right when the user knows a Paul Itoi and no
  Paula Toy, but it is a policy choice, not a measurement.
- "Stadium" against Stadeum. `say` says "Stadeum" differently from
  "stadium". So "the game at the stadium" scores −9 against the name while
  "deploy it to Stadium" scores −5 to +3. A real speaker says both the same
  way, so on a real voice this is a homophone and only the text test (with
  its same-sound margin) can decide.
- "a toy" against Itoi. Neither matcher offers the span, so it is never a
  candidate.

### Latency and memory (M2 Pro, CPU, 2 threads; clips 1.7 s median)

| per transcription | p50 | p95 |
|---|---|---|
| sherpa Parakeet transcribe (today) | 87 ms | 119 ms |
| ONNX encode (log-mel + encoder) | 93 ms | 129 ms |
| ONNX greedy TDT decode from that encode | 3 ms | 5 ms |
| audio score, all candidates (2 per clip median, 4 max) | 16 ms | 48 ms |
| per candidate | 12 ms | 21 ms |
| today's text `rewrite` on the 1.7B (already paid) | 66 ms | 107 ms |

- **Reusing the encode.** Sherpa does not expose its encoder output, so with
  sherpa transcribing, the scorer encodes the clip a second time. That adds
  about 90 ms for a sentence, and 0.6 s for a 12.5 s clip. If Parakeet
  transcription runs on the ONNX path instead, one encode serves both. The
  stateful greedy decode added to `audio-score.ts` takes 3 ms after the
  encode, and the audio check then adds only the 16 to 48 ms of scoring.
  Scoring is O(T·U), so on long dictations each candidate has to be scored
  on its sentence, cropped by the word timestamps. Uncropped, one text on a
  21 s clip costs about 400 ms.
- **Parity.** The ONNX greedy decode typed exactly what sherpa typed on 276
  of 310 clips. Most differences are casing or punctuation ("Hive Mind" /
  "Hive mind"). A few are words, in both directions ("Call itoy" / "Paul
  Itoy", "Paul Itoi" / "Paul Atoy"). They likely come from the feature
  front end (dither, padding). Closing that gap needs a parity pass before
  the ONNX path could replace sherpa.
- **Memory** (process RSS added, after four clips):

  | | resident |
  |---|---|
  | sherpa Parakeet 0.6B (today) | +1.17 GB |
  | onnxruntime Parakeet 0.6B, transcription only | +1.15 GB |
  | onnxruntime Parakeet 0.6B, transcription + scoring | +1.17 to 1.29 GB (two runs) |
  | sherpa + a separate scorer | about +2.3 GB |

  Running Parakeet users' transcription through the ONNX path gives one copy
  at today's footprint. The earlier 1.7 to 1.8 GB figure for the scorer was
  inflated by the script reading every model file into memory. Kroko users
  would need the 661 MB download and +1.2 GB for the scorer alone.

### Recommendation

**Don't build an audio-triggered rewrite.** Audio alone has about half the
recall of today's fixer, because a name rarely fits better than the speech
model's own spelling.

**Don't build the audio veto yet either.** It is the one shape that beats
today on the fix cases (exact 0.83 → 0.89 on Parakeet, 0.77 → 0.81 on Kroko).
It pays off only together with looser candidates. And on `say` audio no
threshold separates a respelt brand ("Stakwork", −8 to −15) from a close
different name (Mark → Mike, −9.5 to −13.5). On real voices the gap was
narrower still when learning. At about 1.2 GB for Kroko users, or a sherpa
replacement for Parakeet users, it does not earn its cost yet.

What to do instead, in order:

1. **Loosen `recall` for multi-word Person names on the text path alone.**
   Offer spans whose surname part sounds like the name's ("Call itoy",
   "Coolitoy", "Paul Italy"), and keep the one-word looser matches out
   (that is where Mark → Mike and John → Jen come from). That is where
   today's "Paul Itoi" misses are, and it needs no audio.
2. **Fix the text test's two known false rewrites,** "the Tory party" →
   Tauri and Kroko's "PH" → P8. The audio rejects both by wide margins
   (−14, −14 to −24), but a lower-case or capitalised everyday-word check
   may be enough.
3. **Revisit the veto only if Parakeet transcription moves onto the ONNX
   path** for its own reasons (one model copy, word timestamps,
   encoder access). Then the veto costs 16 to 48 ms and no memory, and can
   run in shadow next to the text test at about −12. Refit it on real
   recordings of Tom's names before it vetoes anything.
