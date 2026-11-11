import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withMessages, type RunEvent, type StepContext } from "./core.js";
import type { StrutCapabilities } from "./capabilities.js";
import { appIdentity, appOfIdentity, publicAppIdentity, publicAppOfIdentity } from "./auth.js";
import { kitForTests } from "./test-util/app-kit.js";
import type { KitLocation } from "./apps/kit.js";
import { STEP_RUN_TOOL } from "./apps/tools.js";
import type { PublicViewNeeds } from "./public-view.js";
import { createRegistry } from "./steps/registry.js";
import { runWorkflow } from "./runner.js";
import type { GraphReader, NodeEnvelope } from "./graph/search.js";
import type { GraphBackend } from "./graph/backend.js";
import { seedConceptSchema, testBackends } from "./graph/test-util.js";
import { seedStrutDomain } from "./graph/schema-seed.js";
import {
  createPublicSurface,
  normalizeSurface,
  publicEvent,
  publicReader,
  readSurface,
  relativeImports,
  stepHelpers,
  surfaceProblem,
} from "./public-surface.js";
import { publicRoutes } from "./public-routes.js";

describe("the surface record", () => {
  it("accepts any subset of its lists and refuses anything else", () => {
    assert.equal(surfaceProblem({}), undefined);
    assert.equal(
      surfaceProblem({
        concepts: ["Law"],
        workflows: [{ name: "openlaw-run", runs: true }, { name: "harvey-lab-run" }],
        steps: ["openlaw/runs"],
        types: ["Document"],
        apps: [{ name: "openlaw-benchmarks", reads: ["openlaw/runs"], domains: ["openlaw.ai"] }],
      }),
      undefined,
    );
    assert.match(surfaceProblem({ secrets: [] })!, /unknown field "secrets"/);
    assert.match(surfaceProblem({ workflows: ["openlaw-run"] })!, /workflows is a list of \{ name, runs\? \}/);
    assert.match(surfaceProblem({ workflows: [{ name: "x", runs: "yes" }] })!, /runs is true or false/);
    assert.match(surfaceProblem({ workflows: [{ name: "x", owner: "tom" }] })!, /a workflow is \{ name, runs\? \}/);
    assert.match(surfaceProblem({ concepts: [""] })!, /concepts is a list of names/);
    assert.match(surfaceProblem({ apps: [{ name: "a", domains: ["https://openlaw.ai"] }] })!, /lowercase host names/);
    assert.match(surfaceProblem([])!, /the surface is/);
  });

  it("normalizes: every list present, each name once, runs only when true", () => {
    assert.deepEqual(normalizeSurface({ workflows: [{ name: "a", runs: false }, { name: "a", runs: true }], steps: ["s", "s"] }), {
      concepts: [],
      workflows: [{ name: "a" }],
      steps: ["s"],
      types: [],
      apps: [],
      runnable: [],
    });
  });

  it("an absent file is the empty surface; a broken one throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-public-"));
    try {
      assert.deepEqual(await readSurface(dir), normalizeSurface({}));
      const s = createPublicSurface({ dataDir: dir, store: new MemoryRunStore() });
      await s.set(normalizeSurface({ workflows: [{ name: "w", runs: true }] }));
      assert.deepEqual((await readSurface(dir)).workflows, [{ name: "w", runs: true }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a step's helpers", () => {
  it("relative imports resolve to step names, and nothing above the steps root", () => {
    const src = `import { a } from "./_shared.js";\nimport b from "../other/_h.ts";\nconst c = await import("./_lazy.js");\nimport "../../outside.js";\nimport { z } from "strut";`;
    assert.deepEqual(relativeImports("openlaw/runs", src).sort(), ["openlaw/_lazy", "openlaw/_shared", "other/_h"]);
  });

  it("follows helpers through helpers, leaving out other steps and missing files", async () => {
    const files: Record<string, string> = {
      "acme/_a": `import { b } from "./_b.js"; export const a = 1;`,
      "acme/_b": `export const b = 2;`,
      "acme/other": `export default 3;`,
    };
    const helpers = await stepHelpers("acme/step", `import { a } from "./_a.js"; import o from "./other.js"; import { g } from "./_gone.js";`, async (n) => files[n] ?? null);
    assert.deepEqual(helpers.map((h) => h.name), ["acme/_a", "acme/_b"]);
  });
});

describe("a run as a visitor reads it", () => {
  it("keeps the input whole and drops who, where and the session", () => {
    const e = {
      ts: "t",
      runId: "r1",
      path: "wf",
      type: "run.start",
      input: { question: "q" },
      actor: "tom",
      principal: "tom",
      job: "app/x/tom",
      startedBy: { workflow: "orchestrator", runId: "r0", session: "tom/hive" },
      callback: { origin: "https://hive" },
      mcp: [{ name: "hive", origin: "https://hive" }],
    } as unknown as RunEvent;
    assert.deepEqual(publicEvent(e, (p) => `/t/${p}`), { ts: "t", runId: "r1", path: "wf", type: "run.start", input: { question: "q" } });
    const end = { ts: "t", runId: "r1", path: "wf/talk", type: "step.end", output: 1, messages: [{ role: "system", content: "s" }] } as unknown as RunEvent;
    assert.deepEqual(publicEvent(end, (p) => `/t/${p}`), { ts: "t", runId: "r1", path: "wf/talk", type: "step.end", output: 1, transcript: "/t/wf/talk" });
  });
});

describe("the graph as a visitor reads it", () => {
  const node = (ref_id: string, node_type = "Concept"): NodeEnvelope => ({ ref_id, node_type, properties: { name: ref_id } });
  const inner = {
    getNode: async (r: string) => (["seen", "hidden"].includes(r) ? node(r) : null),
    getNodeByKey: async () => node("hidden"),
    namesLike: async () => [{ ref_id: "seen", node_type: "Concept", name: "seen" }, { ref_id: "hidden", node_type: "Concept", name: "hidden" }],
    neighbors: async () => ({
      nodes: [node("hidden"), node("other-seen")],
      edges: [
        { source: "seen", target: "hidden", ref_id: "e1", edge_type: "PARENT_OF", properties: {} },
        { source: "seen", target: "other-seen", ref_id: "e2", edge_type: "PARENT_OF", properties: {} },
      ],
    }),
    search: async () => ({ nodes: [node("hidden"), node("seen")], facts: [{}], total: 2, truncated: false }),
    connectionCounts: async () => [{ edge_type: "PARENT_OF", target_type: "Concept", direction: "out", count: 2 }],
    resolveNamespace: async () => "default",
  } as unknown as GraphReader;
  const view = publicReader(inner, async (r) => r === "seen" || r === "other-seen");

  it("a node not visible reads as not there", async () => {
    assert.equal((await view.getNode("seen"))?.ref_id, "seen");
    assert.equal(await view.getNode("hidden"), null);
    assert.equal(await view.getNodeByKey("Concept", "k"), null);
    assert.deepEqual(await view.connectionCounts("hidden"), []);
  });

  it("lists, neighbors and searches keep only visible nodes and edges between them", async () => {
    assert.deepEqual((await view.namesLike("Concept", "e")).map((h) => h.ref_id), ["seen"]);
    const n = await view.neighbors("seen");
    assert.deepEqual(n.nodes.map((x) => x.ref_id), ["other-seen"]);
    assert.deepEqual(n.edges.map((e) => e.ref_id), ["e2"]);
    assert.deepEqual(await view.neighbors("hidden"), { nodes: [], edges: [] });
    const s = await view.search({ q: "x" });
    assert.deepEqual(s.nodes.map((x) => x.ref_id), ["seen"]);
    assert.equal(s.facts, undefined);
  });

  it("refuses the namespace registry", async () => {
    await assert.rejects(view.registerNamespace("x"), /not available to a public read/);
  });
});

describe("the /public routes", () => {
  const KEY = "public-key";
  const PEER = "public-peer";
  const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  let dir: string;
  let saved: Record<string, string | undefined>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-public-routes-"));
    saved = { STRUT_API_KEY: process.env["STRUT_API_KEY"], STRUT_PEER_KEY: process.env["STRUT_PEER_KEY"] };
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const talk = defineStep({
    type: "test/talk",
    input: z.any(),
    output: z.any(),
    async run() {
      return withMessages({ said: "hi" }, [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }]);
    },
  });

  const boot = async () => {
    const store = new MemoryRunStore();
    const strut = await createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), store, serveUi: false, scheduler: false });
    await strut.workspace.createWorkflow("demo", "name: demo\nsteps:\n  - id: talk\n    type: log\n    config:\n      message: hi\n");
    const res = await runWorkflow({ name: "demo", input: z.any(), steps: [{ id: "talk", type: "test/talk", config: {} }] }, { question: "what is law?" }, await createRegistry([talk]), {
      store,
      actor: "tom-1",
    });
    assert.equal(res.status, "success");
    const put = (body: unknown, headers: Record<string, string> = auth) =>
      strut.app.request("/public-view", { method: "PUT", headers, body: JSON.stringify(body) });
    return { strut, store, runId: res.runId, put };
  };

  it("an empty surface answers anyone with nothing, and every other route still needs the key", async () => {
    const { strut } = await boot();
    const res = await strut.app.request("/public");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { host: { remote: 1 }, workflows: [], steps: [], concepts: [], types: [], apps: [], runnable: [] });
    assert.equal((await strut.app.request("/public/workflows/demo")).status, 404);
    assert.equal((await strut.app.request("/public/workflows/demo/flow")).status, 404);
    assert.equal((await strut.app.request("/public/graph/nodes/x")).status, 404);
    assert.equal((await strut.app.request("/workflows/demo")).status, 401);
    assert.equal((await strut.app.request("/workflows/demo/flow")).status, 401);
  });

  it("the record is the person's: no key is a 401, a peer is a 403, and what it names that is not here is reported", async () => {
    const { put } = await boot();
    assert.equal((await put({ workflows: [{ name: "demo" }] }, { "content-type": "application/json" })).status, 401);
    assert.equal((await put({ workflows: [{ name: "demo" }] }, { authorization: `Bearer ${PEER}`, "content-type": "application/json" })).status, 403);
    assert.equal((await put({ workflows: ["demo"] })).status, 400);
    const ok = await put({ workflows: [{ name: "demo" }, { name: "gone" }], steps: ["nope/step"], concepts: ["Law"] });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { surface: unknown; missing: Record<string, string[]> };
    assert.deepEqual(body.missing, { workflows: ["gone"], steps: ["nope/step"], concepts: ["Law"], apps: [] });
  });

  it("a public workflow reads without its runs; with runs: true they read whole, minus who launched them", async () => {
    const { strut, runId, put } = await boot();
    await put({ workflows: [{ name: "demo" }] });
    const listing = (await (await strut.app.request("/public")).json()) as { workflows: Array<{ name: string; runs: boolean }> };
    assert.deepEqual(listing.workflows.map((w) => [w.name, w.runs]), [["demo", false]]);
    const meta = (await (await strut.app.request("/public/workflows/demo")).json()) as Record<string, unknown>;
    assert.equal(meta["active"], "v1");
    assert.equal(meta["owner"], undefined);
    assert.equal((await strut.app.request("/public/workflows/demo/flow")).status, 200);
    assert.match(await (await strut.app.request("/public/workflows/demo/v1")).text(), /type: log/);
    assert.equal((await strut.app.request("/public/workflows/demo/runs")).status, 404);
    assert.equal((await strut.app.request(`/public/workflows/demo/runs/${runId}/events`)).status, 404);

    await put({ workflows: [{ name: "demo", runs: true }] });
    const runs = (await (await strut.app.request("/public/workflows/demo/runs")).json()) as Array<Record<string, unknown>>;
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!["input"], { question: "what is law?" });
    assert.equal(runs[0]!["actor"], undefined);
    const eventsText = await (await strut.app.request(`/public/workflows/demo/runs/${runId}/events`)).text();
    assert.ok(!eventsText.includes("tom-1"), "no actor in a public event");
    const events = JSON.parse(eventsText) as Array<{ type: string; path: string; transcript?: string; messages?: unknown }>;
    const end = events.find((e) => e.type === "step.end" && e.path === "demo/talk")!;
    assert.equal(end.messages, undefined);
    assert.equal(end.transcript, `/public/workflows/demo/runs/${runId}/transcripts/demo/talk`);
    const transcript = (await (await strut.app.request(end.transcript!)).json()) as Array<{ role: string }>;
    assert.deepEqual(transcript.map((m) => m.role), ["system", "user"]);
    assert.equal((await strut.app.request(`/public/workflows/demo/runs/nope/events`)).status, 404);
    // A run id that climbs out of the workflow names no other workflow's run.
    assert.equal((await strut.app.request(`/public/workflows/demo/runs/..%2F..%2Fother%2Fruns%2F${runId}/events`)).status, 404);
  });

  it("every answer may be read from another origin, a preflight needs no key, and no write is open", async () => {
    const { strut } = await boot();
    const res = await strut.app.request("/public");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const pre = await strut.app.request("/public/workflows", { method: "OPTIONS", headers: { origin: "https://index.sphinx.chat", "access-control-request-method": "GET" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    // A launch is open by name (plans/paid-runs.md §3): a workflow nobody
    // made runnable launches nothing. Any other write under /public is shut.
    assert.equal((await strut.app.request("/public/workflows/demo/run", { method: "POST" })).status, 404);
    assert.equal((await strut.app.request("/public/workflows/demo/runs/1/pause", { method: "POST" })).status, 401);
    assert.equal((await strut.app.request("/public", { method: "PUT" })).status, 401);
    assert.equal((await strut.app.request("/public-view")).status, 401);
  });

  it("a public step shows its schema and its source with the helpers it imports, and only it", async () => {
    const { strut, put } = await boot();
    await strut.workspace.publishStep("demo/_shared", `export const shout = (s: string) => s.toUpperCase() + "!";\n`);
    await strut.workspace.publishStep(
      "demo/shout",
      `import { z, defineStep } from "strut";\nimport { shout } from "./_shared.js";\nexport default defineStep({ type: "demo/shout", description: "Shouts.", effect: "read", input: z.object({ text: z.string() }), output: z.string(), async run(cfg) { return shout(cfg.text); } });\n`,
    );
    await strut.rebuildRegistry();
    assert.equal((await strut.app.request("/public/steps/demo/shout/source")).status, 404);
    await put({ steps: ["demo/shout"] });
    assert.deepEqual(await (await strut.app.request("/public/steps")).json(), [{ type: "demo/shout", source: "custom", description: "Shouts.", effect: "read" }]);
    const schema = (await (await strut.app.request("/public/steps/demo/shout/schema")).json()) as { effect: string; fields: Array<{ name: string }> };
    assert.equal(schema.effect, "read");
    assert.deepEqual(schema.fields.map((f) => f.name), ["text"]);
    const source = (await (await strut.app.request("/public/steps/demo/shout/source")).json()) as { source: string; helpers: Array<{ name: string; source: string }> };
    assert.match(source.source, /defineStep/);
    assert.deepEqual(source.helpers.map((h) => h.name), ["demo/_shared"]);
    assert.match(source.helpers[0]!.source, /toUpperCase/);
    assert.equal((await strut.app.request("/public/steps/demo/_shared/source")).status, 404);
    assert.equal((await strut.app.request("/public/steps/demo/shout/versions")).status, 200);
  });

  it("each visitor address has a budget a minute", async () => {
    const app = new Hono();
    publicRoutes(app, {
      surface: createPublicSurface({ dataDir: dir, store: new MemoryRunStore() }),
      workspace: new WorkspaceManager(join(dir, "ws2")),
      store: new MemoryRunStore(),
      registry: () => ({}),
      stepSources: () => ({}),
      fileHeaders: () => ({}),
      liveStatus: () => "stale",
      ratePerMinute: 2,
    });
    const from = (ip: string) => app.request("/public", { headers: { "x-forwarded-for": ip } });
    assert.equal((await from("1.1.1.1")).status, 200);
    assert.equal((await from("1.1.1.1")).status, 200);
    const third = await from("1.1.1.1");
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("access-control-allow-origin"), "*");
    assert.equal((await from("2.2.2.2")).status, 200);
  });
});

