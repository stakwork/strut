# Private voice: talk to your agent, and no one else hears

> **Status (2026-11-03): proposed. Nothing is built.**
> - Rows marked **agreed** under "Decided" are the owner's, from the design conversation of 2026-11-03. Everything marked *proposed* is mine and open.
> - Read against: strut `main` @83e7675, peel `main` @324588a, sphinx `master` @74c12954, sphinx-voice `main` @ebbe0c5, meet `main` @fd63ca1.
> - Companions:
>   - `org-home-swarm.md`: the same move for an org (§9);
>   - `chained-orchestrators.md`: pairing, person tokens;
>   - `local-desktop-and-stt.md` and `dictation-models.md`: strut's speech recognition and the person's vocabulary;
>   - `live-feeds.md`, `federation.md`.
> - The research behind it was done the same day: NEAR AI's TEE stack, the open-source field, TEE attacks, Tinfoil, LiveKit, and the Sphinx mixer. Every finding this plan relies on is restated here with its source.

## Goal

A person opens their agent's chat in Peel, taps **Talk**, and has a natural
spoken conversation with their own agent. The phone and attested code are
the only places the audio and the words are readable. The person pays in
sats over Sphinx.

"End to end" means phone to attested code, not phone to phone. The agent has
to hear the person in order to answer, so what is promised is about
everyone else:
- The operator (Stakwork), the host and any relay in the path never read
  the audio or the words.
- §11 lists what each of them still sees.

## Decided

| Question | Decision |
|---|---|
| Goal | **agreed.** End-to-end encrypted, Lightning-gated voice, phone → cloud → phone, natural enough to hold a conversation. |
| Where speech runs | **agreed.** Speech recognition and synthesis run in the agent's VM (the TEE), not on the phone, because there we can customize them, starting with the person's own vocabulary (strut's lexicon). |
| Who answers | **agreed.** The orchestrator, set up to be quick: it answers at once without tool calls, and starts a job in the background when the request needs work. |
| Payments | **agreed.** Sphinx's own rails. |
| Inference provider | **agreed.** Tinfoil directly, once we need attested GPUs, with no reseller in between (PPQ). Not in the first steps. |
| Order | **agreed.** UX first: Peel plus a docker-compose with everything on one machine, tested locally. Then one step at a time. This plan is settled before any code. |
| Voice agent | **agreed.** A second entry point in sphinx-voice, in Node: a 1:1 mode with no wake word (§3.5). |
| One conversation | *proposed* (§3.2). The call and the agent DM are one orchestrator session. |
| Topology | *proposed* (§2). LiveKit stays central, the audio is end-to-end encrypted, and the agent connects outward. |
| Speech stack | *proposed* (§3.3). Speech runs on CPU in the VM. strut does both directions with sherpa: speech-to-text, and Kokoro for text-to-speech. LiveKit handles turn-taking. Only the LLM needs a GPU, and that's a provider's. |
| Call set-up | *proposed* (§4). Over the agent DM. |

## 1. The shape

```
Peel (iPhone / Mac)
  │  encrypted audio: LiveKit frame encryption, a fresh key per call
  ▼
LiveKit server (livekit.sphinx.chat): forwards ciphertext it cannot read
  ▲
  │  outbound only
the agent's VM   (step 1: a Mac on the same Wi-Fi · step 4: an Intel TDX VM)
  voice agent    LiveKit Agents (Node): voice activity, end of turn, interruptions
  strut          speech both ways on CPU (sherpa: Kroko + the person's lexicon,
                 Kokoro), orchestrator turns, jobs
  Sphinx runner  the agent's account: DMs, call set-up, sats
  (step 5)       → Tinfoil enclaves for the LLM, body-encrypted (EHBP)
```

A turn:
1. The voice agent detects that the person has finished speaking.
2. It sends that stretch of audio to strut and gets the text back.
3. It runs an orchestrator turn on the agent DM's session.
4. It streams the reply into text-to-speech and back into the room.

If the reply started a job, the job's end comes back as a callback and the
agent says the result. The person can interrupt the agent at any time.

## 2. Why LiveKit stays central

- **Peel Home opens no ports.** No feature may need a direct path to it
  (`peel:docs/always-on.md:15-18`, `peel:docs/agent-on-strut.md:48-49`). A
  LiveKit server on the home would need inbound UDP, or TCP, or a TURN relay.
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
- **Moving the media server into the VM would hide nothing more.** Any
  server on the media path, central or in the VM, and any relay on the way
  sees the same things:
  - participants, packet timing and packet sizes (Opus is variable bitrate);
  - a per-packet loudness level, carried in a cleartext RTP header extension
    (RFC 6464) that LiveKit negotiates and reads on every packet
    (`livekit:pkg/sfu/buffer/buffer_base.go`).

So: a central media server, end-to-end encryption with a fresh shared key
per call, and the agent connecting outward. Step 1 runs its own
livekit-server on the LAN instead, with encryption off. The agent code is the
same either way.

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
     §5), so its end reaches the voice agent.
