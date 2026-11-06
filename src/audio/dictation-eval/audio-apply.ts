/**
 * Spike (plans/dictation-audio-check.md, "Applying at transcription"): can the
 * audio scorer, given the user's vocabulary names, rewrite a misspelt name at
 * transcription time? For each clip:
 *
 *   1. the real speech models type it (Parakeet TDT 0.6B and Kroko, via sherpa);
 *   2. candidates: each 1–3-word span near a vocabulary name, by lingo.ts
 *      `recall` as is, or by a looser sound match (`soundsAlike`);
 *   3. Δ = fit(sentence with the name) − fit(sentence as typed, or with the
 *      span title-cased) on the clip, TDT 0.6B at λ = 1, one encode per clip;
 *   4. policies decide which candidates to apply, against today's text-only
 *      fixer (`rewrite` on the 1.7B) on the same transcript.
 *
 * Scored on vocabulary names only: a name the speaker said that the output
 * gains is a true positive, one it gains that was not said a false positive.
 *
 *   tsx src/audio/dictation-eval/audio-apply.ts [--voices Samantha] [--fixer 1.7b] [--verbose]
 *   tsx src/audio/dictation-eval/audio-apply.ts --mem sherpa|onnx   # resident memory, one process each
 *
 * Opt-in, macOS only; needs what audio-score.ts needs. Transcripts are cached
 * in .models/audio-score/stt-cache.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DictationFixer } from "../fixer.js";
import { applyEdits, letters, recall, rewrite, SAME_SOUND_MARGIN, soundKey, soundsAlike, type Fixer, type Lexicon } from "../lingo.js";
import { FIXER_MODELS } from "../models.js";
import { createStt } from "../stt.js";
import { readWav, synth, tdtScorer, type Encoded } from "./audio-score.js";
import { loadCases } from "./run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const STT_MODELS = ["parakeet-tdt-en-0.6b-v2", "zipformer-en-kroko"] as const;
const UPPER = /\p{Lu}/u;

// ── Items ───────────────────────────────────────────────────────────────────

interface Item {
  id: string;
  set: "apply" | "cases";
  /** What `say` speaks. */
  say: string;
  /** The text the speaker meant; its vocabulary names are what the output should hold. */
  intended: string;
  lexicon: Lexicon;
  note?: string;
}

const names = (list: [string, string][]): Lexicon => ({
  entries: list.map(([name, type], i) => ({ refId: `v-${i}`, type, name, written: [name], heard: [], dictationOff: false, facts: 0 })),
  undone: [],
});

/** The user's vocabulary for the new set: names only, nothing learned. */
const VOCAB = names([["Paul Itoi", "Person"], ["Kathryn O'Brien", "Person"], ["Stadeum", "Lingo"], ["Supabase", "Organization"], ["Stakwork", "Organization"], ["P8", "Lingo"], ["Mike", "Person"]]);

const APPLY: Item[] = [
  ["a-boss", "My boss is called Paul Itoi."],
  ["a-ask", "Ask Paul Itoi about it."],
  ["a-review", "Paul Itoi will review the deck on Monday."],
  ["a-kathryn", "Kathryn O'Brien is my wife."],
  ["a-stadeum", "Deploy it to Stadeum."],
  ["a-supabase", "We use Supabase."],
  ["a-stakwork", "I work for Stakwork."],
  ["a-p8", "Ship P8 by Friday."],
  ["n-etoy", "I met Paul Etoy at the conference.", "a different person, spelt one letter off"],
  ["n-paula-toy", "I met Paula Toy at the conference.", "a different person"],
  ["n-stadium", "We watched the game at the stadium.", "the everyday stadium"],
  ["n-ph", "The pH of the water is high.", "pH, not P8"],
  ["n-mark", "I'll call Mark tomorrow.", "Mark, not Mike"],
  ["n-toy", "My son wants a toy for his birthday.", "a toy, not Itoi"],
].map(([id, text, note]) => ({ id: id!, set: "apply" as const, say: text!, intended: text!, lexicon: VOCAB, ...(note ? { note } : {}) }));

/** cases.jsonl fix cases with no vocabulary word in them, or no sensible audio version. */
const SKIP: Record<string, string> = {
  "f-fillers": "fillers only", "f-filler-commas": "fillers only", "f-stutter": "a doubled word", "f-stutter-the": "a doubled word",
  "f-self-correct-day": "a self-correction", "f-self-correct-time": "a self-correction", "n-lsat-off": "turned off: never a candidate",
};
/** What a speaker says where the expected text is not it. */
const SPOKEN: Record<string, string> = { "f-vocab-and-filler": "we should, uh, move to Kubernetes" };

