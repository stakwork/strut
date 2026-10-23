/**
 * The half of dictation that runs sherpa (plans/local-desktop-and-stt.md §4):
 * the recognizers, their streams, and the decode loop that turns audio into
 * partials and finals. createStt runs it in a worker thread (`ModelWorker`,
 * src/model-worker.ts): a decode is synchronous native work, and a
 * recognizer's streams live on the thread that built it, so building a
 * recognizer, every stream and `transcribe`'s whole pass over a WAV happen
 * there, and the main thread only posts audio and receives events. An
 * injected engine (tests) runs it in process.
 *
 * Everything else stays in stt.ts on the main thread: model downloads,
 * hotword lists (compiled to the files a recognizer's config names), and the
 * session log.
 */
import type { SttEvent, SttWord } from "./stt.js";

// ── Engine surface (what we use of sherpa-onnx-node; fakeable) ────────────

export interface EngineWaveform {
  samples: Float32Array;
  sampleRate: number;
}
export interface EngineResult {
  text: string;
  tokens?: string[];
  timestamps?: number[];
  start_time?: number;
}
export interface EngineStream {
  acceptWaveform(w: EngineWaveform): void;
  inputFinished(): void;
}
export interface EngineRecognizer {
  createStream(): EngineStream;
  isReady(s: EngineStream): boolean;
  decode(s: EngineStream): void;
  isEndpoint(s: EngineStream): boolean;
  reset(s: EngineStream): void;
  getResult(s: EngineStream): EngineResult;
}
export interface SttEngine {
  OnlineRecognizer: new (config: Record<string, unknown>) => EngineRecognizer;
  readWave(path: string): EngineWaveform;
}

/** Lazy sherpa import (or another module shaped like it); null when the
 *  optional addon isn't installed. */