for (const tb of testBackends()) describe(`public Concepts and nodes (${tb.name})`, { skip: tb.skip }, () => {
  let b: GraphBackend;
  let dir: string;
  before(async () => {
    b = await tb.open();
  });
  after(async () => {
    await tb.close(b);
  });
  beforeEach(async () => {
    await tb.wipe(b);
    await seedStrutDomain(b);
    await seedConceptSchema(b);
    dir = await mkdtemp(join(tmpdir(), "strut-public-graph-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const concept = async (name: string, parent?: string, docs?: string) => {
    const ref = (await b.nodes.write({ type: "Concept", data: { name, description: `About ${name}`, ...(docs ? { docs } : {}) } })).ref_id;
    if (parent) await b.edges.write({ edge: "PARENT_OF", source_ref_id: parent, target_ref_id: ref });
    return ref;
  };

  it("a public root shows its subtree live; a page outside it, and a node no public run named, are not there", async () => {
    const store = new MemoryRunStore();
    const strut = await createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), graph: b, store, serveUi: false, scheduler: false, concepts: false, views: false });
    const kitchen = await concept("Kitchen");
    const cooking = await concept("Cooking", kitchen, "Plan on Sundays.");
    const secret = await concept("Secret");
    await strut.app.request("/public-view", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ concepts: ["Kitchen"] }) });

    const listing = (await (await strut.app.request("/public")).json()) as { concepts: Array<{ name: string; pages: number }> };
    assert.deepEqual(listing.concepts, [{ name: "Kitchen", description: "About Kitchen", pages: 2 }]);
    const tree = (await (await strut.app.request("/public/concepts")).json()) as { concepts: Array<{ name: string; parent?: string; root: string }> };
    assert.deepEqual(tree.concepts.map((c) => [c.name, c.parent ?? null, c.root]), [["Kitchen", null, "Kitchen"], ["Cooking", "Kitchen", "Kitchen"]]);
    const page = (await (await strut.app.request("/public/concepts/Cooking")).json()) as { parent: string; properties: { docs: string } };
    assert.equal(page.parent, "Kitchen");
    assert.equal(page.properties.docs, "Plan on Sundays.");
    assert.deepEqual(((await (await strut.app.request("/public/concepts/Kitchen")).json()) as { children: Array<{ name: string }> }).children.map((c) => c.name), ["Cooking"]);
    assert.equal((await strut.app.request("/public/concepts/Secret")).status, 404);
    assert.equal((await strut.app.request(`/public/graph/nodes/${cooking}`)).status, 200);
    assert.equal((await strut.app.request(`/public/graph/nodes/${secret}`)).status, 404);

    // A public workflow's run that READ the secret page makes it visible.
    const res = await runWorkflow(
      { name: "peek", input: z.any(), steps: [{ id: "get", type: "graph/graph-get", config: { ref_id: secret } }] },
      {},
      await createRegistry([]),
      { store, services: strut.services },
    );
    assert.equal(res.status, "success", JSON.stringify(res.error));
    await strut.workspace.createWorkflow("peek", "name: peek\nsteps:\n  - id: get\n    type: log\n    config:\n      message: hi\n");
    await strut.app.request("/public-view", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ concepts: ["Kitchen"], workflows: [{ name: "peek" }] }) });
    assert.equal((await strut.app.request(`/public/graph/nodes/${secret}`)).status, 404, "a workflow without its runs makes nothing visible");
    await strut.app.request("/public-view", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ concepts: ["Kitchen"], workflows: [{ name: "peek", runs: true }] }) });
    assert.equal((await strut.app.request(`/public/graph/nodes/${secret}`)).status, 200);

    // A run after the index was built reaches it through the run-event hook.
    const later = await concept("Later");
    assert.equal((await strut.app.request(`/public/graph/nodes/${later}`)).status, 404);
    const again = await runWorkflow(
      { name: "peek", input: z.any(), steps: [{ id: "get", type: "graph/graph-get", config: { ref_id: later } }] },
      {},
      await createRegistry([]),
      { store, services: strut.services },
    );
    assert.equal(again.status, "success", JSON.stringify(again.error));
    assert.equal((await strut.app.request(`/public/graph/nodes/${later}`)).status, 200);
    await strut.close();
  });

  it("a page created under a public root is public at the next read", async () => {
    const kitchen = await concept("Kitchen");
    const surface = createPublicSurface({ dataDir: dir, store: new MemoryRunStore(), graph: { reader: b.reader, schemas: b.schemas }, treeTtlMs: 0 });
    await surface.set(normalizeSurface({ concepts: ["Kitchen"] }));
    assert.deepEqual((await surface.conceptTree()).concepts.map((c) => c.name), ["Kitchen"]);
    const baking = await concept("Baking", kitchen);
    assert.deepEqual((await surface.conceptTree()).concepts.map((c) => c.name), ["Kitchen", "Baking"]);
    assert.equal(await surface.visible(baking, "Concept"), true);
    const view = surface.reader()!;
    assert.equal((await view.getNode(baking))?.ref_id, baking);
  });
});

