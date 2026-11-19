import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { ORCHESTRATOR_WORKFLOW } from "./orchestrator-seed.js";
import type { Scope } from "./auth.js";
import type { RunEvent } from "./core.js";
import { createConversations, isConversationFlow, pullRequestsOf, titleOf, turnJobs, withJobs, type ConversationRecord } from "./conversations.js";
import { countReads } from "./test-util/count-reads.js";
import { encodeId } from "./session-store.js";
import listStep from "./steps/lib/conversation/list.js";
import { createProposal, proposalsRoot } from "./proposals.js";

describe("conversations: the pure parts", () => {
  it("titleOf: Hive's leading @<workspace> line left out, whitespace as one space, cut", () => {
    assert.equal(titleOf("@acme-web\nflights   to\nLisbon?"), "flights to Lisbon?");
    assert.equal(titleOf("@acme is great"), "@acme is great", "a mention in the text is the text");
    assert.equal(titleOf("x".repeat(200)).length, 80);
    assert.ok(titleOf("x".repeat(200)).endsWith("…"));
    assert.equal(titleOf(undefined), "");
  });

  it("isConversationFlow: a workflow with params.wake", () => {
    assert.equal(isConversationFlow({ params: { wake: "…" } }), true);
    assert.equal(isConversationFlow({ params: {} }), false);
    assert.equal(isConversationFlow(null), false);
  });

  it("turnJobs: the job/start and job/continue a turn's log shows, as a tool call or a step", () => {
    const ev = (e: Partial<RunEvent>) => ({ ts: "t", workflow: "orchestrator", runId: "r", ...e }) as RunEvent;
    const jobs = turnJobs([
      ev({ type: "step.start", path: "o/agent/001-job_start", input: JSON.stringify({ workflow: "builder", brief: "b" }) }),
      ev({ type: "step.end", path: "o/agent/001-job_start", stepType: "tool:job_start", output: JSON.stringify({ job: "j-1", runId: "11" }) }),
      ev({ type: "step.end", path: "o/agent/002-job_continue", stepType: "tool:job_continue", output: { job: "j-2", runId: "12" } }),
      ev({ type: "step.end", path: "o/start", stepType: "job/start", output: { job: "j-3", runId: "13" } }),
      ev({ type: "step.end", path: "o/agent/003-job_get", stepType: "tool:job_get", output: { job: "j-4", runId: "14" } }),
      // A continue returns the workflow the job's record runs it on.
      ev({ type: "step.end", path: "o/agent/004-job_continue", stepType: "tool:job_continue", output: JSON.stringify({ job: "j-1", runId: "15", callback: true, workflow: "builder" }) }),
    ]);
    assert.deepEqual(jobs, [
      { job: "j-1", runId: "11", workflow: "builder" },
      // Logged before job/continue returned it: the job's record has it.
      { job: "j-2", runId: "12" },
      { job: "j-3", runId: "13", workflow: "job" },
      { job: "j-1", runId: "15", workflow: "builder" },
    ]);
  });

  it("pullRequestsOf: a run output's pull_request artifacts with a GitHub link, each once", () => {
    assert.deepEqual(
      pullRequestsOf({
        artifacts: [
          { id: "pr", kind: "pull_request", title: "Fix login", url: "https://github.com/a/b/pull/5" },
          { id: "pr2", kind: "pull_request", title: "Again", url: "https://github.com/a/b/pull/5/files" },
          { id: "c", kind: "pull_request", content: '{"url":"https://github.com/a/c/pull/7","state":"merged"}' },
          { id: "x", kind: "pull_request", url: "https://example.com/pull/1" },
          { id: "m", kind: "markdown", url: "https://github.com/a/b/pull/9" },
        ],
      }),
      [
        { url: "https://github.com/a/b/pull/5", title: "Fix login", repo: "a/b", number: 5 },
        { url: "https://github.com/a/c/pull/7", repo: "a/c", number: 7, state: "merged" },
      ],
    );
    assert.deepEqual(pullRequestsOf(undefined), []);
  });

  it("withJobs: each turn's jobs, a job seen again moved to the end", () => {
    assert.deepEqual(withJobs(["a", "b"], [[{ job: "c", runId: "1" }], [{ job: "a", runId: "2" }]]), ["b", "c", "a"]);
    assert.deepEqual(withJobs([], []), []);
  });

  it("the steps are refused to an app's page", async () => {
    await assert.rejects(
      () => listStep.run({}, { app: { name: "x", version: "v1" }, services: { conversations: {} } } as never),
      /not available to an app's page/,
    );
  });
});

