import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createEventsSink, slimRunEvent, SINK_FIELDS, type SinkBatch } from "./events-sink.js";
import { defineStep, withMessages, withUsage, type RunEvent } from "./core.js";
import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

/** A step.end with everything a run can put on an event — what must NOT
 *  leave is marked SECRET-*. */
const fat: RunEvent = {
  ts: "2026-10-21T00:00:00.000Z",
  runId: "1",
  path: "wf/step",
  type: "step.end",
  stepType: "agent",
  durationMs: 12,
  iteration: 2,
  input: { prompt: "SECRET-INPUT" },
  output: { text: "SECRET-OUTPUT" },
  messages: [{ role: "user", content: "SECRET-TRANSCRIPT" }],
  params: { system: "SECRET-PARAM" },
  paramOverrides: { child: { k: "SECRET-OVERRIDE" } },
  error: { message: "boom", stack: "SECRET-STACK" },
  nodes: [{ ref_id: "n1", name: "SECRET-NODE" }],
  stepHashes: { "x/y": "SECRET-HASH-MAP" },
  mcp: [{ name: "hive", origin: "https://SECRET-MCP" }],
  callback: { origin: "https://SECRET-CALLBACK" },
  workflowHash: "abc",
  stepVersion: { version: "v2", hash: "def" },
  cassette: "replay",
  origin: "schedule",
  automation: { id: "a1" },
  actor: "evan",
  principal: "evan",
  job: "j1",
  verify: { checkId: "c1", subject: "step:x", sourceRunId: "0" },
  subflow: { workflow: "child", hash: "ghi" },
  parentRunId: "0",
  toolCallId: "t1",
  modelCalls: 1,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as RunEvent["usage"],
  cost: 0.01,
};

describe("slimRunEvent", () => {
  it("keeps the envelope — the allowlist and the error's message — and nothing a workflow handled", () => {
    const slim = slimRunEvent("wf", fat);
    assert.ok(!JSON.stringify(slim).includes("SECRET"), JSON.stringify(slim));
    assert.deepEqual(Object.keys(slim).sort(), ["workflow", ...SINK_FIELDS, "error"].sort());
    assert.equal(slim.workflow, "wf");
    assert.deepEqual(slim.error, { message: "boom" });
    assert.deepEqual(slim.usage, fat.usage);
  });

  it("leaves out what the event does not carry", () => {
    const slim = slimRunEvent("wf", { ts: "t", runId: "1", path: "wf", type: "run.start" });
    assert.deepEqual(slim, { workflow: "wf", ts: "t", runId: "1", path: "wf", type: "run.start" });
  });
});

