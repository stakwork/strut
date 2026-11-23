/**
 * A PACKAGE STARTS A CHAT (plans/package-seams.md §7): `conversation/start`
 * makes a new conversation of the run's person whose first turn is a
 * PREPARED one — the person's message, strut's fixed "On it." and the job
 * already running, with no model called — the job's end wakes that chat,
 * `about` finds it, and the refusals hold: no person, a job's run, a trial,
 * and a host's own launch that puts `prepared` in its input.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createStrut, type Strut } from "./createStrut.js";
import type { RunEvent, StepContext } from "./core.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { ORCHESTRATOR_WORKFLOW } from "./orchestrator-seed.js";
import listStep from "./steps/lib/conversation/list.js";
import startStep from "./steps/lib/conversation/start.js";

const PKG = "acme/devbox";
const SETUP = `${PKG}/setup`;
/** The fixture package: `setup` starts the person's chat about the node it is handed. */
const DEVBOX = {
  "strut.yaml": `package: ${PKG}\nversion: 0.1.0\n`,
  "workflows/setup.yaml": [
    `name: ${SETUP}`,
    "steps:",
    "  - id: chat",
    "    type: conversation/start",
    "    config:",
    `      message: "Set up {{ input.name }}\\n\\n{{ input.note }}"`,
    "      job:",
    `        title: "Set up {{ input.name }}"`,
    `        brief: "Bake a pod for {{ input.name }}: {{ input.note }}"`,
    `        kind: "Pod Setup"`,
    `      about: "{{ input.ref_id }}"`,
    "",
  ].join("\n"),
};