// A server holds 100k+ conversations after months: a call opens the records
// it returns, or those written since a mark, never every one on file.
describe("conversations: reads bounded by what is returned", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-conversations-reads-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const index = () =>
    createConversations({
      dataDir: dir,
      store: new MemoryRunStore(),
      sessions: { turns: async () => [], list: async () => [] } as never,
      getWorkflow: async () => ({ params: { wake: "w" } }) as never,
      running: () => false,
      liveState: () => undefined,
      artifactRefs: async () => undefined,
    });
  const sessions = () => join(dir, "conversations", "sessions");
  /** A record an older process wrote, last changed `daysAgo` days ago. */
  const older = async (id: string, daysAgo: number, extra: Partial<ConversationRecord> = {}) => {
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const rec: ConversationRecord = { id, title: id, createdAt: at, updatedAt: at, rev: 1, viewers: ["alice"], turns: [{ runId: `r-${id}`, workflow: "orchestrator", at, by: "alice", status: "success" }], jobs: [], ...extra };
    await mkdir(sessions(), { recursive: true });
    await writeFile(join(sessions(), `${encodeId(id)}.json`), JSON.stringify(rec));
  };
  const turn = (c: ReturnType<typeof index>, id: string, actor = "alice") => c.launched(id, { runId: `r-${id}-${Math.random()}`, workflow: "orchestrator", actor, prompt: `about ${id}` });

  it("changed(since) opens the records written since, off the day logs; the log of older records is filled once", async () => {
    for (let i = 0; i < 30; i++) await older(`old-${i}`, 10 + (i % 5));
    const c = index();
    const before = new Date(Date.now() - 1000).toISOString();
    // The first read fills the day logs from the records on file, once.
    assert.deepEqual((await c.changed(before)).map((e) => e.id), []);
    await turn(c, "old-3");
    await turn(c, "new-1");

    const { value, reads } = await countReads(dir, () => c.changed(before));
    assert.deepEqual(value.map((e) => e.id).sort(), ["new-1", "old-3"]);
    assert.equal(reads.filter((f) => f.startsWith(sessions())).length, 2, `opened ${reads.length} files: ${reads.join(", ")}`);
    assert.equal(reads.filter((f) => f.endsWith(".log")).length, 1, "today's log alone");
    // Older windows come off the logs the fill wrote, each record in its day's.
    assert.equal((await c.changed(new Date(Date.now() - 12.5 * 86_400_000).toISOString())).length, 2 + 18);
    // No mark: every one on file.
    assert.equal((await c.changed()).length, 31);
  });

  it("a list reads the viewer's file and one file of the shared ones, never their records", async () => {
    const c = index();
    for (let i = 0; i < 20; i++) {
      await turn(c, `alice/${i}`);
      await c.update({ session: `alice/${i}`, shared: true }, { actor: "alice" });
    }
    const { value, reads } = await countReads(dir, () => c.list({ limit: 5 }, { actor: "carol" }));
    assert.deepEqual([value.conversations.length, value.conversations.every((r) => r.team), !!value.next], [5, true, true]);
    assert.equal(reads.filter((f) => f.startsWith(sessions())).length, 0, `opened ${reads.join(", ")}`);
    // Unshared: out of the list of whoever never opened it; a turn in a shared one moves its row.
    await c.update({ session: "alice/0", shared: false }, { actor: "alice" });
    await turn(c, "alice/1", "bob");
    const rows = (await c.list({ limit: 50 }, { actor: "carol" })).conversations;
    assert.deepEqual([rows.length, rows[0]!.id, rows[0]!.turns], [19, "alice/1", 2]);
  });

  it("a shared.json from before the rows (ids alone) still lists them, and is rewritten as rows at its next write", async () => {
    await older("alice/a", 1, { shared: true });
    await older("alice/b", 2, { shared: true });
    await writeFile(join(dir, "conversations", "shared.json"), JSON.stringify({ ids: ["alice/a", "alice/b"] }));
    const c = index();
    assert.deepEqual((await c.list({}, { actor: "carol" })).conversations.map((r) => r.id), ["alice/a", "alice/b"]);
    await turn(c, "alice/b");
    const file = JSON.parse(await readFile(join(dir, "conversations", "shared.json"), "utf-8"));
    assert.deepEqual([file.ids, Object.keys(file.conversations).sort()], [undefined, ["alice/a", "alice/b"]]);
  });
});

