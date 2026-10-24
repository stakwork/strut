/**
 * Spike (plans/dictation-audio-check.md): does a correction fit the recording?
 * Scores text against a WAV with NeMo models run directly on onnxruntime-node:
 *
 *   tdt     Parakeet TDT 0.6B v2, the offline model strut already ships: encoder,
 *           prediction net and joiner, then the TDT (token-and-duration
 *           transducer) forward log-likelihood of a text. The pick.
 *   tdt110  Parakeet TDT 110M (sherpa-onnx export), the same method, smaller.
 *   ctc     Parakeet TDT-CTC 110M's CTC head: CTC forward log-likelihood.
 *
 * A change's score is delta = fit(text with the change) - fit(text as typed),
 * in nats, with the model's own spelling prior taken back out (see `Fit`).
 * A mishearing fits about as well as the transcript did; a different word
 * fits clearly worse. Learn when delta >= threshold (-8 at lambda 1).
 *
 *   tsx src/audio/dictation-eval/audio-score.ts                       # the spike's pairs
 *   tsx src/audio/dictation-eval/audio-score.ts --set cases --stt     # cases.jsonl learn cases, plus transcripts
 *   tsx src/audio/dictation-eval/audio-score.ts --set cases --judge judge.txt --fixer 1.7b
 *       # against run.ts --verbose output, and the no-judge policy on a fixer model
 *   tsx src/audio/dictation-eval/audio-score.ts --bench --scorer tdt --voices Samantha  # latency by clip length
 *
 * Opt-in and not part of `npm test`. macOS only (audio comes from `say` and
 * `afconvert`, in five voices by default). It needs, in ./.models (gitignored):
 *   - ctc/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8 and
 *     tdt110/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8,
 *     from the sherpa-onnx `asr-models` release, for those scorers;
 *   - gguf/ (as run.ts) for --fixer;
 * and Parakeet TDT 0.6B v2 (and Kroko, for --stt) in strut's model dir
 * (`--models`, default Peel's cache). WAVs are cached in .models/audio-score/wavs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ort from "onnxruntime-node";
import { DictationFixer } from "../fixer.js";
import { hunks, isCode } from "../lingo.js";
import { FIXER_MODELS } from "../models.js";
import { runProcess } from "../../shell.js";
import { createStt } from "../stt.js";
import { loadCases } from "./run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");

// ── Audio ───────────────────────────────────────────────────────────────────

/** 16 kHz mono PCM16 WAV → float samples in [-1, 1]. */
export function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (b.readUInt16LE(off + 10) !== 1 || b.readUInt32LE(off + 12) !== 16000 || b.readUInt16LE(off + 22) !== 16) throw new Error(`${path}: want 16 kHz mono PCM16`);
    }
    if (id === "data") {
      const n = size / 2, out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

/** `say` in a voice, then afconvert to 16 kHz mono PCM16. Cached by voice and text. */
async function synth(dir: string, voice: string, text: string): Promise<string> {
  const key = `${voice}-${text.replace(/[^\w]+/g, "_").slice(0, 60)}-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
  const wav = join(dir, `${key}.wav`);
  if (existsSync(wav)) return wav;
  const aiff = join(dir, `${key}.aiff`);
  for (const [cmd, args] of [["say", ["-v", voice, "-o", aiff, text]], ["afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]]] as const) {
    const r = await runProcess({ cmd, args: [...args], cwd: dir });
    if (r.code !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
  }
  rmSync(aiff);
  return wav;
}

// ── NeMo log-mel features (AudioToMelSpectrogramPreprocessor defaults) ──────

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** librosa.filters.mel(sr=16000, n_fft=512, fmin=0, fmax=8000, norm="slaney"). */
function melBank(nMels: number, nFft = 512, sr = 16000): Float64Array[] {
  const toMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27));
  const toHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)));
  const bins = nFft / 2 + 1, top = toMel(sr / 2);
  const hz = Array.from({ length: nMels + 2 }, (_, i) => toHz((top * i) / (nMels + 1)));
  const freqs = Array.from({ length: bins }, (_, i) => (i * sr) / nFft);
  return Array.from({ length: nMels }, (_, m) => {
    const w = new Float64Array(bins), enorm = 2 / (hz[m + 2]! - hz[m]!);
    for (let k = 0; k < bins; k++) {
      const lo = (freqs[k]! - hz[m]!) / (hz[m + 1]! - hz[m]!), hi = (hz[m + 2]! - freqs[k]!) / (hz[m + 2]! - hz[m + 1]!);
      w[k] = Math.max(0, Math.min(lo, hi)) * enorm;
    }
    return w;
  });
}

/** [nMels, frames] row-major, per-feature normalised, as NeMo feeds its encoder. */
export function logMel(x: Float32Array, nMels: number): { data: Float32Array; frames: number } {
  const nFft = 512, hop = 160, win = 400, pad = nFft / 2;
  const pre = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) pre[i] = i === 0 ? x[0]! : x[i]! - 0.97 * x[i - 1]!;
  const frames = Math.floor(x.length / hop) + 1;
  const hann = new Float64Array(nFft), woff = (nFft - win) / 2;
  for (let i = 0; i < win; i++) hann[woff + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
  const bank = melBank(nMels), out = new Float32Array(nMels * frames);
  const re = new Float64Array(nFft), im = new Float64Array(nFft);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < nFft; i++) {
      const s = f * hop + i - pad;
      re[i] = s >= 0 && s < pre.length ? pre[s]! * hann[i]! : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let m = 0; m < nMels; m++) {
      const w = bank[m]!;
      let e = 0;
      for (let k = 0; k <= nFft / 2; k++) if (w[k]) e += w[k]! * (re[k]! * re[k]! + im[k]! * im[k]!);
      out[m * frames + f] = Math.log(e + 2 ** -24);
    }
  }
  for (let m = 0; m < nMels; m++) {
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += out[m * frames + f]!;
    mean /= frames;
    let v = 0;
    for (let f = 0; f < frames; f++) v += (out[m * frames + f]! - mean) ** 2;
    const sd = Math.sqrt(v / Math.max(1, frames - 1)) + 1e-5;
    for (let f = 0; f < frames; f++) out[m * frames + f] = (out[m * frames + f]! - mean) / sd;
  }
  return { data: out, frames };
}

// ── Tokens ──────────────────────────────────────────────────────────────────

/** tokens.txt pieces, and a segmenter: each word into the fewest pieces (no sentencepiece model ships). */
export class Vocab {
  readonly pieces: string[] = [];
  readonly ids = new Map<string, number>();
  readonly blank: number;
  constructor(tokensTxt: string) {
    for (const line of readFileSync(tokensTxt, "utf8").split("\n")) {
      const sp = line.lastIndexOf(" ");
      if (sp < 0) continue;
      const piece = line.slice(0, sp), id = Number(line.slice(sp + 1));
      this.pieces[id] = piece;
      this.ids.set(piece, id);
    }
    this.blank = this.ids.get("<blk>")!;
  }
  encode(text: string): number[] {
    const out: number[] = [];
    for (const word of text.trim().split(/\s+/).filter(Boolean)) {
      const w = `▁${word}`, n = w.length;
      const best: { cost: number; prev: number; id: number }[] = Array.from({ length: n + 1 }, () => ({ cost: Infinity, prev: -1, id: -1 }));
      best[0]!.cost = 0;
      for (let i = 0; i < n; i++) {
        if (best[i]!.cost === Infinity) continue;
        for (let j = n; j > i; j--) {
          const id = this.ids.get(w.slice(i, j));
          if (id !== undefined && best[i]!.cost + 1 < best[j]!.cost) best[j] = { cost: best[i]!.cost + 1, prev: i, id };
        }
        // A character outside the vocab costs a lot and maps to <unk>.
        if (best[i]!.cost + 10 < best[i + 1]!.cost) best[i + 1] = { cost: best[i]!.cost + 10, prev: i, id: 0 };
      }
      const seq: number[] = [];
      for (let j = n; j > 0; j = best[j]!.prev) seq.unshift(best[j]!.id);
      out.push(...seq);
    }
    return out;
  }
  decode(ids: number[]): string {
    return ids.map((i) => this.pieces[i]).join("").replace(/▁/g, " ").trim();
  }
}

const lse = (a: number, b: number) => (a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b))));

// ── Scorers ─────────────────────────────────────────────────────────────────

/**
 * A text's fit to one recording. `raw` is log P(audio | text). The model also
 * carries a prior over spellings (CTC: token priors; TDT: its prediction net,
 * an internal LM), which marks a rare spelling down however well it sounds
 * right. `at(lambda)` takes lambda of that prior back out:
 *   ctc  emissions log p(k | x) - lambda * log p(k)  (hybrid-style prior division)
 *   tdt  raw - lambda * log P_ILM(text)              (internal LM estimation, ILME)
 */
export interface Fit {
  raw: number;
  at(lambda: number): number;
}

/** One recording, encoded once. */
export interface Encoded {
  frames: number;
  encodeMs: number;
  greedy(): Promise<string>;
  score(text: string): Promise<Fit>;
}

export interface Scorer {
  id: string;
  bytes: number;
  encode(samples: Float32Array): Promise<Encoded>;
}

const opts: ort.InferenceSession.SessionOptions = { intraOpNumThreads: 2, graphOptimizationLevel: "all" };
const size = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".onnx")).reduce((s, f) => s + readFileSync(join(dir, f)).length, 0);

export async function ctcScorer(dir: string, priorClips: Float32Array[]): Promise<Scorer> {
  const vocab = new Vocab(join(dir, "tokens.txt"));
  const session = await ort.InferenceSession.create(join(dir, readdirSync(dir).find((f) => f.endsWith(".onnx"))!), opts);
  let logPrior: Float64Array | null = null;
  const scorer: Scorer = {
    id: "ctc-110m",
    bytes: size(dir),
    async encode(samples) {
      const t0 = performance.now();
      const { data, frames } = logMel(samples, 80);
      const r = await session.run({
        audio_signal: new ort.Tensor("float32", data, [1, 80, frames]),
        length: new ort.Tensor("int64", BigInt64Array.from([BigInt(frames)]), [1]),
      });
      const lp = r["logprobs"]!, [, T, V] = lp.dims as number[];
      const L = lp.data as Float32Array;
      const encodeMs = performance.now() - t0;
      return {
        frames: T!,
        encodeMs,
        async greedy() {
          const ids: number[] = [];
          let prev = -1;
          for (let t = 0; t < T!; t++) {
            let best = 0;
            for (let v = 1; v < V!; v++) if (L[t * V! + v]! > L[t * V! + best]!) best = v;
            if (best !== prev && best !== vocab.blank) ids.push(best);
            prev = best;
          }
          return vocab.decode(ids);
        },
        posteriors: () => ({ L, T: T!, V: V! }),
        async score(text) {
          const y = vocab.encode(text), S = 2 * y.length + 1;
          const lab = (s: number) => (s % 2 === 0 ? vocab.blank : y[(s - 1) / 2]!);
          const forward = (lambda: number) => {
            const e = (t: number, s: number) => L[t * V! + lab(s)]! - (s % 2 === 1 && logPrior ? lambda * logPrior[lab(s)]! : 0);
            let a = new Float64Array(S).fill(-Infinity);
            a[0] = e(0, 0);
            if (S > 1) a[1] = e(0, 1);
            for (let t = 1; t < T!; t++) {
              const b = new Float64Array(S).fill(-Infinity);
              for (let s = 0; s < S; s++) {
                let v = a[s]!;
                if (s > 0) v = lse(v, a[s - 1]!);
                if (s > 1 && s % 2 === 1 && lab(s) !== lab(s - 2)) v = lse(v, a[s - 2]!);
                b[s] = v + e(t, s);
              }
              a = b;
            }
            return S > 1 ? lse(a[S - 1]!, a[S - 2]!) : a[0]!;
          };
          return { raw: forward(0), at: forward };
        },
      } as Encoded & { posteriors(): { L: Float32Array; T: number; V: number } };
    },
  };
  // Token priors: mean frame posterior over clips not in the test, floored so an unseen piece is not boosted without bound.
  const sum = new Float64Array(vocab.pieces.length);
  let n = 0;
  for (const clip of priorClips) {
    const { L, T, V } = ((await scorer.encode(clip)) as any).posteriors();
    for (let t = 0; t < T; t++) for (let v = 0; v < V; v++) sum[v] += Math.exp(L[t * V + v]!);
    n += T;
  }
  logPrior = Float64Array.from(sum, (x) => Math.log(Math.max(x / Math.max(1, n), 1e-5)));
  return scorer;
}

export async function tdtScorer(dir: string, id: string): Promise<Scorer> {
  const vocab = new Vocab(join(dir, "tokens.txt"));
  const pick = (part: string) => join(dir, readdirSync(dir).find((f) => f.startsWith(part) && f.endsWith(".onnx"))!);
  const [enc, dec, join_] = await Promise.all([pick("encoder"), pick("decoder"), pick("joiner")].map((f) => ort.InferenceSession.create(f, opts)));
  const V = vocab.pieces.length, DUR = [0, 1, 2, 3, 4];
  // Shapes from the export: mel bins, encoder width, prediction-net width and LSTM state inputs.
  const meta = (s: ort.InferenceSession, i: number) => (s.inputMetadata[i] as unknown as { name: string; shape: (number | string)[] });
  const MELS = meta(enc!, 0).shape[1] as number, H = meta(join_!, 0).shape[1] as number, G = meta(join_!, 1).shape[1] as number;
  const stateIn = [meta(dec!, 2), meta(dec!, 3)].map((m) => ({ name: m.name, layers: m.shape[0] as number }));
  /** Prediction-net outputs [640, U+1] for blank (SOS) then y. */
  async function predict(y: number[]): Promise<{ data: Float32Array; n: number }> {
    const ids = Int32Array.from([vocab.blank, ...y]);
    const r = await dec!.run({
      targets: new ort.Tensor("int32", ids, [1, ids.length]),
      target_length: new ort.Tensor("int32", Int32Array.from([ids.length]), [1]),
      ...Object.fromEntries(stateIn.map((m) => [m.name, new ort.Tensor("float32", new Float32Array(m.layers * G), [m.layers, 1, G])])),
    });
    return { data: r["outputs"]!.data as Float32Array, n: ids.length };
  }
  return {
    id,
    bytes: size(dir),
    async encode(samples) {
      const t0 = performance.now();
      const { data, frames } = logMel(samples, MELS);
      const r = await enc!.run({
        audio_signal: new ort.Tensor("float32", data, [1, MELS, frames]),
        length: new ort.Tensor("int64", BigInt64Array.from([BigInt(frames)]), [1]),
      });
      const E = r["outputs"]!, T = (r["encoded_lengths"]!.data as BigInt64Array)[0]!;
      const nT = Number(T), Tfull = E.dims[2]!;
      const encodeMs = performance.now() - t0;
      /** Joiner over every frame for prediction outputs [640, n] → logits [T, n, V+5]. */
      const joint = async (g: Float32Array, n: number) => (await join_!.run({
        encoder_outputs: E,
        decoder_outputs: new ort.Tensor("float32", g, [1, G, n]),
      }))["outputs"]!.data as Float32Array;
      const W = V + DUR.length;
      const lsm = (z: Float32Array, base: number, from: number, to: number) => {
        let m = -Infinity, s = 0;
        for (let i = from; i < to; i++) m = Math.max(m, z[base + i]!);
        for (let i = from; i < to; i++) s += Math.exp(z[base + i]! - m);
        return m + Math.log(s);
      };
      return {
        frames: nT,
        encodeMs,
        async greedy() {
          // Greedy TDT decode (as sherpa's), one prediction step per token; for checking the features.
          const out: number[] = [];
          let t = 0, g = await predict([]);
          let gcol = Float32Array.from({ length: G }, (_, k) => g.data[k * g.n + g.n - 1]!);
          let z = await joint(gcol, 1);
          for (let steps = 0; t < nT && steps < 4 * nT; steps++) {
            const base = t * W;
            let tok = 0, d = 0;
            for (let v = 1; v < V; v++) if (z[base + v]! > z[base + tok]!) tok = v;
            for (let k = 1; k < DUR.length; k++) if (z[base + V + k]! > z[base + V + d]!) d = k;
            if (tok !== vocab.blank) {
              out.push(tok);
              g = await predict(out);
              gcol = Float32Array.from({ length: G }, (_, k) => g.data[k * g.n + g.n - 1]!);
              z = await joint(gcol, 1);
            }
            t += tok === vocab.blank && DUR[d] === 0 ? 1 : DUR[d]!;
          }
          return vocab.decode(out);
        },
        async score(text) {
          const y = vocab.encode(text), U = y.length;
          const g = await predict(y);
          // Joiner in blocks of prediction steps, keeping per (t, u) only what the forward pass reads.
          const blankLp = new Float64Array(nT * (U + 1)), tokLp = new Float64Array(nT * (U + 1)), durLp = new Float64Array(nT * (U + 1) * DUR.length);
          const BLOCK = Math.max(1, Math.floor(4e7 / (Tfull * W)));
          for (let u0 = 0; u0 <= U; u0 += BLOCK) {
            const n = Math.min(BLOCK, U + 1 - u0), gb = new Float32Array(G * n);
            for (let k = 0; k < G; k++) for (let j = 0; j < n; j++) gb[k * n + j] = g.data[k * g.n + u0 + j]!;
            const z = await joint(gb, n);
            for (let t = 0; t < nT; t++) {
              for (let j = 0; j < n; j++) {
                const u = u0 + j, base = (t * n + j) * W, cell = t * (U + 1) + u;
                const zt = lsm(z, base, 0, V), zd = lsm(z, base, V, W);
                blankLp[cell] = z[base + vocab.blank]! - zt;
                tokLp[cell] = u < U ? z[base + y[u]!]! - zt : -Infinity;
                for (let k = 0; k < DUR.length; k++) durLp[cell * DUR.length + k] = z[base + V + k]! - zd;
              }
            }
          }
          // alpha over (t, u); a blank moves 1..4 frames, a token 0..4; the path ends at frame T with all of y.
          const alpha = new Float64Array((nT + 1) * (U + 1)).fill(-Infinity);
          // Internal LM: the joiner with the acoustic input zeroed, over non-blank tokens.
          const z0 = (await join_!.run({
            encoder_outputs: new ort.Tensor("float32", new Float32Array(H), [1, H, 1]),
            decoder_outputs: new ort.Tensor("float32", g.data, [1, G, U + 1]),
          }))["outputs"]!.data as Float32Array;
          let ilm = 0;
          for (let u = 0; u < U; u++) {
            const base = u * W;
            let m = -Infinity, s = 0;
            for (let v = 0; v < V; v++) if (v !== vocab.blank) m = Math.max(m, z0[base + v]!);
            for (let v = 0; v < V; v++) if (v !== vocab.blank) s += Math.exp(z0[base + v]! - m);
            ilm += z0[base + y[u]!]! - m - Math.log(s);
          }
          alpha[0] = 0;
          for (let t = 0; t < nT; t++) {
            for (let u = 0; u <= U; u++) {
              const a = alpha[t * (U + 1) + u]!;
              if (a === -Infinity) continue;
              const cell = t * (U + 1) + u;
              for (let k = 0; k < DUR.length; k++) {
                const d = DUR[k]!, dl = durLp[cell * DUR.length + k]!;
                if (d > 0 && t + d <= nT) {
                  const i = (t + d) * (U + 1) + u;
                  alpha[i] = lse(alpha[i]!, a + blankLp[cell]! + dl);
                }
                if (u < U && t + d <= nT && !(d === 0 && t + d === nT)) {
                  const i = (t + d) * (U + 1) + u + 1;
                  alpha[i] = lse(alpha[i]!, a + tokLp[cell]! + dl);
                }
              }
            }
          }
          const raw = alpha[nT * (U + 1) + U]!;
          return { raw, at: (lambda: number) => raw - lambda * ilm };
        },
      };
    },
  };
}

// ── Test sets ───────────────────────────────────────────────────────────────

/** One edit to judge: `say` is what the speaker said; `base` the text as typed, `edit` with the change. */
interface Item {
  id: string;
  say: string;
  base: string;
  edit: string;
  /** Should the change be learned (it fits what was said)? */
  learn: boolean;
  /** The hunk as cases.jsonl's pairs name it, for matching. */
  pair?: { heard: string; written: string };
}

/** The spike brief's pairs: base is the other candidate, as a transcript might have typed it. */
const PAIRS: Item[] = [
  { id: "p-itoi", say: "His name is Paul Itoi.", base: "His name is Paul Etoy.", edit: "His name is Paul Itoi.", learn: true },
  { id: "p-kathryn", say: "My wife is Kathryn O'Brien.", base: "My wife is Katherine O'Brien.", edit: "My wife is Kathryn O'Brien.", learn: true },
  { id: "p-stakwork", say: "I work for Stakwork.", base: "I work for Stack work.", edit: "I work for Stakwork.", learn: true },
  { id: "p-supabase", say: "We use Supabase.", base: "We use super base.", edit: "We use Supabase.", learn: true },
  { id: "p-p8", say: "Ship P8 by Friday.", base: "Ship PH by Friday.", edit: "Ship P8 by Friday.", learn: true },
  { id: "n-mark", say: "I'll call Mark tomorrow.", base: "I'll call Mark tomorrow.", edit: "I'll call Mike tomorrow.", learn: false },
  { id: "n-jon", say: "Ask Jon about it.", base: "Ask Jon about it.", edit: "Ask Jen about it.", learn: false },
  { id: "n-tom", say: "Tell Tom the deck is ready.", base: "Tell Tom the deck is ready.", edit: "Tell Tim the deck is ready.", learn: false },
];

/**
 * cases.jsonl learn cases → one item per word hunk. Audio is what the user
 * meant: the edited sentence when the edit is a mishearing, the typed one when
 * the user chose a different word. Cases with no sensible audio version are
 * left out (SKIP, with why).
 */
export const SKIP: Record<string, string> = {
  "n-cut": "a cut: nothing new to score",
  "n-add": "an addition: nothing heard to score against",
  "n-rewrite": "a rewrite: not a correction of what was said",
  "n-rewrite-2": "a rewrite",
  "n-punct": "punctuation and casing only",
  "n-format": "number formatting: the same words",
  "n-possessive": "a grammar edit",
  "n-filler": "a filler removed: a cut",
  "n-lsat-off": "filtered by the lexicon (turned off), not by judgement",
  "n-undone": "filtered by the lexicon (undone pair), not by judgement",
  "n-btc-bitcoin": "two right ways to write one thing; which was said is unknown",
  "l-long-two": "a one-minute dictation: kept out of the main table, timed separately",
};
/** What a speaker would say where `say` cannot read the written form the way they mean it. */
const SPOKEN: Record<string, string> = {
  "l-kates": "restart the kates cluster",
};

function caseItems(): Item[] {
  const out: Item[] = [];
  for (const c of loadCases()) {
    if (c.kind !== "learn" || SKIP[c.id]) continue;
    const hs = hunks(c.typed, c.edited);
    const wanted = (h: { from: string; to: string }) => c.expect.find((e) => e.heard.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "") === h.from.toLowerCase() && e.written.replace(/[^\p{L}\p{N}]/gu, "") === h.to.replace(/[^\p{L}\p{N}]/gu, ""));
    // Audio: the edited text with each unwanted hunk (a changed mind) undone.
    const words = c.typed.split(/\s+/);
    const say = SPOKEN[c.id] ?? (hs.some((h) => !wanted(h)) ? applyHunks(c.typed, hs.filter((h) => wanted(h))) : c.edited);
    for (const h of hs) {
      const pair = wanted(h);
      out.push({ id: hs.length > 1 ? `${c.id}#${h.from}` : c.id, say, base: words.join(" "), edit: applyHunks(c.typed, [h]), learn: !!pair, pair: pair ?? { heard: h.from, written: h.to } });
    }
  }
  return out;
}

