# Native dictation client (macOS / iOS / Kotlin) → strut `/audio/stream`

Scope: a native app that captures the microphone itself and streams audio to
a running strut for speech-to-text. Nothing here involves strut's web UI; the
app owns capture, the UI for the transcript, and what it does with the text.
The server side is complete on `main`. This is the contract to build against.

Source of truth for the protocol: `strut/src/audio/ws.ts` (socket),
`strut/src/audio/stt.ts` (`SttStreamOptions`, events), `strut/src/audio/routes.ts`
(HTTP). Design background: `local-desktop-and-stt.md` §4.

---

## 0. Getting a strut to talk to

Two ways to have one running locally. Both need Node 20 or newer on the
machine; the package does not include Node.

- **Download.** The `v*` GitHub release has `strut-darwin-arm64.tar.gz`
  and `strut-darwin-x64.tar.gz`. Fetch and unpack from the terminal, then run
  `./strut --open`: the web UI it opens has dictation built in, so you can
  try the recognizer before writing a line of client code.

  ```sh
  curl -L https://github.com/stakwork/strut/releases/latest/download/strut-darwin-arm64.tar.gz | tar xz
  ./strut/strut --open
  ```

  Use `curl`, not the browser: a browser download is quarantined by macOS,
  Archive Utility marks every extracted file, and loading the unnotarized
  speech addon would then hang the process on a Gatekeeper prompt. `./strut`
  detects that case and tells you to run `xattr -dr com.apple.quarantine
  <dir>` once, but the `curl` path never hits it.
- **Build.** In a checkout: `yarn install`, `npm --prefix web
  install`, then `npm run package:desktop -- --smoke --tar`. Same layout at
  `dist-desktop/strut/`, and the tarball beside it.

The directory is `package.json`, `build/`, `web/dist/`, `node_modules/`,
`native/`, plus two entry points: `desktop.js`, which a host spawns, and
`strut`, a shell wrapper over it. `native/` holds every binary in the package
and nothing else: the `sherpa-onnx.node` addon and the two dylibs it links
(`libonnxruntime`, `libsherpa-onnx-c-api`), moved out of the sherpa platform
package by the packaging script, which points `sherpa-onnx-node`'s loader at
them and fails the build if a binary turns up anywhere else. The dictation
fixer's node-llama-cpp binaries (the addon, the ggml/llama dylibs and the ggml
backends it loads from its own folder, Metal among them) sit together in
`native/llama/<platform folder>`, found through the prebuilt package's
`getBinsDir()`; never built from source or downloaded at runtime. The app
code-signs and notarizes that directory and its folders. They ship ad-hoc signed, which
is why an unsigned download trips Gatekeeper; inside a signed, notarized app
bundle there is no prompt.

A host runs `node <dir>/desktop.js` from any cwd with **no required env**.
The launcher defaults to the filesystem workspace (no Neo4j), binds
`127.0.0.1` on an OS-picked port, keeps the workspace under the platform
app-support dir and models under the platform cache dir, and generates an
API key per launch. It prints a few human lines, then one JSON line on
stdout:

```
{"event":"ready","port":51234,"host":"127.0.0.1","key":"3f9a…"}
```

That line is the base URL and the credential for everything below. Every
default is an env override:

| Var | Launcher default |
|---|---|
| `STRUT_WORKSPACE` | `~/Library/Application Support/strut/workspace` (XDG / `%APPDATA%` elsewhere) |
| `STRUT_CACHE_DIR` | `~/Library/Caches` — models land at `<cache>/strut/models` |
| `STRUT_API_KEY` | random per launch; set your own to skip parsing it |
| `STRUT_HOST` / `STRUT_PORT` | `127.0.0.1` / `0` |
| `STRUT_WORKSPACE_BACKEND` | `fs`. The graph backend needs a Neo4j and is not for desktop. |
| `STRUT_SECRET_KEY` | unset: the secrets file is only obfuscated, with a boot warning. A shipping host keeps a stable one in the keychain. |
| `ANTHROPIC_API_KEY` etc. | not needed for dictation; only workflows and chat use them |

The host kills the child on quit; strut handles `SIGTERM`. `GET /health` is
unauthenticated, for liveness polling.

## 1. The moving parts

