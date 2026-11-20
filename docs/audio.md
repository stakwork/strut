# Speech, dictation and voice

Speech-to-text, text-to-speech, dictation's vocabulary and fixer, and the voice service route.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Files

What each file and folder in this area is, in the order of the tree.

### `fixer/`

node-llama-cpp for dictation's fixer (src/audio/fixer.ts), a package of its own (fixer/package.json, fixer/yarn.lock) so no install of strut carries it — its CUDA and Vulkan builds are ~740 MB on Linux — and only the desktop package does (scripts/package-desktop.mjs stages it at fixer/; `--no-fixer` leaves it out). `index.js` re-exports it for the fixer's worker, which imports that file by path (`fixerRuntime`); `check.ts` holds the real package to the shape fixer-engine.ts types by hand (`npm run check:fixer`, run by the desktop job). Install: `yarn --cwd fixer install --frozen-lockfile --ignore-scripts`, never from `prepare` (mcp runs it). Without it there is no fixer: dictation/models lists none, dictation/use refuses one, transcription and learning take the no-fixer path

### `src/voice.ts`

`POST /voice/calls` (plans/private-voice.md §4.1): a person's call set-up handed to the voice service beside strut (`STRUT_VOICE_URL` + `STRUT_VOICE_TOKEN`, `createStrut({ voice })`) — the body unchanged (≤ 16 KB, 413 over), the person as `x-strut-actor`, the shared token as the bearer, its status and body back unchanged; a person token or the deployment key with an actor, 503 unconfigured or unanswered (15 s). A route, not a workflow: the body and answer hold the call key and room tokens, so nothing of either is logged or kept. `warmSpeech`, from `listen()` when a voice service is set: the recognizer `/audio/transcribe` picks (over silence) and Kokoro (one word), downloaded and loaded in the background so a call's first turn waits for neither

### `src/steps/lib/dictation/`

dictation/models, dictation/use { speech?, fixer? (null: none) }, dictation/remove-model { id } (refused for an active model or the default speech model): the dictation model picker over `ctx.services.stt.dictation` (src/audio/dictation-models.ts), each answering `{ models: [{ id, kind, name, summary, recommended, bytes, description, state, progress?, downloaded?, selected, active, removable, error? }] }`; dictation/enable { ref_id, on } turns dictation off/on for one entity (the `dictation` attribute memory/lexicon reads)

dictation for any client (plans/native-dictation-client.md §7a). The vocabulary: add (by hand), remove (a mishearing, or a lingo-type word with all of its), undo (forget reason undone). correction: { typed, edited } → { learned: [{ heard, written, undo }] }: what the user's edit of dictation's text teaches — audio/lingo.ts `mishearings`, judged by the user's fixer model (nothing learned with none installed, or one that takes longer than the timeout once loaded) — each mishearing written through memory/remember as the pair alone (never the sentence) on the entity that writes it or a new word of the lingo type; undone pairs and dictation_off words never. The models: models, use, remove-model over `stt.dictation` (_models.ts). _shared.ts: `readLexicon` (what /audio/transcribe reads) and `learn`

### `src/audio/`

speech-to-text over sherpa-onnx (plans/local-desktop-and-stt.md §4), and text-to-speech the other way (plans/private-voice.md §3.3). Streaming dictation is the product surface; workflows learn AROUND it (hotword lists, "dream cycles" §4.8), no STT step in v1

### `src/audio/stt.ts`

createStt(): models (download.ts), the dictation picks (`stt.dictation`) and the fixer they pick (`stt.fixer`, fixer.ts), hotword lists, streams (PCM in → partial/final out; `push` / `end` are async, a round trip to the recognizer thread) and their session log, two-recognizer mode (fast greedy partials + hotword-capable finals), batch transcribe (the caller's `model`, else the user's installed speech pick, else `STRUT_STT_MODEL`; an `offline` model — Parakeet — decodes the whole clip in one pass and cannot stream); the recognizers run in a WORKER THREAD (decoder.ts over `ModelWorker`); sherpa is an optionalDependency, lazy-imported in the worker; an injected `engine` (tests) runs in process, `engineModule` swaps the worker's

### `src/audio/decoder.ts`

what runs in the recognizer thread: the sherpa engine surface (OnlineRecognizer, and OfflineRecognizer for an offline model), one recognizer per (model, hotwords hash, score, endpoint rules), each stream's decode loop (partials, endpoints, finals, words), and `transcribe`'s whole pass over a WAV — a recognizer's streams must live on the thread that built it, so building and decoding are both here

### `src/audio/tts.ts`

createTts(): text-to-speech, the speaking half of a voice conversation — Kokoro (`TTS_MODELS`, downloaded on first use by download.ts into STRUT_MODEL_DIR/tts/<id>) and `speak(text, { voice?, speed?, model?, signal? })` → `{ sampleRate, voice, audio }`, `audio` mono 16-bit PCM a piece per sentence as it is generated; a bad request is a `SpeakRequestError` before any model loads; the model runs in a WORKER THREAD of its own (synthesizer.ts over `ModelWorker`), never queued behind a dictation decode; aborting the signal, or leaving the loop, stops the speech; sherpa is the same lazy optionalDependency; an injected `engine` (tests) runs in process, `engineModule` swaps the worker's

