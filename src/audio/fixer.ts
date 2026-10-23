/**
 * The dictation fixer (plans/dictation-models.md): the user's picked fixer
 * model (models.ts FIXER_MODELS, a Qwen3 GGUF) on node-llama-cpp with Metal,
 * in a worker thread of its own (`ModelWorker`). It only scores, for the
 * pipeline in lingo.ts:
 *
 * - `judge(questions)`: for each change of an edit, log P(yes) − log P(no)
 *   that it is a mishearing, from one forward pass after a few-shot prompt.
 * - `score(sentences)`: the log-likelihood of each sentence after "Dictated
 *   by someone who often mentions X (a <type>)".
 * - `retract(text)`: the words a speaker took back and the cue that took
 *   them back, as `{ wrong, cue }`; code finds and removes the span.
 *
 * The prompts and the model are fixer-engine.ts, in the worker. The model
 * loads on first use and unloads after five minutes idle; picking another
 * fixer swaps it on the next use.
 */
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelWorker, type ModelWorkerSpec } from "../model-worker.js";
import type { FixerEngine } from "./fixer-engine.js";
import type { Fixer } from "./lingo.js";
import { findFixer } from "./models.js";

// Beside this file in `src/` (tsx) and in `build/` alike.
const ENGINE = new URL(`./fixer-engine${extname(fileURLToPath(import.meta.url))}`, import.meta.url).href;

// ── On the main thread: the picked fixer, loaded on use ────────────────────

/** A fixer to use now; `ready()` resolves once its model is loaded. */
export interface LoadedFixer extends Fixer {
  ready(): Promise<void>;
}

export interface DictationFixerOptions {
  /** The installed pick, read on each use (`DictationModels.fixerModel`). */
  model: () => Promise<{ id: string; path: string } | null>;
  /** Unload after this long without a call. Default five minutes. */
  idleMs?: number;
  /** What the worker builds for a model (tests: a fake). Default: fixer-engine.ts's `loadLlamaFixer`. */
  spec?: (m: { id: string; path: string }) => ModelWorkerSpec;
}

const IDLE_MS = 5 * 60_000;

export class DictationFixer {
  private loaded: { id: string; path: string; worker: ModelWorker; busy: number; started?: boolean; timer?: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly o: DictationFixerOptions) {}

  /** The picked fixer when it is installed, else null. Its model loads on its first call. */
  async current(): Promise<LoadedFixer | null> {
    const m = await this.o.model();
    if (!m) {
      await this.unload();
      return null;
    }
    if (this.loaded?.path !== m.path) {
      // Swapped with no await between the check and the new one: two calls
      // racing here share one worker, and none is left running unowned.
      const old = this.loaded;
      const spec = this.o.spec?.(m) ?? { module: ENGINE, factory: "loadLlamaFixer", options: { path: m.path } };
      this.loaded = { ...m, worker: new ModelWorker(spec, `dictation fixer (${m.id})`), busy: 0 };
      await this.free(old);
    }
    const l = this.loaded!;
    const call = async <T>(method: keyof FixerEngine, args: unknown[]): Promise<T> => {
      // A handle outlives its model (swapped, idle, closed): calling it would
      // start a worker nobody unloads.
      if (this.loaded !== l) throw new Error(`dictation fixer ${l.id} was unloaded`);
      l.busy++;
      l.started = true;
      clearTimeout(l.timer);
      try {
        return await l.worker.call<T>(method, args);
      } finally {
        if (--l.busy === 0 && this.loaded === l) {
          l.timer = setTimeout(() => void this.unload(l), this.o.idleMs ?? IDLE_MS);
          l.timer.unref();
        }
      }
    };
    return {
      id: m.id,
      learnMargin: findFixer(m.id)?.learnMargin ?? 0,
      judge: (qs) => call("judge", [qs]),
      score: (ss) => call("score", [ss]),
      retract: (text) => call("retract", [text]),
      ready: () => call("ready", []),
    };
  }

  /** Whether a model is loaded or loading now (tests, status). */
  get active(): string | null {
    return this.loaded?.id ?? null;
  }

  async close(): Promise<void> {
    await this.unload();
  }

  /** Free the model (or only `which`, if it is still the one loaded). */
  private async unload(which = this.loaded): Promise<void> {
    if (!which || which !== this.loaded) return;
    this.loaded = null;
    await this.free(which);
  }

  private async free(which: typeof this.loaded): Promise<void> {
    if (!which) return;
    clearTimeout(which.timer);
    // A worker never called has no model to free, and no thread.
    if (!which.started) return;
    await which.worker.call("dispose").catch(() => {});
    await which.worker.close();
  }
}

/** How long a transcript waits for the fixer before it goes out with the learned mishearings only. */
export const FIX_TIMEOUT_MS = 1500;

/** `p`'s value, or undefined when it takes longer than `ms` (it keeps running). */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A late failure is nobody's to handle.
  p.catch(() => {});
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}
