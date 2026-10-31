import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { threadId } from "node:worker_threads";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createStt,
  pcm16ToFloat32,
  wordsOf,
  type EngineRecognizer,
  type EngineResult,
  type EngineStream,
  type SttEngine,
} from "./stt.js";
import { STT_MODELS, sttModelPath } from "./models.js";

/**
 * A scripted fake engine: each recognizer is fed a queue of "what to say
 * after N seconds of audio", so the stream logic (partials, endpoints,
 * two-recognizer mode, flush, session logging) is exercised with no addon.
 */
interface Script {
  /** text to report once at least `at` seconds of audio have been accepted */
  at: number;
  text: string;
  tokens?: string[];
  timestamps?: number[];
  /** report an endpoint once this text is reached */
  endpoint?: boolean;
}

class FakeStream implements EngineStream {
  seconds = 0;
  finished = false;
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void {
    this.seconds += w.samples.length / w.sampleRate;
  }
  inputFinished(): void {
    this.finished = true;
  }
}

class FakeRecognizer implements EngineRecognizer {
  readonly config: Record<string, unknown>;
  readonly script: Script[];
  private offsets = new WeakMap<FakeStream, number>();
  constructor(config: Record<string, unknown>, script: Script[]) {
    this.config = config;
    this.script = script;
  }
  createStream(): EngineStream {
    return new FakeStream();
  }
  isReady(): boolean {
    return false;
  }
  decode(): void {}
  private current(s: EngineStream): Script | undefined {
    const fs = s as FakeStream;
    const local = fs.seconds - (this.offsets.get(fs) ?? 0);
    return [...this.script].reverse().find((x) => local >= x.at);
  }
  isEndpoint(s: EngineStream): boolean {
    return this.current(s)?.endpoint === true;
  }
  reset(s: EngineStream): void {
    const fs = s as FakeStream;
    this.offsets.set(fs, fs.seconds);
  }
  getResult(s: EngineStream): EngineResult {
    const cur = this.current(s);
    if (!cur) return { text: "" };
    return { text: cur.text, tokens: cur.tokens, timestamps: cur.timestamps, start_time: this.offsets.get(s as FakeStream) ?? 0 };
  }
}

function fakeEngine(scripts: Record<string, Script[]>, built: Record<string, unknown>[] = []): SttEngine {
  return {
    OnlineRecognizer: class {
      constructor(config: Record<string, unknown>) {
        built.push(config);
        const tokens = String((config["modelConfig"] as { tokens: string }).tokens);
        const id = STT_MODELS.find((m) => tokens.includes(`/stt/${m.id}/`))?.id ?? "?";
        return new FakeRecognizer(config, scripts[id] ?? []);
      }
    } as unknown as SttEngine["OnlineRecognizer"],
    // Offline (Parakeet): one result for the whole clip, naming its model and length.
    OfflineRecognizer: class {
      readonly id: string;
      constructor(config: Record<string, unknown>) {
        built.push(config);
        const tokens = String((config["modelConfig"] as { tokens: string }).tokens);
        this.id = STT_MODELS.find((m) => tokens.includes(`/stt/${m.id}/`))?.id ?? "?";
      }
      createStream() {
        return { seconds: 0, acceptWaveform(w: { samples: Float32Array; sampleRate: number }) { this.seconds += w.samples.length / w.sampleRate; } };
      }
      decode() {}
      getResult(s: { seconds: number }): EngineResult {
        return { text: ` Heard by ${this.id}.`, tokens: [" Heard", " by", ` ${this.id}.`], timestamps: [0, 0.5, s.seconds - 1] };
      }
    } as unknown as NonNullable<SttEngine["OfflineRecognizer"]>,
    readWave: () => ({ samples: new Float32Array(16000 * 3), sampleRate: 16000 }),
  };
}

