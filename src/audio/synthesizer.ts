/**
 * The half of text-to-speech that runs sherpa (plans/private-voice.md §3.3):
 * Kokoro's OfflineTts and the speech it generates. createTts runs it in a
 * worker thread of its own (`ModelWorker`, src/model-worker.ts), so a
 * generation never blocks the event loop and never queues behind a
 * dictation decode in the recognizer's thread. An injected engine (tests)
 * runs it in process.
 *
 * sherpa streams a generation a sentence at a time: `generateAsync` runs on
 * libuv's pool and calls `onProgress` here with each sentence's samples as
 * it is done (Kokoro takes one sentence per batch, split where espeak-ng
 * ends one). A call that returns 0 stops it, but sherpa reads the answer
 * only when its next sentence ends, having started that one without waiting
 * for it: a stop between two calls still costs the sentence in flight and
 * the one after it. The main thread pulls the pieces with `next`, one call
 * each, as 16-bit PCM.
 */
import { loadSherpaEngine, type Built } from "./decoder.js";

// ── Engine surface (what we use of sherpa-onnx-node; fakeable) ────────────

export interface EngineAudio {
  samples: Float32Array;
  sampleRate: number;
}
export interface EngineTtsRequest {
  text: string;
  sid: number;
  speed: number;
  /** Each sentence's samples as it is generated; return 0 to stop (heard when the next one ends). */
  onProgress?: (info: { samples: Float32Array; progress: number }) => number;
}
export interface EngineTts {
  readonly sampleRate: number;
  generateAsync(req: EngineTtsRequest): Promise<EngineAudio>;
}
export interface TtsEngine {
  OfflineTts: new (config: Record<string, unknown>) => EngineTts;
}

// ── What the main thread sends ─────────────────────────────────────────────

/** One model: built once per `key` and kept for the worker's life. */
export interface VoiceModelSpec {
  key: string;
  /** For the main thread's "ready in N ms" line. */
  label: string;
  config: Record<string, unknown>;
}

export interface SpeakRequest {
  text: string;
  /** Speaker id in the model's voice table. */
  sid: number;
  speed: number;
}

/** This module's URL: what the worker imports `loadTtsHost` from. */
export const SYNTHESIZER_MODULE = import.meta.url;

export type TtsHost = ReturnType<typeof createTtsHost>;

/** The worker's factory: the host over sherpa, or over `engineModule` (a test's fake). */
export async function loadTtsHost(o: { engineModule?: string } = {}): Promise<TtsHost> {
  return createTtsHost(await loadSherpaEngine<TtsEngine>(o.engineModule));
}

export function createTtsHost(engine: TtsEngine | null) {
  const models = new Map<string, EngineTts>();
  const generations = new Map<string, Generation>();
  // One generation at a time: two would split the cores and both come late.
  let turn: Promise<void> = Promise.resolve();

  const model = (spec: VoiceModelSpec, built: Built[]): EngineTts => {
    let m = models.get(spec.key);
    if (!m) {
      if (!engine) throw new Error("tts not available: sherpa-onnx-node is not installed");
      const t0 = Date.now();
      m = new engine.OfflineTts(spec.config);
      built.push({ label: spec.label, ms: Date.now() - t0 });
      models.set(spec.key, m);
    }
    return m;
  };

  return {
    available: (): boolean => engine != null,

    /** Build `spec`'s model if it is new and queue `req`; its pieces come from `next`. */
    start(id: string, spec: VoiceModelSpec, req: SpeakRequest): { sampleRate: number; built: Built[] } {
      const built: Built[] = [];
      const tts = model(spec, built);
      const generation = new Generation();
      generations.set(id, generation);
      turn = turn.then(() => generation.run(tts, req));
      return { sampleRate: tts.sampleRate, built };
    },

    /** The next sentence as 16-bit PCM; null once the speech is done or stopped. */
    async next(id: string): Promise<Uint8Array | null> {
      const generation = generations.get(id);
      if (!generation) throw new Error("speech is gone: it ended, or the speech thread restarted");
      try {
        const piece = await generation.next();
        if (!piece) generations.delete(id);
        return piece;
      } catch (e) {
        generations.delete(id);
        throw e;
      }
    },

    /** Stop: no more pieces, and sherpa stops at the next sentence it ends. */
    cancel(id: string): void {
      generations.get(id)?.stop();
      generations.delete(id);
    },
  };
}

// ── One generation ─────────────────────────────────────────────────────────

class Generation {
  private readonly pieces: Uint8Array[] = [];
  private done = false;
  private stopped = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  async run(tts: EngineTts, req: SpeakRequest): Promise<void> {
    if (this.stopped) return; // stopped while it waited its turn
    try {
      await tts.generateAsync({
        ...req,
        onProgress: ({ samples }) => {
          if (this.stopped) return 0;
          this.pieces.push(float32ToPcm16(samples));
          this.notify();
          return 1;
        },
      });
    } catch (e) {
      this.error = e instanceof Error ? e : new Error(String(e));
    }
    this.done = true;
    this.notify();
  }

  async next(): Promise<Uint8Array | null> {
    while (!this.pieces.length && !this.done && !this.stopped) await new Promise<void>((r) => (this.wake = r));
    if (this.stopped) return null;
    const piece = this.pieces.shift();
    if (piece) return piece;
    if (this.error) throw this.error;
    return null;
  }

  stop(): void {
    this.stopped = true;
    this.pieces.length = 0;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/** Float samples in [-1, 1] → 16-bit little-endian PCM (stt.ts's `pcm16ToFloat32` reversed). */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768))), true);
  return out;
}
