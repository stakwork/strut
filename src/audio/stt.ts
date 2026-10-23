/**
 * Speech-to-text service over sherpa-onnx (plans/local-desktop-and-stt.md §4).
 *
 * Owns: models on disk (downloaded and verified by download.ts; the user's
 * dictation picks in dictation-models.ts), hotword lists, the streaming session
 * (PCM in → partial/final events out) and its session log, and the batch
 * `transcribe` that runs the same streaming path over a WAV. Routes
 * (`routes.ts`) and the WebSocket (`ws.ts`) are thin over this.
 *
 * The recognizers themselves — building them, every decode — run in a
 * worker thread (decoder.ts over `ModelWorker`), so a decode never blocks
 * the event loop: a recognizer takes up to a second to build, and
 * `transcribe` decodes a whole file in one go.
 *
 * `sherpa-onnx-node` is an optionalDependency, imported lazily (in the
 * worker): a strut without the addon boots, and `available()` says so. Tests
 * inject a fake `engine`, which runs in process.
 *
 * Two-recognizer streams: when `partialModel` is set, a fast greedy model
 * produces the partials and the hotword-capable `model` produces finals and
 * owns endpoint detection (see §4.4 for why — sherpa's NeMo online
 * transducer is greedy-only, so speed and biasing come from different
 * families).
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DictationModels } from "./dictation-models.js";
import { DictationFixer } from "./fixer.js";
import { createInstaller, isInstalled, type DownloadProgress, type Installer } from "./download.js";
import { compileHotwords, parseHotwords, HotwordsStore, type Hotword } from "./hotwords.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PARTIAL_MODEL,
  STT_MODELS,
  modelDirFromEnv,
  pickModelFiles,
  requireModel,
  sttModelPath,
  type SttModel,
} from "./models.js";
import { SessionStore } from "./sessions.js";
import { bootEnv } from "../env.js";
import { ModelWorker, type ModelWorkerSpec } from "../model-worker.js";
import { createSttHost, DECODER_MODULE, type Built, type RecognizerSpec, type SttEngine, type SttHost } from "./decoder.js";

// The engine surface and the decode loop live in decoder.ts (they run in the
// recognizer's thread); re-exported here, where callers have always found them.
export {
  loadSherpaEngine,
  wordsOf,
  type EngineWaveform,
  type EngineResult,
  type EngineStream,
  type EngineRecognizer,
  type SttEngine,
} from "./decoder.js";

// ── Public types ───────────────────────────────────────────────────────────

export interface SttWord {
  text: string;
  /** Seconds from the start of the stream. */
  start: number;
}

export type SttEvent =
  | { type: "partial"; text: string }
  | { type: "final"; index: number; text: string; words: SttWord[] };

export interface EndpointRules {
  /** Trailing silence (s) that ends a segment even with no speech yet. */
  rule1?: number;
  /** Trailing silence (s) after speech that ends a segment. */
  rule2?: number;
  /** Utterance length (s) after which a segment is cut regardless. */
  rule3?: number;
}

export interface SttStreamOptions {
  /** Finals model (hotword-capable). Default `STRUT_STT_MODEL` / catalog default. */
  model?: string;
  /** Fast model for partials; `null` for single-recognizer mode. Default
   *  `STRUT_STT_PARTIAL_MODEL` / catalog default. */
  partialModel?: string | null;
  /** A stored list name, or phrases inline. */
  hotwords?: string | readonly string[] | readonly Hotword[];
  /** Global per-token boost for phrases without their own `:score`. */
  hotwordsScore?: number;
  sampleRate?: number;
  /** Log finals + accept corrections under this id (`SessionStore`). */
  session?: string;
  endpoint?: EndpointRules;
}