export async function loadSherpaEngine(module = "sherpa-onnx-node"): Promise<SttEngine | null> {
  try {
    const mod = (await import(module)) as { default?: SttEngine } & SttEngine;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

// ── What the main thread sends ─────────────────────────────────────────────

/** One recognizer: built once per `key` and kept for the worker's life. */
export interface RecognizerSpec {
  /** (model, hotwords hash, score, endpoint rules) — streams that agree share it. */
  key: string;
  /** For the main thread's "ready in N ms" line. */
  label: string;
  config: Record<string, unknown>;
}

export interface DecoderSpec {
  main: RecognizerSpec;
  /** The fast model's recognizer for partials; null for single-recognizer mode. */
  partial: RecognizerSpec | null;
  sampleRate: number;
  /** Silence padded on `end` so the last chunk decodes (the model's `tailPadMs`). */
  tailPadMs: number;
  /** Final indexes continue across connections that share a session. */
  firstIndex: number;
}

/** A recognizer this call had to build. */
export interface Built {
  label: string;
  ms: number;
}

/** This module's URL: what the worker imports `loadSttHost` from. */
export const DECODER_MODULE = import.meta.url;

const FRAME_SECONDS = 0.1;

export type SttHost = ReturnType<typeof createSttHost>;

/** The worker's factory: the host over sherpa, or over `engineModule` (a test's fake). */
export async function loadSttHost(o: { engineModule?: string } = {}): Promise<SttHost> {
  return createSttHost(await loadSherpaEngine(o.engineModule));
}

export function createSttHost(engine: SttEngine | null) {
  const recognizers = new Map<string, EngineRecognizer>();
  const decoders = new Map<string, Decoder>();

  const requireEngine = (): SttEngine => {
    if (!engine) throw new Error("stt not available: sherpa-onnx-node is not installed");
    return engine;
  };
  const recognizer = (spec: RecognizerSpec, built: Built[]): EngineRecognizer => {
    let r = recognizers.get(spec.key);
    if (!r) {
      const t0 = Date.now();
      r = new (requireEngine().OnlineRecognizer)(spec.config);
      built.push({ label: spec.label, ms: Date.now() - t0 });
      recognizers.set(spec.key, r);
    }
    return r;
  };
  const decoder = (id: string): Decoder => {
    const d = decoders.get(id);
    if (!d) throw new Error("stream is gone: it ended, or the recognizer thread restarted");
    return d;
  };

  return {
    available: (): boolean => engine != null,

    open(id: string, spec: DecoderSpec): { built: Built[] } {
      const built: Built[] = [];
      const main = recognizer(spec.main, built);
      const partial = spec.partial ? recognizer(spec.partial, built) : null;
      decoders.set(id, new Decoder(spec, main, partial));
      return { built };
    },

    push(id: string, samples: Float32Array, sampleRate: number): SttEvent[] {
      return decoder(id).push(samples, sampleRate);
    },

    end(id: string): SttEvent[] {
      const d = decoder(id);
      decoders.delete(id);
      return d.end();
    },

    close(id: string): void {
      decoders.delete(id);
    },

    /** Read a WAV and decode it whole, single-recognizer; only the finals. */
    transcribe(path: string, spec: Omit<DecoderSpec, "partial" | "sampleRate">): { finals: SttEvent[]; built: Built[]; ms: number } {
      const wave = requireEngine().readWave(path);
      const built: Built[] = [];
      const d = new Decoder({ ...spec, partial: null, sampleRate: wave.sampleRate }, recognizer(spec.main, built), null);
      const t0 = Date.now();
      const events: SttEvent[] = [];
      const frame = Math.max(1, Math.round(FRAME_SECONDS * wave.sampleRate));
      for (let i = 0; i < wave.samples.length; i += frame) events.push(...d.push(wave.samples.subarray(i, i + frame), wave.sampleRate));
      events.push(...d.end());
      return { finals: events.filter((ev) => ev.type === "final"), built, ms: Date.now() - t0 };
    },
  };
}

// ── One stream ─────────────────────────────────────────────────────────────

class Decoder {
  private readonly main: EngineStream;
  private readonly partial: EngineStream | null;
  private lastPartial = "";
  private index: number;
  /** Rate of the last audio fed — sherpa aborts the process if a stream's
   *  rate changes, so the flush pad must match it. */
  private rate: number;
  private fed = false;

  constructor(
    private readonly spec: DecoderSpec,
    private readonly mainRec: EngineRecognizer,
    private readonly partialRec: EngineRecognizer | null,
  ) {
    this.main = mainRec.createStream();
    this.partial = partialRec ? partialRec.createStream() : null;
    this.index = spec.firstIndex;
    this.rate = spec.sampleRate;
  }

  push(samples: Float32Array, sampleRate: number): SttEvent[] {
    this.feed(samples, sampleRate);
    const events: SttEvent[] = [];
    const text = this.currentPartialText();
    if (text !== this.lastPartial) {
      this.lastPartial = text;
      events.push({ type: "partial", text });
    }
    if (this.mainRec.isEndpoint(this.main)) {
      const fin = this.takeFinal();
      if (fin) events.push(fin);
      this.resetAll();
    }
    return events;
  }

  end(): SttEvent[] {
    const pad = Math.round((this.spec.tailPadMs / 1000) * this.rate);
    this.feed(new Float32Array(pad), this.rate);
    this.main.inputFinished();
    while (this.mainRec.isReady(this.main)) this.mainRec.decode(this.main);
    const fin = this.takeFinal();
    return fin ? [fin] : [];
  }

  private feed(samples: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.rate) {
      if (this.rate !== this.spec.sampleRate || samples.length) {
        // Changing rate mid-stream is fatal in sherpa (it exits the process).
        if (this.fed) throw new Error(`sample rate changed mid-stream (${this.rate} → ${sampleRate})`);
      }
      this.rate = sampleRate;
    }
    this.fed = true;
    const w = { samples, sampleRate };
    this.main.acceptWaveform(w);
    while (this.mainRec.isReady(this.main)) this.mainRec.decode(this.main);
    if (this.partial && this.partialRec) {
      this.partial.acceptWaveform(w);
      while (this.partialRec.isReady(this.partial)) this.partialRec.decode(this.partial);
    }
  }

  private currentPartialText(): string {
    const r = this.partial && this.partialRec ? this.partialRec.getResult(this.partial) : this.mainRec.getResult(this.main);
    return r.text.trim();
  }

  private takeFinal(): SttEvent | null {
    const r = this.mainRec.getResult(this.main);
    const text = r.text.trim();
    if (!text) return null;
    return { type: "final", index: this.index++, text, words: wordsOf(r) };
  }

  private resetAll(): void {
    this.mainRec.reset(this.main);
    if (this.partial && this.partialRec) this.partialRec.reset(this.partial);
    this.lastPartial = "";
  }
}

/** Group sherpa's subword tokens into words. A token starting with `▁` (or
 *  a space, as the JSON renders it) begins a word. */
export function wordsOf(r: EngineResult): SttWord[] {
  const tokens = r.tokens ?? [];
  const ts = r.timestamps ?? [];
  const base = r.start_time ?? 0;
  const words: SttWord[] = [];
  tokens.forEach((tok, i) => {
    const starts = tok.startsWith("▁") || tok.startsWith(" ");
    const piece = starts ? tok.slice(1) : tok;
    const last = words[words.length - 1];
    if (starts || !last) words.push({ text: piece, start: round(base + (ts[i] ?? 0)) });
    else last.text += piece;
  });
  return words.filter((w) => w.text.length > 0);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
