import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { jobRoot, jobsCapability, readJobRecord } from "./jobs.js";
import { STRUT_SENT, checksFixPrompt, createPrChecks, outcomeOf, prOf, type PrChecksDeps } from "./pr-checks.js";
import type { PrStatus } from "./steps/lib/github/pr-status.js";
import prChecksStep from "./steps/lib/job/pr-checks.js";
import { fixPrompt } from "./apps/jamie/src/lib/pr.js";

// A job's pull request fails its checks: strut sends the job one turn to fix
// it (plans/pr-checks.md). The pure parts, the pass with every outside thing
// stubbed, the step, and the whole path through a strut with GitHub's API
// answered in-process.

const PR = "https://github.com/acme/app/pull/7";
const PR2 = "https://github.com/acme/app/pull/8";
const DAY = 24 * 60 * 60 * 1000;

type Check = [name: string, status: "failed" | "running" | "passed" | "skipped"];
function prStatus(url: string, checks: Check[], state: PrStatus["state"] = "open"): PrStatus {
  const n = Number(url.split("/").pop());
  const counts = { passed: 0, failed: 0, running: 0, skipped: 0, total: checks.length };
  for (const [, s] of checks) counts[s]++;
  return {
    url,
    repo: "acme/app",
    number: n,
    title: `PR ${n}`,
    state,
    head: `fix/${n}`,
    base: "main",
    headSha: `sha${n}`,
    mergeable: true,
    checks: checks.map(([name, status]) => ({ name, status })),
    counts,
  };
}