export interface SttStream {
  readonly model: string;
  readonly partialModel: string | null;
  readonly hotwords: string | null;
  /** Feed PCM16LE bytes at the stream's sample rate. Each call is a round
   *  trip to the recognizer's thread; calls made back to back are decoded in
   *  the order they were made. */
  push(pcm16le: Uint8Array): Promise<SttEvent[]>;
  /** Feed float32 samples (any rate; sherpa resamples). */
  pushSamples(samples: Float32Array, sampleRate: number): Promise<SttEvent[]>;
  /** Flush: pads silence so the last chunk decodes, emits the trailing final. */
  end(): Promise<SttEvent[]>;
  /** Resolves once every session-log write so far has landed — await it
   *  before telling a client it may correct the finals. */
  flush(): Promise<void>;
  close(): void;
}

export interface TranscribeResult {
  text: string;
  segments: { text: string; words: SttWord[] }[];
  model: string;
  hotwords: string | null;
  durationMs: number;
}

export type { DownloadProgress } from "./download.js";

export interface SttModelStatus extends SttModel {
  installed: boolean;
  /** Which entry env/default resolution picks. */
  default: "model" | "partialModel" | null;
}

export interface SttService {
  readonly modelDir: string;
  readonly hotwords: HotwordsStore;
  readonly sessions: SessionStore;
  /** The user's dictation model picks and their downloads (dictation/* steps). */
  readonly dictation: DictationModels;
  /** The picked fixer model, loaded on use (fixer.ts): the vocabulary's rewrite and learning. */
  readonly fixer: DictationFixer;
  /** Whether the sherpa addon loads in this process. */
  available(): Promise<boolean>;
  models(): Promise<SttModelStatus[]>;
  /** Download + verify + extract (idempotent, deduped). Resolves to the dir. */
  ensureModel(id: string, onProgress?: (p: DownloadProgress) => void): Promise<string>;
  openStream(opts?: SttStreamOptions): Promise<SttStream>;
  transcribe(wav: Uint8Array, opts?: Omit<SttStreamOptions, "sampleRate">): Promise<TranscribeResult>;
  /** Append a user's correction to a session's final. */
  correct(session: string, index: number, text: string): Promise<void>;
  /** Stop the recognizer thread (its streams with it); the next call starts another. */
  close(): Promise<void>;
}

export interface SttServiceOptions {
  /** Local data dir (sessions, hotword lists, temp WAVs). */
  dataDir: string;
  modelDir?: string;
  /** An engine to run IN PROCESS (tests): the recognizers are built and fed
   *  on this thread. Default: sherpa, in a worker thread. */
  engine?: () => Promise<SttEngine | null>;
  /** The module the worker loads its engine from, in place of
   *  `sherpa-onnx-node` (a test's fake). Ignored with `engine`. */
  engineModule?: string;
  fetchImpl?: typeof fetch;
  /** Downloads models (tests: a fake). Default: fetch + sha256 + extract (download.ts). */
  install?: Installer;
  /** What the fixer's worker loads (tests: a fake model). Default: node-llama-cpp (fixer-engine.ts). */
  fixerSpec?: (m: { id: string; path: string }) => ModelWorkerSpec;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

// ── Implementation ─────────────────────────────────────────────────────────

const DEFAULT_HOTWORDS_SCORE = 2;
const DEFAULT_ENDPOINT: Required<EndpointRules> = { rule1: 2.4, rule2: 1.0, rule3: 20 };

interface Loaded {
  model: SttModel;
  dir: string;
  files: ReturnType<typeof pickModelFiles>;
}

export function createStt(opts: SttServiceOptions): SttService {
  const env = opts.env ?? bootEnv();
  const modelDir = opts.modelDir ?? modelDirFromEnv(env);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(`[stt] ${m}`));
  const hotwords = new HotwordsStore(opts.dataDir);
  const sessions = new SessionStore(opts.dataDir);

  const host = opts.engine ? inProcess(opts.engine) : inWorker(opts.engineModule);
  const available = () => host.call<boolean>("available");
  const requireEngine = async (): Promise<void> => {
    if (!(await available())) throw new SttUnavailableError();
  };
  const logBuilt = (built: Built[]) => {
    for (const b of built) log(`recognizer ${b.label} ready in ${b.ms} ms`);
  };

  const install = opts.install ?? createInstaller({ fetchImpl, log });

