/**
 * Text-to-speech over sherpa-onnx (plans/private-voice.md §3.3): Kokoro on
 * CPU, the speaking half of a voice conversation beside stt.ts's listening
 * half.
 *
 * Owns the models on disk (the catalog's `TTS_MODELS`, downloaded and
 * verified by download.ts like the STT models) and `speak`: text in, mono
 * 16-bit PCM out a sentence at a time, each piece as soon as Kokoro has it.
 * The route (`POST /audio/speak`, routes.ts) is thin over this.
 *
 * The model runs in a worker thread of its own (synthesizer.ts over
 * `ModelWorker`), one generation at a time. As in stt.ts, `sherpa-onnx-node`
 * is an optionalDependency imported in the worker, a model missing on disk
 * is downloaded on first use, and tests inject a fake `engine` that runs in
 * process.
 */
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInstaller, isInstalled, type DownloadProgress, type Installer } from "./download.js";
import { DEFAULT_TTS_MODEL, TTS_MODELS, findTtsModel, modelDirFromEnv, ttsModelPath, type TtsModel } from "./models.js";
import { createTtsHost, SYNTHESIZER_MODULE, type SpeakRequest, type TtsEngine, type TtsHost, type VoiceModelSpec } from "./synthesizer.js";
import type { Built } from "./decoder.js";
import { bootEnv } from "../env.js";
import { ModelWorker } from "../model-worker.js";

export { float32ToPcm16, type EngineTts, type TtsEngine } from "./synthesizer.js";

// ── Public types ───────────────────────────────────────────────────────────

export interface SpeakOptions {
  /** A `TTS_MODELS` id; default `DEFAULT_TTS_MODEL`. */
  model?: string;
  /** A name from the model's voice table; default its `defaultVoice`. */
  voice?: string;
  /** 1 is the voice's own pace; 0.5–2. */
  speed?: number;
  /** Aborting stops the speech: no more pieces, and the generation within
   *  a sentence or two (synthesizer.ts says why). */
  signal?: AbortSignal;
}

export interface Speech {
  model: string;
  voice: string;
  sampleRate: number;
  /** Mono 16-bit little-endian PCM at `sampleRate`, a piece per sentence as
   *  it is generated. Leaving the loop early stops the speech. */
  audio: AsyncIterable<Uint8Array>;
}

export interface TtsModelStatus extends TtsModel {
  installed: boolean;
  default: boolean;
}

export interface TtsService {
  readonly modelDir: string;
  /** Whether the sherpa addon loads in this process. */
  available(): Promise<boolean>;
  models(): Promise<TtsModelStatus[]>;
  /** Download + verify + extract (idempotent, deduped). Resolves to the dir. */
  ensureModel(id: string, onProgress?: (p: DownloadProgress) => void): Promise<string>;
  /** Resolves once the model is loaded and the speech queued: a bad
   *  request (`SpeakRequestError`) or a missing addon fails here, before any audio. */
  speak(text: string, opts?: SpeakOptions): Promise<Speech>;
  /** Stop the speech thread; the next call starts another. */
  close(): Promise<void>;
}

