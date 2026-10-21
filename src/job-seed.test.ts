import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { defineStep } from "./core.js";
import { contentHash } from "./version.js";
import { createRegistry } from "./steps/registry.js";
import { validateWorkflowYaml } from "./validate.js";
import { WorkspaceManager, flowFromYaml } from "./workspace.js";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { JOB_WORKFLOW, jobWorkflowYaml } from "./job-seed.js";

type Params = { tools: string[]; system: string };
const paramsOf = (text: string) => (yaml.load(text) as { params: Params }).params;

const quiet = { serveUi: false, enableChat: false, scheduler: false, stt: false as const, store: new MemoryRunStore() };

describe("the job workflow strut ships (plans/jobs.md §5)", () => {
  it("the template is a valid workflow over strut's own registry, and every grant is a strut step", async () => {
    const text = await jobWorkflowYaml();
    const registry = await createRegistry([]);
    const v = validateWorkflowYaml(text, { registry });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));

    const flow = flowFromYaml(JOB_WORKFLOW, "v1", text);
    assert.deepEqual(
      flow.steps.map((s) => s.type),
      ["job/dir", "foreach", "context/concept", "if", "agent", "acp/prompt", "pack"],
      "job/dir → checkouts → the Job page → strut's agent, or a local one over ACP → pack",
    );
    assert.equal(flow.inputBlock?.["prompt"]?.required ?? true, true);
    for (const k of ["workspace", "session", "repos", "agent", "mode", "model", "cwd"]) assert.equal(flow.inputBlock?.[k]?.required, false, `${k} is optional`);

    const { tools } = paramsOf(text);
    assert.ok(tools.length > 0);
    for (const t of tools) {
      assert.ok(!t.includes("*"), `strut's own list names steps, never globs: ${t}`);
      assert.ok(registry[t], `a grant strut cannot honor: ${t}`);
    }
  });

  it("a job's app (plans/apps.md §6, §8): the agent may scaffold, build and read one — never publish or check one out, the authoring writes; the reply hands one over as kind app", async () => {
    const text = await jobWorkflowYaml();
    const { tools } = paramsOf(text);
    for (const t of ["app/init", "app/build", "app/get"]) assert.ok(tools.includes(t), `the job agent holds ${t}`);
    for (const t of ["app/publish", "app/checkout"]) assert.ok(!tools.includes(t), `the job agent never holds ${t}`);
    assert.ok(text.includes("`app` for an app directory you built"), "the reply's artifact kind names it");
    // How to hand one over is the `Job App` page under `Job` (concept-seed.test.ts), not prompt text.
    assert.doesNotMatch(paramsOf(text).system, /app\/init|kind: "app"/);
  });

  it("the host's delta is appended — its grants after strut's, its section after strut's prompt — and changes the hash; nothing else does", async () => {
    const plain = await jobWorkflowYaml();
    const section = "Before you act, open the `Job` Concept and follow the kind's page.";
    const delta = await jobWorkflowYaml({ tools: ["pod/*", "browser/*"], system: `\n${section}\n` });

    const p = paramsOf(plain);
    const d = paramsOf(delta);
    assert.deepEqual(d.tools, [...p.tools, "pod/*", "browser/*"]);
    assert.ok(d.system.startsWith(p.system.trimEnd()), "strut's prompt leads");
    assert.equal(d.system.slice(p.system.trimEnd().length), `\n\n${section}\n`, "the host's section follows, once");

    assert.notEqual(contentHash(plain), contentHash(delta));
    assert.equal(contentHash(await jobWorkflowYaml()), contentHash(plain), "the dump is deterministic");
    assert.equal(contentHash(await jobWorkflowYaml({ tools: [], system: "  " })), contentHash(plain), "an empty delta is no delta");
    // The delta's document is still the same workflow.
    assert.equal(validateWorkflowYaml(delta, { registry: await createRegistry([]) }).ok, true);
  });

  it("createStrut seeds it by content hash: once, as a seed; a reboot is a no-op; every boot makes git's template active — over a workspace edit, and again when a delta is taken back out; a changed delta publishes; `job: false` seeds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "job-seed-"));
    try {
      const ws = () => new WorkspaceManager(dir);
      const versionsOf = async (strut: Awaited<ReturnType<typeof createStrut>>) =>
        ((await (await strut.app.request(`/workflows/${JOB_WORKFLOW}/versions`)).json()) as { versions: Array<{ version: string; source?: string }> }).versions
          .slice()
          .sort((x, y) => x.version.localeCompare(y.version));
      const activeOf = async () => (await ws().getWorkflowMetadata(JOB_WORKFLOW))!.active;

      const a = await createStrut({ workspace: ws(), ...quiet });
      const listed = (await (await a.app.request("/workflows")).json()) as Array<{ name: string; category?: string; description?: string }>;
      const entry = listed.find((w) => w.name === JOB_WORKFLOW);
      assert.ok(entry, "job is listed");
      assert.equal(entry!.category, "job");
      assert.match(entry!.description ?? "", /job's directory/);
      assert.deepEqual((await versionsOf(a)).map((v) => [v.version, v.source]), [["v1", "seed"]]);

      // Same template again: nothing published.
      const b = await createStrut({ workspace: ws(), ...quiet });
      assert.deepEqual((await versionsOf(b)).map((v) => v.version), ["v1"]);

      // A seed always matches git: a workspace-side edit (the UI, the
      // builder) is active until the next boot, which makes the committed
      // template active again. The edit stays in the history.
      const edited = (await ws().getWorkflowSource(JOB_WORKFLOW, "v1")).replace("maxSteps: 500", "maxSteps: 50");
      await ws().publishWorkflow(JOB_WORKFLOW, "v2", edited, undefined, undefined, undefined, { source: "ui" });
      assert.equal(await activeOf(), "v2");
      const c = await createStrut({ workspace: ws(), ...quiet });
      assert.equal(await activeOf(), "v1", "the boot put git's template back");
      assert.deepEqual((await versionsOf(c)).map((v) => [v.version, v.source]), [["v1", "seed"], ["v2", "ui"]]);

      // The host's delta is a new template: published and activated.
      await createStrut({ workspace: ws(), ...quiet, job: { tools: ["pod/*"] } });
      assert.equal(await activeOf(), "v3");
      assert.deepEqual(paramsOf(await ws().getWorkflowSource(JOB_WORKFLOW, "v3")).tools.at(-1), "pod/*");
      const meta = await ws().getWorkflowMetadata(JOB_WORKFLOW);
      assert.equal(meta!.versions["v3"]!.source, "seed");
      assert.equal(meta!.category, "job");

      // The delta taken back out: the template is v1's text again, and v1 is
      // made active — nothing new published.
      await createStrut({ workspace: ws(), ...quiet });
      assert.equal(await activeOf(), "v1");
      assert.deepEqual((await versionsOf(c)).map((v) => v.version), ["v1", "v2", "v3"]);

      // Off.
      const fresh = await mkdtemp(join(tmpdir(), "job-seed-off-"));
      try {
        const off = await createStrut({ workspace: new WorkspaceManager(fresh), ...quiet, job: false });
        const names = ((await (await off.app.request("/workflows")).json()) as Array<{ name: string }>).map((w) => w.name);
        assert.ok(!names.includes(JOB_WORKFLOW));
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs on strut alone: with `job` on the launch the agent works in the job's directory on the job's thread and the artifacts resolve into it; without one it is a one-shot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "job-seed-run-"));
    try {
      const turns: Array<{ cwd: string; session: string | undefined; prompt: string; tools: unknown; system: string }> = [];
      // Stands in for the core `agent` step: writes the plan into its cwd and
      // answers in the step's output shape (`object` is the structured answer).
      const fakeAgent = defineStep({
        type: "agent",
        input: z.object({ cwd: z.string(), prompt: z.string(), session: z.string().optional(), agentTools: z.any(), system: z.string() }).passthrough(),
        output: z.any(),
        async run(cfg) {
          turns.push({ cwd: cfg.cwd, session: cfg.session, prompt: cfg.prompt, tools: cfg.agentTools, system: cfg.system });
          const { writeFileSync } = await import("node:fs");
          writeFileSync(join(cfg.cwd, "plan.md"), `# Plan (turn ${turns.length})\n`);
          return { result: "wrote the plan", object: { text: "wrote the plan", artifacts: [{ id: "plan", title: "Plan", path: "plan.md" }] }, steps: 1, usage: {}, cost: 0 };
        },
      });
      const strut = await createStrut({ workspace: new WorkspaceManager(dir), registry: await createRegistry([fakeAgent]), ...quiet });
      const job = "job-seed-test";

      const first = await strut.run(JOB_WORKFLOW, { prompt: "Plan dark mode.", workspace: "acme" }, { job });
      assert.equal(first.status, "success", JSON.stringify(first.error));
      const out = first.output as { text: string; artifacts: Array<{ id: string; path: string }>; ask?: unknown };
      assert.deepEqual([out.text, out.artifacts], ["wrote the plan", [{ id: "plan", title: "Plan", path: "plan.md" }]]);
      assert.equal(out.ask, undefined);
      assert.equal(turns[0]!.cwd, join(dir, "jobs", job), "the job's directory");
      assert.equal(turns[0]!.session, job, "the job's thread");
      assert.equal(turns[0]!.prompt, "Workspace: @acme, the one this strut belongs to. Plan dark mode.");
      assert.deepEqual(turns[0]!.tools, paramsOf(await jobWorkflowYaml()).tools, "params.tools reaches agentTools");
      assert.equal(turns[0]!.system.trimEnd(), paramsOf(await jobWorkflowYaml()).system.trimEnd(), "no graph: strut's prompt alone, no Concept section");
      assert.ok(existsSync(join(dir, "jobs", job, "plan.md")));

      const links = ((await (await strut.app.request(`/workflows/${JOB_WORKFLOW}/runs/${first.runId}/artifacts`)).json()) as { artifacts: Array<{ id: string; kind?: string; url?: string }> }).artifacts;
      assert.deepEqual(links.map((l) => [l.id, l.kind, l.url]), [["plan", "markdown", `/jobs/${job}/files/plan.md`]]);

      // The same job again: the same directory, the same thread, the file revised in place.
      const second = await strut.run(JOB_WORKFLOW, { prompt: "Add a toggle.", session: "side-thread" }, { job });
      assert.equal(second.status, "success", JSON.stringify(second.error));
      assert.equal(turns[1]!.cwd, turns[0]!.cwd);
      assert.equal(turns[1]!.session, "side-thread", "a session on the input picks the thread, the directory stays the job's");
      assert.equal(readFileSync(join(dir, "jobs", job, "plan.md"), "utf-8"), "# Plan (turn 2)\n");

      // No job: a one-shot in the run's own artifact directory, a cold agent.
      const alone = await strut.run(JOB_WORKFLOW, { prompt: "Just a note." });
      assert.equal(alone.status, "success", JSON.stringify(alone.error));
      assert.equal(turns[2]!.session, undefined);
      assert.equal(turns[2]!.cwd, join(dir, "artifacts", alone.runId));
      const own = ((await (await strut.app.request(`/workflows/${JOB_WORKFLOW}/runs/${alone.runId}/artifacts`)).json()) as { artifacts: Array<{ url?: string }> }).artifacts;
      assert.deepEqual(own.map((l) => l.url), [`/artifacts/${alone.runId}/plan.md`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
