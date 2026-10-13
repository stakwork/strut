// Recall and duplicate-matching benchmark for the memory/* steps:
// `npm run bench:memory [-- --out file.md] [-- --verbose]`.
//
// Seeds a temp LadybugDB through the real memory/remember (and merge) with
// bench-memory.json, runs every labelled query through memory/recall, and
// probes remember's entity matching with near-duplicate names. The
// `heldout` queries were written after the matcher was tuned and are never
// tuned against: they are reported on their own. Lives in scripts/, outside
// the build.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../src/core.js";
import forget from "../src/steps/lib/memory/forget.js";
import merge from "../src/steps/lib/memory/merge.js";
import recall from "../src/steps/lib/memory/recall.js";
import remember from "../src/steps/lib/memory/remember.js";

type FactRow = [id: string, subject: string, predicate: string, object: string | null, text: string, supersede?: boolean];
type Episode = { t: string; f: FactRow[] };
type Q = { kind: string; q: string; type?: string; expect: string[]; not?: string[] };
type Fixture = {
  episodes: Episode[];
  merges: [keep: string, duplicate: string][];
  queries: Q[];
  heldout: { episodes: Episode[]; queries: Q[] };
  /** `auto: false`: the right entity may be listed as similar, but matching it automatically counts as a false positive. */
  dedupe: { seed: string[]; probes: { probe: string; match: string | null; auto?: false }[] };
};
type Step = { input: { parse(v: unknown): any }; run(cfg: any, ctx: StepContext): Promise<any> };

const ref = (s: string) => {
  const i = s.indexOf(":");
  return { type: s.slice(0, i), name: s.slice(i + 1) };
};
const call = (step: unknown, input: unknown, ctx: StepContext) => (step as Step).run((step as Step).input.parse(input), ctx);
const ctxFor = (db: string) =>
  ({ runId: "bench", path: "bench", scope: {}, input: undefined, emit: async () => {},
     services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? db : undefined) } } }) as unknown as StepContext;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Scores = {
  byKind: Record<string, { n: number; r1: number; r5: number; mrr: number }>;
  overall: { n: number; r1: number; r5: number; mrr: number; noise5: number };
  negatives: { n: number; withHits: number };
  notViolations: number;
  latency: { p50: number; p95: number };
  misses: string[];
};
type PR = { tp: number; fp: number; positives: number; precision: number; recall: number };
export type BenchResult = { main: Scores; heldout: Scores; dedupe: { auto: PR; candidates: PR; p50: number; misses: string[] } };

async function score(queries: Q[], ctx: StepContext, idOf: Map<string, string>, labelOf: Map<string, string>): Promise<Scores> {
  const byKind: Scores["byKind"] = {};
  const positives: { r1: number; r5: number; mrr: number; noise5: number }[] = [];
  const times: number[] = [];
  const misses: string[] = [];
  let negN = 0, negHits = 0, notViolations = 0;
  for (const q of queries) {
    // A label with no node: remember merged it into another entity (a matching bug), so it can never be found.
    for (const l of [...q.expect, ...(q.not ?? [])]) if (!idOf.has(l)) misses.push(`[seed] ${q.q}: ${l} was merged into another entity`);
    const t0 = performance.now();
    const hits: { ref_id: string }[] = await call(recall, { q: q.q, ...(q.type ? { type: q.type } : {}), limit: 10 }, ctx);
    times.push(performance.now() - t0);
    const got = hits.map((h) => labelOf.get(h.ref_id) ?? h.ref_id);
    const top5 = got.slice(0, 5);
    if ((q.not ?? []).some((l) => top5.includes(l))) {
      notViolations++;
      misses.push(`[${q.kind} must-not] ${q.q} → ${top5.join(", ")}`);
    }
    if (!q.expect.length) {
      negN++;
      if (got.length) {
        negHits++;
        misses.push(`[${q.kind}] ${q.q} → ${got.slice(0, 3).join(", ")}`);
      }
      continue;
    }
    const want = new Set(q.expect);
    const at = (k: number) => got.slice(0, k).filter((l) => want.has(l)).length / Math.min(want.size, k);
    const first = got.findIndex((l) => want.has(l));
    const m = { r1: at(1), r5: at(5), mrr: first < 0 ? 0 : 1 / (first + 1), noise5: top5.filter((l) => !want.has(l)).length };
    positives.push(m);
    const k = (byKind[q.kind] ??= { n: 0, r1: 0, r5: 0, mrr: 0 });
    k.n++; k.r1 += m.r1; k.r5 += m.r5; k.mrr += m.mrr;
    if (m.r5 < 1 || m.r1 < 1) misses.push(`[${q.kind}${m.r5 < 1 ? "" : " @1"}] ${q.q} → want ${q.expect.join(", ")}; got ${top5.join(", ") || "nothing"}`);
  }
  for (const k of Object.values(byKind)) { k.r1 /= k.n; k.r5 /= k.n; k.mrr /= k.n; }
  return {
    byKind,
    overall: { n: positives.length, r1: mean(positives.map((m) => m.r1)), r5: mean(positives.map((m) => m.r5)), mrr: mean(positives.map((m) => m.mrr)), noise5: mean(positives.map((m) => m.noise5)) },
    negatives: { n: negN, withHits: negHits },
    notViolations,
    latency: { p50: pct(times, 50), p95: pct(times, 95) },
    misses,
  };
}