/** Pretend `id` is installed under modelDir. */
async function installFake(modelDir: string, id: string): Promise<void> {
  const dir = sttModelPath(modelDir, id);
  await mkdir(dir, { recursive: true });
  for (const f of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"]) await writeFile(join(dir, f), "");
  await writeFile(join(dir, "tokens.txt"), "<blk> 0\n▁S 1\nphinx 2\n");
  await writeFile(join(dir, ".ok"), "x");
}

const silence = (seconds: number) => new Uint8Array(16000 * 2 * seconds);

describe("stt service", () => {
  let root: string;
  let dataDir: string;
  let modelDir: string;
  const env = { STRUT_STT_MODEL: undefined, STRUT_STT_PARTIAL_MODEL: undefined } as Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-stt-"));
    dataDir = join(root, "data");
    modelDir = join(root, "models");
    await installFake(modelDir, "zipformer-en-kroko");
    await installFake(modelDir, "nemo-fast-conformer-en-80ms");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("reports availability from the engine loader and lists install state", async () => {
    const off = createStt({ dataDir, modelDir, env, engine: async () => null, log: () => {} });
    assert.equal(await off.available(), false);
    const on = createStt({ dataDir, modelDir, env, engine: async () => fakeEngine({}), log: () => {} });
    assert.equal(await on.available(), true);
    const models = await on.models();
    assert.equal(models.find((m) => m.id === "zipformer-en-kroko")?.installed, true);
    assert.equal(models.find((m) => m.id === "zipformer-en-kroko")?.default, "model");
    assert.equal(models.find((m) => m.id === "nemo-fast-conformer-en-80ms")?.default, "partialModel");
    assert.equal(models.find((m) => m.id === "nemo-fast-conformer-en-480ms")?.installed, false);
  });

  it("openStream throws a clear error without the addon", async () => {
    const stt = createStt({ dataDir, modelDir, env, engine: async () => null, log: () => {} });
    await assert.rejects(() => stt.openStream({ partialModel: null }), /stt not available/);
  });

  it("openStream without the addon fails before downloading a model", async () => {
    let fetched = 0;
    const fetchImpl = (async () => (fetched++, new Response(null, { status: 500 }))) as typeof fetch;
    const stt = createStt({ dataDir, modelDir: join(root, "empty-models"), env, engine: async () => null, fetchImpl, log: () => {} });
    await assert.rejects(() => stt.openStream({}), /stt not available/);
    await assert.rejects(() => stt.ensureModel("zipformer-en-kroko"), /stt not available/);
    assert.equal(fetched, 0);
  });

  it("single recognizer: partials on change, final + reset on endpoint, flush on end", async () => {
    const engine = fakeEngine({
      "zipformer-en-kroko": [
        { at: 0.5, text: "hello", tokens: ["▁hello"], timestamps: [0.3] },
        { at: 1.0, text: "hello world", tokens: ["▁hello", "▁wor", "ld"], timestamps: [0.3, 0.8, 0.9], endpoint: true },
        { at: 1.5, text: "again", tokens: ["▁again"], timestamps: [0.1] },
      ],
    });
    const stt = createStt({ dataDir, modelDir, env, engine: async () => engine, log: () => {} });
    const s = await stt.openStream({ partialModel: null, session: "s1" });
    assert.equal(s.model, "zipformer-en-kroko");
    assert.equal(s.partialModel, null);
    const events = [];
    for (let i = 0; i < 12; i++) events.push(...(await s.push(silence(0.1))));
    events.push(...(await s.end()));
    await s.flush();
    assert.deepEqual(events, [
      { type: "partial", text: "hello" },
      { type: "partial", text: "hello world" },
      { type: "final", index: 0, text: "hello world", words: [{ text: "hello", start: 0.3 }, { text: "world", start: 0.8 }] },
      // after the reset at ~1.1 s, the second script line is reached 1.5 s later — that's
      // during end()'s 2 s silence pad, so it surfaces as the trailing final only.
      { type: "final", index: 1, text: "again", words: [{ text: "again", start: 1.2 }] },
    ]);
    // Session log captured both finals.
    const entries = (await stt.sessions.get("s1")) ?? [];
    assert.deepEqual(entries.map((e) => (e.type === "final" ? e.text : e.type)), ["hello world", "again"]);
    await stt.correct("s1", 1, "again!");
    assert.equal(((await stt.sessions.get("s1")) ?? []).at(-1)?.type, "correction");
    // A later connection on the same session keeps counting.
    const s2 = await stt.openStream({ partialModel: null, session: "s1" });
    const later = [];
    for (let i = 0; i < 11; i++) later.push(...(await s2.push(silence(0.1))));
    assert.equal(later.find((e) => e.type === "final")?.index, 2);
  });

  it("two recognizers: partials from the fast model, finals + endpoint from the main one", async () => {
    const built: Record<string, unknown>[] = [];
    const engine = fakeEngine(
      {
        "zipformer-en-kroko": [{ at: 1.0, text: "Hello, world.", tokens: ["▁Hello", ","], timestamps: [0.2, 0.5], endpoint: true }],
        "nemo-fast-conformer-en-80ms": [
          { at: 0.2, text: "hel" },
          { at: 0.4, text: "hello" },
          { at: 0.8, text: "hello world" },
        ],
      },
      built,
    );
    const stt = createStt({ dataDir, modelDir, env, engine: async () => engine, log: () => {} });
    const s = await stt.openStream({ hotwords: ["Sphinx"], hotwordsScore: 3 });
    assert.equal(s.partialModel, "nemo-fast-conformer-en-80ms");
    assert.equal(s.hotwords, "inline");
    const events = [];
    for (let i = 0; i < 11; i++) events.push(...(await s.push(silence(0.1))));
    assert.deepEqual(events, [
      { type: "partial", text: "hel" },
      { type: "partial", text: "hello" },
      { type: "partial", text: "hello world" },
      { type: "final", index: 0, text: "Hello, world.", words: [{ text: "Hello,", start: 0.2 }] },
    ]);
    // Hotwords went to the main recognizer only, with bpe modeling unit + vocab.
    const main = built.find((c) => String((c["modelConfig"] as { tokens: string }).tokens).includes("zipformer-en-kroko"))!;
    const fast = built.find((c) => String((c["modelConfig"] as { tokens: string }).tokens).includes("nemo-fast"))!;
    assert.equal(main["decodingMethod"], "modified_beam_search");
    assert.equal(main["hotwordsScore"], 3);
    assert.equal((main["modelConfig"] as Record<string, unknown>)["modelingUnit"], "bpe");
    assert.match(String((main["modelConfig"] as Record<string, unknown>)["bpeVocab"]), /bpe\.vocab$/);
    assert.equal(fast["decodingMethod"], "greedy_search");
    assert.equal(fast["hotwordsFile"], undefined);
  });

  it("caches recognizers per (model, hotwords, score, endpoint) and resolves named lists", async () => {
    const built: Record<string, unknown>[] = [];
    const engine = fakeEngine({}, built);
    const stt = createStt({ dataDir, modelDir, env, engine: async () => engine, log: () => {} });
    await stt.hotwords.put("team", "Stakwork\nSphinx :3\n");
    const a = await stt.openStream({ partialModel: null, hotwords: "team" });
    const b = await stt.openStream({ partialModel: null, hotwords: "team" });
    const c = await stt.openStream({ partialModel: null, hotwords: "team", hotwordsScore: 4 });
    const d = await stt.openStream({ partialModel: null });
    assert.equal(a.hotwords, "team");
    assert.equal(b.hotwords, "team");
    assert.equal(c.hotwords, "team");
    assert.equal(d.hotwords, null);
    assert.equal(built.length, 3);
    await assert.rejects(() => stt.openStream({ partialModel: null, hotwords: "nope" }), /unknown hotwords list/);
  });

  it("ignores hotwords on models that cannot take them", async () => {
    const built: Record<string, unknown>[] = [];
    const stt = createStt({ dataDir, modelDir, env, engine: async () => fakeEngine({}, built), log: () => {} });
    const s = await stt.openStream({ model: "nemo-fast-conformer-en-80ms", partialModel: null, hotwords: ["x"] });
    assert.equal(s.model, "nemo-fast-conformer-en-80ms");
    assert.equal(built[0]!["decodingMethod"], "greedy_search");
  });

  it("an offline model (Parakeet) transcribes a whole clip in one pass and cannot stream", async () => {
    await installFake(modelDir, "parakeet-tdt-en-0.6b-v2");
    const built: Record<string, unknown>[] = [];
    const stt = createStt({ dataDir, modelDir, env, engine: async () => fakeEngine({}, built), log: () => {} });
    const r = await stt.transcribe(new Uint8Array(64), { model: "parakeet-tdt-en-0.6b-v2", session: "p" });
    assert.equal(r.model, "parakeet-tdt-en-0.6b-v2");
    assert.equal(r.text, "Heard by parakeet-tdt-en-0.6b-v2.");
    assert.deepEqual(r.segments[0]!.words.map((w) => [w.text, w.start]), [["Heard", 0], ["by", 0.5], ["parakeet-tdt-en-0.6b-v2.", 2]]);
    assert.equal((built[0]!["modelConfig"] as { modelType: string }).modelType, "nemo_transducer");
    assert.equal(((await stt.sessions.get("p")) ?? []).length, 1);
    await assert.rejects(() => stt.openStream({ model: "parakeet-tdt-en-0.6b-v2", partialModel: null }), /offline/);
  });

  it("transcribe uses the user's speech pick once it is installed, the default until then", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const install = async (_a: unknown, dir: string) => {
      await gate;
      await installFake(modelDir, dir.split("/").pop()!);
    };
    const stt = createStt({ dataDir, modelDir, env, engine: async () => fakeEngine({ "zipformer-en-kroko": [{ at: 1, text: "kroko", endpoint: true }] }), install, log: () => {} });
    await stt.dictation.use({ speech: "parakeet-tdt-en-0.6b-v2" });
    assert.equal((await stt.transcribe(new Uint8Array(64))).model, "zipformer-en-kroko");
    release();
    await stt.dictation.idle();
    assert.equal((await stt.transcribe(new Uint8Array(64))).model, "parakeet-tdt-en-0.6b-v2");
    // The caller's `model` still wins.
    assert.equal((await stt.transcribe(new Uint8Array(64), { model: "zipformer-en-kroko" })).model, "zipformer-en-kroko");
  });

  it("transcribe runs the single-recognizer path over a WAV and joins the finals", async () => {
    const engine = fakeEngine({
      "zipformer-en-kroko": [
        { at: 1.0, text: "one", endpoint: true },
        { at: 1.0, text: "two", endpoint: true },
      ],
    });
    const stt = createStt({ dataDir, modelDir, env, engine: async () => engine, log: () => {} });
    const r = await stt.transcribe(new Uint8Array(64));
    assert.equal(r.model, "zipformer-en-kroko");
    assert.ok(r.segments.length >= 1);
    assert.equal(r.text, r.segments.map((s) => s.text).join(" "));
  });

  describe("in a worker thread (the default)", () => {
    /** A fake engine as a module the worker can import: a stream ends a
     *  segment every second of audio, each result names the thread that
     *  decoded it, and every decode holds that thread for `busyMs` the way
     *  sherpa's native decode does. */
    const engineModule = (busyMs: number) =>
      `data:text/javascript,${encodeURIComponent(`
import { threadId } from "node:worker_threads";
class Stream { seconds = 0; offset = 0; pending = false;
  acceptWaveform(w) { this.seconds += w.samples.length / w.sampleRate; this.pending = true; }
  inputFinished() {} }
export class OnlineRecognizer {
  constructor(config) { this.config = config; }
  createStream() { return new Stream(); }
  isReady(s) { return s.pending; }
  decode(s) { s.pending = false; const end = Date.now() + ${busyMs}; while (Date.now() < end) {} }
  isEndpoint(s) { return s.seconds - s.offset >= 1; }
  reset(s) { s.offset = s.seconds; }
  getResult(s) { return { text: s.seconds > s.offset ? "decoded on " + threadId : "" }; }
}
export function readWave() { return { samples: new Float32Array(16000 * 3), sampleRate: 16000 }; }
`)}`;

    /** The longest the event loop went without running a 5 ms interval while `work` ran. */
    async function maxLag(work: () => Promise<unknown>): Promise<number> {
      let last = performance.now();
      let max = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last);
        last = now;
      }, 5);
      try {
        await work();
      } finally {
        clearInterval(timer);
      }
      return Math.max(max, performance.now() - last);
    }

    it("a stream is decoded off the main thread, its finals counted and logged here", async () => {
      const stt = createStt({ dataDir, modelDir, env, engineModule: engineModule(0), log: () => {} });
      try {
        assert.equal(await stt.available(), true);
        const s = await stt.openStream({ partialModel: null, session: "w1" });
        const events = [];
        for (let i = 0; i < 11; i++) events.push(...(await s.push(silence(0.1))));
        events.push(...(await s.end()));
        await s.flush();
        const finals = events.filter((e) => e.type === "final");
        assert.deepEqual(finals.map((e) => e.index), [0, 1]);
        const decodedOn = Number(/decoded on (\d+)/.exec(finals[0]!.text)?.[1]);
        assert.ok(decodedOn > 0 && decodedOn !== threadId, `decoded on thread ${decodedOn}`);
        assert.equal(((await stt.sessions.get("w1")) ?? []).length, 2);
        await assert.rejects(s.push(silence(0.1)), /stream is closed/);
      } finally {
        await stt.close();
      }
    });

    it("transcribe leaves the event loop free while the recognizer works — in process, it would not", async () => {
      const inWorker = createStt({ dataDir, modelDir, env, engineModule: engineModule(20), log: () => {} });
      const inline = createStt({ dataDir, modelDir, env, engine: () => import(engineModule(20)), log: () => {} });
      try {
        await inWorker.available(); // the worker is up before the clock starts
        let r: Awaited<ReturnType<typeof inWorker.transcribe>> | undefined;
        const lagWorker = await maxLag(async () => (r = await inWorker.transcribe(new Uint8Array(64))));
        const lagInline = await maxLag(() => inline.transcribe(new Uint8Array(64)));
        assert.deepEqual(r!.segments.map((s) => s.text.startsWith("decoded on")), [true, true, true]);
        assert.ok(lagInline >= 400, `in process: the loop stalled ${lagInline.toFixed(0)} ms`);
        assert.ok(lagWorker < 150, `in the worker: the loop stalled ${lagWorker.toFixed(0)} ms`);
      } finally {
        await inWorker.close();
      }
    });

    it("an engine the worker cannot load is 'not available', never a download", async () => {
      const stt = createStt({ dataDir, modelDir, env, engineModule: "data:text/javascript,throw new Error('no addon')", log: () => {} });
      try {
        assert.equal(await stt.available(), false);
        await assert.rejects(() => stt.openStream({ partialModel: null }), /stt not available/);
      } finally {
        await stt.close();
      }
    });
  });

  it("ensureModel rejects unknown ids and dedupes in-flight downloads", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return new Response("not a tarball", { status: 200 });
    }) as unknown as typeof fetch;
    const stt = createStt({ dataDir, modelDir, env, engine: async () => fakeEngine({}), fetchImpl, log: () => {} });
    await assert.rejects(() => stt.ensureModel("nope"), /unknown stt model/);
    const p1 = stt.ensureModel("nemo-fast-conformer-en-480ms").catch((e: Error) => e.message);
    const p2 = stt.ensureModel("nemo-fast-conformer-en-480ms").catch((e: Error) => e.message);
    const [m1, m2] = await Promise.all([p1, p2]);
    assert.match(String(m1), /sha256 mismatch/);
    assert.equal(m1, m2);
    assert.equal(fetches, 1);
  });

  // The recognizers are held by open streams and calls in flight; idleMs
  // after the last hold goes, they are unloaded and the next use builds
  // them again (Parakeet alone is ~1.1 GB; plans/desktop-memory.md).
  it("unloads the recognizers once nothing has held them for idleMs, and builds them again on the next use", async () => {
    const built: Record<string, unknown>[] = [];
    const engine = fakeEngine({ "zipformer-en-kroko": [{ at: 1, text: "hi", endpoint: true }] }, built);
    const logs: string[] = [];
    const stt = createStt({ dataDir, modelDir, env, engine: async () => engine, idleMs: 40, log: (m) => logs.push(m) });
    const s1 = await stt.openStream({ partialModel: null });
    await s1.push(silence(1));
    await s1.end();
    // Used again within idleMs: the recognizer it has.
    const s2 = await stt.openStream({ partialModel: null });
    await s2.end();
    assert.equal(built.length, 1);
    await sleep(120);
    assert.ok(logs.some((m) => /unloaded/.test(m)), logs.join("\n"));
    const s3 = await stt.openStream({ partialModel: null });
    assert.ok((await s3.push(silence(1))).some((ev) => ev.type === "partial" && ev.text === "hi"));
    await s3.end();
    assert.equal(built.length, 2);
    await stt.close();
  });

  it("an open stream and a call in flight hold the recognizers past idleMs", async () => {
    const built: Record<string, unknown>[] = [];
    const engine = fakeEngine({ "zipformer-en-kroko": [{ at: 1, text: "hi", endpoint: true }] }, built);
    const stt = createStt({ dataDir, modelDir, env, engine: async () => engine, idleMs: 40, log: () => {} });
    const s = await stt.openStream({ partialModel: null });
    await sleep(120);
    // Still its recognizer, still its stream.
    assert.ok((await s.push(silence(1))).some((ev) => ev.type === "partial" && ev.text === "hi"));
    assert.equal(built.length, 1);
    s.close();
    await sleep(120);
    // A transcription after the idle unload builds again, and holds while it runs.
    const r = await stt.transcribe(new Uint8Array(100), { model: "zipformer-en-kroko" });
    assert.equal(r.model, "zipformer-en-kroko");
    assert.equal(built.length, 2);
    await stt.close();
  });

  it("an open that fails holds nothing, and close() cancels a pending unload", async () => {
    const built: Record<string, unknown>[] = [];
    const engine = fakeEngine({ "zipformer-en-kroko": [] }, built);
    const logs: string[] = [];
    const stt = createStt({ dataDir, modelDir, env, engine: async () => engine, idleMs: 40, log: (m) => logs.push(m) });
    // Parakeet cannot stream: the open fails, and no stream is left holding the recognizers.
    await installFake(modelDir, "parakeet-tdt-en-0.6b-v2");
    await assert.rejects(() => stt.openStream({ model: "parakeet-tdt-en-0.6b-v2", partialModel: null }), /offline/);
    const s = await stt.openStream({ partialModel: null });
    await s.end();
    await sleep(120);
    assert.equal(logs.filter((m) => /unloaded/.test(m)).length, 1, "the failed open left no hold behind");
    // A use arms the timer; closing the service cancels it.
    await (await stt.openStream({ partialModel: null })).end();
    await stt.close();
    await sleep(120);
    assert.equal(logs.filter((m) => /unloaded/.test(m)).length, 1);
    await stt.close();
  });
});

describe("helpers", () => {
  it("wordsOf groups subword tokens on the ▁/space marker with segment offsets", () => {
    assert.deepEqual(
      wordsOf({ text: "", tokens: [" A", "s", "k", " not", "▁now"], timestamps: [0.3, 0.4, 0.5, 0.7, 1.0], start_time: 10 }),
      [
        { text: "Ask", start: 10.3 },
        { text: "not", start: 10.7 },
        { text: "now", start: 11 },
      ],
    );
  });

  it("pcm16ToFloat32 scales and honours the byte offset", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(-32768, 2);
    buf.writeInt16LE(16384, 4);
    buf.writeInt16LE(32767, 6);
    const view = new Uint8Array(buf.buffer, buf.byteOffset + 2, 6);
    assert.deepEqual(Array.from(pcm16ToFloat32(view)), [-1, 0.5, 32767 / 32768]);
  });
});
