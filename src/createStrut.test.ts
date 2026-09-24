import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";

import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { defineStep, flow, step, withMessages } from "./core.js";
import { pathlessWorkspace } from "./test-util/pathless-workspace.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore, FileRunStore } from "./store.js";
import { FileSecretStore, MemorySecretStore } from "./secret-store.js";
import type { StrutCapabilities } from "./capabilities.js";

// ── createRegistry ─────────────────────────────────────────────────────────

describe("createRegistry", () => {
  it("layers user steps on top of built-in core and lib steps", async () => {
    const myStep = defineStep({
      type: "my-step",
      input: z.object({}),
      output: z.string(),
      async run() {
        return "hi";
      },
    });
    const reg = await createRegistry([myStep]);
    assert.equal(typeof reg["my-step"], "object");
    // Core steps are present.
    assert.equal(typeof reg["http"], "object");
    assert.equal(typeof reg["log"], "object");
    assert.equal(typeof reg["foreach"], "object");
    // Lib steps are present too.
    assert.equal(typeof reg["github/fetch-pr"], "object");
  });

  it("returns core + lib when called with no user steps", async () => {
    const reg = await createRegistry([]);
    assert.ok("http" in reg);
    assert.ok("if" in reg);
    assert.ok("github/fetch-pr" in reg);
  });

  it("throws on duplicate step types in the input", async () => {
    const a = defineStep({
      type: "dup",
      input: z.object({}),
      output: z.any(),
      async run() {
        return 1;
      },
    });
    const b = defineStep({
      type: "dup",
      input: z.object({}),
      output: z.any(),
      async run() {
        return 2;
      },
    });
    await assert.rejects(
      () => createRegistry([a, b]),
      /duplicate step type "dup"/,
    );
  });

  it("throws when a step is missing required fields", async () => {
    await assert.rejects(
      () => createRegistry([{ type: "x" } as any]),
      /missing "type" or "run"/,
    );
  });

  it("lets a user step shadow a core step", async () => {
    const myHttp = defineStep({
      type: "http",
      input: z.object({}),
      output: z.string(),
      async run() {
        return "shadowed";
      },
    });
    const reg = await createRegistry([myHttp]);
    assert.equal(reg["http"], myHttp);
  });
});

// ── createStrut basics ──────────────────────────────────────────────────────

