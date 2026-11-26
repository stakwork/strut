import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { parseGithubRepo } from "./create-pr.js";

const EXAMPLE = `- id: pr
  type: github/pr-status
  config:
    repo: "{{ input.repo }}"
    number: "{{ input.number }}"`;

/** The slice of Octokit this step reads — so a test can hand in a fake. */
export interface PrStatusApi {
  pulls: {
    get(p: { owner: string; repo: string; pull_number: number }): Promise<{ data: PullDetail }>;
  };
  checks: {
    listForRef(p: { owner: string; repo: string; ref: string; per_page: number }): Promise<{ data: { check_runs: CheckRun[] } }>;
  };
  repos: {
    getCombinedStatusForRef(p: { owner: string; repo: string; ref: string; per_page: number }): Promise<{ data: { statuses: CommitStatus[] } }>;
  };
  /** A GitHub Actions job's log, as text (GitHub redirects to it; the SDK
   *  follows). Only `logs` reads it. */
  actions?: {
    downloadJobLogsForWorkflowRun(p: { owner: string; repo: string; job_id: number }): Promise<{ data: unknown }>;
  };
}

export interface PullDetail {
  html_url: string;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  user?: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface CheckRun {
  /** For a GitHub Actions check, also its job's id. */
  id?: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  completed_at?: string | null;
  app?: { slug?: string } | null;
}

interface CommitStatus {
  context: string;
  state: string;
  target_url?: string | null;
  updated_at?: string | null;
}

export type PrState = "open" | "draft" | "merged" | "closed";
export type CheckStatus = "failed" | "running" | "passed" | "skipped";

export interface PrCheck {
  name: string;
  status: CheckStatus;
  url?: string;
  /** When it finished (GitHub's clock): absent while it runs. A re-run of a
   *  failed check finishes again, later. */
  finishedAt?: string;
  /** With `logs`, a failed GitHub Actions check's job log. */
  log?: CheckLog;
  /** With `logs`, why that log could not be had. */
  logError?: string;
}

/** A failed job's whole log, written to a file to grep: the cause of a
 *  failure is often thousands of lines above where the job ends. */
export interface CheckLog {
  /** Absolute path of the file: the log, each line's timestamp stripped. */
  path: string;
  lines: number;
  /** The lines up to the job's first `##[error]` (the failing step's end,
   *  or the first error a problem matcher marked), from that step's start,
   *  at most END_LINES; else the log's own last lines. */
  end: string;
}

/** Writes a log where the run keeps its files; returns the absolute path. */
export type LogWriter = (relPath: string, text: string) => Promise<string>;

/** Failed jobs whose logs one call reads, at most: a matrix fails wide. */
export const MAX_LOGS = 5;
const END_LINES = 40;

export interface PrStatus {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: PrState;
  author?: string;
  head: string;
  base: string;
  /** The commit the checks are of — what a merge names (`github/merge-pr { sha }`). */
  headSha: string;
  body?: string;
  /** GitHub's answer to "can it merge cleanly": false on a conflict, null
   *  while GitHub is still working it out. */
  mergeable: boolean | null;
  /** Failed first, then running, passed, skipped. */
  checks: PrCheck[];
  counts: { passed: number; failed: number; running: number; skipped: number; total: number };
}

const ORDER: Record<CheckStatus, number> = { failed: 0, running: 1, passed: 2, skipped: 3 };

/** A check run's state in four words. */
export function checkRunStatus(status: string, conclusion: string | null | undefined): CheckStatus {
  if (status !== "completed") return "running";
  if (conclusion === "success" || conclusion === "neutral") return "passed";
  if (conclusion === "skipped" || conclusion === "stale") return "skipped";
  return "failed";
}

/** A commit status (the older API: CI that posts statuses, not check runs). */
export function commitStatus(state: string): CheckStatus {
  return state === "success" ? "passed" : state === "pending" ? "running" : "failed";
}

export function prState(pr: Pick<PullDetail, "state" | "draft" | "merged" | "merged_at">): PrState {
  if (pr.merged || pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

/** A refusal in words a person reads: the token's problem, or the PR's. */
export function githubError(err: unknown, what: string): Error {
  const e = err as { status?: number; message?: string } | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const text = (e?.message ?? String(err)).split("\n")[0]!.slice(0, 300);
  if (status === 401) return new Error(`github_unauthorized: GitHub did not accept the token to ${what} — connect GitHub again`);
  if ((status === 403 || status === 429) && /rate limit/i.test(text)) return new Error(`github_rate_limited: GitHub's rate limit for this token is used up, so it could not ${what} — try again in a while`);
  if (status === 403 || status === 404) return new Error(`github_not_found: GitHub would not let this token ${what} (HTTP ${status}: ${text})`);
  return new Error(`github_error: could not ${what} (${status ?? "error"}: ${text})`);
}

const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/** Where GitHub starts a step's lines in a job log: `##[group]Run <step>`. */
const STEP = /^##\[group\]Run /;

/** A job log as text without its timestamps, and its end: the lines up to
 *  the first `##[error]`, from the start of the step it is in, else the
 *  log's last. A step that passed prints its warnings above the one that
 *  failed, and an end that reached up into them read as the cause
 *  (peel#614, 2026-11-26: a passing step's "set GITHUB_TOKEN" warning
 *  blamed for a failed dependency fetch). */
export function logOf(raw: string): { text: string; lines: number; end: string } {
  const lines = raw.replace(/\r?\n$/, "").split(/\r?\n/).map((l) => l.replace(STAMP, ""));
  const err = lines.findIndex((l) => l.includes("##[error]"));
  const stop = err >= 0 ? err + 1 : lines.length;
  let from = Math.max(0, stop - END_LINES);
  for (let i = err - 1; i > from; i--) {
    if (STEP.test(lines[i]!)) {
      from = i;
      break;
    }
  }
  return { text: lines.join("\n") + "\n", lines: lines.length, end: lines.slice(from, stop).join("\n") };
}

/** A failed Actions check's job log, written where the run keeps its files.
 *  A log GitHub will not give is said on the check, never thrown: the
 *  status is still the answer. */
async function attachLog(api: PrStatusApi, owner: string, repo: string, number: number, check: PrCheck, jobId: number, write: LogWriter): Promise<void> {
  if (!api.actions) {
    check.logError = "this client cannot read Actions logs";
    return;
  }
  let raw: string;
  try {
    const { data } = await api.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: jobId });
    raw = typeof data === "string" ? data : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? new TextDecoder().decode(data as ArrayBuffer) : String(data ?? "");
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const why = `GitHub would not give this token the job's log (HTTP ${e.status ?? "error"}: ${(e.message ?? String(err)).split("\n")[0]!.slice(0, 200)})`;
    check.logError = e.status === 403 ? `${why}: a GitHub App's token needs the App's "Actions: read" permission` : why;
    return;
  }
  const log = logOf(raw);
  const safe = check.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  try {
    const path = await write(`ci-logs/${owner}-${repo}-${number}/${safe}-${jobId}.log`, log.text);
    check.log = { path, lines: log.lines, end: log.end };
  } catch (err) {
    check.logError = `could not write the log: ${(err as Error).message}`;
  }
}

/** The pull request's state, its checks (check runs and commit statuses, by
 *  name, the newest of each), and what a merge needs. With `logs`, each
 *  failed Actions check (at most MAX_LOGS) carries its job's log. */
export async function readPullRequest(api: PrStatusApi, owner: string, repo: string, number: number, opts: { logs?: LogWriter } = {}): Promise<PrStatus> {
  let pr: PullDetail;
  try {
    pr = (await api.pulls.get({ owner, repo, pull_number: number })).data;
  } catch (err) {
    throw githubError(err, `read ${owner}/${repo}#${number}`);
  }
  const ref = pr.head.sha;
  const [runs, statuses] = await Promise.all([
    api.checks.listForRef({ owner, repo, ref, per_page: 100 }).then((r) => r.data.check_runs).catch(() => [] as CheckRun[]),
    api.repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100 }).then((r) => r.data.statuses).catch(() => [] as CommitStatus[]),
  ]);
  const byName = new Map<string, PrCheck>();
  const actionsJob = new Map<PrCheck, number>();
  for (const c of runs) {
    if (byName.has(c.name)) continue; // the API lists the newest run of a name first
    const url = c.html_url ?? c.details_url ?? undefined;
    const status = checkRunStatus(c.status, c.conclusion);
    const check: PrCheck = { name: c.name, status, ...(url ? { url } : {}), ...(status !== "running" && c.completed_at ? { finishedAt: c.completed_at } : {}) };
    byName.set(c.name, check);
    if (c.app?.slug === "github-actions" && typeof c.id === "number") actionsJob.set(check, c.id);
  }
  for (const s of statuses) {
    if (byName.has(s.context)) continue;
    const status = commitStatus(s.state);
    byName.set(s.context, { name: s.context, status, ...(s.target_url ? { url: s.target_url } : {}), ...(status !== "running" && s.updated_at ? { finishedAt: s.updated_at } : {}) });
  }
  const checks = [...byName.values()].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
  if (opts.logs) {
    const failed = checks.filter((c) => c.status === "failed" && actionsJob.has(c)).slice(0, MAX_LOGS);
    await Promise.all(failed.map((c) => attachLog(api, owner, repo, number, c, actionsJob.get(c)!, opts.logs!)));
  }
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return {
    url: pr.html_url,
    repo: `${owner}/${repo}`,
    number: pr.number,
    title: pr.title,
    state: prState(pr),
    ...(pr.user?.login ? { author: pr.user.login } : {}),
    head: pr.head.ref,
    base: pr.base.ref,
    headSha: pr.head.sha,
    ...(pr.body ? { body: pr.body } : {}),
    mergeable: pr.mergeable ?? null,
    checks,
    counts: { passed: count("passed"), failed: count("failed"), running: count("running"), skipped: count("skipped"), total: checks.length },
  };
}