  const defaultModelId = () => env["STRUT_STT_MODEL"] ?? DEFAULT_MODEL;
  const defaultPartialId = (): string | null => {
    const v = env["STRUT_STT_PARTIAL_MODEL"];
    if (v === "" || v === "none" || v === "off") return null;
    return v ?? DEFAULT_PARTIAL_MODEL;
  };

  const installed = (id: string) => isInstalled(sttModelPath(modelDir, id));

  async function ensureModel(id: string, onProgress?: (p: DownloadProgress) => void): Promise<string> {
    const model = requireModel(id);
    await requireEngine(); // no model downloads for a build without the addon
    const dir = sttModelPath(modelDir, id);
    if (!(await installed(id))) await install(model, dir, onProgress);
    return dir;
  }

  const dictation = new DictationModels({
    dataDir: opts.dataDir,
    modelDir,
    install,
    defaultSpeech: defaultModelId(),
    requireSpeechEngine: requireEngine,
    log,
  });
  const fixer = new DictationFixer({ model: () => dictation.fixerModel(), ...(opts.fixerSpec ? { spec: opts.fixerSpec } : {}) });

  async function load(id: string): Promise<Loaded> {
    const model = requireModel(id);
    const dir = await ensureModel(id);
    const files = pickModelFiles(await readdir(dir));
    return { model, dir, files };
  }

  async function resolveHotwords(
    spec: SttStreamOptions["hotwords"],
  ): Promise<{ name: string | null; list: Hotword[] }> {
    if (spec == null) return { name: null, list: [] };
    if (typeof spec === "string") {
      const text = await hotwords.get(spec);
      if (text == null) throw new Error(`unknown hotwords list "${spec}"`);
      return { name: spec, list: parseHotwords(text) };
    }
    const list = spec.map((h) => (typeof h === "string" ? { phrase: h } : h)).filter((h) => h.phrase.trim());
    return { name: list.length ? "inline" : null, list };
  }

