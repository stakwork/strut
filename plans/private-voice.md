# Private voice: talk to your org's agent, and no one else hears

> **Status (2026-11-03): proposed.**
> - Built so far: `POST /audio/speak` on `feature/audio-speak` (not merged; §3.3). Nothing else is built.
> - Rows marked **agreed** under "Decided" are the owner's, from the design conversation of 2026-11-03. Everything marked *proposed* is mine and open.
> - Read against: strut `main` @83e7675, peel `main` @324588a, sphinx `master` @74c12954, sphinx-voice `main` @ebbe0c5, meet `main` @fd63ca1.
> - Companions:
>   - `org-home-swarm.md`: the org's home, which this plan's TEE is (§9);
>   - `org-gateway.md`: the org's Bifrost;
>   - `chained-orchestrators.md`: pairing, person tokens;
>   - `local-desktop-and-stt.md` and `dictation-models.md`: strut's speech recognition and its vocabulary;
>   - `live-feeds.md`, `federation.md`.
> - The research behind it was done the same day: NEAR AI's TEE stack, the open-source field, TEE attacks, Tinfoil, LiveKit, and the Sphinx mixer. Every finding this plan relies on is restated here with its source.

## Goal

A member of an org opens the org's agent (Jamie) in Peel, taps **Talk**, and
has a natural spoken conversation with it. The member's phone and attested
code are the only places the audio and the words are readable. The member
pays in sats over Sphinx.

"End to end" means phone to attested code, not phone to phone. The agent has
to hear the member in order to answer, so the promise is about everyone else:
- The operator (Stakwork), the host and any relay in the path never read the
  audio or the words.
- §11 lists what each of them still sees.
- Other members of the same org are not part of the promise at first (§3.6).

## Decided

| Question | Decision |
|---|---|
| Goal | **agreed.** End-to-end encrypted, Lightning-gated voice, phone → cloud → phone, natural enough to hold a conversation. |
| Who a TEE serves | **agreed.** One org's members. The TEE is the org's home (`org-home-swarm.md`), not one VM per person. |
| Privacy between members | **agreed.** Not required at first. Keep it easy to add later (§3.6). |
| Where speech runs | **agreed.** In the TEE, not on the phone, because there we can customize it, starting with strut's vocabulary (its lexicon). |
| Who answers | **agreed.** The orchestrator, set up to be quick: it answers at once without tool calls, and starts a job in the background when the request needs work. |
| Payments | **agreed.** Sphinx's own rails. |
| Inference provider | **agreed.** Tinfoil directly, once we need attested GPUs, with no reseller in between (PPQ). Not in the first steps. |
| Order | **agreed.** UX first: Peel plus a docker-compose with everything on one machine, tested locally. Then one step at a time. This plan is settled before any code. |
| Voice agent | **agreed.** A second entry point in sphinx-voice, in Node: a 1:1 mode with no wake word (§3.5). |
| Speech stack | **agreed.** Speech runs on CPU in the TEE, both ways through strut's sherpa: Kroko for recognition, Kokoro for synthesis (`/audio/speak`, built). Only the LLM needs a GPU, and that's a provider's. |
| Topology | *proposed* (§2). LiveKit stays central, the audio is end-to-end encrypted, and the voice agent connects outward. |
| Call set-up | *proposed* (§4). Over HTTPS to the org's home, with the member's person token. Not over Sphinx, and not as a workflow run. |
| Each member's own thread | *proposed* (§3.2). A member's voice turns run as that member, on a session of their own. |

## 1. The shape

```
Peel (a member's iPhone / Mac)
  │  1. HTTPS to the org's home, with the member's person token: start a call
  │  2. encrypted audio: LiveKit frame encryption, a fresh key per call
  ▼
LiveKit server (livekit.sphinx.chat): forwards ciphertext it cannot read
  ▲
  │  outbound only
the org's home   (step 1: a Mac on the same Wi-Fi · step 4: an Intel TDX VM)
  voice service  LiveKit Agents (Node): one job per call, many calls at once
  strut          speech both ways on CPU (sherpa: Kroko + the lexicon, Kokoro),
                 orchestrator turns run as the member, jobs, the sats ledger
  Jamie          the org's Sphinx account (sphinx-daemon): invoices, tribes
  (step 5)       → Tinfoil enclaves for the LLM, body-encrypted (EHBP)
```

A turn:
1. The voice service detects that the member has finished speaking.
2. It sends that stretch of audio to strut and gets the text back.
3. It runs an orchestrator turn as the member, on the member's voice session.
4. It streams the reply into speech and back into the room.

If the reply started a job, the job's end comes back as a callback and the
agent says the result. The member can interrupt at any time.

## 2. Why LiveKit stays central

- **Phala Cloud has no inbound UDP.**
  - Its gateway only proxies TLS over TCP, routed by SNI (dstack
    `gateway/src/proxy.rs` L243–271). Phala documents UDP inbound only as
    "NAT traversal".
  - A LiveKit server there would carry every call over TURN/TLS on 443. That
    means head-of-line blocking, slower set-up and a gateway hop.
  - On our own dstack host a UDP port mapping works (`vmm/src/config.rs`
    L84–102), but that covers only one kind of host.
- **A LiveKit agent can join an end-to-end encrypted room.**
  - LiveKit documents this (docs.livekit.io/transport/encryption/agents.md:
    "A LiveKit agent is just another participant").
  - Agents connect outward, and outbound UDP works everywhere, Phala
    included.
  - Peel's LiveKit Swift SDK (2.10.2) has frame encryption
    (`EncryptionOptions`, since 2.8.0 for data).
