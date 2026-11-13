// The staff app's pure parts (plans/human-steps.md §9.5): where a deep link
// opens, what the Queue warns of, which parts the server answers for (§9.7),
// and how things read. No React here: src/apps/staff.test.ts tests them.
import type { Balance, Books, Lease, Standing, Task, TaskStats, TaskStatus, TaskType, Verdict, Worker, WorkerStatus } from "./types";

export const TABS = ["queue", "types", "workers", "tasks", "tests"] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABELS: Record<Tab, string> = { queue: "Queue", types: "Types", workers: "Workers", tasks: "Tasks", tests: "Tests" };

/** Where the page is: a tab and what is open in it. */
export interface Place {
  tab: Tab;
  type?: string;
  worker?: string;
  task?: string;
  test?: string;
  /** Tasks of one run: `<workflow>/<runId>`. */
  run?: string;
  /** Tasks one worker answered. */
  by?: string;
  /** §9.6: tasks with an answer not reviewed, or marked so — the review
   *  queue. */
  review?: ReviewFilter;
}

export type ReviewFilter = "none" | Verdict;
export const REVIEW_FILTERS: readonly ReviewFilter[] = ["none", "ok", "rejected"];

/**
 * Where a deep link opens (§9.1): `input` takes one of `tab=queue|types|
 * workers|tasks|tests`, `type=<name>`, `worker=<actor>`, `task=<id>`,
 * `test=<id>`, `run=<workflow>/<runId>`, `by=<actor>` (the tasks they
 * answered), `review=none|ok|rejected` (the review queue, §9.6; with `by`,
 * that worker's). A thing named opens its tab; with nothing named, the
 * Queue.
 */
export function placeOf(input: Record<string, unknown> | null | undefined): Place {
  const str = (k: string) => (typeof input?.[k] === "string" && (input[k] as string) ? (input[k] as string) : undefined);
  const tab = str("tab");
  const named = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : undefined;
  const review = REVIEW_FILTERS.find((r) => r === str("review"));
  if (str("task")) return { tab: "tasks", task: str("task")! };
  if (str("run")) return { tab: "tasks", run: str("run")! };
  if (review) return { tab: "tasks", review, ...(str("by") ? { by: str("by")! } : {}) };
  if (str("by")) return { tab: "tasks", by: str("by")! };
  if (str("worker")) return { tab: "workers", worker: str("worker")! };
  if (str("test")) return { tab: "tests", test: str("test")! };
  if (str("type")) return named === "tests" || named === "tasks" ? { tab: named, type: str("type")! } : { tab: "types", type: str("type")! };
  return { tab: named ?? "queue" };
}

/** A place as the app link's input, the inverse of `placeOf`. */
export function inputOf(p: Place): Record<string, string> {
  if (p.task) return { task: p.task };
  if (p.run) return { run: p.run };
  if (p.review) return { review: p.review, ...(p.by ? { by: p.by } : {}) };
  if (p.by) return { by: p.by };
  if (p.worker) return { worker: p.worker };
  if (p.test) return { test: p.test };
  if (p.type) return p.tab === "types" ? { type: p.type } : { tab: p.tab, type: p.type };
  return p.tab === "queue" ? {} : { tab: p.tab };
}

/** `<workflow>/<runId>` split at its last `/` (a workflow name may hold one). */
export function runOf(run: string): { workflow: string; runId: string } | null {
  const i = run.lastIndexOf("/");
  return i > 0 && i < run.length - 1 ? { workflow: run.slice(0, i), runId: run.slice(i + 1) } : null;
}