describe("pull request checks: the pure parts", () => {
  it("prOf: a pull_request artifact's GitHub link, from its url or its content; anything else is none", () => {
    assert.deepEqual(prOf({ kind: "pull_request", url: `${PR}/files` }), { url: PR, owner: "acme", repo: "app", number: 7 });
    assert.equal(prOf({ kind: "pull_request", content: JSON.stringify({ url: PR }) })?.url, PR);
    assert.equal(prOf({ kind: "pull_request", content: PR })?.url, PR);
    assert.equal(prOf({ kind: "url", url: PR }), null, "only a pull request");
    assert.equal(prOf({ kind: "pull_request", url: "https://gitlab.com/acme/app/-/merge_requests/7" }), null, "GitHub's alone");
  });

  it("outcomeOf: merged or closed is over; a running check waits; failed only once none runs", () => {
    assert.equal(outcomeOf(prStatus(PR, [["build", "failed"]], "merged")), "over");
    assert.equal(outcomeOf(prStatus(PR, [["build", "failed"]], "closed")), "over");
    assert.equal(outcomeOf(prStatus(PR, [["build", "failed"], ["lint", "running"]])), "running");
    assert.equal(outcomeOf(prStatus(PR, [["build", "passed"], ["docs", "skipped"]])), "clean");
    assert.equal(outcomeOf(prStatus(PR, [])), "clean", "no checks: nothing to fix");
    assert.equal(outcomeOf(prStatus(PR, [["build", "failed"], ["lint", "passed"]], "draft")), "failed");
  });

  it("the fix turn's words are the PR card's Fix, word for word", () => {
    const s = prStatus(PR, [["build", "failed"], ["lint", "failed"], ["docs", "passed"]]);
    assert.equal(checksFixPrompt(s), fixPrompt(s));
    assert.match(checksFixPrompt(s), /^The checks on acme\/app#7 failed: build, lint\. .* push the fix to fix\/7/);
  });
});

describe("pull request checks: a pass", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-pr-checks-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A job on file, and a pass over it with everything outside stubbed:
   *  each pull request's state is `states[url]`, read as anyone with a
   *  token. `launch` records each turn, or throws while `refuse` is set. */
  async function harness(o: { prs?: string[]; reporter?: PrChecksDeps["reporter"]; token?: PrChecksDeps["token"]; now?: () => number } = {}) {
    await jobsCapability(dir).recordRun("j-1", { workflow: "job", runId: "r-1", actor: "alice" });
    const states: Record<string, PrStatus> = {};
    const reads: string[] = [];
    const launches: Array<Parameters<PrChecksDeps["launch"]>[0]> = [];
    const warnings: string[] = [];
    const flags = { busy: false, refuse: false };
    const checks = createPrChecks({
      dataDir: dir,
      artifacts: async () => (o.prs ?? [PR]).map((url) => ({ kind: "pull_request", url, runId: "r-1" })),
      reporter: o.reporter ?? (async () => ({ conversation: "alice/c-1", actor: "alice", principal: "alice", model: "claude-sonnet-5-5" })),
      token: o.token ?? (async (principal) => (principal ? "tok" : undefined)),
      read: async (_token, pr) => {
        reads.push(pr.url);
        return states[pr.url]!;
      },
      busy: () => flags.busy,
      launch: async (l) => {
        if (flags.refuse) throw new Error("not now");
        launches.push(l);
        return `fix-${launches.length}`;
      },
      ...(o.now ? { now: o.now } : {}),
      warn: (m) => void warnings.push(m),
    });
    const fixes = async () => (await readJobRecord(jobRoot(dir, "j-1")))?.prFixes;
    return { checks, states, reads, launches, warnings, flags, fixes };
  }

  it("nothing while a check runs, when all passed, or once merged — and the PR is read again next pass", async () => {
    const h = await harness();
    for (const s of [prStatus(PR, [["build", "running"]]), prStatus(PR, [["build", "passed"]]), prStatus(PR, [["build", "failed"]], "merged")]) {
      h.states[PR] = s;
      assert.deepEqual(await h.checks.check(), { jobs: 1, sent: 0 });
    }
    assert.equal(h.reads.length, 3);
    assert.equal(h.launches.length, 0);
    assert.equal(await h.fixes(), undefined);
  });

  it("every check done and one failed: ONE turn, as the person, naming the conversation, with the card's words; never again for that PR", async () => {
    const h = await harness();
    h.states[PR] = prStatus(PR, [["build", "failed"], ["lint", "passed"]]);
    assert.deepEqual(await h.checks.check(), { jobs: 1, sent: 1 });
    assert.equal(h.launches.length, 1);
    const l = h.launches[0]!;
    assert.deepEqual(
      { job: l.job, workflow: l.workflow, conversation: l.conversation, actor: l.actor, principal: l.principal, model: l.model },
      { job: "j-1", workflow: "job", conversation: "alice/c-1", actor: "alice", principal: "alice", model: "claude-sonnet-5-5" },
    );
    assert.equal(l.prompt, `${fixPrompt(h.states[PR]!)}\n${STRUT_SENT}`);
    const fix = (await h.fixes())?.[PR];
    assert.equal(fix?.runId, "fix-1", "the mark names the turn");

    // Failed again after the fix: the next fix is a person's click.
    assert.deepEqual(await h.checks.check(), { jobs: 0, sent: 0 });
    assert.equal(h.launches.length, 1);
    assert.equal(h.reads.length, 1, "a fixed PR is not read again");
  });

  it("a job with a turn in flight is passed over, nothing taken; the next pass sends it", async () => {
    const h = await harness();
    h.states[PR] = prStatus(PR, [["build", "failed"]]);
    h.flags.busy = true;
    assert.deepEqual(await h.checks.check(), { jobs: 1, sent: 0 });
    assert.equal(await h.fixes(), undefined, "nothing taken while busy");
    h.flags.busy = false;
    assert.deepEqual(await h.checks.check(), { jobs: 1, sent: 1 });
  });

  it("a launch that is refused gives the mark back, so the next pass tries again", async () => {
    const h = await harness();
    h.states[PR] = prStatus(PR, [["build", "failed"]]);
    h.flags.refuse = true;
    assert.deepEqual(await h.checks.check(), { jobs: 1, sent: 0 });
    assert.equal(await h.fixes(), undefined, "given back");
    assert.equal(h.warnings.length, 1);
    h.flags.refuse = false;
    assert.deepEqual(await h.checks.check(), { jobs: 1, sent: 1 });
  });

  it("two failing PRs on one job: one turn naming both, both marked", async () => {
    const h = await harness({ prs: [PR, PR2] });
    h.states[PR] = prStatus(PR, [["build", "failed"]]);
    h.states[PR2] = prStatus(PR2, [["test", "failed"]]);
    assert.deepEqual(await h.checks.check(), { jobs: 1, sent: 1 });
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]!.prompt, [fixPrompt(h.states[PR]!), fixPrompt(h.states[PR2]!), STRUT_SENT].join("\n"));
    assert.deepEqual(Object.keys((await h.fixes()) ?? {}).sort(), [PR, PR2]);
  });

  it("no token, or a turn that woke no conversation: not read, nothing sent; a missing token is warned once", async () => {
    const noToken = await harness({ token: async () => undefined });
    noToken.states[PR] = prStatus(PR, [["build", "failed"]]);
    await noToken.checks.check();
    await noToken.checks.check();
    assert.equal(noToken.reads.length, 0);
    assert.equal(noToken.launches.length, 0);
    assert.equal(noToken.warnings.length, 1, "once per process");

    await rm(dir, { recursive: true, force: true });
    const nowhere = await harness({ reporter: async () => ({ actor: "alice", principal: "alice" }) });
    nowhere.states[PR] = prStatus(PR, [["build", "failed"]]);
    assert.deepEqual(await nowhere.checks.check(), { jobs: 0, sent: 0 });
    assert.equal(nowhere.reads.length, 0, "nowhere for the reply: not even read");
  });

  it("a job not used in a week is not read", async () => {
    const h = await harness({ now: () => Date.now() + 8 * DAY });
    h.states[PR] = prStatus(PR, [["build", "failed"]]);
    assert.deepEqual(await h.checks.check(), { jobs: 0, sent: 0 });
    assert.equal(h.reads.length, 0);
  });

  it("with a url, that PR alone; a url that is no GitHub PR is refused", async () => {
    const h = await harness({ prs: [PR, PR2] });
    h.states[PR] = prStatus(PR, [["build", "passed"]]);
    h.states[PR2] = prStatus(PR2, [["build", "passed"]]);
    await h.checks.check({ url: `${PR2}/checks` });
    assert.deepEqual(h.reads, [PR2]);
    await assert.rejects(h.checks.check({ url: "https://example.com/pr/1" }), /not a GitHub pull request's URL/);
  });

  it("a call while a pass runs gets that pass and starts nothing", async () => {
    const h = await harness();
    h.states[PR] = prStatus(PR, [["build", "running"]]);
    const [a, b] = await Promise.all([h.checks.check(), h.checks.check({ url: PR })]);
    assert.deepEqual(a, b);
    assert.equal(h.reads.length, 1);
  });
});