- **Moving the media server into the TEE would hide nothing more.** Any server
  on the media path, central or in the home, and any relay on the way sees the
  same things:
  - participants, packet timing and packet sizes (Opus is variable bitrate);
  - a per-packet loudness level, carried in a cleartext RTP header extension
    (RFC 6464) that LiveKit negotiates and reads on every packet
    (`livekit:pkg/sfu/buffer/buffer_base.go`).
- **One server for every org.** We already run `livekit.sphinx.chat`. A media
  server per org home would be one more thing in every TEE.

So: a central media server, end-to-end encryption with a fresh shared key per
call, and the voice service connecting outward. Step 1 runs its own
livekit-server on the LAN instead, with encryption off. The voice service's
code is the same either way.

**Metadata hygiene from step 2:**
- Turn off DTX (silence suppression) on both sides, so packets keep a
  constant rate.
- Turn off Opus RED on the phone. The Swift SDK leaves it on under
  encryption (`LocalParticipant.swift` ~L849). The JS and Rust SDKs turn it
  off.
- Give each call random participant identities.

No SDK exposes Opus constant bitrate, and dropping the audio-level extension
needs a server patch. Both are later items (§8).

## 3. The voice turn

### 3.1 The orchestrator, set up for speech

Today a turn that starts a job takes about 16 s to say "On it" (swarm38,
2026-10-29, `plans/live-feeds.md:26`), and one with a lookup took 31 s. The
time goes on four things:
- Sonnet 5.5 at reasoning `medium`;
- a `job/start` tool call, which costs a second model call after it;
- the per-turn setup steps;
- a reply that arrives only at `run.end`.

Five changes. The first three help text turns too.

1. **Start the job from the reply, not from a tool.**
   - The reply schema (`src/workflows/orchestrator.yaml`, the `turn` step:
     `text`, `artifacts`, `ask`) gains an optional `start` (brief, title,
     kind, workflow).
   - A `job/start` step after the agent starts it, so a turn is one model
     call.
   - The `job/start` tool stays, for a turn that starts several jobs.
   - The job inherits the launching run's `jobCallback` (`specs/CALLBACKS.md`
     §5), so its end reaches the voice service.
2. **`params.reasoning`.** The template fixes reasoning today. Make it a
   param, and run voice turns with it off.
3. **A fast model, picked per launch.** The voice service launches with
   `params.model`, which is a knob, not a grant (`src/closure.ts`
   `grantWidenedBy` guards only tool grants).
   - Steps 1–4: a fast hosted model, e.g. Haiku 5.5.
   - Step 5: Tinfoil's `gemma4-31b` with thinking off.
4. **The voice instructions go in the turn.**
   - They ride on `input.context.line`, the per-turn line callers already
     send (`sphinx:runner/src/bridge/turns.rs:41-56`): "On a voice call:
     answer in a sentence or two, the way you would say it."
   - A session freezes its system prompt at its first turn. If a member's
     voice thread ever shares a session with their chat (Q12), the voice line
     must not be in the system prompt.
5. **Stream the reply** (§3.4), so speech starts on the first clause instead
   of after the whole reply.

Setup steps on later turns: the two `context/concept` reads feed only the
system prompt, which is frozen after the first turn. They cost milliseconds
on Ladybug, so leave them unless step 1 measures otherwise. `strut/list-peers`
feeds the per-turn prompt and stays.

Estimate, not measured: the model's first token 0.3–0.6 s with a warm
prompt cache, then the first clause about 0.15 s later.

### 3.2 Each member's own thread

