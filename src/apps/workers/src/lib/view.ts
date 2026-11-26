// The Workers app's pure parts (plans/human-steps.md §9.5): where a deep link
// opens, what the Queue warns of, which parts the server answers for (§9.7),
// and how things read. No React here: src/apps/workers.test.ts tests them.
import type { Balance, Books, Grant, Invite, InvitesAnswer, InviteStatus, Lease, Payout, SentFile, Standing, SupportConversation, SupportFilter, SupportMessage, Task, TaskStats, TaskStatus, TaskType, TypeShare, Verdict, Worker, WorkerStatus } from "./types";
import { localText } from "@strut/kit/folds";

export const TABS = ["queue", "types", "workers", "tasks", "groups", "tests", "payouts", "support"] as const;
export type Tab = (typeof TABS)[number];

/** The tabs the bar shows, one a job: seeing what needs a person
 *  (`queue`), checking the answers (`tasks`, and `groups`, the same answers
 *  put together), the people, the kinds of work (`types`, and a type's
 *  `tests`), paying, talking. A place keeps its own tab, so every deep link
 *  from before opens where it did. */
export const NAV = ["queue", "tasks", "workers", "types", "payouts", "support"] as const;
export type NavTab = (typeof NAV)[number];
export const NAV_LABELS: Record<NavTab, string> = { queue: "Overview", tasks: "Answers", workers: "Workers", types: "Task types", payouts: "Payouts", support: "Support" };

/** The bar's tab a place is under. */
export function navOf(tab: Tab): NavTab {
  return tab === "groups" ? "tasks" : tab === "tests" ? "types" : tab;
}

/** Where the page is: a tab and what is open in it. */
export interface Place {
  tab: Tab;
  type?: string;
  /** On the Payouts tab: only this worker's payouts; on Support, their
   *  conversation. */
  worker?: string;
  task?: string;
  /** On the Payouts tab: one payout, by its key. */
  payout?: string;
  test?: string;
  /** Tasks of one run: `<workflow>/<runId>`. */
  run?: string;
  /** Tasks one worker answered. */
  by?: string;
  /** §9.6: tasks with an answer not reviewed, or marked so — the review
   *  queue. */
  review?: ReviewFilter;
  /** On the Groups tab: one group (`task/reply`'s `group`), of `type`. */
  group?: string;
  /** On the Workers tab: one worker's Review, over the list. */
  reviewing?: string;
  /** On the Workers tab: show only workers pending approval (status "new"). */
  pending?: boolean;
}

export type ReviewFilter = "none" | Verdict;
export const REVIEW_FILTERS: readonly ReviewFilter[] = ["none", "ok", "rejected"];

/**
 * Where a deep link opens (§9.1): `input` takes one of `tab=queue|types|
 * workers|tasks|tests|payouts`, `type=<name>`, `worker=<actor>`, `task=<id>`,
 * `test=<id>`, `payout=<key>` (one payout), `tab=payouts&worker=<actor>`
 * (that worker's payouts), `tab=support&worker=<actor>` (their conversation
 * with Support, plans/support-chat.md §3), `run=<workflow>/<runId>`, `by=<actor>` (the tasks they
 * answered), `review=none|ok|rejected` (the review queue, §9.6; with `by`,
 * that worker's), `reviewing=<actor>` (their Review over the Workers list).
 * A thing named opens its tab; with nothing named, the Queue.
 */