/** One thing that needs a person, above the Queue's table. */
export interface QueueWarning {
  text: string;
  /** Where it leads. */
  to: Place;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What needs a person (§9.5): a type with tasks waiting and nobody granted
 *  it; tasks that expire unanswered within the hour; a type turned off with
 *  open tasks; a type whose app is missing or does not grant the worker's
 *  steps; new workers waiting for a grant. */
export function queueWarnings(stats: TaskStats): QueueWarning[] {
  const out: QueueWarning[] = [];
  for (const t of stats.types) {
    const open = t.waiting + t.working;
    if (t.appProblem) out.push({ text: `${t.type}: ${t.appProblem}.`, to: { tab: "types", type: t.type } });
    if (t.waiting > 0 && t.granted === 0) out.push({ text: `${t.type} has ${plural(t.waiting, "task")} waiting and no worker granted it.`, to: { tab: "types", type: t.type } });
    if (!t.enabled && open > 0) out.push({ text: `${t.type} is turned off with ${plural(open, "open task")}: none is handed out, and each expires when due.`, to: { tab: "types", type: t.type } });
    if (t.dueHour > 0) out.push({ text: `${plural(t.dueHour, "task")} of ${t.type} ${t.dueHour === 1 ? "expires" : "expire"} unanswered within the hour.`, to: { tab: "tasks", type: t.type } });
  }
  const fresh = stats.workers.new ?? 0;
  if (fresh > 0) out.push({ text: `${plural(fresh, "new worker")} signed in and ${fresh === 1 ? "waits" : "wait"} for a grant.`, to: { tab: "workers" } });
  return out;
}

// ── what the server answers for (§9.7) ─────────────────────────────────────

/** The parts of items 4 and 5a the page shows: each only when the server
 *  answers for it, never an empty "coming soon". */
export interface Shown {
  /** Item 4: the Tests tab and a type's Tests section — the test routes
   *  answer (a host's own store answers `not_available`). */
  tests: boolean;
  /** Item 4: the Standing column — the workers carry `standing` and some
   *  type has tests (else every cell would be empty). */
  standing: boolean;
  /** Item 4 (4b): a type's Copies section, and disputed tasks — the types
   *  read come from a server whose tests answer (copies came after them). */
  copies: boolean;
  /** Item 5a: a type's Pay section — the types carry `holdHours`. */
  pay: boolean;
  /** Item 5a: the Earned, Held and Withdrawable columns — the workers carry
   *  a `balance` and some type is paid or someone is owed. */
  earnings: boolean;
  /** §9.6: Mark ok and Reject, and the review filter — the server's own
   *  task store, as for tests (a host's answers `not_available` to both). */
  review: boolean;
}

export function shownOf(o: { types?: TaskType[]; workers?: Worker[]; testsAnswer: "yes" | "no" | "unknown" }): Shown {
  const types = o.types ?? [];
  const workers = o.workers ?? [];
  const tests = o.testsAnswer === "yes";
  const pay = types.some((t) => t.holdHours !== undefined);
  return {
    tests,
    standing: tests && workers.some((w) => w.standing !== undefined) && types.some((t) => !!t.tests),
    copies: tests,
    pay,
    review: tests,
    earnings: workers.some((w) => w.balance !== undefined) && (types.some((t) => (t.paySats ?? 0) > 0) || workers.some((w) => (w.balance?.totalMsat ?? 0) > 0)),
  };
}

/** Whether the test routes answer: a refusal that names `not_available`
 *  (a host's own store) is "no"; any other error says nothing. */
export function testsAnswerOf(r: { data?: unknown; error?: unknown }): "yes" | "no" | "unknown" {
  if (r.data !== undefined) return "yes";
  if (r.error) return /not_available/.test(r.error instanceof Error ? r.error.message : String(r.error)) ? "no" : "unknown";
  return "unknown";
}

/** The Queue's line beside the wallet (§9.7, 5a): what workers are owed and
 *  what the wallet holds, or null when no worker was ever paid. */
export function owedLine(books: Books | undefined): { text: string; short: boolean } | null {
  const w = books?.workers;
  if (!w || !(w.owedMsat > 0 || w.payees > 0 || w.accepted.answers > 0 || w.takenBack.answers > 0)) return null;
  const owed = `Workers are owed ${fmtSats(w.owedMsat)} (${fmtSats(w.heldMsat)} held, ${fmtSats(w.withdrawableMsat)} withdrawable)`;
  const wallet = books?.wallet;
  if (!wallet?.balance) return { text: `${owed}. ${wallet?.error ? `The wallet could not be read: ${wallet.error}` : "No wallet is read here."}`, short: false };
  const cover = wallet.coverMsat ?? wallet.balance.msat - w.owedMsat;
  return cover >= 0
    ? { text: `${owed}; the wallet holds ${fmtSats(wallet.balance.msat)}, ${fmtSats(cover)} more than that.`, short: false }
    : { text: `${owed}; the wallet holds ${fmtSats(wallet.balance.msat)}, ${fmtSats(-cover)} short of it.`, short: true };
}

// ── words ──────────────────────────────────────────────────────────────────

export function fmtSats(msat: number): string {
  const sats = msat / 1000;
  const shown = Math.abs(sats) >= 100 ? Math.round(sats) : Math.round(sats * 1000) / 1000;
  return `${shown.toLocaleString("en-US", { maximumFractionDigits: 3 })} sat${shown === 1 ? "" : "s"}`;
}

/** A duration in ms, short: `45 s`, `12 min`, `3.5 h`, `2 d`. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round((s / 3600) * 10) / 10} h`;
  return `${Math.round((s / 86400) * 10) / 10} d`;
}

/** A moment, short: today's as a time, another day's as a date and time. */
export function fmtWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** An actor shortened (`secp:3fa2…91c`): a long id keeps its scheme, its
 *  first four and last three. */
export function shortActor(actor: string): string {
  const m = /^([a-z0-9]+:)?(.+)$/i.exec(actor);
  const scheme = m?.[1] ?? "";
  const id = m?.[2] ?? actor;
  return id.length > 12 ? `${scheme}${id.slice(0, 4)}…${id.slice(-3)}` : actor;
}

/** Who a worker is to staff (§9.5): the note's first line as a name, else
 *  the actor shortened. The store keeps no name of its own. */
export function whoOf(w: Pick<Worker, "actor" | "note">): string {
  const first = w.note?.split("\n")[0]?.trim();
  return first ? first : shortActor(w.actor);
}

/** The live grants first, then the revoked, each by type. */
export function liveTypes(w: Pick<Worker, "grants">): string[] {
  return w.grants.filter((g) => g.revokedAt === undefined).map((g) => g.type);
}

/** Workers in the list's order: `new` first (they wait), then the rest as
 *  the server lists them (newest first). */
export function workersInOrder<T extends { status: WorkerStatus }>(ws: readonly T[]): T[] {
  return [...ws.filter((w) => w.status === "new"), ...ws.filter((w) => w.status !== "new")];
}

/** Standing in a cell: `qualifying 3/10`, `85% of 20`, `—` (none graded). */
export function standingText(s: Standing): string {
  if (s.qualifying) return s.qualify > 0 ? `qualifying ${s.graded + s.pending}/${s.qualify}` : "qualifying";
  if (s.graded === 0) return "—";
  return `${Math.round((s.passed / s.graded) * 100)}% of ${s.graded}${s.rejected ? ` (${s.rejected} rejected)` : ""}`;
}

/** A standing under its threshold (it revokes at its next grade, once enough are graded). */
export function standingLow(s: Standing): boolean {
  return !s.qualifying && s.graded > 0 && s.passed / s.graded < s.threshold;
}

/** How a lease closed, in words (§9.5): answered, skipped, ran out, ended early. */
export function leaseOutcome(l: Pick<Lease, "status" | "reason" | "expires">, now = Date.now()): string {
  if (l.status === "submitted") return "answered";
  if (l.status === "skipped") return l.reason ? `skipped: ${l.reason}` : "skipped";
  if (l.status === "expired") return l.reason ? `ended early: ${l.reason}` : "ran out";
  return l.expires > now ? "working" : "ran out";
}

/** An earning in words (§8.1): `20 sats, held until 14:00`, `taken back: why`. */
export function earningText(e: NonNullable<Lease["earning"]>, now = Date.now()): string {
  if (e.takenBack !== undefined) return `${fmtSats(e.msat)} taken back${e.takenBackWhy ? `: ${e.takenBackWhy}` : ""}`;
  return e.releases > now ? `${fmtSats(e.msat)}, held until ${fmtWhen(e.releases, now)}` : `${fmtSats(e.msat)}, released`;
}

/** A balance's three columns. */
export function balanceCells(b: Balance | undefined): [string, string, string] {
  if (!b) return ["—", "—", "—"];
  return [fmtSats(b.totalMsat), fmtSats(b.heldMsat), fmtSats(b.withdrawableMsat)];
}

/** §9.6: the answers a verdict can be given on — a real task's, each copy's
 *  apart. */
export function reviewable(t: Pick<Task, "test" | "leases">): Lease[] {
  return t.test ? [] : t.leases.filter((l) => l.status === "submitted");
}

/** A task's answers' verdicts in a cell: `ok`, `rejected`, `to review`,
 *  `1 ok, 1 to review`; "" with no answer to review. */
export function reviewSummary(t: Pick<Task, "test" | "leases">): string {
  const answers = reviewable(t);
  if (!answers.length) return "";
  const n = { ok: 0, rejected: 0, none: 0 };
  for (const l of answers) n[l.review?.verdict ?? "none"]++;
  const parts = [n.ok && `${answers.length > 1 ? `${n.ok} ` : ""}ok`, n.rejected && `${answers.length > 1 ? `${n.rejected} ` : ""}rejected`, n.none && `${answers.length > 1 ? `${n.none} ` : ""}to review`];
  return parts.filter(Boolean).join(", ");
}

/** A verdict in words (§9.6): `rejected: blurry box · by ada, 14:02 ·
 *  changeable until Nov 16, 14:00`, or `· final`. */
export function reviewText(r: NonNullable<Lease["review"]>, now = Date.now()): string {
  const head = r.verdict === "rejected" ? `rejected${r.why ? `: ${r.why}` : ""}` : `ok${r.why ? `: ${r.why}` : ""}`;
  const who = ` · ${r.by ? `by ${r.by}, ` : ""}${fmtWhen(r.at, now)}`;
  return `${head}${who} · ${r.final || r.until <= now ? "final" : `changeable until ${fmtWhen(r.until, now)}`}`;
}

export const REVIEW_WORDS: Record<ReviewFilter, string> = { none: "Not reviewed", ok: "Marked ok", rejected: "Rejected" };

export const STATUS_WORDS: Record<TaskStatus, string> = {
  open: "open",
  settled: "answered",
  expired: "expired",
  cancelled: "cancelled",
  disputed: "disputed",
};

/** The store's rule for a type's name (src/tasks/tasks.ts), so a new name is
 *  refused here first. */
export const TYPE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;

/** Why a new type's name will not do, or undefined. */
export function typeNameProblem(name: string, taken: readonly string[]): string | undefined {
  if (!name) return "a type needs a name";
  if (name.length > 128) return "at most 128 characters";
  if (!TYPE_NAME_RE.test(name)) return 'lowercase letters, digits, ".", "_" and "-", segments joined by "/"';
  if (taken.includes(name)) return `there is a type ${name} already`;
  return undefined;
}

/** JSON as text for an editor, or the text back as JSON. */
export function jsonText(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v, null, 2);
}
export function parseJson(text: string): { value: unknown } | { problem: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

/** A short line of a JSON value, for a table cell. */
export function jsonLine(v: unknown, max = 80): string {
  const s = JSON.stringify(v) ?? "—";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A refusal's words: the step's error message without the tool's wrapping. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^step_run(?: refused)?: /, "");
}