/** Replace hunks' word ranges in `text` (whitespace words; edge punctuation of the range kept). */
function applyHunks(text: string, hs: { to: string; a: [number, number] }[]): string {
  const words = text.split(/\s+/);
  for (const h of [...hs].sort((x, y) => y.a[0] - x.a[0])) {
    const lead = words[h.a[0]]?.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "", trail = words[h.a[1] - 1]?.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? "";
    words.splice(h.a[0], h.a[1] - h.a[0], ...(h.to ? [`${lead}${h.to}${trail}`] : []));
  }
  return words.join(" ");
}

/** Latency by clip length: the long dictation's first sentences, the "stack work" mishearing in the second. */
function benchItems(): Item[] {
  const long = loadCases().find((c) => c.id === "l-long-two") as { typed: string } | undefined;
  if (!long) return [];
  const sentences = long.typed.replace(/\n+/g, " ").match(/[^.]+\./g)!.map((x) => x.trim());
  return [2, 4, 8, 16].map((k) => {
    const said = sentences.slice(0, k).join(" ");
    return { id: `bench-${k}-sentences`, say: said.replace("stack work", "Stakwork"), base: said, edit: said.replace("stack work", "Stakwork"), learn: true };
  });
}

// ── Run ─────────────────────────────────────────────────────────────────────

