// A job's card, its pure parts — tested by src/apps/jamie.test.ts: how a
// turn ended in a pill, the live strip's tally (Hive's `JobLiveStrip`), a
// claim's pill and its open slot (Hive's claims viewer), and a captcha's
// manifest, taps and answer (strut's src/browser/captcha.ts, the job's
// `[captcha-answer]` turn).

import type { LastVerify, LedgerClaim } from "./types";

export type Tone = "running" | "ok" | "attention" | "failed" | "muted" | "merged";

export interface Look {
  label: string;
  tone: Tone;
}

/** How a job's turn ended, as its pill says it. */
export function jobLook(status: string | undefined, ask?: unknown): Look {
  switch (status) {
    case "running":
    case "paused":
    case "pending":
      return { label: status === "paused" ? "Paused" : "Running", tone: "running" };
    case "success":
      return ask ? { label: "Needs an answer", tone: "attention" } : { label: "Done", tone: "ok" };
    case "error":
      return { label: "Failed", tone: "failed" };
    case "cancelled":
      return { label: "Stopped", tone: "muted" };
    case "stale":
      return { label: "Lost", tone: "muted" };
    default:
      return { label: "Ended", tone: "muted" };
  }
}

/** One job update as `job/updates` returns it (the kit's `JobUpdate`). */
export interface LiveUpdate {
  kind: string;
  at: string;
  runId?: string;
  url?: string;
  id?: string;
  title?: string;
  state?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const VERDICTS: Array<[state: string, word: string]> = [
  ["supported", "supported"],
  ["refuted", "refuted"],
  ["planned", "waiting on a look"],
];

/** What the live strip says under a running job: its own line of what it
 *  is doing (`status`, the newest), and how many of each other thing —
 *  recordings, shots, what it holds, the checks' verdicts — never a list.
 *  Only updates of the run in flight (`runId`) when it is known. */
export function liveStrip(updates: readonly LiveUpdate[], runId?: string): { status?: string; tally: string[]; shot?: LiveUpdate } {
  const mine = runId ? updates.filter((u) => !u.runId || u.runId === runId) : updates;
  let status: string | undefined;
  for (let i = mine.length - 1; i >= 0; i--) if (mine[i]!.kind === "status" && mine[i]!.title) { status = mine[i]!.title; break; }
  const things = mine.filter((u) => u.kind !== "status" && u.kind !== "graph" && u.kind !== "verify" && u.kind !== "proposal");
  const tally: string[] = [];
  const recordings = things.filter((u) => u.kind === "walkthrough");
  if (recordings.length) {
    const stopped = recordings.filter((u) => u.state === "stopped").length;
    tally.push(`${plural(recordings.length, "recording")}${stopped ? `, ${stopped} stopped` : ""}`);
  }
  const shots = things.filter((u) => u.kind === "image").length;
  if (shots) tally.push(plural(shots, "shot"));
  const held = things.filter((u) => u.state === "held");
  for (const kind of new Set(held.map((u) => u.kind))) {
    const n = held.filter((u) => u.kind === kind).length;
    tally.push(`${n === 1 ? kind : plural(n, kind)} held`);
  }
  const evidence = things.filter((u) => u.kind === "evidence");
  if (evidence.length) {
    const words = VERDICTS.map(([state, word]) => [evidence.filter((u) => u.state === state).length, word] as const)
      .filter(([n]) => n > 0)
      .map(([n, word]) => `${n} ${word}`);
    tally.push(`${plural(evidence.length, "check")}${words.length ? `: ${words.join(", ")}` : ""}`);
  }
  // The newest picture it took (the store keeps the newest last).
  const visuals = things.filter((u) => (u.kind === "image" || u.kind === "walkthrough") && u.url);
  const shot = visuals[visuals.length - 1];
  return { ...(status ? { status } : {}), tally, ...(shot ? { shot } : {}) };
}

/** A claim's pill: its status, or that it waits on a person's look. */
export type ClaimPill = LedgerClaim["status"] | "needs a look";

/** The evidence id an external check waits on (a person's look), if any. */
export function openSlot(claim: Pick<LedgerClaim, "checks">): string | undefined {
  for (const c of claim.checks) {
    const v: LastVerify | undefined = c.lastVerify;
    if (v && "planned" in v) return v.planned;
  }
  return undefined;
}

export function claimPill(claim: LedgerClaim): ClaimPill {
  return openSlot(claim) && claim.status !== "refuted" ? "needs a look" : claim.status;
}

/** How a check did on the latest pass, in words. */
export function checkWords(v: LastVerify | undefined): string | null {
  if (!v) return null;
  if ("ran" in v) return "ran";
  if ("pending" in v) return "running";
  if ("planned" in v) return "waiting on a person";
  switch (v.skipped) {
    case "superseded":
      return "superseded — a newer turn";
    case "cannot-launch":
      return v.reason ? `couldn't run: ${v.reason}` : "couldn't run";
    case "budget":
      return "skipped: over the verify budget";
    case "policy":
      return "not due";
    default:
      return v.reason ? `skipped (${v.skipped}): ${v.reason}` : `skipped (${v.skipped})`;
  }
}

/** Claims that need the person first: a look, then refuted, then the rest. */
export function sortClaims(claims: readonly LedgerClaim[]): LedgerClaim[] {
  const rank = (c: LedgerClaim) => ({ "needs a look": 0, refuted: 1, unknown: 2, stale: 3, supported: 4 })[claimPill(c)];
  return [...claims].sort((a, b) => rank(a) - rank(b));
}

// ── captchas ───────────────────────────────────────────────────────────────

export interface CaptchaManifest {
  image: string;
  instruction?: string;
  site: string;
  mode: "tap" | "text" | "either";
  round: number;
  maxRounds: number;
  grid?: { rows: number; cols: number };
  askedAt?: string;
  expiresAt?: string;
  state: "waiting" | "sent" | "solved" | "failed" | "expired";
}

/** A captcha round's manifest (src/browser/captcha.ts), or null when it is not one. */
export function parseCaptcha(text: string | undefined): CaptchaManifest | null {
  if (!text) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw["image"] !== "string" || typeof raw["site"] !== "string" || typeof raw["round"] !== "number") return null;
  const mode = raw["mode"] === "tap" || raw["mode"] === "text" ? raw["mode"] : "either";
  const states = ["waiting", "sent", "solved", "failed", "expired"] as const;
  const state = states.find((s) => s === raw["state"]) ?? "waiting";
  const g = raw["grid"] as { rows?: unknown; cols?: unknown } | undefined;
  const grid = g && typeof g.rows === "number" && typeof g.cols === "number" && g.rows > 0 && g.cols > 0 ? { rows: g.rows, cols: g.cols } : undefined;
  return {
    image: raw["image"],
    ...(typeof raw["instruction"] === "string" ? { instruction: raw["instruction"] } : {}),
    site: raw["site"],
    mode,
    round: raw["round"],
    maxRounds: typeof raw["maxRounds"] === "number" ? raw["maxRounds"] : 5,
    ...(grid ? { grid } : {}),
    ...(typeof raw["askedAt"] === "string" ? { askedAt: raw["askedAt"] } : {}),
    ...(typeof raw["expiresAt"] === "string" ? { expiresAt: raw["expiresAt"] } : {}),
    state,
  };
}

