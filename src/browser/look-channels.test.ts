import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { answerChannelSocket, BrowserService, STRUT_CHANNEL_SOCKET, type ChannelSocketRoute, type StrutChannelSocket } from "./service.js";
import type { ChannelConnection, ChannelFrame, ChannelTransport } from "../channels.js";
import { createStrut, type Strut } from "../createStrut.js";
import { FileWorkspaceStore } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { kitForTests } from "../test-util/app-kit.js";

// app/look's page opens an app's channel socket at wss://strut.invalid,
// which `page.route` never sees and no host answers: lookAtApp routes it
// with `page.routeWebSocket` and answers it in this process
// (plans/app-channels.md item 7).

/** Playwright's WebSocketRoute, driven by hand: the page's side. */
class FakeRoute implements ChannelSocketRoute {
  sent: string[] = [];
  closedWith?: number;
  private onMsg?: (m: string | Buffer) => unknown;
  private onCls?: (code: number | undefined, reason: string | undefined) => unknown;
  constructor(private readonly where: string) {}
  url() {
    return this.where;
  }
  send(message: string) {
    this.sent.push(message);
  }
  async close(options?: { code?: number }) {
    this.closedWith = options?.code;
  }
  onMessage(handler: (m: string | Buffer) => unknown) {
    this.onMsg = handler;
  }
  onClose(handler: (code: number | undefined, reason: string | undefined) => unknown) {
    this.onCls = handler;
  }
  pageSends(frame: unknown) {
    this.onMsg?.(JSON.stringify(frame));
  }
  pageCloses(code: number) {
    this.onCls?.(code, undefined);
  }
  frames(): ChannelFrame[] {
    return this.sent.map((t) => JSON.parse(t) as ChannelFrame);
  }
}

describe("app/look's channel socket", () => {
  it("routes only strut's own channel socket", () => {
    assert.ok(STRUT_CHANNEL_SOCKET.test("wss://strut.invalid/channels?ticket=t&client=c"));
    assert.ok(!STRUT_CHANNEL_SOCKET.test("wss://strut.invalid/rooms"));
    assert.ok(!STRUT_CHANNEL_SOCKET.test("wss://example.com/channels"));
  });

  it("hands the socket to the channels: what the page sent early waits for them, strut's frames reach the page, a clean close passes on", async () => {
    const route = new FakeRoute("wss://strut.invalid/channels?ticket=t");
    const received: unknown[] = [];
    let closedClean: boolean | undefined;
    let transport: ChannelTransport | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const open: StrutChannelSocket = async (url, actor, t) => {
      assert.equal(url, "wss://strut.invalid/channels?ticket=t");
      assert.equal(actor, "alice");
      transport = t;
      await gate;
      const conn: ChannelConnection = { client: "c1", receive: (f) => received.push(f), pong: () => undefined, close: (clean) => (closedClean = clean) };
      return conn;
    };
    const answered = answerChannelSocket(route, open, "alice");
    route.pageSends({ op: "join", channel: "lobby" });
    release();
    await answered;
    assert.deepEqual(received, [{ op: "join", channel: "lobby" }], "the early join reached the channels");
    transport!.send(JSON.stringify({ op: "presence", channel: "lobby", left: { client: "x", since: 1 } }));
    assert.equal(route.frames()[0]?.op, "presence");
    route.pageCloses(1000);
    assert.equal(closedClean, true);
  });

  it("a socket strut refuses is an error frame and a 1011 to the page", async () => {
    const route = new FakeRoute("wss://strut.invalid/channels?ticket=bad");
    await answerChannelSocket(route, async () => ({ error: "the channel socket was refused: 401 …" }), undefined);
    assert.deepEqual(route.frames(), [{ op: "error", error: "the channel socket was refused: 401 …" }]);
    assert.equal(route.closedWith, 1011);
  });
});

describe("app/look's channel socket, answered by a strut", () => {
  const saved = process.env["STRUT_API_KEY"];
  let root: string;
  let strut: Strut;
  const browser = new BrowserService();

  before(async () => {
    process.env["STRUT_API_KEY"] = "deploy-key";
    root = await mkdtemp(join(tmpdir(), "strut-look-channels-"));
    strut = await createStrut({
      workspace: new FileWorkspaceStore(join(root, "ws")),
      store: new MemoryRunStore(),
      kit: await kitForTests(),
      services: { browser },
      scheduler: false, enableChat: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, views: false, concepts: false,
    });
    const src = join(root, "src", "chess");
    for (const [rel, text] of Object.entries({ "app.yaml": "title: Chess\n", "src/App.tsx": "export default function App() { return <p>chess</p>; }\n" })) {
      await mkdir(join(src, dirname(rel)), { recursive: true });
      await writeFile(join(src, rel), text, "utf8");
    }
    const published = await strut.apps.publish(src, "chess", { surface: "person" });
    assert.ok(published.ok, published.ok ? "" : published.errors.join("\n"));
  });

  after(async () => {
    await strut.close();
    await rm(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
  });

  it("admits the page's ticket as an upgrade would and joins the app's channels as the viewer it names", async () => {
    const open = (browser as unknown as { channelSocket?: StrutChannelSocket }).channelSocket;
    assert.ok(open, "createStrut hands the service its channel socket when it serves a UI");
    const minted = await strut.app.request("/apps/chess/channel-ticket", {
      method: "POST",
      headers: { authorization: "Bearer deploy-key", "x-strut-actor": "alice", "content-type": "application/json" },
      body: JSON.stringify({ version: "v1" }),
    });
    const { ticket } = (await minted.json()) as { ticket: string };
    const sent: ChannelFrame[] = [];
    const conn = await open(`wss://strut.invalid/channels?ticket=${encodeURIComponent(ticket)}`, "alice", { send: (t) => sent.push(JSON.parse(t) as ChannelFrame) });
    assert.ok(!("error" in conn), "error" in conn ? conn.error : "");
    (conn as ChannelConnection).receive({ op: "join", channel: "lobby" });
    const joined = sent.find((f) => f.op === "joined");
    assert.ok(joined && joined.op === "joined");
    assert.deepEqual(joined.members.map((m) => m.actor), ["alice"]);

    const refused = await open("wss://strut.invalid/channels?ticket=forged", "alice", { send: () => undefined });
    assert.ok("error" in refused && /401/.test(refused.error));
  });
});