export function placeOf(input: Record<string, unknown> | null | undefined): Place {
  const str = (k: string) => (typeof input?.[k] === "string" && (input[k] as string) ? (input[k] as string) : undefined);
  const tab = str("tab");
  const named = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : undefined;
  const review = REVIEW_FILTERS.find((r) => r === str("review"));
  if (str("payout")) return { tab: "payouts", payout: str("payout")! };
  if (str("group")) return { tab: "groups", group: str("group")!, ...(str("type") ? { type: str("type")! } : {}) };
  if (named === "payouts") return { tab: "payouts", ...(str("worker") ? { worker: str("worker")! } : {}) };
  if (named === "support") return { tab: "support", ...(str("worker") ? { worker: str("worker")! } : {}) };
  if (str("task")) return { tab: "tasks", task: str("task")! };
  if (str("run")) return { tab: "tasks", run: str("run")! };
  if (review) return { tab: "tasks", review, ...(str("by") ? { by: str("by")! } : {}) };
  if (str("by")) return { tab: "tasks", by: str("by")! };
  if (str("pending") === "true") return { tab: "workers", pending: true };
  if (str("reviewing")) return { tab: "workers", reviewing: str("reviewing")! };
  if (str("worker")) return { tab: "workers", worker: str("worker")! };
  if (str("test")) return { tab: "tests", test: str("test")! };
  if (str("type")) return named === "tests" || named === "tasks" || named === "groups" ? { tab: named, type: str("type")! } : { tab: "types", type: str("type")! };
  return { tab: named ?? "queue" };
}

