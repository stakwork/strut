import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { kitForTests } from "./test-util/app-kit.js";

// The channel socket (plans/app-channels.md §2): a HOST's socket for an
// app page, opened with a ticket (a browser host) or a credential and
// `?app=` (a server), through the same gate as every route.

type Frame = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, read: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

interface Open {
  ws: WebSocket;
  got: Frame[];
  until: (what: string, pred: (f: Frame) => boolean) => Promise<Frame>;
  send: (frame: unknown) => void;
}

/** A host's socket, with every frame strut sends it — or the status it was refused with. */
function open(url: string, headers: Record<string, string> = {}): Promise<Open> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const got: Frame[] = [];
    ws.on("message", (data) => got.push(JSON.parse(String(data)) as Frame));
    ws.once("open", () =>
      resolve({ ws, got, until: (what, pred) => waitFor(what, () => got.find(pred)), send: (frame) => ws.send(JSON.stringify(frame)) }),
    );
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
  });
}

const statusOf = (url: string, headers: Record<string, string> = {}) =>
  open(url, headers).then(
    ({ ws }) => {
      ws.close();
      return 101;
    },
    (err: { status?: number }) => err.status,
  );

const QUIET = { scheduler: false, serveUi: false, enableChat: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, views: false, concepts: false } as const;