  /** What the recognizer thread builds a recognizer from; it keeps one per `key`. */
  async function recognizerSpec(
    loaded: Loaded,
    list: readonly Hotword[],
    score: number,
    ep: Required<EndpointRules>,
  ): Promise<RecognizerSpec> {
    if (loaded.model.offline) return offlineSpec(loaded);
    const biased = list.length > 0 && loaded.model.hotwords;
    const compiled = biased ? await compileHotwords(loaded.dir, list) : null;
    const key = [loaded.model.id, compiled?.hash ?? "-", biased ? score : "-", ep.rule1, ep.rule2, ep.rule3].join("|");
    const { dir, files } = loaded;
    const modelConfig: Record<string, unknown> = {
      transducer: { encoder: join(dir, files.encoder), decoder: join(dir, files.decoder), joiner: join(dir, files.joiner) },
      tokens: join(dir, files.tokens),
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    };
    if (compiled) {
      // §4.2: without modelingUnit sherpa defaults to cjkchar and the list
      // silently does nothing.
      modelConfig["modelingUnit"] = "bpe";
      modelConfig["bpeVocab"] = compiled.vocab;
    }
    const config: Record<string, unknown> = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig,
      decodingMethod: compiled ? "modified_beam_search" : "greedy_search",
      maxActivePaths: 4,
      enableEndpoint: true,
      rule1MinTrailingSilence: ep.rule1,
      rule2MinTrailingSilence: ep.rule2,
      rule3MinUtteranceLength: ep.rule3,
    };
    if (compiled) {
      config["hotwordsFile"] = compiled.file;
      config["hotwordsScore"] = score;
    }
    return { key, label: `${loaded.model.id}${compiled ? ` +hotwords(${compiled.hash})` : ""}`, config };
  }

  /** An offline transducer (Parakeet): one pass over the whole clip, greedy. */
  function offlineSpec(loaded: Loaded): RecognizerSpec {
    const { dir, files } = loaded;
    return {
      key: `${loaded.model.id}|offline`,
      label: loaded.model.id,
      offline: true,
      config: {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: join(dir, files.encoder), decoder: join(dir, files.decoder), joiner: join(dir, files.joiner) },
          tokens: join(dir, files.tokens),
          modelType: "nemo_transducer",
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
        decodingMethod: "greedy_search",
      },
    };
  }

  /** The finals recognizer `o` asks for, and where its finals continue counting. */
  async function mainSpec(o: Omit<SttStreamOptions, "sampleRate">, modelId = o.model ?? defaultModelId()) {
    const ep = { ...DEFAULT_ENDPOINT, ...stripUndefined(o.endpoint ?? {}) };
    const { name: hotwordsName, list } = await resolveHotwords(o.hotwords);
    const score = o.hotwordsScore ?? DEFAULT_HOTWORDS_SCORE;
    const loaded = await load(modelId);
    const spec = await recognizerSpec(loaded, list, score, ep);
    // Final indexes continue across connections that share a session, so a
    // correction's `index` is unambiguous within the session file.
    const firstIndex = o.session ? await sessions.nextIndex(o.session) : 0;
    return { loaded, spec, hotwordsName, score, ep, firstIndex };
  }

  async function openStream(o: SttStreamOptions = {}): Promise<SttStream> {
    // Before load(): without the addon a dictation start must not download a model first.
    await requireEngine();
    const modelId = o.model ?? defaultModelId();
    if (requireModel(modelId).offline) throw new Error(`stt model "${modelId}" is offline: it transcribes whole clips (/audio/transcribe), not streams`);
    const partialId = o.partialModel === undefined ? defaultPartialId() : o.partialModel;
    const { loaded, spec, hotwordsName, score, ep, firstIndex } = await mainSpec(o);
    const partial = partialId && partialId !== modelId ? await recognizerSpec(await load(partialId), [], score, ep) : null;
    const id = randomUUID();
    const sampleRate = o.sampleRate ?? 16000;
    const { built } = await host.call<{ built: Built[] }>("open", [
      id,
      { main: spec, partial, sampleRate, tailPadMs: loaded.model.tailPadMs, firstIndex },
    ]);
    logBuilt(built);
    return new Stream({
      id,
      host,
      model: loaded.model.id,
      partialModel: partial ? partialId : null,
      hotwords: hotwordsName,
      sampleRate,
      session: o.session ?? null,
      sessions,
    });
  }

  async function transcribe(wav: Uint8Array, o: Omit<SttStreamOptions, "sampleRate"> = {}): Promise<TranscribeResult> {
    await requireEngine();
    // Batch runs single-recognizer: partials are irrelevant here. The model:
    // the caller's, else the user's dictation pick once installed, else the default.
    const modelId = o.model ?? (await dictation.speechModel()) ?? defaultModelId();
    const { loaded, spec, hotwordsName, firstIndex } = await mainSpec(o, modelId);
    const tmp = join(opts.dataDir, "audio", "tmp");
    await mkdir(tmp, { recursive: true });
    const path = join(tmp, `${randomUUID()}.wav`);
    await writeFile(path, wav);
    let r: { finals: SttEvent[]; built: Built[]; ms: number };
    try {
      // The whole pass — read, decode, flush — in the recognizer's thread.
      r = await host.call("transcribe", [path, { main: spec, tailPadMs: loaded.model.tailPadMs, firstIndex }]);
    } finally {
      await rm(path, { force: true });
    }
    logBuilt(r.built);
    if (o.session) await logFinals(sessions, o.session, loaded.model.id, hotwordsName, r.finals);
    const segments = r.finals.flatMap((ev) => (ev.type === "final" ? [{ text: ev.text, words: ev.words }] : []));
    return {
      text: segments.map((s) => s.text).join(" "),
      segments,
      model: loaded.model.id,
      hotwords: hotwordsName,
      durationMs: r.ms,
    };
  }

  return {
    modelDir,
    hotwords,
    sessions,
    dictation,
    fixer,
    available,
    async models() {
      const d = defaultModelId();
      const pd = defaultPartialId();
      return Promise.all(
        STT_MODELS.map(async (m) => ({
          ...m,
          installed: await installed(m.id),
          default: m.id === d ? ("model" as const) : m.id === pd ? ("partialModel" as const) : null,
        })),
      );
    },
    ensureModel,
    openStream,
    transcribe,
    correct: (session, index, text) => sessions.append(session, { type: "correction", t: new Date().toISOString(), index, text }),
    close: async () => {
      await Promise.all([host.close(), fixer.close()]);
    },
  };
}