function caseItems(): Item[] {
  return loadCases().flatMap((c) => c.kind !== "fix" || SKIP[c.id] ? [] : [{ id: c.id, set: "cases" as const, say: SPOKEN[c.id] ?? c.expect, intended: c.expect, lexicon: c.lexicon }]);
}

// ── Candidates ──────────────────────────────────────────────────────────────

interface Cand {
  span: string;
  at: number;
  written: string;
  type: string;
  /** Found by lingo.ts `recall` (else only by the looser sound match). */
  strict: boolean;
}

/** Whitespace words with their cores; a span may not cross punctuation. */
function words(text: string) {
  return [...text.matchAll(/\S+/g)].flatMap((m) => {
    const core = m[0].match(/[\p{L}\p{N}](?:.*[\p{L}\p{N}])?/u);
    if (!core) return [];
    const start = m.index! + core.index!;
    return [{ start, end: start + core[0].length, lead: core.index! > 0, trail: core.index! + core[0].length < m[0].length }];
  });
}

/** `recall`, plus every span of no more words than a written form that `soundsAlike` it, of a similar length
 *  (more words would swallow a neighbour: "in peel" for Peel). */
export function candidates(text: string, lexicon: Lexicon): Cand[] {
  const out: Cand[] = recall(text, lexicon).map((c) => ({ span: c.span, at: c.at, written: c.written, type: c.type, strict: true }));
  const ws = words(text);
  const forms = lexicon.entries.filter((e) => !e.dictationOff).flatMap((e) => e.written.map((w) => ({ w, type: e.type, n: w.split(/\s+/).length })));
  for (let i = 0; i < ws.length; i++) {
    for (let n = 1; n <= 3 && i + n <= ws.length; n++) {
      if (n > 1 && (ws[i + n - 2]!.trail || ws[i + n - 1]!.lead)) break;
      const span = text.slice(ws[i]!.start, ws[i + n - 1]!.end), ls = letters(span);
      if (ls.length < 2) continue;
      for (const f of forms) {
        const lw = letters(f.w);
        if (span === f.w || n > f.n || ls.length < 0.6 * lw.length || ls.length > 1.6 * lw.length) continue;
        if (out.some((c) => c.at === ws[i]!.start && c.span === span && c.written === f.w)) continue;
        if (soundsAlike(span, f.w)) out.push({ span, at: ws[i]!.start, written: f.w, type: f.type, strict: false });
      }
    }
  }
  return out;
}

const titleCase = (t: string) => t.replace(/\p{L}+/gu, (w) => w[0]!.toUpperCase() + w.slice(1));
const capitalised = (t: string) => t.replace(/\p{L}/u, (ch) => ch.toUpperCase());
const withName = (text: string, c: Cand) => applyEdits(text, [{ from: c.span, to: c.written, at: c.at }], false);
/** The text as typed, and with the span's own letters title-cased: casing alone is no evidence for the name. */
const asTyped = (text: string, c: Cand) => letters(c.span) !== letters(c.written) || c.span !== titleCase(c.span) ? [text, applyEdits(text, [{ from: c.span, to: titleCase(c.span), at: c.at }], false)] : [text];
const sameSound = (c: Cand) => !UPPER.test(c.span) && letters(c.span) !== letters(c.written) && soundKey(c.span) === soundKey(c.written);
const overlap = (x: Cand, y: Cand) => x.at < y.at + y.span.length && y.at < x.at + x.span.length;

/** Audio Δ for each candidate: fit with the name − the better fit as typed. */
async function audioDeltas(enc: Encoded, text: string, cs: Cand[]): Promise<number[]> {
  const memo = new Map<string, number>();
  const fit = async (t: string) => {
    if (!memo.has(t)) memo.set(t, (await enc.score(t)).at(1));
    return memo.get(t)!;
  };
  const out: number[] = [];
  for (const c of cs) {
    const base = Math.max(...(await Promise.all(asTyped(text, c).map(fit))));
    out.push((await fit(withName(text, c))) - base);
  }
  return out;
}

/** The text fixer's Δ for each candidate, as `rewrite` reads it (minus its margin: > 0 means it would rewrite). */
async function textDeltas(fixer: Fixer, text: string, cs: Cand[]): Promise<number[]> {
  if (!cs.length) return [];
  const sets = cs.map((c) => [withName(text, c), ...asTyped(text, c).slice(0, letters(c.span) !== letters(c.written) ? 2 : 1)].map((s) => ({ name: c.written, type: c.type, text: capitalised(s) })));
  const s = await fixer.score(sets.flat());
  let k = 0;
  return cs.map((c, i) => {
    const r = s.slice(k, (k += sets[i]!.length));
    return r[0]! - Math.max(...r.slice(1)) - (sameSound(c) ? SAME_SOUND_MARGIN : 0);
  });
}