describe("the channel socket", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  let dir: string;
  let strut: Strut;
  let base: string;
  let person: string;

  before(async () => {
    process.env["STRUT_API_KEY"] = "deploy-key";
    process.env["STRUT_PEER_KEY"] = "peer-key";
    dir = await mkdtemp(join(tmpdir(), "strut-channels-"));
    strut = await createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), store: new MemoryRunStore(), kit: await kitForTests(), ...QUIET });
    const src = join(dir, "src", "chess");
    for (const [rel, text] of Object.entries({ "app.yaml": "title: Chess\n", "src/App.tsx": "export default function App() { return <p>chess</p>; }\n" })) {
      await mkdir(join(src, dirname(rel)), { recursive: true });
      await writeFile(join(src, rel), text, "utf8");
    }
    const published = await strut.apps.publish(src, "chess", { surface: "person" });
    assert.ok(published.ok, published.ok ? "" : published.errors.join("\n"));
    base = `127.0.0.1:${await strut.listen(0, "127.0.0.1")}`;
    const minted = await fetch(`http://${base}/peers/tokens`, {
      method: "POST",
      headers: { authorization: "Bearer deploy-key", "content-type": "application/json" },
      body: JSON.stringify({ actor: "carol" }),
    });
    person = ((await minted.json()) as { token: string }).token;
  });

  after(async () => {
    await strut.close();
    await rm(dir, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** What a host's server asks for: a ticket for its viewer, as Hive's does with the swarm key. */
  const mint = async (body: unknown, headers: Record<string, string> = { authorization: "Bearer deploy-key" }) => {
    const res = await fetch(`http://${base}/apps/chess/channel-ticket`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { ticket?: string; exp?: number; error?: string } };
  };
  const ticketFor = async (actor: string) => {
    const { status, body } = await mint({ version: "v1" }, { authorization: "Bearer deploy-key", "x-strut-actor": actor });
    assert.equal(status, 200, body.error);
    return body.ticket!;
  };
  const socket = (query: string) => `ws://${base}/channels?${query}`;

  it("a ticket opens the app's channels for its viewer: two hosts' sockets meet, and strut stamps the sender", async () => {
    const minted = await mint({ version: "v1" }, { authorization: "Bearer deploy-key", "x-strut-actor": "alice" });
    assert.equal(minted.status, 200);
    assert.match(minted.body.ticket!, /^strut-channel\./);
    assert.ok(minted.body.exp! > Date.now() && minted.body.exp! <= Date.now() + 60_000);

    const alice = await open(socket(`ticket=${encodeURIComponent(minted.body.ticket!)}`));
    const bob = await open(socket(`ticket=${encodeURIComponent(await ticketFor("bob"))}`));
    try {
      alice.send({ op: "join", channel: "lobby" });
      const joined = await alice.until("alice's joined", (f) => f.op === "joined");
      bob.send({ op: "join", channel: "lobby" });
      await bob.until("bob's joined", (f) => f.op === "joined");
      await alice.until("bob's arrival", (f) => f.op === "presence" && f.joined?.actor === "bob");
      alice.send({ op: "send", channel: "lobby", messages: [{ data: { move: "e4" } }] });
      const move = await bob.until("alice's move", (f) => f.op === "message");
      assert.deepEqual(move.message.from, { actor: "alice", client: joined.client });
      assert.deepEqual(move.message.data, { move: "e4" });
      alice.send("not json");
      assert.match((await alice.until("an error", (f) => f.op === "error")).error, /JSON object/);
    } finally {
      alice.ws.close();
      bob.ws.close();
    }
  });

  it("who may open it: a ticket strut signed, or a person's credential or the key with ?app=; never a strut's, nor nothing", async () => {
    assert.equal(await statusOf(socket("")), 401);
    assert.equal(await statusOf(socket("ticket=strut-channel.forged.sig")), 401);
    assert.equal(await statusOf(socket(`ticket=x&app=chess@v1`), { authorization: "Bearer deploy-key" }), 401, "a bad ticket is refused even beside a credential");
    assert.equal(await statusOf(socket("app=chess@v1"), { authorization: "Bearer deploy-key", "x-strut-actor": "alice" }), 101);
    assert.equal(await statusOf(socket("app=chess@v1"), { authorization: `Bearer ${person}` }), 101);
    assert.equal(await statusOf(socket("app=chess@v1"), { authorization: "Bearer peer-key", "x-strut-actor": "alice" }), 403);
    assert.equal(await statusOf(socket(""), { authorization: "Bearer deploy-key" }), 400);
    assert.equal(await statusOf(socket("app=chess@v9"), { authorization: "Bearer deploy-key" }), 404);
    // Plain HTTP is no socket.
    assert.equal((await fetch(`http://${base}/channels?ticket=${encodeURIComponent(await ticketFor("alice"))}`)).status, 426);
  });

  it("who may mint a ticket: the key or a session, for an app version this strut holds; never a peer", async () => {
    assert.equal((await mint({ version: "v1" }, {})).status, 401);
    assert.equal((await mint({ version: "v1" }, { authorization: "Bearer peer-key", "x-strut-actor": "alice" })).status, 403);
    assert.equal((await mint({ version: "v1" }, { authorization: `Bearer ${person}` })).status, 403);
    assert.equal((await mint({})).status, 400);
    assert.equal((await mint({ version: "v9" })).status, 404);
    assert.equal((await mint({ version: "latest" })).status, 404);
    const anonymous = await mint({ version: "v1" });
    assert.equal(anonymous.status, 200, "the key with no actor: a viewer strut stamps by client alone");
  });

  it("a host that comes back with ?client= keeps its place; a clean close leaves at once", async () => {
    const alice = await open(socket(`ticket=${encodeURIComponent(await ticketFor("alice"))}`));
    const bob = await open(socket(`ticket=${encodeURIComponent(await ticketFor("bob"))}`));
    try {
      alice.send({ op: "join", channel: "game" });
      const { client } = await alice.until("alice's joined", (f) => f.op === "joined");
      alice.send({ op: "send", channel: "game", messages: [{ key: "pos", data: "e2" }] });
      bob.send({ op: "join", channel: "game" });
      await bob.until("bob's joined", (f) => f.op === "joined");

      alice.ws.terminate(); // the network, not the host: no close frame
      await sleep(100);
      const back = await open(socket(`ticket=${encodeURIComponent(await ticketFor("alice"))}&client=${client}`));
      try {
        back.send({ op: "join", channel: "game" });
        const rejoined = await back.until("alice's rejoin", (f) => f.op === "joined");
        assert.equal(rejoined.client, client);
        assert.deepEqual(rejoined.messages.map((m: Frame) => m.data), ["e2"]);
        await sleep(50);
        assert.equal(bob.got.filter((f) => f.op === "presence").length, 0, "bob never saw alice leave, nor come back");

        back.ws.close(1000);
        const left = await bob.until("alice's leave", (f) => f.op === "presence" && f.left);
        assert.equal(left.left.client, client);
      } finally {
        back.ws.close();
      }
    } finally {
      bob.ws.close();
    }
  });

  it("the ticket never reaches the log", async () => {
    const ticket = await ticketFor("alice");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const s = await open(socket(`ticket=${encodeURIComponent(ticket)}`));
      s.ws.close();
      await fetch(`http://${base}/channels?ticket=${encodeURIComponent(ticket)}`);
    } finally {
      console.log = log;
    }
    const logged = lines.filter((l) => l.includes("/channels"));
    assert.ok(logged.length >= 2, `the requests were logged: ${lines.join("\n")}`);
    for (const l of logged) {
      assert.ok(!l.includes(ticket.slice(14, 40)), l);
      assert.match(l, /ticket=…/);
    }
  });

  it("behind a host that owns the server: routed under its mount, strut's gate decides", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on("upgrade", (req, sock, head) => {
      if (!strut.upgrade(req, sock, head, { basePath: "/lab" })) {
        sock.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        sock.destroy();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const lab = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/lab/channels`;
    try {
      assert.equal(await statusOf(lab), 401);
      const s = await open(`${lab}?ticket=${encodeURIComponent(await ticketFor("alice"))}`);
      s.send({ op: "join", channel: "lobby" });
      assert.equal((await s.until("joined", (f) => f.op === "joined")).members[0].actor, "alice");
      s.ws.close();
    } finally {
      server.close();
    }
  });
});