export interface TtsServiceOptions {
  modelDir?: string;
  /** An engine to run IN PROCESS (tests). Default: sherpa, in a worker thread. */
  engine?: () => Promise<TtsEngine | null>;
  /** The module the worker loads its engine from, in place of
   *  `sherpa-onnx-node` (a test's fake). Ignored with `engine`. */
  engineModule?: string;
  fetchImpl?: typeof fetch;
  /** Downloads models (tests: a fake). Default: fetch + sha256 + extract (download.ts). */
  install?: Installer;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

/** What one `speak` may say: a spoken reply is a few sentences, never a book. */
export const MAX_SPEAK_CHARS = 10_000;

/** Kokoro's intra-op threads: four nearly halve a sentence's time against two
 *  (0.44 s against 0.79 s for a 1.75 s sentence, 4 cores); more gain little. */
const THREADS = Math.min(4, availableParallelism());

// ── Implementation ─────────────────────────────────────────────────────────

export function createTts(opts: TtsServiceOptions = {}): TtsService {
  const env = opts.env ?? bootEnv();
  const modelDir = opts.modelDir ?? modelDirFromEnv(env);
  const log = opts.log ?? ((m: string) => console.log(`[tts] ${m}`));
  const install = opts.install ?? createInstaller({ fetchImpl: opts.fetchImpl ?? fetch, log });
  const host = opts.engine ? inProcess(opts.engine) : inWorker(opts.engineModule);

  const available = () => host.call<boolean>("available");
  const installed = (id: string) => isInstalled(ttsModelPath(modelDir, id));

  async function ensureModel(id: string, onProgress?: (p: DownloadProgress) => void): Promise<string> {
    const model = requireTtsModel(id);
    if (!(await available())) throw new TtsUnavailableError(); // no download for a build without the addon
    const dir = ttsModelPath(modelDir, id);
    if (!(await installed(id))) await install(model, dir, onProgress);
    return dir;
  }

  /** What the speech thread builds the model from; it keeps one per `key`. */
  function modelSpec(model: TtsModel, dir: string): VoiceModelSpec {
    return {
      key: model.id,
      label: model.id,
      config: {
        model: {
          // With `lang` set, Kokoro reads English through espeak-ng and needs
          // no lexicon (sherpa exits the process when both are missing).
          kokoro: {
            model: join(dir, model.file),
            voices: join(dir, "voices.bin"),
            tokens: join(dir, "tokens.txt"),
            dataDir: join(dir, "espeak-ng-data"),
            lang: model.lang,
          },
          numThreads: THREADS,
          provider: "cpu",
          debug: 0,
        },
        // One sentence per batch, so each reaches the caller as it is done.
        maxNumSentences: 1,
      },
    };
  }

  async function speak(text: string, o: SpeakOptions = {}): Promise<Speech> {
    const { model, voice, req } = resolve(text, o);
    const dir = await ensureModel(model.id);
    const id = randomUUID();
    const { sampleRate, built } = await host.call<{ sampleRate: number; built: Built[] }>("start", [id, modelSpec(model, dir), req]);
    for (const b of built) log(`model ${b.label} ready in ${b.ms} ms`);
    return { model: model.id, voice, sampleRate, audio: pieces(host, id, o.signal) };
  }

  return {
    modelDir,
    available,
    async models() {
      return Promise.all(TTS_MODELS.map(async (m) => ({ ...m, installed: await installed(m.id), default: m.id === DEFAULT_TTS_MODEL })));
    },
    ensureModel,
    speak,
    close: () => host.close(),
  };
}

/** The request as the speech thread takes it, or what is wrong with it. */
function resolve(text: string, o: SpeakOptions): { model: TtsModel; voice: string; req: SpeakRequest } {
  if (!text.trim()) throw new SpeakRequestError("nothing to say: text is empty");
  if (text.length > MAX_SPEAK_CHARS) throw new SpeakRequestError(`text is ${text.length} characters; at most ${MAX_SPEAK_CHARS}`);
  const model = requireTtsModel(o.model ?? DEFAULT_TTS_MODEL);
  const voice = o.voice ?? model.defaultVoice;
  const sid = model.voices.indexOf(voice);
  if (sid < 0) throw new SpeakRequestError(`unknown voice ${JSON.stringify(voice)} for ${model.id} (known: ${model.voices.join(", ")})`);
  const speed = o.speed ?? 1;
  if (!(speed >= 0.5 && speed <= 2)) throw new SpeakRequestError(`speed must be between 0.5 and 2, got ${speed}`);
  return { model, voice, req: { text, sid, speed } };
}

function requireTtsModel(id: string): TtsModel {
  const model = findTtsModel(id);
  if (!model) throw new SpeakRequestError(`unknown tts model ${JSON.stringify(id)} (known: ${TTS_MODELS.map((m) => m.id).join(", ")})`);
  return model;
}

/** A speech's pieces, pulled from the speech thread one call each. The
 *  signal stops it from now on, read or not. */
function pieces(host: Host, id: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  let open = true;
  const stop = () => {
    if (!open) return;
    open = false;
    host.call("cancel", [id]).catch(() => {});
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  async function* read(): AsyncGenerator<Uint8Array> {
    try {
      while (open) {
        const piece = await host.call<Uint8Array | null>("next", [id]);
        if (!piece) {
          open = false; // done, or stopped: the speech thread let it go
          return;
        }
        yield piece;
      }
    } catch (e) {
      open = false;
      throw e;
    } finally {
      signal?.removeEventListener("abort", stop);
      stop();
    }
  }
  return read();
}

// ── Where the model runs ───────────────────────────────────────────────────

/** The speech host (synthesizer.ts) as calls: in a worker thread, or in process. */
interface Host {
  call<T>(method: keyof TtsHost, args?: unknown[]): Promise<T>;
  close(): Promise<void>;
}

/** sherpa in a worker thread of its own: a sentence never blocks the event loop. */
function inWorker(engineModule?: string): Host {
  const worker = new ModelWorker(
    { module: SYNTHESIZER_MODULE, factory: "loadTtsHost", options: engineModule ? { engineModule } : {} },
    "tts worker",
  );
  return { call: (method, args) => worker.call(method, args), close: () => worker.close() };
}

/** An injected engine, on this thread (tests). */
function inProcess(load: () => Promise<TtsEngine | null>): Host {
  let host: Promise<TtsHost> | undefined;
  return {
    async call<T>(method: keyof TtsHost, args: unknown[] = []): Promise<T> {
      const h = await (host ??= load().then(createTtsHost));
      return (h[method] as (...a: unknown[]) => T)(...args);
    },
    close: async () => {
      host = undefined;
    },
  };
}

export class TtsUnavailableError extends Error {
  constructor() {
    super("tts not available: sherpa-onnx-node is not installed (unsupported platform, or a build without speech)");
    this.name = "TtsUnavailableError";
  }
}

/** What is wrong with a `speak` request: an empty or long text, an unknown model or voice, a speed out of range. */
export class SpeakRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeakRequestError";
  }
}
