import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createStrut, type Strut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, type RunSummary } from "../core.js";
import { FileWorkspaceStore } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { appIdentity } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";

/**
 * A peer's app, hosted by a person's own strut (plans/apps.md §7.4). Two
 * struts: `acme` (the org's, where the app lives) and the person's own
 * (Peel's), which holds a PERSON token for acme as its peer record. On acme,
 * that token gets `step_run` alone on `/mcp`, as the person, under the
 * app's grants — a run it launches is the app's, not a peer launch — while
 * a plain peer key and `/mcp/builder` stay closed. Through the person's
 * strut, the read-through serves acme's app list, the version's listing and
 * the document with its identity (an ETag, a 304), and `POST
 * /peers/acme/mcp` relays the page's tools/call; a peer of the person's
 * strut cannot relay through it.
 */

const KEY = "peer-host-key";
const PEER_KEY = "peer-host-peer-key";
const keyed = { authorization: `Bearer ${KEY}` };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const whoami = defineStep({
  type: "whoami",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    return { app: ctx.app ?? null, actor: ctx.actor ?? null, principal: ctx.principal ?? null };
  },
});

/** The result of a stateless door's answer: its first `data:` line (SSE) or the JSON body. */
const rpcResult = (text: string): any => {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
};
const rpcBody = (method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

describe("a peer's app, hosted by a person's own strut (plans/apps.md §7.4)", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  let root: string;
  let acme: Strut;
  let mine: Strut;
  const acmeStore = new MemoryRunStore();
  let personToken: string;
  let identity: string;

  /** A JSON-RPC call to `path` on `strut` with `auth`; the status and the result. */
  const rpc = async (strut: Strut, path: string, auth: string, method: string, params: unknown) => {
    const res = await strut.app.request(path, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${auth}` }, body: rpcBody(method, params) });
    const text = await res.text();
    return { status: res.status, text, body: res.status === 200 ? rpcResult(text) : undefined };
  };
  /** step_run's result, unwrapped from the MCP answer (or its error text). */
  const stepRun = (r: { body?: any }): { result?: any; error?: string } => {
    const res = r.body?.result;
    const text = res?.content?.[0]?.text as string | undefined;
    if (res?.isError) return { error: text ?? "error" };
    return { result: res?.structuredContent ?? (text ? JSON.parse(text) : undefined) };
  };
  const settled = async (strut: Strut, wf: string, runId: string): Promise<RunSummary> => {
    for (let i = 0; i < 400; i++) {
      const s = await strut.store.getRunSummary(wf, runId);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`run ${wf}/${runId} did not settle`);
  };

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER_KEY;
    const kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-peer-host-"));
    const quiet = { scheduler: false, serveUi: false, enableChat: false, enableMcp: true, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, views: false } as const;

    acme = await createStrut({ workspace: new FileWorkspaceStore(join(root, "acme")), store: acmeStore, registry: await createRegistry([whoami]), kit, ...quiet });
    // NOT open to peers: no `peer:` in its YAML. The app grants it.
    await acme.workspace.publishWorkflowByContent("echo-app", "name: echo-app\nsteps:\n  - id: w\n    type: whoami\n");
    const dir = join(root, "src", "hello-peer");
    const files: Record<string, string> = {
      "app.yaml": "title: Hello peer\ngrants:\n  workflows: [echo-app]\n  steps: [whoami]\n",
      "src/App.tsx": 'export default function App() { return <p className="p-2">hi</p>; }\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, dirname(rel)), { recursive: true });
      await writeFile(join(dir, rel), text, "utf8");
    }
    const published = await acme.apps.publish(dir, "hello-peer", { surface: "person" });
    assert.ok(published.ok, published.ok ? "" : published.errors.join("\n"));
    identity = appIdentity("hello-peer", "v1");

    // The person's credential for acme, as hive's pairing mints one.
    const minted = await acme.app.request("/peers/tokens", { method: "POST", headers: { ...keyed, "content-type": "application/json" }, body: JSON.stringify({ actor: "alice" }) });
    assert.equal(minted.status, 200, await minted.clone().text());
    personToken = ((await minted.json()) as { token: string }).token;

    const port = await acme.listen(0, "127.0.0.1");
    mine = await createStrut({
      workspace: new FileWorkspaceStore(join(root, "mine")),
      store: new MemoryRunStore(),
      ...quiet,
      peers: [{ id: "acme", baseUrl: `http://127.0.0.1:${port}`, token: personToken, label: "Acme" }],
    });
  });

  after(async () => {
    await mine?.close();
    await acme?.close();
    await rm(root, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("on the peer: a person token gets step_run alone on /mcp, as that person, under the app's grants; a plain peer and /mcp/builder stay closed", async () => {
    const list = await rpc(acme, "/mcp", personToken, "tools/list", {});
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.result.tools.map((t: { name: string }) => t.name), ["step_run"]);

    const me = stepRun(await rpc(acme, "/mcp", personToken, "tools/call", { name: "step_run", arguments: { type: "whoami", config: {}, app: identity } }));
    assert.equal(me.error, undefined, me.error);
    assert.deepEqual(me.result, { app: { name: "hello-peer", version: "v1" }, actor: "alice", principal: "alice" });

    // The app's grants are the fence: a step it does not grant is refused.
    const log = stepRun(await rpc(acme, "/mcp", personToken, "tools/call", { name: "step_run", arguments: { type: "log", config: { message: "x" }, app: identity } }));
    assert.match(log.error ?? "", /step_run refused/);

    // A granted workflow the YAML does not open to peers runs, as the app's
    // run — the person behind the token, origin app — never a peer launch.
    const launched = stepRun(await rpc(acme, "/mcp", personToken, "tools/call", { name: "step_run", arguments: { type: "run/launch", config: { workflow: "echo-app" }, app: identity } }));
    assert.equal(launched.error, undefined, launched.error);
    const summary = await settled(acme, "echo-app", (launched.result as { runId: string }).runId);
    assert.equal(summary.status, "success", JSON.stringify(summary.error));
    assert.deepEqual([summary.actor, summary.origin, summary.app?.name], ["alice", "app", "hello-peer"]);
    const direct = await acme.app.request("/workflows/echo-app/run", { method: "POST", headers: { authorization: `Bearer ${personToken}`, "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(direct.status, 403, "launched directly, the same workflow is not open to a peer");

    // A plain peer (its actor a header) gets nothing on /mcp; the builder's door is not a person's.
    assert.equal((await rpc(acme, "/mcp", PEER_KEY, "tools/list", {})).status, 403);
    assert.equal((await rpc(acme, "/mcp/builder", personToken, "tools/list", {})).status, 403);
    // The key still gets the full door.
    const full = await rpc(acme, "/mcp", KEY, "tools/list", {});
    assert.ok(full.body.result.tools.length > 1);
  });

  it("through the person's strut: the peer's app list, the document with its identity and an ETag, and the page's tools/call relayed", async () => {
    const apps = await mine.app.request("/peers/acme/apps", { headers: keyed });
    assert.equal(apps.status, 200);
    assert.equal(apps.headers.get("content-type"), "application/json");
    const listed = ((await apps.json()) as { apps: Array<{ name: string; activeVersion: string; title: string }> }).apps;
    assert.deepEqual(listed.map((a) => [a.name, a.activeVersion, a.title]), [["hello-peer", "v1", "Hello peer"]]);

    const scope = await mine.app.request("/peers/acme/apps/hello-peer/v1/files", { headers: keyed });
    assert.equal(scope.status, 200);
    const { token, files } = (await scope.json()) as { token: string; files: string[] };
    assert.ok(token && files.includes("dist/index.html"));

    const docPath = `/peers/acme/apps/hello-peer/v1/files/dist/index.html?t=${encodeURIComponent(token)}`;
    const doc = await mine.app.request(docPath, { headers: keyed });
    assert.equal(doc.status, 200);
    const html = await doc.text();
    const meta = html.match(/<meta name="strut-app-token" content="([^"]+)"/)?.[1];
    assert.equal(meta, identity, "the peer's own identity for the page, which this strut cannot mint");
    assert.equal(doc.headers.get("content-security-policy"), "sandbox", "untrusted content here, no scripts: a host frames its text");
    const etag = doc.headers.get("etag");
    assert.ok(etag, "the peer's ETag passes through");
    const again = await mine.app.request(docPath, { headers: { ...keyed, "if-none-match": etag! } });
    assert.equal(again.status, 304);

    // The page's call, relayed with the person token on file.
    const me = stepRun(await rpc(mine, "/peers/acme/mcp", KEY, "tools/call", { name: "step_run", arguments: { type: "whoami", config: {}, app: meta } }));
    assert.equal(me.error, undefined, me.error);
    assert.deepEqual(me.result, { app: { name: "hello-peer", version: "v1" }, actor: "alice", principal: "alice" });

    // A peer of the person's strut never relays through it; an app's other routes are not read through.
    assert.equal((await rpc(mine, "/peers/acme/mcp", PEER_KEY, "tools/list", {})).status, 403);
    assert.equal((await mine.app.request("/peers/acme/apps/hello-peer", { headers: keyed })).status, 404);
    assert.equal((await mine.app.request("/peers/acme/mcp", { headers: keyed })).status, 405, "POST only, as /mcp: a client's GET for a stream reads 405 as none");
    assert.equal((await rpc(mine, "/peers/nope/mcp", KEY, "tools/list", {})).status, 404);
  });
});