describe("the job/pr-checks step", () => {
  it("runs the server's check, passing the url alone; with no server, it says what it needs", async () => {
    const calls: unknown[] = [];
    const ctx = { services: { prChecks: { check: async (o: unknown) => (calls.push(o), { jobs: 2, sent: 1 }) } } } as never;
    assert.deepEqual(await prChecksStep.run({ url: PR }, ctx), { jobs: 2, sent: 1 });
    assert.deepEqual(await prChecksStep.run({}, ctx), { jobs: 2, sent: 1 });
    assert.deepEqual(calls, [{ url: PR }, {}]);
    await assert.rejects(prChecksStep.run({}, { services: {} } as never), /needs the server's pull request checks/);
  });
});

describe("pull request checks through a whole strut", () => {
  let dir = "";
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["GITHUB_TOKEN", "STRUT_API_KEY"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-pr-checks-e2e-"));
    for (const k of ENV) saved[k] = process.env[k];
    process.env["GITHUB_TOKEN"] = "gh-test-token";
    delete process.env["STRUT_API_KEY"];
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const until = async <T>(find: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 1500; i++) {
      const v = await find();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${what} never happened`);
  };

  it("a job turn that delivered a PR whose build failed gets one fix turn, as its person, naming its conversation; the job keeps the mark", async () => {
    // GitHub's API, answered here: #7 is open, its one check failed.
    const githubCalls: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      githubCalls.push({ url, auth: headers.get("authorization") });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      const path = new URL(url).pathname;
      if (path === "/repos/acme/app/pulls/7") {
        return json({ html_url: PR, number: 7, title: "Fix it", state: "open", draft: false, merged: false, mergeable: true, user: { login: "bob" }, head: { ref: "fix/7", sha: "sha7" }, base: { ref: "main" } });
      }
      if (path === "/repos/acme/app/commits/sha7/check-runs") {
        return json({ total_count: 1, check_runs: [{ id: 11, name: "build", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/app/runs/11", app: { slug: "github-actions" } }] });
      }
      if (path === "/repos/acme/app/commits/sha7/status") return json({ state: "failure", statuses: [] });
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      builder: false,
      autoResume: false,
      orchestrator: false,
      resolveActor: (c) => c.req.header("x-test-actor"),
    });
    // A stand-in job: its turn delivers the pull request it was told about.
    await strut.workspace.publishWorkflow("job", "v1", {
      steps: [{ id: "result", type: "pack", config: { text: "{{ input.prompt }}", artifacts: [{ id: "pr", kind: "pull_request", title: "Fix it", url: PR }] } }],
    });
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await strut.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const ended = (runId: string) =>
      until(async () => ((await strut.store.getRunEvents("job", runId)).some((e) => e.type === "run.end") ? true : undefined), `run ${runId}'s end`);

    const launched = await post("/workflows/job/run", { job: "j-1", input: { prompt: "make the fix" }, conversation: "bob/c-1", wake: true }, { "x-test-actor": "bob" });
    assert.equal(launched.status, 202, JSON.stringify(launched.body));
    await ended(launched.body.runId);

    const first = await post("/steps/job%2Fpr-checks/run", { config: {} });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.output ?? first.body, { jobs: 1, sent: 1 });
    assert.ok(githubCalls.length >= 3, "the PR, its check runs, its statuses");
    assert.ok(githubCalls.every((c) => c.auth === "token gh-test-token"), "read with the token for github.com");

    const rec = await until(async () => {
      const r = await readJobRecord(jobRoot(strut.dataDir, "j-1"));
      return r?.runs?.length === 2 && r.prFixes?.[PR]?.runId ? r : undefined;
    }, "the fix turn on the job");
    const fixRun = rec.runs![1]!.runId;
    assert.equal(rec.prFixes![PR]!.runId, fixRun);
    await ended(fixRun);
    const start = (await strut.store.getRunEvents("job", fixRun)).find((e) => e.type === "run.start")!;
    assert.equal((start.input as { prompt?: string }).prompt, `The checks on acme/app#7 failed: build. Find out why, fix it, and push the fix to fix/7 — the same pull request.\n${STRUT_SENT}`);
    assert.equal(start.conversation, "bob/c-1", "its end goes to the conversation the turn that opened it woke");
    assert.equal(start.wakeAsked, true);
    assert.equal(start.actor, "bob", "as the person who ran that turn");

    const again = await post("/steps/job%2Fpr-checks/run", { config: {} });
    assert.deepEqual(again.body.output ?? again.body, { jobs: 0, sent: 0 }, "once per pull request");
  });
});
