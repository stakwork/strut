// GET /apps/look/stream (src/browser/look-stream.ts): the upgrade admitted
// through the one gate as the person, and the socket driven, against a
// stand-in for the browser's `streamApp`. The real page and its screencast
// are in src/apps/look.live.test.ts.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { createStrut, type Strut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { personToken } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";
import { BrowserService, type AppStream } from "./service.js";
import { closeReason, LOOK_STREAM_PATH } from "./look-stream.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A browser whose `streamApp` is the test's: what it was asked, the frames
 *  it sends, how it fails or ends. Nothing connects to a real browser. */
class StandIn extends BrowserService {
  asked: Array<{ name: string; version: string; actor?: string; link?: Record<string, string> }> = [];
  closed = 0;
  refuse?: string;
  endNow?: (why: string) => void;
  send?: (jpeg: Buffer) => void;
  override async streamApp(input: { name: string; version: string; actor?: string; link?: Record<string, string> }, onFrame: (jpeg: Buffer) => void): Promise<AppStream> {
    this.asked.push(input);
    if (this.refuse) throw new Error(this.refuse);
    this.send = onFrame;
    const ended = new Promise<string>((r) => (this.endNow = r));
    return { width: 1280, height: 720, ended, close: async () => void this.closed++ };
  }
}

interface Opened {
  ws: WebSocket;
  frames: Buffer[];
  texts: string[];
  closed: Promise<{ code: number; reason: string }>;
}

function open(url: string, headers: Record<string, string> = {}): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const frames: Buffer[] = [];
    const texts: string[] = [];
    ws.on("message", (data, binary) => (binary ? frames.push(data as Buffer) : texts.push(String(data))));
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.once("close", (code, reason) => r({ code, reason: String(reason) })));
    ws.once("open", () => resolve({ ws, frames, texts, closed }));
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

const QUIET = { scheduler: false, enableChat: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false, views: false, concepts: false } as const;

describe("GET /apps/look/stream", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  let dir: string;
  let strut: Strut;
  let base: string;
  const browser = new StandIn();
  const key = { authorization: "Bearer deploy-key" };

  before(async () => {
    process.env["STRUT_API_KEY"] = "deploy-key";
    process.env["STRUT_PEER_KEY"] = "peer-key";
    dir = await mkdtemp(join(tmpdir(), "strut-look-stream-"));
    strut = await createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), store: new MemoryRunStore(), kit: await kitForTests(), services: { browser }, ...QUIET });
    const src = join(dir, "src", "board");
    for (const [rel, text] of Object.entries({ "app.yaml": "title: Board\n", "src/App.tsx": "export default function App() { return <p>board</p>; }\n" })) {
      await mkdir(join(src, dirname(rel)), { recursive: true });
      await writeFile(join(src, rel), text, "utf8");
    }
    const published = await strut.apps.publish(src, "board", { surface: "person" });
    assert.ok(published.ok, published.ok ? "" : published.errors.join("\n"));
    const port = await strut.listen(0, "127.0.0.1");
    base = `ws://127.0.0.1:${port}${LOOK_STREAM_PATH}`;
  });

  after(async () => {
    await strut.close();
    await rm(dir, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("is a WebSocket: a plain GET is 426", async () => {
    const res = await strut.app.request(`${LOOK_STREAM_PATH}?app=board`, { headers: key });
    assert.equal(res.status, 426);
  });

  it("is admitted by the gate: no credential 401, the plain peer key 403, no app 400, an unknown one 404", async () => {
    assert.equal(await statusOf(`${base}?app=board`), 401);
    assert.equal(await statusOf(`${base}?app=board`, { authorization: "Bearer peer-key", "x-strut-actor": "tom-1" }), 403);
    assert.equal(await statusOf(base, key), 400);
    assert.equal(await statusOf(`${base}?app=nope`, key), 404);
    assert.equal(await statusOf(`${base}?app=board&version=v9`, key), 404);
    assert.equal(browser.asked.length, 0, "nothing opened");
  });

  it("opens the app as the person, at the deep link, and sends each frame as one binary message; closing the socket closes the page", async () => {
    const s = await open(`${base}?app=board&input=${encodeURIComponent("present=job-1&view=all")}`, { ...key, "x-strut-actor": "tom-1" });
    for (let i = 0; i < 50 && !browser.send; i++) await sleep(10);
    assert.deepEqual(browser.asked.at(-1), { name: "board", version: "v1", actor: "tom-1", link: { present: "job-1", view: "all" } });
    browser.send!(Buffer.from([0xff, 0xd8, 0xff, 1]));
    browser.send!(Buffer.from([0xff, 0xd8, 0xff, 2]));
    for (let i = 0; i < 50 && s.frames.length < 2; i++) await sleep(10);
    assert.deepEqual(s.frames.map((f) => f[3]), [1, 2]);
    assert.deepEqual(s.texts, []);
    s.ws.close();
    await s.closed;
    for (let i = 0; i < 50 && !browser.closed; i++) await sleep(10);
    assert.equal(browser.closed, 1);
  });

  it("a person's token opens it as the token's own actor", async () => {
    const s = await open(`${base}?app=board`, { authorization: `Bearer ${personToken("ann-2")!.token}`, "x-strut-actor": "mallory-9" });
    for (let i = 0; i < 50 && browser.asked.at(-1)?.actor !== "ann-2"; i++) await sleep(10);
    assert.equal(browser.asked.at(-1)?.actor, "ann-2");
    assert.equal(browser.asked.at(-1)?.link, undefined);
    s.ws.close();
    await s.closed;
  });

  it("a stream that cannot open says why in a text message, then closes 1011 with the reason", async () => {
    browser.refuse = "browser: 4 kept pages and streams are open (BROWSER_SESSIONS_MAX)";
    try {
      const s = await open(`${base}?app=board`, key);
      const { code, reason } = await s.closed;
      assert.equal(code, 1011);
      assert.equal(reason, browser.refuse);
      assert.deepEqual(s.texts.map((t) => JSON.parse(t)), [{ type: "error", error: browser.refuse }]);
      assert.deepEqual(s.frames, []);
    } finally {
      browser.refuse = undefined;
    }
  });

  it("a stream that ends on its own says why, then closes 1011", async () => {
    browser.send = undefined;
    const s = await open(`${base}?app=board`, key);
    for (let i = 0; i < 50 && !browser.send; i++) await sleep(10);
    browser.endNow!("the page crashed");
    const { code, reason } = await s.closed;
    assert.equal(code, 1011);
    assert.equal(reason, "the page crashed");
    assert.deepEqual(s.texts.map((t) => JSON.parse(t)), [{ type: "error", error: "the page crashed" }]);
  });

  it("a close frame's reason is cut to 123 bytes of UTF-8", () => {
    assert.equal(closeReason("short"), "short");
    const cut = closeReason("é".repeat(100));
    assert.ok(Buffer.byteLength(cut) <= 123);
    assert.equal(cut, "é".repeat(61));
  });
});