describe("createEventsSink", () => {
  const ev = (n: number, type: RunEvent["type"] = "step.end"): RunEvent => ({
    ts: `t${n}`,
    runId: "r",
    path: `wf/s${n}`,
    type,
    output: `SECRET-${n}`,
  });
  const paths = (batches: SinkBatch[]) => batches.flatMap((b) => b.events.map((e) => e.path));

  /** A fake listener: records each batch, answers as told. */
  function listener(answer: (batch: SinkBatch, call: number) => Promise<Response> | Response = () => new Response(null, { status: 204 })) {
    const batches: SinkBatch[] = [];
    let calls = 0;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const batch = JSON.parse(init!.body as string) as SinkBatch;
      calls++;
      const res = await answer(batch, calls);
      if (res.ok) batches.push(batch);
      return res;
    };
    return { batches, fetch: fetch as unknown as typeof globalThis.fetch, calls: () => calls };
  }

  it("posts queued events as one batch, in order, as run.events", async () => {
    const host = listener();
    const sink = createEventsSink({ url: "http://sink.test/events", fetch: host.fetch, flushMs: 10_000 });
    sink.push("wf", ev(1, "run.start"));
    sink.push("wf", ev(2));
    sink.push("wf", ev(3, "run.end"));
    await sink.flush();
    assert.equal(host.batches.length, 1);
    assert.equal(host.batches[0]!.event, "run.events");
    assert.deepEqual(paths(host.batches), ["wf/s1", "wf/s2", "wf/s3"]);
    assert.ok(!JSON.stringify(host.batches).includes("SECRET"));
    await sink.flush(); // nothing queued: no empty POST
    assert.equal(host.calls(), 1);
  });

  it("flushes on its own after flushMs", async () => {
    const host = listener();
    const sink = createEventsSink({ url: "http://sink.test/events", fetch: host.fetch, flushMs: 20 });
    sink.push("wf", ev(1));
    assert.equal(host.calls(), 0);
    for (let i = 0; i < 50 && host.calls() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(paths(host.batches), ["wf/s1"]);
  });

  it("splits a full queue into batches of maxBatch and posts at once when one fills", async () => {
    const host = listener();
    const sink = createEventsSink({ url: "http://sink.test/events", fetch: host.fetch, flushMs: 10_000, maxBatch: 100 });
    for (let i = 1; i <= 250; i++) sink.push("wf", ev(i));
    await sink.flush();
    assert.deepEqual(
      host.batches.map((b) => b.events.length),
      [100, 100, 50],
    );
    assert.deepEqual(
      paths(host.batches),
      Array.from({ length: 250 }, (_, i) => `wf/s${i + 1}`),
    );
  });

  it("keeps batches in order under a slow listener: one POST in flight at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const host = listener(async (_b, call) => {
      if (call === 1) await gate;
      return new Response(null, { status: 204 });
    });
    const sink = createEventsSink({ url: "http://sink.test/events", fetch: host.fetch, flushMs: 10_000 });
    sink.push("wf", ev(1));
    const first = sink.flush(); // in flight, held at the listener
    sink.push("wf", ev(2));
    sink.push("wf", ev(3));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.calls(), 1, "the second batch waits for the first");
    release();
    await first;
    await sink.flush();
    assert.deepEqual(
      host.batches.map((b) => b.events.map((e) => e.path)),
      [["wf/s1"], ["wf/s2", "wf/s3"]],
    );
  });

  it("drops a batch the listener will not take and goes on with the next", async () => {
    const host = listener((_b, call) => (call === 1 ? new Response(null, { status: 500 }) : new Response(null, { status: 204 })));
    const sink = createEventsSink({ url: "http://sink.test/events", fetch: host.fetch, flushMs: 10_000, retryDelaysMs: [] });
    sink.push("wf", ev(1));
    await sink.flush();
    sink.push("wf", ev(2));
    await sink.flush();
    assert.deepEqual(paths(host.batches), ["wf/s2"]);
    assert.equal(host.calls(), 2, "no retry past retryDelaysMs; the run never waited");
  });

  it("a listener that cannot keep up loses the oldest queued events, never the newest", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const host = listener(async (_b, call) => {
      if (call === 1) await gate;
      return new Response(null, { status: 204 });
    });
    const sink = createEventsSink({ url: "http://sink.test/events", fetch: host.fetch, flushMs: 10_000, maxQueue: 3 });
    sink.push("wf", ev(1));
    const first = sink.flush(); // [1] in flight
    for (let i = 2; i <= 6; i++) sink.push("wf", ev(i)); // 2 and 3 fall off the front
    release();
    await first;
    assert.deepEqual(paths(host.batches), ["wf/s1", "wf/s4", "wf/s5", "wf/s6"]);
  });

  it("close flushes; a push after it posts at once", async () => {
    const host = listener();
    const sink = createEventsSink({ url: "http://sink.test/events", fetch: host.fetch, flushMs: 10_000 });
    sink.push("wf", ev(1));
    await sink.close();
    assert.deepEqual(paths(host.batches), ["wf/s1"]);
    sink.push("wf", ev(2));
    for (let i = 0; i < 50 && host.batches.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(paths(host.batches), ["wf/s1", "wf/s2"]);
  });
});

