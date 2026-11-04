import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, withMessages, type RunEvent } from "./core.js";
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
      strut.app.request("/public", { method: "PUT", headers, body: JSON.stringify(body) });
    return { strut, store, runId: res.runId, put };
  };

  it("an empty surface answers anyone with nothing, and every other route still needs the key", async () => {
    const { strut } = await boot();
    const res = await strut.app.request("/public");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workflows: [], steps: [], concepts: [], types: [], apps: [] });
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
    assert.equal((await strut.app.request("/public/workflows/demo/run", { method: "POST" })).status, 401);
    assert.equal((await strut.app.request("/public", { method: "DELETE" })).status, 401);
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
    await strut.app.request("/public", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ concepts: ["Kitchen"] }) });

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
    await strut.app.request("/public", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ concepts: ["Kitchen"], workflows: [{ name: "peek" }] }) });
    assert.equal((await strut.app.request(`/public/graph/nodes/${secret}`)).status, 404, "a workflow without its runs makes nothing visible");
    await strut.app.request("/public", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ concepts: ["Kitchen"], workflows: [{ name: "peek", runs: true }] }) });
    assert.equal((await strut.app.request(`/public/graph/nodes/${secret}`)).status, 200);
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
