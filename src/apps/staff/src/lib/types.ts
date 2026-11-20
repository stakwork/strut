// What the `/tasks` routes answer, as the page reads them (specs/API.md §22,
// plans/human-steps.md §9.4). Fields a server may not answer — a host's own
// task store, an older strut — are optional, and the page shows a part only
// when its field is there (§9.7).
import type { AnswerSchema } from "@strut/kit/folds";

export type TaskStatus = "open" | "settled" | "expired" | "cancelled" | "disputed";
export type WorkerStatus = "new" | "active" | "suspended" | "banned";
export type GradeRule = "equal" | { step: string; config?: Record<string, unknown> };

export interface TestRules {
  rate: number;
  newRate: number;
  newTasks: number;
  qualify: number;
  window: number;
  minGraded: number;
  threshold: number;
  grade: GradeRule;
  gradeCapUsd: number;
}

export interface CopiesRule {
  max: number;
  agree: number;
  compare: GradeRule;
  onDisagree: "more" | "fail";
}

export interface TaskType {
  name: string;
  /** What workers call it, in their language (plans/i18n.md); absent: its name. */
  title?: string;
  app: string;
  answer: AnswerSchema;
  leaseSeconds: number;
  withinHours: number;
  enabled: boolean;
  /** Ruling 9: open to any signed-in worker (true) or invite-only. Absent on
   *  a server from before open types, which has no choice to show. */
  open?: boolean;
  /** 5a: absent when unpaid. `holdHours` is there on a server that pays. */
  paySats?: number;
  holdHours?: number;
  /** The most it pays in all, and the most tasks one worker takes a day. */
  limits?: { budgetSats?: number; perWorkerDay?: number };
  tests?: TestRules;
  copies?: CopiesRule;
  /** The files an answer carries (plans/human-steps.md §5.6); absent: none. */
  attachments?: AttachmentRule;
  /** A standing type (plans/human-steps.md §5.7): a worker's ask makes the
   *  task, and each answer starts this workflow. Absent: a human step makes
   *  its tasks. */
  standing?: { workflow: string };
  /** A ROUND type: this workflow's runs make its tasks, one for each item,
   *  and Send a round launches it (`staff/send-round`). */
  round?: { workflow: string };
  /** Its check before an answer is accepted (plans/human-steps.md §5.6.7
   *  c): a sealed step; one that fails is refused, and earns nothing. */
  check?: { step: string; config?: Record<string, unknown> };
  changedAt: number;
  changedBy?: string;
  /** Where its workers answer it (§9.5): whether its app is in the public
   *  view, and then its links and a QR of the Peel one. Absent on a server
   *  whose public view has no share read. */
  share?: TypeShare;
}

export interface TypeShare {
  public: boolean;
  /** The visitor's page in a browser. */
  link?: string;
  /** The same page opened in Peel. */
  peelLink?: string;
  /** `peelLink` as a QR code, an SVG. */
  qrSvg?: string;
}

export interface AttachmentRule {
  max: number;
  min: number;
  types: string[];
}

/** A file an answer carried, under the task's run's artifacts. */
export interface SentFile {
  name: string;
  mediaType: string;
  size: number;
  path: string;
}

export interface Percentiles {
  p50: number;
  p90: number;
}

export interface StatsWindowView {
  answered: number;
  expired: number;
  cancelled: number;
  disputed: number;
  skipped: number;
  leasesLost: number;
  toAnswer?: Percentiles;
  work?: Percentiles;
}

export type StatsWindow = "hour" | "day" | "week";

export interface TypeStats {
  type: string;
  app: string;
  enabled: boolean;
  waiting: number;
  working: number;
  oldest?: number;
  dueSoon: number;
  dueHour: number;
  granted: number;
  holding: number;
  asking: number;
  /** Its ready tests (ruling 9: a paid open type needs its K of them). */
  readyTests?: number;
  windows: Record<StatsWindow, StatsWindowView>;
  appProblem?: string;
}

export interface TaskStats {
  at: number;
  types: TypeStats[];
  workers: Record<WorkerStatus, number>;
  holding: number;
  asking: number;
}

export interface Grant {
  type: string;
  /** Who granted it: an admin, or `open` (OPEN_GRANT_BY) when the worker's
   *  first ask of an open type recorded it (ruling 9). */
  by?: string;
  at: number;
  revokedAt?: number;
  revokedBy?: string;
  why?: string;
  qualify?: number;
}

export interface Balance {
  totalMsat: number;
  heldMsat: number;
  withdrawableMsat: number;
  nextReleaseAt?: number;
}

