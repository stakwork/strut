/**
 * LIVE text-to-speech test — needs the sherpa addon and downloads Kokoro
 * (350 MB) and, to hear what it said, the small Kroko STT model (57 MB)
 * into STRUT_TEST_TTS_MODEL_DIR (default: a temp dir, so point it at a
 * persistent dir to avoid re-downloading). Opt in with STRUT_TEST_TTS=1
 * (`npm run test:tts`). Skipped otherwise, like the STT live test.
 *
 * Logs what a voice turn waits on: time to the first audio, the whole
 * reply's time, its audio's duration, and the real-time factor.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createTts, type TtsService } from "./tts.js";
import { createStt, loadSherpaEngine, type SttService } from "./stt.js";
import { speakRoutes } from "./routes.js";
import { DEFAULT_TTS_MODEL } from "./models.js";

const enabled = process.env["STRUT_TEST_TTS"] === "1";

const REPLY = "Sure, I can help with that. The meeting with Priya moved to Thursday at three, and I will send the notes after.";

describe("tts live (STRUT_TEST_TTS=1)", { skip: !enabled }, () => {
  let dataDir: string;
  let modelDir: string;
  let tmpModelDir: string | undefined;
  let tts: TtsService;
  let stt: SttService;
  let app: Hono;

  before(async () => {
    assert.ok(await loadSherpaEngine(), "sherpa-onnx-node must be installed for the live test");
    dataDir = await mkdtemp(join(tmpdir(), "strut-tts-live-"));
    modelDir = process.env["STRUT_TEST_TTS_MODEL_DIR"] ?? (tmpModelDir = await mkdtemp(join(tmpdir(), "strut-tts-models-")));
    tts = createTts({ modelDir, env: {} });
    stt = createStt({ dataDir, modelDir, env: {} });
    const t0 = Date.now();
    await tts.ensureModel(DEFAULT_TTS_MODEL);
    console.log(`[tts live] ${DEFAULT_TTS_MODEL} on disk after ${Date.now() - t0} ms`);
    app = new Hono();
    speakRoutes(app, tts);
  });
  after(async () => {
    await tts?.close();
    await stt?.close();
    await rm(dataDir, { recursive: true, force: true });
    if (tmpModelDir) await rm(tmpModelDir, { recursive: true, force: true });
  });

  /** POST /audio/speak and time it as a client sees it. */
  async function speak(body: Record<string, unknown>, opts: { stopAfterFirst?: boolean } = {}) {
    const t0 = performance.now();
    const res = await app.request("/audio/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status !== 200) assert.fail(`${res.status}: ${await res.text()}`);
    const rate = Number(res.headers.get("x-sample-rate"));
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let first = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      first ||= performance.now() - t0;
      chunks.push(value);
      if (opts.stopAfterFirst) {
        await reader.cancel();
        break;
      }
    }
    const total = performance.now() - t0;
    const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) (pcm.set(c, at), (at += c.length));
    const seconds = pcm.length / 2 / rate;
    return { rate, chunks, pcm, first, total, seconds, rtf: total / 1000 / seconds };
  }

  const fmt = (r: Awaited<ReturnType<typeof speak>>) =>
    `first audio ${r.first.toFixed(0)} ms, total ${r.total.toFixed(0)} ms, ${r.seconds.toFixed(2)} s of audio in ${r.chunks.length} piece(s), real-time factor ${r.rtf.toFixed(3)}`;

  it("speaks a two-sentence reply, a sentence at a time, and it is heard back", async () => {
    const cold = await speak({ text: "Hello." });
    console.log(`[tts live] cold (the model loads): ${fmt(cold)}`);
    const r = await speak({ text: REPLY });
    console.log(`[tts live] reply: ${fmt(r)}`);
    assert.equal(r.rate, 24000);
    assert.ok(r.chunks.length >= 2, "expected the reply's sentences to arrive separately");
    assert.ok(r.seconds > 3 && r.seconds < 15, `${r.seconds} s of audio`);
    assert.ok(r.first < r.total, "the first sentence arrives before the reply is done");
    const peak = new Int16Array(r.pcm.buffer, r.pcm.byteOffset, r.pcm.length / 2).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 3000, `peak ${peak}: silence, or samples out of scale`);

    // Hear it back with Kroko: the bytes are speech, at the rate they claim.
    const heard = await stt.transcribe(wav(r.pcm, r.rate), { model: "zipformer-en-kroko" });
    console.log(`[tts live] heard back: ${JSON.stringify(heard.text)}`);
    assert.match(heard.text.toLowerCase(), /meeting/);
    assert.match(heard.text.toLowerCase(), /thursday/);
  });

  it("a client that hangs up frees the speech thread within two sentences", async () => {
    const long = Array.from({ length: 8 }, (_, i) => `This is sentence number ${i + 1} of a long answer nobody waits for.`).join(" ");
    const cut = await speak({ text: long }, { stopAfterFirst: true });
    const next = await speak({ text: "Next." });
    console.log(`[tts live] after a hang-up: the next speech's ${fmt(next)}`);
    assert.equal(cut.chunks.length, 1);
    // Waited for the sentence in flight and at most the one sherpa began
    // before it heard the stop (synthesizer.ts), never the other five.
    assert.ok(next.first < 3 * cut.first, `the next speech waited ${next.first.toFixed(0)} ms; a sentence takes ${cut.first.toFixed(0)}`);
  });
});

/** PCM16 mono → a WAV file. */
function wav(pcm: Uint8Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
