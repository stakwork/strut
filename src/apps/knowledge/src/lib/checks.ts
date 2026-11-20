// A Concept's CHECKS and TESTS as the page shows them — pure, no React
// (tested in src/apps/knowledge.test.ts). A check is a claim on the page
// with the cases that test it; a test is two wordings of the page, each
// with every check's verdicts on it (`knowledge/checks`, src/trials.ts).

import type { PageClaim } from "./learning";

/** One input a check is tested with: a workflow and its input. */
export interface Case {
  workflow: string;
  input: Record<string, unknown>;
}

/** One verdict: a run the check's judge read. */
export interface Sample {
  run: string;
  workflow?: string;
  supports: boolean;
  /** What the judge saw, in a line. */
  content?: string;
  at?: number;
  /** A trial's: which of the check's cases it replayed. */
  case?: number;
  trial?: true;
}

export interface Check extends PageClaim {
  cases: Case[];
  /** Its verdicts on the page's wording now, oldest first. */
  samples: Sample[];
}

/** One wording of a test, with each check's verdicts on it, by check id. */
export interface TestSide {
  version: string;
  docs: string;
  samples: Record<string, Sample[]>;
}

export interface PageTest {
  id: string;
  at: string;
  by?: string;
  page: TestSide;
  change: TestSide;
  /** One of its two wordings is the page now. */
  live: boolean;
}

export interface Batch {
  id: string;
  test?: string;
  claim?: string;
  total: number;
  done: number;
  errors: string[];
}

export interface ChecksView {
  concept: string;
  ref_id: string;
  version: string;
  docs: string;
  fromGit?: { set: string; checkout?: string; why?: string };
  checks: Check[];
  tests: PageTest[];
  running: Batch[];
  /** The last run left samples with no verdict: how many and why, in a line. */
  problem?: string;
}

/** The most dots a row draws: the newest. The rest are a count to their left. */
export const DOTS_MAX = 10;

/** The newest `max` of a row's samples, and how many earlier ones are not drawn. */
export function capped<T>(samples: readonly T[], max = DOTS_MAX): { more: number; shown: T[] } {
  const more = Math.max(0, samples.length - max);
  return { more, shown: samples.slice(more) };
}

export function tally(samples: readonly Pick<Sample, "supports">[]): { passed: number; judged: number } {
  return { passed: samples.filter((s) => s.supports).length, judged: samples.length };
}

/** "14 of 16 passed", or that nothing ran. */
export function tallyWords(samples: readonly Pick<Sample, "supports">[]): string {
  const { passed, judged } = tally(samples);
  return judged ? `${passed} of ${judged} passed` : "Not run yet";
}

/** Every check's verdicts on one wording of a test. */
export function allSamples(side: Pick<TestSide, "samples">): Sample[] {
  return Object.values(side.samples).flat();
}

/** Which wording did better: the share of verdicts that passed on each. `none` while a side has no verdict. */
export type Outcome = "page" | "same" | "change" | "none";

export function outcomeOf(page: readonly Pick<Sample, "supports">[], change: readonly Pick<Sample, "supports">[]): Outcome {
  const p = tally(page);
  const c = tally(change);
  if (!p.judged || !c.judged) return "none";
  // p.passed / p.judged against c.passed / c.judged, without dividing.
  const diff = p.passed * c.judged - c.passed * p.judged;
  return diff > 0 ? "page" : diff < 0 ? "change" : "same";
}

export const OUTCOME: Record<Exclude<Outcome, "none">, string> = {
  page: "The page is better",
  same: "No difference",
  change: "The change is better",
};

/** A case in a line: the one thing it says (`{ prompt }` reads as the prompt), else its input as it is. */
export function caseLabel(c: Pick<Case, "input">): string {
  const values = Object.values(c.input ?? {});
  if (values.length === 1 && typeof values[0] === "string") return values[0];
  return JSON.stringify(c.input ?? {});
}

/** The field a case's message goes in: the one string field the check's cases use, `prompt` when there is none to copy. */
function messageField(cases: readonly Case[]): string {
  for (const c of cases) {
    const keys = Object.keys(c.input ?? {});
    if (keys.length === 1 && typeof c.input[keys[0]!] === "string") return keys[0]!;
  }
  return "prompt";
}

/** The workflow a new case of `check` runs: its own cases', else another check's on the page. */
export function workflowFor(check: Pick<Check, "cases">, others: readonly Pick<Check, "cases">[] = []): string | undefined {
  return check.cases[0]?.workflow ?? others.find((o) => o.cases.length)?.cases[0]!.workflow;
}

/** A message as a new case of `check`, shaped like the ones it has; null without a message or a workflow. */
export function caseFor(check: Pick<Check, "cases">, message: string, workflow: string | undefined): Case | null {
  const text = message.trim();
  const flow = workflow?.trim();
  if (!text || !flow) return null;
  return { workflow: flow, input: { [messageField(check.cases)]: text } };
}

/** Who wrote a check, as the page says it. */
export function speakerLabel(speaker: string | undefined): string {
  if (!speaker || speaker === "person") return "Added here";
  if (speaker === "strut") return "Seeded";
  if (speaker === "ai") return "Learned";
  return `By ${speaker}`;
}

const line = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 2));

/** A trial's message: its input's one string, else the input as it is. */
export function messageOf(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) return caseLabel({ input: input as Record<string, unknown> });
  return line(input);
}

/** A trial's reply: its output's `text`, else the output as it is; the error when it failed. */
export function replyOf(out: { output?: unknown; error?: string }): string {
  const o = out.output;
  if (o && typeof o === "object" && typeof (o as { text?: unknown }).text === "string") return (o as { text: string }).text;
  if (o !== undefined) return line(o);
  return out.error ? `The run failed: ${out.error}` : "";
}

/** The job a trial's reply would have started, which was held: its title, its brief and the rest of what it named, a line each. */
export interface HeldJob {
  title?: string;
  brief: string;
  rest: string[];
}

/** The output's `held` (the orchestrator's: the job its reply would have started, src/workflows/orchestrator.yaml); null when it would have started none. The judge reads it with the reply. */
export function heldOf(out: { output?: unknown }): HeldJob | null {
  const o = out.output;
  const h = o && typeof o === "object" ? (o as { held?: unknown }).held : undefined;
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const { title, brief, ...rest } = h as Record<string, unknown>;
  if (typeof brief !== "string" || !brief.trim()) return null;
  const said = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
  return {
    ...(typeof title === "string" && title.trim() ? { title } : {}),
    brief,
    rest: Object.entries(rest)
      .filter(([, v]) => said(v))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ") : typeof v === "string" ? v : JSON.stringify(v)}`),
  };
}

/** "Running: 5 of 16 judged", over everything in flight; null when nothing is. */
export function runningWords(batches: readonly Pick<Batch, "total" | "done">[]): string | null {
  if (!batches.length) return null;
  const total = batches.reduce((n, b) => n + b.total, 0);
  const done = batches.reduce((n, b) => n + b.done, 0);
  return `Running: ${done} of ${total} judged`;
}

/** The samples to ask for, from what a person typed: a whole number from 1 to 20, else null. */
export function samplesOf(typed: string): number | null {
  const n = Number(typed);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}
