import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

const EXAMPLE = `- id: pr
  type: github/create-pr
  config:
    repo: "{{ input.repo }}"
    head: "{{ push.branch }}"
    base: "{{ checkout.branch }}"
    title: "{{ input.title }}"
    body: "{{ input.body }}"`;

/** `owner/repo` from `owner/repo`, `https://github.com/owner/repo[.git]`. */
export function parseGithubRepo(raw: string): { owner: string; repo: string } {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/.exec(raw.trim());
  if (!m) throw new Error(`github/create-pr: repo must be "owner/repo" or https://github.com/owner/repo, got "${raw}"`);
  return { owner: m[1]!, repo: m[2]! };
}

/** The slice of Octokit this step uses — so a test can hand in a fake. */
export interface PullsApi {
  pulls: {
    list(p: { owner: string; repo: string; head: string; state: "open"; per_page: number }): Promise<{ data: PullData[] }>;
    create(p: { owner: string; repo: string; head: string; base: string; title: string; body?: string; draft?: boolean }): Promise<{ data: PullData }>;
  };
}

export interface PullData {
  html_url: string;
  number: number;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface CreatePrArgs {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface CreatePrResult {
  url: string;
  number: number;
  headSha: string;
  base: string;
  head: string;
  created: boolean;
}

/** GitHub's error → the contract's code. 401/403 is the token's problem
 *  (`no_push_permission`), anything else `pr_create_failed`. The message
 *  carries GitHub's status and text, never the token. */
function classify(err: unknown, what: string): Error {
  const e = err as { status?: number; message?: string } | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const text = (e?.message ?? String(err)).split("\n")[0]!.slice(0, 500);
  if (status === 401 || status === 403) return new Error(`no_push_permission: GitHub refused to ${what} (HTTP ${status}: ${text})`);
  return new Error(`pr_create_failed: ${status ?? "error"} ${text}`);
}

function shape(pr: PullData, created: boolean): CreatePrResult {
  return { url: pr.html_url, number: pr.number, headSha: pr.head.sha, base: pr.base.ref, head: pr.head.ref, created };
}

/** Open the PR, or return the open one for `head` (idempotent: a re-run after
 *  a crash lands on the same PR). */
export async function openPullRequest(api: PullsApi, a: CreatePrArgs): Promise<CreatePrResult> {
  let existing: PullData[];
  try {
    existing = (await api.pulls.list({ owner: a.owner, repo: a.repo, head: `${a.owner}:${a.head}`, state: "open", per_page: 1 })).data;
  } catch (err) {
    throw classify(err, "list pull requests");
  }
  if (existing[0]) return shape(existing[0], false);
  try {
    const { data } = await api.pulls.create({
      owner: a.owner,
      repo: a.repo,
      head: a.head,
      base: a.base,
      title: a.title,
      ...(a.body !== undefined ? { body: a.body } : {}),
      ...(a.draft !== undefined ? { draft: a.draft } : {}),
    });
    return shape(data, true);
  } catch (err) {
    throw classify(err, "create the pull request");
  }
}

/**
 * Open a pull request with the token's identity — the user's, when the
 * token is theirs (plans/code-change.md §6). Idempotent by head branch:
 * an open PR for `head` is returned instead of a second one.
 */
export default defineStep({
  type: "github/create-pr",
  description:
    `Open a GitHub pull request from head to base, or return the open one that already exists for head (so a re-run lands on the same PR). ` +
    `Auth: token, else the GITHUB_TOKEN secret — the PR is authored by the token's owner. ` +
    `Fails with "pr_create_failed: <status> <message>" when GitHub refuses, or "no_push_permission: …" on 401/403. ` +
    `Output: { url, number, headSha, base, head, created } — created is false when the PR already existed.\n\n${EXAMPLE}`,
  input: z.object({
    repo: z.string().min(1).describe('"owner/repo" or https://github.com/owner/repo'),
    head: z.string().min(1).describe("the branch with the change (a git/push step's `branch`)"),
    base: z.string().min(1).describe("the branch to merge into"),
    title: z.string().min(1).describe("pull request title"),
    body: z.string().optional().describe("pull request description (markdown)"),
    draft: z.boolean().optional().describe("open as a draft"),
    token: z.string().optional().describe("GitHub token; omit to use the GITHUB_TOKEN secret"),
  }),
  output: z.object({
    url: z.string(),
    number: z.number(),
    headSha: z.string(),
    base: z.string(),
    head: z.string(),
    created: z.boolean(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { owner, repo } = parseGithubRepo(cfg.repo);
    // Lazy-load the SDK inside run() — see AGENTS.md "Lib step dependency
    // convention". Credentials via the secrets capability (scrubbed); explicit
    // config wins — "Lib step credentials".
    const { Octokit } = await import("@octokit/rest");
    const auth = cfg.token ?? (await ctx?.services?.secrets?.get("GITHUB_TOKEN"));
    if (!auth) throw new Error("github/create-pr: no token — set the GITHUB_TOKEN secret (or `token`); a pull request needs an author");
    const octokit = new Octokit({ auth }) as unknown as PullsApi;
    return openPullRequest(octokit, {
      owner,
      repo,
      head: cfg.head,
      base: cfg.base,
      title: cfg.title,
      ...(cfg.body !== undefined ? { body: cfg.body } : {}),
      ...(cfg.draft !== undefined ? { draft: cfg.draft } : {}),
    });
  },
});