interface Args {
  set: "pairs" | "cases";
  scorers: string[];
  voices: string[];
  stt: boolean;
  models: string;
  lambda: Record<string, number>;
  threshold: Record<string, number>;
  /** run.ts --verbose outputs (the judge on cases.jsonl), compared on the same items. */
  judge: string[];
  /** Fixer models for the no-judge policy: audio, then only the single-word name and everyday questions. */
  fixers: string[];
  gguf: string;
  bench: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const perScorer = (v: string | undefined, dflt: Record<string, number>) => v === undefined ? dflt : Object.fromEntries(Object.keys(dflt).map((k) => [k, Number(v)]));
  return {
    set: (get("set") ?? "pairs") as Args["set"],
    scorers: (get("scorer") ?? "tdt110,tdt").split(","),
    voices: (get("voices") ?? "Samantha,Daniel,Karen,Moira,Rishi").split(","),
    stt: argv.includes("--stt"),
    models: get("models") ?? join(homedir(), "Library/Application Support/Peel/Strut/cache/strut/models"),
    lambda: perScorer(get("lambda"), { "ctc-110m": 1, "tdt-110m": 1, "tdt-0.6b": 1 }),
    threshold: perScorer(get("threshold"), { "ctc-110m": -8, "tdt-110m": -8, "tdt-0.6b": -8 }),
    judge: get("judge")?.split(",") ?? [],
    fixers: get("fixer")?.split(",") ?? [],
    gguf: get("gguf") ?? join(ROOT, ".models/gguf"),
    bench: argv.includes("--bench"),
    verbose: argv.includes("--verbose"),
  };
}

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
const LAMBDAS = [0, 0.25, 0.5, 0.75, 1, 1.25];