export interface Tap {
  nx: number;
  ny: number;
}

/** A pointer at (x, y) on an image's box, as fractions of it. */
export function tapAt(x: number, y: number, box: { left: number; top: number; width: number; height: number }): Tap {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { nx: clamp((x - box.left) / box.width), ny: clamp((y - box.top) / box.height), };
}

/** A grid's cell under a tap. */
export const cellOf = (t: Tap, grid: { rows: number; cols: number }) => ({
  row: Math.min(grid.rows - 1, Math.floor(t.ny * grid.rows)),
  col: Math.min(grid.cols - 1, Math.floor(t.nx * grid.cols)),
});

/** A tap on a grid toggles its cell, kept as the cell's centre. */
export function toggleCell(taps: readonly Tap[], t: Tap, grid: { rows: number; cols: number }): Tap[] {
  const { row, col } = cellOf(t, grid);
  const centre = { nx: (col + 0.5) / grid.cols, ny: (row + 0.5) / grid.rows };
  const at = taps.findIndex((x) => { const c = cellOf(x, grid); return c.row === row && c.col === col; });
  return at >= 0 ? taps.filter((_, i) => i !== at) : [...taps, centre];
}

export type CaptchaAnswer = { round: number; site: string } & ({ taps: Tap[] } | { text: string } | { skip: true });

/** The job's next turn: `[captcha-answer] {…}` on its first line (the job
 *  runs browser-captcha with it, job.yaml). */
export function captchaPrompt(answer: CaptchaAnswer): string {
  return `[captcha-answer] ${JSON.stringify(answer)}`;
}

/** Milliseconds left before a round expires (null with no clock). */
export function msLeft(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? null : t - now;
}
