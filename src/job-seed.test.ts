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
import { STRUT_CONCEPTS, conceptFiles } from "./concept-seed.js";

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
      ["job/dir", "foreach", "context/concept", "context/concept", "if", "agent", "acp/prompt", "pack"],
      "job/dir → checkouts → the Job page → the kind's page → strut's agent, or a local one over ACP → pack",
    );
    assert.equal(flow.inputBlock?.["prompt"]?.required ?? true, true);
    for (const k of ["workspace", "kind", "session", "repos", "agent", "mode", "model", "cwd"]) assert.equal(flow.inputBlock?.[k]?.required, false, `${k} is optional`);

    const { tools } = paramsOf(text);
    assert.ok(tools.length > 0);
    for (const t of tools) {
      assert.ok(!t.includes("*"), `strut's own list names steps, never globs: ${t}`);
      assert.ok(registry[t], `a grant strut cannot honor: ${t}`);
    }
  });

  it("no app tools (2026-10-22): an app is the builder's, handed over by name; the reply passes one on as { kind: app, app }", async () => {
    const text = await jobWorkflowYaml();
    const { tools, system } = paramsOf(text);
    for (const t of tools) assert.ok(!t.startsWith("app/"), `the job agent never holds ${t}`);
    assert.ok(JSON.stringify(yaml.load(text)).includes("An app on this server, by name"), "the reply's `app` field");
    assert.ok(!text.includes("an app directory you built"), "no app directory as a deliverable");
    assert.doesNotMatch(system, /app\/init|Job App/);
  });

  it("a repository found mid-turn: git/checkout is granted and the prompt says how, since bash never holds the person's token", async () => {
    const text = await jobWorkflowYaml();
    const { tools, system } = paramsOf(text);
    assert.ok(tools.includes("git/checkout"), "a repository checked out with the person's token, into the job's directory");
    assert.match(system, /git\/checkout with `workdir`\s+your job id/);
    const work = flowFromYaml(JOB_WORKFLOW, "v1", text).steps.find((s) => s.id === "work") as { config: Record<string, unknown> };
    assert.equal(work.config["secretsEnv"], undefined, "no token in the agent's shell");
  });

  it("the agent's instructions are the `Job` page, not this file: the YAML keeps the mechanics, and everything the prompt said before is on the page or the `Browser` page under it", async () => {
    const text = await jobWorkflowYaml();
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const system = flat(paramsOf(text).system);
    // The mechanics stay: the directory, the checkouts, the reply's fields.
    for (const kept of ["Your working directory is the job's", "A `git clone` in bash has no credentials.", "Your deliverables are FILES in the working directory", "put the question in `ask`; their answer is the next turn's message."]) {
      assert.ok(system.includes(kept), kept);
    }
    assert.ok(system.length < 1200, `the mechanics alone (${system.length} chars)`);
    assert.doesNotMatch(system, /VERIFIED|browser-explore|captcha|meta\/|job\/(list|get|read|status)/, "how to work is the page's");

    const files = conceptFiles([STRUT_CONCEPTS]);
    const job = (await files.get("Job"))!;
    const page = flat(job.docs!);
    for (const moved of [
      // The kinds, and a kind's page at the head of a turn.
      "A message that opens with a kind's page is that kind: follow the page.",
      "say in `text` which page you followed",
      "When no kind fits, the work is yours — a plan, a page, notes — as files in your directory.",
      // Running a workflow, here and on a peer.
      'Running a workflow (a person may call one a "strut")',
      "meta/run-workflow runs it as its own run under this job (same job id, same directory)",
      "Prefer running a workflow that does the work over doing it by hand, and say in `text` which one you ran.",
      "its files stay there",
      "also names THIS server (`self`) and its repositories — code there is here",
      // No browser of its own: the `Browser` page says how.
      "You have no browser to look around with",
      "open the `Browser` page under this one and run browser-explore as it says",
      "Never install or launch a browser yourself (playwright, puppeteer, a headless chrome from bash)",
      // Earlier jobs.
      "look before starting over: `job/list { q }` finds earlier jobs by words",
      "Say in `text` which job you built on.",
      "never as a path in `text`, which they cannot open",
      "another job's directory is not yours to write",
      // Done means verified.
      "The work is done when it is VERIFIED, not when your last tool call returned.",
      "meta/add-claim with subject { kind: job, name: <your job id> }",
      "ONE claim for a change; several only when the ask has separate parts, one per part.",
      "a page: browser/verify (browser/walkthrough for a flow, a frame per step)",
      "an endpoint: http/verify",
      'exec with `cwd: "{{ input.dir }}"`',
      "an external check ({ description })",
      "Never a check that reads your own diff or code",
      "hang your check on their claim rather than writing a second",
      "call meta/verify-job",
      "Refuted means not done — fix the work (or a wrong check, meta/edit-check), verify again, and only then answer.",
      "making something and checking it are two steps",
    ]) {
      assert.ok(page.includes(moved), moved);
    }
    // The page fits the read's cap, which the workflow raises for it.
    const concepts = flowFromYaml(JOB_WORKFLOW, "v1", text).steps.find((st) => st.id === "concepts") as { config: Record<string, unknown> };
    assert.deepEqual(concepts.config, { name: "{{ params.concept }}", max: 10000 });
    assert.ok(job.docs!.length < 10000, `the Job page fits its cap (${job.docs!.length} chars)`);

    // Looking at a site is a kind under Job: the call, what it answers, the
    // screenshots, and the captcha a person solves.
    assert.ok(job.children.some((c) => c.name === "Browser"), "listed under Job");
    const browser = flat((await files.get("Browser"))!.docs!);
    for (const moved of [
      'meta/run-workflow { name: "browser-explore", input: { goal, url } }',
      "with a goal that stands alone, since it sees nothing of this conversation",
      "answers { answer, evidence: [{ path, url }], pages }",
      "shots/NNN.png",
      "a link to report as an image artifact",
      "Never install or launch a browser yourself",
      "A captcha is the person's to solve, never yours.",
      "run browser-captcha { session }",
      "list its `artifact` as given and end the turn with `ask`",
      "`[captcha-answer] {…}`",
      "run browser-captcha { session, answer: that JSON } at once — a challenge expires",
      "`solved`: run browser-explore { goal, url, session } at once",
      "`failed`: say so in `text`.",
    ]) {
      assert.ok(browser.includes(moved), moved);
    }
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

  it("a job's kind opens the turn's prompt with that kind's page, after the job's own lines and before the message; a kind with no page adds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "job-seed-kind-"));
    try {
      const prompts: string[] = [];
      const fakeAgent = defineStep({
        type: "agent",
        input: z.object({ prompt: z.string() }).passthrough(),
        output: z.any(),
        async run(cfg) {
          prompts.push(cfg.prompt);
          return { result: "ok", object: { text: "ok", artifacts: [] }, steps: 1, usage: {}, cost: 0 };
        },
      });
      // Stands in for context/concept over a graph holding one kind's page.
      const fakeConcept = defineStep({
        type: "context/concept",
        input: z.object({ name: z.string().optional() }).passthrough(),
        output: z.any(),
        async run(cfg) {
          return { text: cfg.name === "Code Change" ? "PAGE: how a code change is done here." : "" };
        },
      });
      const strut = await createStrut({ workspace: new WorkspaceManager(dir), registry: await createRegistry([fakeAgent, fakeConcept]), ...quiet });
      const { kindLead, kindEnd } = (yaml.load(await jobWorkflowYaml()) as { params: { kindLead: string; kindEnd: string } }).params;
      const job = "job-kind-test";

      const coded = await strut.run(JOB_WORKFLOW, { prompt: "Add the line.", workspace: "acme", kind: "Code Change" }, { job });
      assert.equal(coded.status, "success", JSON.stringify(coded.error));
      assert.equal(prompts[0], `This job runs on this server, @acme. Your job id: ${job}. ${kindLead}PAGE: how a code change is done here.${kindEnd}Add the line.`);
      assert.ok(kindLead.includes("\n\n") && kindEnd.includes("\n\n"), "the page stands apart from the lines around it");

      const unknown = await strut.run(JOB_WORKFLOW, { prompt: "Again.", kind: "Nope" }, { job });
      assert.equal(unknown.status, "success", JSON.stringify(unknown.error));
      assert.equal(prompts[1], `Your job id: ${job}. Again.`, "no page for the kind: the prompt as without one");
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
      assert.equal(turns[0]!.prompt, `This job runs on this server, @acme. Your job id: ${job}. Plan dark mode.`, "the server line, then the job's id");
      assert.deepEqual(turns[0]!.tools, paramsOf(await jobWorkflowYaml()).tools, "params.tools reaches agentTools");
      // No graph: the `Job` page all the same, read from the file strut
      // ships — the agent's instructions, and the kinds under it.
      const system = turns[0]!.system;
      assert.ok(system.startsWith(paramsOf(await jobWorkflowYaml()).system.trimEnd()), "the mechanics lead");
      assert.ok(system.includes('Knowledge on this server — the "Job" Concept'), "then the Job page");
      assert.ok(system.includes("The work is done when it is VERIFIED") && system.includes("To record a new kind, add a child Concept here"), "its docs, whole");
      assert.ok(system.includes("- Browser — Looking at a site or a running app") && system.includes("- Plan — "), "and the kinds under it");
      assert.ok(system.includes('graph_graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'), "opened as on a graph");
      assert.ok(system.includes("`{{ input.urls.pod }}/<path>`"), "a check's own template reaches the agent as text");
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
      assert.equal(turns[2]!.prompt, "Just a note.", "no job, no id line");
      const own = ((await (await strut.app.request(`/workflows/${JOB_WORKFLOW}/runs/${alone.runId}/artifacts`)).json()) as { artifacts: Array<{ url?: string }> }).artifacts;
      assert.deepEqual(own.map((l) => l.url), [`/artifacts/${alone.runId}/plan.md`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