export interface Standing {
  qualifying: boolean;
  qualify: number;
  window: number;
  graded: number;
  passed: number;
  /** §9.6: of `graded`, answers rejected in review (each a fail). */
  rejected?: number;
  errors: number;
  pending: number;
  minGraded: number;
  threshold: number;
}

export interface Worker {
  actor: string;
  status: WorkerStatus;
  firstSeen: number;
  changedAt: number;
  changedBy?: string;
  note?: string;
  /** Their name (`people/names`, plans/people-and-hosts.md §1): not the
   *  route's answer; the page adds it. */
  name?: string;
  grants: Grant[];
  /** 5a and 4: there on a server that answers for them. */
  balance?: Balance;
  standing?: Record<string, Standing>;
  week?: number;
  holding?: string;
}

export interface WorkerActivity {
  holding?: { lease: string; task: string; type: string; expires: number };
  week?: Record<string, { answered: number; skipped: number; lost: number }>;
  recent?: Array<{ lease: Lease; task: { id: string; type: string; workflow: string; runId: string; status: TaskStatus; test?: string } }>;
}

export interface Earning {
  msat: number;
  at: number;
  releases: number;
  takenBack?: number;
  takenBackWhy?: string;
  takenBackBy?: string;
}

export type Verdict = "ok" | "rejected";

/** A verdict on one answer (plans/human-steps.md §9.6): `until` is when it
 *  can no longer change, `final` whether that has passed. */
export interface Review {
  verdict: Verdict;
  why?: string;
  by?: string;
  at: number;
  until: number;
  final: boolean;
}

export interface Lease {
  id: string;
  task: string;
  worker: string;
  type: string;
  taken: number;
  expires: number;
  status: "open" | "submitted" | "expired" | "skipped";
  closed?: number;
  reason?: string;
  payMsat?: number;
  answer?: unknown;
  agrees?: boolean;
  /** The files its answer carried (§5.6). */
  attachments?: SentFile[];
  earning?: Earning;
  review?: Review;
}

export interface Task {
  id: string;
  seq: number;
  type: string;
  workflow: string;
  runId: string;
  path: string;
  show: unknown;
  files: string[];
  root: "run" | "job" | "test";
  job?: string;
  status: TaskStatus;
  created: number;
  due: number;
  settledAt?: number;
  answer?: unknown;
  by?: string;
  copies?: number;
  test?: string;
  servedTo?: string;
  grade?: "pass" | "fail" | "error";
  gradedAt?: number;
  leases: Lease[];
  /** What the run told the workers who answered (its `task/reply`), its
   *  files read through `staff/file`. Absent: it told them nothing. */
  reply?: TaskReply;
}

/** A run's reply after the answer: a JSON object and files of its run. */
export interface TaskReply {
  show?: Record<string, unknown>;
  files?: SentFile[];
  at: number;
}

export interface TaskRun {
  status: string;
  waitingOn?: string[];
}

export interface Test {
  id: string;
  type: string;
  show: unknown;
  files: string[];
  expected: unknown;
  grade?: GradeRule;
  fromTask?: string;
  fromWorker?: string;
  ready: boolean;
  created: number;
  createdBy?: string;
  retired?: number;
  retiredBy?: string;
  served: number;
  passed: number;
  failed: number;
  errors: number;
  missing?: string[];
}

export interface TestInstance {
  task: string;
  lease?: string;
  worker: string;
  status: TaskStatus;
  served: number;
  answer?: unknown;
  answeredAt?: number;
  grade?: "pass" | "fail" | "error";
  gradedAt?: number;
  note?: string;
}

/** One of a task's files, as `run/files` answers one. */
export interface TaskFile {
  path: string;
  mediaType: string;
  bytes: number;
  text?: string;
  base64?: string;
  truncated?: true;
}

/** `earnings/read`'s parts the Queue's line reads (§8.1, "The books"). */
/** What a round of a round type sends (`staff/round-items`): the workflow's
 *  list, each item as a person reads it, and the newest round. `input`:
 *  the name the ticked items go under; absent, the workflow has no list. */
export interface RoundInfo {
  type: string;
  workflow: string;
  input?: string;
  items: Array<{ label: string; value: unknown }>;
  last?: { runId: string; at: number; tasks: number };
}

export interface Books {
  workers?: { owedMsat: number; heldMsat: number; withdrawableMsat: number; payees: number; accepted: { answers: number; msat: number; days: Array<{ day: string; answers: number; msat: number; takenBackAnswers: number; takenBackMsat: number }> }; takenBack: { answers: number; msat: number } };
  wallet?: { balance?: { msat: number; usd?: number }; rate?: number; owedToWorkersMsat?: number; coverMsat?: number; error?: string };
}

export type PayoutStateName = "out" | "paid" | "failed";