### `src/audio/synthesizer.ts`

what runs in the speech thread: sherpa's OfflineTts (built once per model, `lang: en-us` so espeak-ng reads the text and no lexicon is loaded, `maxNumSentences: 1`, up to four intra-op threads) and one generation at a time, each pulled by the main thread a sentence per `next` call from `generateAsync`'s `onProgress`. A stop is heard by sherpa only when a sentence ends, after it began the next: up to two sentences are generated for nothing

### `src/audio/models.ts`

catalogs: STT_MODELS (id → release URL + sha256 + chunk latency + hotwords? + offline?; STRUT_MODEL_DIR/stt/<id>), FIXER_MODELS (Qwen3 0.6B / 1.7B GGUF Q4_K_M on llama.cpp, each with its learn margin; the 1.7B is the default to offer; STRUT_MODEL_DIR/fixer/<id>), and DICTATION_MODELS — what a user picks from: Kroko + Parakeet TDT 0.6B v2 (offline) as speech, the fixers (plans/dictation-models.md); TTS_MODELS (Kokoro v1.0 fp32, its voice table by speaker id, `af_heart` the default; the int8 export was half the speed on CPU; STRUT_MODEL_DIR/tts/<id>)

### `src/audio/download.ts`

the ONE model downloader: fetch, sha256, extract a .tar.bz2 (`tar xjf`) or keep a single file, `.ok` marks it installed; concurrent installs of one dir share a download

### `src/audio/dictation-models.ts`

the user's picks (speech, fixer or none) in <dataDir>/audio/dictation.json, each model's state (available / downloading with progress / installed); a pick not on disk downloads in the background and is used once installed; the dictation/models, use, remove-model steps are thin over it

### `src/audio/hotwords.ts`

contextual biasing: list format, synthesized bpe.vocab from tokens.txt (REQUIRED with modelingUnit "bpe" — unset = cjkchar = silent no-op), named lists under <dataDir>/audio/hotwords

### `src/audio/sessions.ts`

<dataDir>/audio/sessions/<id>.jsonl: finals + user corrections (the dream cycle's training data)

### `src/audio/ws.ts`

GET /audio/stream WebSocket (raw `ws` on the Node server — @hono/node-ws doesn't support node-server 2.x); Bearer or ?key=; a socket's stream calls (open, every push, end) run one after another, so audio reaches the recognizer in order

### `src/audio/lingo.ts`

dictation's vocabulary pipeline, pure over a `Lexicon` and a `Fixer` (plans/dictation-models.md): code finds and builds, the model only scores. `recall` (1–3-word spans fuzzy/sound-alike against every entry's heard and written forms; an exact past mishearing beats the same letters beats near, then the shortest span), `rewrite` (a candidate kept when the sentence with the word scores likelier than as heard, in its own capitals too; fillers and doubled words by rule with an exception list; a taken-back phrase when the fixer names `{ wrong, cue }` and code finds it before the cue; edits carry their offset), `heardOnly` (no fixer: exact learned mishearings only), `mishearings` (a word-level diff, each change of ≤ 4 words a side that `soundsAlike` asked yes/no; never an undone pair or an off word), memory/remember's input for a learn (`learnInput`, `undoIds`)

### `src/audio/fixer.ts`

`DictationFixer`: the user's picked fixer (`DictationModels.fixerModel`) in a ModelWorker of its own, loaded on first call, swapped when the pick changes, unloaded after 5 minutes idle; `within` + FIX_TIMEOUT_MS (1.5 s) for the callers' fallback; `fixerRuntime`: node-llama-cpp's way in, fixer/index.js when fixer/ is installed (the desktop package, a checkout that ran its install), else null — no fixer here

### `src/audio/fixer-engine.ts`

what the fixer's worker runs: the judge / take-back prompts (Qwen3 ChatML, thinking off) and node-llama-cpp (Metal, GGUF; imported by the path the worker is handed, the part it calls typed here as `LlamaLib`, which fixer/check.ts checks against the real package) — `judge` (log P(yes) − log P(no), one forward pass), `score` (log-likelihood after "Dictated by someone who often mentions X"), `retract`; one sequence per task so each fixed prefix stays cached; imports only types from strut so the worker loads it alone

### `src/audio/dictation-eval/`

cases.jsonl (learn + fix cases, synthetic) and run.ts — `npm run eval:dictation`, opt-in: the real pipeline and DictationFixer against the GGUFs in ./.models/gguf (gitignored), with fixer/ installed; precision, recall, p50/p95, load time

### `src/audio/routes.ts`

/audio/models (+ SSE download), /audio/transcribe (WAV body; `text` with the vocabulary applied by the fixer, read per call from memory/lexicon, `heard` + `changes` when it changed, `fixer` the model used or null — none, or slower than 1.5 s: fillers and doubled words by rule, exact learned mishearings of two or more words only; `?lingo=0` skips it), /audio/hotwords/:name, /audio/sessions/:id (+ corrections); `speakRoutes`: GET /audio/speak (the TTS models, their voices, `installed`), POST /audio/speak ({ text, voice?, speed?, model? } → `audio/pcm` s16le mono at `x-sample-rate`, streamed a sentence at a time; JSON errors only before the first sentence; a hang-up aborts the speech)