| Piece | Where | Notes |
|---|---|---|
| Recognizer | inside strut (sherpa-onnx, CPU) | Models download once into `STRUT_MODEL_DIR` / `<STRUT_CACHE_DIR>/strut/models` |
| Audio capture | the app | AVAudioEngine / AudioRecord, any sample rate, mono |
| Transport | one WebSocket per dictation | `GET /audio/stream`, JSON control frames + binary PCM |
| Push-to-talk alternative | one HTTP request | `POST /audio/transcribe` with a WAV body |
| Model install | HTTP, once | `GET /audio/models`, `POST /audio/models/:id/download` (SSE progress) |
| Learning loop | HTTP | sessions, corrections, named hotword lists |

Base URL is whatever the app spawned or was configured with:
`http://127.0.0.1:<port>` for a local child process (port and key from the
ready line, §0) or `https://host/lab` behind mcp. Every `/audio/*` route and
the socket sit under that base.

## 2. Auth

If strut runs with `STRUT_API_KEY` set (the desktop launcher generates one per
launch and puts it on the ready line, §0), every `/audio/*` request and the
socket upgrade must carry it:

- HTTP and WebSocket: `Authorization: Bearer <STRUT_API_KEY>` — a
  `URLSessionWebSocketTask` / OkHttp socket can set request headers, so use the
  header; `?key=<STRUT_API_KEY>` on the socket URL is the fallback for clients
  that can't.
- Behind mcp's `/lab` mount the credential is mcp's instead: HTTP Basic
  `admin:<API_TOKEN>` or `x-api-token: <API_TOKEN>`, on both HTTP and the
  upgrade.

Wrong or missing credential: HTTP `401`, and the upgrade is refused with `401`
before the WebSocket handshake completes.

## 3. Install models (once, before first use)

`GET /audio/models` →

```json
{
  "available": true,
  "modelDir": "/Users/me/.cache/strut/models",
  "models": [
    { "id": "zipformer-en-kroko", "bytes": 57000000, "chunkMs": 1280, "hotwords": true,
      "cased": true, "installed": true, "default": "model", "description": "…" },
    { "id": "nemo-fast-conformer-en-80ms", "bytes": 103000000, "chunkMs": 80, "hotwords": false,
      "cased": false, "installed": false, "default": "partialModel", "description": "…" },
    …
  ]
}
```

`available: false` means the sherpa addon didn't load in that strut; every
audio call will answer `501 { "error": "stt not available" }`.

Install the pair marked `default` (`model` = finals, `partialModel` = fast
partials; ~160 MB total):

`POST /audio/models/<id>/download` → `text/event-stream`:

```
event: progress
data: {"phase":"download","received":1048576,"total":57123456}
…
event: progress
data: {"phase":"extract"}
event: progress
data: {"phase":"done"}
```

or `event: error` / `data: {"error":"…"}`. Idempotent; re-running on an
installed model returns `done` immediately. If you skip this, the first
stream triggers the download and its `ready` arrives only after it finishes,
which can be a minute on a slow link — pre-install at app setup.

## 4. Streaming dictation — the socket

Open `ws(s)://<base>/audio/stream` with the auth header, then:

### 4.1 Client → server

1. One text frame, the start message. Everything except `type` is optional:

   ```json
   {
     "type": "start",
     "sampleRate": 48000,
     "model": "zipformer-en-kroko",
     "partialModel": "nemo-fast-conformer-en-80ms",
     "hotwords": ["Sphinx", "sphinx", "Stakwork :2"],
     "hotwordsScore": 2,
     "session": "2026-09-07T17:12:41Z-dictation",
     "endpoint": { "rule1": 2.4, "rule2": 1.0, "rule3": 20 }
   }
   ```

   | Field | Default | Meaning |
   |---|---|---|
   | `sampleRate` | 16000 | Rate of the PCM you will send. Declare your capture rate; strut resamples. **It must not change for the life of the stream** (see §5). |
   | `model` | `STRUT_STT_MODEL` / catalog default (`zipformer-en-kroko`) | Finals model. Hotword-capable Zipformer by default. |
   | `partialModel` | `STRUT_STT_PARTIAL_MODEL` / catalog default (`nemo-fast-conformer-en-80ms`) | Fast greedy model that produces partials. `null` = single recognizer: finals model does both, partials every ~1.3 s. |
   | `hotwords` | none | Either a stored list name (string) or inline phrases. A phrase may carry its own boost as ` :score`; objects `{ "phrase": "…", "score": 2 }` also work. |
   | `hotwordsScore` | 2 | Boost for phrases without their own score. 1.5–3 is the useful range; 5 over-biases. |
   | `session` | none | Log every final under `<dataDir>/audio/sessions/<id>.jsonl` for the learning loop (§7). |
   | `endpoint` | `{2.4, 1.0, 20}` | Seconds: `rule1` trailing silence with no speech yet, `rule2` trailing silence after speech, `rule3` max utterance length. Each triggers a `final`. |