- **The turn runs as the member.** The call route knows the member from their
  person token (§4), and the voice service launches every turn of that call
  with the member as the actor (`x-strut-actor`). The turn uses the member's
  delegation and their GitHub token, as Hive's call turns run as their speaker
  ([stakwork/hive#5699](https://github.com/stakwork/hive/pull/5699)).
- **A session per call:** `<member>/voice/<room>`, inside the person-scoped
  namespace strut already gives a person token (`peerSessionId`,
  `src/session-store.ts`). Ruled 2026-11-03: a fresh session each call, not
  one per member. A session freezes its system prompt at its first turn, so
  one long voice thread never heard a change to the orchestrator's text (it
  kept answering "I'm Claude" after the lab named it Jamie). Earlier calls
  stay in strut's session store and the graph, where the orchestrator can
  find them.
- **One turn at a time per session** (`session_busy:`). Two members talk at
  once on different sessions. The same member on two devices waits a turn.
- **Sharing with the member's Jamie chat** would put calls and chat in one
  memory. That's Q12.

### 3.3 Speech in the TEE

**Recognition: strut's own** (`src/audio/`: sherpa-onnx, Kroko, NeMo).
- LiveKit's voice-activity detector cuts each utterance.
- A small agents-js STT plugin (about 150 lines) sends the utterance to
  strut, over `/audio/stream` or `/audio/transcribe`, and reads the final
  text.
- Measured on a Mac (`plans/local-desktop-and-stt.md:331-375`):
  - the final lands about 300 ms after `end`;
  - Kroko decodes at about 1.5% of real time;
  - a recognizer is built in about 1.3 s on its first use and is warm after
    that.
- Accuracy is unmeasured; strut records no word error rate anywhere. Step 1
  measures it on our own voices. The fallback is Parakeet, an offline model
  strut already offers (`src/audio/models.ts:108`).
- Send audio at the stream's own rate (16 kHz). A rate change makes sherpa
  exit the process. strut guards against it, but the plugin should resample
  before sending.

**The vocabulary.**
- strut's lexicon lives in its memory graph, one per strut. On an org home
  that's the ORG's vocabulary: its people, products and jargon. A member's
  personal vocabulary is Q11.
- The exact mishearings strut has learned apply instantly: lingo's
  `heardOnly`, which needs no fixer model.
- The fixer pass, with its 1.5 s timeout (`src/audio/fixer.ts`), is too slow
  for the speaking path. Skip it there, or run it on the transcript
  afterwards.

**Synthesis: Kokoro inside strut. Built** on `feature/audio-speak`.
- **The route.** `POST /audio/speak { text, voice?, speed? }`.
  - It returns 16-bit mono PCM at 24 kHz, with `x-sample-rate` and
    `x-voice` headers.
  - Each sentence is sent as Kokoro finishes it: sherpa's `generateAsync`
    reports sentence by sentence.
  - A hang-up stops the generation.
  - `GET /audio/speak` lists the model and its 54 voices.
- **The model.** Kokoro v1.0 fp32, pinned by sha256 and downloaded on first
  use. The int8 export ran at half the speed on CPU.
- **Measured** on 4 CPU cores:

  | Request | First audio | Real-time factor |
  |---|---|---|
  | Two sentences, Mac | 367 ms | 0.23 |
  | Two sentences, Docker with 4 CPUs and 8 GB | about 360 ms | 0.22 |
  | One clause ("Sure,") | about 0.17 s | — |

  - The live test transcribed its own output back through Kroko, exactly.
  - These are Apple M4 cores. The TEE's Intel vCPUs are untested.
- **What it means for the voice service.** Send one clause or sentence per
  request.
  - It keeps the first audio near 0.2 s.
  - It bounds cancellation: sherpa only checks for a stop between sentences,
    so a hang-up mid-reply costs the sentence in flight plus the next.
- **Pronunciation.** sherpa 1.13.7 ignores Kokoro's lexicon files for English
  (espeak-ng reads every word). To pronounce names from the vocabulary right,
  respell them in the text before synthesis, or edit espeak-ng's dictionary.
- **Fallback.** Kokoro-FastAPI's CPU image, behind agents-js's OpenAI TTS
  plugin: the same model, run another way.

**Capacity: one generation at a time.**
- strut's synthesizer runs one generation at a time on 4 threads. When three
  members' agents speak at once, the third waits for two sentences.
- An org home must be sized for its concurrent calls: more cores, or several
  synthesizer workers sharing them.
- Step 1 measures two and three concurrent calls.

**Turn-taking.**
- Silero for voice activity (`minSilenceDuration` 550 ms) plus LiveKit's
  turn detector, a local ONNX model.
- Interruptions on (`allowInterruptions`, 500 ms).
- Preemptive generation off at first: it would start orchestrator turns on
  partial transcripts. Revisit once measured.

### 3.4 Streaming the reply

**Today.**
- The orchestrator's agent runs in schema mode. The reply is the `text` field
  the model writes into the `final_answer` tool's input.
- The caller gets it at `run.end`, and nothing streams.
- `GET /workflows/:name/runs/:runId/stream` already follows a run over SSE.
  It re-reads the run log every 250 ms (`src/store.ts:80`).

**The change, in four pieces:**

1. **Tap the reply in the agent step.**
   - Every stream the step reads goes through `streamFailure`
     (`src/steps/core/agent.ts:639`): the main loop, the nudge, the forced
     answer. So one hook covers them all.
   - Schema mode: the `tool-input-delta` parts of `final_answer`. Parse the
     partial JSON for `text` (`parsePartialJson`, exported by `ai`) and pass
     on only what is new.
   - Text mode: `text-delta`.
   - Opt-in with `stream: true` on the agent step. The orchestrator sets it
     from `params.stream`, so other agents' logs don't fill with deltas.
   - `text` goes first in the reply schema, so it streams before `start` and
     `artifacts`.
   - Deltas are keyed by the tool call. If the model makes a new
     `final_answer` call (a refused one, a resumed stream), it says so with
     `reset: true`.
2. **A `reply.delta` run event**, `{ path, call, text, reset? }`, sent through
   `ctx.emit` and grouped about every 50 ms. A short reply is 10–20 small
   events.
   - Kept in the run log, so the record shows what was said before an
     interruption.
   - The events sink only sends allowlisted envelope fields
     (`src/events-sink.ts`), so the text never leaves the TEE.
   - The UI's event panel and the folds (`kit/src/folds/`) skip it.
3. **Wake the reader when an event lands.**
   - The run store signals its live tails on every `append`, and the 250 ms
     poll stays as the fallback.
   - Every live viewer then gets each event within milliseconds.
4. **The voice service consumes it.**
   - It launches the turn, gets back `{ runId }`, and opens the same SSE
     stream.
   - Its `llmNode` yields each delta at the turn step's path into LiveKit's
     sentence tokenizer, which feeds `/audio/speak` a clause at a time.
   - At `run.end` it reads `start`, `artifacts` and `ask` from the output.

**What it saves.**
- Without it, the member waits for the first token, then the whole reply
  (0.4–0.8 s for two sentences), then `run.end`, then up to 250 ms of
  polling.
- With it, they wait for the first token and the first clause, plus a few
  milliseconds.

**The risk: whether the provider streams a tool call's input in pieces.**
- Anthropic called directly: yes. aieo turns eager input streaming on by
  default.
- Through Bifrost: not verified.
- Tinfoil's vLLM: not verified. Some vLLM tool parsers hold a call's
  arguments back until they're complete.
- **If `text` comes in one lump,** voice turns switch to text mode, which
  streams everywhere. The model says the reply as plain text, and a job is a
  `job/start` call after that text, in the same message. A session takes a
  different output mode per turn.
- Step 1 measures each provider, and the result decides it.

**Interruptions.**
- When the member cuts in, the voice service stops speaking but lets the turn
  finish. Cancelling it would commit nothing, and the session would lose the
  member's words too.
- The next turn's context line says where the reply was cut ("you were cut off
  after: …"). LiveKit's speech handle knows how much was played, so the agent
  knows what the member actually heard.

**Size:** about 60 lines in `agent.ts`, about 30 in `store.ts`, the event
type, and tests. It helps every surface that follows a live run, not just
voice.

### 3.5 The voice service: a new 1:1 mode, not meeting Jamie

sphinx-voice today is a meeting listener:
- it transcribes everyone and waits for the wake word "jamie";
- a Haiku call decides whether someone asked for something;
- replies come back on a long poll;
- its speaker can't be stopped.

Its commit `3cf4e90` removed LiveKit's `voice.AgentSession` because a session
hears one participant and answers every turn. That is exactly what a 1:1 call
wants.

**No wake word.** In a 1:1 call everything the member says is addressed to
the agent, so the end of each turn is the cue to answer.
- The meeting mode keeps its wake word and its classifier.
- When the member turns to talk to someone else in the room, they mute in
  Peel. No "was that for me?" check sits on the speaking path.

**The new mode:**
- One LiveKit job per call, many calls at once in one process.
- `AgentSession` on the member's track.
- A custom `llmNode` that runs the orchestrator turn as the member and
  streams its reply (§3.4).
- The strut STT and TTS plugins, Silero and the turn detector.
- agents-js 1.9.x (sphinx-voice pins 1.0.25).

### 3.6 Privacy between members: later, kept easy

**Today.** Any member's person token reads every route on the home: run
logs, transcripts, sessions, job files (`isPeerScope`, `src/auth.ts`). So
other members can read a member's call turns, through:
- the prompt on `run.start`;
- the transcript on `step.end`;
- the `reply.delta` events;
- the session record.

**Not now.** Hiding only the sessions would be small, but the same words sit
in run logs, transcripts and job files. A real fix scopes every read route
that serves them, and that isn't a small change.

**Kept easy for later.** Four rules hold from step 1, so that a later read
filter by actor is enough:
- Every voice run records the member as its actor (`run.start.actor`).
- The member's voice sessions live in their own namespace, `<member>/voice/<room>`.
- A job a voice turn starts carries the member as its actor, so the job's
  record lists them (`actors`, which `GET /jobs?mine=1` already filters on).
- The ledger keys balances by actor.

**The later change.** For a person token, filter the routes that serve runs,
transcripts, sessions, jobs and artifacts down to that actor's own. The app
door already does this for a sealed workflow's runs (`ownRun`,
`src/createStrut.ts`), so the pattern exists.

