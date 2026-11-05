import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRunStatus, prState, readPullRequest, type PrStatusApi, type PullDetail } from "./pr-status.js";
import mergeStep, { mergePullRequest, type MergeApi, type MergeMethod } from "./merge-pr.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";

const pull = (o: Partial<PullDetail> = {}): PullDetail => ({
  html_url: "https://github.com/a/b/pull/5",
  number: 5,
  title: "Fix login",
  body: "It redirects now.",
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  user: { login: "jamie-bot" },
  head: { ref: "fix/login", sha: "abc" },
  base: { ref: "main" },
  ...o,
});

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("github/pr-status", () => {
  it("a check run's state in four words; a PR's state", () => {
    assert.equal(checkRunStatus("in_progress", null), "running");
    assert.equal(checkRunStatus("completed", "success"), "passed");
    assert.equal(checkRunStatus("completed", "neutral"), "passed");
    assert.equal(checkRunStatus("completed", "skipped"), "skipped");
    assert.equal(checkRunStatus("completed", "timed_out"), "failed");
    assert.equal(prState({ state: "open", draft: true }), "draft");
    assert.equal(prState({ state: "closed", merged_at: "2026-11-05T00:00:00Z" }), "merged");
    assert.equal(prState({ state: "closed" }), "closed");
  });

  it("the PR, its checks (runs and statuses, the newest of each name, failed first) and counts", async () => {
    const asked: string[] = [];
    const api: PrStatusApi = {
      pulls: { get: async (p) => (asked.push(`pr ${p.owner}/${p.repo}#${p.pull_number}`), { data: pull() }) },
      checks: {
        listForRef: async (p) => (
          asked.push(`checks ${p.ref}`),
          {
            data: {
              check_runs: [
                { name: "test", status: "completed", conclusion: "success", html_url: "https://ci/test" },
                { name: "lint", status: "completed", conclusion: "failure", details_url: "https://ci/lint" },
                { name: "test", status: "completed", conclusion: "failure" },
                { name: "e2e", status: "queued" },
              ],
            },
          }
        ),
      },
      repos: {
        getCombinedStatusForRef: async () => ({ data: { statuses: [{ context: "deploy", state: "pending" }, { context: "lint", state: "success" }] } }),
      },
    };
    const s = await readPullRequest(api, "a", "b", 5);
    assert.deepEqual(asked, ["pr a/b#5", "checks abc"]);
    assert.deepEqual(
      { ...s, checks: s.checks.map((c) => `${c.status} ${c.name}`) },
      {
        url: "https://github.com/a/b/pull/5",
        repo: "a/b",
        number: 5,
        title: "Fix login",
        state: "open",
        author: "jamie-bot",
        head: "fix/login",
        base: "main",
        headSha: "abc",
        body: "It redirects now.",
        mergeable: true,
        checks: ["failed lint", "running deploy", "running e2e", "passed test"],
        counts: { passed: 1, failed: 1, running: 2, skipped: 0, total: 4 },
      },
    );
  });

  it("a PR the token cannot see is said plainly; checks that cannot be read are none", async () => {
    const hidden: PrStatusApi = {
      pulls: { get: async () => Promise.reject(httpError(404, "Not Found")) },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    };
    await assert.rejects(readPullRequest(hidden, "a", "b", 5), /^Error: github_not_found: GitHub would not let this token read a\/b#5/);
    const limited: PrStatusApi = { ...hidden, pulls: { get: async () => Promise.reject(httpError(403, "API rate limit exceeded for 1.2.3.4. (But here's the good news: …)")) } };
    await assert.rejects(readPullRequest(limited, "a", "b", 5), /^Error: github_rate_limited: GitHub's rate limit for this token is used up, so it could not read a\/b#5 — try again in a while$/);
    const noChecks: PrStatusApi = { ...hidden, pulls: { get: async () => ({ data: pull() }) }, checks: { listForRef: async () => Promise.reject(httpError(403, "no")) } };
    assert.deepEqual((await readPullRequest(noChecks, "a", "b", 5)).checks, []);
  });
});

describe("github/merge-pr", () => {
  const fake = (o: { pr?: Partial<PullDetail>; refuse?: MergeMethod[]; allowed?: Partial<Record<"allow_squash_merge" | "allow_merge_commit" | "allow_rebase_merge", boolean>> } = {}) => {
    const merges: string[] = [];
    const api: MergeApi = {
      pulls: {
        get: async () => ({ data: pull(o.pr) }),
        merge: async (p) => {
          merges.push(`${p.merge_method} ${p.sha}`);
          if (o.refuse?.includes(p.merge_method)) throw httpError(405, `${p.merge_method} merges are not allowed on this repository`);
          return { data: { merged: true, sha: "m1" } };
        },
      },
      repos: { get: async () => ({ data: o.allowed ?? { allow_squash_merge: true, allow_merge_commit: true } }) },
    };
    return { api, merges };
  };

  it("squashes the head the person looked at", async () => {
    const { api, merges } = fake();
    assert.deepEqual(await mergePullRequest(api, { owner: "a", repo: "b", number: 5, sha: "abc" }), { merged: true, url: "https://github.com/a/b/pull/5", sha: "m1", method: "squash" });
    assert.deepEqual(merges, ["squash abc"]);
  });

  it("a method the repository does not allow: the first one it does", async () => {
    const { api, merges } = fake({ refuse: ["squash"], allowed: { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true } });
    assert.equal((await mergePullRequest(api, { owner: "a", repo: "b", number: 5 })).method, "rebase");
    assert.deepEqual(merges, ["squash abc", "rebase abc"]);
  });

  it("refuses a merged, closed, draft or conflicting PR, and one whose head moved, before merging", async () => {
    for (const [pr, why] of [
      [{ merged: true, state: "closed" }, /already merged/],
      [{ state: "closed" }, /is closed/],
      [{ draft: true }, /is a draft/],
      [{ mergeable: false }, /has conflicts with main/],
    ] as const) {
      const { api, merges } = fake({ pr });
      await assert.rejects(mergePullRequest(api, { owner: "a", repo: "b", number: 5 }), why);
      assert.deepEqual(merges, []);
    }
    const { api, merges } = fake();
    await assert.rejects(mergePullRequest(api, { owner: "a", repo: "b", number: 5, sha: "old" }), /^Error: pr_head_moved: a\/b#5 has new commits/);
    assert.deepEqual(merges, []);
  });

  it("only a person merges: strut's own page, or an accepted proposal — never an agent's tool or a model-written page", async () => {
    const cfg = { repo: "a/b", number: 5 };
    const refused = /a person's act/;
    await assert.rejects(mergeStep.run(cfg, { workflow: RUN_STEP_FLOW, actor: "alice", app: { name: "acme/x", version: "v1" } } as never), refused);
    await assert.rejects(mergeStep.run(cfg, { workflow: "orchestrator", actor: "alice", app: { name: "strut/jamie", version: "v1", firstParty: true } } as never), refused, "a run the page launched");
    await assert.rejects(mergeStep.run(cfg, { workflow: "orchestrator", actor: "alice" } as never), refused);
    // Past the gate, the token: none on file here.
    const noToken = /no GitHub token for you/;
    await assert.rejects(mergeStep.run(cfg, { workflow: RUN_STEP_FLOW, actor: "alice", app: { name: "strut/jamie", version: "v1", firstParty: true }, services: { secrets: { get: async () => undefined } } } as never), noToken);
    await assert.rejects(mergeStep.run(cfg, { workflow: "orchestrator", actor: "alice", proposal: { id: "p1" }, services: { secrets: { get: async () => undefined } } } as never), noToken);
  });
});
