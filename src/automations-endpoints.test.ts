/**
 * The automations HTTP door, end to end over a real `createStrut`
 * (plans/automations.md §7): CRUD on workflow metadata, the preview, and a
 * fire that launches a REAL run stamped `origin: "schedule"` whose output
 * the next fire reads back as `last`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";

const WF = "echo";
// The run's output is its last step's: `pack` returns its resolved config.
const steps = [{ id: "out", type: "pack", config: { newest_id: "{{ input.since_id || 'first' }}-next" } }];

describe("automations endpoints", () => {
  let dir: string;
  let strut: Strut;
  let store: MemoryRunStore;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    dir = join(tmpdir(), `strut-autos-ep-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    store = new MemoryRunStore();
    strut = await createStrut({ workspace: new WorkspaceManager(dir), store, serveUi: false, scheduler: false });
    await strut.workspace.publishWorkflow(WF, "v1", { steps });
  });
  afterEach(async () => {
    await strut.close();
    await rm(dir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
  });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await strut.app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  /** Wait for a detached run to write its summary. */
  const finished = async (runId: string) => {
    for (let i = 0; i < 200; i++) {
      const s = await store.getRunSummary(WF, runId);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`run ${runId} never finished`);
  };

  it("create → list → patch → delete, all on workflow metadata", async () => {
    const made = await call("POST", `/workflows/${WF}/automations`, { name: "Morning", trigger: { every: "week", on: ["mon", "fri"], at: ["09:00"], tz: "America/New_York" } });
    assert.equal(made.status, 201);
    assert.equal(made.json.automation.summary, "Mon, Fri at 9:00 AM (New York time)");
    assert.equal(made.json.next.length, 5);
    const id = made.json.automation.id as string;

    const listed = await call("GET", `/automations?workflow=${WF}`);
    assert.deepEqual(listed.json.automations.map((a: any) => [a.id, a.workflow, a.enabled, a.lastRun, a.running]), [[id, WF, true, null, false]]);
    assert.equal((await call("GET", "/automations")).json.automations.length, 1);
    const wfEntry = (await call("GET", "/workflows")).json.find((w: any) => w.name === WF);
    assert.equal(wfEntry.automations.length, 1, "GET /workflows carries them — the sidebar badge reads this");

    const paused = await call("PATCH", `/workflows/${WF}/automations/${id}`, { enabled: false });
    assert.deepEqual([paused.status, paused.json.automation.enabled, paused.json.automation.nextRunAt], [200, false, null]);
    assert.equal((await strut.workspace.getWorkflowMetadata(WF))?.active, "v1", "pausing published nothing");

    assert.equal((await call("DELETE", `/workflows/${WF}/automations/${id}`)).status, 200);
    assert.equal((await call("DELETE", `/workflows/${WF}/automations/${id}`)).status, 404);
    assert.deepEqual((await call("GET", "/automations")).json.automations, []);
  });

  it("bad drafts are a 400 that names the problem; an unknown workflow is a 404", async () => {
    const bad = await call("POST", `/workflows/${WF}/automations`, { name: "x", trigger: { every: "day", at: ["9am"] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /HH:MM/);
    assert.equal((await call("POST", `/workflows/nope/automations`, { name: "x", trigger: { every: "day", at: ["09:00"] } })).status, 404);
  });

  it("preview returns the sentence and the next fires without writing", async () => {
    const p = await call("POST", "/automations/preview", { trigger: { every: "month", day: { nth: "last", weekday: "fri" }, at: ["16:00"], tz: "UTC" } });
    assert.equal(p.status, 200);
    assert.equal(p.json.summary, "The last Friday of each month at 4:00 PM (UTC)");
    assert.equal(p.json.next.length, 5);
    assert.equal((await call("POST", "/automations/preview", { trigger: { every: "cron" } })).status, 400);
    assert.deepEqual((await call("GET", "/automations")).json.automations, []);
  });

  it("fire launches a real run stamped as scheduled, and the next fire reads its output as `last`", async () => {
    const made = await call("POST", `/workflows/${WF}/automations`, { name: "Poll", trigger: { every: "day", at: ["09:00"], tz: "UTC" }, input: { since_id: "{{ last.output.newest_id }}" } });
    const id = made.json.automation.id as string;

    const first = await call("POST", `/workflows/${WF}/automations/${id}/fire`);
    assert.equal(first.status, 202);
    const s1 = await finished(first.json.runId);
    assert.deepEqual([s1.status, s1.automation, s1.output], ["success", { id }, { newest_id: "first-next" }]);
    const start = (await store.getRunEvents(WF, first.json.runId)).find((e) => e.type === "run.start")!;
    assert.deepEqual([start.origin, start.automation], ["schedule", { id }]);

    const view = (await call("GET", `/automations?workflow=${WF}`)).json.automations[0];
    assert.deepEqual([view.lastRun.runId, view.lastRun.status, view.running], [first.json.runId, "success", false]);

    const second = await call("POST", `/workflows/${WF}/automations/${id}/fire`);
    assert.deepEqual((await finished(second.json.runId)).output, { newest_id: "first-next-next" }, "the cursor came from the first run's output");
  });

  it("mutations and fire need the API key when one is configured; reads do not", async () => {
    const made = await call("POST", `/workflows/${WF}/automations`, { name: "Morning", trigger: { every: "day", at: ["09:00"], tz: "UTC" } });
    const id = made.json.automation.id as string;
    process.env["STRUT_API_KEY"] = "sekret";
    for (const [method, path] of [
      ["POST", `/workflows/${WF}/automations`],
      ["PATCH", `/workflows/${WF}/automations/${id}`],
      ["DELETE", `/workflows/${WF}/automations/${id}`],
      ["POST", `/workflows/${WF}/automations/${id}/fire`],
    ] as const) {
      assert.equal((await call(method, path, {})).status, 401, `${method} ${path}`);
    }
    assert.equal((await call("GET", "/automations")).status, 200);
    assert.equal((await call("PATCH", `/workflows/${WF}/automations/${id}`, { name: "Renamed" }, { authorization: "Bearer sekret" })).status, 200);
  });
});