## 4. Call set-up

**Over HTTPS to the org's home, with the member's person token.**
- Peel already holds one per org: Hive's device pairing returns each org's
  `{ baseUrl, token }` ([stakwork/hive#5602](https://github.com/stakwork/hive/pull/5602)),
  and Peel opens org pages with it today.
- An org home has a public HTTPS address, so set-up needs no Sphinx message
  and no runner. Sphinx carries only the money (§5).

**A route, not a workflow.**
- A run records its input on `run.start`, and the run log is readable by
  every member (§3.6). The call key and the room tokens must never be in a run
  log.
- So the call starts at `POST /voice/calls`, a thin strut route:
  - it authenticates the person token, the way the gate already admits a
    person token to `/mcp`;
  - it hands the request to the voice service inside the home, with the
    member's actor;
  - it records nothing.
- Whether this route belongs in strut or in the lab is Q10. org-home keeps
  org code in the lab and gives strut only generic seams.

### 4.1 The contract

Three pieces are built against this at once: Peel, strut's route and the
voice service. Steps 2 and 4 only add fields.

**Peel → the home**

```
POST {home}/voice/calls
Authorization: Bearer <the member's person token>
Content-Type: application/json

{}                                     step 1
{ "key": "<base64, 32 bytes>" }        from step 2
{ "sealed": "<base64 HPKE envelope>" } from step 4, in place of key (§6)
{ ..., "voice": "am_michael" }         any step, optional: Jamie's voice
```

`200`:

```json
{
  "url": "ws://127.0.0.1:7880",
  "room": "sphinx.call.voice.<32 hex>",
  "token": "<LiveKit JWT for the member>",
  "identity": "<the member's identity in the room, random>",
  "agent": "<the agent's identity in the room, random>",
  "encrypted": false,
  "voice": "af_heart"
}
```

- **`url`** is the LiveKit server to connect to.
- **`encrypted`** is true from step 2. Peel then joins with `key` as the shared
  key and with Opus RED off (§2).
- **`voice`** is the voice in effect for this call.
  - It's the request's `voice` when that is a voice strut's `/audio/speak`
    has (`GET /audio/speak` lists them), otherwise a 400.
  - With no `voice` in the request: the service's `STRUT_TTS_VOICE`, else
    strut's default, `af_heart`.
  - Peel's Talk screen toggles between `af_heart` ♀ and `am_michael` ♂.

Errors are JSON, `{ error }`:

| Status | When |
|---|---|
| 400 | A bad body, e.g. a key that isn't 32 bytes. |
| 401 | No credential, or one strut can't verify. |
| 402 | From step 3: the member's balance is below the minimum. Adds `{ balance, minimum }` in sats. |
| 403 | A credential that isn't a person's, e.g. the plain peer key. A call always runs as a person. |
| 503 | No voice service configured, or it isn't answering. |

**Rules**
- **Every call is a fresh room.** Rooms and identities are random and never
  reused (§2).
- **Peel connects to `url` as returned.**
  - It's the member's own home naming it, in answer to the member's own
    authenticated request. So this path doesn't apply the call-link rule that
    media must sit on the call server's own host and port
    (`peel:Sources/PeelCore/CallServer.swift:213-219`).
  - `ws://` only on loopback, `wss://` everywhere else.
- **Hanging up is leaving the room.**
  - The voice service ends the session when the member leaves
    (`closeOnDisconnect`), and after 30 s if the member never joins.
  - A new call from the same member ends their previous one, so the newest
    device wins.

**strut → the voice service**
- **Who may call the route.**
  - A person token (`peer:person`), admitted the way the gate admits one to
    `/mcp`.
  - The deployment key, for tests. The actor then comes from `x-strut-actor`,
    as everywhere.
  - Any other peer scope is a 403.
- **What it forwards.** strut takes the actor from the credential and sends
  the body unchanged to `POST {STRUT_VOICE_URL}/calls` with:
  - `x-strut-actor: <member>`;
  - `authorization: Bearer <STRUT_VOICE_TOKEN>`, a secret strut and the voice
    service share, so nothing else on the host starts a call as a member.
- **What it answers.** The voice service's status and body, unchanged.
- **What it keeps.** It logs and stores nothing of the body or the answer:
  they hold the key and the tokens.
- **Unconfigured.** With `STRUT_VOICE_URL` unset, the route answers 503.
- **Where it lives.** If the route moves to the lab (Q10), the contract
  doesn't change.

**The voice service's `POST /calls`**
1. It checks `STRUT_VOICE_TOKEN`.
2. It names the room (`sphinx.call.voice.` + 32 random hex) and two random
   identities.
3. It mints the member's token: join this room only, publish and subscribe
   audio, update its own attributes (the `voice` below), no admin, valid 10
   minutes for joining.
4. It gets the agent into the room before it answers, so a member never talks
   to an empty room.
   - Step 1: it joins with its own token on the local server, or by worker
     dispatch there (Q7).
   - From step 2: it gets tokens from meet (private rooms), and joins with
     `encryption` and the key (§4, step 2).
5. Every turn of the call runs as `x-strut-actor` on `<member>/voice/<room>` (§3.2).
   Speech goes to strut's `/audio/transcribe` and `/audio/speak` with the
   deployment key, inside the home.

**What Peel reads in the room.** LiveKit Agents (agents-js 1.x) publish all
of it, so the call screen needs nothing from the home:
- **The agent's state:** the participant attribute `lk.agent.state`, one of
  `initializing`, `idle`, `listening`, `thinking`, `speaking`.
- **Live text from both sides:** text streams on the topic `lk.transcription`,
  with the attributes `lk.segment_id`, `lk.transcribed_track_id` (whose speech
  it is) and `lk.transcription_final`.
- **From step 2, encryption covers these** only because the agent connects
  with `encryption`, not the legacy `e2ee`.

**What Peel sets in the room: the member's participant attribute `voice`.**
- Peel sets it to change Jamie's voice mid-call. The agent switches from the
  next sentence it sends to `/audio/speak`; the sentence it is speaking ends
  in the old voice.
- An unknown name is ignored.
- Attributes go over LiveKit's signaling, which end-to-end encryption doesn't
  cover. A voice name isn't private, so that's fine; nothing private may ride
  in an attribute.

**Local values (step 1)**
- **strut:**
  - `STRUT_API_KEY` set, so person tokens can be signed;
  - `STRUT_VOICE_URL=http://127.0.0.1:<voice port>`;
  - `STRUT_VOICE_TOKEN`.
- **A person token:** `POST /peers/tokens { actor: "dev-member" }`, called with
  the API key, returns `{ token }`. Paste it into Peel's dev setting with the
  home's URL, `http://127.0.0.1:3000`.
- **livekit:** `livekit-server --dev --bind 0.0.0.0`. Its keys are
  `devkey` / `secret`.
- **The voice service:** `STRUT_URL`, `STRUT_API_KEY`, `STRUT_VOICE_TOKEN`,
  `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`,
  `LIVEKIT_API_SECRET=secret`.
- **The iPhone simulator:** it shares the Mac's network and microphone, so
  the same loopback URLs work there.

### Step 1, on the LAN

1. Peel's dev setting names the local home and a person token (§4.1).
2. Peel sends `POST /voice/calls`.
3. The voice service mints both LiveKit tokens with the dev key, gets the
   agent into the room, and answers.
4. Peel joins `url` with `token`.

### Step 2, the central server

1. Peel makes a 32-byte key and sends `POST /voice/calls { key }` (§4.1).
2. The voice service:
   - names a room (128 random bits, like `CallLink.new`, `Call.swift:150-156`);
   - asks meet for two tokens, the member's and its own;
   - joins with encryption;
   - returns the member's token, with `encrypted: true`.
3. meet needs one change: a private room gets no Jamie dispatch and no
   `isHost` admin grant. Today every token dispatches `LIVEKIT_AGENT_NAME`,
   and `?isHost=true` gives anyone room admin
   (`meet:app/api/connection-details/route.ts:30-45, 73-83`).
4. The voice service connects the room itself with `encryption` before it
   starts the session.
   - agents-js's `ctx.connect(e2ee)` passes the legacy `e2ee` field, which
     leaves transcripts and data messages unencrypted (`agents/src/job.ts`
     L478).
   - `AgentSession.start` would otherwise connect without options
     (`voice/agent_session.ts` ~L1002).
5. Use a shared key: rtc-node's per-participant keys are broken
   (livekit/node-sdks#741, fix #768 open).

Until step 4, the key crosses ordinary TLS, which the operator could read on
the home. Step 4 seals it (§6).

**Why not have the voice service register as a LiveKit worker:** that needs a
per-home API key for the central server, and a LiveKit API key is admin over
every room.

## 5. Paying in sats (step 3)

**Jamie's account takes the money.**
- The org's home already runs Jamie's own Sphinx account (sphinx-daemon,
  `org-home-swarm.md` §4.2), and the daemon already issues invoices
  (`POST /invoice`, `sphinx:wasm/daemon/README.md`).
- A top-up:
  1. Peel asks the home for an invoice (`POST /voice/topup { sats }`, with
     its person token).
  2. The home gets the invoice from the daemon.
  3. The member pays it from their own wallet.
  4. When the daemon reports the payment, strut's ledger credits that member.
- It has to be prepaid:
  - money moves only on the payer's own signed request;
  - the mixer waits only 4,200 ms for a preimage
    (`sphinx:mixer/src/interceptor.rs`), so nothing can be held for the
    length of a call.

**The ledger, in the TEE.**
- A price per minute in sats, debited per member.
- Below a minimum balance the voice service says so and doesn't start. When a
  member's balance runs low it says so, and a top-up can happen mid-call.
- Revenue is swept to the operator in aggregate. The operator sees totals,
  not calls or members.
- Who pays, each member or the org from a shared balance, is Q5.

**What the mixer learns** (traced in the code). A member's wallet and Jamie's
account sit on the same mixer (`mqtt-broker.v2.sphinx.chat`).
- **It sees the pair before any money moves,** from the async-pay ping, which
  names the payee in cleartext (`sphinx:sphinx/src/ping/asyncpay.rs:169-182`).
- **It makes the transfer itself.** It shifts the balance from one account to
  the other (`sphinx:mixer/src/send.rs:138-147, 408`).
- **It keeps both sides on disk,** under one payment hash in the `PMT` table,
  which nothing purges (`sphinx:mixer/src/db/pmt.rs`).
- **The docs overstate the privacy.** `sphinx:docs/async_payments.md:39-48`
  claims privacy for two accounts on the same LSP, and the code doesn't
  implement it.

So the operator learns that a member pays the org's Jamie, how much and when.
It already knows who is in which org, but the amounts and times track how
much a member talks. Round top-ups made apart from calls blur that. The
content of the calls is never in it.

## 6. The org's home in a TEE (step 4)

**What goes in.** Everything that reads the member's words:
- strut: its runs, sessions, the ledger and the speech models;
- the voice service;
- Jamie's account (the daemon): its seed is the org's money.

Until step 5 the orchestrator's model call still leaves the TEE for a hosted
provider, through the org's Bifrost (`org-gateway.md`). So a call is private
only once steps 4 and 5 are both done. And whatever else the org home runs
that a turn reads or writes (the graph, the lab) has to be inside too, or
not touched by voice turns.

**Host** (Q6). Today's swarms run on AWS EC2, which offers no Intel TDX.
- **Phala Cloud** (dstack on TDX): works, because the voice service only
  connects outward.
- **GCP TDX VMs** (dstack runs there).
- **Our own TDX servers.**
- **AWS's AMD SEV-SNP instances:** dstack doesn't target them. It would need
  other tooling (Confidential Containers or our own image and attestation).
  Unchecked.

**A measured image.**
- Every image pinned by digest.
- Models baked in: Kroko, Silero, the turn detector, Kokoro.
- The Ladybug backend; containers running as non-root.
- The production OS image, with no SSH. A development image and an SSH key
  that never showed in the attestation were the two findings of the August
  2026 audit of Venice's Phala gateway.

**Secrets.**
- `STRUT_SECRET_KEY`, the other root secrets and Jamie's seed are generated
  or derived inside the TEE by dstack's key service from the app's measured
  identity. No deployer supplies them, and no person holds Jamie's seed.

**Attestation, over HTTPS.**
1. Peel calls `GET /attestation?nonce=…` on the home.
2. The home answers with a TDX quote whose `report_data` commits to the
   nonce and to three keys:
   - the TLS key;
   - an HPKE key for sealing secrets to the TEE;
   - Jamie's Sphinx pubkey.
3. Peel verifies the quote with `dcap-qvl`, built into sphinx-rs (one
   function), with Intel's collateral fetched by Swift.
   - Don't use Phala's prebuilt Swift package: its UniFFI 0.28 clashes with
     sphinx-rs's 0.24, the same clash that holds Peel's LiveKit at 2.10.2.
4. Checks: debug off, a minimum TCB level, and the image hash against our
   published releases.
5. Peel then seals the call key to the HPKE key, using CryptoKit's HPKE, so it
   needs no TLS pinning hook. Peel has no custom TLS trust today.
6. Peel shows "verified" on the org and on the call screen.

**What attestation can't stop.**
- Memory-bus interposers break TDX for anyone with physical access: TEE.fail
  (under $1,000, forges quotes) and DDRop (about $159, disclosed 2026-09-14).
- So where the hardware sits matters, and §11 says so.

## 7. Tinfoil (step 5)

**The LLM.**
- The orchestrator's model goes to Tinfoil's OpenAI-compatible chat API, with
  the body encrypted by EHBP.
- **Straight from the TEE, not through Bifrost.** Bifrost reads a request's
  body to route and bill it, and EHBP hides the body. So strut meters these
  calls itself, from the token counts Tinfoil returns
  (`X-Tinfoil-Usage-Metrics`).
- aieo needs a chat-completions provider that speaks EHBP, or tinfoil-js's
  fetch.
- tinfoil-js 1.3.0 attests the router, which runs on AMD SEV-SNP. The router
  verifies the model enclaves, most of which are TDX. TDX support in the JS
  SDK is an open PR (#215).

**Speech stays in the TEE.**
- Tinfoil's realtime speech-to-text has no voice-activity detection and a
  fixed 480 ms delay, and all three audio models sit on one H200. We don't
  need it.
- `voxtral-tts` ($0.002 per request) is an option if Kokoro sounds wrong.

**What Tinfoil sees:** our API key, model, token counts and timing. Not the
member, not the content. We pay by card (Stripe).

**Latency risk.**
- With Tinfoil in the path, from end of speech to first audio, strictly
  sequential (estimates):

  | Optimistic | Expected | Pessimistic |
  |---|---|---|
  | 0.8 s | 2.0 s | 5.4 s |

- Starting the model on partial transcripts would bring the expected case to
  about 1.3–1.6 s.
- Tinfoil publishes no first-token latency under confidential computing, and
  some LLM traffic may be served in Poznań. Measure before switching.

## 8. Later

- **Our own GPU enclave**, one H200 at about $4–6k a month, once enough orgs
  share it.
- **Many unrelated people on one host.** It needs per-actor read isolation in
  strut (§3.6) and a pooled Sphinx account.
- **A media server for private calls** with the audio-level extension off and
  Opus at constant bitrate, perhaps in its own TEE.
- **Meeting calls on the org's home.** Jamie in group calls moves to the
  home, using the same voice service's meeting mode.

## 9. Relation to org-home-swarm.md

This plan is the voice part of the org's home, and the TEE is that home.

**It uses from org-home:**
- Jamie's account and the daemon on the home (§4.2 there);
- the members and their Sphinx keys, which the lab learns (§2 there);
- Peel talking to the home with a token per org (§2 there, "Device pairing").
  Today Hive's pairing hands that token out.

**It adds to org-home:**
- the third hosting option. org-home accepts "a swarm Stakwork runs, where
  Stakwork has root" as a step toward self-hosting. A home in an attested VM
  is hosted by Stakwork, and Stakwork still can't read it (§6);
- the orchestrator answering at once (§3.1) and reply streaming (§3.4), which
  every Jamie surface on the home can use;
- Peel checking a home's attestation (§6).

**The same rule for code:** org-level code goes in the lab, and strut gets
generic seams. The call route (Q10) and the ledger are where that rule needs
applying.

## 10. Steps

Each step ships something usable and builds on the ones before it.

| Step | Ships | Proves |
|---|---|---|
| **1. Talk, on one machine** | Talk to Jamie in Peel; the voice call screen; a compose with strut, livekit and the voice service; the voice service's 1:1 mode; the orchestrator changes (§3.1); reply streaming (§3.4); `/audio/speak` (built) | The conversation feels natural; per-stage latency; recognition accuracy; two or three calls at once |
| **2. Off the LAN** | The central media server with end-to-end encryption; meet's private rooms; the call route on a real org home | It works from anywhere, for several members |
| **3. Sats** | A price per minute; balance and top-up in Peel; Jamie's invoices; the per-member ledger; aggregate sweeps | Lightning-gated |
| **4. The home in a TEE** | The org home on a TEE host; a measured image; secrets from the key service; `/attestation`; `dcap-qvl` in sphinx-rs; the call key sealed with HPKE; "verified" in Peel | Neither the operator nor the host can read it |
| **5. Tinfoil** | The orchestrator's model in Tinfoil's enclaves, encrypted with EHBP, metered in strut; optionally `voxtral-tts` | Private inference on large models |

### Step 1 in detail

**peel:** the Mac first, then the iPhone simulator.
- **A Talk entry point** for the org's Jamie, on the org's page where Peel
  lists an org (Stadeum).
  - Not in the agent DM.
    [stakwork/peel#468](https://github.com/stakwork/peel/pull/468) puts its own
    voice mode there: hands-free chat with on-device speech and text over
    Sphinx. The two shouldn't share one button.
  - Peel's call menu already has an inline Jamie picker for group calls
    (`Apps/iOS/Peel/ConversationScreen.swift:113-146`).
- **A home-call path beside `CallStore`.**
  - It calls `POST /voice/calls` (§4.1) and joins the room it gets back with
    the LiveKit SDK Peel already links.
  - It doesn't go through `CallLink`.
- **A voice call screen.**
  - It reads `lk.agent.state` and the `lk.transcription` streams (§4.1) to
    show listening, thinking and speaking, and the live text.
  - The member interrupts by speaking.
  - Reuse `IOSCallScreen` / `CallWindow`, or #468's phase state and panel
    once #468 builds.
  - Keep Apple's voice processing on (`.voiceChat`,
    `IOSCallSession.swift:190-194`).
- **A dev setting:** the home's URL and a person token (§4.1, "Local values").
- **Loopback first.**
  - The Mac and the simulator both reach `127.0.0.1`, so step 1 needs no TLS
    and no local-network permission.
  - A real iPhone on the LAN needs `NSLocalNetworkUsageDescription`, which
    only the Mac declares today, plus a certificate it trusts for the LAN
    host.
- **Building for the simulator.** sphinx-rs needs its arm64-simulator slice:
  `cargo +1.88.0 build --target aarch64-apple-ios-sim --release` in
  `sphinx-ffi`, then `scripts/build-ffi.sh` with `SPHINX_IOS_SIM_LIB` set.

**compose** (in sphinx-voice, beside the voice service)

| Service | Image | Network |
|---|---|---|
| `strut` | `ghcr.io/stakwork/strut`, Ladybug backend | the voice service and Peel (`/voice/calls`) |
| `livekit` | `livekit/livekit-server:v1.13.11` `--dev --bind 0.0.0.0 --node-ip <LAN IP> --udp-port 7882` | 7880/tcp, 7881/tcp, 7882/udp; natively on a Mac (`brew install livekit`) |
| `voice` | the 1:1 mode | outbound to strut and livekit; strut forwards `/voice/calls` to it |

**voice service** (sphinx-voice, a second entry point, Node)
- One job per call; `AgentSession` on the member's track, with the strut STT
  and TTS plugins, Silero and the turn detector.
- An `llmNode` that runs the orchestrator turn as the member, on
  `<member>/voice/<room>`, and streams its reply a clause at a time.
- A job's callback becomes `session.say`.
- `POST /calls`, the handler behind `/voice/calls` (§4.1): mint tokens, get
  the agent in, answer.

**strut**
- `/voice/calls`, forwarding to `STRUT_VOICE_URL` with the member's actor,
  open to a person token (§4.1, Q10).
- The orchestrator's `start` reply and the `job/start` step after it.
- `params.reasoning`.
- Reply streaming: the `stream` flag and the tap in the agent step, the
  `reply.delta` event, and the store waking its tails (§3.4).
- `/audio/speak`: built on `feature/audio-speak`.

**Measure** on the CPU budget of the target TEE: Docker with `cpus: 4` and
8 GB, as Phala's `tdx.large`, never Apple's GPU.
- Each stage of the latency budget below.
- Two and three calls at once: first audio while the synthesizer is shared,
  and the CPU the whole stack uses.
- Recognition accuracy with Kroko and with Parakeet.
- Whether `final_answer`'s `text` streams in pieces, for each provider we'd
  use (Anthropic direct, through Bifrost, a vLLM endpoint like Tinfoil's).
  The answer picks schema or text mode for voice turns (§3.4).
- Whether an `AgentSession` runs on a room we connected ourselves, without the
  worker (Q7).

### Latency budget: from the end of speech to the first audio

Targets: 1.5 s by the end of step 1, 1.0 s stretch. Voice-agent builders aim
for about 0.8 s (Daily, Pipecat).

| Stage | Target | Measured |
|---|---|---|
| End of turn (Silero + turn detector) | 0.4 s | — |
| Final text from strut | 0.3 s | about 0.3 s (Kroko, Mac) |
| Orchestrator: model's first token | 0.5 s | — |
| First clause | 0.15 s | — |
| Kokoro, first audio of a clause | 0.2 s | about 0.17 s on 4 cores, one call |
| Network, phone ↔ home, with jitter buffer | 0.1 s | — |

## 11. Who sees what (after steps 4 and 5)

| Party | Sees | Doesn't see |
|---|---|---|
| The member's phone, the TEE | everything | — |
| Other members of the org | the member's turns in run logs and sessions, until per-member read isolation exists (§3.6) | — |
| Network observers | IP addresses, timing, packet sizes | audio, words |
| The LiveKit server | a room, random identities, timing, packet sizes, a per-packet loudness level | audio, words, the key |
| The Sphinx broker and mixer | that a member pays the org's Jamie; amounts; times (§5) | content, the call key |
| The cloud host, the operator | that the home runs; aggregate revenue sweeps | anything inside the TEE, unless they have physical access to the server (§6) |
| Tinfoil (step 5) | our key, model, token counts, timing | the member, the content |

## Open questions

1. **Where the voice service lives.** *Decided 2026-11-03:* a second entry
   point in sphinx-voice.
2. **Node or Python.** *Decided 2026-11-03:* Node.
   - Node's encryption works with a shared key only, and only if we connect
     the room ourselves (§4). Step 2 proves that.
   - Python is the fallback if it doesn't hold.
3. **Kokoro.** *Decided and built:* inside strut (§3.3).
4. **Streaming the reply.** *Decided 2026-11-03:* `reply.delta` run events
   over the existing SSE stream, with the store waking its readers (§3.4).
   Still open until step 1 measures it: schema mode or text mode for voice
   turns.
5. **Who pays.** Each member from their own balance (proposed for step 3,
   since the sats are in personal wallets), or the org from a shared one, or
   both. And the price per minute.
6. **Hosting for step 4.** Phala Cloud, GCP TDX, our own TDX servers, or
   AWS's SEV-SNP instances, where the swarms already run but dstack doesn't.
7. **Running without the worker.** Does an `AgentSession` run on a room we
   connected ourselves, without LiveKit's worker? The turn detector may need
   the worker's inference process.
8. **What a member sees after a call.** The turns as messages in their Jamie
   chat, or one "call, 4 min" line that opens the transcript.
9. **Privacy between members.** *Decided 2026-11-03:* not required at first.
   Keep it easy to add later (§3.6).
10. **Where the call route lives.** A generic strut route that forwards to the
    voice service (proposed), or the lab.
11. **Whose vocabulary.** The org's lexicon only (one memory graph per strut),
    or a member's own on top.
12. **One thread or two.** A member's voice turns on a session per call
    (`<member>/voice/<room>`, ruled 2026-11-03), or on the same session as
    their Jamie chat, so calls and chat share one memory.