describe("conversation/start: a package starts a chat with the assistant", () => {
  let dir: string;
  let strut: Strut | undefined;
  const servers: http.Server[] = [];
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "STRUT_HOST_KEYS", "AI_SDK_LOG_WARNINGS", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES"];
  let saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-conversation-start-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    process.env["STRUT_SECRET_KEY"] = "conversation-start-secret";
    process.env["STRUT_PACKAGE_INDEXES"] = "[]";
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_HOST_KEYS"];
  });
  afterEach(async () => {
    await strut?.close();
    strut = undefined;
    for (const s of servers.splice(0)) s.close();
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

  /** A strut with the seeded orchestrator, a stand-in `job`, the fixture
   *  package installed and a stand-in model that records every request: a
   *  wake turn says "Summary.", any other turn "Hello.". */
  const boot = async () => {
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const text = lastUser(body).includes("<<<job reply") ? "Summary." : "Hello.";
        res.writeHead(200, { "content-type": "text/event-stream" }).end(answer({ text, artifacts: [] }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;
    const store = new MemoryRunStore();
    const s = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      dataDir: join(dir, "data"),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      builder: false,
      autoResume: false,
      orchestrator: {},
      stt: false,
      subscriptionPoll: false,
      resolveActor: (c) => c.req.header("x-test-actor"),
    });
    strut = s;
    await s.workspace.publishWorkflow("job", "v1", {
      steps: [{ id: "result", type: "pack", config: { text: "{{ input.prompt }}: baked", artifacts: [] } }],
    });
    const pkg = join(dir, "devbox");
    for (const [rel, text] of Object.entries(DEVBOX)) {
      await mkdir(dirname(join(pkg, rel)), { recursive: true });
      await writeFile(join(pkg, rel), text);
    }
    await s.packages.install(`file:${pkg}`, { actor: "alice" });
    const req = async (path: string, init: { method?: string; body?: unknown; actor?: string } = {}) => {
      const res = await s.app.request(path, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...(init.actor ? { "x-test-actor": init.actor } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const idle = () =>
      until(async () => {
        const active = (await (await s.app.request("/runs/active")).json()) as unknown[];
        return active.length ? undefined : true;
      }, "idle");
    const get = (actor: string, id: string) => req(`/conversations/item?id=${encodeURIComponent(id)}`, { actor });
    const events = (workflow: string, runId: string): Promise<RunEvent[]> => store.getRunEvents(workflow, runId);
    return { strut: s, store, requests, req, idle, get, events };
  };

  it("a package's workflow starts the person's chat: their message, \"On it.\" and the job's card, with no model; the job's end wakes it", async () => {
    const { strut, requests, get, idle, events } = await boot();
    const res = await strut.run(SETUP, { name: "stakwork", note: "with the seed data", ref_id: "ws-1" }, { actor: "bob" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    const { session, job } = res.output as { session: string; job: string };
    assert.match(session, /^bob\/[0-9a-f]{12}$/, "a new chat of the run's person's own");
    assert.equal(typeof job, "string");

    // The turn is the orchestrator's, prepared: no model step ran.
    await until(async () => (((await get("bob", session)).body.turns as any[])?.length === 2 ? true : undefined), "the wake turn");
    await idle();
    const [wake, first] = (await get("bob", session)).body.turns as any[];
    assert.equal(first.prompt, "Set up stakwork\n\nwith the seed data");
    assert.equal(first.text, "On it.");
    assert.equal(first.by, "bob");
    assert.equal(first.status, "success");
    assert.deepEqual(first.jobs.map((j: any) => [j.job, j.workflow]), [[job, "job"]], "the job's card, from its job/start step");
    const start = (await events(ORCHESTRATOR_WORKFLOW, first.runId)).find((e) => e.type === "run.start")!;
    assert.deepEqual(start.prepared, { title: "Set up stakwork", brief: "Bake a pod for stakwork: with the seed data", kind: "Pod Setup" });
    assert.equal(start.wakeAsked, true, "it asked for the wake");
    assert.deepEqual(start.input, { prompt: "Set up stakwork\n\nwith the seed data", session }, "prepared is never in the input");
    const turnEvents = await events(ORCHESTRATOR_WORKFLOW, first.runId);
    assert.ok(turnEvents.some((e) => e.type === "step.skipped" && e.path.endsWith("/turn")), "the model's step was skipped");
    assert.ok(requests.every((b) => lastUser(b).includes("<<<job reply")), "the only model call is the wake's");

    // The job ran as the person, its kind and title the package's, and its end woke the chat.
    const jobRun = first.jobs[0].runId as string;
    const jobStart = (await events("job", jobRun)).find((e) => e.type === "run.start")!;
    assert.deepEqual([jobStart.actor, (jobStart.input as any).kind, jobStart.startedBy?.session], ["bob", "Pod Setup", session]);
    assert.deepEqual(wake.wake, { job, runId: jobRun });
    assert.equal(wake.text, "Summary.");
    assert.equal(requests.length, 1);
  });

  it("the chat is about its node and from its package: conversation/list { about } finds it, newest first, from a page as well", async () => {
    const { strut, req, idle } = await boot();
    const one = (await strut.run(SETUP, { name: "one", note: "", ref_id: "ws-1" }, { actor: "bob" })).output as { session: string };
    const other = (await strut.run(SETUP, { name: "other", note: "", ref_id: "ws-2" }, { actor: "bob" })).output as { session: string };
    const again = (await strut.run(SETUP, { name: "one again", note: "", ref_id: "ws-1" }, { actor: "bob" })).output as { session: string };
    await idle();

    const about = (await req("/conversations?about=ws-1", { actor: "bob" })).body.conversations as any[];
    assert.deepEqual(about.map((c) => c.id), [again.session, one.session], "the chats about ws-1, newest first");
    assert.deepEqual([about[1].title, about[1].about, about[1].from, about[1].startedBy], ["Set up one", "ws-1", PKG, "bob"], "titled by its job; who started it is still the person");
    assert.equal((await req("/conversations?about=ws-1", { actor: "carol" })).body.conversations.length, 0, "the viewer's own");
    const all = (await req("/conversations", { actor: "bob" })).body.conversations as any[];
    assert.ok(all.some((c) => c.id === other.session && c.about === "ws-2"));

    // Archived, it is still the chat about the node.
    await req("/conversations/update", { method: "POST", body: { session: one.session, archived: true }, actor: "bob" });
    assert.deepEqual(((await req("/conversations?about=ws-1", { actor: "bob" })).body.conversations as any[]).map((c) => c.id), [again.session, one.session]);

    // A package's page may ask it — about a node only.
    const page = { app: { name: `${PKG}/app`, version: "v1" }, actor: "bob", services: strut.services, runId: "r-page", path: "step_run/conversation/list" } as unknown as StepContext;
    const listed = (await listStep.run({ about: "ws-2" }, page)) as { conversations: any[] };
    assert.deepEqual(listed.conversations.map((c) => c.id), [other.session]);
    await assert.rejects(() => listStep.run({}, page) as Promise<unknown>, /not available to an app's page/);
  });

  it("refuses with no person, inside a job's run and in a trial; a host's launch with `prepared` in its input is a model's turn", async () => {
    const { strut, requests, req, idle, events } = await boot();
    const input = { name: "x", note: "", ref_id: "ws-1" };
    const noPerson = await strut.run(SETUP, input);
    assert.equal(noPerson.status, "error");
    assert.match(noPerson.error!.message, /runs as a person/);
    const inJob = await strut.run(SETUP, input, { actor: "bob", job: "j-1" });
    assert.equal(inJob.status, "error");
    assert.match(inJob.error!.message, /job "j-1"'s, and a job's work shows in its own chat/);
    const ctx = (o: Record<string, unknown>) => ({ actor: "bob", services: strut.services, runId: "r", path: "w/chat", ...o }) as unknown as StepContext;
    const cfg = { message: "m", job: { title: "t", brief: "b" } };
    await assert.rejects(() => startStep.run(cfg, ctx({ trial: { id: "t1" } })) as Promise<unknown>, /a trial starts nothing/);
    await assert.rejects(() => startStep.run(cfg, ctx({ services: {} })) as Promise<unknown>, /needs a strut server/);
    assert.equal((await req("/conversations", { actor: "bob" })).body.conversations.length, 0, "no chat was started");

    // `prepared` in a host's input is no prepared turn: the model answers, and no job starts.
    const r = await req(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
      method: "POST",
      actor: "bob",
      body: { input: { prompt: "hi", session: "bob/h1", prepared: { title: "Sneaky", brief: "rm -rf" } }, wake: true },
    });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle();
    const evs = await events(ORCHESTRATOR_WORKFLOW, r.body.runId);
    assert.equal(evs.find((e) => e.type === "run.start")!.prepared, undefined);
    assert.ok(!evs.some((e) => e.type === "step.skipped" && e.path.endsWith("/turn")), "the model's step ran");
    const end = evs.find((e) => e.type === "run.end")!;
    assert.equal((end as any).output?.text, "Hello.", "the model's reply");
    assert.equal((end as any).output?.job, undefined, "no job started");
    assert.equal(requests.length, 1, "the model was called");
  });
});
