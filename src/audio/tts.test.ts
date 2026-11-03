import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { threadId } from "node:worker_threads";
import { join } from "node:path";
import { Hono } from "hono";
import { createTts, float32ToPcm16, type TtsEngine, type TtsService } from "./tts.js";
import { speakRoutes } from "./routes.js";
import { TTS_MODELS, ttsModelPath } from "./models.js";
import type { Installer } from "./download.js";

const MODEL = TTS_MODELS[0]!;

/**
 * A fake Kokoro: one piece per sentence, each four samples of
 * (sentence number) / 100. `gate(i)` holds sentence i until it resolves, the
 * way a real sentence takes its time; a 0 from `onProgress` stops it at
 * once (sherpa may finish one more). `fail` throws at that sentence.
 */
interface Fake {
  built: Record<string, unknown>[];
  /** Every sentence generated, with the request's sid and speed. */
  generated: { text: string; sid: number; speed: number }[];
  gate?: (i: number) => Promise<void>;
  fail?: number;
}

function fakeEngine(fake: Fake): TtsEngine {
  return {
    OfflineTts: class {
      readonly sampleRate = 24000;
      constructor(config: Record<string, unknown>) {
        fake.built.push(config);
      }
      async generateAsync(req: { text: string; sid: number; speed: number; onProgress?: (i: { samples: Float32Array; progress: number }) => number }) {
        const sentences = req.text.split(/(?<=[.!?])\s+/).filter(Boolean);
        let n = 0;
        for (const [i, text] of sentences.entries()) {
          await fake.gate?.(i);
          if (fake.fail === i) throw new Error(`sentence ${i} failed`);
          fake.generated.push({ text, sid: req.sid, speed: req.speed });
          n++;
          if (req.onProgress?.({ samples: new Float32Array(4).fill((i + 1) / 100), progress: (i + 1) / sentences.length }) === 0) break;
        }
        return { samples: new Float32Array(4 * n), sampleRate: 24000 };
      }
    } as unknown as TtsEngine["OfflineTts"],
  };
}

/** Sentence i's piece, as the route writes it. */
const piece = (i: number) => float32ToPcm16(new Float32Array(4).fill((i + 1) / 100));

/** Pretend the model is on disk. */
async function installFake(modelDir: string): Promise<void> {
  const dir = ttsModelPath(modelDir, MODEL.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".ok"), "x");
}

/** A promise and the function that resolves it. */
function latch(): { done: Promise<void>; open: () => void } {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  return { done, open };
}