2. **`params.reasoning`.** The template fixes reasoning today. Make it a
   param, and run voice turns with it off.
3. **A fast model, picked per launch.** The voice agent launches with
   `params.model`, which is a knob, not a grant (`src/closure.ts`
   `grantWidenedBy` guards only tool grants).
   - Steps 1–4: a fast hosted model, e.g. Haiku 5.5.
   - Step 5: Tinfoil's `gemma4-31b` with thinking off.
4. **The voice instructions go in the turn, not in the system prompt.**
   - The session froze its system prompt at its first turn, which was the
     DM's.
   - So the voice line rides on `input.context.line`, the per-turn line the
     runner already sends (`sphinx:runner/src/bridge/turns.rs:41-56`): "On a
     voice call: answer in a sentence or two, the way you would say it."
5. **Stream the reply** (§3.4), so text-to-speech starts on the first clause
   instead of after the whole reply.

Setup steps on later turns: the two `context/concept` reads feed only the
system prompt, which is frozen after the first turn. They cost milliseconds
on Ladybug, so leave them unless step 1 measures otherwise. `strut/list-peers`
feeds the per-turn prompt and stays.

Estimate, not measured: the model's first token 0.3–0.6 s with a warm
prompt cache, then the first clause about 0.15 s later.

### 3.2 One conversation

- **Same session as the DM.** Voice turns name the same session as the agent
  DM: the runner's configured session, e.g. `peel/agent-1/dm`
  (`sphinx:runner/src/bridge/turns.rs:98-104`, `:431`). Whatever is said on a
  call, the DM remembers, and the reverse.
- **One turn at a time.** A session serves one turn at a time (`session_busy:`).
  The runner already retries on busy (`turns.rs:230-231`), and the voice agent
  does the same, so a DM that arrives mid-call waits one turn.
- **What the DM shows.** The person's words and the agent's replies are in
  the session's record (`GET /sessions/messages`). Whether Peel also shows
  them in the DM is Q8.

### 3.3 Speech in the VM

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

**The person's vocabulary.**
- The exact mishearings strut has learned apply instantly: lingo's `heardOnly`,
  which needs no fixer model.
- The fixer pass, with its 1.5 s timeout (`src/audio/fixer.ts`), is too slow
  for the speaking path. Skip it there, or run it on the transcript afterwards.

**Synthesis: Kokoro, inside strut.**
- **CPU only.** The agent's VM has no GPU: a confidential GPU costs $4–9 an
  hour. Speech has to run on CPU in production, so a GPU on a developer's Mac
  is no argument for anything.
- **The engine.** The sherpa addon strut already ships for speech-to-text
  includes `OfflineTts` with Kokoro, unused today.
- **The route.** A new route, `/audio/speak`, runs it in strut's model worker
  thread, the way the recognizers run (`src/model-worker.ts`), and streams
  16-bit PCM back.
- **Models.** Kokoro's model comes through strut's pinned downloader
  (`src/audio/download.ts`), with its sha256 checked.
- **Why strut.** It becomes the one speech service, in both directions:
  - no Python stack in the measured image;
  - one place to customize speech, e.g. pronouncing names from the person's
    lexicon. How far sherpa's pronunciation lexicon goes is unchecked.
- **The plugin.** A small agents-js TTS plugin calls the route, the twin of
  the STT plugin.
- **To verify in step 1:**
  - Does sherpa's Kokoro stream samples as it generates? Otherwise speak
    clause by clause.
  - Its first audio and real-time factor on the CPU budget of the target VM.
