import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createStrut, type Strut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, type StepContext, type StepRegistry } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { FileWorkspaceStore } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { appIdentity, appOfIdentity, fileToken } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";
import { testBackends } from "../graph/test-util.js";
import type { GraphBackend } from "../graph/backend.js";
import type { KitLocation } from "./kit.js";
import { buildTools } from "../ai/tools.js";
import { APP_TOOL_META, STEP_RUN_TOOL, buildAppTools, grantRefusal, keptFromApp } from "./tools.js";
import { parseManifest } from "./manifest.js";

/**
 * The app door (plans/apps.md §5, §7.2, §9): `step_run` under an app's
 * grants — refused outside them, on a run/* call to an ungranted workflow,
 * on a graph write to an undeclared type (an edit by ref_id of a Concept
 * among them), on llm whatever the manifest says, on a params widening, on
 * a missing or foreign token; `run/launch { key }` returning the in-flight
 * run; a run launched through it seeing `ctx.app`; writes kept under
 * `step:<type>` with the actor and the app on their summary, reads not,
 * `app/report-error` kept and read back by `app/get`; the tool listed
 * app-only on both MCP doors. Then the builder's own app tools and editor.
 */

const KEY = "apps-door-key";
const auth = { authorization: `Bearer ${KEY}`, "x-strut-actor": "viewer" };

const score = defineStep({
  type: "score",
  input: z.object({ value: z.number() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    await ctx.services.artifacts?.write(ctx.runId, "report.txt", `score ${cfg.value * 2}`);
    return { score: cfg.value * 2 };
  },
});
const nap = defineStep({
  type: "nap",
  input: z.object({ ms: z.number() }),
  output: z.any(),
  async run(cfg) {
    await new Promise((r) => setTimeout(r, cfg.ms));
    return { slept: cfg.ms };
  },
});
const whoami = defineStep({
  type: "whoami",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    return { app: ctx.app ?? null, actor: ctx.actor ?? null, principal: ctx.principal ?? null };
  },
});
const big = defineStep({
  type: "big",
  input: z.object({}),
  output: z.any(),
  async run() {
    return { blob: "x".repeat(6 * 1024 * 1024) };
  },
});

const WORKFLOWS: Record<string, string> = {
  "score-wf": `name: score-wf\ninput:\n  value: { type: number }\nsteps:\n  - id: s\n    type: score\n    config: { value: "{{ input.value }}" }\n  - id: out\n    type: pack\n    config:\n      score: "{{ s.score }}"\n      artifacts: [{ id: report, title: Report, path: report.txt }]\n`,
  // Two steps: a cancel is cooperative and lands at the boundary between them.
  "slow-wf": `name: slow-wf\nsteps:\n  - id: n1\n    type: nap\n    config: { ms: 700 }\n  - id: n2\n    type: nap\n    config: { ms: 700 }\n`,
  "echo-app": `name: echo-app\nsteps:\n  - id: w\n    type: whoami\n`,
  agentish: `name: agentish\nparams:\n  tools: []\nsteps:\n  - id: a\n    type: agent\n    config:\n      prompt: hi\n      agentTools: "{{ params.tools }}"\n`,
  "grader-run": `name: grader-run\nsealed: true\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n`,
};

const MANIFESTS: Record<string, string> = {
  bench: [
    "title: Bench",
    "grants:",
    "  workflows: [score-wf, slow-wf, echo-app, agentish, grader-run]",
    "  steps: [graph/*, app/get, whoami, big, run/launch]",
    "data:",
    "  graph:",
    "    types:",
    "      Concept: { name: string, description: string?, docs: string? }",
    "",
  ].join("\n"),
  strict: "title: Strict\ngrants:\n  workflows: [score-wf]\n",
  nodes: "title: Nodes\ngrants:\n  steps: [graph/*]\n",
  paid: "title: Paid\ngrants:\n  steps: [llm, exec, agent, acp/prompt, meta/*, sqlite/*, automation/*, job/start, app/publish]\n",
};
const APP_TSX = 'export default function App() { return <p className="p-2">hi</p>; }\n';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse the first `data:` line of a stateless door's SSE answer. */
const sseResult = (text: string): any => {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : undefined;
};

