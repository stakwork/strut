import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import type { StepContext } from "./core.js";
import type { Proposal, ProposalsCapability } from "./proposals.js";
import type { Automations } from "./scheduler.js";

// meta/set-automation: the builder job schedules a workflow it published —
// only one stamped `ai`, only once a person allowed it, after its publish.

const yaml = (name: string) => `name: ${name}\nsteps:\n  - id: say\n    type: log\n    config:\n      message: hi\n`;
const weekly = { every: "week", on: ["mon"], at: ["09:00"], tz: "Europe/London" };

describe("meta/set-automation", () => {
  let dir = "";
  let strut: Strut<Record<string, unknown>>;
  const run = (cfg: unknown, extra: Partial<StepContext> = {}) =>
    strut.getRegistry()["meta/set-automation"]!.run(cfg, {
      runId: "r1",
      path: "wf/set",
      scope: {},
      input: {},
      emit: async () => {},
      services: strut.services,
      proposal: { id: "p-test", by: { workflow: "builder", runId: "r0" } },
      ...extra,
    });
  const automations = () => (strut.services as unknown as { automations: { api: Automations } }).automations.api;
  const proposals = () => (strut.services as unknown as { proposals: ProposalsCapability }).proposals;
  const decide = async (id: string, action: "accept" | "reject") => {
    const res = await strut.app.request(`/proposals/${id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    return { status: res.status, body: (await res.json()) as Proposal & { error?: string; proposal?: Proposal } };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-set-automation-"));
    strut = await createStrut({ workspace: new WorkspaceManager(dir), serveUi: false, enableChat: false, scheduler: false });
  });
  after(async () => {
    await strut.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a seeded or a person's workflow, and a workflow that does not exist", async () => {
    await strut.workspace.publishWorkflowByContent("persons", yaml("persons"), undefined, undefined, undefined);
    await assert.rejects(() => run({ workflow: "persons", name: "x", trigger: weekly }), /was not published through meta\/publish-workflow \(publisher: none\)/);
    await assert.rejects(() => run({ workflow: "job", name: "x", trigger: weekly }), /was not published through meta\/publish-workflow/);
    await assert.rejects(() => run({ workflow: "nowhere", name: "x", trigger: weekly }), /not found — publish it with meta\/publish-workflow first/);
    assert.deepEqual(await automations().list("persons"), []);
  });

  it("runs only as an accepted proposal: a tool call, a DAG step, meta/run-step or a subflow is refused", async () => {
    await strut.workspace.publishWorkflowByContent("ai-direct", yaml("ai-direct"), undefined, undefined, "ai");
    const cfg = { workflow: "ai-direct", name: "x", trigger: weekly };
    await assert.rejects(() => run(cfg, { agentTool: true, proposal: undefined }), /runs only as a proposal a person accepted/);
    await assert.rejects(() => run(cfg, { proposal: undefined }), /runs only as a proposal a person accepted/);
    const authoring = (strut.services as unknown as { authoring: { runStep(t: string, a: unknown): Promise<{ error?: string }> } }).authoring;
    assert.ok((await authoring.runStep("meta/set-automation", { config: cfg })).error, "meta/run-step may not run it");
    // An AI workflow whose own DAG holds the step, run as a subflow would be.
    await strut.workspace.publishWorkflowByContent(
      "ai-dag",
      `name: ai-dag\nsteps:\n  - id: s\n    type: meta/set-automation\n    config:\n      workflow: ai-direct\n      name: x\n      trigger: { every: week, on: [mon], at: ["09:00"], tz: Europe/London }\n`,
      undefined,
      undefined,
      "ai",
    );
    const dag = await strut.run("ai-dag", {});
    assert.equal(dag.status, "error");
    assert.deepEqual(await automations().list("ai-direct"), []);
  });

  it("as a proposal: waits for the pending publish of its workflow, then schedules it; pause and remove by id", async () => {
    const by = { workflow: "builder", runId: "r2", path: "builder/turn/001", job: "j-1" };
    const publish = await proposals().propose({ step: "meta/publish-workflow", input: { name: "weekly-top", yaml: yaml("weekly-top") }, title: "Publish.", by });
    const schedule = await proposals().propose({ step: "meta/set-automation", input: { workflow: "weekly-top", name: "Weekly top", trigger: weekly }, title: "Schedule.", by });

    const early = await decide(schedule.id, "accept");
    assert.equal(early.status, 409);
    assert.match(early.body.error!, new RegExp(`applies after "${publish.id}" \\(meta/publish-workflow\\)`));
    assert.equal(early.body.proposal?.status, "pending");

    assert.equal((await decide(publish.id, "accept")).body.status, "applied");
    const applied = await decide(schedule.id, "accept");
    assert.equal(applied.body.status, "applied", JSON.stringify(applied.body.result));
    const [made] = await automations().list("weekly-top");
    assert.equal(made?.name, "Weekly top");
    assert.equal(made?.enabled, true);

    // A rejected publish leaves the schedule nothing to wait for, and nothing to schedule.
    const p2 = await proposals().propose({ step: "meta/publish-workflow", input: { name: "never", yaml: yaml("never") }, title: "Publish.", by });
    const s2 = await proposals().propose({ step: "meta/set-automation", input: { workflow: "never", name: "Never", trigger: weekly }, title: "Schedule.", by });
    await decide(p2.id, "reject");
    const failed = await decide(s2.id, "accept");
    assert.equal(failed.body.status, "failed");
    assert.match(failed.body.result?.error ?? "", /not found/);

    const paused = (await run({ workflow: "weekly-top", id: made!.id, enabled: false })) as { automation: { enabled: boolean } };
    assert.equal(paused.automation.enabled, false);
    assert.deepEqual(await run({ workflow: "weekly-top", id: made!.id, remove: true }), { removed: made!.id });
    assert.deepEqual(await automations().list("weekly-top"), []);
  });
});