// ── Where the recognizers run ──────────────────────────────────────────────

/** The recognizer host (decoder.ts) as calls: in a worker thread, or in process. */
interface Host {
  call<T>(method: keyof SttHost, args?: unknown[], transfer?: Transferable[]): Promise<T>;
  close(): Promise<void>;
}

/** sherpa in a worker thread: a decode never blocks the event loop serving requests. */
function inWorker(engineModule?: string): Host {
  const worker = new ModelWorker(
    { module: DECODER_MODULE, factory: "loadSttHost", options: engineModule ? { engineModule } : {} },
    "stt worker",
  );
  return { call: (method, args, transfer) => worker.call(method, args, transfer), close: () => worker.close() };
}

/** An injected engine, on this thread (tests). */
function inProcess(load: () => Promise<SttEngine | null>): Host {
  let host: Promise<SttHost> | undefined;
  return {
    async call<T>(method: keyof SttHost, args: unknown[] = []): Promise<T> {
      const h = await (host ??= load().then(createSttHost));
      return (h[method] as (...a: unknown[]) => T)(...args);
    },
    close: async () => {
      host = undefined;
    },
  };
}

export class SttUnavailableError extends Error {
  constructor() {
    super("stt not available: sherpa-onnx-node is not installed (unsupported platform, or a build without dictation)");
    this.name = "SttUnavailableError";
  }
}

// ── The streaming session ──────────────────────────────────────────────────

interface StreamDeps {
  id: string;
  host: Host;
  model: string;
  partialModel: string | null;
  hotwords: string | null;
  sampleRate: number;
  session: string | null;
  sessions: SessionStore;
}

/** A dictation stream on this thread: the decoding is the recognizer
 *  thread's (decoder.ts); the session log is written here. */
class Stream implements SttStream {
  readonly model: string;
  readonly partialModel: string | null;
  readonly hotwords: string | null;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly d: StreamDeps) {
    this.model = d.model;
    this.partialModel = d.partialModel;
    this.hotwords = d.hotwords;
  }

  push(pcm16le: Uint8Array): Promise<SttEvent[]> {
    // A fresh buffer, so it moves to the recognizer's thread instead of being copied.
    const samples = pcm16ToFloat32(pcm16le);
    return this.send("push", [this.d.id, samples, this.d.sampleRate], [samples.buffer]);
  }

  pushSamples(samples: Float32Array, sampleRate: number): Promise<SttEvent[]> {
    return this.send("push", [this.d.id, samples, sampleRate]);
  }

  async end(): Promise<SttEvent[]> {
    if (this.closed) return [];
    this.closed = true;
    return this.logged(await this.d.host.call<SttEvent[]>("end", [this.d.id]));
  }

  flush(): Promise<void> {
    return this.writes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.d.host.call("close", [this.d.id]).catch(() => {});
  }

  private async send(method: "push", args: unknown[], transfer?: Transferable[]): Promise<SttEvent[]> {
    if (this.closed) throw new Error("stream is closed");
    return this.logged(await this.d.host.call<SttEvent[]>(method, args, transfer));
  }

  private logged(events: SttEvent[]): SttEvent[] {
    const session = this.d.session;
    if (session && events.some((ev) => ev.type === "final")) {
      this.writes = this.writes
        .then(() => logFinals(this.d.sessions, session, this.model, this.hotwords, events))
        .catch((e) => console.warn(`[stt] session log failed:`, e));
    }
    return events;
  }
}

/** Append a stream's finals to its session log. */
async function logFinals(sessions: SessionStore, session: string, model: string, hotwords: string | null, events: SttEvent[]): Promise<void> {
  for (const ev of events) {
    if (ev.type !== "final") continue;
    await sessions.append(session, { type: "final", t: new Date().toISOString(), index: ev.index, text: ev.text, words: ev.words, model, hotwords });
  }
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const n = bytes.byteLength >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