2. Binary frames: raw **PCM16 little-endian, mono**, at `sampleRate`. No
   header, no framing. Around 100 ms per frame (4800 samples = 9600 bytes at
   48 kHz) is the sweet spot; any size works. Frames sent before `ready` are
   buffered and fed once the recognizer is up.

3. One text frame `{"type":"end"}` when the user stops. Strut pads ~2 s of
   silence so the last words decode, emits the trailing `final`, waits for
   the session log to land, then closes with code `1000`.

Closing the socket without `end` discards whatever hadn't reached a `final`.

### 4.2 Server → client (all text frames, JSON)

| Message | When |
|---|---|
| `{"type":"ready","model":"…","partialModel":"…"\|null,"hotwords":"<list name>"\|"inline"\|null}` | Recognizers are built. ~1 s cold, a few ms when cached. Start rendering. |
| `{"type":"partial","text":"…"}` | On every change to the in-progress text. Replace, don't append: `text` is the whole current utterance. Lowercase, unpunctuated when it comes from the NeMo partials model. |
| `{"type":"final","index":0,"text":"…","words":[{"text":"Ask","start":0.32},…]}` | An utterance closed (endpoint rule) or the stream ended. `text` supersedes the partials shown for it; the next partial starts a new utterance. Cased and punctuated from the finals model. `index` counts finals within the stream (continues across a resumed `session`); `start` is seconds from stream start. |
| `{"type":"error","error":"…"}` | Then close `1011`. Bad start message, unknown model or list, or a decode failure. |

Two things the app should do with these:

- **Render**: committed text = all `final.text` so far, joined with a space;
  live text = the latest `partial.text` after it. A punctuation-only final
  (`"."`) can arrive on `end`; attach it to the previous word.
- **Timing** on an M-series Mac with the default pair: partials trail the
  audio by 50–100 ms; a final lands ~300 ms after `end`; CPU ≈ 10 ms per
  100 ms of audio. Send frames at capture pace, not faster.

## 5. Audio contract (the parts that bite)

- **Mono PCM16LE only.** AVAudioEngine's input tap gives Float32, often
  deinterleaved stereo. Take channel 0, scale by 32768, clamp, write Int16
  little-endian. Compressed formats are not accepted.
- **Declare your real rate and never change it.** sherpa `exit(-1)`s the whole
  strut process on a mid-stream rate change. Strut rejects a rate change before
  it reaches the addon, but only if the client declares the rate it actually
  sends: if the input device changes (AirPods connect, mic switches) and the
  rate changes, **end the stream and start a new one**.
- **Do not resample in the app.** 48 kHz in is fine; strut resamples to the
  engine's 16 kHz. Resampling yourself only adds a place to get it wrong.
- **Frame cadence.** ~100 ms frames. Bigger frames raise partial latency; much
  smaller ones just add socket overhead.
- **Echo cancellation / noise suppression** are the app's job if wanted
  (`AVAudioSession` voice-processing mode on iOS, `kAUVoiceIOProperty` /
  `setVoiceProcessingEnabled` on macOS). Strut does nothing to the audio.

## 6. Push-to-talk: `POST /audio/transcribe`

For a hold-to-talk button or a voice memo, skip the socket: buffer the
capture, wrap it as a WAV (any rate, 8/16/24-bit PCM, mono), and

```
POST /audio/transcribe?model=zipformer-en-kroko&hotwords=<list>&session=<id>
Content-Type: audio/wav
<wav bytes>
```

→ `{ "text": "…", "segments": [{ "text", "words" }], "model", "hotwords", "durationMs", "fixer" }`,
plus `heard` and `changes` when the user's vocabulary changed the text (§7a).
`text` is what to type. Single recognizer (no `partialModel`); same casing
and punctuation as a `final`. Bodies under 44 bytes are rejected as not-a-WAV.

