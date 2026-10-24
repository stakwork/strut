/**
 * Dictation's eval (plans/dictation-models.md): cases.jsonl run through the
 * real pipeline — lingo.ts `mishearings` (learn) and `rewrite` (fix), with
 * the 1.5 s fallback to `heardOnly` as /audio/transcribe has it — on the
 * real fixer: fixer.ts's `DictationFixer`, the model in its ModelWorker.
 * Reports precision, recall, exact-match rate, p50/p95 latency, load time
 * and how many transcripts fell back on time.
 *
 *   npm run eval:dictation                          # 1.7b, 0.6b and none (exact mishearings only)
 *   npm run eval:dictation -- --model 0.6b [--task fix] [--only f-stutter] [--verbose]
 *
 * Opt-in and not part of `npm test`: it needs the GGUFs in ./.models/gguf
 * (gitignored; Qwen3-{0.6B,1.7B}-Q4_K_M.gguf, the files models.ts
 * FIXER_MODELS downloads), or `--dir` naming another folder that holds them,
 * and node-llama-cpp in fixer/ (`yarn --cwd fixer install --frozen-lockfile
 * --ignore-scripts`; strut's own dependencies do not have it).
 * Node must load .ts in a worker thread: Node 22.18+ (or 22.6+ with
 * NODE_OPTIONS=--experimental-transform-types).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DictationFixer, FIX_TIMEOUT_MS, within } from "../fixer.js";
import { heardOnly, hunks, letters, mishearings, rewrite, type Fixer, type Hunk, type Lexicon, type Mishearing } from "../lingo.js";
import { FIXER_MODELS } from "../models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");

// ── Cases ───────────────────────────────────────────────────────────────────

interface LearnCase {
  kind: "learn";
  id: string;
  lexicon: Lexicon;
  typed: string;
  edited: string;
  expect: Mishearing[];
}
interface FixCase {
  kind: "fix";
  id: string;
  lexicon: Lexicon;
  transcript: string;
  expect: string;
}
type Case = LearnCase | FixCase;

/** cases.jsonl: lexicon rows (entries as names, written forms, heard values, off), then cases naming one. */
export function loadCases(): Case[] {
  const lexicons = new Map<string, Lexicon>();
  const cases: Case[] = [];
  for (const line of readFileSync(join(HERE, "cases.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.kind === "lexicon") {
      lexicons.set(row.id, {
        entries: row.entries.map((e: any, i: number) => ({
          refId: `${row.id}-${i}`,
          type: e.type ?? "Lingo",
          name: e.name,
          written: e.written ?? [e.name],
          heard: (e.heard ?? []).map((h: any, j: number) => (typeof h === "string"
            ? { refId: `${row.id}-${i}-${j}`, value: h, form: null }
            : { refId: `${row.id}-${i}-${j}`, value: h.value, form: h.form ?? null })),
          dictationOff: e.off === true,
          facts: (e.heard ?? []).length,
        })),
        undone: row.undone ?? [],
      });
    } else {
      const lexicon = lexicons.get(row.lexicon);
      if (!lexicon) throw new Error(`${row.id}: no lexicon ${row.lexicon}`);
      cases.push({ ...row, lexicon });
    }
  }
  return cases;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const pairKey = (p: Mishearing) => `${letters(p.heard) && p.heard.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim()}→${p.written.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")}${p.term ? " (term)" : ""}`;
/** Fix is scored on word changes, punctuation aside: the expected text's changes from the transcript against the output's. */
const changeKey = (h: Hunk) => `${h.a[0]}-${h.a[1]}:${h.to}`;

interface Tally {
  tp: number;
  fp: number;
  fn: number;
  exact: number;
  n: number;
  ms: number[];
  fellBack: number;
  wrong: string[];
}
const tally = (): Tally => ({ tp: 0, fp: 0, fn: 0, exact: 0, n: 0, ms: [], fellBack: 0, wrong: [] });

function count(t: Tally, got: Set<string>, want: Set<string>): boolean {
  const tp = [...got].filter((k) => want.has(k)).length;
  t.tp += tp;
  t.fp += got.size - tp;
  t.fn += want.size - tp;
  t.n++;
  const exact = tp === got.size && tp === want.size;
  if (exact) t.exact++;
  return exact;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

// ── One model ───────────────────────────────────────────────────────────────

interface Args {
  models: string[];
  task: "learn" | "fix" | "all";
  only?: string;
  verbose: boolean;
  dir: string;
}

/** `null`: no fixer — exact learned mishearings only, nothing learned. */
async function runOne(model: string | null, a: Args) {
  const cases = loadCases().filter((c) => (a.task === "all" || c.kind === a.task) && (!a.only || c.id === a.only));
  const entry = model ? FIXER_MODELS.find((m) => m.id === model || m.id === `qwen3-${model}-q4`) : undefined;
  if (model && !entry) throw new Error(`unknown fixer ${model} (known: ${FIXER_MODELS.map((m) => m.id).join(", ")})`);
  const fixers = entry ? new DictationFixer({ model: async () => ({ id: entry.id, path: join(a.dir, entry.file) }) }) : null;
  let fixer: Fixer | null = null;
  let loadMs = 0;
  if (fixers) {
    const f = (await fixers.current())!;
    const t0 = performance.now();
    await f.ready();
    loadMs = performance.now() - t0;
    // Warm each task once: first-call allocations, and each prompt's cached prefix.
    await f.judge([{ typed: "hi", edited: "Hi", from: "hi", to: "Hi", at: 0, known: "" }]);
    await f.named([{ text: "Hi there", word: "Hi" }]);
    await f.everyday(["hi"]);
    await f.score([{ name: "Strut", type: "Project", text: "Hi there" }]);
    await f.retract("hi, no, hello");
    fixer = f;
  }
  const learn = tally(), fix = tally();
  try {
    for (const c of cases) {
      const s = performance.now();
      if (c.kind === "learn") {
        const pairs = fixer ? ((await within(mishearings(c.typed, c.edited, c.lexicon, fixer), FIX_TIMEOUT_MS)) ?? null) : [];
        learn.ms.push(performance.now() - s);
        if (pairs === null) learn.fellBack++;
        const exact = count(learn, new Set((pairs ?? []).map(pairKey)), new Set(c.expect.map(pairKey)));
        if (!exact) learn.wrong.push(`${c.id}: got ${JSON.stringify(pairs)} want ${JSON.stringify(c.expect)}`);
        if (a.verbose) console.log(`${exact ? "ok  " : "FAIL"} ${c.id} ${Math.round(learn.ms.at(-1)!)}ms ${JSON.stringify(pairs)}`);
      } else {
        let out = fixer ? await within(rewrite(c.transcript, c.lexicon, fixer), FIX_TIMEOUT_MS) : undefined;
        if (fixer && !out) fix.fellBack++;
        out ??= heardOnly(c.transcript, c.lexicon);
        fix.ms.push(performance.now() - s);
        const exact = count(fix, new Set(hunks(c.transcript, out.text).map(changeKey)), new Set(hunks(c.transcript, c.expect).map(changeKey)));
        if (!exact) fix.wrong.push(`${c.id}: "${out.text}" want "${c.expect}"`);
        if (a.verbose) console.log(`${exact ? "ok  " : "FAIL"} ${c.id} ${Math.round(fix.ms.at(-1)!)}ms ⇒ ${out.text}`);
      }
    }
  } finally {
    await fixers?.close();
  }
  const summarize = (t: Tally) => t.n === 0 ? null : ({
    n: t.n,
    precision: t.tp + t.fp ? t.tp / (t.tp + t.fp) : 1,
    recall: t.tp + t.fn ? t.tp / (t.tp + t.fn) : 1,
    exact: t.exact / t.n,
    p50: Math.round(pct(t.ms, 50)),
    p95: Math.round(pct(t.ms, 95)),
    fellBack: t.fellBack,
    wrong: t.wrong,
  });
  return { model: entry?.id ?? "none", loadMs: Math.round(loadMs), learn: summarize(learn), fix: summarize(fix) };
}

type Result = Awaited<ReturnType<typeof runOne>>;

function table(results: Result[]): string {
  const rows = ["| fixer | task | n | precision | recall | exact | p50 ms | p95 ms | fell back | load s |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of results) {
    for (const task of ["learn", "fix"] as const) {
      const t = r[task];
      if (!t) continue;
      rows.push(`| ${r.model} | ${task} | ${t.n} | ${t.precision.toFixed(2)} | ${t.recall.toFixed(2)} | ${t.exact.toFixed(2)} | ${t.p50} | ${t.p95} | ${t.fellBack} | ${(r.loadMs / 1000).toFixed(1)} |`);
    }
  }
  return rows.join("\n");
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const model = get("model");
  return {
    models: model ? [model] : ["1.7b", "0.6b", "none"],
    task: (get("task") ?? "all") as Args["task"],
    only: get("only"),
    verbose: argv.includes("--verbose"),
    dir: get("dir") ?? join(ROOT, ".models/gguf"),
  };
}

// Run only as a script: audio-score.ts imports loadCases.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const results: Result[] = [];
  for (const m of args.models) results.push(await runOne(m === "none" ? null : m, args));
  console.log(table(results));
  for (const r of results) for (const task of ["learn", "fix"] as const) for (const w of r[task]?.wrong ?? []) console.log(`  ${r.model} ${task} ✗ ${w}`);
}