describe("createStrut", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-factory-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("builds an instance with sensible defaults", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });

    assert.ok(strut.app, "app should be a Hono instance");
    assert.equal(strut.workspace.path, tempDir);
    // Default services provide the standard adapter capabilities out of the box.
    const svc = strut.services as { http?: unknown; secrets?: unknown };
    assert.equal(typeof svc.http, "function");
    assert.equal(typeof svc.secrets, "object");
    const reg = strut.getRegistry();
    assert.ok("http" in reg);
  });

  it("serves run artifacts with media content-types (video plays inline, unknown types download)", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const artifacts = (strut.services as { artifacts: { write(r: string, p: string, c: Uint8Array): Promise<string> } }).artifacts;
    await artifacts.write("run-1", "clip.mp4", new Uint8Array([0, 0, 0, 24]));
    await artifacts.write("run-1", "audio/track.wav", new Uint8Array([82, 73, 70, 70]));
    await artifacts.write("run-1", "blob.bin", new Uint8Array([1]));

    const mp4 = await strut.app.request("/artifacts/run-1/clip.mp4");
    assert.equal(mp4.status, 200);
    assert.equal(mp4.headers.get("content-type"), "video/mp4");
    const wav = await strut.app.request("/artifacts/run-1/audio/track.wav");
    assert.equal(wav.headers.get("content-type"), "audio/wav");
    const bin = await strut.app.request("/artifacts/run-1/blob.bin");
    assert.equal(bin.headers.get("content-type"), "application/octet-stream");
    const list = (await (await strut.app.request("/artifacts/run-1")).json()) as unknown;
    assert.deepEqual(list, { runId: "run-1", files: ["audio/track.wav", "blob.bin", "clip.mp4"] });
  });

  it("uses an injected registry as-is", async () => {
    const myStep = defineStep({
      type: "ping",
      input: z.object({}),
      output: z.string(),
      async run() {
        return "pong";
      },
    });

    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([myStep]),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });

    const reg = strut.getRegistry();
    assert.ok("ping" in reg);
  });

  it("threads services into strut.run()", async () => {
    interface Services {
      tag: string;
      readings: number[];
    }

    const recordStep = defineStep<"record", z.ZodObject<{ value: z.ZodNumber }>, z.ZodAny, Services>({
      type: "record",
      input: z.object({ value: z.number() }),
      output: z.any(),
      async run(cfg, ctx) {
        ctx.services.readings.push(cfg.value);
        return { tag: ctx.services.tag, total: ctx.services.readings.length };
      },
    });

    const readings: number[] = [];
    const strut = await createStrut<Services>({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([recordStep]),
      store: new MemoryRunStore(),
      services: { tag: "test-env", readings },
      serveUi: false,
      enableChat: false,
    });

    const wf = flow("record-test", {
      input: z.object({}),
      steps: [step("r", "record", { value: 42 })],
    });

    const result = await strut.run(wf, {});
    assert.equal(result.status, "success");
    assert.deepEqual(result.output, { tag: "test-env", total: 1 });
    assert.deepEqual(readings, [42]);
  });

  it("allows per-run services overrides", async () => {
    interface Services {
      label: string;
    }

    const labelStep = defineStep<"label", z.ZodObject<{}>, z.ZodString, Services>({
      type: "label",
      input: z.object({}),
      output: z.string(),
      async run(_cfg, ctx) {
        return ctx.services.label;
      },
    });

    const strut = await createStrut<Services>({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([labelStep]),
      store: new MemoryRunStore(),
      services: { label: "default" },
      serveUi: false,
      enableChat: false,
    });

    const wf = flow("label-test", {
      input: z.object({}),
      steps: [step("l", "label", {})],
    });

    const a = await strut.run(wf);
    assert.equal(a.output, "default");

    const b = await strut.run(wf, {}, { services: { label: "override" } });
    assert.equal(b.output, "override");
  });

  it("resolves workflows by name from the workspace", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("hello", "v1", {
      steps: [
        { id: "g", type: "log", config: { message: "hi" } },
      ],
    });

    const strut = await createStrut({
      workspace: ws,
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });

    const result = await strut.run("hello", {});
    assert.equal(result.status, "success");
  });

  it("serves a partial summary for a run with events but no run.json", async () => {
    const ws = new WorkspaceManager(tempDir);
    const strut = await createStrut({
      workspace: ws,
      serveUi: false,
      enableChat: false,
    });
    // Simulate a run orphaned before finalize: events on disk, no run.json.
    const ev = (over: Record<string, unknown>) => ({
      ts: "2026-01-01T00:00:00.000Z",
      runId: "9999",
      path: "dead-wf",
      type: "run.start",
      ...over,
    });
    await strut.store.append("dead-wf", "9999", ev({ input: { taskId: "t1" } }) as never);
    await strut.store.append(
      "dead-wf",
      "9999",
      ev({ type: "step.end", path: "dead-wf/first", output: { n: 1 }, ts: "2026-01-01T00:01:00.000Z" }) as never,
    );

    const res = await strut.app.request("/workflows/dead-wf/runs/9999");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.partial, true);
    assert.equal(body.status, "stale");
    assert.deepEqual(body.input, { taskId: "t1" });
    assert.deepEqual(body.steps, { first: { n: 1 } });

    // A run with no events at all is still a 404.
    const missing = await strut.app.request("/workflows/dead-wf/runs/1234");
    assert.equal(missing.status, 404);
  });

  it("exposes a working /health endpoint", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const res = await strut.app.request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; stepCount: number };
    assert.equal(body.ok, true);
    assert.ok(body.stepCount > 0);
  });

  it("runs a single step via POST /steps/:type/run", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const res = await strut.app.request("/steps/log/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { message: "hello {{ input.name }}" },
        input: { name: "world" },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; output: unknown };
    assert.equal(body.status, "success");
    assert.equal(body.output, "hello world");

    const missing = await strut.app.request("/steps/nope/run", { method: "POST" });
    assert.equal(missing.status, 404);
  });

  it("records stepHashes on every launch path, and keeps a single-step run only under step:<type>", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishStep(
      "clip/shout",
      `import { z, defineStep } from "strut";
       export default defineStep({ type: "clip/shout", input: z.object({ text: z.string() }), output: z.string(), async run(cfg) { return cfg.text.toUpperCase(); } });`,
    );
    await ws.publishStep(
      "clip/unused",
      `import { z, defineStep } from "strut";
       export default defineStep({ type: "clip/unused", input: z.any(), output: z.any(), async run() { return 1; } });`,
    );
    await ws.publishWorkflow("shouter", "v1", { steps: [{ id: "s", type: "clip/shout", config: { text: "{{ input.text }}" } }] });
    const store = new MemoryRunStore();
    const strut = await createStrut({ workspace: ws, store, serveUi: false, enableChat: false, stt: false });
    const hash = (await ws.getActiveStepHashes())["clip/shout"]!;
    assert.equal(strut.claims, null, "a filesystem workspace has no claims layer");

    // strut.run()
    const direct = await strut.run("shouter", { text: "hi" });
    assert.equal(direct.output, "HI");
    const startOf = async (key: string, runId: string) => (await store.getRunEvents(key, runId)).find((e) => e.type === "run.start")!;
    assert.deepEqual((await startOf("shouter", direct.runId)).stepHashes, { "clip/shout": hash }, "only the steps the flow can execute");

    // POST /workflows/:name/run (detached)
    const launched = await strut.app.request("/workflows/shouter/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text: "yo" } }),
    });
    assert.equal(launched.status, 202);
    const { runId } = (await launched.json()) as { runId: string };
    await (await strut.app.request(`/workflows/shouter/runs/${runId}/stream`)).text(); // drain to completion
    assert.deepEqual((await startOf("shouter", runId)).stepHashes, { "clip/shout": hash });

    // POST /steps/:type/run — in memory unless asked (no claims here), then kept under the step key.
    const post = (body: unknown) =>
      strut.app.request("/steps/clip/shout/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const scratch = (await (await post({ config: { text: "a" } })).json()) as { runId: string; kept?: string; events: Array<{ type: string; stepHashes?: unknown }> };
    assert.equal(scratch.kept, undefined);
    assert.deepEqual(scratch.events.find((e) => e.type === "run.start")!.stepHashes, { "clip/shout": hash });
    const kept = (await (await post({ config: { text: "b" }, keep: true })).json()) as { runId: string; kept?: string; output: unknown };
    assert.deepEqual([kept.kept, kept.output], ["step:clip/shout", "B"]);
    assert.deepEqual(await store.listRuns("step:clip/shout"), [kept.runId]);
    assert.equal((await store.listRuns("shouter")).length, 2, "workflow run history is untouched");
    const listed = (await (await strut.app.request("/workflows")).json()) as Array<{ name: string }>;
    assert.deepEqual(listed.map((w) => w.name), ["shouter"], "a step key is never a workflow");
  });

  it("a filesystem workspace has no claims layer: GET /claims says so, mutations are 409", async () => {
    const strut = await createStrut({ workspace: new WorkspaceManager(tempDir), store: new MemoryRunStore(), serveUi: false, enableChat: false, stt: false });
    assert.deepEqual([strut.claims, strut.verifier], [null, null]);
    const read = await strut.app.request("/claims?kind=step&name=log");
    assert.deepEqual([read.status, await read.json()], [200, { enabled: false, claims: [] }]);
    const post = (path: string) => strut.app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await post("/claims")).status, 409);
    assert.equal((await post("/claims/x/evidence")).status, 409);
    assert.equal((await post("/workflows/wf/runs/1/verify")).status, 409);
  });

  it("exposes /steps with registered types", async () => {
    const myStep = defineStep({
      type: "custom-thing",
      input: z.object({}),
      output: z.any(),
      async run() {
        return null;
      },
    });
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([myStep]),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const res = await strut.app.request("/steps");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { core: Array<{ type: string }> };
    const types = body.core.map((s) => s.type);
    assert.ok(types.includes("custom-thing"));
    assert.ok(types.includes("http"));
  });

  it("rejects POST /steps when the registry was injected", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([]),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const res = await strut.app.request("/steps", {
      method: "POST",
      body: JSON.stringify({ name: "x", code: "export default {}" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 409);
  });

  it("exposes step version endpoints (list / get-version / set-active)", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const headers = { "content-type": "application/json" };

    // Publish v1, then a changed v2 of the same step.
    const pub1 = await strut.app.request("/steps", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "scorer", code: "// v1" }),
    });
    const { version: v1 } = (await pub1.json()) as { version: string };
    await strut.app.request("/steps", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "scorer", code: "// v2" }),
    });

    // versions lists both, active is v2
    const verRes = await strut.app.request("/steps/scorer/versions");
    assert.equal(verRes.status, 200);
    const ver = (await verRes.json()) as { active: string; versions: string[] };
    assert.equal(ver.versions.length, 2);
    assert.notEqual(ver.active, v1);

    // archived source for v1 is retrievable
    const srcRes = await strut.app.request(`/steps/scorer/version/${v1}`);
    assert.equal(srcRes.status, 200);
    const src = (await srcRes.json()) as { source: string };
    assert.equal(src.source, "// v1");

    // set active back to v1
    const actRes = await strut.app.request("/steps/scorer/active", {
      method: "PUT",
      headers,
      body: JSON.stringify({ version: v1 }),
    });
    assert.equal(actRes.status, 200);
    const ver2Res = await strut.app.request("/steps/scorer/versions");
    const ver2 = (await ver2Res.json()) as { active: string };
    assert.equal(ver2.active, v1);
  });

  it("counts runs per workflow version and rolls back via PUT /active", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("ver-flow", "v1", { steps: [{ id: "g", type: "log", config: { message: "one" } }] });
    await ws.publishWorkflow("ver-flow", "v2", { steps: [{ id: "g", type: "log", config: { message: "two" } }] });
    const strut = await createStrut({ workspace: ws, store: new MemoryRunStore(), serveUi: false, enableChat: false });

    // Explicit runIds: generated ones are millisecond timestamps and collide.
    await strut.run("ver-flow", {}, { runId: "1" });
    await strut.run("ver-flow", {}, { runId: "2" });
    const act = await strut.app.request("/workflows/ver-flow/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "v1" }),
    });
    assert.equal(act.status, 200);
    await strut.run("ver-flow", {}, { runId: "3" });

    const res = await strut.app.request("/workflows/ver-flow/versions");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      active: string;
      versions: Array<{ version: string; runs: number; success: number }>;
      unattributed: number;
    };
    assert.equal(body.active, "v1");
    assert.deepEqual(body.versions.map((v) => v.version).sort(), ["v1", "v2"]);
    const by = Object.fromEntries(body.versions.map((v) => [v.version, v]));
    assert.equal(by.v2.runs, 2);
    assert.equal(by.v2.success, 2);
    assert.equal(by.v1.runs, 1);
    assert.equal(body.unattributed, 0);
  });

  it("launches a run detached over HTTP, returning a runId immediately", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("echo-flow", "v1", {
      steps: [{ id: "g", type: "log", config: { message: "hi" } }],
    });
    const strut = await createStrut({
      workspace: ws,
      store: new FileRunStore(tempDir),
      serveUi: false,
      enableChat: false,
    });
    const res = await strut.app.request("/workflows/echo-flow/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    // Detached: 202 + { runId }, no streamed body.
    assert.equal(res.status, 202);
    const { runId } = (await res.json()) as { runId: string };
    assert.ok(runId, "should return a runId");
    // Drain to completion so the background writes settle before teardown.
    const drain = await strut.app.request(`/workflows/echo-flow/runs/${runId}/stream`);
    await drain.text();
  });

  it("reattaches to a run via SSE tail (history + final done)", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("echo-flow", "v1", {
      steps: [{ id: "g", type: "log", config: { message: "hi" } }],
    });
    const strut = await createStrut({
      workspace: ws,
      store: new FileRunStore(tempDir),
      serveUi: false,
      enableChat: false,
    });

    // Launch detached, then tail its log to completion.
    const launch = await strut.app.request("/workflows/echo-flow/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    const { runId } = (await launch.json()) as { runId: string };

    const res = await strut.app.request(`/workflows/echo-flow/runs/${runId}/stream`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("run.start"), "replays history");
    assert.ok(text.includes("run.end"), "follows to the terminal event");
    assert.ok(text.includes("event: done"), "sends a final done with the result");
  });

  it("streams a run reattached after it already finished", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("echo-flow", "v1", {
      steps: [{ id: "g", type: "log", config: { message: "hi" } }],
    });
    const strut = await createStrut({
      workspace: ws,
      store: new FileRunStore(tempDir),
      serveUi: false,
      enableChat: false,
    });

    // Run to completion *first* (so the log is fully written), then attach.
    const result = await strut.run("echo-flow", {});
    assert.equal(result.status, "success");

    const res = await strut.app.request(
      `/workflows/echo-flow/runs/${result.runId}/stream`,
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("run.start"));
    assert.ok(text.includes("event: done"));
  });

  it("streams a completed run's events from a MemoryRunStore (no capability gate)", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const wf = flow("mem-stream", {
      input: z.object({}),
      steps: [step("g", "log", { message: "hello" })],
    });
    const result = await strut.run(wf, {});
    const res = await strut.app.request(`/workflows/mem-stream/runs/${result.runId}/stream`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("run.start"));
    assert.ok(text.includes("event: done"));
  });

  it("rebuildRegistry is a no-op when the registry was injected", async () => {
    const myStep = defineStep({
      type: "fixed",
      input: z.object({}),
      output: z.any(),
      async run() {
        return 1;
      },
    });
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([myStep]),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const before = Object.keys(strut.getRegistry()).sort();
    await strut.rebuildRegistry();
    const after = Object.keys(strut.getRegistry()).sort();
    assert.deepEqual(before, after);
  });

  it("serves run history from an in-memory store (list, lookup, events)", async () => {
    const memStore = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: memStore,
      serveUi: false,
      enableChat: false,
    });

    const wf = flow("mem-test", {
      input: z.object({}),
      steps: [step("g", "log", { message: "hello" })],
    });

    const result = await strut.run(wf, {});
    assert.equal(result.status, "success");

    // Every read endpoint works over the memory store — it is a complete
    // ephemeral backend, not a write-only stub.
    const list = await strut.app.request("/workflows/mem-test/runs");
    assert.equal(list.status, 200);
    const runs = (await list.json()) as { runId: string; status: string }[];
    assert.deepEqual(runs.map((r) => [r.runId, r.status]), [[result.runId, "success"]]);

    const one = await strut.app.request(`/workflows/mem-test/runs/${result.runId}`);
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as { status: string }).status, "success");

    const events = await strut.app.request(`/workflows/mem-test/runs/${result.runId}/events`);
    assert.equal(events.status, 200);
    const types = ((await events.json()) as { type: string }[]).map((e) => e.type);
    assert.ok(types.includes("run.start") && types.includes("run.end"));

    const missing = await strut.app.request("/workflows/mem-test/runs/nope");
    assert.equal(missing.status, 404);
  });

  it("custom steps can `import \"strut\"` from a workspace outside the package tree", async () => {
    // tempDir is under the OS tmpdir — no `strut` package is reachable by
    // walking up from it. The resolve hook (strut-resolver.ts) maps the bare
    // specifier to this running strut, so the step gets the same defineStep/z.
    const ws = new WorkspaceManager(tempDir);
    await ws.publishStep(
      "hook-step",
      `import { z, defineStep } from "strut";
       export default defineStep({
         type: "hook-step",
         input: z.object({ name: z.string() }),
         output: z.string(),
         async run({ input }) { return "hi " + input.name; },
       });`,
    );
    const strut = await createStrut({ workspace: ws, store: new MemoryRunStore(), serveUi: false, enableChat: false, stt: false });
    assert.ok("hook-step" in strut.getRegistry(), "step importing strut loads from an out-of-tree workspace");
    const { z: ourZ } = await import("zod");
    const def = strut.getRegistry()["hook-step"]!;
    assert.ok(def.input instanceof ourZ.ZodObject, "the step's zod is this process's zod (one module instance)");
  });

  it("custom steps published before the rename can still `import \"vein\"`", async () => {
    // Pre-#1664 step versions live in the graph verbatim (their content hash
    // is their identity), so the resolve hook keeps the old bare specifier.
    const ws = new WorkspaceManager(tempDir);
    await ws.publishStep(
      "legacy-hook-step",
      `import { z, defineStep } from "vein";
       export default defineStep({
         type: "legacy-hook-step",
         input: z.object({}),
         output: z.string(),
         async run() { return "still here"; },
       });`,
    );
    const strut = await createStrut({ workspace: ws, store: new MemoryRunStore(), serveUi: false, enableChat: false, stt: false });
    assert.ok("legacy-hook-step" in strut.getRegistry(), "step importing the old package name loads");
  });

  it("a non-file WorkspaceStore gets in-memory store defaults and still loads custom steps", async () => {
    const ws = pathlessWorkspace(new WorkspaceManager(tempDir));
    // Import-free step source (the temp dir sits outside the project tree,
    // so `import "strut"` wouldn't resolve — same trick as registry.test.ts).
    await ws.publishStep(
      "conf-step",
      `export default {
        type: "conf-step",
        input: { _def: { typeName: 'ZodObject', shape: () => ({}) } },
        output: { _def: { typeName: 'ZodAny' } },
        async run() { return "ok"; },
      };`,
    );
    const strut = await createStrut({ workspace: ws, dataDir: join(tempDir, "data"), serveUi: false, enableChat: false });
    assert.ok(strut.store instanceof MemoryRunStore, "run store defaults to memory for a non-file workspace");
    assert.equal(strut.dataDir, join(tempDir, "data"));
    assert.ok("conf-step" in strut.getRegistry(), "custom steps load via materializeCustomSteps()");
    const health = (await (await strut.app.request("/health")).json()) as { dataDir: string };
    assert.equal(health.dataDir, join(tempDir, "data"));
    const meta = await strut.app.request("/workflows/nope");
    assert.equal(meta.status, 404);
  });

  it("actor secrets default to a file beside a FILE deployment secret store, whatever the workspace kind", async () => {
    // The mcp lab host: a GRAPH workspace (stood in for by a pathless one)
    // with file stores under dataDir — and no `actorSecretStore` passed. A
    // credential hive pushes must outlive the process, so the default follows
    // the deployment secret store's kind, not the workspace's.
    const dataDir = join(tempDir, "data");
    const boot = () =>
      createStrut({
        workspace: pathlessWorkspace(new WorkspaceManager(tempDir)),
        dataDir,
        store: new MemoryRunStore(),
        secretStore: new FileSecretStore(dataDir),
        serveUi: false,
        enableChat: false,
        stt: false,
      });
    const put = (strut: Awaited<ReturnType<typeof boot>>) =>
      strut.app.request("/actors/hive-user-1/secrets/GITHUB_TOKEN", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "ghp_survives" }),
      });

    const first = await boot();
    assert.equal((await put(first)).status, 200);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dataDir, "actor-secrets.json"), "utf8");
    assert.ok(!raw.includes("ghp_survives"), "encrypted at rest, beside secrets.json");

    // A second instance over the same dataDir — a restart — still has it.
    const second = await boot();
    const listed = (await (await second.app.request("/actors/hive-user-1/secrets")).json()) as {
      secrets: { name: string }[];
    };
    assert.deepEqual(listed.secrets.map((x) => x.name), ["GITHUB_TOKEN"]);
    const svc = second.services as unknown as StrutCapabilities;
    assert.equal(await svc.secrets.forPrincipal!("hive-user-1").get("GITHUB_TOKEN"), "ghp_survives");
    assert.equal(await svc.secrets.get("GITHUB_TOKEN"), undefined, "never the deployment's");

    // And with an in-memory deployment store, actor secrets stay in memory:
    // nothing is written under dataDir for them.
    const memDir = join(tempDir, "mem");
    const mem = await createStrut({
      workspace: pathlessWorkspace(new WorkspaceManager(tempDir)),
      dataDir: memDir,
      store: new MemoryRunStore(),
      secretStore: new MemorySecretStore(),
      serveUi: false,
      enableChat: false,
      stt: false,
    });
    assert.equal((await put(mem)).status, 200);
    await assert.rejects(readFile(join(memDir, "actor-secrets.json"), "utf8"), "memory store writes no file");
  });

  it("dataDir defaults to the file workspace root and is overridable", async () => {
    const a = await createStrut({ workspace: new WorkspaceManager(tempDir), serveUi: false, enableChat: false });
    assert.equal(a.dataDir, tempDir);
    const b = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      dataDir: join(tempDir, "elsewhere"),
      serveUi: false,
      enableChat: false,
    });
    assert.equal(b.dataDir, join(tempDir, "elsewhere"));
  });

  it("GET /workflows decorates entries with lastRunAt from the run store", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("ran", "v1", { steps: [{ id: "g", type: "log", config: { message: "x" } }] });
    await ws.publishWorkflow("never", "v1", { steps: [{ id: "g", type: "log", config: { message: "x" } }] });
    const strut = await createStrut({
      workspace: ws,
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
    });
    const result = await strut.run("ran", {});
    const res = await strut.app.request("/workflows");
    const list = (await res.json()) as { name: string; lastRunAt?: number }[];
    const byName = Object.fromEntries(list.map((w) => [w.name, w.lastRunAt]));
    assert.equal(byName["ran"], Number(result.runId));
    assert.equal(byName["never"], undefined);
  });

  it("resolves + applies a declared promotion (run output → target param)", async () => {
    const ws = new WorkspaceManager(tempDir);
    // Target workflow whose `system` param we'll promote into.
    await ws.publishWorkflow("target", "v1", {
      steps: [{ id: "g", type: "log", config: { message: "{{ params.system }}" } }],
      params: { system: "old" },
    });
    // Optimizer workflow: emits `{ bestPrompt }` and declares a promote to target.
    await ws.publishWorkflow("opt", "v1", {
      steps: [{ id: "best", type: "emit", config: {} }],
      promotes: [{ from: "bestPrompt", to: "target.system", label: "Sys" }],
    });

    const emit = defineStep({
      type: "emit",
      input: z.object({}),
      output: z.any(),
      async run() {
        return { bestPrompt: "new winner" };
      },
    });

    const strut = await createStrut({
      workspace: ws,
      registry: await createRegistry([emit]),
      store: new FileRunStore(tempDir),
      serveUi: false,
      enableChat: false,
    });

    const result = await strut.run("opt", {});
    assert.equal(result.status, "success");

    // GET promotions resolves the run-output value + the target's current value.
    const pRes = await strut.app.request(`/workflows/opt/runs/${result.runId}/promotions`);
    assert.equal(pRes.status, 200);
    const proms = (await pRes.json()) as any[];
    assert.equal(proms.length, 1);
    assert.equal(proms[0].value, "new winner");
    assert.equal(proms[0].current, "old");
    assert.equal(proms[0].target.workflow, "target");
    assert.equal(proms[0].target.param, "system");
    assert.equal(proms[0].resolved, true);

    // POST promote writes it + publishes a new target version.
    const applyRes = await strut.app.request(`/workflows/opt/runs/${result.runId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "target.system" }),
    });
    assert.equal(applyRes.status, 200);
    const applied = (await applyRes.json()) as any;
    assert.equal(applied.version, "v2");
    assert.equal(applied.before, "old");
    assert.equal(applied.after, "new winner");

    const flow = await ws.getWorkflow("target");
    assert.equal(flow.params?.["system"], "new winner");
  });

  it("returns [] promotions when the workflow declares none", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("plain", "v1", {
      steps: [{ id: "g", type: "log", config: { message: "hi" } }],
    });
    const strut = await createStrut({
      workspace: ws,
      store: new FileRunStore(tempDir),
      serveUi: false,
      enableChat: false,
    });
    const result = await strut.run("plain", {});
    const pRes = await strut.app.request(`/workflows/plain/runs/${result.runId}/promotions`);
    assert.equal(pRes.status, 200);
    assert.deepEqual(await pRes.json(), []);
  });
});

describe("listen()", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-listen-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("binds an OS-picked port on 0, honors the host, and prints a ready line", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      stt: false,
    });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    let port: number;
    try {
      port = await strut.listen(0, "127.0.0.1");
    } finally {
      console.log = orig;
    }
    try {
      assert.ok(port > 0, `expected a real port, got ${port}`);
      const ready = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.event === "ready");
      assert.deepEqual(ready, { event: "ready", port, host: "127.0.0.1" });
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    } finally {
      await strut.close();
    }
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), "server should be closed");
  });

  it("puts the API key on the ready line only when STRUT_READY_KEY is set", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      stt: false,
    });
    const lines: string[] = [];
    const orig = console.log;
    const prevKey = process.env["STRUT_API_KEY"];
    const prevReady = process.env["STRUT_READY_KEY"];
    process.env["STRUT_API_KEY"] = "launch-key";
    process.env["STRUT_READY_KEY"] = "1";
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    let port: number;
    try {
      port = await strut.listen(0, "127.0.0.1");
    } finally {
      console.log = orig;
      if (prevKey === undefined) delete process.env["STRUT_API_KEY"]; else process.env["STRUT_API_KEY"] = prevKey;
      if (prevReady === undefined) delete process.env["STRUT_READY_KEY"]; else process.env["STRUT_READY_KEY"] = prevReady;
    }
    try {
      const ready = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.event === "ready");
      assert.deepEqual(ready, { event: "ready", port, host: "127.0.0.1", key: "launch-key" });
    } finally {
      await strut.close();
    }
  });

  it("rejects when the port is taken instead of crashing the process", async () => {
    const mk = () =>
      createStrut({
        workspace: new WorkspaceManager(tempDir),
        store: new MemoryRunStore(),
        serveUi: false,
        enableChat: false,
        stt: false,
      });
    const a = await mk();
    const port = await a.listen(0, "127.0.0.1");
    const b = await mk();
    try {
      await assert.rejects(b.listen(port, "127.0.0.1"), /EADDRINUSE/);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

// ── Actors and the principal rule (plans/mothership-cost-control.md §2) ────

describe("actors and the principal rule", () => {
  let tempDir: string;
  let savedKey: string | undefined;
  beforeEach(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    tempDir = join(tmpdir(), `strut-actors-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A step that reports who it ran as. */
  const whoami = defineStep({
    type: "whoami",
    input: z.object({}),
    output: z.any(),
    async run(_cfg, ctx) {
      return { actor: ctx.actor ?? null, principal: ctx.principal ?? null };
    },
  });
  const STEPS = [{ id: "who", type: "whoami", config: {} }];

  const boot = async (o: { resolveActor?: (c: any) => string | undefined } = {}) => {
    const store = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([whoami]),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      ...(o.resolveActor ? { resolveActor: o.resolveActor } : {}),
    });
    await strut.workspace.publishWorkflow("wf", "v1", { steps: STEPS });
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await strut.app.request(path, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    const finished = async (wf: string, runId: string) => {
      for (let i = 0; i < 300; i++) {
        const s = await store.getRunSummary(wf, runId);
        if (s) return s;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`run ${runId} never finished`);
    };
    const startOf = async (wf: string, runId: string) => (await store.getRunEvents(wf, runId)).find((e) => e.type === "run.start")!;
    return { strut, store, call, finished, startOf };
  };

  it("an HTTP run is billed to the request actor, else to the workflow's owner, else to nobody", async () => {
    const { strut, call, finished, startOf } = await boot({ resolveActor: (c) => c.req.header("x-test-actor") || undefined });
    // Nobody known, no owner → no stamps at all.
    const anon = (await call("POST", "/workflows/wf/run", { input: {} })).json.runId as string;
    assert.deepEqual((await finished("wf", anon)).output, { actor: null, principal: null });
    assert.equal((await startOf("wf", anon)).principal, undefined);

    // The launcher pays for their own run.
    const mine = (await call("POST", "/workflows/wf/run", { input: {} }, { "x-test-actor": "alice-1" })).json.runId as string;
    assert.deepEqual((await finished("wf", mine)).output, { actor: "alice-1", principal: "alice-1" });
    const start = await startOf("wf", mine);
    assert.equal(start.actor, "alice-1");
    assert.equal(start.principal, "alice-1");
    assert.equal((await finished("wf", mine)).principal, "alice-1", "on the summary too");

    // With an owner: an anonymous launch (an automation, say) is the owner's; a launch by someone else is theirs.
    await strut.workspace.setWorkflowOwner("wf", "bob-2");
    const owners = (await call("POST", "/workflows/wf/run", { input: {} })).json.runId as string;
    assert.deepEqual((await finished("wf", owners)).output, { actor: null, principal: "bob-2" });
    const theirs = (await call("POST", "/workflows/wf/run", { input: {} }, { "x-test-actor": "alice-1" })).json.runId as string;
    assert.deepEqual((await finished("wf", theirs)).output, { actor: "alice-1", principal: "alice-1" });
    // strut.run() follows the same rule.
    const r = await strut.run("wf", {}, { actor: "carol-3" });
    assert.deepEqual(r.output, { actor: "carol-3", principal: "carol-3" });
    assert.deepEqual((await strut.run("wf", {})).output, { actor: null, principal: "bob-2" });
    assert.deepEqual((await strut.run("wf", {}, { principal: "dave-4" })).output, { actor: null, principal: "dave-4" });
  });

  it("the default resolver honors x-strut-actor only with a configured, matching deployment key", async () => {
    const { call, finished } = await boot();
    const unkeyed = (await call("POST", "/workflows/wf/run", { input: {} }, { "x-strut-actor": "mallory-9" })).json.runId as string;
    assert.deepEqual((await finished("wf", unkeyed)).output, { actor: null, principal: null }, "no key configured → nothing is honored");

    process.env["STRUT_API_KEY"] = "deploy-key";
    const wrong = (await call("POST", "/workflows/wf/run", { input: {} }, { "x-strut-actor": "mallory-9", authorization: "Bearer nope" })).json.runId as string;
    assert.deepEqual((await finished("wf", wrong)).output, { actor: null, principal: null });
    const right = (await call("POST", "/workflows/wf/run", { input: {} }, { "x-strut-actor": "hive-user-1", authorization: "Bearer deploy-key" })).json.runId as string;
    assert.deepEqual((await finished("wf", right)).output, { actor: "hive-user-1", principal: "hive-user-1" });
  });

  it("a single-step run is the actor's own; a subflow inherits its parent's principal", async () => {
    const { strut, call } = await boot({ resolveActor: (c) => c.req.header("x-test-actor") || undefined });
    const single = await call("POST", "/steps/whoami/run", { config: {} }, { "x-test-actor": "alice-1" });
    assert.deepEqual(single.json.output, { actor: "alice-1", principal: "alice-1" });
    assert.deepEqual((await call("POST", "/steps/whoami/run", { config: {} })).json.output, { actor: null, principal: null });

    await strut.workspace.publishWorkflow("parent", "v1", { steps: [{ id: "child", type: "subflow", config: { workflow: "wf", input: {} } }] });
    await strut.workspace.setWorkflowOwner("parent", "owner-7");
    assert.deepEqual((await strut.run("parent", {})).output, { actor: null, principal: "owner-7" });
  });

  it("the first publish with an actor adopts the workflow; later ones never re-own it; PUT /owner transfers (gated)", async () => {
    const { strut, call } = await boot({ resolveActor: (c) => c.req.header("x-test-actor") || undefined });
    const yaml = "steps:\n  - id: who\n    type: whoami\n";
    // Created without an actor: ownerless.
    await call("POST", "/workflows", { name: "orphan", yaml });
    assert.equal((await strut.workspace.getWorkflowMetadata("orphan"))!.owner, undefined);
    // The next edit by a person adopts it…
    assert.equal((await call("POST", "/workflows/orphan", { version: "v2", yaml }, { "x-test-actor": "alice-1" })).status, 201);
    assert.equal((await strut.workspace.getWorkflowMetadata("orphan"))!.owner, "alice-1");
    // …and a later editor does not take it over.
    await call("POST", "/workflows/orphan", { version: "v3", yaml }, { "x-test-actor": "bob-2" });
    assert.equal((await strut.workspace.getWorkflowMetadata("orphan"))!.owner, "alice-1");
    // Created by a person: theirs from the start; the listing shows it.
    await call("POST", "/workflows", { name: "mine", yaml }, { "x-test-actor": "carol-3" });
    assert.equal((await call("GET", "/workflows")).json.find((w: any) => w.name === "mine").owner, "carol-3");

    // Transfer: explicit, and an admin action.
    process.env["STRUT_API_KEY"] = "deploy-key";
    assert.equal((await call("PUT", "/workflows/orphan/owner", { owner: "bob-2" })).status, 401);
    assert.equal((await call("PUT", "/workflows/orphan/owner", { owner: "bob-2" }, { authorization: "Bearer deploy-key" })).status, 200);
    assert.equal((await strut.workspace.getWorkflowMetadata("orphan"))!.owner, "bob-2");
    assert.equal((await call("PUT", "/workflows/orphan/owner", { owner: null }, { authorization: "Bearer deploy-key" })).status, 200);
    assert.equal((await strut.workspace.getWorkflowMetadata("orphan"))!.owner, undefined);
    assert.equal((await call("PUT", "/workflows/nope/owner", { owner: "x" }, { authorization: "Bearer deploy-key" })).status, 404);
  });

  it("PUT /run-cap stores a positive cap, clears with null, rejects the rest, publishes no version", async () => {
    const { strut, call } = await boot();
    const before = (await strut.workspace.getWorkflowMetadata("wf"))!;
    assert.equal((await call("PUT", "/workflows/wf/run-cap", { maxRunCostUsd: 2.5 })).status, 200);
    const after = (await strut.workspace.getWorkflowMetadata("wf"))!;
    assert.equal(after.maxRunCostUsd, 2.5);
    assert.deepEqual(Object.keys(after.versions), Object.keys(before.versions));
    assert.equal((await call("GET", "/workflows")).json.find((w: any) => w.name === "wf").maxRunCostUsd, 2.5);
    for (const bad of [0, -1, "5", true, { usd: 5 }]) {
      assert.equal((await call("PUT", "/workflows/wf/run-cap", { maxRunCostUsd: bad })).status, 400, String(bad));
    }
    assert.equal((await call("PUT", "/workflows/wf/run-cap", { maxRunCostUsd: null })).status, 200);
    assert.equal((await strut.workspace.getWorkflowMetadata("wf"))!.maxRunCostUsd, undefined);
    assert.equal((await call("PUT", "/workflows/nope/run-cap", { maxRunCostUsd: 1 })).status, 404);
  });

  it("a durable resume bills the principal recorded at launch, not today's owner", async () => {
    const { strut, store, call, finished } = await boot();
    await strut.workspace.setWorkflowOwner("wf", "new-owner-5");
    // A run that died mid-flight, launched back when alice was billed for it.
    const runId = "1690000000000";
    await store.append("wf", runId, { ts: new Date().toISOString(), runId, path: "wf", type: "run.start", input: {}, actor: "alice-1", principal: "alice-1" });
    const res = await call("POST", `/workflows/wf/runs/${runId}/resume`, {});
    assert.equal(res.status, 202, JSON.stringify(res.json));
    const summary = await finished("wf", runId);
    assert.equal(summary.status, "success");
    assert.deepEqual(summary.output, { actor: "alice-1", principal: "alice-1" });
    assert.equal(summary.principal, "alice-1");
  });

  it("scheduling adopts an ownerless workflow; with the Mothership required, an unowned schedule is refused at the door and at fire time", async () => {
    const { strut, call } = await boot({ resolveActor: (c) => c.req.header("x-test-actor") || undefined });
    const draft = { name: "Nightly", trigger: { every: "day", at: ["09:00"], tz: "UTC" } };
    // Whoever schedules an ownerless workflow becomes its owner…
    const made = await call("POST", "/workflows/wf/automations", draft, { "x-test-actor": "alice-1" });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal((await strut.workspace.getWorkflowMetadata("wf"))!.owner, "alice-1");
    // …and a later scheduler does not take it over.
    await call("PATCH", `/workflows/wf/automations/${made.json.automation.id}`, { name: "Renamed" }, { "x-test-actor": "bob-2" });
    assert.equal((await strut.workspace.getWorkflowMetadata("wf"))!.owner, "alice-1");

    await strut.workspace.publishWorkflow("orphan", "v1", { steps: STEPS });
    process.env["STRUT_MOTHERSHIP_REQUIRED"] = "1";
    try {
      // Nobody present, nobody to bill: refused, and the workflow stays as it was.
      const refused = await call("POST", "/workflows/orphan/automations", draft);
      assert.equal(refused.status, 400);
      assert.match(refused.json.error, /no owner/);
      assert.equal((await strut.workspace.getWorkflowMetadata("orphan"))!.automations, undefined);
      // A paused one is fine to store; enabling it is not.
      const paused = await call("POST", "/workflows/orphan/automations", { ...draft, enabled: false });
      assert.equal(paused.status, 201);
      const id = paused.json.automation.id as string;
      assert.match((await call("PATCH", `/workflows/orphan/automations/${id}`, { enabled: true })).json.error, /no owner/);
      // Fire launches nothing and says why where the flyout shows it.
      const fired = await call("POST", `/workflows/orphan/automations/${id}/fire`);
      assert.equal(fired.status, 400);
      assert.match(fired.json.error, /no owner/);
      assert.match((await call("GET", "/automations?workflow=orphan")).json.automations[0].lastFireError, /no owner/);
      // A person scheduling it adopts it, and then it runs — billed to them.
      assert.equal((await call("PATCH", `/workflows/orphan/automations/${id}`, { enabled: true }, { "x-test-actor": "carol-3" })).status, 200);
      const ok = await call("POST", `/workflows/orphan/automations/${id}/fire`);
      assert.equal(ok.status, 202, JSON.stringify(ok.json));
    } finally {
      delete process.env["STRUT_MOTHERSHIP_REQUIRED"];
    }
  });

  it("POST /actor/claim: claims every ownerless workflow (or the named ones) for the actor, never one someone else owns", async () => {
    const { strut, call } = await boot({ resolveActor: (c) => c.req.header("x-test-actor") || undefined });
    for (const name of ["a", "b", "c"]) await strut.workspace.publishWorkflow(name, "v1", { steps: STEPS });
    await strut.workspace.setWorkflowOwner("c", "bob-2");
    assert.equal((await call("POST", "/actor/claim", {})).status, 400, "no actor → nothing to claim for");
    assert.equal((await call("POST", "/actor/claim", { workflows: "a" }, { "x-test-actor": "alice-1" })).status, 400);

    const one = await call("POST", "/actor/claim", { workflows: ["a", "nope"] }, { "x-test-actor": "alice-1" });
    assert.equal(one.status, 200);
    assert.deepEqual(one.json.claimed, ["a"]);
    assert.deepEqual(one.json.skipped.map((s: any) => [s.workflow, s.reason]), [["nope", "not found"]]);

    const all = await call("POST", "/actor/claim", {}, { "x-test-actor": "alice-1" });
    assert.equal(all.json.actor, "alice-1");
    assert.deepEqual(all.json.claimed.sort(), ["b", "wf"]);
    assert.deepEqual(
      all.json.skipped.map((s: any) => [s.workflow, s.owner]).sort(),
      [["a", "alice-1"], ["c", "bob-2"]],
    );
    const owners = Object.fromEntries((await call("GET", "/workflows")).json.map((w: any) => [w.name, w.owner]));
    assert.deepEqual(owners, { a: "alice-1", b: "alice-1", c: "bob-2", wf: "alice-1" });
  });
});

