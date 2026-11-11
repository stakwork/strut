// The Publish dialog's Public view tab, its pure parts (components/PublicViewPanel.tsx;
// plans/public-surface.md §2): the link a visitor opens, how the
// cascade's checked lines merge into the record, and a workflow or step
// row's three boxes — show its definition, show its runs, anyone can run
// it — with the price the third opens (plans/paid-runs.md §2).
import type { PublicRunInfo, PublicRunnable, PublicViewNeeds, PublicViewRecord } from "./api";

/** A visitor's link to a public app: the page alone, no credential. */
export function visitorAppLink(name: string, here: string): string {
  const url = new URL(here);
  url.search = "";
  url.hash = "";
  url.searchParams.set("app", name);
  url.searchParams.set("solo", "1");
  url.searchParams.set("public", "1");
  return url.toString();
}

export const sameRecord = (a: PublicViewRecord, b: PublicViewRecord) => JSON.stringify(a) === JSON.stringify(b);
export const emptyRecord = (): PublicViewRecord => ({ concepts: [], workflows: [], steps: [], types: [], apps: [], runnable: [] });

/** The record with the cascade's checked lines merged in. */
export function mergeNeeds(rec: PublicViewRecord, needs: PublicViewNeeds, checked: Set<string>): PublicViewRecord {
  const next: PublicViewRecord = JSON.parse(JSON.stringify(rec));
  const on = (key: string) => checked.has(key);
  if (needs.app) {
    const reads = needs.reads.filter((r) => on(`read:${r.name}`)).map((r) => r.name);
    const at = next.apps.find((a) => a.name === needs.app!.name);
    if (at) at.reads = [...new Set([...(at.reads ?? []), ...reads])];
    else next.apps.push({ name: needs.app.name, ...(reads.length ? { reads } : {}) });
  }
  if (needs.workflow && !needs.workflows.length) next.workflows.push({ name: needs.workflow });
  for (const w of needs.workflows) {
    if (!on(`workflow:${w.name}`)) continue;
    const runs = on(`runs:${w.name}`);
    const at = next.workflows.find((x) => x.name === w.name);
    if (at) at.runs = at.runs || runs || undefined;
    else next.workflows.push({ name: w.name, ...(runs ? { runs: true } : {}) });
  }
  for (const s of needs.steps) if (on(`step:${s.name}`) && !next.steps.includes(s.name)) next.steps.push(s.name);
  for (const c of needs.concepts) if (on(`concept:${c.name}`) && !next.concepts.includes(c.name)) next.concepts.push(c.name);
  for (const w of next.workflows) if (!w.runs) delete w.runs;
  return next;
}

/** The keys a cascade starts with checked. */
export function checkedOf(needs: PublicViewNeeds): Set<string> {
  const out = new Set<string>();
  for (const w of needs.workflows) {
    if (w.checked) out.add(`workflow:${w.name}`);
    if (w.checked && w.runs) out.add(`runs:${w.name}`);
  }
  for (const s of needs.steps) if (s.checked) out.add(`step:${s.name}`);
  for (const r of needs.reads) if (r.checked) out.add(`read:${r.name}`);
  for (const c of needs.concepts) if (c.checked) out.add(`concept:${c.name}`);
  return out;
}

// ── A workflow or step row: three boxes ───────────────────────────────────

export type RowKind = "workflow" | "step";
export interface Row {
  kind: RowKind;
  name: string;
}
export const rowKey = (r: Row) => `${r.kind}:${r.name}`;

/** The rows the tab draws: `before`'s, in their order, then every workflow
 *  and step the record shows or runs that is not among them. A row the
 *  person unticked everything on stays until it is removed. */
export function rowsOf(rec: PublicViewRecord, before: Row[] = []): Row[] {
  const out = [...before];
  const seen = new Set(out.map(rowKey));
  const add = (r: Row) => {
    if (!seen.has(rowKey(r))) {
      seen.add(rowKey(r));
      out.push(r);
    }
  };
  for (const w of rec.workflows) add({ kind: "workflow", name: w.name });
  for (const s of rec.steps) add({ kind: "step", name: s });
  for (const r of rec.runnable) add({ kind: r.kind, name: r.name });
  return out;
}

export interface Boxes {
  /** Anyone reads its definition (`workflows` / `steps`). */
  definition: boolean;
  /** Anyone reads its runs (a workflow's `runs: true`). */
  runs: boolean;
  /** Anyone may run it (`runnable`). */
  run: boolean;
}

export function boxesOf(rec: PublicViewRecord, row: Row): Boxes {
  const w = row.kind === "workflow" ? rec.workflows.find((x) => x.name === row.name) : undefined;
  return {
    definition: row.kind === "workflow" ? !!w : rec.steps.includes(row.name),
    runs: !!w?.runs,
    run: rec.runnable.some((r) => r.kind === row.kind && r.name === row.name),
  };
}

const copyOf = (rec: PublicViewRecord): PublicViewRecord => JSON.parse(JSON.stringify(rec));
const isRow = (row: Row) => (r: PublicRunnable) => r.kind === row.kind && r.name === row.name;

/** The record with one box set. Runs are a workflow's, and come with its
 *  definition (a run's events carry its steps): ticking runs ticks the
 *  definition, unticking the definition unticks runs. "Anyone can run it"
 *  is independent of both; turned off, its price goes with it. */
