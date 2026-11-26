import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRunStatus, logOf, MAX_LOGS, prState, readPullRequest, type PrStatusApi, type PullDetail } from "./pr-status.js";
import { formatPRContent } from "./fetch-pr.js";
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
                { name: "lint", status: "completed", conclusion: "failure", details_url: "https://ci/lint", completed_at: "2026-11-26T09:11:46Z" },
                { name: "test", status: "completed", conclusion: "failure" },
                { name: "e2e", status: "queued", completed_at: null },
              ],
            },
          }
        ),
      },
      repos: {
        getCombinedStatusForRef: async () => ({ data: { statuses: [{ context: "deploy", state: "pending", updated_at: "2026-11-26T09:00:00Z" }, { context: "lint", state: "success" }] } }),
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
    const at = Object.fromEntries(s.checks.map((c) => [c.name, c.finishedAt]));
    assert.deepEqual(at, { lint: "2026-11-26T09:11:46Z", deploy: undefined, e2e: undefined, test: undefined }, "when it finished; none while it runs");
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

  it("a job log without its timestamps; its end is the lines up to the first error", () => {
    const raw = [
      "﻿2026-11-22T22:13:30.1Z start",
      "2026-11-22T22:13:31.1234567Z not ok 14 - the door",
      ...Array.from({ length: 60 }, (_, i) => `2026-11-22T22:13:32.0Z line ${i}`),
      "2026-11-22T22:13:38.3Z ##[error]Process completed with exit code 1.",
      "2026-11-22T22:13:38.4Z Post job cleanup.",
      "",
    ].join("\n");
    const log = logOf(raw);
    assert.equal(log.lines, 64);
    assert.ok(log.text.startsWith("start\nnot ok 14 - the door\nline 0\n"));
    assert.ok(log.text.endsWith("Post job cleanup.\n"));
    const end = log.end.split("\n");
    assert.equal(end.length, 40);
    assert.equal(end.at(-1), "##[error]Process completed with exit code 1.");
    assert.equal(end[0], "line 21");
    assert.equal(logOf("a\nb").end, "a\nb", "no error: the log's own end");
  });

  it("a log's end starts at the failing step: a passing step's warning above it is not in it (peel#614)", () => {
    const log = logOf(
      [
        "##[group]Run ./scripts/build-ffi.sh",
        "##[endgroup]",
        "WARNING: stakwork/sphinx is private, so set GITHUB_TOKEN to a token that can read it",
        "bindings ready",
        "##[group]Run swift build --build-tests",
        "##[endgroup]",
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
    );
    assert.equal(log.end, "##[group]Run swift build --build-tests\n##[endgroup]\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n##[error]Process completed with exit code 1.");
  });

  it("with logs, each failed Actions check's log goes to a file; a status has none; a refusal is said on the check", async () => {
    const run = (id: number, name: string, conclusion: string, slug = "github-actions") => ({ id, name, status: "completed", conclusion, app: { slug } });
    const asked: number[] = [];
    const api: PrStatusApi = {
      pulls: { get: async () => ({ data: pull() }) },
      checks: {
        listForRef: async () => ({
          data: {
            check_runs: [
              run(1, "test (1/2)", "failure"),
              run(2, "test (2/2)", "failure"),
              run(3, "build", "success"),
              run(4, "vercel", "failure", "vercel"),
              ...Array.from({ length: 6 }, (_, i) => run(10 + i, `unit ${i}`, "failure")),
            ],
          },
        }),
      },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [{ context: "deploy", state: "failure" }] } }) },
      actions: {
        downloadJobLogsForWorkflowRun: async ({ job_id }) => {
          asked.push(job_id);
          if (job_id === 2) throw httpError(403, "Resource not accessible by integration");
          return { data: `2026-11-22T00:00:00.0Z job ${job_id}\n2026-11-22T00:00:01.0Z ##[error]boom\n` };
        },
      },
    };
    const written = new Map<string, string>();
    const s = await readPullRequest(api, "a", "b", 5, { logs: async (rel, text) => (written.set(rel, text), `/data/artifacts/r1/${rel}`) });
    const one = s.checks.find((c) => c.name === "test (1/2)")!;
    assert.deepEqual(one.log, { path: "/data/artifacts/r1/ci-logs/a-b-5/test-1-2-1.log", lines: 2, end: "job 1\n##[error]boom" });
    assert.equal(written.get("ci-logs/a-b-5/test-1-2-1.log"), "job 1\n##[error]boom\n");
    const two = s.checks.find((c) => c.name === "test (2/2)")!;
    assert.equal(two.log, undefined);
    assert.match(two.logError!, /HTTP 403: Resource not accessible by integration\): a GitHub App's token needs the App's "Actions: read" permission$/);
    assert.equal(s.checks.find((c) => c.name === "vercel")!.logError, undefined, "not an Actions check: no log, nothing said");
    assert.equal(s.checks.find((c) => c.name === "deploy")!.log, undefined);
    assert.equal(asked.length, MAX_LOGS, "a matrix that fails wide: the first few logs only");
    assert.equal(s.checks.find((c) => c.name === "build")!.log, undefined);
    const plain = await readPullRequest(api, "a", "b", 5);
    assert.ok(plain.checks.every((c) => !c.log && !c.logError), "no logs unless asked");
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

describe("github/fetch-pr", () => {
  const limits = { maxPatchLines: 3, maxFiles: 2, maxDescriptionChars: 100, maxCommentChars: 100, maxComments: 5, maxReviews: 5 };
  const pr = { number: 7, title: "Big", head: { ref: "feature/big" }, base: { ref: "main" }, changed_files: 250, html_url: "u" };
  const file = (name: string, lines: number) => ({ filename: name, status: "modified", additions: lines, deletions: 0, changes: lines, patch: Array.from({ length: lines }, (_, i) => `+${i}`).join("\n") });

  it("a cut diff says so, counts the PR's own files, and points at the checkout", () => {
    const md = formatPRContent(pr, [file("a.ts", 2), file("b.ts", 9), file("c.ts", 1)], [], [], [], [], limits);
    assert.match(md, /## Files Changed \(showing 2 of 250 files\)/);
    assert.match(md, /This is not the whole diff\. For all of it, check the branch out \(git\/checkout with ref: "feature\/big"\) and read it with git diff and rg\./);
    assert.match(md, /\.\.\. truncated 6 lines \.\.\./);
  });

  it("a small diff, whole, says nothing more", () => {
    const md = formatPRContent({ ...pr, changed_files: 1 }, [file("a.ts", 2)], [], [], [], [], limits);
    assert.match(md, /showing 1 of 1 files/);
    assert.doesNotMatch(md, /not the whole diff/);
  });

  it("a file whose patch GitHub left out is a cut diff too", () => {
    const md = formatPRContent({ ...pr, changed_files: 1 }, [{ filename: "huge.json", status: "modified", additions: 90000, deletions: 0, changes: 90000 }], [], [], [], [], limits);
    assert.match(md, /not the whole diff/);
  });
});
