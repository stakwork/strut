import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createStrut, type Strut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, withMessages, type StepContext, type StepRegistry } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { FileWorkspaceStore } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { appIdentity, appOfIdentity, fileToken } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";
import { testBackends } from "../graph/test-util.js";
import type { GraphBackend } from "../graph/backend.js";
import type { KitLocation } from "./kit.js";
import { buildTools } from "../ai/tools.js";
import { APP_TOOL_META, STEP_RUN_TOOL, appJobId, buildAppTools, grantRefusal, keptFromApp, scopeAppJobs } from "./tools.js";
import { jobRoot, saveJobUpload } from "../jobs.js";
import { parseManifest } from "./manifest.js";
import type { AppUsage } from "./monitor.js";

/**
 * The app door (plans/apps.md §5, §7.2, §9): `step_run` under an app's
 * grants — refused outside them, on a run/* call to an ungranted workflow,
 * on a graph write to an undeclared type, or to one strut keeps for itself
 * (an edit by ref_id of a Concept among them), on llm whatever the manifest says, on a params widening, on
 * a missing or foreign token; `run/launch { key }` returning the in-flight
 * run; a run launched through it seeing `ctx.app`; writes kept under
 * `step:<type>` with the actor and the app on their summary, reads not,
 * `app/report-error` kept and read back by `app/get`; a page's jobs in the
 * app's namespace — its uploads, the runs it launches under them, a
 * non-holding read beside another, files on a launch; the tool listed
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
/** An agent stand-in: its session rides on its output, as the agent step's does. */
const talker = defineStep({
  type: "talker",
  input: z.object({ task: z.string() }),
  output: z.any(),
  async run(cfg) {
    return withMessages({ result: "said" }, [
      { role: "system", content: "you talk" },
      { role: "user", content: cfg.task },
      { role: "assistant", content: [{ type: "text", text: "said it" }] },
    ]);
  },
});
/** Reads one file of a folder a step handed it — a job's uploads/. */
const cat = defineStep({
  type: "cat",
  input: z.object({ dir: z.string(), file: z.string(), ms: z.number().default(0) }),
  output: z.any(),
  async run(cfg, ctx) {
    if (cfg.ms) await new Promise((r) => setTimeout(r, cfg.ms));
    return { text: await readFile(join(cfg.dir, cfg.file), "utf8"), job: ctx.job ?? null };
  },
});
const attached = defineStep({
  type: "attached",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    return { attachments: ctx.attachments ?? [] };
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
  "talk-wf": `name: talk-wf\nsteps:\n  - id: a\n    type: talker\n    config: { task: "say it" }\n`,
  agentish: `name: agentish\nparams:\n  tools: []\nsteps:\n  - id: a\n    type: agent\n    config:\n      prompt: hi\n      agentTools: "{{ params.tools }}"\n`,
  "grader-run": `name: grader-run\nsealed: true\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n`,
  // A job's uploads read by a run that holds the job's folder, and by one that does not.
  "read-upload": `name: read-upload\ninput:\n  file: { type: string }\nsteps:\n  - id: dir\n    type: job/dir\n    config: { hold: false }\n  - id: c\n    type: cat\n    config: { dir: "{{ dir.path }}", file: "{{ input.file }}", ms: 400 }\n`,
  "hold-upload": `name: hold-upload\ninput:\n  file: { type: string }\nsteps:\n  - id: dir\n    type: job/dir\n  - id: c\n    type: cat\n    config: { dir: "{{ dir.path }}", file: "{{ input.file }}", ms: 400 }\n`,
  "attach-wf": `name: attach-wf\nsteps:\n  - id: a\n    type: attached\n`,
};

const MANIFESTS: Record<string, string> = {
  bench: [
    "title: Bench",
    "grants:",
    "  workflows: [score-wf, slow-wf, echo-app, agentish, grader-run, talk-wf, read-upload, hold-upload, attach-wf]",
    "  steps: [graph/*, app/get, whoami, big, run/launch, job/upload, job/delete-upload, job/get, job/list, job/read]",
    "",
  ].join("\n"),
  strict: "title: Strict\ngrants:\n  workflows: [score-wf]\n",
  nodes: "title: Nodes\ngrants:\n  steps: [graph/*]\n",
  paid: "title: Paid\ngrants:\n  steps: [llm, exec, agent, acp/prompt, meta/*, sqlite/*, automation/*, job/start, app/publish, app/pin]\n",
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
    registry = await createRegistry([score, nap, whoami, talker, big, cat, attached]);
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
      browserWorkflows: false, privacyWorkflows: false,
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
    await refused({ type: "job/start", config: {}, app: paid }, /run\/launch \{ job \}.*an agent's door/);
    await refused({ type: "app/publish", config: {}, app: paid }, /does not author apps/);
    await refused({ type: "app/pin", config: { name: "paid" }, app: paid }, /the person's call/);
    // An app may filter a granted workflow's runs by job; it reads no job
    // past its grants. (Launching under its own jobs: the job test below.)
    assert.deepEqual(await ok({ type: "run/list", config: { workflow: "score-wf", job: "j" }, app: identity }), []);
    await refused({ type: "run/list", config: { job: "j" }, app: identity }, /needs `workflow`/);
    await refused({ type: "run/files", config: { job: "j", path: "x.md" }, app: identity }, /needs `workflow`/);
    await refused({ type: "run/launch", config: { workflow: "score-wf", job: "{{ input.j }}" }, app: identity }, /must be a literal job id/);
    await refused({ type: "run/launch", config: { workflow: "agentish", params: { tools: ["app/list"] } }, app: identity }, /params may not widen/);
    await refused({ type: "nope/step", config: {}, app: identity }, /not granted/);
    // The pure check, on a manifest alone.
    const m = parseManifest("title: T\ngrants: { steps: ['graph/*'] }\n");
    assert.ok(m.ok);
    assert.equal(grantRefusal("graph/graph-search", {}, m.manifest, registry), null);
    assert.match(grantRefusal("app/get", {}, m.manifest, registry)!, /not granted/);
    assert.equal(grantRefusal("app/report-error", {}, m.manifest, registry), null, "always granted");
    assert.ok(keptFromApp("graph/edit-node") && keptFromApp("app/report-error") && !keptFromApp("run/list") && !keptFromApp("graph/graph-get"));
  });

  it("a preview (app/look { path }): hosted under its label with no version recorded, served with its identity, calls checked against ITS manifest, uncounted", async () => {
    const dir = join(root, "apps", "draft-app");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Draft\ngrants:\n  steps: [whoami]\n", "utf8");
    await writeFile(join(dir, "src", "App.tsx"), APP_TSX, "utf8");
    const p = await strut.apps.preview(dir, "draft-app", { surface: "ai" });
    assert.ok(p.ok, p.ok ? "" : p.errors.join("\n"));
    assert.match(p.version, /^preview-[0-9a-f]{12}$/);
    assert.equal(await strut.workspace.getApp("draft-app"), null, "no version recorded");
    assert.deepEqual(strut.apps.previewOf("draft-app", p.version)?.manifest.grants.steps, ["whoami"]);
    assert.equal(strut.apps.previewOf("bench", p.version), null, "another app's name");

    // The file route hosts it where a version would be: the token minted, the identity written in.
    const listed = (await (await strut.app.request(`/apps/draft-app/${p.version}/files`, { headers: auth })).json()) as { token: string; hash: string; files: string[] };
    assert.equal(listed.hash, p.hash);
    assert.ok(listed.files.includes("dist/index.html"));
    const html = await (await strut.app.request(`/apps/draft-app/${p.version}/files/dist/index.html?t=${encodeURIComponent(listed.token)}`)).text();
    const previewId = appIdentity("draft-app", p.version);
    assert.ok(html.includes(`content="${previewId}"`));
    assert.deepEqual(appOfIdentity(previewId), { name: "draft-app", version: p.version });
    assert.equal((await strut.app.request(`/apps/draft-app/preview-000000000000/files`, { headers: auth })).status, 404);

    assert.deepEqual(await ok({ type: "whoami", config: {}, app: previewId }), { app: { name: "draft-app", version: p.version }, actor: "viewer", principal: "viewer" });
    await refused({ type: "big", config: {}, app: previewId }, /not granted/);
    await refused({ type: "whoami", config: {}, app: appIdentity("draft-app", "preview-000000000000") }, /no longer hosted/);
    assert.equal((await strut.app.request("/apps/draft-app/usage", { headers: auth })).status, 404, "counted nowhere");
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

  it("run/transcript reads an agent's session the log hands out as a link, on the workflow's grant", async () => {
    const launched = await ok({ type: "run/launch", config: { workflow: "talk-wf" }, app: identity });
    await ok({ type: "run/get", config: { workflow: "talk-wf", runId: launched.runId, wait: 10_000 }, app: identity });
    const events = await ok({ type: "run/events", config: { workflow: "talk-wf", runId: launched.runId }, app: identity });
    const end = events.find((e: any) => e.type === "step.end" && e.path === "talk-wf/a");
    assert.equal(end.messages, undefined, "the log never inlines a session");
    assert.equal(end.transcript, `/workflows/talk-wf/runs/${launched.runId}/transcripts/talk-wf/a`);
    const t = await ok({ type: "run/transcript", config: { workflow: "talk-wf", runId: launched.runId, path: "talk-wf/a" }, app: identity });
    assert.deepEqual(t, {
      path: "talk-wf/a",
      messages: [
        { role: "system", content: "you talk" },
        { role: "user", content: "say it" },
        { role: "assistant", content: [{ type: "text", text: "said it" }] },
      ],
    });
    await refused({ type: "run/transcript", config: { workflow: "talk-wf", runId: launched.runId, path: "talk-wf/nope" }, app: identity }, /No transcript at "talk-wf\/nope"/);
    await refused({ type: "run/transcript", config: { workflow: "talk-wf", runId: launched.runId, path: "talk-wf/a" }, app: appIdentity("strict", "v1") }, /workflow "talk-wf" is not granted/);
    await refused({ type: "run/transcript", config: { workflow: "grader-run", runId: "1", path: "grader-run/a" }, app: identity }, /sealed/);
  });

  it("a page's jobs are the app's: uploads into one, runs launched under it, a read beside a hold, files on a launch", async () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    // The namespace, pure: idempotent, and a page's job/list prefix can only narrow it.
    assert.equal(appJobId("bench", "library"), "app/bench/library");
    assert.equal(appJobId("bench", "app/bench/library"), "app/bench/library");
    assert.deepEqual(scopeAppJobs("bench", "job/list", {}), { prefix: "app/bench/" });
    assert.deepEqual(scopeAppJobs("bench", "job/list", { prefix: "lib" }), { prefix: "app/bench/lib" });
    assert.deepEqual(scopeAppJobs("bench", "graph/graph-get", { ref_id: "x" }), { ref_id: "x" });

    // An upload lands in the app's job, never over a file there, and is no kept run.
    const up = await ok({ type: "job/upload", config: { job: "library", name: "notes.txt", data: b64("hello") }, app: identity });
    assert.deepEqual(up, { job: "app/bench/library", path: "uploads/notes.txt", name: "notes.txt", mediaType: "text/plain", size: 5 });
    const again = await ok({ type: "job/upload", config: { job: "library", name: "notes.txt", data: `data:text/plain;base64,${b64("again")}` }, app: identity });
    assert.equal(again.path, "uploads/notes-2.txt");
    assert.equal(await readFile(join(jobRoot(dataDir, "app/bench/library"), "uploads/notes.txt"), "utf8"), "hello");
    assert.deepEqual(await store.listRuns("step:job/upload"), [], "the bytes are its input: never kept");
    await refused({ type: "job/upload", config: { job: "library", name: "x.bin", data: "not base64!" }, app: identity }, /not base64/);

    // The page sees only its own jobs, by the short id or the whole one.
    await saveJobUpload(jobRoot(dataDir, "elsewhere"), "elsewhere", { name: "secret.txt", bytes: Buffer.from("no") });
    const listed = await ok({ type: "job/list", config: {}, app: identity });
    assert.deepEqual(listed.jobs.map((j: { job: string }) => j.job), ["app/bench/library"]);
    assert.deepEqual((await ok({ type: "job/list", config: { prefix: "nope" }, app: identity })).jobs, []);
    const view = await ok({ type: "job/get", config: { job: "library" }, app: identity });
    assert.deepEqual(view.files, ["uploads/notes-2.txt", "uploads/notes.txt"]);
    assert.equal((await ok({ type: "job/get", config: { job: "app/bench/library" }, app: identity })).job, "app/bench/library");
    await refused({ type: "job/get", config: { job: "elsewhere" }, app: identity }, /No job "app\/bench\/elsewhere"/);
    await refused({ type: "job/read", config: { job: "elsewhere", path: "uploads/secret.txt" }, app: identity }, /No file/);

    // A run launched under the job reads the upload by its path. Two that do
    // not hold the folder run at once; two that do, one at a time.
    const readers = await Promise.all(
      [1, 2].map(() => ok({ type: "run/launch", config: { workflow: "read-upload", job: "library", input: { file: up.path } }, app: identity })),
    );
    const read = await Promise.all(readers.map((r) => ok({ type: "run/get", config: { workflow: "read-upload", runId: r.runId, wait: 10_000 }, app: identity })));
    assert.deepEqual(read.map((r) => [r.status, r.job, r.output?.text]), [
      ["success", "app/bench/library", "hello"],
      ["success", "app/bench/library", "hello"],
    ]);
    const holders = await Promise.all(
      [1, 2].map(() => ok({ type: "run/launch", config: { workflow: "hold-upload", job: "library", input: { file: up.path } }, app: identity })),
    );
    const held = await Promise.all(holders.map((r) => ok({ type: "run/get", config: { workflow: "hold-upload", runId: r.runId, wait: 10_000 }, app: identity })));
    assert.deepEqual(held.map((r) => r.status).sort(), ["error", "success"]);
    assert.match(held.find((r) => r.status === "error")!.error.message, /job_busy:/);

    // Deleting: an upload, by its path; nothing outside uploads/.
    assert.deepEqual(await ok({ type: "job/delete-upload", config: { job: "library", path: again.path }, app: identity }), { job: "app/bench/library", path: again.path, removed: true });
    assert.equal((await ok({ type: "job/delete-upload", config: { job: "library", path: again.path }, app: identity })).removed, false);
    await refused({ type: "job/delete-upload", config: { job: "library", path: "plan.md" }, app: identity }, /only a file under uploads\//);
    await refused({ type: "job/delete-upload", config: { job: "library", path: "uploads/../../elsewhere.json" }, app: identity }, /escapes|only a file under uploads/);

    // A one-shot launch takes its files on the run: saved under its
    // artifacts, handed to its steps, never in what the log keeps.
    const one = await ok({ type: "run/launch", config: { workflow: "attach-wf", attachments: [{ name: "a.txt", data: b64("hi") }] }, app: identity });
    const done = await ok({ type: "run/get", config: { workflow: "attach-wf", runId: one.runId, wait: 10_000 }, app: identity });
    assert.deepEqual(done.output.attachments, [{ name: "a.txt", mediaType: "text/plain", size: 2, path: "attachments/a.txt" }]);
    const start = (await store.getRunEvents("attach-wf", one.runId)).find((e) => e.type === "run.start")!;
    assert.deepEqual(start.attachments, [{ name: "a.txt", mediaType: "text/plain", size: 2, path: "attachments/a.txt" }]);
    assert.ok(!JSON.stringify(await store.getRunEvents("attach-wf", one.runId)).includes(b64("hi")), "no bytes in the log");
    const file = await ok({ type: "run/files", config: { workflow: "attach-wf", runId: one.runId, path: "attachments/a.txt" }, app: identity });
    assert.equal(file.text, "hi");
    await refused({ type: "run/launch", config: { workflow: "attach-wf", attachments: [{ name: "big.png", data: Buffer.alloc(6 * 1024 * 1024).toString("base64") }] }, app: identity }, /big\.png is 6\.0 MB; the limit is 5\.0 MB/);
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

  // A declared type going through, kept, is graph-types.test.ts's: only a
  // Neo4j graph registers an app's types.
  it("a graph write is refused on an undeclared type, and on one strut keeps for itself whatever the manifest says — a create by type, an edit of a Concept by ref_id, a templated type, an edge by ref", { skip: backend.skip }, async () => {
    const nodes = appIdentity("nodes", "v1");
    await refused({ type: "graph/create-node", config: { node_type: "Invoice", node_data: { name: "X" } }, app: nodes }, /write on "Invoice" is refused: this app declares no graph types/);
    await refused({ type: "graph/create-node", config: { node_type: "Concept", node_data: { name: "X" } }, app: nodes }, /write on "Concept" is refused: Concept is the workspace's notes/);
    await refused({ type: "graph/edit-node", config: { ref_id: conceptRef, node_data: { description: "edited" } }, app: nodes }, /write on "Concept" is refused: Concept is the workspace's notes/);
    await refused({ type: "graph/delete-node", config: { ref_id: conceptRef }, app: nodes }, /write on "Concept" is refused/);
    await refused({ type: "graph/create-node", config: { node_type: "StrutRun", node_data: {} }, app: nodes }, /StrutRun is one of strut's own types/);
    await refused({ type: "graph/create-node", config: { node_type: "Evidence", node_data: {} }, app: nodes }, /Evidence is the claims layer's/);
    await refused({ type: "graph/edit-node", config: { ref_id: "no-such-node", node_data: {} }, app: nodes }, /no node no-such-node/);
    await refused({ type: "graph/create-node", config: { node_type: "{{ input.t }}", node_data: {} }, app: identity }, /literal value, not a template/);
    await refused({ type: "graph/delete-edge", config: { edge_ref_id: "e1" }, app: identity }, /locate the edge by its endpoints/);
    await refused({ type: "graph/create-schema", config: {}, app: identity }, /not a thing a page does/);
    assert.deepEqual(await store.listRuns("step:graph/create-node"), [], "a refusal keeps nothing");
    // A read of the graph is not kept either.
    const read = await ok({ type: "graph/graph-get", config: { ref_id: conceptRef }, app: identity });
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

  it("every call is counted per app: GET /apps/:name/usage, a warning on the version that caused it, its count on GET /apps, the brief on app/get", async () => {
    // Through the door: counted by the server's monitor, as the viewer.
    await rpc("/mcp", "tools/call", { name: STEP_RUN_TOOL, arguments: { type: "whoami", config: {}, app: appIdentity("strict", "v1") } });
    const before = (await (await strut.app.request("/apps/strict/usage", { headers: auth })).json()) as AppUsage;
    assert.equal(before.app, "strict");
    const whoami = before.types.find((t) => t.type === "whoami");
    assert.deepEqual([whoami?.calls, whoami?.errors, whoami?.bytes], [1, 1, 0], "a refusal counts as a failure");
    assert.equal(before.minutes.length, 60);
    // One page, one call per item: a fan-out warning on bench@v1 (110 calls,
    // so a 10 s window boundary between them leaves one side over the rule).
    const counted = buildAppTools({ apps: strut.apps, registry, services: strut.services, actor: "viewer", runStepDeps: { store, workspace: new FileWorkspaceStore(dataDir) }, monitor: strut.appMonitor });
    for (let i = 0; i < 110; i++) await (counted[STEP_RUN_TOOL] as any).execute({ type: "whoami", config: { item: i }, app: identity }, { toolCallId: "t", messages: [] });
    const usage = (await (await strut.app.request("/apps/bench/usage", { headers: auth })).json()) as AppUsage;
    const fanout = usage.warnings.find((w) => w.kind === "fanout");
    assert.ok(fanout, JSON.stringify(usage.warnings));
    assert.deepEqual([fanout.version, fanout.type], ["v1", "whoami"]);
    assert.ok(fanout.peak >= 55 && fanout.distinct! >= 25, JSON.stringify(fanout));
    assert.ok(usage.types.find((t) => t.type === "whoami")!.bytes > 0);
    const listed = ((await (await strut.app.request("/apps", { headers: auth })).json()) as { apps: Array<{ name: string; warnings?: number }> }).apps;
    assert.equal(listed.find((a) => a.name === "bench")?.warnings, 1);
    assert.equal(listed.find((a) => a.name === "strict")?.warnings, undefined);
    assert.equal((await strut.apps.get("bench"))!.usage?.warnings[0]?.kind, "fanout", "the builder reads it through app/get");
    assert.equal((await strut.app.request("/apps/ghost/usage", { headers: auth })).status, 404);
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