export async function runBench(fixture: Fixture): Promise<BenchResult> {
  const dir = mkdtempSync(join(tmpdir(), "strut-memory-bench-"));
  try {
    const ctx = ctxFor(join(dir, "recall", "graph.lbug"));
    const labelOf = new Map<string, string>();
    const idOf = new Map<string, string>();
    for (const ep of [...fixture.episodes, ...fixture.heldout.episodes]) {
      const out = await call(remember, {
        episode: ep.t,
        facts: ep.f.map(([, s, p, o, text, supersede]) => ({ subject: ref(s), predicate: p, text, ...(o ? { object: ref(o) } : {}), supersede: !!supersede })),
      }, ctx);
      if (out.error) throw new Error(`seed failed on ${JSON.stringify(ep.t)}: ${out.error}`);
      for (const e of out.entities) {
        const label = `e:${e.type}:${e.type === "Self" ? "Me" : e.name}`;
        idOf.set(label, e.ref_id);
        if (!labelOf.has(e.ref_id)) labelOf.set(e.ref_id, label);
      }
      ep.f.forEach(([id], i) => {
        idOf.set(`f:${id}`, out.facts[i].ref_id);
        labelOf.set(out.facts[i].ref_id, `f:${id}`);
      });
    }
    for (const [keep, dup] of fixture.merges) {
      const out = await call(merge, { keep: idOf.get(`e:${keep}`), duplicate: idOf.get(`e:${dup}`) }, ctx);
      if (out.error) throw new Error(`merge failed: ${out.error}`);
    }
    const main = await score(fixture.queries, ctx, idOf, labelOf);
    const heldout = await score(fixture.heldout.queries, ctx, idOf, labelOf);

    // Duplicate matching: a fresh graph of seed entities; each probe is
    // remembered, judged, and forgotten again so it never matches a later one.
    const dctx = ctxFor(join(dir, "dedupe", "graph.lbug"));
    const seedId = new Map<string, string>();
    for (const s of fixture.dedupe.seed) {
      seedId.set(s, (await call(remember, { episode: `seed ${s}`, mentions: [ref(s)] }, dctx)).entities[0].ref_id);
    }
    const auto = { tp: 0, fp: 0, positives: 0 }, cand = { tp: 0, fp: 0, positives: 0 };
    const dtimes: number[] = [];
    const misses: string[] = [];
    for (const [s, id] of seedId) {
      const first = [...seedId].find(([, v]) => v === id)![0];
      if (first !== s) misses.push(`[dedupe] seed ${s} matched ${first}: two entities became one`);
    }
    const label = (id: string) => [...seedId].find(([, v]) => v === id)?.[0] ?? id;
    for (const p of fixture.dedupe.probes) {
      const t0 = performance.now();
      const out = await call(remember, { episode: `probe ${p.probe}`, mentions: [ref(p.probe)] }, dctx);
      dtimes.push(performance.now() - t0);
      const e = out.entities[0];
      const target = p.match ? seedId.get(p.match) : undefined;
      if (p.match && !target) throw new Error(`dedupe: unknown seed ${p.match}`);
      const matched = e.status === "matched" ? e.ref_id : undefined;
      const candidates = new Set<string>([...(matched ? [matched] : []), ...(e.similar ?? []).map((s: { ref_id: string }) => s.ref_id)]);
      if (target) {
        cand.positives++;
        if (p.auto !== false) auto.positives++;
      }
      if (matched) matched === target && p.auto !== false ? auto.tp++ : auto.fp++;
      if (target && candidates.has(target)) cand.tp++;
      if ([...candidates].some((id) => id !== target)) cand.fp++;
      const ok = (target ? candidates.has(target) && ![...candidates].some((id) => id !== target) : candidates.size === 0)
        && !(matched && p.auto === false);
      if (!ok) misses.push(`[dedupe] ${p.probe} (want ${p.match ?? "none"}${p.auto === false ? ", not automatic" : ""}) → ${matched ? `matched ${label(matched)}` : "created"}${(e.similar ?? []).length ? `, similar ${e.similar.map((s: any) => label(s.ref_id)).join(", ")}` : ""}`);
      if (e.status === "created") await call(forget, { ref_id: e.ref_id, reason: "bench probe" }, dctx);
    }
    const pr = (x: { tp: number; fp: number; positives: number }): PR =>
      ({ ...x, precision: x.tp + x.fp ? x.tp / (x.tp + x.fp) : 1, recall: x.positives ? x.tp / x.positives : 1 });
    return { main, heldout, dedupe: { auto: pr(auto), candidates: pr(cand), p50: pct(dtimes, 50), misses } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const f = (x: number) => x.toFixed(3);
function scoresTable(title: string, r: Scores): string[] {
  return [
    `| ${title} | n | recall@1 | recall@5 | MRR |`,
    "|---|---:|---:|---:|---:|",
    ...Object.entries(r.byKind).map(([k, v]) => `| ${k} | ${v.n} | ${f(v.r1)} | ${f(v.r5)} | ${f(v.mrr)} |`),
    `| **all positive** | ${r.overall.n} | **${f(r.overall.r1)}** | **${f(r.overall.r5)}** | **${f(r.overall.mrr)}** |`,
    `| negatives with any hit | ${r.negatives.withHits}/${r.negatives.n} | | | |`,
    `| must-not hit in top 5 | ${r.notViolations} | | | |`,
    `| non-relevant in top 5, mean | ${r.overall.noise5.toFixed(2)} | | | |`,
    `| latency p50 / p95 (ms) | ${r.latency.p50.toFixed(1)} / ${r.latency.p95.toFixed(1)} | | | |`,
  ];
}

export function table(r: BenchResult): string {
  const d = r.dedupe;
  return [
    ...scoresTable("main queries", r.main),
    "",
    ...scoresTable("held-out queries", r.heldout),
    "",
    "| dedupe | value |",
    "|---|---:|",
    `| auto-match precision / recall | ${f(d.auto.precision)} / ${f(d.auto.recall)} (${d.auto.tp} tp, ${d.auto.fp} fp of ${d.auto.positives}) |`,
    `| matched-or-similar precision / recall | ${f(d.candidates.precision)} / ${f(d.candidates.recall)} (${d.candidates.tp} tp, ${d.candidates.fp} fp of ${d.candidates.positives}) |`,
    `| remember p50, one mention (ms) | ${d.p50.toFixed(1)} |`,
  ].join("\n");
}

const args = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(new URL("./bench-memory.json", import.meta.url), "utf8")) as Fixture;
const r = await runBench(fixture);
const md = table(r);
const misses = [...r.main.misses, ...r.heldout.misses.map((m) => `(held-out) ${m}`), ...r.dedupe.misses];
console.log(md);
if (args.includes("--verbose")) console.log(`\n${misses.join("\n")}`);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
if (out) writeFileSync(out, `${md}\n\n### Misses\n\n${misses.map((m) => `- ${m}`).join("\n")}\n`);
if (args.includes("--json")) console.log(JSON.stringify(r));
process.exit(0);
