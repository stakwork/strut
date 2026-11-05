/**
 * Benchmark of GET /proposals?status=pending's engine (plans/proposals-index-perf.md).
 *   tsx scripts/bench-proposals.ts --mode old|new [--files 20000] [--kb 20] [--callers 200] [--rounds 1] [--dir <existing data dir, used as is; else a temp one is generated>] [--gen-only]
 * `old` is the pre-index implementation (readdir + read every file, filter);
 * `new` is the index + single-flight/cache path the route runs. One cold
 * process per run: the numbers include the first call (the index build).
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProposals, proposalsRoot, type Proposal } from "../src/proposals.js";
import { proposalIndex } from "../src/proposals-index.js";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const has = (n: string) => process.argv.includes(`--${n}`);
const mode = arg("mode", "new");
const files = Number(arg("files", "20000"));
const kb = Number(arg("kb", "20"));
const callers = Number(arg("callers", "200"));
const rounds = Number(arg("rounds", "1"));

export async function makeDir(root: string, n: number, kb: number): Promise<void> {
  await mkdir(root, { recursive: true });
  const blob = "x".repeat(kb * 1024);
  const base = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < n; i += 500) {
    await Promise.all(
      Array.from({ length: Math.min(500, n - i) }, (_, j) => {
        const k = i + j;
        const pending = k % 400 === 0;
        const p: Proposal = {
          id: `p${String(k).padStart(10, "0")}`,
          step: "dev/write",
          input: { blob, k },
          title: "Write a thing",
          status: pending ? "pending" : k % 3 ? "applied" : "rejected",
          createdAt: new Date(base + k * 1000).toISOString(),
          by: { workflow: "wf", runId: `r${k % 50}`, path: "wf/a", job: `j${k % 10}`, actor: "ann" },
          ...(pending ? {} : { decision: { action: "accept" as const, at: new Date(base + k * 1000 + 5).toISOString(), input: { blob } }, result: { output: { ok: true }, at: new Date(base + k * 1000 + 9).toISOString() } }),
        };
        return writeFile(join(root, `${p.id}.json`), JSON.stringify(p, null, 2));
      }),
    );
  }
}

/** The implementation this replaces, verbatim in effect. */
async function oldList(root: string): Promise<Proposal[]> {
  const names = (await readdir(root)).filter((n) => n.endsWith(".json"));
  const out: Proposal[] = [];
  for (const n of names) {
    try {
      const p = JSON.parse(await readFile(join(root, n), "utf-8")) as Proposal;
      if (p.status === "pending") out.push(p);
    } catch {}
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const pct = (xs: number[], q: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
const mb = (n: number) => (n / 1048576).toFixed(0);

async function main() {
  const reuse = arg("dir", "");
  const dataDir = reuse || (await mkdtemp(join(tmpdir(), "bench-proposals-")));
  const root = proposalsRoot(dataDir);
  if (!(await readdir(root).catch(() => [])).length) {
    const t = Date.now();
    await makeDir(root, files, kb);
    console.log(`generated ${files} files x ~${kb}KB in ${Date.now() - t} ms`);
  }
  if (has("gen-only")) return;
  let peakRss = 0;
  let peakHeap = 0;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  }, 20);
  const lat: number[] = [];
  const call = async () => {
    const t = performance.now();
    if (mode === "old") await oldList(root);
    else {
      const body = await proposalIndex(root).memo("k", async () => JSON.stringify({ proposals: await listProposals(root, { status: "pending" }) }));
      if (!body.length) throw new Error("empty");
    }
    lat.push(performance.now() - t);
  };
  const t0 = Date.now();
  for (let r = 0; r < rounds; r++) await Promise.all(Array.from({ length: callers }, call));
  const wall = Date.now() - t0;
  clearInterval(sampler);
  console.log(
    `mode=${mode} files=${files} callers=${callers} rounds=${rounds} | p50=${pct(lat, 0.5).toFixed(0)}ms p99=${pct(lat, 0.99).toFixed(0)}ms max=${Math.max(...lat).toFixed(0)}ms wall=${wall}ms | peakRSS=${mb(peakRss)}MB peakHeap=${mb(peakHeap)}MB`,
  );
  if (!reuse) await rm(dataDir, { recursive: true, force: true });
}
if (process.argv[1]?.endsWith("bench-proposals.ts")) await main();