- **Fallback.** Kokoro-FastAPI's CPU image, an off-the-shelf server with an
  OpenAI-compatible `/v1/audio/speech`, behind agents-js's OpenAI TTS plugin.
  It's the same model, so falling back changes how it runs, not the voice.

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
     (`src/events-sink.ts`), so the text never leaves the VM.
   - The UI's event panel and the folds (`kit/src/folds/`) skip it.
3. **Wake the reader when an event lands.**
   - The run store signals its live tails on every `append`, and the 250 ms
     poll stays as the fallback.
   - Every live viewer then gets each event within milliseconds.
4. **The voice agent consumes it.**
   - It launches the turn, gets back `{ runId }`, and opens the same SSE
     stream.
   - Its `llmNode` yields each delta at the turn step's path into LiveKit's
     sentence tokenizer, which feeds `/audio/speak`.
   - At `run.end` it reads `start`, `artifacts` and `ask` from the output.

**What it saves.**
- Without it, the person waits for the first token, then the whole reply
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
- When the person cuts in, the voice agent stops speaking but lets the turn
  finish. Cancelling it would commit nothing, and the session would lose the
  person's words too.
- The next turn's context line says where the reply was cut ("you were cut off
  after: …"). LiveKit's speech handle knows how much was played, so the agent
  knows what the person actually heard.

**Size:** about 60 lines in `agent.ts`, about 30 in `store.ts`, the event
type, and tests. It helps every surface that follows a live run, not just
voice.

### 3.5 The voice agent: a new 1:1 mode, not Jamie

sphinx-voice is a meeting listener:
- it transcribes everyone and waits for the wake word "jamie";
- a Haiku call decides whether the person asked for something;
- replies come back on a long poll;
- its speaker can't be stopped.

Its commit `3cf4e90` removed LiveKit's `voice.AgentSession` because a session
hears one participant and answers every turn. That is exactly what a 1:1 call
wants.

**No wake word.** In a 1:1 call everything the person says is addressed to
the agent, so the end of each turn is the cue to answer.
- Jamie's mode keeps its wake word and its classifier for meetings.
- When the person turns to talk to someone else in the room, they mute in
  Peel. No "was that for me?" check sits on the speaking path.

The new mode:
- `AgentSession` on the owner's track;
- a custom `llmNode` that runs the orchestrator turn and streams its reply
  (§3.4);
- the strut STT and TTS plugins, Silero and the turn detector;
- agents-js 1.9.x (sphinx-voice pins 1.0.25).

## 4. Call set-up

### Step 1, on the LAN

**Peel's call server is the home.** On the same origin, the home's Caddy serves:
- the voice service's version of meet's `/api/connection-details`, which mints
  tokens with the dev key;
- LiveKit's `/rtc`.

Peel accepts media only from the call server's own host and port
(`peel:Sources/PeelCore/CallServer.swift:213-219`), and room names must start
with `sphinx.call.` (`peel:Sources/PeelCore/Call.swift:205-209`).

The voice agent joins every room the token route minted for the owner. No
Sphinx change is needed for step 1.

### Step 2, the central server

Set-up goes over Sphinx, which already reaches a home with no open ports.

1. Peel makes a room (`CallLink.new`, 128 random bits, `Call.swift:150-156`)
   and a 32-byte key.
2. Peel asks meet for two tokens: its own and the agent's. meet needs one
   change: a private room gets no Jamie dispatch and no `isHost` admin grant.
   Today every token dispatches `LIVEKIT_AGENT_NAME` and `?isHost=true` gives
   anyone room admin (`meet:app/api/connection-details/route.ts:30-45,
   73-83`).
3. Peel posts the call link (type 32) in the agent DM, carrying the room, the
   agent's token and the key.
   - The DM is end-to-end encrypted to the agent's key, so neither the broker
     nor the mixer sees the key.
   - Peel puts the key in the message, never in a link fragment (Peel refuses
     those, `Call.swift:120`).
4. The runner forwards call links from the owner to strut, and strut tells the
   voice agent to join. Today the runner drops every non-text message type
   (`sphinx:runner/src/bridge/mod.rs:298`).
