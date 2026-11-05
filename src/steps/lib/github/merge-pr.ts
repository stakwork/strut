import { z } from "zod";
import { defineStep, isFirstParty, workflowOf, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";
import { parseGithubRepo } from "./create-pr.js";
import { githubError, prState, type PullDetail } from "./pr-status.js";

export type MergeMethod = "squash" | "merge" | "rebase";

/** The slice of Octokit a merge uses — so a test can hand in a fake. */
export interface MergeApi {
  pulls: {
    get(p: { owner: string; repo: string; pull_number: number }): Promise<{ data: PullDetail }>;
    merge(p: { owner: string; repo: string; pull_number: number; sha: string; merge_method: MergeMethod }): Promise<{ data: { merged: boolean; sha: string; message?: string } }>;
  };
  repos: {
    get(p: { owner: string; repo: string }): Promise<{ data: { allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean } }>;
  };
}

export interface MergeResult {
  merged: true;
  url: string;
  /** The commit the merge made. */
  sha: string;
  method: MergeMethod;
}

/** Merge `number` at `sha` (the head the person looked at; default the
 *  current head), by `method` — or, when the repository does not allow it,
 *  the first method it does. Refused, with the reason, when it is not open,
 *  is a draft, conflicts, or its head moved past `sha`. */
export async function mergePullRequest(api: MergeApi, a: { owner: string; repo: string; number: number; sha?: string; method?: MergeMethod }): Promise<MergeResult> {
  const name = `${a.owner}/${a.repo}#${a.number}`;
  let pr: PullDetail;
  try {
    pr = (await api.pulls.get({ owner: a.owner, repo: a.repo, pull_number: a.number })).data;
  } catch (err) {
    throw githubError(err, `read ${name}`);
  }
  const state = prState(pr);
  if (state === "merged") throw new Error(`pr_not_mergeable: ${name} is already merged`);
  if (state === "closed") throw new Error(`pr_not_mergeable: ${name} is closed`);
  if (state === "draft") throw new Error(`pr_not_mergeable: ${name} is a draft — mark it ready for review first`);
  if (pr.mergeable === false) throw new Error(`pr_not_mergeable: ${name} has conflicts with ${pr.base.ref}`);
  if (a.sha && pr.head.sha !== a.sha) throw new Error(`pr_head_moved: ${name} has new commits since you looked — look at it again before merging`);
  const sha = pr.head.sha;
  const attempt = async (method: MergeMethod) => (await api.pulls.merge({ owner: a.owner, repo: a.repo, pull_number: a.number, sha, merge_method: method })).data;
  let method = a.method ?? "squash";
  let done: { merged: boolean; sha: string; message?: string };
  try {
    done = await attempt(method);
  } catch (err) {
    // 405: the method is not allowed here (or GitHub will not merge it now).
    if ((err as { status?: number })?.status !== 405) throw githubError(err, `merge ${name}`);
    const allowed = await api.repos.get({ owner: a.owner, repo: a.repo }).then((r) => r.data).catch(() => null);
    const other = (["squash", "merge", "rebase"] as const).find(
      (m) => m !== method && (m === "squash" ? allowed?.allow_squash_merge : m === "merge" ? allowed?.allow_merge_commit : allowed?.allow_rebase_merge),
    );
    if (!other) throw githubError(err, `merge ${name}`);
    method = other;
    try {
      done = await attempt(method);
    } catch (again) {
      throw githubError(again, `merge ${name}`);
    }
  }
  if (!done.merged) throw new Error(`pr_not_mergeable: GitHub did not merge ${name}${done.message ? `: ${done.message}` : ""}`);
  return { merged: true, url: pr.html_url, sha: done.sha, method };
}

/**
 * Merge a pull request as the person who asked — their token, on their run
 * (plans/code-change.md §3.2). A person's act: it runs only as strut's own
 * app's call for its viewer (the Merge button, plans/jamie-app.md §5), or as
 * a proposal a person accepted (`ctx.proposal`) — never as an agent's tool.
 */
export default defineStep({
  type: "github/merge-pr",
  secrets: ["GITHUB_TOKEN"],
  effect: "write",
  description:
    `Merge a GitHub pull request: squash by default, else the first method the repository allows. Only a person merges: from strut's own app, or as a proposal a person accepted. ` +
    `Refused, with the reason, when it is not open, is a draft, has conflicts ("pr_not_mergeable: …") or has commits newer than sha ("pr_head_moved: …"). ` +
    `Output: { merged: true, url, sha, method }.`,
  input: z.object({
    repo: z.string().min(1).describe('"owner/repo" or https://github.com/owner/repo'),
    number: z.coerce.number().int().positive().describe("pull request number"),
    sha: z.string().optional().describe("the head commit the person looked at (github/pr-status's headSha): refused when the branch moved past it"),
    method: z.enum(["squash", "merge", "rebase"]).optional().describe("default squash"),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const pageCall = isFirstParty(ctx.app) && !!ctx.actor && workflowOf(ctx) === RUN_STEP_FLOW;
    if (!pageCall && !ctx.proposal) {
      throw new Error(
        "github/merge-pr is a person's act: it runs only from strut's own app (its Merge button) or as a proposal a person accepted. Propose it; never merge on your own.",
      );
    }
    const { owner, repo } = parseGithubRepo(cfg.repo);
    // Lazy-load the SDK inside run() — AGENTS.md "Lib step dependency convention".
    const { Octokit } = await import("@octokit/rest");
    const auth = await ctx?.services?.secrets?.get("GITHUB_TOKEN");
    if (!auth) throw new Error("github_unauthorized: no GitHub token for you on this server — connect GitHub, then merge again");
    return mergePullRequest(new Octokit({ auth }) as unknown as MergeApi, {
      owner,
      repo,
      number: cfg.number,
      ...(cfg.sha ? { sha: cfg.sha } : {}),
      ...(cfg.method ? { method: cfg.method } : {}),
    });
  },
});