## 7. The learning loop (sessions, corrections, hotword lists)

Only if the app wants recognition to improve for its user. All optional.

- **Sessions.** Pass `session` on `start` (or `transcribe`). Finals are
  appended to `<dataDir>/audio/sessions/<id>.jsonl`. Read back with
  `GET /audio/sessions` (list) and `GET /audio/sessions/<id>` →
  `{ "id", "entries": [ { "type":"final", "t", "index", "text", "words", "model", "hotwords" }, { "type":"correction", "t", "index", "text" } ] }`.
- **Corrections.** When the user edits a final's text, send
  `POST /audio/sessions/<id>/corrections` with `{ "index": <final.index>, "text": "<edited>" }`.
  This is the highest-signal data the dream cycle gets; the app should send
  it whenever it lets the user edit.
- **Hotword lists.** `PUT /audio/hotwords/<name>` with a `text/plain` body,
  one phrase per line, optional ` :score`, or JSON `{ "phrases": [...] }`.
  `GET /audio/hotwords` lists names; `GET /audio/hotwords/<name>` returns the
  text; `DELETE` removes it. A stream names one with `"hotwords": "<name>"`.
  The app can seed a list from the user's contacts, projects, or vocabulary;
  a scheduled strut workflow can maintain it from sessions and corrections.

Hotword rules worth knowing: only the finals model honors them (the partials
model is greedy), the boost only helps a spelling the model could already
emit (it won't turn "stack work" into "Stakwork"; that's a post-correction
glossary), and casing must match what the model would emit, so list proper
nouns both ways.

## 7a. The user's vocabulary (rewrite, learning, Undo, the Vocabulary UI)

Strut keeps the user's words and how dictation mishears them in its memory
graph, and makes every decision about them (with the user's fixer model, a
small local model it runs): what an edit teaches, how a transcript is
rewritten. A client sends what it saw and
shows what comes back; it has no word lists or rules of its own. Every call
below is the same for any client (Mac, iOS, a web page). Steps are run through
`POST /steps/<type>/run` with the body `{ "config": { …input } }` and answer
`{ "status": "success" | "error", "output"?, "error"? }`. Never pass `keep`:
a step run is kept only when asked, and the sentence a correction carries
should not be.

**Transcribing.** `POST /audio/transcribe` (§6) applies the vocabulary by
default:

```ts
{
  text: string;            // type this
  segments: { text: string; words: SttWord[] }[];  // as heard
  model: string; hotwords: string | null; durationMs: number;
  fixer: string | null;    // the fixer model that read it (see Models); null: none ran
  heard?: string;          // the transcript as heard, only when `text` differs
  changes?: { heard: string; written: string; at: number }[];  // each edit in text order; `at` is its offset in `heard`, `written` "" for a removal
}
```