export function setBox(rec: PublicViewRecord, row: Row, box: keyof Boxes, on: boolean): PublicViewRecord {
  const next = copyOf(rec);
  if (box === "run") {
    next.runnable = next.runnable.filter((r) => !isRow(row)(r));
    if (on) next.runnable.push({ kind: row.kind, name: row.name });
    return next;
  }
  if (row.kind === "step") {
    if (box === "definition") next.steps = on ? [...new Set([...next.steps, row.name])] : next.steps.filter((s) => s !== row.name);
    return next;
  }
  const at = next.workflows.find((w) => w.name === row.name);
  if (box === "definition") {
    if (on && !at) next.workflows.push({ name: row.name });
    if (!on) next.workflows = next.workflows.filter((w) => w.name !== row.name);
    return next;
  }
  if (on) {
    if (at) at.runs = true;
    else next.workflows.push({ name: row.name, runs: true });
  } else if (at) {
    next.workflows = next.workflows.map((w) => (w.name === row.name ? { name: w.name } : w));
  }
  return next;
}

/** The record without the row, in every list. */
export function removeRow(rec: PublicViewRecord, row: Row): PublicViewRecord {
  const next = copyOf(rec);
  if (row.kind === "workflow") next.workflows = next.workflows.filter((w) => w.name !== row.name);
  else next.steps = next.steps.filter((s) => s !== row.name);
  next.runnable = next.runnable.filter((r) => !isRow(row)(r));
  return next;
}

export type PriceField = "base" | "markup" | "capUsd" | "dailyCapUsd";

/** The record with one price field typed: a number, or left out when the
 *  box is empty (the server checks the rest). */
export function setPrice(rec: PublicViewRecord, row: Row, field: PriceField, text: string): PublicViewRecord {
  const next = copyOf(rec);
  next.runnable = next.runnable.map((r) => {
    if (!isRow(row)(r)) return r;
    const { [field]: _old, ...rest } = r;
    const n = text.trim() === "" ? undefined : Number(text);
    return n === undefined || !Number.isFinite(n) ? rest : { ...rest, [field]: n };
  });
  return next;
}

/** What a workflow's launcher reads: its output (the default), or the whole run. */
export function setResults(rec: PublicViewRecord, row: Row, results: "output" | "run"): PublicViewRecord {
  const next = copyOf(rec);
  if (row.kind !== "workflow") return next;
  next.runnable = next.runnable.map((r) => {
    if (!isRow(row)(r)) return r;
    const { results: _old, ...rest } = r;
    return results === "run" ? { ...rest, results } : rest;
  });
  return next;
}

const micros = (dollars: number | undefined) => Math.round((dollars ?? 0) * 1_000_000);

/** The credit a run needs to start, in dollars: base + markup × the
 *  per-run cap, rounded to the micro-dollar as the server rounds it. */
export function reserveUsd(item: PublicRunnable): number {
  return (micros(item.base) + Math.round((item.markup ?? 0) * micros(item.capUsd))) / 1_000_000;
}

export const isPricedItem = (item: PublicRunnable) => (item.base ?? 0) > 0 || (item.markup ?? 0) > 0;

/** Dollars as a person reads them: cents, or four places under a cent. */
export function usd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** What the save will refuse, said before it: the server's checks over what
 *  the dialog knows of the item (`GET /public-view/runnable`). */
export function runHints(item: PublicRunnable, info: PublicRunInfo): string[] {
  const out: string[] = [];
  const priced = isPricedItem(item);
  if (item.kind === "workflow" && info.input === false) out.push("It declares no input: block — add one before strangers can run it.");
  if ((item.markup ?? 0) > 0 && item.capUsd === undefined) out.push("A markup needs a per-run cap.");
  if (priced && !info.wallet) out.push("Priced: set a wallet under Earnings first, or make it free.");
  if (item.kind === "workflow" && info.can.spends) {
    if (!info.owner && !info.principal) out.push("It calls a model and has no owner to pay for a stranger's run: claim it first.");
    if (!priced && item.dailyCapUsd === undefined) out.push("Free, and it calls a model: set a daily cap, the most you carry in a day.");
  }
  return out;
}

/** How many runs of an item with a daily cap and no per-run cap fit in the
 *  daily cap at once: the server's `DAILY_CAP_SHARE` (src/public-runnable.ts),
 *  held equal by public-view.test.ts. */
export const DAILY_CAP_SHARE = 10;

/** What the caps do together, said beside them — not a refusal. A run in
 *  flight counts against the daily cap at its own cap (plans/paid-runs.md
 *  §7). With no per-run cap a run may spend a `DAILY_CAP_SHARE`th of the
 *  daily cap, so that many run at once; a per-run cap at or above the daily
 *  cap lets one run at a time. The workflow's own run cap, when smaller,
 *  lets more run, and the dialog does not know it: "up to". */
export function capNote(item: PublicRunnable): string | undefined {
  if (item.kind !== "workflow" || item.dailyCapUsd === undefined) return undefined;
  if (item.capUsd === undefined) {
    return `No per-run cap: each run may spend up to ${usd(item.dailyCapUsd / DAILY_CAP_SHARE)} (the daily cap over ${DAILY_CAP_SHARE}), so ${DAILY_CAP_SHARE} can run at once.`;
  }
  if (micros(item.capUsd) >= micros(item.dailyCapUsd)) {
    return `The per-run cap is at least the daily cap, so one run at a time. Lower it to let several run at once.`;
  }
  return undefined;
}

/** Turning "anyone can run it" on for something that acts or runs code
 *  needs the person's tick; one already runnable when the tab opened had it. */
export function needsTick(row: Row, info: PublicRunInfo | undefined, saved: PublicViewRecord): boolean {
  if (!info || !(info.can.acts || info.can.code)) return false;
  return !saved.runnable.some(isRow(row));
}