describe("createStrut({ eventsSink })", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-events-sink-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const talker = defineStep({
    type: "talker",
    input: z.object({ said: z.string() }),
    output: z.any(),
    async run(cfg) {
      return withUsage(withMessages({ heard: cfg.said }, [{ role: "user", content: cfg.said }]), {
        modelCalls: 1,
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        cost: 0.002,
      });
    },
  });
  const boom = defineStep({
    type: "boom",
    input: z.object({ secret: z.string() }),
    output: z.any(),
    async run(cfg) {
      // The input is on `step.start` and `step.error`; the message is the step's own words.
      throw new Error(`kaboom (${cfg.secret.length} chars in)`);
    },
  });

  /** A stand-in listener on a real port: what strut posts. */
  async function sinkHost(): Promise<{ url: string; posts: Array<{ path: string; body: SinkBatch }>; close: () => void }> {
    const posts: Array<{ path: string; body: SinkBatch }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        posts.push({ path: req.url!, body: JSON.parse(body) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/events?token=s3cret`, posts, close: () => server.close() };
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(cond(), "condition never held");
  }

  it("posts every run's events, the envelope only, to the sink — and nothing waits on it", async () => {
    const host = await sinkHost();
    const store = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([talker, boom]),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      eventsSink: { url: host.url },
    });
    try {
      await strut.workspace.publishWorkflow("chatty", "v1", {
        steps: [
          {
            id: "each",
            type: "foreach",
            config: { items: ["one", "two"], body: { id: "say", type: "talker", config: { said: "SECRET-{{ $current }}" } } },
          },
        ],
      });
      await strut.workspace.publishWorkflow("bad", "v1", {
        steps: [{ id: "b", type: "boom", config: { secret: "{{ input.secret }}" } }],
      });
      const launch = async (path: string, body: unknown) => {
        const res = await strut.app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 202);
        return ((await res.json()) as { runId: string }).runId;
      };
      const chatty = await launch("/workflows/chatty/run", { input: {} });
      const bad = await launch("/workflows/bad/run", { input: { secret: "SECRET-INPUT" } });

      const received = () => host.posts.flatMap((p) => p.body.events);
      const terminal = (runId: string) => received().some((e) => e.runId === runId && (e.type === "run.end" || e.type === "run.error"));
      await until(() => terminal(chatty) && terminal(bad));

      // The URL as given, every post the batch shape.
      assert.ok(host.posts.every((p) => p.path === "/events?token=s3cret" && p.body.event === "run.events"));

      // Each run's events arrive whole and in order, and are exactly the log's envelopes.
      for (const [name, runId] of [
        ["chatty", chatty],
        ["bad", bad],
      ] as const) {
        const logged = (await store.getRunEvents(name, runId)).map((e) => slimRunEvent(name, e));
        assert.deepEqual(
          received().filter((e) => e.runId === runId),
          logged,
          name,
        );
      }

      // Nothing a workflow handled left: no input, output, transcript or stack.
      const text = JSON.stringify(host.posts);
      assert.ok(!text.includes("SECRET"), text);
      assert.ok(!text.includes('"role"') && !text.includes('"messages"') && !text.includes('"output"') && !text.includes('"input"'));
      const failed = received().find((e) => e.runId === bad && e.type === "run.error")!;
      assert.deepEqual(failed.error, { message: "kaboom (12 chars in)" }, "the message, never the stack");

      // What a listener draws from: the step lit up, how long, what it spent.
      const says = received().filter((e) => e.runId === chatty && e.type === "step.end" && e.stepType === "talker");
      assert.equal(says.length, 2);
      assert.ok(says.every((e) => e.modelCalls === 1 && e.cost === 0.002 && typeof e.durationMs === "number"));
      // The run's spend, as the summary computes it: the sum over its step.ends.
      const spent = received()
        .filter((e) => e.runId === chatty && e.type === "step.end")
        .reduce((n, e) => n + (e.modelCalls ?? 0), 0);
      assert.equal(spent, 2);
      const end = received().find((e) => e.runId === chatty && e.type === "run.end")!;
      assert.equal(end.workflow, "chatty");

      // The run records nothing of the sink: the URL is the deployment's.
      assert.ok(!JSON.stringify(await store.getRunEvents("chatty", chatty)).includes("s3cret"));
    } finally {
      await strut.close();
      host.close();
    }
  });

  it("a sink URL that is not http(s) fails the boot", async () => {
    await assert.rejects(
      createStrut({
        workspace: new WorkspaceManager(tempDir),
        registry: await createRegistry([talker]),
        store: new MemoryRunStore(),
        serveUi: false,
        enableChat: false,
        scheduler: false,
        eventsSink: { url: "ftp://viz.example/events" },
      }),
      /STRUT_EVENTS_SINK.*http\(s\)/,
    );
  });

  it("a host's own services.onRunEvent still runs, before the sink's push", async () => {
    const host = await sinkHost();
    const seen: string[] = [];
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([talker]),
      store: new MemoryRunStore(),
      services: {
        onRunEvent: (workflow: string, event: RunEvent) => {
          seen.push(`${workflow}:${event.type}`);
        },
      },
      serveUi: false,
      enableChat: false,
      scheduler: false,
      eventsSink: { url: host.url },
    });
    try {
      await strut.workspace.publishWorkflow("one", "v1", {
        steps: [{ id: "say", type: "talker", config: { said: "hi" } }],
      });
      const result = await strut.run("one", {});
      assert.equal(result.status, "success");
      assert.deepEqual(seen, ["one:run.start", "one:step.start", "one:step.end", "one:run.end"]);
      await until(() => host.posts.flatMap((p) => p.body.events).some((e) => e.type === "run.end"));
      assert.deepEqual(
        host.posts.flatMap((p) => p.body.events).map((e) => e.type),
        ["run.start", "step.start", "step.end", "run.end"],
      );
    } finally {
      await strut.close();
      host.close();
    }
  });
});