/** One payout, as `GET /tasks/payouts` lists it (src/payments/ledger.ts). */
export interface Payout {
  key: string;
  worker: string;
  address: string;
  msat: number;
  maxFeeMsat: number;
  state: PayoutStateName;
  /** Still out a day after it was sent: it waits for a person. */
  stale: boolean;
  at: number;
  day: string;
  feeMsat?: number;
  paymentHash?: string;
  ended?: number;
  why?: string;
  by?: string;
}

export interface PayoutSettings {
  on: boolean;
  minSats: number;
  workerDaySats: number;
  serverDaySats: number;
  /** An invite's starting sats when staff name none (§5.8); absent on a
   *  strut from before. */
  inviteSats?: number;
  changedBy?: string;
  changedAt?: number;
}

export interface PayoutsAnswer {
  settings: PayoutSettings;
  today: { day: string; paidMsat: number; outMsat: number; count: number; serverLeftMsat: number };
  payouts: Payout[];
}

export type InviteStatus = "sending" | "ready" | "failed" | "used" | "cancelled";

/** One worker invite, as `GET /tasks/invites` lists it (src/payments/invites.ts). */
export interface Invite {
  code: string;
  /** `https://<public view>/public/join#…`: what the worker is sent. It opens Tasks. */
  link?: string;
  sats: number;
  status: InviteStatus;
  createdAt?: string;
  /** The kind of work it is for (and gives, when invite-only); none: open work. */
  type?: string;
  /** When its link stops working (ISO). */
  expiresAt?: string;
  /** The admin who made it (an actor), when it was noted. */
  by?: string;
}

export interface InvitesAnswer {
  invites: Invite[];
  /** What an invite gives when it names none. */
  sats: number;
  why?: "no_pay_credential" | "no_invites";
}

/** `staff/invite`'s answer: the invite and its link as a QR code (an SVG). */
export type MadeInvite = Invite & { qrSvg?: string };

// ── Support (plans/people-and-hosts.md §5; db/001-support.sql) ─────────────

export type SupportKind = "message" | "file" | "payment" | "contact";
export type SendStatus = "sending" | "sent" | "failed";

/** One message of a conversation, as the thread draws it (`messageOf`,
 *  lib/support.ts): a deleted one without its text or file; never who sent
 *  it (every reply is Support's). */
export interface SupportMessage {
  /** Strut's own order. */
  key: number;
  /** The Sphinx id, once the daemon gave one: what a reply quotes. */
  id?: string;
  fromMe: boolean;
  kind: SupportKind;
  text?: string;
  replyTo?: string;
  sats?: number;
  deleted?: true;
  /** `state` absent: a file of Support's sent from elsewhere, not kept here. */
  file?: { name?: string; mediaType?: string; size?: number; state?: "kept" | "too_large" | "failed"; error?: string };
  status?: SendStatus;
  error?: string;
  at: number;
  /** Sent by strut on its own: the welcome, a payout's line. */
  auto?: "welcome" | "payout";
}

export interface SupportConversation {
  /** The worker's actor. */
  worker: string;
  pubkey: string;
  /** Their name (`useNames`). */
  alias?: string;
  unread: number;
  last?: SupportMessage;
  seenAt?: number;
  welcomedAt?: number;
  /** `done` until the worker writes again. */
  status: "open" | "done";
  /** Who took it, relative to the viewer: no names (ruling 4). */
  assigned?: "me" | "other";
}

/** Which conversations the list shows. */
export type SupportFilter = "open" | "mine" | "unassigned" | "done";

export interface SupportSettings {
  welcome: string;
  since?: number;
  savedAt?: number;
  /** "Paid you 1,200 sats" from Support when a payout settles. */
  payoutLines: boolean;
  /** Support's picture: the URL workers' Peel loads, and the bytes to show here. */
  photo?: { url: string; mediaType: string; base64?: string };
}

/** One piece of a file (`support/file`): `next` is where the next piece
 *  starts; the pieces' base64 joins as one. */
export interface SupportFile {
  key: number;
  name?: string;
  mediaType: string;
  bytes: number;
  offset: number;
  base64: string;
  next?: number;
}

/** `staff/numbers`: a type's spend against its limits, and what each worker
 *  did of it in the last `days`. */
export interface TypeNumbers {
  type: string;
  title?: string;
  enabled: boolean;
  open: boolean;
  paySats?: number;
  limits?: { budgetSats?: number; perWorkerDay?: number };
  spentSats: number;
  workingSats: number;
  days: number;
  answered: number;
  workers: Array<{ worker: string; answered: number; workMinutes: number; perHour?: number; earnedSats: number }>;
}
