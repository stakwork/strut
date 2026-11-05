import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { createStrut, type Strut } from "./createStrut.js";
import { FileWorkspaceStore } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { kitForTests } from "./test-util/app-kit.js";
import { peerChannelUrl } from "./channels-peer.js";

// The peer relay (plans/app-channels.md §4): a page on "mine" showing an app
// that lives on "acme" opens its socket on mine; mine pipes it to acme's
// channel socket with the person token on file, so the page meets acme's
// own viewers in acme's channel, stamped as the person.

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
  closed: Promise<number>;
}

function open(url: string): Promise<Open> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got: Frame[] = [];
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.on("message", (data) => got.push(JSON.parse(String(data)) as Frame));
    ws.once("open", () => resolve({ ws, got, closed, until: (what, pred) => waitFor(what, () => got.find(pred)), send: (f) => ws.send(JSON.stringify(f)) }));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
  });
}

const QUIET = { scheduler: false, serveUi: false, enableChat: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, views: false, concepts: false } as const;
const KEY = "deploy-key";

describe("channels through a peer", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  let root: string;
  let acme: Strut;
  let mine: Strut;
  let acmeBase: string;
  let mineBase: string;

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = "peer-key";
    const kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-channels-peer-"));
    acme = await createStrut({ workspace: new FileWorkspaceStore(join(root, "acme")), store: new MemoryRunStore(), kit, ...QUIET });
    const src = join(root, "src", "hello");
    for (const [rel, text] of Object.entries({ "app.yaml": "title: Hello\n", "src/App.tsx": "export default function App() { return <p>hi</p>; }\n" })) {
      await mkdir(join(src, dirname(rel)), { recursive: true });
      await writeFile(join(src, rel), text, "utf8");
    }
    const published = await acme.apps.publish(src, "hello", { surface: "person" });
    assert.ok(published.ok, published.ok ? "" : published.errors.join("\n"));
    acmeBase = `http://127.0.0.1:${await acme.listen(0, "127.0.0.1")}`;
    // The person's credential for acme, as hive's pairing mints one.
    const minted = await fetch(`${acmeBase}/peers/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ actor: "alice" }),
    });
    const person = ((await minted.json()) as { token: string }).token;
    mine = await createStrut({
      workspace: new FileWorkspaceStore(join(root, "mine")),
      store: new MemoryRunStore(),
      ...QUIET,
      peers: [
        { id: "acme", baseUrl: acmeBase, token: person },
        // A strut's credential, not a person's: acme has no member to stamp.
        { id: "acme-plain", baseUrl: acmeBase, token: "peer-key" },
      ],
    });
    mineBase = `http://127.0.0.1:${await mine.listen(0, "127.0.0.1")}`;
  });

  after(async () => {
    await mine.close();
    await acme.close();
    await rm(root, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const mint = async (base: string, body: Record<string, unknown>, actor: string) => {
    const res = await fetch(`${base}/apps/hello/channel-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "x-strut-actor": actor, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { ticket?: string; error?: string } };
  };
  const socketOn = async (base: string, body: Record<string, unknown>, actor: string, extra = "") => {
    const { status, body: b } = await mint(base, body, actor);
    assert.equal(status, 200, b.error);
    return open(`${base.replace("http", "ws")}/channels?ticket=${encodeURIComponent(b.ticket!)}${extra}`);
  };

  it("a page on mine meets acme's viewers in acme's channel, stamped as the person on file", async () => {
    const relayed = await socketOn(mineBase, { version: "v1", peer: "acme" }, "evan-local");
    const direct = await socketOn(acmeBase, { version: "v1" }, "bob");
    try {
      relayed.send({ op: "join", channel: "lobby" });
      const joined = await relayed.until("joined, from acme", (f) => f.op === "joined");
      assert.deepEqual(joined.members.map((m: Frame) => m.actor), ["alice"], "acme stamps the person token's actor, not mine's viewer");
      direct.send({ op: "join", channel: "lobby" });
      await direct.until("bob's joined", (f) => f.op === "joined");
      await relayed.until("bob's arrival", (f) => f.op === "presence" && f.joined?.actor === "bob");
      relayed.send({ op: "send", channel: "lobby", messages: [{ data: "hi from mine" }] });
      const heard = await direct.until("the relayed message", (f) => f.op === "message");
      assert.deepEqual(heard.message.from, { actor: "alice", client: joined.client });
      direct.send({ op: "send", channel: "lobby", messages: [{ data: "hi from acme" }] });
      assert.equal((await relayed.until("acme's message", (f) => f.op === "message" && f.message.data === "hi from acme")).message.from.actor, "bob");

      relayed.ws.close(1000);
      await direct.until("alice's leave", (f) => f.op === "presence" && f.left?.actor === "alice");
    } finally {
      relayed.ws.close();
      direct.ws.close();
    }
  });

  it("an abrupt drop keeps the place on acme, and the host comes back with its client id through mine", async () => {
    const direct = await socketOn(acmeBase, { version: "v1" }, "bob");
    const relayed = await socketOn(mineBase, { version: "v1", peer: "acme" }, "evan-local");
    try {
      direct.send({ op: "join", channel: "game" });
      await direct.until("bob's joined", (f) => f.op === "joined");
      relayed.send({ op: "join", channel: "game" });
      const { client } = await relayed.until("joined", (f) => f.op === "joined");
      await direct.until("alice's arrival", (f) => f.op === "presence" && f.joined);
      relayed.ws.terminate();
      await sleep(150);
      const back = await socketOn(mineBase, { version: "v1", peer: "acme" }, "evan-local", `&client=${client}`);
      try {
        back.send({ op: "join", channel: "game" });
        assert.equal((await back.until("rejoined", (f) => f.op === "joined")).client, client);
        await sleep(50);
        assert.equal(direct.got.filter((f) => f.op === "presence" && f.left).length, 0, "acme never saw alice leave");
      } finally {
        back.ws.close();
      }
    } finally {
      direct.ws.close();
    }
  });

  it("what the peer refuses reaches the page as an error, and mine refuses a peer it does not know", async () => {
    const missing = await socketOn(mineBase, { version: "v9", peer: "acme" }, "evan-local");
    missing.send({ op: "join", channel: "lobby" });
    const refused = await missing.until("the peer's refusal", (f) => f.op === "error");
    assert.match(refused.error, /the peer refused the channel socket: 404 .*no version v9/);
    assert.equal(await missing.closed, 1011);

    const plain = await socketOn(mineBase, { version: "v1", peer: "acme-plain" }, "evan-local");
    assert.match((await plain.until("a strut's credential refused", (f) => f.op === "error")).error, /403/);

    assert.equal((await mint(mineBase, { version: "v1", peer: "nobody" }, "evan-local")).status, 404);
    assert.equal((await mint(mineBase, { version: "latest", peer: "acme" }, "evan-local")).status, 404);
  });

  it("names the peer's socket from its base URL, under its mount", () => {
    assert.equal(peerChannelUrl({ baseUrl: "https://swarm.example:3355/lab" }, { name: "acme/board", version: "v2" }, "c-1"), "wss://swarm.example:3355/lab/channels?app=acme%2Fboard%40v2&client=c-1");
    assert.equal(peerChannelUrl({ baseUrl: "http://127.0.0.1:3000" }, { name: "hello", version: "v1" }), "ws://127.0.0.1:3000/channels?app=hello%40v1");
  });
});
