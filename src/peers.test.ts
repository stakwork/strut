import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { MemorySecretStore, FileSecretStore } from "./secret-store.js";
import { defineStep, withAccessedNodes, type RunEvent, type RunSummary } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { z } from "zod";
import listPeers from "./steps/lib/strut/list-peers.js";
import runWorkflowStep from "./steps/lib/strut/run-workflow.js";
import {
  checkPeer,
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
    await assert.rejects(cap.fetch("nope", "/workflows"), /peer_unknown: no peer "nope" — the peers on file: cloud/);
    assert.deepEqual(await cap.list(), [{ id: "cloud", baseUrl: "http://cloud.test" }]);
  });

  it("strut/list-peers shows what each peer holds, never a token or URL", async () => {
    const { store, cap, ready } = capabilityOver(async () => json({}));
    await ready;
    await store.set({ id: "apps", baseUrl: "http://apps", token: "t", label: "Apps", repos: ["https://github.com/a/b"] });
    const out = await listPeers.run({}, { services: { peers: cap } } as never);
    assert.deepEqual(out, {
      peers: [
        { id: "apps", label: "Apps", repos: ["https://github.com/a/b"] },
        { id: "cloud" },
      ],
    });
    await assert.rejects(listPeers.run({}, { services: {} } as never), /needs the peers capability/);
  });

  it("strut/list-peers includes self when set and omits it when not", async () => {
    const { store, cap, ready } = capabilityOver(async () => json({}));
    await ready;
    assert.ok(!("self" in ((await listPeers.run({}, { services: { peers: cap } } as never)) as object)));
    await store.setSelf({ id: "me", repos: ["https://github.com/a/mine"] });
    const out = await listPeers.run({}, { services: { peers: cap } } as never);
    assert.deepEqual(out, { self: { id: "me", repos: ["https://github.com/a/mine"] }, peers: [{ id: "cloud" }] });
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

  it("an input or params a model handed as a JSON string is sent as the object", async () => {
    let body: unknown;
    const { cap, ready } = capabilityOver(async (_url, init) => {
      body = JSON.parse(init?.body ?? "");
      return json({ runId: "r1" }, 202);
    });
    await ready;
    await launchOnPeer(cap, { peer: "cloud", workflow: "explore", input: '{"prompt":"how?","repos":["a"]}', params: ' {"p":2}' });
    assert.deepEqual(body, { input: { prompt: "how?", repos: ["a"] }, params: { p: 2 } });
  });

  it("room: true asks the peer for the person's room there, for the run's callbacks and its jobs' (plans/chained-orchestrators.md §3)", async () => {
    let body: unknown;
    const { cap, ready } = capabilityOver(async (_url, init) => {
      body = JSON.parse(init?.body ?? "");
      return json({ runId: "r1" }, 202);
    });
    await ready;
    await launchOnPeer(cap, { peer: "cloud", workflow: "orchestrator", input: { prompt: "hi", session: "tom-1/cloud" }, room: true });
    assert.deepEqual(body, { input: { prompt: "hi", session: "tom-1/cloud" }, callback: { room: true }, jobCallback: { room: true } });
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

  it("a `done` that says stale is retried, then peer_run_stale; a summary-less done reattaches", async () => {
    // The peer's run died with its process and nobody resumed it: its tail
    // closes with `done { status: "stale" }` instead of hanging (TailOpts.live).
    let n = 0;
    const { cap, ready } = capabilityOver(async () => {
      n += 1;
      return sseResponse([sseDone({ runId: "r1", status: "stale" })]);
    });
    await ready;
    await assert.rejects(tailPeerRun(cap, handle, { sleep: noSleep, maxAttempts: 3 }), /peer_run_stale: run r1 on peer "cloud" has no live process there and was not resumed \(3 checks\)/);
    assert.equal(n, 3);

    // A peer mid-boot resumes its runs after it starts serving: stale, then live.
    let m = 0;
    const { cap: boot, ready: ready2 } = capabilityOver(async () => {
      m += 1;
      if (m < 3) return sseResponse([sseDone({ runId: "r1", status: "stale" })]);
      return sseResponse([...events.map(sseEvent), sseDone(result)]);
    });
    await ready2;
    assert.deepEqual(await tailPeerRun(boot, handle, { sleep: noSleep }), result);

    // The terminal event read before its summary was written: `done` names
    // the live state — reattach, and the next `done` has the result.
    let k = 0;
    const { cap: racy, ready: ready3 } = capabilityOver(async () => {
      k += 1;
      if (k === 1) return sseResponse([...events.map(sseEvent), sseDone({ runId: "r1", status: "running" })]);
      return sseResponse([sseDone(result)]);
    });
    await ready3;
    const got: string[] = [];
    assert.deepEqual(await tailPeerRun(racy, handle, { sleep: noSleep, onEvent: (e) => got.push(e.type) }), result);
    assert.equal(got.length, 4, "each event once across the reattach");
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
  let savedSelf: string | undefined;
  beforeEach(async () => {
    dir = join(tmpdir(), `strut-peers-routes-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    savedEnv = process.env["STRUT_PEERS"];
    delete process.env["STRUT_PEERS"];
    savedSelf = process.env["STRUT_SELF"];
    delete process.env["STRUT_SELF"];
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env["STRUT_PEERS"];
    else process.env["STRUT_PEERS"] = savedEnv;
    if (savedSelf === undefined) delete process.env["STRUT_SELF"];
    else process.env["STRUT_SELF"] = savedSelf;
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

  it("keeps what the host says a peer holds: description and repos", async () => {
    const strut = await boot();
    const res = await put(strut, "sphinx-apps", {
      baseUrl: "http://apps",
      token: "k",
      label: "Sphinx Apps",
      description: "The Sphinx mobile and desktop apps",
      repos: ["https://github.com/stakwork/sphinx-kotlin"],
    });
    assert.deepEqual(await res.json(), {
      ok: true,
      id: "sphinx-apps",
      baseUrl: "http://apps",
      label: "Sphinx Apps",
      description: "The Sphinx mobile and desktop apps",
      repos: ["https://github.com/stakwork/sphinx-kotlin"],
    });
    assert.equal((await put(strut, "x", { baseUrl: "http://x", token: "k", repos: "nope" })).status, 400);
    assert.equal((await put(strut, "x", { baseUrl: "http://x", token: "k", description: 3 })).status, 400);
    const { peers } = (await (await strut.app.request("/peers")).json()) as { peers: unknown[] };
    assert.deepEqual(peers, [
      {
        id: "sphinx-apps",
        baseUrl: "http://apps",
        label: "Sphinx Apps",
        description: "The Sphinx mobile and desktop apps",
        repos: ["https://github.com/stakwork/sphinx-kotlin"],
      },
    ]);
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

describe("/self routes", () => {
  let dir: string;
  let savedSelf: string | undefined;
  beforeEach(async () => {
    dir = join(tmpdir(), `strut-self-routes-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    savedSelf = process.env["STRUT_SELF"];
    delete process.env["STRUT_SELF"];
  });
  afterEach(async () => {
    if (savedSelf === undefined) delete process.env["STRUT_SELF"];
    else process.env["STRUT_SELF"] = savedSelf;
    await rm(dir, { recursive: true, force: true });
  });
  const boot = (self?: Parameters<typeof createStrut>[0]["self"]) =>
    createStrut({ workspace: new WorkspaceManager(dir), store: new MemoryRunStore(), serveUi: false, enableChat: false, scheduler: false, ...(self ? { self } : {}) });
  const put = (strut: Strut, body: unknown) =>
    strut.app.request("/self", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("PUT/GET/DELETE round trip; 400 on bad input; never in /peers", async () => {
    const strut = await boot();
    assert.deepEqual(await (await strut.app.request("/self")).json(), { self: null });
    assert.equal((await strut.app.request("/self", { method: "DELETE" })).status, 404);
    const body = { id: "me", label: "Me", description: "My code", repos: ["https://github.com/a/b"] };
    assert.deepEqual(await (await put(strut, body)).json(), { ok: true, ...body });
    assert.equal((await put(strut, { repos: "nope" })).status, 400);
    assert.equal((await put(strut, { description: 3 })).status, 400);
    assert.equal((await put(strut, { id: "-bad" })).status, 400);
    assert.deepEqual(await (await strut.app.request("/self")).json(), { self: body });
    assert.deepEqual(await (await strut.app.request("/peers")).json(), { peers: [] });
    assert.equal((await strut.app.request("/self", { method: "DELETE" })).status, 200);
    assert.deepEqual(await (await strut.app.request("/self")).json(), { self: null });
  });

  it("seeds from STRUT_SELF and the option (option wins); a bad env fails the boot", async () => {
    process.env["STRUT_SELF"] = JSON.stringify({ label: "Env", repos: ["https://github.com/e/e"] });
    let strut = await boot();
    assert.deepEqual(await (await strut.app.request("/self")).json(), { self: { label: "Env", repos: ["https://github.com/e/e"] } });
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    strut = await boot({ label: "Opt" });
    assert.deepEqual(await (await strut.app.request("/self")).json(), { self: { label: "Opt" } });
    process.env["STRUT_SELF"] = "{nope";
    await assert.rejects(boot(), /STRUT_SELF is not JSON/);
    process.env["STRUT_SELF"] = JSON.stringify({ repos: [1] });
    await assert.rejects(boot(), /STRUT_SELF repos must be an array of strings/);
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

  // What the peer's stand-in `builder` lists as made (plans/builder-job.md
  // §3): files in ITS job's directory, a link, and one deliverable it got
  // from a third strut, tagged already.
  const PEER_ARTIFACTS = [
    { id: "plan", title: "Plan", path: "plan.md" },
    { id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/acme/web/pull/7" },
    { id: "far", title: "Far", path: "x.md", peer: "third", job: "j3" },
    "not an entry",
  ];
  /** The same list as the caller's step returns it: tagged with the peer
   *  and the job its files are under THERE — the third strut's entry
   *  re-tagged as the next hop, `via` the third, its job kept
   *  (plans/chained-orchestrators.md §5). */
  const tagged = (job: string) => [
    { id: "plan", title: "Plan", path: "plan.md", peer: "cloud", job },
    { id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/acme/web/pull/7", peer: "cloud", job },
    { id: "far", title: "Far", path: "x.md", peer: "cloud", via: "third", job: "j3" },
    "not an entry",
  ];

  beforeEach(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    dirs = [0, 1].map(() => join(tmpdir(), `strut-peer-e2e-${randomUUID()}`));
    await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));

    // A step on the peer that touches its graph (the provenance marker),
    // one ref of which the peer itself got from a third strut.
    const touch = defineStep({
      type: "test/touch",
      description: "reports nodes",
      input: z.object({}),
      output: z.any(),
      async run() {
        return withAccessedNodes({ ok: true }, [
          { ref_id: "n1", node_type: "Concept", name: "Billing" },
          { ref_id: "n2", node_type: "Feature", peer: "third" },
        ]);
      },
    });
    peer = await createStrut({
      workspace: new WorkspaceManager(dirs[0]!),
      store: new MemoryRunStore(),
      registry: await createRegistry([touch]),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      orchestrator: false,
      builder: false,
    });
    // Open to peers (`peer: true`): what the peer key may launch. `touch` is not.
    await peer.workspace.publishWorkflow("echo", "v1", {
      steps: [{ id: "g", type: "log", config: { message: "hi {{ input.name }}" } }],
      peer: true,
    });
    await peer.workspace.publishWorkflow("touch", "v1", {
      steps: [{ id: "t", type: "test/touch" }, { id: "again", type: "test/touch" }],
    });
    await peer.workspace.publishWorkflow("builder", "v1", {
      steps: [{ id: "result", type: "pack", config: { text: "Built hello there.", artifacts: PEER_ARTIFACTS } }],
      peer: true,
    });
    await peer.workspace.publishWorkflow("slow", "v1", {
      steps: [{ id: "many", type: "foreach", config: { items: 200, body: { id: "w", type: "wait", config: { durationMs: 50 } } } }],
      peer: true,
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
    await caller.workspace.publishWorkflow("calltouch", "v1", far({ workflow: "touch" }));
    await caller.workspace.publishWorkflow("callarts", "v1", far({ workflow: "builder", input: { prompt: "p" }, job: "job-on-peer" }));
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

  it("the peer's STRUT_PEER_KEY is enough: launch as the principal, follow, cancel its own run", async () => {
    const saved = process.env["STRUT_PEER_KEY"];
    process.env["STRUT_PEER_KEY"] = "peer-scoped-key";
    try {
      const { peers } = (await (await caller.app.request("/peers", { headers: auth })).json()) as { peers: Array<{ baseUrl: string }> };
      const put = await caller.app.request("/peers/cloud", {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: peers[0]!.baseUrl, token: "peer-scoped-key" }),
      });
      assert.equal(put.status, 200);

      const far = (await settled(caller, "call", await launch("call", { input: { name: "p" } }, "alice-1"))).output as Far;
      assert.equal(far.output, "hi p");
      const start = (await peer.store.getRunEvents("echo", far.runId)).find((e) => e.type === "run.start")!;
      assert.equal(start.origin, "peer");
      assert.equal(start.actor, "alice-1", "the forwarded principal is honored with the peer key");

      // On the peer key the peer keeps the job as `peer/<job>`, and the
      // deliverables are tagged with the job as the PEER holds it.
      const arts = (await settled(caller, "callarts", await launch("callarts", { input: {} }))).output as Far;
      assert.equal((await settled(peer, "builder", arts.runId)).job, "peer/job-on-peer");
      assert.deepEqual((arts.output as { artifacts: unknown }).artifacts, tagged("peer/job-on-peer"));

      // A workflow that does not say `peer: true` is refused, and the step
      // fails with the peer's word for it.
      const refused = await settled(caller, "calltouch", await launch("calltouch", { input: {} }));
      assert.equal(refused.status, "error");
      assert.match(refused.error?.message ?? "", /not open to peers/);

      const runId = await launch("callslow", { input: {} });
      let peerRun: { workflow: string; runId: string } | undefined;
      for (let i = 0; i < 200 && !peerRun; i++) {
        const active = (await (await peer.app.request("/runs/active", { headers: auth })).json()) as Array<{ workflow: string; runId: string }>;
        peerRun = active.find((r) => r.workflow === "slow");
        if (!peerRun) await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(peerRun, "the peer is running `slow`");
      assert.equal((await caller.app.request(`/workflows/callslow/runs/${runId}/cancel`, { method: "POST", headers: auth })).status, 202);
      assert.equal((await settled(caller, "callslow", runId)).status, "cancelled");
      assert.equal((await settled(peer, "slow", peerRun!.runId)).status, "cancelled", "the peer key cancels the run it launched");
    } finally {
      if (saved === undefined) delete process.env["STRUT_PEER_KEY"];
      else process.env["STRUT_PEER_KEY"] = saved;
    }
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

  it("the peer run's nodes land on the step's step.end tagged with the peer, and the launch is journaled", async () => {
    const runId = await launch("calltouch", { input: {} });
    const summary = await settled(caller, "calltouch", runId);
    assert.equal(summary.status, "success", JSON.stringify(summary.error));
    const far = summary.output as Far;
    const events = await caller.store.getRunEvents("calltouch", runId);

    // Deduplicated across the peer's two steps; a ref the peer itself got
    // from a third strut keeps that tag.
    const end = events.find((e) => e.type === "step.end" && e.path === "calltouch/far")!;
    assert.deepEqual(end.nodes, [
      { ref_id: "n1", node_type: "Concept", name: "Billing", peer: "cloud" },
      { ref_id: "n2", node_type: "Feature", peer: "third" },
    ]);
    assert.ok(!("nodes" in (end.output as object)), "the marker is not in the output");

    // The handle, journaled before the wait: no stepType, so no step counted.
    const launched = events.find((e) => e.type === "step.end" && e.path === "calltouch/far#launch")!;
    assert.ok(launched, "a step.end at <path>#launch");
    assert.equal(launched.stepType, undefined);
    const record = launched.output as { peer: string; workflow: string; runId: string; launchedAt: number };
    assert.deepEqual([record.peer, record.workflow, record.runId], ["cloud", "touch", far.runId]);
    assert.ok(typeof record.launchedAt === "number");
    assert.ok(Date.parse(launched.ts) <= Date.parse(end.ts));
    assert.equal(summary.stepCounts?.["strut/run-workflow"]?.success, 1);
  });

  it("a resumed caller reattaches to the peer's run instead of launching it again", async () => {
    // A finished run on the peer, and a caller log cut off while waiting on
    // it — what a crash of the caller leaves behind — resumed through the
    // same path boot-time auto-resume takes.
    const first = await launch("call", { input: { name: "x" } });
    const theirs = (await settled(caller, "call", first)).output as Far;
    assert.equal((await peer.store.listRuns("echo")).length, 1);

    const stale = "1700000000000";
    const workflowHash = await caller.workspace.getWorkflowHash("call");
    const at = (i: number) => new Date(Date.now() - 10_000 + i).toISOString();
    const ev = (i: number, e: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent => ({ ts: at(i), runId: stale, path: "call", ...e });
    await caller.store.append("call", stale, ev(0, { type: "run.start", input: { name: "x" }, ...(workflowHash ? { workflowHash } : {}) }));
    await caller.store.append("call", stale, ev(1, { type: "step.start", path: "call/far", stepType: "strut/run-workflow", input: { peer: "cloud", workflow: "echo" } }));
    await caller.store.append("call", stale, ev(2, {
      type: "step.end",
      path: "call/far#launch",
      output: { peer: "cloud", workflow: "echo", runId: theirs.runId, launchedAt: Date.now() - 5000 },
    }));

    const res = await caller.app.request(`/workflows/call/runs/${stale}/resume`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 202, await res.text());
    const summary = await settled(caller, "call", stale);
    assert.equal(summary.status, "success", JSON.stringify(summary.error));
    const far = summary.output as Far;
    assert.equal(far.runId, theirs.runId, "the SAME run on the peer");
    assert.equal(far.output, "hi x");
    assert.ok((far.durationMs ?? 0) >= 5000, "timed from the original launch");
    assert.equal((await peer.store.listRuns("echo")).length, 1, "nothing was launched again");
  });

  it("the peer output's artifacts come back tagged with the peer and the job they live under there — on a launch and on a reattach", async () => {
    const runId = await launch("callarts", { input: {} });
    const summary = await settled(caller, "callarts", runId);
    assert.equal(summary.status, "success", JSON.stringify(summary.error));
    const far = summary.output as Far;
    assert.equal((far.output as { text: string }).text, "Built hello there.");
    assert.deepEqual((far.output as { artifacts: unknown }).artifacts, tagged("job-on-peer"));
    const theirs = await settled(peer, "builder", far.runId);
    assert.deepEqual((theirs.output as { artifacts: unknown }).artifacts, PEER_ARTIFACTS, "the peer's own record is untouched");

    // A caller cut off while waiting, resumed: the same run on the peer,
    // tagged the same way.
    const stale = "1700000000001";
    const workflowHash = await caller.workspace.getWorkflowHash("callarts");
    const at = (i: number) => new Date(Date.now() - 10_000 + i).toISOString();
    const ev = (i: number, e: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent => ({ ts: at(i), runId: stale, path: "callarts", ...e });
    await caller.store.append("callarts", stale, ev(0, { type: "run.start", input: {}, ...(workflowHash ? { workflowHash } : {}) }));
    await caller.store.append("callarts", stale, ev(1, { type: "step.start", path: "callarts/far", stepType: "strut/run-workflow", input: { peer: "cloud", workflow: "builder" } }));
    await caller.store.append("callarts", stale, ev(2, {
      type: "step.end",
      path: "callarts/far#launch",
      output: { peer: "cloud", workflow: "builder", runId: far.runId, launchedAt: Date.now() - 5000 },
    }));
    const res = await caller.app.request(`/workflows/callarts/runs/${stale}/resume`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 202, await res.text());
    const again = (await settled(caller, "callarts", stale)).output as Far;
    assert.equal(again.runId, far.runId, "reattached, not relaunched");
    assert.deepEqual((again.output as { artifacts: unknown }).artifacts, tagged("job-on-peer"));
  });

  it("a local `builder` run that took the `remote` branch: run.end, GET …/artifacts and the job's fold carry the peer's deliverables tagged, never resolved here", async () => {
    const ends: Array<Record<string, any>> = [];
    const host = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        ends.push(JSON.parse(raw));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(host.address() as AddressInfo).port}/run-end`;
      const runId = await launch("builder", { job: "build-1", input: { prompt: "Build hello on cloud", peer: "cloud" }, callback: { url } }, "alice-1");
      const summary = await settled(caller, "builder", runId);
      assert.equal(summary.status, "success", JSON.stringify(summary.error));
      let end: Record<string, any> | undefined;
      for (let i = 0; i < 400 && !(end = ends.find((e) => e.runId === runId)); i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(end, "run.end reached the host");

      // The work ran there, under the same job id (the full key: no `peer/`).
      assert.equal(end.output.peer, "cloud");
      assert.equal(end.output.text, "Built hello there.");
      const remote = (await caller.store.getRunEvents("builder", runId)).find((e) => e.type === "step.end" && e.path === "builder/remote")!;
      assert.equal((await settled(peer, "builder", (remote.output as Far).runId)).job, "build-1");

      // Left as they came: the peer's paths, no url made here, no error.
      const expected = [
        { id: "plan", kind: "markdown", title: "Plan", path: "plan.md", peer: "cloud", job: "build-1" },
        { id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/acme/web/pull/7", peer: "cloud", job: "build-1" },
        { id: "far", kind: "markdown", title: "Far", path: "x.md", peer: "cloud", via: "third", job: "j3" },
      ];
      assert.deepEqual(end.artifacts, expected);
      const listed = (await (await caller.app.request(`/workflows/builder/runs/${runId}/artifacts`, { headers: auth })).json()) as { artifacts: unknown };
      assert.deepEqual(listed.artifacts, expected);

      // The job here folds them as its current deliverables, tagged.
      const view = (await (await caller.app.request("/jobs/build-1", { headers: auth })).json()) as { artifacts: unknown[]; threads: unknown[] };
      assert.deepEqual(view.artifacts, expected.map((a) => ({ ...a, runId })));
      assert.ok(!JSON.stringify(view.threads).includes("not found"), "nor does the thread fold");
    } finally {
      host.close();
    }
  });

  it("a host that gates strut/run-workflow: no route reaches the peer but an approved proposal (a workflow step, meta/run-workflow or job/start of a builder with peer)", async () => {
    const dir = join(tmpdir(), `strut-peer-gated-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const { peers } = (await (await caller.app.request("/peers", { headers: auth })).json()) as { peers: Array<{ baseUrl: string }> };
    const gated = await createStrut({
      workspace: new WorkspaceManager(dir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      peers: [{ id: "cloud", baseUrl: peers[0]!.baseUrl, token: KEY, label: "Cloud" }],
      // Peel's delta: the agent's peer tool asks first.
      orchestrator: { approve: ["strut/run-workflow"] },
      job: { approve: ["strut/run-workflow"] },
    });
    try {
      const echoRuns = async () => (await peer.store.listRuns("echo")).length + (await peer.store.listRuns("builder")).length;
      const before = await echoRuns();
      const refusal = /strut\/run-workflow needs the person's approval on this strut/;
      const go = async (wf: string, body: Record<string, unknown>) => {
        const res = await gated.app.request(`/workflows/${wf}/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(res.status, 202, await res.clone().text());
        return settled(gated, wf, ((await res.json()) as { runId: string }).runId);
      };

      // A workflow step.
      await gated.workspace.publishWorkflow("call", "v1", { steps: [{ id: "far", type: "strut/run-workflow", config: { peer: "cloud", workflow: "echo", input: { name: "x" } } }] });
      const step = await go("call", { input: {} });
      assert.equal(step.status, "error");
      assert.match(step.error?.message ?? "", refusal);

      // The builder's `remote` branch, launched with input.peer — what job/start { peer } and meta/run-workflow do.
      const build = await go("builder", { job: "b-1", input: { prompt: "Build hello on cloud", peer: "cloud" } });
      assert.equal(build.status, "error");
      assert.match(build.error?.message ?? "", refusal);
      const authoring = (gated.services as { authoring: { runWorkflow(n: string, i: unknown): Promise<{ status?: string; error?: { message: string } }> } }).authoring;
      const nested = await authoring.runWorkflow("builder", { prompt: "Build hello on cloud", peer: "cloud" });
      assert.equal(nested.status, "error");
      assert.match(nested.error?.message ?? "", refusal);
      // job/start { workflow: builder, peer } launches that same builder run.
      const reg = gated.getRegistry();
      const started = (await reg["job/start"]!.run(
        { workflow: "builder", title: "Build", prompt: "Build hello on cloud", peer: "cloud" },
        { runId: "r-orch", path: "orchestrator/turn/001-job_start", scope: {}, input: {}, emit: async () => {}, services: gated.services, registry: reg, agentTool: true } as never,
      )) as { runId: string };
      const viaJob = await settled(gated, "builder", started.runId);
      assert.equal(viaJob.status, "error");
      assert.match(viaJob.error?.message ?? "", refusal);
      assert.equal(await echoRuns(), before, "nothing reached the peer");

      // The agent's tool call as a proposal: accepted, it runs once.
      const proposals = (gated.services as { proposals: { propose(p: unknown): Promise<{ id: string }> } }).proposals;
      const p = await proposals.propose({
        step: "strut/run-workflow",
        input: { peer: "cloud", workflow: "echo", input: { name: "approved" } },
        title: "Run a workflow on another strut.",
        by: { workflow: "orchestrator", runId: "r-orch", path: "orchestrator/turn/002-strut_run_workflow" },
      });
      const decided = (await (await gated.app.request(`/proposals/${p.id}/decide`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) })).json()) as { status: string; result?: { output?: Far; error?: string } };
      assert.equal(decided.status, "applied", JSON.stringify(decided.result));
      assert.equal(decided.result?.output?.output, "hi approved");
    } finally {
      await gated.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the tail of a run that died on the peer ends with done { status: stale }", async () => {
    await peer.store.append("echo", "8888", { ts: new Date().toISOString(), runId: "8888", path: "echo", type: "run.start", input: {} });
    const res = await peer.app.request("/workflows/echo/runs/8888/stream", { headers: auth });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"type":"run.start"/);
    assert.match(text, /event: done\ndata: \{"runId":"8888","status":"stale"\}/);
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

// ── three struts: a spoke's deliverable from the laptop, through central ──

describe("a deliverable two hops away (plans/chained-orchestrators.md §5)", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  let dirs: string[];
  let spoke: Strut;
  let central: Strut;
  let laptop: Strut;
  const urlOf = (port: number) => `http://127.0.0.1:${port}`;
  const NO_SEEDS = { serveUi: false, enableChat: false, scheduler: false, job: false, orchestrator: false, builder: false } as const;

  before(async () => {
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_PEER_KEY"];
    dirs = [0, 1, 2].map(() => join(tmpdir(), `strut-two-hops-${randomUUID()}`));
    await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));
    // The spoke: a build that writes a report into its job's directory and
    // hands it over by path.
    const report = defineStep({
      type: "test/report",
      description: "writes a report and lists it",
      input: z.object({ dir: z.string() }),
      output: z.any(),
      async run(cfg) {
        await writeFile(join(cfg.dir, "report.md"), "# Report\n");
        return { text: "Built.", artifacts: [{ id: "report", title: "Report", path: "report.md" }] };
      },
    });
    spoke = await createStrut({ workspace: new WorkspaceManager(dirs[0]!), store: new MemoryRunStore(), registry: await createRegistry([report]), ...NO_SEEDS });
    await spoke.workspace.publishWorkflow("build", "v1", {
      steps: [{ id: "dir", type: "job/dir" }, { id: "w", type: "test/report", config: { dir: "{{ dir.path }}" } }],
      peer: true,
    });
    // Central: its orchestrator's shape, a turn that builds on the spoke and
    // hands the result on.
    central = await createStrut({
      workspace: new WorkspaceManager(dirs[1]!),
      store: new MemoryRunStore(),
      ...NO_SEEDS,
      peers: [{ id: "billing", baseUrl: urlOf(await spoke.listen(0, "127.0.0.1")), token: "central-for-billing" }],
    });
    await central.workspace.publishWorkflow("relay", "v1", {
      steps: [
        { id: "b", type: "strut/run-workflow", config: { peer: "billing", workflow: "build", job: "team/j1" } },
        { id: "out", type: "pack", config: { text: "{{ b.output.text }}", artifacts: "{{ b.output.artifacts }}" } },
      ],
      peer: true,
    });
    // The laptop: one peer, the org's central.
    laptop = await createStrut({
      workspace: new WorkspaceManager(dirs[2]!),
      store: new MemoryRunStore(),
      ...NO_SEEDS,
      peers: [{ id: "acme", baseUrl: urlOf(await central.listen(0, "127.0.0.1")), token: "laptop-for-acme" }],
    });
    await laptop.workspace.publishWorkflow("ask", "v1", { steps: [{ id: "c", type: "strut/run-workflow", config: { peer: "acme", workflow: "relay" } }] });
  });

  after(async () => {
    for (const s of [laptop, central, spoke]) await s?.close();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const settledOn = async (strut: Strut, wf: string, runId: string): Promise<RunSummary> => {
    for (let i = 0; i < 600; i++) {
      const s = await strut.store.getRunSummary(wf, runId);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`run ${wf}/${runId} did not settle`);
  };

  it("the laptop's entry names the next hop, and the file opens through central's read-through from the laptop's own", async () => {
    const res = await laptop.app.request("/workflows/ask/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(res.status, 202);
    const summary = await settledOn(laptop, "ask", ((await res.json()) as { runId: string }).runId);
    assert.equal(summary.status, "success", JSON.stringify(summary.error));
    const relayed = (summary.output as { output: { text: string; artifacts: unknown[] } }).output;
    assert.equal(relayed.text, "Built.");
    // Central tagged it with the spoke; the laptop has no record for the
    // spoke, so it names central and keeps the spoke as `via`, with its job.
    assert.deepEqual(relayed.artifacts, [{ id: "report", title: "Report", path: "report.md", peer: "acme", via: "billing", job: "team/j1" }]);

    // Central reads the spoke's file with its own token; the job id travels encoded.
    const direct = await central.app.request("/peers/billing/jobs/team%2Fj1/files/report.md");
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), "# Report\n");
    assert.equal(direct.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(direct.headers.get("content-security-policy"), "sandbox", "untrusted content on this origin, no scripts");
    // The laptop goes one hop further, each hop with its own token.
    const far = await laptop.app.request("/peers/acme/peers/billing/jobs/team%2Fj1/files/report.md");
    assert.equal(far.status, 200);
    assert.equal(await far.text(), "# Report\n");
    // A listing comes back as the spoke's JSON.
    const listing = await laptop.app.request("/peers/acme/peers/billing/jobs/team%2Fj1/files");
    assert.equal(listing.status, 200);
    assert.equal(listing.headers.get("content-type"), "application/json");
    assert.ok(((await listing.json()) as { files: string[] }).files.includes("report.md"));
    // A file that is not there is the spoke's 404, passed on.
    assert.equal((await laptop.app.request("/peers/acme/peers/billing/jobs/team%2Fj1/files/nope.md")).status, 404);
  });

  it("files only, a peer on file only, and this strut's key never travels on", async () => {
    for (const path of ["/peers/billing/workflows", "/peers/billing/secrets", "/peers/billing/peers/x/workflows"]) {
      assert.equal((await central.app.request(path)).status, 404, path);
    }
    const unknown = await central.app.request("/peers/nope/jobs/j1/files/report.md");
    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as { error: string }).error, /^peer_unknown:/);

    // What a peer receives: the path, the query but `key`, and the token on file.
    const seen: Array<{ url?: string; auth?: string }> = [];
    const spy = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "text/plain");
      res.end("hi");
    });
    await new Promise<void>((r) => spy.listen(0, "127.0.0.1", r));
    try {
      const put = await central.app.request("/peers/spy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: urlOf((spy.address() as AddressInfo).port), token: "central-for-spy" }),
      });
      assert.equal(put.status, 200);
      const res = await central.app.request("/peers/spy/artifacts/123/a.txt?key=central-secret&t=tok");
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "hi");
      assert.deepEqual(seen, [{ url: "/artifacts/123/a.txt?t=tok", auth: "Bearer central-for-spy" }]);
    } finally {
      spy.close();
    }
  });
});

describe("strut/run-workflow's input", () => {
  // A model often sends an object field as its JSON text; the call (and a
  // proposal of it, which a card reads) must hold the object.
  it("is a JSON object, and JSON text of one is read as that object", () => {
    const cfg = runWorkflowStep.input.parse({ peer: "hive", workflow: "orchestrator", input: '{"prompt":"hi","session":"s"}' });
    assert.deepEqual(cfg.input, { prompt: "hi", session: "s" });
    assert.deepEqual(runWorkflowStep.input.parse({ peer: "hive", workflow: "orchestrator", input: { prompt: "hi" } }).input, { prompt: "hi" });
    for (const input of ["not json", "[1]", '"text"']) {
      assert.throws(() => runWorkflowStep.input.parse({ peer: "hive", workflow: "orchestrator", input }), `${input}`);
    }
    const tool = z.toJSONSchema(runWorkflowStep.input, { io: "input" }) as { properties: { input: { type?: string } } };
    assert.equal(tool.properties.input.type, "object");
  });
});

// ── a peer behind TLS with a CA of its own (a home box's `tls internal`) ──

const openssl = spawnSync("openssl", ["version"]).status === 0;

describe("a peer with a CA of its own", { skip: !openssl && "openssl is not installed" }, () => {
  it("is trusted for that peer's requests only: without the CA the same server is refused", async () => {
    const dir = join(tmpdir(), `strut-peer-ca-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const run = (args: string[]) => {
      const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
    };
    // A CA, and a certificate for 127.0.0.1 it signs.
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=test home CA"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "box.key", "-out", "box.csr", "-subj", "/CN=127.0.0.1"]);
    await writeFile(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\n");
    run(["x509", "-req", "-in", "box.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "box.pem", "-days", "2", "-extfile", "ext.cnf"]);
    const server = https.createServer({ key: readFileSync(join(dir, "box.key")), cert: readFileSync(join(dir, "box.pem")) }, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ auth: req.headers.authorization }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const store = peerStore(new MemorySecretStore());
      await store.set(checkPeer({ id: "home", baseUrl, token: "person-token", ca: readFileSync(join(dir, "ca.pem"), "utf-8") }));
      await store.set(checkPeer({ id: "bare", baseUrl, token: "person-token" }));
      const peers = peersCapability(store);
      const res = await peers.fetch("home", "/health");
      assert.deepEqual(await res.json(), { auth: "Bearer person-token" });
      await assert.rejects(peers.fetch("bare", "/health"), /fetch failed/);
      assert.deepEqual((await peers.list()).find((p) => p.id === "home"), { id: "home", baseUrl, ca: true }, "listed without the PEM");
      assert.throws(() => checkPeer({ id: "x", baseUrl, token: "t", ca: "not a cert" }), /ca must be a PEM certificate/);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