/** A place as the app link's input, the inverse of `placeOf`. */
export function inputOf(p: Place): Record<string, string> {
  if (p.payout) return { payout: p.payout };
  if (p.group) return { group: p.group, ...(p.type ? { type: p.type } : {}) };
  if (p.tab === "payouts") return { tab: "payouts", ...(p.worker ? { worker: p.worker } : {}) };
  if (p.tab === "support") return { tab: "support", ...(p.worker ? { worker: p.worker } : {}) };
  if (p.task) return { task: p.task };
  if (p.run) return { run: p.run };
  if (p.review) return { review: p.review, ...(p.by ? { by: p.by } : {}) };
  if (p.by) return { by: p.by };
  if (p.reviewing) return { reviewing: p.reviewing };
  if (p.pending) return { tab: "workers", pending: "true" };
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

/** One thing that needs a person, first on the Overview. */
export interface Need {
  text: string;
  /** What its button says. */
  action: string;
  /** Where it leads. */
  to: Place;
  /** `warn`: work or people are held up until someone acts. `plain`: it waits. */
  tone: "warn" | "plain";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A type's answers with no verdict yet (`toReview`), every type's with no
 *  `type`; undefined on a server that does not count them (a host's own
 *  task store, an older strut). */
export function toReviewOf(stats: Pick<TaskStats, "types"> | undefined, type?: string): number | undefined {
  const rows = (stats?.types ?? []).filter((t) => (type ? t.type === type : true) && t.toReview !== undefined);
  return rows.length ? rows.reduce((n, t) => n + (t.toReview ?? 0), 0) : undefined;
}

/** What needs a person (§9.5): a type whose app is missing or does not
 *  grant the worker's steps; one with tasks waiting and nobody who may take
 *  them; one turned off with open tasks; tasks that expire unanswered within
 *  the hour; people who signed in and wait to be let in (`waiting`, the
 *  list's `new` workers: Review opens the one who waited longest); and,
 *  last, the answers nobody has reviewed (`groups`: there is a group to
 *  review them in). */
export function needsYou(stats: TaskStats, o: { groups?: boolean; waiting?: readonly Pick<Worker, "actor" | "firstSeen">[] } = {}): Need[] {
  const out: Need[] = [];
  for (const t of stats.types) {
    const open = t.waiting + t.working;
    if (t.appProblem) out.push({ text: `${t.type}: ${t.appProblem}.`, action: "Open the type", to: { tab: "types", type: t.type }, tone: "warn" });
    if (t.waiting > 0 && t.granted === 0) out.push({ text: `${t.type} has ${plural(t.waiting, "task")} waiting and no worker who may take it.`, action: "Let someone in", to: { tab: "types", type: t.type }, tone: "warn" });
    if (!t.enabled && open > 0) out.push({ text: `${t.type} is turned off with ${plural(open, "open task")}: none is handed out, and each expires when due.`, action: "Open the type", to: { tab: "types", type: t.type }, tone: "warn" });
    if (t.dueHour > 0) out.push({ text: `${plural(t.dueHour, "task")} of ${t.type} ${t.dueHour === 1 ? "expires" : "expire"} unanswered within the hour.`, action: "See them", to: { tab: "tasks", type: t.type }, tone: "warn" });
  }
  const fresh = stats.workers.new ?? 0;
  if (fresh > 0) {
    const text = `${plural(fresh, "person", "people")} signed in and ${fresh === 1 ? "is" : "are"} waiting to be reviewed.`;
    out.push({ text, action: "Review", to: { tab: "workers", pending: true }, tone: "warn" });
  }
  const review = toReviewOf(stats) ?? 0;
  if (review > 0) out.push({ text: `${plural(review, "answer")} ${review === 1 ? "has" : "have"} not been reviewed.`, action: "Start reviewing", to: o.groups ? { tab: "groups" } : { tab: "tasks", review: "none" }, tone: "plain" });
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
  /** Ruling 9: a type's Open / Invite-only choice — every type carries
   *  `open` (with no type yet, shown). */
  open: boolean;
  /** Item 5b: the Payouts tab and a worker's link to theirs — `/tasks/payouts`
   *  answers (a host's own store answers `not_available`). */
  payouts: boolean;
  /** The Support tab and Message on a worker's page
   *  (plans/people-and-hosts.md §5): the wallet is a Sphinx daemon with its
   *  message token, or Support already has a conversation. */
  support: boolean;
}

export function shownOf(o: { types?: TaskType[]; workers?: Worker[]; testsAnswer: "yes" | "no" | "unknown"; payoutsAnswer?: "yes" | "no" | "unknown"; supportAnswer?: "yes" | "no" | "unknown" }): Shown {
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
    open: types.every((t) => t.open !== undefined),
    payouts: o.payoutsAnswer === "yes",
    support: o.supportAnswer === "yes",
    earnings: workers.some((w) => w.balance !== undefined) && (types.some((t) => (t.paySats ?? 0) > 0) || workers.some((w) => (w.balance?.totalMsat ?? 0) > 0)),
  };
}

/** Whether a route answers here: a refusal that names `not_available`
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

/** What workers are owed beside what the wallet holds, as the Overview
 *  draws it: null when no worker was ever paid (`owedLine`'s rule). `cover`
 *  is what the wallet holds past what is owed (negative: short of it);
 *  absent when no wallet is read here. */
export function moneyOf(books: Books | undefined): { owedMsat: number; heldMsat: number; withdrawableMsat: number; walletMsat?: number; coverMsat?: number; walletError?: string } | null {
  if (!owedLine(books)) return null;
  const w = books!.workers!;
  const wallet = books?.wallet;
  const base = { owedMsat: w.owedMsat, heldMsat: w.heldMsat, withdrawableMsat: w.withdrawableMsat };
  if (!wallet?.balance) return { ...base, ...(wallet?.error ? { walletError: wallet.error } : {}) };
  return { ...base, walletMsat: wallet.balance.msat, coverMsat: wallet.coverMsat ?? wallet.balance.msat - w.owedMsat };
}

// ── payouts (§8.2) ─────────────────────────────────────────────────────────

export const PAYOUT_STATES = ["out", "stale", "paid", "failed"] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

/** What a payout is to staff: `stale` is an `out` one that waits for a person. */
export function payoutState(p: Pick<Payout, "state" | "stale">): PayoutState {
  return p.state === "out" && p.stale ? "stale" : p.state;
}

/** A Sphinx address shortened (`<pubkey>_<lsp>_<scid>`): the pubkey's first
 *  and last few, and the channel. */
export function shortAddress(address: string): string {
  const [pubkey, , scid] = address.split("_");
  if (!pubkey || scid === undefined) return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}_…_${scid}`;
}

/** The wallet's cover for the Payouts tab: the Queue's line, and whether
 *  withdrawals are refused (the wallet is short of what workers are owed). */
export function payoutCover(books: Books | undefined): { text: string; short: boolean } | null {
  const line = owedLine(books);
  return line ? { text: line.text, short: line.short } : null;
}

/** The most one worker's payouts came to today among `payouts` (those
 *  listed: the newest), failed ones counting for nothing: the worker cap's
 *  use. */
export function mostByOneWorkerToday(payouts: readonly Pick<Payout, "worker" | "msat" | "state" | "day">[], day: string): number {
  const by = new Map<string, number>();
  for (const p of payouts) if (p.day === day && p.state !== "failed") by.set(p.worker, (by.get(p.worker) ?? 0) + p.msat);
  return Math.max(0, ...by.values());
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

/** Who a worker is to staff (§9.5): the note's first line, which staff
 *  typed on purpose, else their name (`people/names`,
 *  plans/people-and-hosts.md §1 and decision 5), else the actor shortened. */
export function whoOf(w: Pick<Worker, "actor" | "note" | "name">): string {
  const first = w.note?.split("\n")[0]?.trim();
  return first || w.name || shortActor(w.actor);
}

/** What shows under `whoOf`: their name where the note came first, and the
 *  short key beside any name (plans/people-and-hosts.md §9: a name is never
 *  checked). Empty when `whoOf` is the key itself. */
export function whoElse(w: Pick<Worker, "actor" | "note" | "name">): string {
  const first = w.note?.split("\n")[0]?.trim();
  if (!first && !w.name) return "";
  return [first && w.name ? w.name : "", shortActor(w.actor)].filter(Boolean).join(" · ");
}

/** Who an open type's grant is by (src/tasks/worker-store.ts): the worker's
 *  own first ask, never an actor. */
export const OPEN_GRANT_BY = "open";

/** Who granted it, in words: `by ada`, or that the worker took an open type
 *  up themselves (ruling 9). */
export function grantedBy(g: Pick<Grant, "by">): string {
  if (g.by === OPEN_GRANT_BY) return "by themselves: the type is open";
  return g.by ? `by ${g.by}` : "";
}

/** A worker's live types, an open grant marked: `pets (open), ballots`. */
export function liveTypesText(w: Pick<Worker, "grants">): string {
  return w.grants.filter((g) => g.revokedAt === undefined).map((g) => (g.by === OPEN_GRANT_BY ? `${g.type} (open)` : g.type)).join(", ");
}

/** What a PAID OPEN type means for who earns, or null (ruling 12: the
 *  admin's call, said and never refused; the server's `openPayWarning` and
 *  `openPayProblem`): no qualifying lets anyone earn from their first
 *  answer, and one short of its K ready tests takes no newcomer. `ready`
 *  undefined: not counted here, so a shortfall is not said. */
export function openPayHint(d: { open: boolean; paySats: number; testsOn: boolean; qualify: number }, ready: number | undefined): string | null {
  if (!d.open || !(d.paySats > 0)) return null;
  if (!d.testsOn || !(d.qualify >= 1)) return "Paid and open with no qualifying tests: anyone signed in earns from their first answer, and your review is the only check.";
  if (ready !== undefined && ready < d.qualify) return `Paid and open: it qualifies newcomers on ${d.qualify} tests and has ${ready} ready, so it takes no new worker until they are.`;
  return null;
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

/** A file the task page draws at once, as a picture: an image's media type,
 *  or — a task's own files are paths alone — an image's extension. */
export function isPicture(path: string, mediaType?: string): boolean {
  return mediaType ? mediaType.startsWith("image/") : /\.(png|jpe?g|gif|webp|avif)$/i.test(path);
}

/** The files the task's answer carried: on the lease that gave it (a copies
 *  task's, the first that agreed). */
export function answerFiles(t: Pick<Task, "by" | "leases">): SentFile[] {
  return t.leases.find((l) => l.worker === t.by && l.status === "submitted")?.attachments ?? [];
}

/** Who gave a verdict, in words: a person as named, a run's own
 *  (`workflow:<name>`, task/reply's `verdict`) as its workflow. */
export function reviewerName(by: string): string {
  return by.startsWith("workflow:") ? `the workflow ${by.slice("workflow:".length)}` : by;
}

/** A verdict in words (§9.6): `rejected: blurry box · by ada, 14:02 ·
 *  changeable until Nov 16, 14:00`, `· changeable` (nothing paid yet on a
 *  type that pays once marked OK), or `· final`. */
export function reviewText(r: NonNullable<Lease["review"]>, now = Date.now()): string {
  const head = r.verdict === "rejected" ? `rejected${r.why ? `: ${r.why}` : ""}` : `ok${r.why ? `: ${r.why}` : ""}`;
  const who = ` · ${r.by ? `by ${reviewerName(r.by)}, ` : ""}${fmtWhen(r.at, now)}`;
  const when = r.final || (r.until !== undefined && r.until <= now) ? "final" : r.until === undefined ? "changeable" : `changeable until ${fmtWhen(r.until, now)}`;
  return `${head}${who} · ${when}`;
}

/** A group's tasks read at once: the routes' page at its largest. */
export const GROUP_TASKS = 1000;

/** A key as a label: `posted_by` → "Posted by". */
export function labelOf(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `title` and `ask` of what a task or a reply shows, when they are text. */
function wordsOf(show: unknown): string {
  if (typeof show === "string") return show.trim();
  if (!show || typeof show !== "object" || Array.isArray(show)) return "";
  const s = show as Record<string, unknown>;
  return [s["title"], s["ask"]].filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()).join(" · ");
}

/** What a task is called in a list: the words its run sent back after the
 *  answer (the reply's `title` and `ask`), else the words it asked with. */
export function captionOf(t: Pick<Task, "show" | "reply">): string {
  return wordsOf(t.reply?.show) || wordsOf(t.show);
}

/** What a task showed besides its words, in a line: its plain fields
 *  (`Listing: Oat milk 1 L`), the first `max` of them. */
export function shownLine(show: unknown, max = 2): string {
  if (!show || typeof show !== "object" || Array.isArray(show)) return "";
  return answerFields(Object.fromEntries(Object.entries(show as Record<string, unknown>).filter(([k]) => k !== "ask" && k !== "title")))
    .slice(0, max)
    .map(([k, v]) => `${labelOf(k)}: ${v}`)
    .join(" · ");
}

/** An answer's plain fields with a value, as label and text: what a list
 *  shows of an answer with no picture, and the answer page's short list. */
export function answerFields(answer: unknown): Array<[string, string]> {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(answer as Record<string, unknown>)) {
    if (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean") out.push([k, String(v)]);
  }
  return out;
}

/** The fields of an object answer left empty (`""`, null), by key. */
export function emptyFields(answer: unknown): string[] {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
  return Object.entries(answer as Record<string, unknown>).filter(([, v]) => v === null || v === undefined || (typeof v === "string" && !v.trim())).map(([k]) => k);
}

/** An answer in one line, for a row with no picture: `Title: Dune · Pages: 412`. */
export function answerLine(answer: unknown, max = 3): string {
  if (answer === undefined) return "";
  if (answer === null || typeof answer !== "object") return String(answer);
  const fields = answerFields(answer);
  return fields.length ? fields.slice(0, max).map(([k, v]) => `${labelOf(k)}: ${v}`).join(" · ") : jsonLine(answer, 60);
}

/** The picture a task is shown by: the reply's first (what the run made of
 *  the answer), else the answer's first. */
export function pictureOf(t: Pick<Task, "by" | "leases" | "reply">): SentFile | undefined {
  return t.reply?.files?.find((f) => isPicture(f.path, f.mediaType)) ?? answerFiles(t).find((f) => isPicture(f.path, f.mediaType));
}

/** The lease that gave the task's answer (a copies task's, the first that agreed). */
export function answerLease(t: Pick<Task, "by" | "leases">): Lease | undefined {
  return t.leases.find((l) => l.worker === t.by && l.status === "submitted");
}

/** How long an answer took its worker, taken to sent; "" while open. */
export function tookText(l: Pick<Lease, "taken" | "closed" | "status"> | undefined): string {
  return l && l.status === "submitted" && l.closed !== undefined ? fmtDuration(l.closed - l.taken) : "";
}

/** A clock time with its seconds, for a task's history. */
export function fmtClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** One line of a task's history. */
export interface Happening {
  at: number;
  text: string;
  /** The lease it is about: its earning, and Take back, sit on this line. */
  lease?: Lease;
}

/** What happened to a task, oldest first: made, each time someone took it
 *  and how that ended, the run's reply, each verdict. `who` names a worker. */
export function happenings(t: Task, who: (actor: string) => string, now = Date.now()): Happening[] {
  const out: Happening[] = [{ at: t.created, text: t.test ? "Served as a test" : "The run made the task" }];
  for (const l of t.leases) {
    out.push({ at: l.taken, text: `${who(l.worker)} took it` });
    const end = leaseOutcome(l, now);
    if (end !== "working") out.push({ at: l.closed ?? l.expires, text: l.status === "submitted" ? `${who(l.worker)} answered` : `${who(l.worker)}: ${end}`, ...(l.status === "submitted" ? { lease: l } : {}) });
    if (l.review) out.push({ at: l.review.at, text: `${l.review.by ?? "Staff"} marked ${t.leases.filter((x) => x.status === "submitted").length > 1 ? `${who(l.worker)}'s answer` : "it"} ${l.review.verdict === "ok" ? "OK" : "rejected"}` });
  }
  if (t.reply) out.push({ at: t.reply.at, text: "The run replied" });
  if (t.status !== "open" && t.status !== "settled" && t.settledAt) out.push({ at: t.settledAt, text: `The task ${STATUS_WORDS[t.status]}` });
  // Stable: lines of one moment keep the order above (taken, then answered).
  return out.map((h, i) => ({ h, i })).sort((a, b) => a.h.at - b.h.at || a.i - b.i).map(({ h }) => h);
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

// ── bringing workers in (§5.8, §9.5) ────────────────────────────────────────

/** A kind of work an invite can be for, as the invite panel offers it. */
export interface InviteChoice {
  name: string;
  /** What staff call it: its title and name, or its name. */
  label: string;
  /** Anyone signed in may take it; else invite-only, and the invite gives it. */
  open: boolean;
  /** The app that draws it. */
  app: string;
  /** That app is in the public view (or this server cannot say). */
  online: boolean;
}

/** The kinds of work an invite can be for: every type that is on, A–Z. */
export function inviteChoices(types: TaskType[] | undefined): InviteChoice[] {
  return (types ?? [])
    .filter((t) => t.enabled)
    .map((t) => ({ name: t.name, label: localText(t.title) ? `${localText(t.title)} (${t.name})` : t.name, open: t.open !== false, app: t.app, online: t.share ? t.share.public : true }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** What the invite does with the work chosen, in a line. */
export function inviteWorkText(choice: InviteChoice | undefined): string {
  if (!choice) return "Tasks shows them every kind of open work.";
  return choice.open ? "Open to anyone signed in: the link takes them straight to it." : "Invite-only: this link makes it theirs.";
}

/** Whether any work that is on is open: then the one link for a group is worth showing. */
export function anyOpenWork(types: TaskType[] | undefined): boolean {
  return (types ?? []).some((t) => t.enabled && t.open !== false);
}

// ── Invites (plans/human-steps.md §5.8) ─────────────────────────────────────

/** An invite's status in words. */
export const INVITE_WORDS: Record<InviteStatus, string> = {
  sending: "Getting it ready: the wallet is paying for it",
  ready: "Ready to send",
  failed: "Failed: the wallet could not pay for it",
  used: "Used: a worker signed up with it",
  cancelled: "Cancelled",
};

/** Whether an invite may still be used, so shared or cancelled. */
export function inviteOpen(i: Pick<Invite, "status">): boolean {
  return i.status === "sending" || i.status === "ready";
}

/** Newest first by createdAt; one without a time goes last, in its order. */
export function sortInvites<T extends Pick<Invite, "createdAt">>(invites: T[]): T[] {
  const t = (i: T) => (i.createdAt ? Date.parse(i.createdAt) : NaN);
  return invites
    .map((inv, n) => ({ inv, n }))
    .sort((a, b) => {
      const x = t(a.inv), y = t(b.inv);
      if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
      return (Number.isNaN(x) ? 0 : y - x) || a.n - b.n;
    })
    .map((e) => e.inv);
}

/** The worker who took an invite, and when: the grant it made (`by: invite:<code>`).
 *  None for an invite for open work (no grant) or one not yet used; else the server's `takenBy`. */
export function acceptedBy(invite: Pick<Invite, "code" | "takenBy">, workers: Array<Pick<Worker, "actor" | "name" | "grants">> | undefined): { who: string; at?: number } | null {
  for (const w of workers ?? []) {
    const g = w.grants.find((g) => g.by === `invite:${invite.code}`);
    if (g) return { who: w.name || shortActor(w.actor), at: g.at };
  }
  // No worker row (not loaded, or a host's own store): the server's own word on who took it, no time.
  return invite.takenBy ? { who: shortActor(invite.takenBy) } : null;
}

/** Days an invite's link works; mirrors INVITE_TOKEN_DAYS (src/payments/invites.ts). */
export const INVITE_LINK_DAYS = 90;

/** When an invite's link stops working (ms): the server's `expiresAt`, else createdAt + INVITE_LINK_DAYS. */
export function inviteExpiry(i: Pick<Invite, "createdAt" | "expiresAt">): number | null {
  const e = i.expiresAt ? Date.parse(i.expiresAt) : NaN;
  if (Number.isFinite(e)) return e;
  const c = i.createdAt ? Date.parse(i.createdAt) : NaN;
  return Number.isFinite(c) ? c + INVITE_LINK_DAYS * 86_400_000 : null;
}

/** An invite's badge: friendly label and colour classes. */
export function inviteBadge(status: InviteStatus): { label: string; className: string } {
  switch (status) {
    case "ready":
      return { label: "Ready · unused", className: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200" };
    case "used":
      return { label: "Used", className: "border-transparent bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200" };
    case "cancelled":
      return { label: "Cancelled", className: "border-transparent bg-muted text-muted-foreground line-through" };
    case "failed":
      return { label: "Failed", className: "border-transparent bg-destructive/15 text-destructive" };
    default:
      return { label: "Sending", className: "animate-pulse border-transparent bg-muted text-muted-foreground" };
  }
}

/** How often the invites are read (ms), or false for never: fast while one
 *  is being paid for, slowly while one waits to be used, as a backstop to the
 *  app's channel saying one was. */
export function invitesReadMs(invites: Array<Pick<Invite, "status">> | undefined): number | false {
  if (invites?.some((i) => i.status === "sending")) return 3_000;
  return invites?.some((i) => i.status === "ready") ? 30_000 : false;
}

/** Why this server cannot invite, in words a person who is not technical
 *  follows; the cause for whoever runs the server in brackets. */
export function inviteWhyText(why: NonNullable<InvitesAnswer["why"]>): string {
  return why === "no_pay_credential"
    ? "To invite people, this server's wallet has to be set up first, in Earnings. (No Sphinx daemon pay token.)"
    : "This server's wallet cannot make invites yet: it needs an update. (Its Sphinx daemon has no invite routes.)";
}

/** The words a worker is sent with the link. */
export function inviteMessage(link: string): string {
  return `You're invited to work with us. Open this on your phone to sign up with Peel: ${link}`;
}