/** Clips outside every test set, for the CTC token priors: the models' own real-voice samples and a long dictation in a voice the tests do not use. */
async function priorClips(models: string, wavDir: string): Promise<Float32Array[]> {
  const dirs = [join(ROOT, ".models/ctc"), join(models, "stt")];
  const wavs = dirs.flatMap((d) => existsSync(d) ? readdirSync(d).map((m) => join(d, m, "test_wavs")).filter(existsSync).flatMap((t) => readdirSync(t).filter((f) => f.endsWith(".wav")).map((f) => join(t, f))) : []);
  const long = loadCases().find((c) => c.id === "l-long-two") as { edited: string } | undefined;
  if (long) for (const p of long.edited.split(/\n+/).filter(Boolean)) wavs.push(await synth(wavDir, "Fred", p));
  return wavs.flatMap((w) => {
    try {
      return [readWav(w)];
    } catch {
      return []; // not 16 kHz mono PCM16
    }
  });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const wavDir = join(ROOT, ".models/audio-score/wavs");
  mkdirSync(wavDir, { recursive: true });
  const items = a.bench ? benchItems() : a.set === "pairs" ? PAIRS : caseItems();
  const scorers: Scorer[] = [];
  for (const s of a.scorers) {
    const t0 = performance.now();
    const rss0 = process.memoryUsage().rss;
    if (s === "ctc") {
      const dir = join(ROOT, ".models/ctc", readdirSync(join(ROOT, ".models/ctc")).find((d) => d.includes("ctc"))!);
      scorers.push(await ctcScorer(dir, await priorClips(a.models, wavDir)));
    } else if (s === "tdt") scorers.push(await tdtScorer(join(a.models, "stt/parakeet-tdt-en-0.6b-v2"), "tdt-0.6b"));
    else if (s === "tdt110") {
      const dir = join(ROOT, ".models/tdt110", readdirSync(join(ROOT, ".models/tdt110")).find((d) => d.includes("110m"))!);
      scorers.push(await tdtScorer(dir, "tdt-110m"));
    }
    console.log(`# ${scorers.at(-1)!.id}: ${mb(scorers.at(-1)!.bytes)} on disk, load ${Math.round(performance.now() - t0)} ms${s === "ctc" ? " (with its priors)" : ""}, +${mb(process.memoryUsage().rss - rss0)} RSS`);
  }
  const stt = a.stt ? createStt({ dataDir: join(ROOT, ".models/audio-score/data"), modelDir: a.models, log: () => {} }) : null;

  const rows: { item: Item; voice: string; scorer: string; base: Fit; edit: Fit; greedy: string; heard: Record<string, string>; encodeMs: number; scoreMs: number; seconds: number }[] = [];
  for (const voice of a.voices) {
    for (const item of items) {
      const wav = await synth(wavDir, voice, item.say);
      const samples = readWav(wav);
      const heard: Record<string, string> = {};
      if (stt) {
        for (const model of ["parakeet-tdt-en-0.6b-v2", "zipformer-en-kroko"]) heard[model] = (await stt.transcribe(readFileSync(wav), { model })).text;
      }
      for (const s of scorers) {
        const enc = await s.encode(samples);
        const t1 = performance.now();
        const base = await enc.score(item.base), edit = await enc.score(item.edit);
        const lam = a.lambda[s.id]!;
        base.at(lam); edit.at(lam);
        const scoreMs = (performance.now() - t1) / 2;
        const greedy = a.verbose ? await enc.greedy() : "";
        rows.push({ item, voice, scorer: s.id, base, edit, greedy, heard, encodeMs: enc.encodeMs, scoreMs, seconds: samples.length / 16000 });
        if (a.verbose) console.log(`${s.id} ${voice} ${item.id} Δraw=${(edit.raw - base.raw).toFixed(2)} Δλ=${(edit.at(lam) - base.at(lam)).toFixed(2)} ${(samples.length / 16000).toFixed(1)}s encode ${Math.round(enc.encodeMs)}ms score ${Math.round(scoreMs)}ms/text greedy="${greedy}" ${JSON.stringify(heard)}`);
      }
    }
  }
  await stt?.close();
  const delta = (r: (typeof rows)[number], lam: number) => r.edit.at(lam) - r.base.at(lam);
  const p = (xs: number[], q: number) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]!;

  for (const s of scorers) {
    const mine = rows.filter((x) => x.scorer === s.id);
    // How far apart are mishearings and changed words, for each lambda? Best single threshold, per clip.
    console.log(`\n## ${s.id}: separation by lambda (per clip; Δ = fit(edit) − fit(typed), nats)\n`);
    console.log("| lambda | lowest positive | highest negative | best threshold | clip accuracy there |");
    console.log("|---|---|---|---|---|");
    for (const lam of LAMBDAS) {
      const pos = mine.filter((x) => x.item.learn).map((x) => delta(x, lam)), neg = mine.filter((x) => !x.item.learn).map((x) => delta(x, lam));
      let best = { th: 0, acc: -1 };
      for (const th of [...pos, ...neg].sort((x, y) => x - y)) {
        const acc = (pos.filter((d) => d >= th).length + neg.filter((d) => d < th).length) / (pos.length + neg.length);
        if (acc > best.acc) best = { th, acc };
      }
      console.log(`| ${lam} | ${pos.length ? Math.min(...pos).toFixed(1) : "-"} | ${neg.length ? Math.max(...neg).toFixed(1) : "-"} | ${best.th.toFixed(1)} | ${best.acc.toFixed(2)} |`);
    }
    const lam = a.lambda[s.id]!, th = a.threshold[s.id]!;
    console.log(`\n## ${s.id} at lambda ${lam}: learn when Δ ≥ ${th} (median over ${a.voices.length} voices)\n`);
    console.log("| item | should learn | typed → edited | Δ raw | Δ | Δ min | Δ max | clips learned | verdict |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    let tp = 0, fp = 0, fn = 0, tn = 0, cTp = 0, cFp = 0, cFn = 0, cTn = 0;
    for (const item of items) {
      const rs = mine.filter((x) => x.item === item);
      const r = rs.map((x) => delta(x, lam)).sort((x, y) => x - y), raw = rs.map((x) => x.edit.raw - x.base.raw).sort((x, y) => x - y);
      const med = r[Math.floor(r.length / 2)]!, votes = r.filter((d) => d >= th).length;
      const got = med >= th;
      if (got && item.learn) tp++; else if (got) fp++; else if (item.learn) fn++; else tn++;
      for (const d of r) {
        const g = d >= th;
        if (g && item.learn) cTp++; else if (g) cFp++; else if (item.learn) cFn++; else cTn++;
      }
      const [f, t] = diffWords(item.base, item.edit);
      console.log(`| ${item.id} | ${item.learn ? "yes" : "no"} | ${f} → ${t} | ${raw[Math.floor(raw.length / 2)]!.toFixed(1)} | ${med.toFixed(1)} | ${r[0]!.toFixed(1)} | ${r.at(-1)!.toFixed(1)} | ${votes}/${r.length} | ${got === item.learn ? "ok" : "WRONG"} |`);
    }
    const prf = (tp: number, fp: number, fn: number, tn: number) => `precision ${(tp / Math.max(1, tp + fp)).toFixed(2)}, recall ${(tp / Math.max(1, tp + fn)).toFixed(2)}, accuracy ${((tp + tn) / Math.max(1, tp + fp + fn + tn)).toFixed(2)} (tp ${tp} fp ${fp} fn ${fn} tn ${tn})`;
    console.log(`\nper item (median voice): ${prf(tp, fp, fn, tn)}`);
    console.log(`per clip: ${prf(cTp, cFp, cFn, cTn)}`);
    console.log(`clip ${p(mine.map((x) => x.seconds), 0.5).toFixed(1)} s median, ${p(mine.map((x) => x.seconds), 1).toFixed(1)} s max; encode p50 ${Math.round(p(mine.map((x) => x.encodeMs), 0.5))} ms p95 ${Math.round(p(mine.map((x) => x.encodeMs), 0.95))} ms; one text scored p50 ${p(mine.map((x) => x.scoreMs), 0.5).toFixed(1)} ms p95 ${p(mine.map((x) => x.scoreMs), 0.95).toFixed(1)} ms`);
  }
  for (const file of a.judge) {
    // The judge's learned pairs per case, from run.ts --verbose ("ok   id 64ms [pairs]").
    const learned = new Map<string, { heard: string; written: string }[]>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^(?:ok  |FAIL) (\S+) \d+ms (\[.*\])$/);
      if (m) learned.set(m[1]!, JSON.parse(m[2]!));
    }
    const core = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const judged = (item: Item) => (learned.get(item.id.split("#")[0]!) ?? []).some((q) => core(q.heard) === core(item.pair!.heard) && q.written.replace(/[^\p{L}\p{N}]/gu, "") === item.pair!.written.replace(/[^\p{L}\p{N}]/gu, ""));
    console.log(`\n## against the judge (${file.split("/").pop()}), same ${items.length} items, median voice\n`);
    console.log("| policy | precision | recall | accuracy | tp | fp | fn | tn | wrong |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const s of scorers) {
      const th = a.threshold[s.id]!, lam = a.lambda[s.id]!;
      const fits = (item: Item) => {
        const r = rows.filter((x) => x.scorer === s.id && x.item === item).map((x) => delta(x, lam)).sort((x, y) => x - y);
        return r[Math.floor(r.length / 2)]! >= th;
      };
      const policies: [string, (i: Item) => boolean][] = [["judge", judged], [`audio ${s.id}`, fits], [`judge and audio ${s.id}`, (i) => judged(i) && fits(i)]];
      for (const [name, f] of policies) {
        if (name === "judge" && s !== scorers[0]) continue;
        let tp = 0, fp = 0, fn = 0, tn = 0;
        const wrong: string[] = [];
        for (const item of items) {
          const got = f(item);
          if (got && item.learn) tp++; else if (got) fp++; else if (item.learn) fn++; else tn++;
          if (got !== item.learn) wrong.push(item.id);
        }
        console.log(`| ${name} | ${(tp / Math.max(1, tp + fp)).toFixed(2)} | ${(tp / Math.max(1, tp + fn)).toFixed(2)} | ${((tp + tn) / items.length).toFixed(2)} | ${tp} | ${fp} | ${fn} | ${tn} | ${wrong.join(", ")} |`);
      }
    }
  }
  for (const model of a.fixers) {
    // Audio decides whether the edit sounds like what was said. What sound cannot tell is left to two
    // one-word questions: a respelling between two everyday words ("their" → "there", "apple" → "Apple")
    // is not learned unless the user's word reads as a name where it stands, and never at a sentence start.
    const entry = FIXER_MODELS.find((m) => m.id === `qwen3-${model}-q4`)!;
    const fixers = new DictationFixer({ model: async () => ({ id: entry.id, path: join(a.gguf, entry.file) }) });
    const f = (await fixers.current())!;
    await f.ready();
    await f.everyday(["hi"]);
    await f.named([{ text: "Hi there", word: "Hi" }]);
    const ms: number[] = [];
    const lexical = new Map<Item, boolean>();
    for (const item of items) {
      const { heard, written } = item.pair ?? { heard: diffWords(item.base, item.edit)[0], written: diffWords(item.base, item.edit)[1] };
      if (isCode(heard) || isCode(written)) {
        lexical.set(item, true);
        continue;
      }
      const t0 = performance.now();
      const [[eFrom, eTo], [named]] = await Promise.all([f.everyday([heard.toLowerCase(), written.toLowerCase()]), f.named([{ text: item.edit, word: written }])]);
      ms.push(performance.now() - t0);
      const at = item.edit.indexOf(written), start = /(?:^|[.!?])[\s"'“‘(]*$/u.test(item.edit.slice(0, Math.max(0, at)));
      const bothEveryday = eFrom! > 2 && eTo! > 2;
      lexical.set(item, !(bothEveryday && (start || named! <= 0)));
    }
    await fixers.close();
    console.log(`\n## no judge: audio, then the name and everyday questions on ${entry.id} (p50 ${Math.round(ms.sort((x, y) => x - y)[Math.floor(ms.length / 2)] ?? 0)} ms a change)\n`);
    console.log("| policy | precision | recall | accuracy | tp | fp | fn | tn | wrong |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const s of scorers) {
      const th = a.threshold[s.id]!, lam = a.lambda[s.id]!;
      const fits = (item: Item) => {
        const r = rows.filter((x) => x.scorer === s.id && x.item === item).map((x) => delta(x, lam)).sort((x, y) => x - y);
        return r[Math.floor(r.length / 2)]! >= th;
      };
      let tp = 0, fp = 0, fn = 0, tn = 0;
      const wrong: string[] = [];
      for (const item of items) {
        const got = fits(item) && lexical.get(item)!;
        if (got && item.learn) tp++; else if (got) fp++; else if (item.learn) fn++; else tn++;
        if (got !== item.learn) wrong.push(item.id);
      }
      console.log(`| audio ${s.id} + ${model} words | ${(tp / Math.max(1, tp + fp)).toFixed(2)} | ${(tp / Math.max(1, tp + fn)).toFixed(2)} | ${((tp + tn) / items.length).toFixed(2)} | ${tp} | ${fp} | ${fn} | ${tn} | ${wrong.join(", ")} |`);
    }
  }
  if (stt) {
    console.log("\n## transcripts (did the recognizer type what was said?)\n");
    for (const model of ["parakeet-tdt-en-0.6b-v2", "zipformer-en-kroko"]) {
      const seen = new Map<string, { said: string; heard: string }>();
      for (const r of rows) if (r.scorer === rows[0]!.scorer) seen.set(`${r.voice}|${r.item.say}`, { said: r.item.say, heard: r.heard[model]! });
      const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
      const exact = [...seen.values()].filter((x) => norm(x.said) === norm(x.heard)).length;
      console.log(`${model}: ${exact}/${seen.size} clips typed exactly (case and punctuation aside)`);
      if (a.verbose) for (const x of seen.values()) if (norm(x.said) !== norm(x.heard)) console.log(`  said "${x.said}" heard "${x.heard}"`);
    }
  }
  console.log(`\nprocess RSS at end ${mb(process.memoryUsage().rss)}`);
}

function diffWords(a: string, b: string): [string, string] {
  const hs = hunks(a, b);
  return [hs.map((h) => h.from).join(" … "), hs.map((h) => h.to).join(" … ")];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
