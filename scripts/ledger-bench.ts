/**
 * The ledger's benchmark (plans/paid-runs.md §5, "Measured"): paid runs
 * against a fresh ledger file, each a hold and a charge — two transactions
 * of the shape the plan measured (a guarded update, an entry, a rollup
 * upsert) — then the earnings reads and a token's newest 50 entries.
 * Opt-in, never part of `npm test`:
 *
 *   npx tsx scripts/ledger-bench.ts [--runs 500000] [--tokens 20000] [--subjects 50] [--keep]
 *
 * The file is made in the OS temp dir and removed unless `--keep`.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openLedger, ledgerPath, priceOf, reserveFor, usdToMicros, dayOf } from "../src/payments/ledger.js";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "500000" },
    tokens: { type: "string", default: "20000" },
    subjects: { type: "string", default: "50" },
    keep: { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
const tokens = Number(values.tokens);
const subjects = Number(values.subjects);

const dir = mkdtempSync(join(tmpdir(), "strut-ledger-bench-"));
const ledger = await openLedger({ dataDir: dir });
const price = priceOf({ base: 0.01, markup: 1.5 });
const reserve = reserveFor(price, usdToMicros(1));
const start = Date.parse("2026-01-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let t = performance.now();
for (let i = 0; i < tokens; i++) {
  await ledger.firstUse({
    id: `tok${i}`,
    paymentHash: `hash${i}`,
    askedMsat: 10_000_000,
    settledMsat: 10_000_000,
    credit: usdToMicros(1_000),
    rate: 73_176,
    expires: start + 400 * DAY,
    at: start,
  });
}
const buyMs = performance.now() - t;
console.log(`${tokens} first uses (synchronous=full): ${((buyMs * 1000) / tokens).toFixed(1)} µs each`);

t = performance.now();
for (let i = 0; i < runs; i++) {
  const token = `tok${i % tokens}`;
  const subject = `workflow:acme/pkg${i % 5}/item${i % subjects}`;
  const at = start + Math.floor((i / runs) * 365) * DAY;
  const runId = `r${i}`;
  await ledger.hold({ token, reserve, subject, runId, at });
  await ledger.charge({ token, runId, subject, cost: (i * 7919) % 900_000, outcome: i % 20 ? "success" : "error", price, at });
}
const runMs = performance.now() - t;
console.log(`${runs} paid runs = ${runs * 2} transactions: ${((runMs * 1000) / (runs * 2)).toFixed(1)} µs per transaction`);

const time = async (label: string, fn: () => Promise<unknown>) => {
  await fn();
  const n = 20;
  const s = performance.now();
  for (let i = 0; i < n; i++) await fn();
  console.log(`${label}: ${((performance.now() - s) / n).toFixed(3)} ms`);
};
await time("earnings by item", () => ledger.earnings({ by: "item" }));
await time("earnings by day", () => ledger.earnings({ by: "day" }));
await time("earnings by package", () => ledger.earnings({ by: "package" }));
await time("earnings in total", () => ledger.earnings({ by: "total" }));
await time("received by day", () => ledger.received());
await time("a token's newest 50 entries", () => ledger.entries("tok7"));
await time("recent (30 days)", () => ledger.recent("workflow:acme/pkg0/item0", { now: start + 364 * DAY }));
await time("today", () => ledger.today("workflow:acme/pkg0/item0", { now: start + 364 * DAY }));
await time("open holds", () => ledger.openHolds());
await time("outstanding", () => ledger.outstanding());
console.log(`last day: ${dayOf(start + 364 * DAY)}`);

await ledger.close();
const size = statSync(ledgerPath(dir)).size;
console.log(`file: ${(size / 1e6).toFixed(0)} MB${values.keep ? ` at ${ledgerPath(dir)}` : ""}`);
if (!values.keep) rmSync(dir, { recursive: true, force: true });