5. Both sides join with encryption.
   - The agent connects the room itself with `encryption` before it starts the
     session. agents-js's `ctx.connect(e2ee)` passes the legacy `e2ee` field,
     which leaves the agent's transcripts and data messages unencrypted
     (`agents/src/job.ts` L478). `AgentSession.start` would otherwise connect
     without options (`voice/agent_session.ts` ~L1002).
   - Use a shared key: rtc-node's per-participant keys are broken
     (livekit/node-sdks#741, fix #768 open).

**Why not have the agent register as a LiveKit worker:** that needs a
per-home API key for the central server, and a LiveKit API key is admin over
every room.

## 5. Paying in sats (step 3)

**The model.** Inside one person's home, the person pays their own agent's
Sphinx account, prepaid. It has to be prepaid:
- money moves only on the payer's own signed request;
- the mixer waits only 4,200 ms for a preimage (`sphinx:mixer/src/interceptor.rs`),
  so nothing can be held for the length of a call.

**How it works.**
- A price per minute in sats.
- Below a minimum balance the voice agent says so and doesn't start. When the
  balance runs low it says so, and a top-up is a payment in the DM, mid-call.
- The VM keeps the usage ledger and sweeps revenue to the operator's account
  in aggregate. The operator sees totals, not calls.

**What it needs.**
- The runner carries `msat` and `payment_hash` into strut. Today payment types
  are dropped (`runner/src/bridge/mod.rs:298`), and the amount on a text
  message is lost (`:340-352`).
- A bridge route that issues an invoice. `make_invoice` exists in the core it
  links (`sphinx:sphinx/src/bindings/invoice.rs:10-52`).
- Peel shows the balance and a top-up in the agent DM. It hides Pay there today
  (`peel:Apps/iOS/Peel/ConversationScreen.swift:190`).

**What the mixer learns** (traced in the code):
- The person's wallet and the agent's account sit on the same mixer
  (`mqtt-broker.v2.sphinx.chat`).
- **It sees the pair before any money moves.** It learns the pair from the
  async-pay ping, which names the payee in cleartext
  (`sphinx:sphinx/src/ping/asyncpay.rs:169-182`).
- **It makes the transfer itself.** It shifts the balance from one account to
  the other (`sphinx:mixer/src/send.rs:138-147, 408`).
- **It keeps both sides on disk.** It stores them under one payment hash in the
  `PMT` table, which nothing purges (`sphinx:mixer/src/db/pmt.rs`).
- **DMs link the pair the same way**, with or without sats.
- **The docs overstate the privacy.** `sphinx:docs/async_payments.md:39-48`
  claims privacy for two accounts on the same LSP, and the code doesn't
  implement it.

For a person and their own agent this adds little, since every DM already
links them. But it isn't "oblivious". If one host ever serves many people's
agents, pay one pooled account per host, with the agent named only in the
encrypted final hop (`sphinx:sphinx/src/onion_payment.rs:59-80`), and have the VM split it (§8).

## 6. The VM (step 4)

**Host.** dstack on Intel TDX.
- Phala Cloud works because the home needs no inbound ports.
- Our own TDX server and GCP's TDX VMs are the alternatives (Q6).

**A measured compose.**
- Every image pinned by digest.
- Models baked into the images: Kroko, Silero, the turn detector, Kokoro.
- The Ladybug backend; containers running as non-root.
- dstack's production OS image, with no SSH. A development image and an SSH
  key that never showed in the attestation were the two findings of the
  August 2026 audit of Venice's Phala gateway.

**Secrets.**
- `STRUT_SECRET_KEY` and the other root secrets are derived by dstack's key
  service from the app's measured identity. No deployer supplies them.
- Peel hands over the agent's seed only after checking the attestation,
  encrypted to the VM's attested key. This is the `strut move` hand-off with a
  check added.

**Attestation over Sphinx.**
- The call link, or a verify message, carries a nonce.
- The agent answers with a TDX quote whose `report_data` commits to the nonce
  and to the agent's Sphinx pubkey.
- Peel verifies it with `dcap-qvl`, built into sphinx-rs (one function), with
  Intel's collateral fetched by Swift.
  - Don't use Phala's prebuilt Swift package: its UniFFI 0.28 clashes with
    sphinx-rs's 0.24, the same clash that holds Peel's LiveKit at 2.10.2.
- Checks: debug off, a minimum TCB level, and the compose hash against our
  published releases.
- A quote is a few KB: check Sphinx's message size limit.
- Peel shows "verified" on the agent and on the call screen.

**What attestation can't stop.**
- Memory-bus interposers break TDX for anyone with physical access: TEE.fail
  (under $1,000, forges quotes) and DDRop (about $159, disclosed 2026-09-14).
- So where the hardware sits matters, and §11 says so.

## 7. Tinfoil (step 5)

**The LLM.**
- The orchestrator's model goes through `llmAuth` to Tinfoil's
  OpenAI-compatible chat API, with the body encrypted by EHBP.
- aieo needs a chat-completions provider that speaks EHBP, or tinfoil-js's
  fetch.
- tinfoil-js 1.3.0 attests the router, which runs on AMD SEV-SNP. The router
  verifies the model enclaves, most of which are TDX. TDX support in the JS
  SDK is an open PR (#215).

**Speech stays in the VM.**
- Tinfoil's realtime speech-to-text has no voice-activity detection and a
  fixed 480 ms delay, and all three audio models sit on one H200. We don't
  need it.
- `voxtral-tts` ($0.002 per request) is an option if Kokoro sounds wrong.

**What Tinfoil sees:** our API key, model, token counts and timing. Not the
person, not the content. We pay by card (Stripe).

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

- **Our own GPU enclave**, one H200 at about $4–6k a month, once volume
  justifies it.
- **One host serving many people's agents.** It needs a pooled Sphinx account
  (§5) and per-actor read isolation in strut, which doesn't exist today.
- **A media server for private calls** with the audio-level extension off and
  Opus at constant bitrate, perhaps in its own VM.
- **Org calls.** Jamie in calls moves to the org's home with the same voice
  agent (§9).

## 9. Overlap with org-home-swarm.md

**Same direction.** Content moves off central services onto a box of its
owner's, and the agent lives on that box. Realtime goes through strut, not a
central service. Devices reach the box directly or over Sphinx.

**Different unit.**
- org-home is per org: members, Hive's shell, tribes, Jamie in tribes.
- This plan is per person: the Peel Home that `strut move` already provisions.

**Fills org-home's gap.** org-home accepts "a swarm Stakwork runs, where
Stakwork has root" as a step towards self-hosting. An attested VM is the
third option: Stakwork hosts it, and still can't read it. org-home §2 can use
§6 as it is.

**Build once.**
- The voice agent in its 1:1 mode. org-home doesn't mention calls, and
  sphinx-voice is still central.
- The "orchestrator answers at once" changes (§3.1).
- Peel checking a home's attestation (§6).

## 10. Steps

Each step ships something usable and builds on the ones before it.

| Step | Ships | Proves |
|---|---|---|
| **1. Talk, on one machine** | Talk in Peel's agent DM; the voice call screen; the compose; the voice agent's 1:1 mode; the orchestrator changes (§3.1) | The conversation feels natural; per-stage latency; recognition accuracy on our voices |
| **2. Off the LAN** | The central media server with end-to-end encryption; call set-up over the DM; the runner forwarding call links; meet's private rooms | It works from anywhere; the home stays port-free |
| **3. Sats** | A price per minute; balance and top-up in Peel; payments reach strut; the ledger in the VM; aggregate sweeps | Lightning-gated |
| **4. The VM** | A dstack TDX deployment; the measured compose; KMS-derived secrets; seed hand-over after attestation; quotes over Sphinx; `dcap-qvl` in sphinx-rs; "verified" in Peel | Neither the operator nor the host can read it |
| **5. Tinfoil** | The orchestrator's model in Tinfoil's enclaves, encrypted with EHBP; optionally `voxtral-tts` | Private inference on large models |

### Step 1 in detail

**peel**
- **A Talk entry point.** Add one in the agent DM: on the iPhone, Call is
  hidden there by `if !isAgent` (`Apps/iOS/Peel/ConversationScreen.swift:114`);
  on the Mac there's none (`Apps/Mac/Peel/AgentViews.swift:146`).
- **A voice call screen.** It shows listening, thinking and speaking, the live
  text, and lets the person interrupt by speaking. Reuse `IOSCallScreen` /
  `CallWindow` where it fits. Keep Apple's voice processing on (`.voiceChat`,
  `IOSCallSession.swift:190-194`).
- **A dev profile.** Its call server is the home (`--call-server <host>:<port>`).
- **iPhone permissions.** The iPhone needs `NSLocalNetworkUsageDescription`,
  which only the Mac declares today. It also needs a certificate it trusts for
  the LAN host, or an installed CA.

**compose** (`peel:home/docker-compose.yml`, extended)

| Service | Image | Network |
|---|---|---|
| `strut` | as today | 127.0.0.1 only |
| `bridge` (runner) | as today | strut's namespace |
| `livekit` | `livekit/livekit-server:v1.13.11` `--dev --bind 0.0.0.0 --node-ip <LAN IP> --udp-port 7882` | 7880/tcp, 7881/tcp, 7882/udp; natively on a Mac (`brew install livekit`) |
| `voice` | the 1:1 agent | outbound only |
| `peer` (Caddy) | as today | plus `/api/connection-details` and `/rtc` on one origin |

**voice agent (sphinx-voice, a second entry point, Node)**
- `AgentSession` on the owner, with the strut STT and TTS plugins, Silero and
  the turn detector.
- An `llmNode` that runs the orchestrator turn on the DM's session and streams
  its reply.
- A job's callback becomes `session.say`.
- The meet-shaped token route.

**strut**
- The orchestrator's `start` reply and the `job/start` step after it.
- `params.reasoning`.
- Reply streaming: the `stream` flag and the tap in the agent step, the
  `reply.delta` event, and the store waking its tails (§3.4).
- `/audio/speak`: Kokoro through sherpa, streaming PCM (§3.3).

**Measure** on the CPU budget of the target VM: Docker with `cpus: 4` and
8 GB, as Phala's `tdx.large`, never Apple's GPU.
- Each stage of the latency budget below.
- What a call costs in CPU across the whole stack: strut, sherpa in both
  directions, Silero and the turn detector.
- Recognition accuracy with Kroko and with Parakeet.
- Whether `final_answer`'s `text` streams in pieces, for each provider we'd
  use (Anthropic direct, through Bifrost, a vLLM endpoint like Tinfoil's).
  The answer picks schema or text mode for voice turns (§3.4).
- Whether an `AgentSession` runs on a room we connected ourselves, without the
  worker (Q7).

### Latency budget: from the end of speech to the first audio

Targets: 1.5 s by the end of step 1, 1.0 s stretch. Voice-agent builders aim
for about 0.8 s (Daily, Pipecat).

| Stage | Target |
|---|---|
| End of turn (Silero + turn detector) | 0.4 s |
| Final text from strut | 0.3 s |
| Orchestrator: model's first token | 0.5 s |
| First clause | 0.15 s |
| Kokoro first audio | 0.2 s |
| Network, phone ↔ home, with jitter buffer | 0.1 s |

These are estimates, for step 1 to measure against.

## 11. Who sees what (after step 4)

| Party | Sees | Doesn't see |
|---|---|---|
| The phone, the VM | everything | — |
| Network observers | IP addresses, timing, packet sizes | audio, words |
| The LiveKit server | a room, random identities, timing, packet sizes, a per-packet loudness level | audio, words, the key |
| The Sphinx broker and mixer | that the phone and the agent talk and pay; amounts; times (§5) | content, the call key |
| The cloud host, the operator | that the VM runs; aggregate revenue sweeps | anything inside the VM, unless they have physical access to the server (§6) |
| Tinfoil (step 5) | our key, model, token counts, timing | the person, the content |

## Open questions

1. **Where the voice agent lives.** *Decided 2026-11-03:* a second entry point
   in sphinx-voice.
2. **Node or Python.** *Decided 2026-11-03:* Node.
   - Node's encryption works with a shared key only, and only if we connect
     the room ourselves (§4). Step 2 proves that.
   - Python is the fallback if it doesn't hold.
3. **Kokoro.** Inside strut, proposed (§3.3). The VM runs speech on CPU, so
   the container's advantage, Apple's GPU on a Mac, doesn't carry over to
   production. The container stays as the fallback.
4. **Streaming the reply.** *Decided 2026-11-03:* `reply.delta` run events
   over the existing SSE stream, with the store waking its readers (§3.4).
   Still open until step 1 measures it: schema mode or text mode for voice
   turns.
5. **Pricing.** The price per minute in sats, and whether there's a free
   allowance.
6. **Hosting for step 4.** Phala Cloud, our own TDX server, or GCP TDX.
7. **Running without the worker.** Does an `AgentSession` run on a room we
   connected ourselves, without LiveKit's worker? The turn detector may need
   the worker's inference process.
8. **The DM after a call.** Does it show the call's turns as messages, or one
   "call, 4 min" line that opens the transcript?
