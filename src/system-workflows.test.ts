import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "./steps/registry.js";
import { validateWorkflowYaml } from "./validate.js";
import { WorkspaceManager, flowFromYaml } from "./workspace.js";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { SYSTEM_DIR, installSystemWorkflow, installSystemWorkflows, isSystemWorkflow, shippedVersionLabel } from "./system-workflows.js";

const yamlV = (n: number) => `name: sys\ndescription: A system workflow.\nsteps:\n  - id: out\n    type: pack\n    config: { n: ${n} }\n`;
const automationJson = { name: "Sys", trigger: { every: "day", at: ["12:30"] } };

describe("system workflows", () => {
  let dir: string;
  let ws: WorkspaceManager;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-system-"));
    ws = new WorkspaceManager(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("tidy-memory is a valid workflow: one agent over the memory read steps and merge, no model, output { text, cost }", async () => {
    const text = await readFile(join(SYSTEM_DIR, "tidy-memory", "workflow.yaml"), "utf-8");
    const v = validateWorkflowYaml(text, { registry: await createRegistry([]) });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));
    const flow = flowFromYaml("tidy-memory", "v1", text);
    assert.deepEqual(flow.steps.map((s) => s.type), ["agent", "pack"]);
    const cfg = flow.steps[0]!.config as Record<string, unknown>;
    assert.deepEqual(cfg["agentTools"], ["memory/duplicates", "memory/get", "memory/merge"]);
    assert.deepEqual(cfg["toolFilter"], ["none"]);
    assert.equal(cfg["model"], undefined);
    assert.deepEqual(flow.steps[1]!.config, { text: "{{ tidy.result }}", cost: "{{ tidy.cost }}" });
    assert.ok(isSystemWorkflow("tidy-memory"));
    assert.ok(!isSystemWorkflow("job"));
  });

  it("a fresh workspace gets the workflow at its shipped version, category system, with its automation off", async () => {
    const r = await installSystemWorkflow(ws, "sys", yamlV(1), automationJson);
    assert.equal(r.action, "created");
    const meta = (await ws.getWorkflowMetadata("sys"))!;
    assert.equal(meta.active, shippedVersionLabel(yamlV(1)));
    assert.match(meta.active, /^s-[0-9a-f]{8}$/);
    assert.equal(meta.category, "system");
    assert.equal(meta.automations?.length, 1);
    const [a] = meta.automations!;
    assert.equal(a!.id, r.automation);
    assert.equal(a!.enabled, false);
    assert.deepEqual({ every: a!.trigger.every, at: (a!.trigger as { at: string[] }).at }, { every: "day", at: ["12:30"] });

    assert.equal((await installSystemWorkflow(ws, "sys", yamlV(1), automationJson)).action, "unchanged");
    assert.deepEqual((await ws.getWorkflowMetadata("sys"))!.automations, meta.automations);
  });

  it("an older shipped version moves forward; the automation's enabled flag and trigger are left alone", async () => {
    await installSystemWorkflow(ws, "sys", yamlV(1), automationJson);
    const [a] = (await ws.getWorkflowMetadata("sys"))!.automations!;
    const mine = { ...a!, enabled: true, trigger: { ...a!.trigger, at: ["08:00"] } as typeof a.trigger };
    await ws.setWorkflowAutomations("sys", [mine]);

    const r = await installSystemWorkflow(ws, "sys", yamlV(2), automationJson);
    assert.equal(r.action, "updated");
    const meta = (await ws.getWorkflowMetadata("sys"))!;
    assert.equal(meta.active, shippedVersionLabel(yamlV(2)));
    assert.deepEqual(meta.automations, [mine]);
  });

  it("a seed always matches git: over a version edited in strut, the shipped one is active again, new or known; the edit stays in the history", async () => {
    await installSystemWorkflow(ws, "sys", yamlV(1), automationJson);
    await ws.publishWorkflow("sys", "v1", yamlV(99), undefined, undefined, undefined, { source: "ui" });

    const r = await installSystemWorkflow(ws, "sys", yamlV(2), automationJson);
    assert.equal(r.action, "updated");
    const meta = (await ws.getWorkflowMetadata("sys"))!;
    assert.equal(meta.active, shippedVersionLabel(yamlV(2)));
    assert.ok(meta.versions["v1"], "the edit is kept");

    await ws.setActiveVersion("sys", "v1");
    const again = await installSystemWorkflow(ws, "sys", yamlV(2), automationJson);
    assert.equal(again.action, "updated");
    assert.equal((await ws.getWorkflowMetadata("sys"))!.active, shippedVersionLabel(yamlV(2)), "a known shipped version is made active again");
  });

  it("an automation still carrying a former shipped name takes the new one; a name the user chose is left alone", async () => {
    const renamed = { ...automationJson, name: "Merge duplicates", formerNames: ["Tidy memory"] };
    await installSystemWorkflow(ws, "sys", yamlV(1), { ...automationJson, name: "Tidy memory" });
    const [a] = (await ws.getWorkflowMetadata("sys"))!.automations!;
    const mine = { ...a!, enabled: true, trigger: { ...a!.trigger, at: ["08:00"] } as typeof a.trigger };
    await ws.setWorkflowAutomations("sys", [mine]);

    await installSystemWorkflow(ws, "sys", yamlV(1), renamed);
    assert.deepEqual((await ws.getWorkflowMetadata("sys"))!.automations, [{ ...mine, name: "Merge duplicates" }]);

    await ws.setWorkflowAutomations("sys", [{ ...mine, name: "My cleanup" }]);
    await installSystemWorkflow(ws, "sys", yamlV(1), renamed);
    assert.deepEqual((await ws.getWorkflowMetadata("sys"))!.automations, [{ ...mine, name: "My cleanup" }]);
  });

  it("a deleted automation is recreated, off", async () => {
    await installSystemWorkflow(ws, "sys", yamlV(1), automationJson);
    const [before] = (await ws.getWorkflowMetadata("sys"))!.automations!;
    await ws.setWorkflowAutomations("sys", []);

    const r = await installSystemWorkflow(ws, "sys", yamlV(1), automationJson);
    assert.equal(r.action, "unchanged");
    const [after] = (await ws.getWorkflowMetadata("sys"))!.automations!;
    assert.equal(after!.id, r.automation);
    assert.notEqual(after!.id, before!.id);
    assert.equal(after!.enabled, false);
  });

  it("a same-named workflow strut never shipped is the user's own and is left alone", async () => {
    await ws.publishWorkflow("sys", "v1", yamlV(7), undefined, "mine");
    const r = await installSystemWorkflow(ws, "sys", yamlV(1), automationJson);
    assert.equal(r.action, "skipped");
    const meta = (await ws.getWorkflowMetadata("sys"))!;
    assert.deepEqual(Object.keys(meta.versions), ["v1"]);
    assert.equal(meta.category, "mine");
    assert.equal(meta.automations, undefined);
  });

  it("a system workflow strut no longer ships has its automations switched off at boot", async () => {
    await installSystemWorkflow(ws, "gone", yamlV(1), automationJson);
    const [a] = (await ws.getWorkflowMetadata("gone"))!.automations!;
    await ws.setWorkflowAutomations("gone", [{ ...a!, enabled: true }]);
    await ws.publishWorkflow("mine", "v1", yamlV(2));
    await ws.setWorkflowAutomations("mine", [{ ...a!, id: "a-mine", enabled: true }]);

    await installSystemWorkflows(ws);
    assert.equal((await ws.getWorkflowMetadata("gone"))!.automations![0]!.enabled, false);
    assert.equal((await ws.getWorkflowMetadata("mine"))!.automations![0]!.enabled, true, "not a system workflow: untouched");
    assert.equal((await ws.getWorkflowMetadata("tidy-memory"))!.automations![0]!.enabled, false, "shipped, installed off");
  });

  it("createStrut installs tidy-memory at boot, and GET /automations carries each workflow's category", async () => {
    const strut = await createStrut({ workspace: ws, store: new MemoryRunStore(), serveUi: false, enableChat: false, scheduler: false, stt: false });
    try {
      await ws.publishWorkflow("mine", "v1", yamlV(1));
      await strut.app.request("/workflows/mine/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Mine", trigger: { every: "day", at: ["09:00"] } }),
      });
      const res = await strut.app.request("/automations");
      const { automations } = (await res.json()) as { automations: Array<{ workflow: string; name: string; enabled: boolean; category?: string }> };
      const tidy = automations.find((a) => a.workflow === "tidy-memory")!;
      assert.deepEqual({ name: tidy.name, enabled: tidy.enabled, category: tidy.category }, { name: "Merge duplicates", enabled: false, category: "system" });
      assert.equal(automations.find((a) => a.workflow === "mine")!.category, undefined);
      const one = (await (await strut.app.request("/automations?workflow=tidy-memory")).json()) as { automations: Array<{ category?: string }> };
      assert.equal(one.automations[0]!.category, "system");
    } finally {
      await strut.close();
    }
  });
});