/** Apply the chosen candidates, the best first where two overlap. */
function choose(text: string, cs: Cand[], score: number[], ok: (i: number) => boolean): string {
  const picked = cs.map((c, i) => ({ c, s: score[i]! })).filter((_, i) => ok(i)).sort((a, b) => b.s - a.s);
  const keep: Cand[] = [];
  for (const p of picked) if (!keep.some((k) => overlap(k, p.c))) keep.push(p.c);
  return keep.length ? applyEdits(text, keep.map((c) => ({ from: c.span, to: c.written, at: c.at })), false) : text;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const count = (text: string, w: string) => text.match(new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu"))?.length ?? 0;

/** Per vocabulary written form: needed = said − typed, gained = output − typed. */
function tallyOne(item: Item, typed: string, out: string) {
  let tp = 0, fp = 0, fn = 0;
  for (const w of item.lexicon.entries.filter((e) => !e.dictationOff).flatMap((e) => e.written)) {
    const have = count(typed, w), need = Math.max(0, count(item.intended, w) - have), gain = Math.max(0, count(out, w) - have);
    tp += Math.min(need, gain);
    fp += Math.max(0, gain - need);
    fn += Math.max(0, need - gain);
  }
  return { tp, fp, fn, exact: fp === 0 && fn === 0 };
}

// ── Run ─────────────────────────────────────────────────────────────────────

interface Row {
  item: Item;
  voice: string;
  model: string;
  typed: string;
  cs: Cand[];
  audio: number[];
  text: number[];
  today: string;
}

const norm = (s: string) => s.replace(/[’‘]/g, "'");
const get = (argv: string[], k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const pctl = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]! : NaN);
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

async function memory(mode: string, models: string, wavDir: string) {
  const wavs = await Promise.all(APPLY.slice(0, 4).map((i) => synth(wavDir, "Samantha", i.say)));
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const tick = () => (peak = Math.max(peak, process.memoryUsage().rss));
  const timer = setInterval(tick, 20);
  if (mode === "sherpa") {
    const stt = createStt({ dataDir: join(ROOT, ".models/audio-score/data"), modelDir: models, log: () => {} });
    for (const w of wavs) await stt.transcribe(readFileSync(w), { model: STT_MODELS[0] });
    tick();
    console.log(`sherpa Parakeet 0.6B: +${mb(process.memoryUsage().rss - rss0)} RSS after 4 transcriptions, peak +${mb(peak - rss0)}`);
    await stt.close();
  } else {
    const s = await tdtScorer(join(models, "stt/parakeet-tdt-en-0.6b-v2"), "tdt-0.6b");
    for (const w of wavs) {
      const e = await s.encode(readWav(w));
      const t = await e.decode!();
      if (mode === "onnx") for (const c of candidates(t, VOCAB)) await e.score(withName(t, c));
    }
    tick();
    console.log(`onnxruntime Parakeet 0.6B (${mode === "onnx" ? "transcribe + score" : "transcribe only"}): +${mb(process.memoryUsage().rss - rss0)} RSS after 4 clips, peak +${mb(peak - rss0)}`);
  }
  clearInterval(timer);
}

async function main() {
  const argv = process.argv.slice(2);
  const voices = (get(argv, "voices") ?? "Samantha,Daniel,Karen,Moira,Rishi").split(",");
  const models = get(argv, "models") ?? join(homedir(), "Library/Application Support/Peel/Strut/cache/strut/models");
  const fixerId = get(argv, "fixer") ?? "1.7b";
  const verbose = argv.includes("--verbose");
  const wavDir = join(ROOT, ".models/audio-score/wavs");
  mkdirSync(wavDir, { recursive: true });
  if (get(argv, "mem")) return memory(get(argv, "mem")!, models, wavDir);

  const items = [...APPLY, ...caseItems()];
  const cacheFile = join(ROOT, ".models/audio-score/stt-cache.json");
  const cache: Record<string, { text: string; ms: number }> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const stt = createStt({ dataDir: join(ROOT, ".models/audio-score/data"), modelDir: models, log: () => {} });
  const scorer = await tdtScorer(join(models, "stt/parakeet-tdt-en-0.6b-v2"), "tdt-0.6b");
  const entry = FIXER_MODELS.find((m) => m.id === `qwen3-${fixerId}-q4`)!;
  const fixers = new DictationFixer({ model: async () => ({ id: entry.id, path: join(ROOT, ".models/gguf", entry.file) }) });
  const fixer = (await fixers.current())!;
  await fixer.ready();
  await fixer.score([{ name: "Strut", type: "Project", text: "Hi there" }]);

  const rows: Row[] = [];
  const lat = { sherpa: [] as number[], encode: [] as number[], decode: [] as number[], score: [] as number[], perCand: [] as number[], cands: [] as number[], strictCands: [] as number[], fixer: [] as number[], seconds: [] as number[] };
  let sameAsSherpa = 0, decoded = 0;
  for (const voice of voices) {
    for (const item of items) {
      const wav = await synth(wavDir, voice, item.say);
      const samples = readWav(wav);
      const enc = await scorer.encode(samples);
      lat.encode.push(enc.encodeMs);
      lat.seconds.push(samples.length / 16000);
      const t0 = performance.now();
      const own = await enc.decode!();
      lat.decode.push(performance.now() - t0);
      for (const model of STT_MODELS) {
        const key = `${model}|${wav}`;
        if (!cache[key]) {
          const r = await stt.transcribe(readFileSync(wav), { model });
          cache[key] = { text: r.text, ms: r.durationMs };
        }
        const typed = norm(cache[key]!.text);
        if (model === STT_MODELS[0]) {
          lat.sherpa.push(cache[key]!.ms);
          decoded++;
          if (norm(own) === typed) sameAsSherpa++;
          else if (verbose) console.log(`  decode differs: sherpa "${typed}" onnx "${own}"`);
        }
        const cs = candidates(typed, item.lexicon);
        const t1 = performance.now();
        const audio = await audioDeltas(enc, typed, cs);
        if (model === STT_MODELS[0]) {
          lat.score.push(performance.now() - t1);
          if (cs.length) lat.perCand.push((performance.now() - t1) / cs.length);
          lat.cands.push(cs.length);
          lat.strictCands.push(cs.filter((c) => c.strict).length);
        }
        const text = await textDeltas(fixer, typed, cs);
        const t2 = performance.now();
        const today = (await rewrite(typed, item.lexicon, fixer)).text;
        lat.fixer.push(performance.now() - t2);
        rows.push({ item, voice, model, typed, cs, audio, text, today });
        if (verbose) console.log(`${model.slice(0, 8)} ${voice} ${item.id}: "${typed}" ${cs.map((c, i) => `[${c.span}→${c.written}${c.strict ? "" : "*"} a${audio[i]!.toFixed(1)} t${text[i]!.toFixed(1)}]`).join(" ")} today "${today}"`);
      }
    }
  }
  writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  await stt.close();
  await fixers.close();

  // ── Policies ──
  type Policy = [string, (r: Row) => string];
  const audioAt = (th: number, strictOnly = false): Policy[1] => (r) => choose(r.typed, r.cs, r.audio, (i) => r.audio[i]! >= th && (!strictOnly || r.cs[i]!.strict));
  /** Audio, and for a span typed as an everyday word (no capital), today's text test as well. */
  const hybrid = (th: number, strictOnly = false): Policy[1] => (r) => choose(r.typed, r.cs, r.audio, (i) => r.audio[i]! >= th && (!strictOnly || r.cs[i]!.strict) && (UPPER.test(r.cs[i]!.span) || r.text[i]! > 0));
  /** Today's text decision on recall's candidates, vetoed by the audio. */
  const veto = (th: number, loose = false): Policy[1] => (r) => choose(r.typed, r.cs, r.text, (i) => (loose || r.cs[i]!.strict) && r.text[i]! > 0 && r.audio[i]! >= th);
  const policies: Policy[] = [
    [`text only: today's rewrite, ${entry.id}`, (r) => r.today],
    ...[-4, -2, 0, 2].map((th): Policy => [`audio only, Δ ≥ ${th}`, audioAt(th)]),
    ...[-4, -2, 0, 2].map((th): Policy => [`audio Δ ≥ ${th}, text test on lower-case spans`, hybrid(th)]),
    [`audio Δ ≥ 0, text test on lower-case spans, recall only`, hybrid(0, true)],
    ...[-16, -12, -10, -8, -4, 0].map((th): Policy => [`today's text test, audio veto Δ < ${th}`, veto(th)]),
    [`text test on the looser candidates too, no audio`, veto(-Infinity, true)],
    ...[-12, -8].map((th): Policy => [`text test on the looser candidates too, audio veto Δ < ${th}`, veto(th, true)]),
  ];
  const sets: [string, (r: Row) => boolean][] = [["apply (14 sentences)", (r) => r.item.set === "apply"], ["cases.jsonl fix", (r) => r.item.set === "cases"], ["all", () => true]];
  for (const model of STT_MODELS) {
    for (const [setName, inSet] of sets) {
      const rs = rows.filter((r) => r.model === model && inSet(r));
      console.log(`\n## ${model} transcripts, ${setName}: ${rs.length} clips (${voices.length} voices)\n`);
      console.log("| policy | precision | recall | exact | tp | fp | fn |");
      console.log("|---|---|---|---|---|---|---|");
      for (const [name, f] of policies) {
        let tp = 0, fp = 0, fn = 0, exact = 0;
        for (const r of rs) {
          const t = tallyOne(r.item, r.typed, f(r));
          tp += t.tp; fp += t.fp; fn += t.fn; exact += t.exact ? 1 : 0;
        }
        console.log(`| ${name} | ${(tp / Math.max(1, tp + fp)).toFixed(2)} | ${(tp / Math.max(1, tp + fn)).toFixed(2)} | ${(exact / rs.length).toFixed(2)} | ${tp} | ${fp} | ${fn} |`);
      }
    }
  }
  // Where the recommended shape (looser candidates, text test, audio veto at -12) and today's rewrite differ in outcome.
  console.log("\n## where looser candidates + text test + audio veto -12 and today's rewrite differ\n");
  for (const r of rows) {
    const a = tallyOne(r.item, r.typed, r.today), out = veto(-12, true)(r), b = tallyOne(r.item, r.typed, out);
    if (a.exact !== b.exact) console.log(`- ${b.exact ? "fixed" : "broke"} ${r.model.slice(0, 8)} ${r.voice} ${r.item.id}: typed "${r.typed}" today "${r.today}" new "${out}"`);
  }
  // Per item on the apply set: what each model typed, and the best candidate's Δ.
  console.log("\n## apply set, per item (median over voices of the best candidate for the item's names)\n");
  for (const item of items) {
    const rs = rows.filter((r) => r.item === item);
    const line = STT_MODELS.map((m) => {
      const mine = rs.filter((r) => r.model === m);
      const typed = [...new Set(mine.map((r) => r.typed))].join(" | ");
      // The candidates for a name the speaker said and the transcript lacks; for a negative, all of them.
      const rel = (r: Row) => r.cs.map((c, i) => i).filter((i) => item.lexicon.entries.length && (count(item.intended, r.cs[i]!.written) > count(r.typed, r.cs[i]!.written) || !r.cs.some((c) => count(item.intended, c.written) > count(r.typed, c.written))));
      const best = mine.map((r) => Math.max(-99, ...rel(r).map((i) => r.audio[i]!))).sort((a, b) => a - b);
      const bestText = mine.map((r) => Math.max(-99, ...rel(r).map((i) => r.text[i]!))).sort((a, b) => a - b);
      const exact = mine.filter((r) => tallyOne(r.item, r.typed, veto(-8)(r)).exact).length, today = mine.filter((r) => tallyOne(r.item, r.typed, r.today).exact).length;
      return `${m.slice(0, 8)}: typed {${typed}}; best audio Δ ${best.map((x) => x.toFixed(1)).join(",")}; best text Δ ${bestText.map((x) => x.toFixed(1)).join(",")}; exact: today ${today}/${mine.length}, veto@-8 ${exact}/${mine.length}`;
    });
    if (item.set === "apply" || verbose) console.log(`- ${item.id} "${item.say}"\n  ${line.join("\n  ")}`);
  }
  const ms = (xs: number[]) => `p50 ${Math.round(pctl(xs, 0.5))} p95 ${Math.round(pctl(xs, 0.95))} ms`;
  console.log(`\n## latency (Parakeet transcripts; clips p50 ${pctl(lat.seconds, 0.5).toFixed(1)} s, max ${pctl(lat.seconds, 1).toFixed(1)} s)\n`);
  console.log(`sherpa transcribe ${ms(lat.sherpa)}; onnx encode ${ms(lat.encode)}; onnx greedy decode from that encode ${ms(lat.decode)} (same text as sherpa ${sameAsSherpa}/${decoded})`);
  console.log(`candidates per clip p50 ${pctl(lat.cands, 0.5)} p95 ${pctl(lat.cands, 0.95)} max ${pctl(lat.cands, 1)} (recall only p50 ${pctl(lat.strictCands, 0.5)} max ${pctl(lat.strictCands, 1)}); scoring all candidates ${ms(lat.score)}, per candidate ${ms(lat.perCand)}`);
  console.log(`today's rewrite (${entry.id}) ${ms(lat.fixer)}`);
  console.log(`process RSS at end ${mb(process.memoryUsage().rss)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
