import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { MemorySecretStore, FileSecretStore } from "./secret-store.js";
import type { RunEvent, RunSummary } from "./core.js";
import {
  launchOnPeer,
  listPeerWorkflows,
  parsePeersEnv,
  peerIdProblem,
  peerStore,
  peersCapability,
  readPeerWorkflow,
  tailPeerRun,
  type PeerFetch,
  type PeerFetchInit,
} from "./peers.js";

// ── helpers: a fake peer over an SSE body ─────────────────────────────────

const enc = new TextEncoder();

const sseEvent = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const sseDone = (r: unknown) => `event: done\ndata: ${JSON.stringify(r)}\n\n`;

/** A streamed response of the given chunks. With `hang`, it never closes
 *  by itself and errors when the request's signal aborts — what a real
 *  fetch does to a read in flight. */
function sseResponse(chunks: string[], opts: { hang?: boolean; signal?: AbortSignal } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      if (!opts.hang) controller.close();
      else {
        opts.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          controller.error(e);
        });
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const noSleep = async () => {};

function capabilityOver(fetchImpl: PeerFetch) {
  const store = peerStore(new MemorySecretStore());
  const ready = store.set({ id: "cloud", baseUrl: "http://cloud.test", token: "tok-cloud" });
  const cap = peersCapability(store, fetchImpl);
  return { store, cap, ready };
}

// ── the record ────────────────────────────────────────────────────────────

