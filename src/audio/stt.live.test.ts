/**
 * LIVE speech-to-text test — needs the sherpa addon and downloads the small
 * kroko model (57 MB) into STRUT_TEST_STT_MODEL_DIR (default: a temp dir, so
 * point it at a persistent dir to avoid re-downloading). Opt in with
 * STRUT_TEST_STT=1. Skipped otherwise, like the graph tests.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStt, loadSherpaEngine, pcm16ToFloat32, type SttEvent, type SttService } from "./stt.js";
import { sttModelPath } from "./models.js";

const enabled = process.env["STRUT_TEST_STT"] === "1";

describe("stt live (STRUT_TEST_STT=1)", { skip: !enabled }, () => {
  let dataDir: string;
  let stt: SttService;
  let wavPath: string;
  const modelDir = process.env["STRUT_TEST_STT_MODEL_DIR"];
  let tmpModelDir: string | undefined;

  before(async () => {
    assert.ok(await loadSherpaEngine(), "sherpa-onnx-node must be installed for the live test");
    dataDir = await mkdtemp(join(tmpdir(), "strut-stt-live-"));
    if (!modelDir) tmpModelDir = await mkdtemp(join(tmpdir(), "strut-stt-models-"));
    stt = createStt({ dataDir, modelDir: modelDir ?? tmpModelDir!, env: {} });
    const dir = await stt.ensureModel("zipformer-en-kroko");
    assert.equal(dir, sttModelPath(modelDir ?? tmpModelDir!, "zipformer-en-kroko"));
    wavPath = join(dir, "test_wavs", "0.wav");
  });
  after(async () => {
    await stt?.close();
    await rm(dataDir, { recursive: true, force: true });
    if (tmpModelDir) await rm(tmpModelDir, { recursive: true, force: true });
  });

  async function streamWav(opts: Parameters<SttService["openStream"]>[0]): Promise<SttEvent[]> {
    const engine = (await loadSherpaEngine())!;
    const wave = engine.readWave(wavPath);
    const s = await stt.openStream({ ...opts, sampleRate: wave.sampleRate });
    const frame = Math.round(wave.sampleRate * 0.1);
    const events: SttEvent[] = [];
    for (let i = 0; i < wave.samples.length; i += frame) {
      // Round-trip through PCM16 so the bytes path is what's exercised.
      const chunk = wave.samples.subarray(i, i + frame);
      const pcm = new Uint8Array(chunk.length * 2);
      const view = new DataView(pcm.buffer);
      chunk.forEach((v, j) => view.setInt16(j * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true));
      assert.equal(pcm16ToFloat32(pcm).length, chunk.length);
      events.push(...(await s.push(pcm)));
    }
    events.push(...(await s.end()));
    await s.flush();
    return events;
  }

  it("streams the bundled test clip to partials and a final", async () => {
    const events = await streamWav({ partialModel: null, session: "live" });
    const finals = events.filter((e) => e.type === "final");
    const partials = events.filter((e) => e.type === "partial");
    assert.ok(partials.length >= 1, "expected partials");
    assert.ok(finals.length >= 1, "expected a final");
    const text = finals.map((e) => (e.type === "final" ? e.text : "")).join(" ");
    assert.match(text.toLowerCase(), /ask not what your country can do for you/);
    const first = finals[0]!;
    assert.ok(first.type === "final" && first.words.length >= 5 && first.words[0]!.start >= 0);
    const logged = await stt.sessions.get("live");
    assert.ok(logged && logged.length >= 1);
  });

  it("accepts a hotwords list (modified_beam_search path) and still transcribes", async () => {
    await stt.hotwords.put("live", "country :2\nAsk\n");
    const events = await streamWav({ partialModel: null, hotwords: "live" });
    const text = events
      .filter((e) => e.type === "final")
      .map((e) => (e.type === "final" ? e.text : ""))
      .join(" ");
    assert.match(text.toLowerCase(), /ask not what your country/);
  });

  it("transcribe() over the WAV bytes matches the stream", async () => {
    const { readFile } = await import("node:fs/promises");
    const r = await stt.transcribe(await readFile(wavPath));
    assert.match(r.text.toLowerCase(), /ask not what your country/);
    assert.equal(r.model, "zipformer-en-kroko");
  });
});

/**
 * LIVE Parakeet (offline) — downloads Parakeet TDT 0.6B v2 int8 (482 MB)
 * through the dictation picker (download, sha256, extract) and transcribes
 * Kroko's test clip with it. Opt in with STRUT_TEST_STT=1 and
 * STRUT_TEST_STT_PARAKEET=1; point STRUT_TEST_STT_MODEL_DIR at a persistent
 * dir to download once.
 */
describe("parakeet live (STRUT_TEST_STT=1 STRUT_TEST_STT_PARAKEET=1)", { skip: !(enabled && process.env["STRUT_TEST_STT_PARAKEET"] === "1") }, () => {
  let dataDir: string;
  let stt: SttService;
  const modelDir = process.env["STRUT_TEST_STT_MODEL_DIR"];
  let tmpModelDir: string | undefined;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "strut-stt-live-"));
    if (!modelDir) tmpModelDir = await mkdtemp(join(tmpdir(), "strut-stt-models-"));
    stt = createStt({ dataDir, modelDir: modelDir ?? tmpModelDir!, env: {} });
  });
  after(async () => {
    await stt?.close();
    await rm(dataDir, { recursive: true, force: true });
    if (tmpModelDir) await rm(tmpModelDir, { recursive: true, force: true });
  });

  it("picked, downloaded and verified, it transcribes a clip in one pass, cased and punctuated", async () => {
    const { readFile } = await import("node:fs/promises");
    const clip = await readFile(join(await stt.ensureModel("zipformer-en-kroko"), "test_wavs", "0.wav"));
    await stt.dictation.use({ speech: "parakeet-tdt-en-0.6b-v2" });
    await stt.dictation.idle();
    const listed = await stt.dictation.list();
    assert.equal(listed.find((m) => m.id === "parakeet-tdt-en-0.6b-v2")?.state, "installed", JSON.stringify(listed));
    const t0 = Date.now();
    const first = await stt.transcribe(clip);
    const firstMs = Date.now() - t0;
    const t1 = Date.now();
    const r = await stt.transcribe(clip);
    const warmMs = Date.now() - t1;
    console.log(`[parakeet] "${r.text}" — first call ${firstMs} ms (recognizer build + decode), warm ${warmMs} ms (decode ${r.durationMs} ms)`);
    assert.equal(first.model, "parakeet-tdt-en-0.6b-v2");
    assert.equal(r.text, first.text);
    assert.match(r.text, /^[A-Z]/);
    assert.match(r.text.toLowerCase(), /ask not what your country can do for you/);
  });
});