describe("a public app, for a visitor (plans/public-surface.md §5)", () => {
  const KEY = "public-app-key";
  const auth = { authorization: `Bearer ${KEY}` };
  let kit: KitLocation;
  let root: string;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let saved: string | undefined;
  let runId: string;
  const store = new MemoryRunStore();

  const score = defineStep({
    type: "score",
    input: z.object({ value: z.number() }),
    output: z.any(),
    async run(cfg) {
      return { score: cfg.value * 2 };
    },
  });
  const peek = defineStep({ type: "demo/read", effect: "read", input: z.object({}), output: z.any(), async run(_cfg, ctx) {
    return { app: ctx.app ?? null, actor: ctx.actor ?? null };
  } });
  const shellOut = defineStep({ type: "demo/shell", input: z.object({}), output: z.any(), async run(_cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.services.shell) throw new Error("no shell here");
    return ctx.services.shell.run({ cmd: "true" });
  } });

  const rpc = async (path: string, method: string, params: unknown, headers: Record<string, string> = {}) => {
    const res = await strut.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  };
  const call = async (args: Record<string, unknown>, path = "/public/mcp", headers: Record<string, string> = {}) => {
    const r = await rpc(path, "tools/call", { name: STEP_RUN_TOOL, arguments: args }, headers);
    const body = JSON.parse(r.result.content[0].text) as { error?: string };
    return { error: r.result.isError ? body.error : undefined, result: r.result.isError ? undefined : body };
  };
  const putView = (body: unknown) => strut.app.request("/public-view", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-public-app-"));
    const registry = await createRegistry([score, peek, shellOut]);
    const workspace = new WorkspaceManager(join(root, "ws"));
    strut = await createStrut({
      workspace, store, registry, kit, scheduler: false, serveUi: false, views: false,
      job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false,
    });
    await workspace.publishWorkflowByContent("score-wf", `name: score-wf\ninput:\n  value: { type: number }\nsteps:\n  - id: s\n    type: score\n    config: { value: "{{ input.value }}" }\n`);
    await workspace.publishWorkflowByContent("other-wf", `name: other-wf\nsteps:\n  - id: s\n    type: score\n    config: { value: 1 }\n`);
    await workspace.publishWorkflowByContent(
      "read-law",
      `name: read-law\nparams:\n  concept: Law\nsteps:\n  - id: c\n    type: context/concept\n    config: { name: "{{ params.concept }}", tool: "" }\n  - id: k\n    type: context/concept\n    config: { name: "{{ input.kind }}", tool: "" }\n`,
    );
    const res = await runWorkflow(await workspace.getWorkflow("score-wf"), { value: 3 }, registry, { store, actor: "tom-1" });
    assert.equal(res.status, "success");
    runId = res.runId;
    const dir = join(root, "apps", "bench");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Bench\ngrants:\n  workflows: [score-wf, other-wf, read-law]\n  steps: [demo/read, demo/shell, graph/graph-get, run/launch]\npermissions: [fullscreen, geolocation]\n");
    await writeFile(join(dir, "src", "App.tsx"), 'export default function App() { return <p className="p-2">hi</p>; }\n');
    const r = await strut.apps.publish(dir, "bench", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
    await rm(root, { recursive: true, force: true });
  });

  it("the dialog's cascade: an app brings its workflows with runs, its reads, and the Concept roots its workflows read", async () => {
    const res = await strut.app.request("/public-view/needs?app=bench", { headers: auth });
    assert.equal(res.status, 200);
    const needs = (await res.json()) as PublicViewNeeds;
    assert.deepEqual(needs.workflows.map((w) => [w.name, w.runs, w.checked]), [["score-wf", true, true], ["other-wf", true, true], ["read-law", true, true]]);
    assert.deepEqual(needs.reads.map((r) => [r.name, r.checked]), [["demo/read", true], ["demo/shell", false]]);
    assert.deepEqual(needs.concepts.map((x) => [x.name, x.missing ?? false, x.from]), [["Law", true, ["read-law"]]]);
    assert.deepEqual(needs.perRun, ["read-law: a Concept named per run ({{ input.kind }})"]);
    const wf = (await (await strut.app.request("/public-view/needs?workflow=score-wf", { headers: auth })).json()) as PublicViewNeeds;
    assert.deepEqual(wf.workflows.map((w) => [w.name, w.runs]), [["score-wf", false]], "a workflow alone: its runs only on purpose");
    assert.equal((await strut.app.request("/public-view/needs?app=bench")).status, 401);
  });

  it("not in the public view: no page, no door", async () => {
    assert.equal((await strut.app.request("/public/apps/bench")).status, 404);
    assert.equal((await strut.app.request("/public/apps/bench/document")).status, 404);
    const r = await call({ type: "demo/read", config: {}, app: publicAppIdentity("bench", "v1") });
    assert.match(r.error!, /not in this strut server's public view/);
  });

  it("in it: the app is held, served with the visitor's identity, and its page may read what the public view opens — nothing else", async () => {
    const put = (await (await putView({ apps: [{ name: "bench", reads: ["demo/read", "demo/shell"] }], workflows: [{ name: "score-wf", runs: true }] })).json()) as { held?: Array<{ app: string; version?: string; release?: string }> };
    assert.equal(put.held?.[0]?.app, "bench");
    assert.equal(put.held?.[0]?.version, "v1");
    assert.deepEqual(await (await strut.app.request("/public/apps")).json(), [{ name: "bench", version: "v1", title: "Bench", permissions: ["geolocation"] }], "with what its frame is granted beyond every app's, for the visitor's host");

    const doc = await strut.app.request("/public/apps/bench/document");
    assert.equal(doc.status, 200);
    const html = await doc.text();
    assert.match(html, /<meta name="strut-public-view" content="1">/);
    const identity = html.match(/<meta name="strut-app-token" content="([^"]+)">/)![1]!.replace(/&amp;/g, "&");
    assert.deepEqual(publicAppOfIdentity(identity), { name: "bench", version: "v1" });
    assert.equal(appOfIdentity(identity), undefined, "the visitor's identity opens no private door");
    assert.equal(publicAppOfIdentity(appIdentity("bench", "v1")), undefined, "nor the private one this door");

    const listed = await call({ type: "run/list", config: { workflow: "score-wf" }, app: identity });
    assert.equal(listed.error, undefined, listed.error);
    const runs = listed.result as unknown as Array<Record<string, unknown>>;
    assert.equal(runs[0]!["runId"], runId);
    assert.equal(runs[0]!["actor"], undefined);
    const events = await call({ type: "run/events", config: { workflow: "score-wf", runId }, app: identity });
    assert.ok(!JSON.stringify(events.result).includes("tom-1"), "no actor in a visitor's events");
    assert.deepEqual((await call({ type: "demo/read", config: {}, app: identity })).result, { app: { name: "bench", version: "v1" }, actor: null });

    assert.match((await call({ type: "run/launch", config: { workflow: "score-wf" }, app: identity })).error!, /not open to visitors to run/);
    assert.match((await call({ type: "run/list", config: { workflow: "other-wf" }, app: identity })).error!, /workflow "other-wf" is not in the public view/);
    assert.match((await call({ type: "app/state", config: {}, app: identity })).error!, /nothing is kept for a visitor/);
    assert.match((await call({ type: "demo/shell", config: {}, app: identity })).error!, /no shell here/, "a ticked read runs with reads alone");
    assert.match((await call({ type: "demo/read", config: {}, app: appIdentity("bench", "v1") })).error!, /not a valid app identity/);
    assert.match((await call({ type: "demo/read", config: {}, app: identity }, "/mcp", auth)).error!, /not a valid app identity/);
  });

  it("a later publish is a draft: the public view keeps serving the release it held", async () => {
    const dir = join(root, "apps", "bench");
    await writeFile(join(dir, "src", "App.tsx"), 'export default function App() { return <p className="p-2">hi again</p>; }\n');
    const r = await strut.apps.publish(dir, "bench", { surface: "ai" });
    assert.ok(r.ok && r.version === "v2" && r.live === false, JSON.stringify(r));
    assert.equal(((await (await strut.app.request("/public/apps/bench")).json()) as { version: string }).version, "v1");
    assert.match((await call({ type: "demo/read", config: {}, app: publicAppIdentity("bench", "v2") })).error!, /not the version in the public view \(v1\)/);
  });
});

