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
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
}

interface CommitStatus {
  context: string;
  state: string;
  target_url?: string | null;
}

export type PrState = "open" | "draft" | "merged" | "closed";
export type CheckStatus = "failed" | "running" | "passed" | "skipped";

export interface PrCheck {
  name: string;
  status: CheckStatus;
  url?: string;
}

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
  if (status === 403 || status === 404) return new Error(`github_not_found: GitHub would not let this token ${what} (HTTP ${status}: ${text})`);
  return new Error(`github_error: could not ${what} (${status ?? "error"}: ${text})`);
}

/** The pull request's state, its checks (check runs and commit statuses, by
 *  name, the newest of each), and what a merge needs. */
export async function readPullRequest(api: PrStatusApi, owner: string, repo: string, number: number): Promise<PrStatus> {
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
  for (const c of runs) {
    if (byName.has(c.name)) continue; // the API lists the newest run of a name first
    const url = c.html_url ?? c.details_url ?? undefined;
    byName.set(c.name, { name: c.name, status: checkRunStatus(c.status, c.conclusion), ...(url ? { url } : {}) });
  }
  for (const s of statuses) {
    if (byName.has(s.context)) continue;
    byName.set(s.context, { name: s.context, status: commitStatus(s.state), ...(s.target_url ? { url: s.target_url } : {}) });
  }
  const checks = [...byName.values()].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
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
    `A GitHub pull request as it is now: { url, repo, number, title, state (open | draft | merged | closed), author, head, base, headSha, body, mergeable, checks: [{ name, status (failed | running | passed | skipped), url }], counts }. ` +
    `Checks are the head commit's check runs and commit statuses, failed first. Auth: token, else the GITHUB_TOKEN secret. ` +
    `Fails with "github_unauthorized: …", "github_not_found: …" (the token cannot see it) or "github_error: …".\n\n${EXAMPLE}`,
  input: z.object({
    repo: z.string().min(1).describe('"owner/repo" or https://github.com/owner/repo'),
    number: z.coerce.number().int().positive().describe("pull request number"),
    token: z.string().optional().describe("GitHub token; omit to use the GITHUB_TOKEN secret"),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { owner, repo } = parseGithubRepo(cfg.repo);
    // Lazy-load the SDK inside run() — AGENTS.md "Lib step dependency convention".
    const { Octokit } = await import("@octokit/rest");
    const auth = cfg.token ?? (await ctx?.services?.secrets?.get("GITHUB_TOKEN"));
    const api = new Octokit(auth ? { auth } : {}) as unknown as PrStatusApi;
    return readPullRequest(api, owner, repo, cfg.number);
  },
});
