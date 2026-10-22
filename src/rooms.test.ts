import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { createRooms } from "./rooms.js";

// Rooms (plans/chained-orchestrators.md §3): the callback contract over a
// socket the client holds open.

type Msg = Record<string, any>;

/** A socket a room can hold, keeping what it was sent. */
function fakeSocket() {
  const listeners: Record<string, () => void> = {};
  return {
    readyState: 1,
    sent: [] as Msg[],
    send(data: string) {
      this.sent.push(JSON.parse(data) as Msg);
    },
    on(event: string, fn: () => void) {
      listeners[event] = fn;
    },
    close() {
      this.readyState = 3;
      listeners["close"]?.();
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, read: () => T | undefined | Promise<T | undefined>, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A socket on a room, with every message it gets — or the status it was
 *  refused with. */
function joinRoom(url: string, headers: Record<string, string>): Promise<{ ws: WebSocket; got: Msg[]; until: (what: string, pred: (m: Msg) => boolean) => Promise<Msg> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const got: Msg[] = [];
    ws.on("message", (data) => got.push(JSON.parse(String(data)) as Msg));
    ws.once("open", () => resolve({ ws, got, until: (what, pred) => waitFor(what, () => got.find(pred)) }));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
  });
}

const refusedWith = (url: string, headers: Record<string, string>) =>
  joinRoom(url, headers).then(
    ({ ws }) => {
      ws.close();
      return 101;
    },
    (err: { status?: number }) => err.status,
  );

const NO_SEEDS = { job: false, orchestrator: false, builder: false, browserWorkflows: false, views: false, concepts: false } as const;

describe("a room", () => {
  it("each message goes to every open socket; with none open they wait, and the next join gets them in order", () => {
    const rooms = createRooms();
    rooms.deliver("tom-1", { n: 1 });
    rooms.deliver("tom-1", { n: 2 });
    rooms.deliver("ann-2", { n: 0 });
    const a = fakeSocket();
    rooms.join("tom-1", a);
    assert.deepEqual(a.sent, [{ n: 1 }, { n: 2 }], "another actor's room is another room");
    const b = fakeSocket();
    rooms.join("tom-1", b);
    assert.deepEqual(b.sent, [], "nothing waited: a had it all");
    rooms.deliver("tom-1", { n: 3 });
    assert.deepEqual([a.sent.at(-1), b.sent], [{ n: 3 }, [{ n: 3 }]]);
    assert.equal(rooms.open("tom-1"), 2);
    a.close();
    b.close();
    assert.equal(rooms.open("tom-1"), 0);
    rooms.deliver("tom-1", { n: 4 });
    const c = fakeSocket();
    rooms.join("tom-1", c);
    assert.deepEqual(c.sent, [{ n: 4 }]);
  });

  it("keeps a bounded queue: past the cap the oldest go", () => {
    const rooms = createRooms(3);
    for (let n = 1; n <= 5; n++) rooms.deliver("tom-1", { n });
    const s = fakeSocket();
    rooms.join("tom-1", s);
    assert.deepEqual(s.sent, [{ n: 3 }, { n: 4 }, { n: 5 }]);
  });
});

describe("rooms on a standalone strut", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  let dir: string;
  let strut: Strut;
  let base: string;
  let tom: string;

  before(async () => {
    process.env["STRUT_API_KEY"] = "deploy-key";
    process.env["STRUT_PEER_KEY"] = "peer-key";
    dir = await mkdtemp(join(tmpdir(), "strut-rooms-"));
    // The job's work: tells the job's host something, then ends.
    const tell = defineStep({
      type: "tell",
      description: "tells the job's host something",
      input: z.any(),
      output: z.any(),
      async run(_cfg, ctx) {
        (ctx.services as { jobs: { notify(job: string, update: Msg): void } }).jobs.notify(ctx.job!, { kind: "note", id: "n1", state: "ready" });
        return { text: "done" };
      },
    });
    strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      store: new MemoryRunStore(),
      registry: await createRegistry([tell]),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      ...NO_SEEDS,
    });
    await strut.workspace.publishWorkflowByContent("job", ["name: job", "steps:", "  - id: t", "    type: tell"].join("\n"));
    // An orchestrator's shape: a turn that starts a job and ends.
    await strut.workspace.publishWorkflowByContent(
      "chat",
      ["name: chat", "peer: person", "steps:", "  - id: s", "    type: job/start", "    config:", "      prompt: go", "      title: A job"].join("\n"),
    );
    await strut.workspace.publishWorkflowByContent("ping", ["name: ping", "peer: true", "steps:", "  - id: v", "    type: log", "    config: { message: hi }"].join("\n"));
    base = `127.0.0.1:${await strut.listen(0, "127.0.0.1")}`;
    const minted = await fetch(`http://${base}/peers/tokens`, {
      method: "POST",
      headers: { authorization: "Bearer deploy-key", "content-type": "application/json" },
      body: JSON.stringify({ actor: "tom-1" }),
    });
    tom = ((await minted.json()) as { token: string }).token;
  });

  after(async () => {
    await strut.close();
    await rm(dir, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const rooms = () => `ws://${base}/rooms`;
  const post = async (path: string, key: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { runId?: string; error?: string; callback?: boolean } };
  };
  /** The chat run's summary and its job's. */
  const settled = async (runId: string) => {
    const chat = await waitFor("the chat's summary", () => strut.store.getRunSummary("chat", runId).then((s) => s ?? undefined));
    const started = chat.output as { job: string; runId: string };
    await waitFor("the job's summary", () => strut.store.getRunSummary("job", started.runId).then((s) => s ?? undefined));
    return started;
  };

  it("who may join: the key with an actor, a person's credential — never a strut's, nor a request that names no actor", async () => {
    assert.equal(await refusedWith(rooms(), {}), 401);
    assert.equal(await refusedWith(rooms(), { authorization: "Bearer peer-key", "x-strut-actor": "tom-1" }), 403);
    assert.equal(await refusedWith(rooms(), { authorization: "Bearer deploy-key" }), 403);
    assert.equal(await refusedWith(rooms(), { authorization: "Bearer deploy-key", "x-strut-actor": "ann-2" }), 101);
    assert.equal(await refusedWith(rooms(), { authorization: `Bearer ${tom}` }), 101);
    // Plain HTTP is no socket, and no other path upgrades.
    assert.equal((await fetch(`http://${base}/rooms`, { headers: { authorization: `Bearer ${tom}` } })).status, 426);
    assert.equal(await refusedWith(`ws://${base}/nope`, { authorization: `Bearer ${tom}` }), 404);
  });

  it("a launch with a room hears its run and its job: the run's run.end, the job's job.update and run.end", async () => {
    const room = await joinRoom(rooms(), { authorization: `Bearer ${tom}` });
    try {
      const launched = await post("/workflows/chat/run", tom, { input: {}, callback: { room: true }, jobCallback: { room: true } });
      assert.equal(launched.status, 202, launched.body.error);
      assert.equal(launched.body.callback, true);
      const runId = launched.body.runId!;
      const chatEnd = await room.until("the chat's run.end", (m) => m.event === "run.end" && m.runId === runId);
      assert.equal(chatEnd["workflow"], "chat");
      assert.equal(chatEnd["status"], "success");
      const { job, runId: jobRun } = chatEnd["output"] as { job: string; runId: string };
      const update = await room.until("the job's update", (m) => m.event === "job.update" && m.job === job);
      assert.deepEqual([update["kind"], update["state"]], ["note", "ready"]);
      const jobEnd = await room.until("the job's run.end", (m) => m.event === "run.end" && m.runId === jobRun);
      assert.deepEqual([jobEnd["workflow"], jobEnd["job"], jobEnd["status"]], ["job", job, "success"]);
      // The log says a room was asked for, never whose.
      const start = (await strut.store.getRunEvents("chat", runId)).find((e) => e.type === "run.start")!;
      assert.deepEqual(start.callback, { room: true });
    } finally {
      room.ws.close();
    }
  });

  it("asleep through it, the socket gets what it missed when it comes back, in order", async () => {
    const launched = await post("/workflows/chat/run", tom, { input: {}, callback: { room: true }, jobCallback: { room: true } });
    assert.equal(launched.status, 202, launched.body.error);
    const { job, runId: jobRun } = await settled(launched.body.runId!);
    await sleep(200); // the callbacks are detached from the runs' teardown
    const room = await joinRoom(rooms(), { authorization: `Bearer ${tom}` });
    try {
      const at = (pred: (m: Msg) => boolean) => room.got.findIndex(pred);
      await room.until("the job's run.end", (m) => m.event === "run.end" && m.runId === jobRun);
      assert.ok(at((m) => m.event === "run.end" && m.runId === launched.body.runId) >= 0, "the chat's run.end");
      const update = at((m) => m.event === "job.update" && m.job === job);
      assert.ok(update >= 0 && update < at((m) => m.event === "run.end" && m.runId === jobRun), "the update before the job's end");
    } finally {
      room.ws.close();
    }
  });

  it("a strut's credential cannot ask for a room, and a run launched without one posts nothing to it", async () => {
    const byStrut = await post("/workflows/ping/run", "peer-key", { input: {}, callback: { room: true } }, { "x-strut-actor": "tom-1" });
    assert.equal(byStrut.status, 400);
    assert.match(byStrut.body.error!, /callback\.room: a room is a person's/);
    assert.equal((await post("/workflows/ping/run", tom, { input: {}, callback: { room: true, url: "https://x.test/cb" } })).status, 400);

    const room = await joinRoom(rooms(), { authorization: `Bearer ${tom}` });
    try {
      const quiet = await post("/workflows/chat/run", tom, { input: {} });
      assert.equal(quiet.status, 202, quiet.body.error);
      const { job, runId: jobRun } = await settled(quiet.body.runId!);
      await sleep(200);
      assert.deepEqual(room.got.filter((m) => m.runId === quiet.body.runId || m.runId === jobRun || m.job === job), []);
    } finally {
      room.ws.close();
    }
  });
});

describe("rooms behind a host that owns the server (mcp's shape)", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  /** What the host's credential proved, stashed on the Node request as
   *  mcp's labAuth does, and read back by the hooks off `env.incoming`. */
  const STASH = Symbol.for("test.host.grant");
  type Grant = { actor?: string; scope?: "peer" | "peer:person" };
  const grantOf = (c: { env?: unknown }) => ((c.env as { incoming?: Record<symbol, Grant | undefined> } | undefined)?.incoming)?.[STASH];

  it("the host authenticates and routes the upgrade under its mount; strut's own gate and hooks decide the room", async () => {
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_PEER_KEY"];
    const dir = await mkdtemp(join(tmpdir(), "strut-rooms-host-"));
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      ...NO_SEEDS,
      resolveActor: (c) => grantOf(c)?.actor,
      resolveScope: (c) => grantOf(c)?.scope,
    });
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on("upgrade", (req, socket, head) => {
      const who = req.headers["x-test-who"];
      (req as unknown as Record<symbol, Grant>)[STASH] = who === "a-strut" ? { actor: "tom-1", scope: "peer" } : { actor: String(who), scope: "peer:person" };
      if (!strut.upgrade(req, socket, head, { basePath: "/lab" })) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/lab/rooms`;
    try {
      await strut.workspace.publishWorkflowByContent("ping", ["name: ping", "peer: true", "steps:", "  - id: v", "    type: log", "    config: { message: hi }"].join("\n"));
      assert.equal(await refusedWith(url, { "x-test-who": "a-strut" }), 403);
      const room = await joinRoom(url, { "x-test-who": "tom-1" });
      try {
        // A launch through the host's bridge: the same hooks, the stash on env.incoming.
        const res = await strut.app.request(
          "/workflows/ping/run",
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {}, callback: { room: true } }) },
          { incoming: { [STASH]: { actor: "tom-1", scope: "peer:person" } } },
        );
        assert.equal(res.status, 202);
        const { runId } = (await res.json()) as { runId: string };
        const end = await room.until("ping's run.end", (m) => m.event === "run.end" && m.runId === runId);
        assert.equal(end["status"], "success");
      } finally {
        room.ws.close();
      }
    } finally {
      server.close();
      await strut.close();
      await rm(dir, { recursive: true, force: true });
      for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