describe("step_run — the app door", () => {
  let kit: KitLocation;
  let root: string;
  let dataDir: string;
  let strut: Strut;
  let registry: StepRegistry;
  const store = new MemoryRunStore();
  const backend = testBackends()[0]!;
  let graph: GraphBackend | undefined;
  let conceptRef: string | undefined;
  let savedKey: string | undefined;
  let tools: ReturnType<typeof buildAppTools>;
  let identity: string;

  const call = async (args: Record<string, unknown>) =>
    (await (tools[STEP_RUN_TOOL] as any).execute(args, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
  const ok = async (args: Record<string, unknown>) => {
    const r = await call(args);
    assert.equal(r.error, undefined, r.error);
    return r.result;
  };
  const refused = async (args: Record<string, unknown>, re: RegExp) => {
    const r = await call(args);
    assert.ok(r.error, `expected a refusal, got ${String(JSON.stringify(r.result)).slice(0, 200)}`);
    assert.match(r.error, re);
  };
  const rpc = async (path: string, method: string, params: unknown) => {
    const res = await strut.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return sseResult(text);
  };

  before(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-app-door-"));
    dataDir = join(root, "ws");
    if (!backend.skip) {
      graph = await backend.open();
      const written = await graph.nodes.write({ type: "Concept", data: { name: "Job", description: "the job page" } }, "create", { namespace: "default" });
      conceptRef = written.ref_id;
    }
    registry = await createRegistry([score, nap, whoami, big]);
    const workspace = new FileWorkspaceStore(dataDir);
    strut = await createStrut({
      workspace,
      store,
      registry,
      kit,
      ...(graph ? { graph } : {}),
      scheduler: false,
      enableChat: true,
      serveUi: false,
      job: false,
      orchestrator: false,
      builder: false,
      browserWorkflows: false,
    });
    for (const [name, yaml] of Object.entries(WORKFLOWS)) await workspace.publishWorkflowByContent(name, yaml);
    for (const [name, manifest] of Object.entries(MANIFESTS)) {
      const dir = join(root, "apps", name);
      for (const [rel, text] of Object.entries({ "app.yaml": manifest, "src/App.tsx": APP_TSX })) {
        await mkdir(join(dir, dirname(rel)), { recursive: true });
        await writeFile(join(dir, rel), text, "utf8");
      }
      const r = await strut.apps.publish(dir, name, { surface: "person" });
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    }
    tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, actor: "viewer", runStepDeps: { store, workspace } });
    identity = appIdentity("bench", "v1");
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (graph) await backend.close(graph);
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(root, { recursive: true, force: true });
  });

  it("the identity: the scope and its token; a missing, foreign, forged or unsigned token opens nothing", async () => {
    assert.equal(identity, `app:bench@v1.${fileToken({ kind: "app", id: "bench@v1" })}`);
    assert.deepEqual(appOfIdentity(identity), { name: "bench", version: "v1" });
    assert.equal(appOfIdentity(fileToken({ kind: "run", id: "1" })), undefined, "a run's file token");
    assert.equal(appOfIdentity(`app:bench@v1.${fileToken({ kind: "app", id: "other@v1" })}`), undefined, "another app's token on this scope");
    assert.equal(appOfIdentity("app:bench@v1."), undefined, "unsigned, on a strut that signs");
    assert.equal(appOfIdentity("app:bench@v2." + fileToken({ kind: "app", id: "bench@v1" })), undefined, "another version");
    await refused({ type: "run/list", config: { workflow: "score-wf" } }, /not a valid app identity/);
    await refused({ type: "run/list", config: { workflow: "score-wf" }, app: "nope" }, /not a valid app identity/);
    await refused({ type: "run/list", config: { workflow: "score-wf" }, app: appIdentity("ghost", "v1") }, /no app ghost@v1/);
  });

  it("refuses: a step outside grants.steps, run/* on an ungranted workflow, a sealed workflow, llm whatever the manifest says, a family not here yet, a params widening", async () => {
    const strict = appIdentity("strict", "v1");
    await refused({ type: "run/list", config: { workflow: "slow-wf" }, app: strict }, /workflow "slow-wf" is not granted .* grants\.workflows: score-wf/);
    await refused({ type: "run/list", config: {}, app: strict }, /needs `workflow`/);
    await refused({ type: "graph/graph-get", config: { ref_id: "x" }, app: strict }, /not granted .* grants\.steps: \(none\)/);
    await refused({ type: "whoami", config: {}, app: strict }, /not granted/);
    await refused({ type: "run/list", config: { workflow: "grader-run" }, app: identity }, /sealed/);
    const paid = appIdentity("paid", "v1");
    for (const type of ["llm", "exec", "agent", "acp/prompt"]) await refused({ type, config: {}, app: paid }, /paid or shell-shaped/);
    await refused({ type: "meta/run-workflow", config: {}, app: paid }, /sealed/);
    await refused({ type: "sqlite/query", config: { sql: "select 1" }, app: paid }, /not available in this strut yet: .*work item 3/);
    await refused({ type: "automation/list", config: {}, app: paid }, /not available in this strut yet: .*work item 7/);
    await refused({ type: "job/start", config: {}, app: paid }, /work item 2/);
    await refused({ type: "app/publish", config: {}, app: paid }, /does not author apps/);
    await refused({ type: "run/list", config: { workflow: "score-wf", job: "j" }, app: identity }, /work item 2/);
    await refused({ type: "run/launch", config: { workflow: "agentish", params: { tools: ["app/list"] } }, app: identity }, /params may not grant/);
    await refused({ type: "nope/step", config: {}, app: identity }, /not granted/);
    // The pure check, on a manifest alone.
    const m = parseManifest("title: T\ngrants: { steps: ['graph/*'] }\n");
    assert.ok(m.ok);
    assert.equal(grantRefusal("graph/graph-search", {}, m.manifest, registry), null);
    assert.match(grantRefusal("app/get", {}, m.manifest, registry)!, /not granted/);
    assert.equal(grantRefusal("app/report-error", {}, m.manifest, registry), null, "always granted");
    assert.ok(keptFromApp("graph/edit-node") && keptFromApp("app/report-error") && !keptFromApp("run/list") && !keptFromApp("graph/graph-get"));
  });

  it("runs a granted step as the viewer, whole results; a result past 5 MB is an error naming the cap", async () => {
    const me = await ok({ type: "whoami", config: {}, app: identity });
    assert.deepEqual(me, { app: { name: "bench", version: "v1" }, actor: "viewer", principal: "viewer" });
    await refused({ type: "big", config: {}, app: identity }, /over the 5 MB cap/);
    assert.deepEqual(await store.listRuns("step:whoami"), [], "a read is not kept");
  });

  it("run/launch { key } returns the in-flight run and launches nothing; run/get { wait } holds; a launched run carries origin app and ctx.app", async () => {
    const first = await ok({ type: "run/launch", config: { workflow: "slow-wf", key: "k1" }, app: identity });
    assert.ok(first.runId && !first.existing);
    const again = await ok({ type: "run/launch", config: { workflow: "slow-wf", key: "k1" }, app: identity });
    assert.deepEqual(again, { runId: first.runId, existing: true });
    const live = await ok({ type: "run/get", config: { workflow: "slow-wf", runId: first.runId }, app: identity });
    assert.equal(live.partial, true, JSON.stringify(live).slice(0, 200));
    assert.equal(live.status, "running");
    const done = await ok({ type: "run/get", config: { workflow: "slow-wf", runId: first.runId, wait: 10_000 }, app: identity });
    assert.equal(done.status, "success");
    assert.equal(done.origin, "app");
    assert.deepEqual(done.app, { name: "bench", version: "v1" });
    assert.equal(done.actor, "viewer");
    assert.deepEqual(done.artifacts, []);
    assert.deepEqual(await store.listRuns("slow-wf"), [first.runId], "one run");
    // The key is free once its run ended.
    const third = await ok({ type: "run/launch", config: { workflow: "slow-wf", key: "k1" }, app: identity });
    assert.notEqual(third.runId, first.runId);
    assert.equal(third.existing, undefined);

    // ctx.app inside the launched run's steps.
    const echo = await ok({ type: "run/launch", config: { workflow: "echo-app" }, app: identity });
    const read = await ok({ type: "run/get", config: { workflow: "echo-app", runId: echo.runId, wait: 10_000 }, app: identity });
    assert.deepEqual(read.output, { app: { name: "bench", version: "v1" }, actor: "viewer", principal: "viewer" });
    const start = (await store.getRunEvents("echo-app", echo.runId)).find((e) => e.type === "run.start")!;
    assert.deepEqual([start.origin, start.app, start.actor], ["app", { name: "bench", version: "v1" }, "viewer"]);

    // run/list, run/events, run/workflow, run/files, run/cancel.
    const launched = await ok({ type: "run/launch", config: { workflow: "score-wf", input: { value: 21 } }, app: identity });
    const got = await ok({ type: "run/get", config: { workflow: "score-wf", runId: launched.runId, wait: 10_000 }, app: identity });
    assert.equal(got.output.score, 42);
    assert.equal(got.artifacts[0]?.url, `/artifacts/${launched.runId}/report.txt`);
    const list = await ok({ type: "run/list", config: { workflow: "score-wf" }, app: identity });
    assert.equal(list[0].runId, launched.runId);
    assert.equal("output" in list[0], false, "a list row has no payloads");
    assert.equal(list[0].artifacts[0].id, "report");
    const events = await ok({ type: "run/events", config: { workflow: "score-wf", runId: launched.runId, skip: 1 }, app: identity });
    assert.equal(events[0].type, "step.start");
    assert.equal(events.at(-1).type, "run.end");
    const info = await ok({ type: "run/workflow", config: { workflow: "score-wf" }, app: identity });
    assert.deepEqual([info.name, info.activeVersion, info.input.value.type], ["score-wf", "v1", "number"]);
    const file = await ok({ type: "run/files", config: { workflow: "score-wf", runId: launched.runId, path: "report.txt" }, app: identity });
    assert.deepEqual([file.text, file.mediaType, file.bytes], ["score 42", "text/plain", 8]);
    await refused({ type: "run/files", config: { workflow: "score-wf", runId: launched.runId, path: "../elsewhere" }, app: identity }, /escapes/);
    const toCancel = await ok({ type: "run/launch", config: { workflow: "slow-wf" }, app: identity });
    const cancelled = await ok({ type: "run/cancel", config: { workflow: "slow-wf", runId: toCancel.runId }, app: identity });
    assert.equal(cancelled.ok, true);
    const after = await ok({ type: "run/get", config: { workflow: "slow-wf", runId: toCancel.runId, wait: 10_000 }, app: identity });
    assert.equal(after.status, "cancelled");
  });

  it("app/report-error is always granted and kept; app/get reads the app's errors back", async () => {
    const r = await ok({ type: "app/report-error", config: { message: "boom", stack: "at x" }, app: appIdentity("strict", "v1") });
    assert.equal(r.ok, true);
    const kept = await store.listRuns("step:app/report-error");
    assert.equal(kept.length, 1);
    const summary = (await store.getRunSummary("step:app/report-error", kept[0]!))!;
    assert.deepEqual([summary.actor, summary.app], ["viewer", { name: "strict", version: "v1" }]);
    const view = (await strut.apps.get("strict"))!;
    assert.equal(view.errors?.length, 1);
    assert.deepEqual([view.errors![0]!.message, view.errors![0]!.stack, view.errors![0]!.version, view.errors![0]!.actor, view.errors![0]!.runId], ["boom", "at x", "v1", "viewer", kept[0]]);
    assert.deepEqual((await strut.apps.get("bench"))!.errors, [], "another app's errors are its own");
    const http = await strut.app.request("/apps/strict", { headers: auth });
    assert.equal(((await http.json()) as { errors: unknown[] }).errors.length, 1, "on the route too");
  });

  it("a graph write is refused on an undeclared type — a create by type, an edit of a Concept by ref_id, a templated type, an edge by ref — and kept when it goes through", { skip: backend.skip }, async () => {
    const nodes = appIdentity("nodes", "v1");
    await refused({ type: "graph/create-node", config: { node_type: "Concept", node_data: { name: "X" } }, app: nodes }, /declares no graph types/);
    await refused({ type: "graph/edit-node", config: { ref_id: conceptRef, node_data: { description: "edited" } }, app: nodes }, /write on "Concept" is refused: this app declares no graph types/);
    await refused({ type: "graph/delete-node", config: { ref_id: conceptRef }, app: nodes }, /write on "Concept" is refused/);
    await refused({ type: "graph/edit-node", config: { ref_id: "no-such-node", node_data: {} }, app: nodes }, /no node no-such-node/);
    await refused({ type: "graph/create-node", config: { node_type: "{{ input.t }}", node_data: {} }, app: identity }, /literal value, not a template/);
    await refused({ type: "graph/delete-edge", config: { edge_ref_id: "e1" }, app: identity }, /locate the edge by its endpoints/);
    await refused({ type: "graph/create-schema", config: {}, app: identity }, /not a thing a page does/);
    // A declared type (bench declares Concept) goes through — and is kept.
    const made = await ok({ type: "graph/create-node", config: { node_type: "Concept", node_data: { name: "From the app", description: "written by bench" } }, app: identity });
    assert.equal(made.status, "Success", JSON.stringify(made));
    const kept = await store.listRuns("step:graph/create-node");
    assert.equal(kept.length, 1);
    const summary = (await store.getRunSummary("step:graph/create-node", kept[0]!))!;
    assert.deepEqual([summary.actor, summary.app, summary.status], ["viewer", { name: "bench", version: "v1" }, "success"]);
    const start = (await store.getRunEvents("step:graph/create-node", kept[0]!)).find((e) => e.type === "step.start")!;
    assert.equal((start.input as { node_type: string }).node_type, "Concept", "the statement is in the kept log");
    // A read of the graph is not.
    const read = await ok({ type: "graph/graph-get", config: { ref_id: made.ref_id }, app: identity });
    assert.equal(read.node_type, "Concept");
    assert.deepEqual(await store.listRuns("step:graph/graph-get"), []);
  });

  it("is listed app-only on both MCP doors and called through them as the connection's actor; a refusal is an error result", async () => {
    for (const door of ["/mcp", "/mcp/builder"]) {
      const listed = await rpc(door, "tools/list", {});
      const tool = listed.result.tools.find((t: { name: string }) => t.name === STEP_RUN_TOOL);
      assert.ok(tool, `${door} lists step_run`);
      assert.deepEqual(tool._meta, APP_TOOL_META[STEP_RUN_TOOL]);
      assert.deepEqual(tool._meta.ui.visibility, ["app"]);
      assert.deepEqual(tool.inputSchema.required, ["type", "app"]);
      assert.ok(listed.result.tools.every((t: { name: string; _meta?: unknown }) => t.name === STEP_RUN_TOOL || t._meta === undefined), "no other tool carries the flag");
    }
    const called = await rpc("/mcp", "tools/call", { name: STEP_RUN_TOOL, arguments: { type: "whoami", config: {}, app: identity } });
    assert.equal(called.result.isError, undefined, JSON.stringify(called));
    assert.deepEqual(called.result.structuredContent, { app: { name: "bench", version: "v1" }, actor: "viewer", principal: "viewer" });
    assert.deepEqual(JSON.parse(called.result.content[0].text), called.result.structuredContent);
    const list = await rpc("/mcp/builder", "tools/call", { name: STEP_RUN_TOOL, arguments: { type: "run/list", config: { workflow: "echo-app" }, app: identity } });
    assert.ok(Array.isArray(JSON.parse(list.result.content[0].text)), "an array result rides as text");
    const bad = await rpc("/mcp", "tools/call", { name: STEP_RUN_TOOL, arguments: { type: "whoami", config: {}, app: "forged" } });
    assert.equal(bad.result.isError, true);
    assert.match(JSON.parse(bad.result.content[0].text).error, /not a valid app identity/);
    const failed = await rpc("/mcp", "tools/call", { name: STEP_RUN_TOOL, arguments: { type: "run/get", config: { workflow: "score-wf", runId: "nope" }, app: identity } });
    assert.equal(failed.result.isError, true);
    assert.match(JSON.parse(failed.result.content[0].text).error, /not found/);
  });

  it("the builder gets the app/* steps as named tools and the editor, sandboxed to its data directory", async () => {
    const workspace = new FileWorkspaceStore(dataDir);
    const builder = buildTools({ workspace, registry, store, getRegistry: async () => registry, services: strut.services, dataDir, shell: { cwd: dataDir } });
    for (const name of ["app_list", "app_get", "app_init", "app_checkout", "app_build", "app_publish", "str_replace_based_edit_tool", "bash"]) assert.ok(builder[name], name);
    const run = async (name: string, input: unknown) => (await (builder[name] as any).execute(input, { toolCallId: "t", messages: [] })) as any;
    const made = await run("app_init", { path: "scratch/apps/mini" });
    assert.equal(made.path, join(dataDir, "scratch", "apps", "mini"), "an app path resolves against the data directory with no run");
    const viewed = await run("str_replace_based_edit_tool", { command: "view", path: "scratch/apps/mini/app.yaml" });
    assert.match(viewed, /title: New app/);
    const listed = await run("str_replace_based_edit_tool", { command: "view", path: "scratch/apps/mini" });
    assert.match(listed, /app\.yaml/);
    assert.match(await run("str_replace_based_edit_tool", { command: "view", path: "../../outside" }), /escapes the working directory/);
    const edited = await run("str_replace_based_edit_tool", { command: "str_replace", path: "scratch/apps/mini/app.yaml", old_str: "title: New app", new_str: "title: Mini" });
    assert.match(edited, /exactly one location/);
    const built = await run("app_build", { path: "scratch/apps/mini" });
    assert.equal(built.ok, true, JSON.stringify(built.errors));
    const published = await run("app_publish", { name: "mini", path: "scratch/apps/mini" });
    assert.deepEqual([published.ok, published.version], [true, "v1"]);
    assert.equal(((await run("app_get", { name: "mini" })) as { title?: string; manifest: { title: string } }).manifest.title, "Mini");
    // Without a shell there is no editor either; the app tools stay.
    const bare = buildTools({ workspace, registry, store, getRegistry: async () => registry, services: strut.services });
    assert.ok(bare["app_init"] && !bare["str_replace_based_edit_tool"] && !bare["bash"]);
  });

  it("the stateless door answers a bare request", async () => {
    // sanity for the helper: a bad method is an error, not a hang
    const res = await strut.app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nope/x", params: {} }) });
    assert.ok([200, 400, 404].includes(res.status));
    await sleep(0);
  });
});