// ── Run callbacks (`POST …/run { callback }`, src/callback.ts) ─────────────

describe("run callbacks", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-run-callback-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const echo = defineStep({
    type: "echo",
    input: z.object({ value: z.any() }),
    output: z.any(),
    async run(cfg) {
      return cfg.value;
    },
  });
  const boom = defineStep({
    type: "boom",
    input: z.object({}),
    output: z.any(),
    async run() {
      throw new Error("kaboom");
    },
  });

  const talker = defineStep({
    type: "talker",
    input: z.object({ said: z.string() }),
    output: z.any(),
    async run(cfg) {
      return withMessages({ ok: true }, [{ role: "user", content: cfg.said }]);
    },
  });

  /** A stand-in host: collects what strut posts. */
  async function callbackHost(): Promise<{ url: string; posts: any[]; close: () => void }> {
    const posts: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        posts.push({ path: req.url, body: JSON.parse(body) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/hook?token=s3cret`, posts, close: () => server.close() };
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(cond(), "condition never held");
  }

  const boot = async () => {
    const store = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([echo, boom, talker]),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
    });
    await strut.workspace.publishWorkflow("ok", "v1", {
      steps: [{ id: "e", type: "echo", config: { value: { hi: "there" } } }],
    });
    await strut.workspace.publishWorkflow("bad", "v1", { steps: [{ id: "b", type: "boom", config: {} }] });
    const run = async (path: string, body: unknown) => {
      const res = await strut.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    await strut.workspace.publishWorkflow("chatty", "v1", {
      steps: [
        {
          id: "each",
          type: "foreach",
          config: { items: ["one", "two"], body: { id: "say", type: "talker", config: { said: "{{ $current }}" } } },
        },
      ],
    });
    return { store, run, app: strut.app };
  };

  it("POST …/run { callback } posts the result to the host, recording only the URL's origin", async () => {
    const host = await callbackHost();
    try {
      const { store, run } = await boot();
      const res = await run("/workflows/ok/run", { input: {}, callback: { url: host.url } });
      assert.equal(res.status, 202);
      assert.equal(res.json.callback, true, "the host's proof this server honors callbacks");
      const runId = res.json.runId as string;
      await until(() => host.posts.length === 1);
      const { path, body } = host.posts[0]!;
      assert.equal(path, "/hook?token=s3cret");
      assert.equal(typeof body.durationMs, "number");
      delete body.durationMs;
      assert.deepEqual(body, { event: "run.end", workflow: "ok", runId, status: "success", output: { hi: "there" } });

      // The URL is the host's credential: the record carries its origin, never the URL.
      const events = await store.getRunEvents("ok", runId);
      assert.deepEqual(events.find((e) => e.type === "run.start")!.callback, { origin: new URL(host.url).origin });
      assert.ok(!JSON.stringify(events).includes("s3cret"));
      assert.ok(!JSON.stringify(await store.getRunSummary("ok", runId)).includes("s3cret"));

      // The versioned twin honors it too.
      const pinned = await run("/workflows/ok/v1/run", { input: {}, callback: { url: host.url } });
      assert.equal(pinned.json.callback, true);
      await until(() => host.posts.length === 2);
      assert.equal(host.posts[1]!.body.runId, pinned.json.runId);
    } finally {
      host.close();
    }
  });

  it("links each agent transcript instead of inlining it; the link serves the bare messages", async () => {
    const host = await callbackHost();
    try {
      const { run, app, store } = await boot();
      const { json } = await run("/workflows/chatty/run", { input: {}, callback: { url: host.url } });
      await until(() => host.posts.length === 1);
      const { body } = host.posts[0]!;
      assert.equal(body.status, "success", JSON.stringify(body));
      const paths = (await store.getRunEvents("chatty", json.runId))
        .filter((e) => e.type === "step.end" && e.messages)
        .map((e) => e.path);
      assert.equal(paths.length, 2);
      assert.deepEqual(body.transcripts.map((t: any) => t.step), paths);
      assert.ok(!JSON.stringify(body).includes('"role"'), "no transcript content in the callback");
      for (const [i, t] of body.transcripts.entries()) {
        assert.equal(t.stepType, "talker");
        const res = await app.request(t.url);
        assert.equal(res.status, 200, t.url);
        assert.deepEqual(await res.json(), [{ role: "user", content: ["one", "two"][i] }]);
      }
      assert.equal((await app.request(`/workflows/chatty/runs/${json.runId}/transcripts/nope`)).status, 404);

      // The run read endpoints link the same sessions instead of inlining them.
      const served = (await (await app.request(`/workflows/chatty/runs/${json.runId}/events`)).json()) as any[];
      assert.ok(!served.some((e) => "messages" in e));
      assert.deepEqual(
        served.filter((e) => e.transcript).map((e) => e.transcript),
        body.transcripts.map((t: any) => t.url),
      );
      const sse = await (await app.request(`/workflows/chatty/runs/${json.runId}/stream`)).text();
      assert.ok(!sse.includes('"messages"') && sse.includes('"transcript"'));
    } finally {
      host.close();
    }
  });

  it("a failed run posts status: error with the message", async () => {
    const host = await callbackHost();
    try {
      const { run } = await boot();
      const { json } = await run("/workflows/bad/run", { input: {}, callback: { url: host.url } });
      await until(() => host.posts.length === 1);
      const { body } = host.posts[0]!;
      assert.equal(body.event, "run.end");
      assert.equal(body.runId, json.runId);
      assert.equal(body.status, "error");
      assert.match(body.error.message, /kaboom/);
      assert.equal(body.output, undefined);
    } finally {
      host.close();
    }
  });

  it("a bad callback is a 400 and launches nothing; null means none", async () => {
    const { store, run } = await boot();
    for (const callback of [{}, { url: "nope" }, { url: "ftp://host/x" }, "https://host/x"]) {
      assert.equal((await run("/workflows/ok/run", { input: {}, callback })).status, 400, JSON.stringify(callback));
    }
    assert.deepEqual(await store.listRuns("ok"), []);
    const res = await run("/workflows/ok/run", { input: {}, callback: null });
    assert.equal(res.status, 202);
    assert.equal(res.json.callback, undefined);
    for (let i = 0; i < 200 && !(await store.getRunSummary("ok", res.json.runId)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });
});
