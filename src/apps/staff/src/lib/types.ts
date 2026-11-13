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
  app: string;
  answer: AnswerSchema;
  leaseSeconds: number;
  withinHours: number;
  enabled: boolean;
  /** 5a: absent when unpaid. `holdHours` is there on a server that pays. */
  paySats?: number;
  holdHours?: number;
  tests?: TestRules;
  copies?: CopiesRule;
  changedAt: number;
  changedBy?: string;
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
  earning?: Earning;
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
export interface Books {
  workers?: { owedMsat: number; heldMsat: number; withdrawableMsat: number; payees: number; accepted: { answers: number; msat: number; days: Array<{ day: string; answers: number; msat: number; takenBackAnswers: number; takenBackMsat: number }> }; takenBack: { answers: number; msat: number } };
  wallet?: { balance?: { msat: number; usd?: number }; rate?: number; owedToWorkersMsat?: number; coverMsat?: number; error?: string };
}