const post = (app: Hono, body: unknown) =>
  app.request("/audio/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function readAll(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

describe("tts", () => {
  let modelDir: string;
  let fake: Fake;
  let tts: TtsService;
  let app: Hono;

  const service = (o: Partial<Parameters<typeof createTts>[0]> = {}) =>
    createTts({ modelDir, env: {}, engine: async () => fakeEngine(fake), log: () => {}, ...o });

  beforeEach(async () => {
    modelDir = await mkdtemp(join(tmpdir(), "strut-tts-"));
    fake = { built: [], generated: [] };
    tts = service();
    app = new Hono();
    speakRoutes(app, tts);
  });
  afterEach(async () => {
    await tts.close();
    await rm(modelDir, { recursive: true, force: true });
  });

  it("speaks a sentence at a time as 16-bit PCM, the model built once", async () => {
    await installFake(modelDir);
    const s = await tts.speak("Hello there. How are you? Fine.");
    assert.equal(s.model, MODEL.id);
    assert.equal(s.voice, "af_heart");
    assert.equal(s.sampleRate, 24000);
    const got: Uint8Array[] = [];
    for await (const p of s.audio) got.push(p);
    assert.deepEqual(got, [piece(0), piece(1), piece(2)]);
    assert.deepEqual(
      fake.generated.map((g) => [g.text, g.sid, g.speed]),
      [["Hello there.", 3, 1], ["How are you?", 3, 1], ["Fine.", 3, 1]],
    );
    // (0.01 * 32768) → 328, little-endian.
    assert.deepEqual([...piece(0).subarray(0, 2)], [328 & 0xff, 328 >> 8]);

    for await (const _ of (await tts.speak("Again.")).audio);
    assert.equal(fake.built.length, 1);
    const kokoro = (fake.built[0]!["model"] as { kokoro: Record<string, string> }).kokoro;
    assert.equal(kokoro["model"], join(ttsModelPath(modelDir, MODEL.id), "model.onnx"));
    assert.equal(kokoro["lang"], "en-us");
    assert.equal(fake.built[0]!["maxNumSentences"], 1);
  });

  it("POST /audio/speak streams each sentence as it is done, with its headers", async () => {
    await installFake(modelDir);
    const second = latch();
    fake.gate = (i) => (i === 1 ? second.done : Promise.resolve());
    const res = await post(app, { text: "First one. Second one.", voice: "bm_george", speed: 1.25 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/pcm");
    assert.equal(res.headers.get("x-sample-rate"), "24000");
    assert.equal(res.headers.get("x-voice"), "bm_george");
    const reader = res.body!.getReader();
    // The first sentence arrives while the second is still being generated.
    assert.deepEqual((await reader.read()).value, piece(0));
    assert.deepEqual(fake.generated.map((g) => g.text), ["First one."]);
    second.open();
    assert.deepEqual((await reader.read()).value, piece(1));
    assert.equal((await reader.read()).done, true);
    assert.deepEqual(fake.generated[0], { text: "First one.", sid: MODEL.voices.indexOf("bm_george"), speed: 1.25 });
  });

  it("refuses a bad body with 400, before any model loads", async () => {
    await installFake(modelDir);
    const cases: [unknown, RegExp][] = [
      ["not json", /expected \{ text/],
      [{}, /expected \{ text/],
      [{ text: 5 }, /expected \{ text/],
      [{ text: "hi", speed: "fast" }, /expected \{ text/],
      [{ text: "   " }, /nothing to say/],
      [{ text: "x".repeat(10_001) }, /at most 10000/],
      [{ text: "hi", voice: "nobody" }, /unknown voice "nobody" .*af_heart/],
      [{ text: "hi", speed: 3 }, /speed must be between 0.5 and 2/],
      [{ text: "hi", model: "nope" }, /unknown tts model "nope"/],
    ];
    for (const [body, error] of cases) {
      const res = await post(app, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(((await res.json()) as { error: string }).error, error);
    }
    assert.equal(fake.built.length, 0);
  });

  it("a model not on disk is downloaded first; without the addon, 501 and no download", async () => {
    const installs: string[] = [];
    const install: Installer = async (asset, dir) => {
      installs.push(`${asset.id} → ${dir}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".ok"), "x");
    };
    const withInstall = service({ install });
    const a = new Hono();
    speakRoutes(a, withInstall);
    const before = (await (await a.request("/audio/speak")).json()) as { available: boolean; models: { id: string; installed: boolean; default: boolean; voices: string[] }[] };
    assert.equal(before.available, true);
    assert.deepEqual(before.models.map((m) => [m.id, m.installed, m.default, m.voices.length]), [[MODEL.id, false, true, 54]]);
    const res = await post(a, { text: "Hello." });
    assert.equal(res.status, 200);
    assert.deepEqual(await readAll(res), piece(0));
    assert.deepEqual(installs, [`${MODEL.id} → ${ttsModelPath(modelDir, MODEL.id)}`]);
    const after = (await (await a.request("/audio/speak")).json()) as { models: { installed: boolean }[] };
    assert.equal(after.models[0]!.installed, true);

    const none = service({ engine: async () => null, install });
    const b = new Hono();
    speakRoutes(b, none);
    const refused = await post(b, { text: "Hello." });
    assert.equal(refused.status, 501);
    assert.match(((await refused.json()) as { error: string }).error, /tts not available/);
    assert.equal(installs.length, 1);
  });

  it("a client that hangs up stops the generation", async () => {
    await installFake(modelDir);
    const second = latch();
    fake.gate = (i) => (i === 1 ? second.done : Promise.resolve());
    const res = await post(app, { text: "One. Two. Three. Four." });
    const reader = res.body!.getReader();
    assert.deepEqual((await reader.read()).value, piece(0));
    await reader.cancel();
    second.open(); // the sentence in flight finishes; nothing after it starts
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fake.generated.map((g) => g.text), ["One.", "Two."]);
    // The speech thread is free for the next one.
    fake.gate = undefined;
    assert.deepEqual(await readAll(await post(app, { text: "Next." })), piece(0));
  });

  it("a client that hangs up before the first sentence stops it too", async () => {
    await installFake(modelDir);
    const first = latch();
    fake.gate = (i) => (i === 0 ? first.done : Promise.resolve());
    const hangUp = new AbortController();
    const res = app.request("/audio/speak", { method: "POST", body: JSON.stringify({ text: "One. Two. Three." }), signal: hangUp.signal });
    await new Promise((r) => setTimeout(r, 10));
    hangUp.abort();
    first.open();
    assert.equal((await readAll(await res)).length, 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fake.generated.map((g) => g.text), ["One."]);
  });

  it("speaks one at a time, in the order asked", async () => {
    await installFake(modelDir);
    const held = latch();
    fake.gate = (i) => (i === 1 && fake.generated.length === 1 ? held.done : Promise.resolve());
    const a = await tts.speak("A one. A two.");
    const b = await tts.speak("B one.");
    const readA = (async () => {
      const got: Uint8Array[] = [];
      for await (const p of a.audio) got.push(p);
      return got;
    })();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fake.generated.map((g) => g.text), ["A one."]);
    held.open();
    const gotB: Uint8Array[] = [];
    for await (const p of b.audio) gotB.push(p);
    assert.equal((await readA).length, 2);
    assert.deepEqual(gotB, [piece(0)]);
    assert.deepEqual(fake.generated.map((g) => g.text), ["A one.", "A two.", "B one."]);
  });

  it("an error before the first sentence is a 500; after it, the body ends", async () => {
    await installFake(modelDir);
    fake.fail = 0;
    const early = await post(app, { text: "One. Two." });
    assert.equal(early.status, 500);
    assert.match(((await early.json()) as { error: string }).error, /sentence 0 failed/);
    fake.fail = 1;
    const late = await post(app, { text: "One. Two. Three." });
    assert.equal(late.status, 200);
    assert.deepEqual(await readAll(late), piece(0));
  });

  it("an aborted signal stops a speech nobody reads", async () => {
    await installFake(modelDir);
    const second = latch();
    fake.gate = (i) => (i === 1 ? second.done : Promise.resolve());
    const stop = new AbortController();
    await tts.speak("One. Two. Three.", { signal: stop.signal });
    stop.abort();
    second.open();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(fake.generated.length <= 2, `generated ${fake.generated.length}`);
    assert.deepEqual(concat(...(await collect(await tts.speak("Next.")))), piece(0));
  });

  describe("in a worker thread (the default)", () => {
    /** A fake engine as a module the worker can import: each sentence's
     *  samples are the thread that generated it, as a 16-bit value. */
    const engineModule = `data:text/javascript,${encodeURIComponent(`
import { threadId } from "node:worker_threads";
export class OfflineTts {
  sampleRate = 24000;
  async generateAsync(req) {
    for (const _ of req.text.split(". ")) {
      await new Promise((r) => setTimeout(r, 5));
      if (req.onProgress?.({ samples: new Float32Array(2).fill(threadId / 32768), progress: 1 }) === 0) break;
    }
    return { samples: new Float32Array(0), sampleRate: 24000 };
  }
}
`)}`;

    it("speech is generated off the main thread and streamed back", async () => {
      await installFake(modelDir);
      const w = createTts({ modelDir, env: {}, engineModule, log: () => {} });
      try {
        assert.equal(await w.available(), true);
        const got = await collect(await w.speak("One. Two. Three"));
        assert.equal(got.length, 3);
        const on = new DataView(got[0]!.buffer, got[0]!.byteOffset).getInt16(0, true);
        assert.ok(on > 0 && on !== threadId, `generated on thread ${on}`);
      } finally {
        await w.close();
      }
    });

    it("an engine the worker cannot load is 'not available', never a download", async () => {
      let installs = 0;
      const w = createTts({ modelDir, env: {}, engineModule: "data:text/javascript,throw new Error('no addon')", install: async () => void installs++, log: () => {} });
      try {
        assert.equal(await w.available(), false);
        await assert.rejects(() => w.speak("Hello."), /tts not available/);
        assert.equal(installs, 0);
      } finally {
        await w.close();
      }
    });
  });
});

async function collect(audio: AsyncIterable<Uint8Array> | { audio: AsyncIterable<Uint8Array> }): Promise<Uint8Array[]> {
  const it = Symbol.asyncIterator in audio ? audio : audio.audio;
  const got: Uint8Array[] = [];
  for await (const p of it) got.push(p);
  return got;
}