With a fixer, `text` has the user's words where the model reads them in
context, and fillers, doubled words and a phrase the speaker took back
("Tuesday, no, Wednesday") removed. With none, or when it does not answer
within 1.5 s (a cold model loads meanwhile; the next transcript gets it),
fillers and doubled words are still removed, only exact learned mishearings
of two or more words are applied (a one-word one, "fix" for Sphinx, needs
the model's check in context), and `fixer` is null. `?lingo=0`
returns the transcript as heard (`fixer: null`, no `heard`, no `changes`). A
strut that cannot read its memory returns it as heard too. The socket's
`final` frames (§4) are as heard today.

**Learning from an edit.** Once the user's edit of what was typed has
settled (the client re-reads the field), send both texts, once:

```
dictation/correction { typed: string, edited: string }
→ { learned: [{ heard: string, written: string, undo: string[] }] }
```

Each pair in `learned` is now in the vocabulary. Show "Learned <written>" for
those with a non-empty `undo`; an empty `undo` means strut already had the
pair. Strut asks the fixer about each short change that could sound like what
was typed. With no fixer **active** (`dictation/models`: no fixer with
`active: true`, i.e. none picked or the pick still downloading) nothing is
learned and `learned` is always empty, so a client can skip sending edits
then (Add still works). The call waits for a cold fixer to load, so it can
take a few seconds the first time. Each text is at most 20,000 characters.
Only the pair is stored, never the sentence.

**Undo.** `dictation/undo { undo: string[] } → { undone: string[] }` with the
`undo` ids of a learn. The pair is then never learned again. Ids that
dictation did not write are refused, and then nothing is forgotten.

**The Vocabulary UI.**

- Read: `memory/lexicon {}` →
  `{ lingo_type, mishearing, entities: [{ ref_id, type, name, written: string[], heard: [{ ref_id, value, form, created_at }], dictation_off, facts, updated_at, known_by_user, user? }], undone: [{ ref_id, value, form, entity: { ref_id, name }, undone_at }] }`.
  `written` holds the ways to write it, the name first. `heard` holds how
  dictation mishears it: `value` is the wrong text and `form` the written form
  it stands for (null means the name). Words of `lingo_type` are dictation's
  own words. Other entities (people, companies) come from the rest of the
  memory. Rank or filter with `facts`, `updated_at` and `known_by_user`.
- Add a word and how it is misheard:
  `dictation/add { written, heard } → { heard, written, undo }`.
  This is the same write as a learn.
- Remove: `dictation/remove { ref_id } → { forgotten }`. The `ref_id` is a
  `heard` ref_id (one mishearing) or a word of `lingo_type` (the word and all
  its mishearings). A word that has nothing else known of it goes with its
  last mishearing. Any other entity is refused, so turn it off instead.
- Dictation off / on for one entity:
  `dictation/enable { ref_id, on: boolean } → { ref_id, on }`. A word that
  is off is neither rewritten nor learned, and `memory/lexicon` shows it with
  `dictation_off: true`; the entity and what is known of it stay. The reply's
  `ref_id` is the entity changed (the survivor, for a merged-away ref_id).
  Use this step, not `memory/attributes`: the attribute behind it is strut's.

Refresh the lexicon after each write if the UI shows it. Transcription
always reads the current one.

**Models.** The speech model and the fixer are the user's picks, the same
steps for any client:

- `dictation/models {}` → `{ models: [{ id, kind: "speech" | "fixer", name,
  summary, recommended, bytes, description, state: "available" |
  "downloading" | "installed", progress?, downloaded?, selected, active,
  removable, error? }] }`. Poll it while something downloads.
  - `name` and `summary` are what to show ("Qwen3 1.7B", "Most accurate at
    learning your lingo."); `recommended` is true for the one to suggest
    (`qwen3-1.7b-q4` only). `description` is the longer, technical text.
  - `selected` is the user's pick for its kind; `active` is what strut uses
    now: the installed speech pick, else the default speech model (Kroko),
    and the installed fixer pick. They differ while a pick downloads.
  - `progress` (0..1) and `downloaded` (bytes received) are present while
    downloading.
  - `removable` is false for an active model and for the default speech
    model.
- `dictation/use { speech?, fixer? }` (`fixer: null`: none) → the same list.
  A pick that is not installed starts downloading and is used once it is.
- `dictation/remove-model { id }` → the same list. Refused for a model that
  is not `removable` (pick another first, or `fixer: null`) and while it
  downloads. A pick removed before it was installed goes back to the default
  speech model, or to no fixer.

Fixers: `qwen3-1.7b-q4` (1.1 GB; offer it first) and `qwen3-0.6b-q4`
(0.4 GB; faster, learns more wrongly). None is downloaded until the user
picks one. A picked fixer loads on first use and unloads after five minutes
idle.

## 8. Errors and lifecycle

| Situation | What you see | Do |
|---|---|---|
| strut not up yet | connection refused | wait for the `ready` stdout line (§0) or poll `GET /health` |
| sherpa addon missing on that strut | `501 {"error":"stt not available"}`; socket `error` then close `1011` | tell the user; it's an install problem |
| bad credential | HTTP `401`; upgrade refused | fix the key |
| unknown model / list | socket `error` (`unknown stt model "x"` / `unknown hotwords list "x"`), close `1011` | check `GET /audio/models`, `GET /audio/hotwords` |
| audio before `start` | socket `error`, close `1011` | send the start frame first |
| network drop mid-stream | socket closes without a trailing `final` | reconnect and start a new stream (same `session` is fine; `index` continues) |
| app killed | nothing; strut reaps the stream on close | — |

strut handles `SIGTERM` cleanly; a host that kills the child on quit loses
only the un-`end`ed utterance.

## 9. Swift sketch (macOS, AVAudioEngine → URLSessionWebSocketTask)

Not production code; the shape of it. Two things are intentional: the tap
runs at the input node's native format and the declared `sampleRate` is read
from that same format, so the two can't disagree.

```swift
import AVFoundation
import Foundation

final class StrutDictation {
    private let engine = AVAudioEngine()
    private var task: URLSessionWebSocketTask?
    var onPartial: ((String) -> Void)?
    var onFinal: ((String, Int) -> Void)?
    var onError: ((String) -> Void)?

    func start(base: URL, apiKey: String, session: String) throws {
        let input = engine.inputNode
        let fmt = input.inputFormat(forBus: 0)          // e.g. 48 kHz, Float32, 1–2 ch
        let rate = Int(fmt.sampleRate)

        var req = URLRequest(url: base.appendingPathComponent("audio/stream")
            .withScheme(base.scheme == "https" ? "wss" : "ws"))
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        let t = URLSession.shared.webSocketTask(with: req)
        task = t
        t.resume()
        receiveLoop(t)

        let startMsg: [String: Any] = [
            "type": "start", "sampleRate": rate, "session": session,
            // "hotwords": ["Sphinx", "sphinx"], "partialModel": NSNull() for single-recognizer
        ]
        let data = try JSONSerialization.data(withJSONObject: startMsg)
        t.send(.string(String(decoding: data, as: UTF8.self))) { _ in }

        // ~100 ms per buffer at the native rate; bufferSize is advisory.
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(fmt.sampleRate / 10), format: fmt) { [weak self] buf, _ in
            guard let ch0 = buf.floatChannelData?[0] else { return }
            let n = Int(buf.frameLength)
            var pcm = Data(count: n * 2)
            pcm.withUnsafeMutableBytes { raw in
                let out = raw.bindMemory(to: Int16.self)
                for i in 0..<n {
                    let v = max(-1, min(1, ch0[i]))
                    out[i] = Int16(v * 32767).littleEndian
                }
            }
            self?.task?.send(.data(pcm)) { _ in }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        task?.send(.string(#"{"type":"end"}"#)) { _ in }   // strut sends the trailing final, then closes 1000
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let e):
                self.onError?(e.localizedDescription)           // includes close without `end`
                return
            case .success(.string(let s)):
                if let d = s.data(using: .utf8),
                   let m = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                   let type = m["type"] as? String {
                    switch type {
                    case "partial": self.onPartial?(m["text"] as? String ?? "")
                    case "final":   self.onFinal?(m["text"] as? String ?? "", m["index"] as? Int ?? 0)
                    case "error":   self.onError?(m["error"] as? String ?? "error")
                    default: break                                   // "ready"
                    }
                }
            default: break
            }
            self.receiveLoop(t)
        }
    }
}

private extension URL {
    func withScheme(_ s: String) -> URL {
        var c = URLComponents(url: self, resolvingAgainstBaseURL: false)!
        c.scheme = s
        return c.url!
    }
}
```

Kotlin (OkHttp `WebSocket` + `AudioRecord` at `ENCODING_PCM_16BIT`, mono) is
the same shape and needs no float conversion: `AudioRecord` already yields
PCM16LE.

## 10. Checklist before shipping a client

- [ ] Auth header on both HTTP and the upgrade; handle `401`.
- [ ] `GET /audio/models` at setup; install the `default` pair with progress UI; surface `available: false`.
- [ ] `sampleRate` in `start` is read from the actual capture format; a device change ends the stream and starts a new one.
- [ ] Mono PCM16LE, ~100 ms frames, sent at capture pace.
- [ ] `end` on stop; wait for the trailing `final` and close `1000` before discarding state.
- [ ] Render partial as replace-in-place, final as commit; glue a punctuation-only final to the previous word.
- [ ] Pass a `session`; send corrections when the user edits.
- [ ] Type `text` from `/audio/transcribe`; once the user's edit of it settles, send `dictation/correction` once and offer Undo (`dictation/undo`) for what it learned.
- [ ] A Dictation setting over `dictation/models` / `dictation/use` / `dictation/remove-model`: each model with its size, Download and Remove.
- [ ] `error` frame → show it; reconnect on transport loss with a new stream.