/** The message as a WhatsApp share link (an https link a host opens). */
export function whatsappUrl(link: string): string {
  return `https://wa.me/?text=${encodeURIComponent(inviteMessage(link))}`;
}

/** An invite's sats as typed: a whole number 1 to 100,000. Blank is a problem (the box starts filled). */
export function inviteSatsOf(text: string): { sats: number } | { problem: string } {
  const t = text.trim();
  if (!t) return { problem: "Enter the sats they start with." };
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? { sats: n } : { problem: "A whole number of sats, 1 to 100,000." };
}

// ── Support (plans/support-chat.md) ─────────────────────────────────────────

/** Who a conversation is with, to staff: the worker's name as staff wrote it
 *  (their note's first line), else their own (`useNames`: the Sphinx name
 *  their DMs carry, plans/people-and-hosts.md §1), else the actor shortened. */
export function supportName(c: Pick<SupportConversation, "worker" | "alias">, worker?: Pick<Worker, "actor" | "note">): string {
  const noted = worker?.note?.split("\n")[0]?.trim();
  return noted || c.alias || shortActor(c.worker);
}

/** Two letters for a name's circle (ruling 13: initials, no pictures yet). */
export function initialsOf(name: string): string {
  const words = name.replace(/^secp:/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A task's id in a message (32 hex, src/tasks/tasks.ts): drawn as a link. */
const TASK_ID = /\b[0-9a-f]{32}\b/g;

/** A message's text in pieces, each task id its own (§3, task links). */
export function textPieces(text: string): Array<{ text: string } | { task: string }> {
  const out: Array<{ text: string } | { task: string }> = [];
  let at = 0;
  for (const m of text.matchAll(TASK_ID)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) });
    out.push({ task: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** A byte count, short: `820 B`, `14 KB`, `3.2 MB`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
}

/** Sats in a payment line: from the worker "Sent you 100 sats" (Support is
 *  "you"), from Support "Support sent 100 sats". Not in the books. */
export function paymentLine(m: Pick<SupportMessage, "fromMe" | "sats">): string {
  const sats = `${(m.sats ?? 0).toLocaleString("en-US")} sat${m.sats === 1 ? "" : "s"}`;
  return m.fromMe ? `Support sent ${sats}` : `Sent you ${sats}`;
}

/** A message in one line, for the conversation list and a quote. */
export function messageLine(m: SupportMessage): string {
  const body = (() => {
    if (m.deleted) return "Message deleted";
    if (m.kind === "contact") return "Added Support as a contact";
    if (m.kind === "payment") return paymentLine(m);
    if (m.kind === "file") {
      const what = m.file?.mediaType?.startsWith("image/") ? "Photo" : m.file?.mediaType?.startsWith("audio/") ? "Voice note" : (m.file?.name ?? "File");
      return m.text ? `${what}: ${m.text}` : what;
    }
    return m.text ?? "";
  })();
  return m.fromMe && (m.kind === "message" || m.kind === "file") && !m.deleted ? `Support: ${body}` : body;
}

/** What strut sent on its own, as the bubble names it. */
export const AUTO_LABELS: Record<NonNullable<SupportMessage["auto"]>, string> = { welcome: "Welcome", payout: "Payout" };

/** The list's filters (plans/support-chat.md §3, item 2), in order. */
export const SUPPORT_FILTERS: ReadonlyArray<{ id: SupportFilter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "mine", label: "Mine" },
  { id: "unassigned", label: "Unassigned" },
  { id: "done", label: "Done" },
];

/** The largest file staff send: the page's call is capped at 4 MB, base64 included. */
export const SUPPORT_FILE_MAX_BYTES = 2.5 * 1024 * 1024;
/** A photo staff send is shrunk to this many pixels on its longer side… */
export const SUPPORT_PHOTO_SIDE = 1600;
/** …and Support's own picture to this. */
export const SUPPORT_AVATAR_SIDE = 512;

/** Width and height that fit `max` on the longer side, never larger. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Shrunk in the page: a photo that is not animated or drawn (GIF, SVG). */
export function shrinkable(type: string): boolean {
  return /^image\/(jpeg|png|webp|bmp|avif|heic|heif)$/i.test(type);
}

/** A name with its extension made `.jpg`, for a photo shrunk to a JPEG. */
export function jpgName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "") || "photo";
  return `${base}.jpg`;
}

/** Why a file cannot be sent, or undefined: past 2.5 MB once shrunk. */
export function attachProblem(o: { size: number }): string | undefined {
  return o.size > SUPPORT_FILE_MAX_BYTES ? `Files up to ${fmtBytes(SUPPORT_FILE_MAX_BYTES)}: this one is ${fmtBytes(o.size)}.` : undefined;
}