describe("peer records", () => {
  it("stores, lists without the token, and deletes", async () => {
    const secrets = new MemorySecretStore();
    const store = peerStore(secrets);
    await store.set({ id: "acme-web", baseUrl: "https://acme.example:3355/lab/", token: "swarm-key", label: "Acme web" });
    await store.set({ id: "Beta_1", baseUrl: "http://beta.local", token: "k2" });

    const got = await store.get("acme-web");
    assert.deepEqual(got, { id: "acme-web", baseUrl: "https://acme.example:3355/lab", token: "swarm-key", label: "Acme web" });

    const listed = await store.list();
    assert.deepEqual(listed, [
      { id: "acme-web", baseUrl: "https://acme.example:3355/lab", label: "Acme web" },
      { id: "Beta_1", baseUrl: "http://beta.local" },
    ]);
    assert.ok(!JSON.stringify(listed).includes("swarm-key"));
    // Never in the secret store's own listing by a readable name either.
    assert.ok((await secrets.list()).every((s) => s.name.startsWith("P_")));

    assert.equal(await store.delete("acme-web"), true);
    assert.equal(await store.delete("acme-web"), false);
    assert.equal(await store.get("acme-web"), undefined);
    assert.equal(await store.get("../x"), undefined);
  });

  it("refuses a bad id, url or token", async () => {
    const store = peerStore(new MemorySecretStore());
    await assert.rejects(store.set({ id: "-lead", baseUrl: "http://x", token: "t" }), /peer id/);
    await assert.rejects(store.set({ id: "a/b", baseUrl: "http://x", token: "t" }), /peer id/);
    await assert.rejects(store.set({ id: "ok", baseUrl: "ftp://x", token: "t" }), /http\(s\)/);
    await assert.rejects(store.set({ id: "ok", baseUrl: "http://x", token: "" }), /token/);
    assert.equal(peerIdProblem("a".repeat(64)), null);
    assert.match(peerIdProblem("a".repeat(65)) ?? "", /at most 64/);
    assert.match(peerIdProblem("") ?? "", /empty/);
  });

  it("the file store keeps them encrypted beside secrets.json", async () => {
    const dir = join(tmpdir(), `strut-peers-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    try {
      const store = peerStore(new FileSecretStore(dir, "peers.json"));
      await store.set({ id: "cloud", baseUrl: "http://cloud", token: "sekrit-token" });
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(join(dir, "peers.json"), "utf-8");
      assert.ok(!raw.includes("sekrit-token"), "token is not on disk in the clear");
      assert.ok(!raw.includes("http://cloud"), "the record is encrypted whole");
      const again = peerStore(new FileSecretStore(dir, "peers.json"));
      assert.equal((await again.get("cloud"))?.token, "sekrit-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses STRUT_PEERS", () => {
    assert.deepEqual(parsePeersEnv(undefined), []);
    assert.deepEqual(parsePeersEnv("  "), []);
    assert.deepEqual(parsePeersEnv('[{"id":"a","baseUrl":"http://a/","token":"t","label":"A"}]'), [
      { id: "a", baseUrl: "http://a", token: "t", label: "A" },
    ]);
    assert.throws(() => parsePeersEnv("{"), /not JSON/);
    assert.throws(() => parsePeersEnv('{"id":"a"}'), /JSON array/);
    assert.throws(() => parsePeersEnv('[{"id":"a","baseUrl":"http://a"}]'), /STRUT_PEERS\[0\]: token/);
  });
});

// ── the capability ────────────────────────────────────────────────────────

describe("the peers capability", () => {
  it("names a peer and injects its token; an unknown id is peer_unknown", async () => {
    const calls: Array<{ url: string; init?: PeerFetchInit }> = [];
    const { cap, ready } = capabilityOver(async (url, init) => {
      calls.push({ url, init });
      return json({ ok: true });
    });
    await ready;
    const res = await cap.fetch("cloud", "/workflows", { headers: { accept: "application/json" } });
    assert.equal(res.status, 200);
    assert.equal(calls[0]!.url, "http://cloud.test/workflows");
    assert.deepEqual(calls[0]!.init?.headers, { accept: "application/json", authorization: "Bearer tok-cloud" });
    await assert.rejects(cap.fetch("nope", "/workflows"), /peer_unknown: no peer "nope"/);
    assert.deepEqual(await cap.list(), [{ id: "cloud", baseUrl: "http://cloud.test" }]);
  });
});

// ── the client ────────────────────────────────────────────────────────────

describe("launchOnPeer", () => {
  it("POSTs the launch body with the actor and returns the handle", async () => {
    let seen: { url: string; init?: PeerFetchInit } | undefined;
    const { cap, ready } = capabilityOver(async (url, init) => {
      seen = { url, init };
      return json({ runId: "r1" }, 202);
    });
    await ready;
    const h = await launchOnPeer(cap, { peer: "cloud", workflow: "echo", version: "v2", input: { a: 1 }, params: { p: 2 }, job: "j1", actor: "alice-1" });
    assert.deepEqual(h, { peer: "cloud", workflow: "echo", runId: "r1" });
    assert.equal(seen!.url, "http://cloud.test/workflows/echo/v2/run");
    assert.equal(seen!.init?.method, "POST");
    assert.equal(seen!.init?.headers?.["x-strut-actor"], "alice-1");
    assert.deepEqual(JSON.parse(seen!.init?.body ?? ""), { input: { a: 1 }, params: { p: 2 }, job: "j1" });
  });

  it("a refusal throws with the peer's message", async () => {
    const { cap, ready } = capabilityOver(async () => json({ error: "job_busy: job j1 is held by run 5" }, 409));
    await ready;
    await assert.rejects(launchOnPeer(cap, { peer: "cloud", workflow: "echo" }), /refused POST \/workflows\/echo\/run \(409\): job_busy: job j1 is held by run 5/);
  });
});

describe("tailPeerRun", () => {
  const events: RunEvent[] = ["run.start", "step.start", "step.end", "run.end"].map((type, i) => ({
    ts: `t${i}`,
    runId: "r1",
    path: "wf",
    type: type as RunEvent["type"],
  }));
  const result = { runId: "r1", status: "success" as const, output: 42 };
  const handle = { peer: "cloud", workflow: "wf", runId: "r1" };

  it("reattaches after a drop with ?skip=<events read>, delivering each event once", async () => {
    const skips: number[] = [];
    const { cap, ready } = capabilityOver(async (url) => {
      const skip = Number(new URL(url).searchParams.get("skip"));
      skips.push(skip);
      const rest = events.slice(skip);
      // The first attachment is cut after two events, no `done`.
      if (skips.length === 1) return sseResponse(rest.slice(0, 2).map(sseEvent));
      return sseResponse([...rest.map(sseEvent), sseDone(result)]);
    });
    await ready;
    const got: string[] = [];
    const res = await tailPeerRun(cap, handle, { onEvent: (e) => got.push(e.type), sleep: noSleep });
    assert.deepEqual(res, result);
    assert.deepEqual(skips, [0, 2]);
    assert.deepEqual(got, ["run.start", "step.start", "step.end", "run.end"]);
  });

  it("retries a connection fault and a 5xx, then gives up as peer_unreachable", async () => {
    let n = 0;
    const { cap, ready } = capabilityOver(async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNREFUSED");
      if (n === 2) return new Response("bad gateway", { status: 502 });
      return sseResponse([sseDone(result)]);
    });
    await ready;
    assert.deepEqual(await tailPeerRun(cap, handle, { sleep: noSleep }), result);
    assert.equal(n, 3);

    const { cap: dead, ready: ready2 } = capabilityOver(async () => {
      throw new Error("ECONNREFUSED");
    });
    await ready2;
    await assert.rejects(tailPeerRun(dead, handle, { sleep: noSleep, maxAttempts: 3 }), /peer_unreachable: .* after 3 attempts: ECONNREFUSED/);
  });

  it("a 4xx on the stream is a refusal, not a drop", async () => {
    const { cap, ready } = capabilityOver(async () => json({ error: "unauthorized" }, 401));
    await ready;
    await assert.rejects(tailPeerRun(cap, handle, { sleep: noSleep }), /refused GET \/workflows\/wf\/runs\/r1\/stream \(401\): unauthorized/);
  });

  it("an abort while the stream is open rejects with an AbortError", async () => {
    const ac = new AbortController();
    const { cap, ready } = capabilityOver(async (_url, init) => sseResponse([sseEvent(events[0])], { hang: true, signal: init?.signal }));
    await ready;
    const tail = tailPeerRun(cap, handle, { signal: ac.signal, sleep: noSleep });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(tail, (e: Error) => e.name === "AbortError");
  });
});

describe("the builder's peer reads", () => {
  it("list and read a peer's workflows in the builder's own shapes", async () => {
    const { cap, ready } = capabilityOver(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/workflows") {
        assert.equal(u.searchParams.get("q"), "clip");
        return json([
          { name: "clip-a", activeVersion: "v2", versions: ["v1", "v2"], description: "A", category: "media", lastRunAt: 1 },
          { name: "clip-b", activeVersion: "v1", versions: ["v1"] },
          { name: "clip-c", activeVersion: "v1", versions: ["v1"] },
        ]);
      }
      if (u.pathname === "/workflows/clip-a") return json({ active: "v2", versions: { v1: {}, v2: { description: "A" } }, publisher: "yaml" });
      if (u.pathname === "/workflows/clip-a/v2") return new Response("name: clip-a\nsteps: []\n", { headers: { "content-type": "text/yaml" } });
      if (u.pathname === "/workflows/clip-a/v9") return json({ error: "nope" }, 404);
      if (u.pathname === "/workflows/gone") return json({ error: "nope" }, 404);
      return json({ error: `unexpected ${u.pathname}` }, 500);
    });
    await ready;
    const list = await listPeerWorkflows(cap, "cloud", "clip", 2);
    assert.deepEqual(list, {
      peer: "cloud",
      workflows: [
        { name: "clip-a", activeVersion: "v2", description: "A", category: "media" },
        { name: "clip-b", activeVersion: "v1" },
      ],
      total: 3,
      hint: 'Showing 2 of 3 workflows on peer "cloud" — pass query (keywords) or raise limit.',
    });
    assert.deepEqual(await readPeerWorkflow(cap, "cloud", "clip-a"), {
      peer: "cloud",
      name: "clip-a",
      version: "v2",
      activeVersion: "v2",
      versions: ["v1", "v2"],
      description: "A",
      publisher: "yaml",
      yaml: "name: clip-a\nsteps: []\n",
    });
    assert.match((await readPeerWorkflow(cap, "cloud", "clip-a", "v9")).error ?? "", /Version "v9" not found .* Available: v1, v2/);
    assert.match((await readPeerWorkflow(cap, "cloud", "gone")).error ?? "", /not found on peer "cloud"/);
  });
});

// ── the routes ────────────────────────────────────────────────────────────

describe("/peers routes", () => {
  let dir: string;
  let savedEnv: string | undefined;
  beforeEach(async () => {
    dir = join(tmpdir(), `strut-peers-routes-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    savedEnv = process.env["STRUT_PEERS"];
    delete process.env["STRUT_PEERS"];
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env["STRUT_PEERS"];
    else process.env["STRUT_PEERS"] = savedEnv;
    await rm(dir, { recursive: true, force: true });
  });
  const boot = (peers?: Parameters<typeof createStrut>[0]["peers"]) =>
    createStrut({ workspace: new WorkspaceManager(dir), store: new MemoryRunStore(), serveUi: false, enableChat: false, scheduler: false, ...(peers ? { peers } : {}) });
  const put = (strut: Strut, id: string, body: unknown) =>
    strut.app.request(`/peers/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("PUT validates, GET lists without tokens, DELETE removes", async () => {
    const strut = await boot();
    assert.equal((await put(strut, "acme-web", { baseUrl: "http://acme/", token: "k1", label: "Acme" })).status, 200);
    assert.equal((await put(strut, "-bad", { baseUrl: "http://x", token: "k" })).status, 400);
    assert.equal((await put(strut, "ok", { baseUrl: "nota url", token: "k" })).status, 400);
    assert.equal((await put(strut, "ok", { baseUrl: "http://x" })).status, 400);
    assert.match(((await (await put(strut, "ok", { baseUrl: "http://x" })).json()) as { error: string }).error, /token/);

    const list = await strut.app.request("/peers");
    assert.equal(list.status, 200);
    const text = await list.text();
    assert.deepEqual(JSON.parse(text), { peers: [{ id: "acme-web", baseUrl: "http://acme", label: "Acme" }] });
    assert.ok(!text.includes("k1"));

    assert.equal((await strut.app.request("/peers/acme-web", { method: "DELETE" })).status, 200);
    assert.equal((await strut.app.request("/peers/acme-web", { method: "DELETE" })).status, 404);
    assert.equal((await strut.app.request("/peers/-bad", { method: "DELETE" })).status, 400);
    assert.deepEqual(await (await strut.app.request("/peers")).json(), { peers: [] });
  });

  it("seeds from the option and from STRUT_PEERS; a bad env fails the boot", async () => {
    process.env["STRUT_PEERS"] = JSON.stringify([{ id: "env-peer", baseUrl: "http://env", token: "e" }]);
    const strut = await boot([{ id: "opt-peer", baseUrl: "http://opt", token: "o", label: "Opt" }]);
    assert.deepEqual(await (await strut.app.request("/peers")).json(), {
      peers: [
        { id: "env-peer", baseUrl: "http://env" },
        { id: "opt-peer", baseUrl: "http://opt", label: "Opt" },
      ],
    });
    process.env["STRUT_PEERS"] = "[{}]";
    await assert.rejects(boot(), /STRUT_PEERS\[0\]: peer id is empty/);
  });
});

// ── two struts: the step over real HTTP ───────────────────────────────────

describe("strut/run-workflow across two struts", () => {
  const KEY = "peer-test-key";
  let dirs: string[];
  let peer: Strut;
  let caller: Strut;
  let savedKey: string | undefined;
  const auth = { authorization: `Bearer ${KEY}` };

  beforeEach(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    dirs = [0, 1].map(() => join(tmpdir(), `strut-peer-e2e-${randomUUID()}`));
    await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));

    peer = await createStrut({ workspace: new WorkspaceManager(dirs[0]!), store: new MemoryRunStore(), serveUi: false, enableChat: false, scheduler: false });
    await peer.workspace.publishWorkflow("echo", "v1", {
      steps: [{ id: "g", type: "log", config: { message: "hi {{ input.name }}" } }],
    });
    await peer.workspace.publishWorkflow("slow", "v1", {
      steps: [{ id: "many", type: "foreach", config: { items: 200, body: { id: "w", type: "wait", config: { durationMs: 50 } } } }],
    });
    const port = await peer.listen(0, "127.0.0.1");

    caller = await createStrut({
      workspace: new WorkspaceManager(dirs[1]!),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      peers: [{ id: "cloud", baseUrl: `http://127.0.0.1:${port}`, token: KEY, label: "Cloud" }],
    });
    const far = (config: Record<string, unknown>) => ({ steps: [{ id: "far", type: "strut/run-workflow", config: { peer: "cloud", workflow: "echo", ...config } }] });
    await caller.workspace.publishWorkflow("call", "v1", far({ input: { name: "{{ input.name }}" } }));
    await caller.workspace.publishWorkflow("callslow", "v1", far({ workflow: "slow" }));
    await caller.workspace.publishWorkflow("nowait", "v1", far({ input: { name: "later" }, wait: false }));
    await caller.workspace.publishWorkflow("withjob", "v1", far({ input: { name: "j" }, job: "job-on-peer" }));
    await caller.workspace.publishWorkflow("nopeer", "v1", far({ peer: "nope" }));
    await caller.workspace.publishWorkflow("missing", "v1", far({ workflow: "nope" }));
  });

  afterEach(async () => {
    await caller?.close();
    await peer?.close();
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  const launch = async (wf: string, body: Record<string, unknown>, actor?: string): Promise<string> => {
    const res = await caller.app.request(`/workflows/${wf}/run`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", ...(actor ? { "x-strut-actor": actor } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, 202, text);
    return (JSON.parse(text) as { runId: string }).runId;
  };
  const settled = async (strut: Strut, wf: string, runId: string, ms = 15_000): Promise<RunSummary> => {
    const until = Date.now() + ms;
    for (;;) {
      const s = await strut.store.getRunSummary(wf, runId);
      if (s) return s;
      if (Date.now() > until) throw new Error(`run ${wf}/${runId} did not settle in ${ms}ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  type Far = { peer: string; workflow: string; runId: string; status: string; output?: unknown; error?: { message: string }; durationMs?: number };

  it("runs the workflow on the peer as the caller's principal and returns its result", async () => {
    const runId = await launch("call", { input: { name: "x" } }, "alice-1");
    const summary = await settled(caller, "call", runId);
    assert.equal(summary.status, "success", JSON.stringify(summary.error));
    const far = summary.output as Far;
    assert.equal(far.peer, "cloud");
    assert.equal(far.workflow, "echo");
    assert.equal(far.status, "success");
    assert.equal(far.output, "hi x");
    assert.ok(typeof far.durationMs === "number");

    const theirs = await settled(peer, "echo", far.runId);
    assert.equal(theirs.status, "success");
    assert.deepEqual(theirs.input, { name: "x" });
    assert.equal(theirs.actor, "alice-1", "the caller's principal is the peer run's actor");
    assert.equal(theirs.principal, "alice-1");
    assert.equal(theirs.job, undefined);
  });

  it("`job` reaches the peer only when the step names one — never the caller's own", async () => {
    const runId = await launch("call", { input: { name: "x" }, job: "callers-job" });
    const far = (await settled(caller, "call", runId)).output as Far;
    assert.equal((await settled(peer, "echo", far.runId)).job, undefined, "the caller's job is not forwarded");

    const runId2 = await launch("withjob", { input: {}, job: "callers-job" });
    const far2 = (await settled(caller, "withjob", runId2)).output as Far;
    assert.equal(far2.status, "success");
    assert.equal((await settled(peer, "echo", far2.runId)).job, "job-on-peer");
  });

  it("wait: false returns the handle at once and the peer's run goes on", async () => {
    const runId = await launch("nowait", { input: {} });
    const far = (await settled(caller, "nowait", runId)).output as Far;
    assert.equal(far.status, "running");
    assert.equal(far.peer, "cloud");
    assert.ok(far.runId);
    const theirs = await settled(peer, "echo", far.runId);
    assert.equal(theirs.status, "success");
    assert.equal(theirs.output, "hi later");
  });

  it("cancelling the caller's run cancels the peer's", async () => {
    const runId = await launch("callslow", { input: {} });
    // Wait until the peer is executing it.
    let peerRun: { workflow: string; runId: string } | undefined;
    for (let i = 0; i < 200 && !peerRun; i++) {
      const active = (await (await peer.app.request("/runs/active", { headers: auth })).json()) as Array<{ workflow: string; runId: string }>;
      peerRun = active.find((r) => r.workflow === "slow");
      if (!peerRun) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(peerRun, "the peer is running `slow`");
    const cancel = await caller.app.request(`/workflows/callslow/runs/${runId}/cancel`, { method: "POST", headers: auth });
    assert.equal(cancel.status, 202, await cancel.text());

    assert.equal((await settled(caller, "callslow", runId)).status, "cancelled");
    assert.equal((await settled(peer, "slow", peerRun!.runId)).status, "cancelled");
  });

  it("an unknown peer, or a refusal from the peer, fails the step with the message", async () => {
    const a = await settled(caller, "nopeer", await launch("nopeer", { input: {} }));
    assert.equal(a.status, "error");
    assert.match(a.error?.message ?? "", /peer_unknown: no peer "nope"/);

    const b = await settled(caller, "missing", await launch("missing", { input: {} }));
    assert.equal(b.status, "error");
    assert.match(b.error?.message ?? "", /peer "cloud" refused POST \/workflows\/nope\/run \(404\): .*not found/);
  });
});