/**
 * A pull request as it is on GitHub now: open, draft, merged or closed, its
 * branches, its checks (failed first), whether it can merge. Read with the
 * RUN'S token — on a person's run, theirs (plans/code-change.md §3.2) — so
 * strut's own app shows each person the pull requests they can see.
 */
export default defineStep({
  type: "github/pr-status",
  secrets: ["GITHUB_TOKEN"],
  effect: "read",
  description:
    `A GitHub pull request as it is now: { url, repo, number, title, state (open | draft | merged | closed), author, head, base, headSha, body, mergeable, checks: [{ name, status (failed | running | passed | skipped), url, finishedAt }], counts }. ` +
    `Checks are the head commit's check runs and commit statuses, failed first. ` +
    `With logs: true, each failed GitHub Actions check (at most ${MAX_LOGS}) also has log: { path, lines, end }: its job's whole log in a file (timestamps stripped) and the failing step's lines up to the job's first error. ` +
    `The cause is often thousands of lines above the end, so search the file (rg in bash). A log GitHub refuses is logError on the check (a GitHub App's token needs "Actions: read"). ` +
    `Auth: token, else the GITHUB_TOKEN secret. ` +
    `Fails with "github_unauthorized: …", "github_not_found: …" (the token cannot see it), "github_rate_limited: …" or "github_error: …".\n\n${EXAMPLE}`,
  input: z.object({
    repo: z.string().min(1).describe('"owner/repo" or https://github.com/owner/repo'),
    number: z.coerce.number().int().positive().describe("pull request number"),
    token: z.string().optional().describe("GitHub token; omit to use the GITHUB_TOKEN secret"),
    logs: z.boolean().optional().describe("Also read each failed GitHub Actions job's log into a file to search: why a check failed"),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { owner, repo } = parseGithubRepo(cfg.repo);
    // Lazy-load the SDK inside run() — AGENTS.md "Lib step dependency convention".
    const { Octokit } = await import("@octokit/rest");
    const auth = cfg.token ?? (await ctx?.services?.secrets?.get("GITHUB_TOKEN"));
    const api = new Octokit(auth ? { auth } : {}) as unknown as PrStatusApi;
    // A log goes in the run's files, where `bash` can search it by its path.
    const artifacts = ctx?.services?.artifacts;
    const logs: LogWriter | undefined =
      cfg.logs && ctx?.runId
        ? artifacts
          ? (rel, text) => artifacts.write(ctx.runId, rel, text)
          : async () => Promise.reject(new Error("this run has no place to keep files (no artifacts)"))
        : undefined;
    return readPullRequest(api, owner, repo, cfg.number, { logs });
  },
});