describe("the visible-refs index", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-public-idx-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ev = (runId: string, type: string, refs: string[] = []): RunEvent =>
    ({ ts: new Date().toISOString(), runId, path: "w", type, ...(refs.length ? { nodes: refs.map((ref_id) => ({ ref_id })) } : {}) }) as RunEvent;
  const counting = (store: MemoryRunStore) => {
    const c = { reads: 0 };
    return {
      c,
      store: {
        listRuns: (w: string) => store.listRuns(w),
        getRunSummary: (w: string, r: string) => store.getRunSummary(w, r),
        getRunEvents: (w: string, r: string) => {
          c.reads++;
          return store.getRunEvents(w, r);
        },
      },
    };
  };

  it("finished runs: found, and a miss scans no logs", async () => {
    const store = new MemoryRunStore();
    await store.append("w", "r1", ev("r1", "step.end", ["a"]));
    await store.finalize("w", "r1", { status: "success" } as never);
    const { c, store: s } = counting(store);
    const surface = createPublicSurface({ dataDir: dir, store: s });
    await surface.set(normalizeSurface({ workflows: [{ name: "w", runs: true }] }));
    assert.equal(await surface.visible("a", undefined), true);
    const reads = c.reads;
    assert.equal(await surface.visible("nope", undefined), false);
    assert.equal(await surface.visible("nope", undefined), false);
    assert.equal(c.reads, reads);
  });

  it("in-flight runs: nodes appear as steps end, with no log re-read", async () => {
    const store = new MemoryRunStore();
    await store.append("w", "r1", ev("r1", "run.start"));
    const { c, store: s } = counting(store);
    const surface = createPublicSurface({ dataDir: dir, store: s });
    await surface.set(normalizeSurface({ workflows: [{ name: "w", runs: true }] }));
    assert.equal(await surface.visible("x", undefined), false);
    const reads = c.reads;
    surface.noteEvent("w", ev("r1", "step.end", ["x"]));
    assert.equal(await surface.visible("x", undefined), true);
    assert.equal(c.reads, reads);
  });

  it("built while a run is going: what it reported before keeps visible after it ends, and after a restart", async () => {
    const store = new MemoryRunStore();
    await store.append("w", "r1", ev("r1", "run.start"));
    await store.append("w", "r1", ev("r1", "step.end", ["a"]));
    const first = createPublicSurface({ dataDir: dir, store });
    await first.set(normalizeSurface({ workflows: [{ name: "w", runs: true }] }));
    assert.equal(await first.visible("a", undefined), true);
    for (const e of [ev("r1", "step.end", ["b"]), ev("r1", "run.end")]) {
      await store.append("w", "r1", e);
      first.noteEvent("w", e);
    }
    await store.finalize("w", "r1", { status: "success" } as never);
    assert.deepEqual([...(await first.runNodes("w", "r1"))].sort(), ["a", "b"]);
    const second = createPublicSurface({ dataDir: dir, store });
    assert.equal(await second.visible("a", undefined), true);
    assert.equal(await second.visible("b", undefined), true);
  });

  it("deleted runs and a workflow with runs turned off lose their refs", async () => {
    const store = new MemoryRunStore();
    await store.append("w", "r1", ev("r1", "step.end", ["a"]));
    const surface = createPublicSurface({ dataDir: dir, store });
    await surface.set(normalizeSurface({ workflows: [{ name: "w", runs: true }] }));
    assert.equal(await surface.visible("a", undefined), true);
    await store.deleteRuns("w");
    surface.forgetRuns("w");
    assert.equal(await surface.visible("a", undefined), false);
    await store.append("w", "r2", ev("r2", "step.end", ["b"]));
    surface.noteEvent("w", ev("r2", "step.end", ["b"]));
    assert.equal(await surface.visible("b", undefined), true);
    await surface.set(normalizeSurface({ workflows: [{ name: "w" }] }));
    assert.equal(await surface.visible("b", undefined), false);
  });

  it("a non-public workflow's runs make nothing visible, events included", async () => {
    const store = new MemoryRunStore();
    await store.append("p", "r1", ev("r1", "step.end", ["a"]));
    const surface = createPublicSurface({ dataDir: dir, store });
    await surface.set(normalizeSurface({ workflows: [{ name: "w", runs: true }] }));
    assert.equal(await surface.visible("a", undefined), false);
    surface.noteEvent("p", ev("r1", "step.end", ["z"]));
    assert.equal(await surface.visible("z", undefined), false);
  });

  it("restart: a new instance rebuilds from the persisted sets and the logs", async () => {
    const store = new MemoryRunStore();
    await store.append("w", "r1", ev("r1", "step.end", ["a"]));
    await store.finalize("w", "r1", { status: "success" } as never);
    await store.append("w", "r2", ev("r2", "step.end", ["live"]));
    const first = createPublicSurface({ dataDir: dir, store });
    await first.set(normalizeSurface({ workflows: [{ name: "w", runs: true }] }));
    assert.equal(await first.visible("a", undefined), true);
    const { c, store: s } = counting(store);
    const second = createPublicSurface({ dataDir: dir, store: s });
    assert.equal(await second.visible("a", undefined), true);
    assert.equal(await second.visible("live", undefined), true);
    assert.equal(c.reads, 1, "only the in-flight run's log is read; the finished set came from the file");
  });
});