describe("conversations through a whole strut", () => {
  let dir = "";
  const servers: http.Server[] = [];
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "STRUT_HOST_KEYS", "AI_SDK_LOG_WARNINGS"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-conversations-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_HOST_KEYS"];
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) s.close();
    // A run that outlived its test may still be writing into it.
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
  const answer = (input: unknown) =>
    sse({
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    }) +
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "final_answer", input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    sse({ type: "message_stop" });
  const until = async <T>(find: () => T | undefined | Promise<T | undefined>, what = "it"): Promise<T> => {
    for (let i = 0; i < 1500; i++) {
      const v = await find();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${what} never happened`);
  };
  const lastUser = (body: any) => JSON.stringify(body.messages.filter((m: any) => m.role === "user").at(-1));

  /** A strut with the seeded orchestrator, a stand-in `job` and a stand-in
   *  model: a wake turn says "Summary."; a person's turn says `reply(body)`
   *  or "Hello."; a prompt with "boom" gets no answer (the turn fails). */
  const boot = async (o: { reply?: (body: any) => unknown; hold?: () => Promise<void> } = {}) => {
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const user = lastUser(body);
        if (user.includes("<<<job reply")) return res.writeHead(200, { "content-type": "text/event-stream" }).end(answer({ text: "Summary.", artifacts: [] }));
        if (user.includes("boom")) return res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "down" } }));
        await o.hold?.();
        res.writeHead(200, { "content-type": "text/event-stream" }).end(answer(o.reply?.(body) ?? { text: "Hello.", artifacts: [] }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      builder: false,
      autoResume: false,
      orchestrator: {},
      resolveActor: (c) => c.req.header("x-test-actor"),
      resolveScope: (c) => c.req.header("x-test-scope") as Scope | undefined,
    });
    await strut.workspace.publishWorkflow("job", "v1", {
      steps: [{ id: "result", type: "pack", config: { text: "{{ input.prompt }}: found 3", artifacts: [] } }],
    });
    const as = (actor: string, scope?: Scope) => ({ "x-test-actor": actor, ...(scope ? { "x-test-scope": scope } : {}) });
    const req = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const res = await strut.app.request(path, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const idle = () =>
      until(async () => {
        const active = (await (await strut.app.request("/runs/active")).json()) as unknown[];
        return active.length ? undefined : true;
      }, "idle");
    /** A person's turn on `session`; waits until every run is done. */
    const say = async (actor: string, session: string, prompt: string, extra: Record<string, unknown> = {}) => {
      const r = await req(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { method: "POST", body: { input: { prompt, session }, ...extra }, headers: as(actor) });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await idle();
      return r.body.runId as string;
    };
    const list = (actor: string, query = "", scope?: Scope) => req(`/conversations${query}`, { headers: as(actor, scope) });
    const get = (actor: string, id: string, query = "", scope?: Scope) => req(`/conversations/item?id=${encodeURIComponent(id)}${query}`, { headers: as(actor, scope) });
    const update = (actor: string, body: Record<string, unknown>, scope?: Scope) => req("/conversations/update", { method: "POST", body, headers: as(actor, scope) });
    return { strut, requests, req, say, list, get, update, idle, as };
  };

  it("a shared conversation is listed for each participant; each turn is read from its run, newest first", async () => {
    const { say, list, get } = await boot();
    const first = await say("alice", "c-1", "@acme-web\nflights to Lisbon?");
    const second = await say("bob", "c-1", "and hotels?");

    for (const actor of ["alice", "bob"]) {
      const { body } = await list(actor);
      assert.deepEqual(body.conversations.map((c: any) => [c.id, c.title, c.turns, c.status]), [["c-1", "flights to Lisbon?", 2, "success"]], actor);
    }
    const { body: view } = await get("alice", "c-1");
    assert.deepEqual(view.participants, ["alice", "bob"]);
    assert.deepEqual(
      view.turns.map((t: any) => [t.turn, t.runId, t.by, t.status, t.prompt, t.text]),
      [
        [1, second, "bob", "success", "and hotels?", "Hello."],
        [0, first, "alice", "success", "@acme-web\nflights to Lisbon?", "Hello."],
      ],
    );
    assert.equal((await list("carol")).body.conversations.length, 0, "not carol's");
    assert.equal((await get("carol", "c-1")).status, 404);
  });

  it("a share puts it in everyone's list until they open it, which makes it theirs; their turn makes them a participant", async () => {
    const { say, list, get, update } = await boot();
    await say("alice", "c-1", "plan the offsite");
    assert.equal((await get("carol", "c-1")).status, 404);
    assert.equal((await update("carol", { session: "c-1", shared: true })).status, 404, "only who may read it shares it");

    const shared = await update("alice", { session: "c-1", shared: true });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.shared, true);
    const row = (actor: string) => list(actor).then((r) => r.body.conversations.map((c: any) => [c.id, c.shared, c.team, c.unread, c.startedBy]));
    assert.deepEqual(await row("carol"), [["c-1", true, true, false, "alice"]], "in carol's list, not hers yet, never unread");
    assert.deepEqual(await row("dave"), [["c-1", true, true, false, "alice"]], "and dave's");
    assert.deepEqual((await list("carol", "?archived=1")).body.conversations, [], "never among the archived");
    const opened = await get("carol", "c-1");
    assert.equal(opened.status, 200);
    assert.deepEqual(opened.body.participants, ["alice"]);
    assert.deepEqual((await row("carol"))[0]!.slice(0, 3), ["c-1", true, undefined], "opened: hers");

    await say("carol", "c-1", "add a budget");
    assert.deepEqual((await get("alice", "c-1")).body.participants, ["alice", "carol"]);
    const unshared = await update("alice", { session: "c-1", shared: false });
    assert.equal(unshared.body.shared, undefined);
    assert.equal((await get("carol", "c-1")).status, 200, "a participant reads it unshared");
    assert.deepEqual(await row("dave"), [], "out of the list of whoever never opened it");
  });

  it("rename for everyone; archived and seen per viewer; a turn is unread until seen", async () => {
    const { say, list, update } = await boot();
    await say("alice", "c-1", "first");
    await say("bob", "c-1", "second");
    assert.equal((await list("alice")).body.conversations[0].unread, true, "bob's turn is new to alice");
    assert.equal((await update("alice", { session: "c-1", seen: true })).body.unread, false);
    assert.equal((await list("alice")).body.conversations[0].unread, false);

    await update("bob", { session: "c-1", title: "Offsite" });
    assert.equal((await list("alice")).body.conversations[0].title, "Offsite");
    await update("bob", { session: "c-1", title: "" });
    assert.equal((await list("alice")).body.conversations[0].title, "first", "an empty title gives back the first message");

    await update("alice", { session: "c-1", archived: true });
    assert.equal((await list("alice")).body.conversations.length, 0);
    assert.deepEqual((await list("alice", "?archived=1")).body.conversations.map((c: any) => c.id), ["c-1"]);
    assert.equal((await list("bob")).body.conversations.length, 1, "bob's is not archived");
    assert.deepEqual((await list("bob", "?q=first")).body.conversations.map((c: any) => c.id), ["c-1"]);
    assert.equal((await list("bob", "?q=nothing")).body.conversations.length, 0);
  });

  it("a wake turn is shown as a wake; the person's turn shows the job it started", async () => {
    const { say, get, idle } = await boot({
      reply: () => ({ text: "Looking into it.", start: { brief: "Find flights", title: "Flights" }, artifacts: [] }),
    });
    await say("alice", "c-1", "flights?", { wake: true });
    await until(async () => ((await get("alice", "c-1")).body.turns.length === 2 ? true : undefined), "the wake turn");
    await idle();
    const { body } = await get("alice", "c-1");
    const [wake, person] = body.turns;
    assert.equal(person.prompt, "flights?");
    assert.equal(person.jobs.length, 1);
    assert.equal(person.jobs[0].workflow, "job");
    assert.equal(wake.prompt, undefined, "a wake has no person's words");
    assert.deepEqual(wake.wake, { job: person.jobs[0].job, runId: person.jobs[0].runId });
    assert.equal(wake.text, "Summary.");
    assert.equal(wake.delivered, undefined, "the job delivered nothing");
  });

  it("a job's proposal shows under the turn that started it, where its card is; one made elsewhere, or not the reader's, does not", async () => {
    const { say, get, idle } = await boot({
      reply: (body) => (lastUser(body).includes("flights?") ? { text: "Looking into it.", start: { brief: "Find flights", title: "Flights" }, artifacts: [] } : { text: "Hello.", artifacts: [] }),
    });
    const session = "alice/c-1";
    await say("alice", session, "flights?", { wake: true });
    await until(async () => ((await get("alice", session)).body.turns.length === 2 ? true : undefined), "the wake turn");
    await say("alice", session, "thanks");
    await idle();
    const started = (await get("alice", session)).body.turns.find((t: any) => t.jobs.length);
    const { job, runId } = started.jobs[0];
    const root = proposalsRoot(dir);
    const by = { workflow: "builder", path: "builder/agent", job, actor: "alice" };
    const propose = (title: string, b: Record<string, unknown>) => createProposal(root, { step: "task/set-type", input: {}, title, by: { ...by, ...b } as never });
    const ofRun = await propose("by the job's run", { runId, conversation: session });
    const ofChild = await propose("by a run inside the job", { runId: "child-run", conversation: session });
    await propose("by the job, from another conversation", { runId: "elsewhere", conversation: "alice/c-2" });
    await propose("by another job", { runId: "other", job: "not-here", conversation: session });
    const bobs = await propose("by the job, for bob", { runId, conversation: session, actor: "bob" });
    const turns = (await get("alice", session)).body.turns;
    const where = (id: string) => turns.filter((t: any) => t.proposals.some((p: any) => p.id === id)).map((t: any) => t.runId);
    assert.deepEqual(where(ofRun.id), [started.runId], "on the turn that started the job run");
    assert.deepEqual(where(ofChild.id), [started.runId], "a run inside the job: on the turn holding the job's card");
    assert.deepEqual(
      turns.flatMap((t: any) => t.proposals.map((p: any) => p.title)),
      ["by the job's run", "by a run inside the job", "by the job, for bob"],
      "made elsewhere, or by a job not started here, it shows nowhere here",
    );
    // A person's token: only their own, as visibleTo decides.
    const mine = (await get("alice", session, "", "peer:person")).body.turns.flatMap((t: any) => t.proposals.map((p: any) => p.id));
    assert.deepEqual(mine, [ofRun.id, ofChild.id]);
    assert.ok(!mine.includes(bobs.id));
  });

  it("a wake turn carries what the job run it woke on delivered, resolved, with the run's workflow", async () => {
    const { strut, say, get, idle } = await boot({
      reply: () => ({ text: "Looking into it.", start: { brief: "Find flights", title: "Flights" }, artifacts: [] }),
    });
    await strut.workspace.publishWorkflow("job", "v2", {
      steps: [{ id: "result", type: "pack", config: { text: "found 3", artifacts: [
        { id: "flights", kind: "markdown", title: "Flights", content: "# 3 flights" },
        { id: "fares", title: "Fares", url: "https://example.com/fares" },
      ] } }],
    });
    await say("alice", "c-1", "flights?", { wake: true });
    await until(async () => ((await get("alice", "c-1")).body.turns.length === 2 ? true : undefined), "the wake turn");
    await idle();
    const [wake, person] = (await get("alice", "c-1")).body.turns;
    assert.deepEqual(wake.delivered, [{
      job: person.jobs[0].job,
      runId: person.jobs[0].runId,
      workflow: "job",
      artifacts: [
        { id: "flights", kind: "markdown", title: "Flights", content: "# 3 flights" },
        { id: "fares", kind: "url", title: "Fares", url: "https://example.com/fares" },
      ],
    }]);
    assert.equal(person.delivered, undefined, "a person's turn woke on nothing");
  });

  it("a list row shows the jobs its turns started — title, running, the pull requests they delivered — and an older record gets them on its next list", async () => {
    const { strut, say, list, idle } = await boot({
      reply: () => ({ text: "On it.", start: { brief: "Fix the login", title: "Login fix" }, artifacts: [] }),
    });
    await strut.workspace.publishWorkflow("job", "v2", {
      steps: [{ id: "result", type: "pack", config: { text: "done", artifacts: [{ id: "pr", kind: "pull_request", title: "Fix login", url: "https://github.com/a/b/pull/5" }] } }],
    });
    await say("alice", "c-1", "fix the login");
    await idle();
    const row = async () => (await list("alice")).body.conversations.find((c: any) => c.id === "c-1");
    const r = await row();
    assert.equal(r.jobs.length, 1);
    assert.deepEqual({ ...r.jobs[0], job: "<id>" }, { job: "<id>", title: "Login fix", prs: [{ url: "https://github.com/a/b/pull/5", title: "Fix login", repo: "a/b", number: 5 }] });
    assert.equal(r.moreJobs, undefined);

    // A record from before jobs were kept: the next list reads them from its turns.
    const file = join(dir, "conversations", "sessions", `${encodeId("c-1")}.json`);
    const rec = JSON.parse(await readFile(file, "utf8"));
    delete rec.jobs;
    await writeFile(file, JSON.stringify(rec));
    const viewer = join(dir, "conversations", "viewers", `${encodeId("alice")}.json`);
    const idx = JSON.parse(await readFile(viewer, "utf8"));
    delete idx.conversations["c-1"].jobs;
    await writeFile(viewer, JSON.stringify(idx));
    assert.equal((await row()).jobs, undefined, "not yet");
    const again = await until(async () => ((await row()).jobs ? await row() : undefined), "the backfill");
    assert.equal(again.jobs[0].title, "Login fix");
  });

  it("a failed turn shows, with its error", async () => {
    const { say, get } = await boot();
    await say("alice", "c-1", "hello");
    await say("alice", "c-1", "boom");
    const { body } = await get("alice", "c-1");
    assert.deepEqual(body.turns.map((t: any) => [t.prompt, t.status]), [["boom", "error"], ["hello", "success"]]);
    assert.ok(body.turns[0].error);
  });

  it("a session from before the index is built from its turn lines: at the first list, and at a read", async () => {
    const { say, list, get } = await boot();
    await say("alice", "old-1", "@acme\nthe old chat");
    await say("alice", "old-2", "another old one");
    // As if the index never was.
    await rm(join(dir, "conversations"), { recursive: true, force: true, maxRetries: 5 });

    const { body } = await list("alice");
    assert.deepEqual(
      body.conversations.map((c: any) => [c.id, c.title, c.turns, c.unread]).sort(),
      [["old-1", "the old chat", 1, false], ["old-2", "another old one", 1, false]],
      "built from the sessions, its history read",
    );

    await rm(join(dir, "conversations"), { recursive: true, force: true, maxRetries: 5 });
    const read = await get("alice", "old-1");
    assert.equal(read.status, 200);
    assert.equal(read.body.turns[0].prompt, "@acme\nthe old chat");
    assert.equal((await get("bob", "old-1")).status, 404, "still alice's alone");
  });

  it("a fork is a new session with the source's messages: the agent remembers", async () => {
    const { strut, requests, say, req, get, as } = await boot();
    await say("alice", "c-1", "my dog is called Rex");
    const fork = await req("/conversations/fork", { method: "POST", body: { session: "c-1" }, headers: as("alice") });
    assert.equal(fork.status, 201, JSON.stringify(fork.body));
    const id = fork.body.id as string;
    assert.match(id, /^alice\/[0-9a-f]{12}$/);
    assert.equal(fork.body.forkedFrom, "c-1");
    assert.equal(fork.body.title, "my dog is called Rex");

    const [src, copy] = await Promise.all([strut.sessionStore.load("c-1"), strut.sessionStore.load(id)]);
    assert.deepEqual(copy?.messages, src?.messages);
    assert.equal(copy?.system, src?.system);
    assert.equal((await get("alice", id)).body.turns.length, 1, "its history shows");
    assert.equal((await get("bob", id)).status, 404, "the forker's alone");

    await say("alice", id, "what is my dog called?");
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("my dog is called Rex"), "the earlier turn is replayed");
    assert.equal((await req("/conversations/fork", { method: "POST", body: { session: "c-1", id }, headers: as("alice") })).status, 409);
  });

  it("wait holds until a turn lands or settles past `since`", async () => {
    const { say, get, req, idle, as } = await boot();
    await say("alice", "c-1", "one");
    const { body: before } = await get("alice", "c-1");

    const t0 = Date.now();
    const quiet = await get("alice", "c-1", `&wait=300&since=${before.rev}`);
    assert.ok(Date.now() - t0 >= 250, "held while nothing changed");
    assert.equal(quiet.body.rev, before.rev);

    const waiting = get("alice", "c-1", `&wait=20000&since=${before.rev}`);
    await new Promise((r) => setTimeout(r, 50));
    const launched = await req(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { method: "POST", body: { input: { prompt: "two", session: "c-1" } }, headers: as("alice") });
    const landed = await waiting;
    assert.ok(landed.body.rev > before.rev);
    assert.equal(landed.body.turns[0].runId, launched.body.runId, "the new turn, in flight or done");
    await idle();
    const t1 = Date.now();
    const settled = await get("alice", "c-1", `&wait=20000&since=${before.rev}`);
    assert.ok(Date.now() - t1 < 1000, "a `since` behind answers at once");
    assert.equal(settled.body.turns[0].status, "success");
  });

  it("a person's token sees its own conversations and shared ones; a plain peer none", async () => {
    const { say, list, get, update } = await boot();
    await say("alice", "c-1", "alice's");
    await say("bob", "c-2", "bob's");
    assert.deepEqual((await list("bob", "", "peer:person")).body.conversations.map((c: any) => c.id), ["c-2"]);
    assert.equal((await get("bob", "c-1", "", "peer:person")).status, 404);
    assert.equal((await update("bob", { session: "c-2", seen: true }, "peer:person")).status, 200, "a person's token may change its own");
    await update("alice", { session: "c-1", shared: true });
    assert.equal((await get("bob", "c-1", "", "peer:person")).status, 200);
    const peer = await list("bob", "", "peer");
    assert.deepEqual([peer.status, peer.body.conversations], [200, []], "a plain peer reads, and sees none");
    assert.equal((await get("bob", "c-2", "", "peer")).status, 404);
    assert.equal((await update("bob", { session: "c-2", seen: true }, "peer")).status, 403);
  });

  it("a person's token continues a conversation it took a turn in, or a shared one, as it is; never another's", async () => {
    const { say, req, get, update, idle, requests, as } = await boot();
    // Hive's ids are bare: its turns run with the deployment's key.
    await say("alice", "c-1", "flights to Lisbon?");
    await say("bob", "c-2", "bob's plan");
    const sessionIds = async () => ((await req("/sessions")).body.sessions as Array<{ id: string }>).map((s) => s.id).sort();
    const turn = (actor: string, session: string, prompt: string) =>
      req(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { method: "POST", body: { input: { prompt, session } }, headers: as(actor, "peer:person") });

    // Alice took a turn in c-1: her token continues it, and the agent remembers.
    const mine = await turn("alice", "c-1", "and hotels?");
    assert.equal(mine.status, 202, JSON.stringify(mine.body));
    await idle();
    const events = (await req(`/workflows/${ORCHESTRATOR_WORKFLOW}/runs/${mine.body.runId}/events`)).body as any[];
    assert.equal(events.find((e) => e.type === "run.start").continues, "c-1");
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("flights to Lisbon?"), "the thread's history was sent");
    assert.deepEqual((await get("alice", "c-1")).body.turns.map((t: any) => t.prompt), ["and hotels?", "flights to Lisbon?"]);
    assert.deepEqual(await sessionIds(), ["c-1", "c-2"], "no peer/c-1");

    // Bob's: refused, and nothing launched.
    const theirs = await turn("alice", "c-2", "let me in");
    assert.equal(theirs.status, 403);
    assert.match(theirs.body.error, /^conversation_not_yours: "c-2"/);
    assert.equal((await get("bob", "c-2")).body.turns.length, 1);

    // Shared, it is hers to join; her turn makes her a participant, so she
    // keeps it once it is unshared.
    await update("bob", { session: "c-2", shared: true });
    assert.equal((await turn("alice", "c-2", "joining")).status, 202);
    await idle();
    await update("bob", { session: "c-2", shared: false });
    assert.equal((await turn("alice", "c-2", "still here")).status, 202);
    await idle();
    assert.deepEqual((await get("bob", "c-2")).body.participants, ["bob", "alice"]);
    // Carol only read it while it was shared: reading is not a turn.
    await update("bob", { session: "c-2", shared: true });
    assert.equal((await get("carol", "c-2")).status, 200);
    await update("bob", { session: "c-2", shared: false });
    assert.equal((await turn("carol", "c-2", "me too")).status, 403);

    // An id that is no conversation stays in the peer namespace, as before.
    assert.equal((await turn("alice", "scratch", "hello")).status, 202);
    await idle();
    assert.deepEqual(await sessionIds(), ["c-1", "c-2", "peer/scratch"]);
  });

  it("a host key (plans/jamie-in-tribes.md §5.1): turns of its own conversations as a linked person, read back; continued by it alone", async () => {
    process.env["STRUT_HOST_KEYS"] = "sphinx:host-token-1";
    const { strut, req, say, list, idle, as } = await boot();
    const ADA = `02${"ab".repeat(32)}`;
    const BOB = `03${"cd".repeat(32)}`;
    const host = (account?: string) => ({ authorization: "Bearer host-token-1", ...(account ? { "x-strut-account": account } : {}) });
    const session = "host/sphinx/3f9a0c21b7e4";
    const launch = { input: { prompt: "Ada: @jamie what did we decide?", session }, wake: true };
    const turn = (account: string | undefined, body: Record<string, unknown>) =>
      req(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { method: "POST", body, headers: host(account) });

    // A turn needs a linked person: no account, another kind's, or one
    // nobody linked is refused, and nothing launches.
    assert.equal((await turn(undefined, launch)).status, 400);
    assert.equal((await turn("email:ada@example.com", launch)).status, 400);
    const unlinked = await turn(`sphinx:${ADA}`, launch);
    assert.equal(unlinked.status, 403);
    assert.match(unlinked.body.error, /^not_linked: sphinx:02abab/);

    // Ada links her key (through Peel, plans/people-and-hosts.md §2.1); the
    // host asks who it is. A host links nothing itself.
    assert.equal((await req(`/hosts/links/${ADA}`, { headers: host() })).status, 404);
    assert.equal((await req("/hosts/link", { method: "POST", body: { code: "link-abcdefgh", key: ADA }, headers: host() })).status, 403);
    await strut.people.link({ kind: "sphinx", key: ADA }, "ada", { name: "ada on sphinx" });
    assert.deepEqual([(await req(`/hosts/links/sphinx:${ADA}`, { headers: host() })).body.actor, (await req(`/hosts/links/${ADA}`, { headers: host() })).body.name], ["ada", "ada on sphinx"]);
    assert.equal((await req("/hosts/links/nope", { headers: host() })).status, 400);
    await strut.people.link({ kind: "sphinx", key: BOB }, "bob");

    // The workflow as published, on the host's own namespace, a conversation workflow.
    assert.equal((await turn(`sphinx:${ADA}`, { ...launch, params: { model: "x" } })).status, 403);
    assert.equal((await turn(`sphinx:${ADA}`, { ...launch, input: { prompt: "hi", session: "ada/1" } })).status, 403);
    assert.equal((await turn(`sphinx:${ADA}`, { ...launch, input: { prompt: "hi", session: "host/email/1" } })).status, 403);
    assert.equal((await req("/workflows/job/run", { method: "POST", body: { input: { prompt: "x", session } }, headers: host(`sphinx:${ADA}`) })).status, 403);

    // As Ada: woken like her own turn, never an admin's.
    const ok = await turn(`sphinx:${ADA}`, launch);
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.equal(ok.body.wake, true);
    await idle();
    const start = ((await req(`/workflows/${ORCHESTRATOR_WORKFLOW}/runs/${ok.body.runId}/events`)).body as any[]).find((e) => e.type === "run.start");
    assert.deepEqual([start.origin, start.host, start.actor, start.wakeAsked], ["host", "sphinx", "ada", true]);

    // The host reads its own conversations, whoever spoke, and no other.
    const read = await req(`/conversations/item?id=${encodeURIComponent(session)}`, { headers: host() });
    assert.equal(read.status, 200);
    assert.equal(read.body.conversation.host, "sphinx");
    assert.deepEqual(read.body.turns.map((t: any) => [t.prompt, t.status]), [["Ada: @jamie what did we decide?", "success"]]);
    await say("bob", "c-2", "bob's own");
    assert.equal((await req("/conversations/item?id=c-2", { headers: host() })).status, 404);
    // Listed for Ada, who took a turn, with its host; for nobody named "host".
    assert.deepEqual((await list("ada")).body.conversations.map((c: any) => [c.id, c.host]), [[session, "sphinx"]]);
    assert.deepEqual((await list("host")).body.conversations, []);

    // Continued by its host alone; Ada forks it to continue it in the app.
    const hers = await req(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { method: "POST", body: { input: { prompt: "from the app", session } }, headers: as("ada", "peer:person") });
    assert.equal(hers.status, 403);
    assert.match(hers.body.error, /^conversation_hosted: /);
    const fork = await req("/conversations/fork", { method: "POST", body: { session }, headers: as("ada", "peer:person") });
    assert.equal(fork.status, 201, JSON.stringify(fork.body));
    assert.ok(fork.body.id.startsWith("ada/"));
    assert.equal(fork.body.host, undefined);

    // A proposal made there: decided as the person the turn ran as, never as an admin.
    const root = proposalsRoot(dir);
    const by = { workflow: ORCHESTRATOR_WORKFLOW, runId: ok.body.runId, path: "orchestrator/agent", conversation: session, actor: "ada" };
    const install = await createProposal(root, { step: "package/install", input: {}, title: "Install a package", approver: "admin", by });
    const decide = (id: string, account: string, action = "accept") => req(`/proposals/${id}/decide`, { method: "POST", body: { action }, headers: host(account) });
    const refused = await decide(install.id, `sphinx:${ADA}`);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /^admin_required:/);
    assert.equal((await decide(install.id, `sphinx:${BOB}`, "reject")).status, 403, "not Bob's");
    assert.equal((await decide(install.id, `sphinx:${ADA}`, "reject")).status, 200);
    const elsewhere = await createProposal(root, { step: "package/install", input: {}, title: "x", by: { ...by, conversation: "ada/other" } });
    assert.equal((await decide(elsewhere.id, `sphinx:${ADA}`, "reject")).status, 404);

    // Nothing else opens to the host key.
    for (const [method, path] of [["GET", "/workflows"], ["GET", "/conversations"], ["POST", "/conversations/fork"], ["GET", "/people"], ["POST", `/workflows/${ORCHESTRATOR_WORKFLOW}/runs/${ok.body.runId}/cancel`], ["POST", `/workflows/${ORCHESTRATOR_WORKFLOW}/v1/run`]] as const) {
      assert.equal((await req(path, { method, headers: host(`sphinx:${ADA}`), ...(method === "POST" ? { body: {} } : {}) })).status, 403, `${method} ${path}`);
    }
  });
});
