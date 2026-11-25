import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { defineStep, mediaOf } from "./core.js";
import { contentHash } from "./version.js";
import { createRegistry } from "./steps/registry.js";
import { validateWorkflowYaml } from "./validate.js";
import { WorkspaceManager, flowFromYaml } from "./workspace.js";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { JOB_WORKFLOW, jobWorkflowYaml } from "./job-seed.js";
import { builderWorkflowYaml } from "./builder-seed.js";
import { STRUT_CONCEPTS, conceptFiles } from "./concept-seed.js";
import { buildRegistryTools } from "./steps/core/agent.js";
import { kitForTests } from "./test-util/app-kit.js";

type Params = { tools: string[]; system: string };
const paramsOf = (text: string) => (yaml.load(text) as { params: Params }).params;

/** The authoring surface a job holds by glob, as the builder does (plans/one-job-agent.md §3). */
const GLOBS = ["meta/*", "app/*"];

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
      ["job/dir", "foreach", "context/concept", "context/concept", "context/recent", "if", "agent", "acp/prompt", "pack"],
      "job/dir → checkouts → the Job page → the kind's page → Recent Work → strut's agent, or a local one over ACP → pack",
    );
    // Recent Work needs nothing before it, so it runs beside the checkouts; the agent waits for both.
    assert.deepEqual(flow.steps.find((s) => s.id === "recent")!.depends, []);
    assert.deepEqual(flow.steps.find((s) => s.id === "own")!.depends, ["kindPage", "recent"]);
    assert.equal(flow.inputBlock?.["prompt"]?.required ?? true, true);
    for (const k of ["workspace", "kind", "session", "repos", "agent", "mode", "model", "cwd"]) assert.equal(flow.inputBlock?.[k]?.required, false, `${k} is optional`);

    const { tools } = paramsOf(text);
    assert.ok(tools.length > 0);
    for (const t of tools) {
      if (GLOBS.includes(t)) continue;
      assert.ok(!t.includes("*"), `only the authoring surface comes by glob: ${t}`);
      assert.ok(registry[t], `a grant strut cannot honor: ${t}`);
    }
  });

  it("building is a kind of job (plans/one-job-agent.md): the builder's tools and approvals, and the Job page says how a build starts", async () => {
    const text = await jobWorkflowYaml();
    const { tools, system } = paramsOf(text);
    const approve = (yaml.load(text) as { params: { approve: string[] } }).params.approve;
    // What the `builder` workflow grants on top of a job's own (§3).
    for (const t of [...GLOBS, "graph/query", "task/types", "task/set-type", "task/report"]) assert.ok(tools.includes(t), t);
    assert.deepEqual(tools.filter((t) => t.startsWith("meta/") || t.startsWith("app/")), GLOBS, "the globs alone: no twin named beside them");
    // Every call the builder asks a person before, the job asks before too.
    const builder = (yaml.load(await builderWorkflowYaml()) as { params: { tools: string[]; approve: string[] } }).params;
    for (const t of builder.approve) assert.ok(approve.includes(t), `asks first, as the builder does: ${t}`);
    for (const t of builder.tools) assert.ok(tools.includes(t), `the builder holds it, so the job does: ${t}`);
    assert.ok(JSON.stringify(yaml.load(text)).includes("An app on this server, by name"), "the reply's `app` field");
    assert.ok(!text.includes("an app directory you built"), "no app directory as a deliverable");
    assert.doesNotMatch(system, /app\/init|Job App/);

    const files = conceptFiles([STRUT_CONCEPTS]);
    const job = (await files.get("Job"))!;
    const said = job.docs!.replace(/\s+/g, " ");
    // The `Job` page sends a look at an app published here to app/look,
    // not to browser-explore, which needs an address.
    assert.match(said, /An app published on this server needs no address: app\/list finds it, app\/look \{ name \} shows it as the person sees it\./);
    // A build is the job's own: the rules first, then the kinds built here.
    for (const must of [
      "is yours to build, with the authoring tools (meta/*, app/*)",
      // The rules are for a workflow or a step: an app with neither behind
      // it is built from its own page (measured 2026-11-25: the agent read
      // both pages whenever there was a workflow to write, 6 of 6, and
      // `App` alone for a front-end-only app, 9 of 10).
      "Before you write a workflow or a step, open the `Workflow Language` page",
      "An app with no workflow or step to write behind it needs its kind's page alone.",
      'open the `Workflow Language` page — graph/graph-get { node_type: "Concept", name: "Workflow Language" } — and work as it says',
      "What is built here is under the `Workflow Builder` Concept, a page under this one",
      "the claim is on the workflow, and meta/verify-run on its test run, not on the job",
      "When this thread has been compacted, what a page said went with it: open the page again before you write more.",
      // Where a change to an app goes: its line says (app/recent, app/list).
      "An app's line in Recent Work, and in app/list, says where it comes from when it was not made here: that is where a change to it goes.",
      "One from a repository opened here is changed here, in place, even when the person names the repository, and reaches it with package/commit when they ask.",
      // The line names strut's repository: a server that holds it changes
      // the code there, and any other changes a copy.
      "Strut's own comes back at the next boot. When the repository its line names is one of the person's, a change to it is a change to its code there; otherwise change a copy of it, under a name of your own.",
      // Another server's is still its builder's, as before, word for word.
      "One published on a PEER is built there, by that server's builder.",
      'meta/run-workflow { name: "builder", input: { prompt, session: "<your job id>/build", peer } }',
      "`prompt` stands alone: the builder sees nothing of your thread.",
      "`session` is the build's own thread: the same on every turn of this job",
      "It answers `{ text, artifacts, ask? }`.",
      'you hand it on as it gave it (an app: `{ kind: "app", app: "<name>" }` in your `artifacts`)',
    ]) assert.ok(said.includes(must), must);
    assert.doesNotMatch(said, /is the builder's, never yours by hand|Never write workflow YAML into a file/, "the split's two lines are gone");
    // Both pages the paragraph names are there to open: the rules by name
    // (no parent, so no other prompt lists them), the kinds under Job.
    assert.deepEqual((await files.get("Workflow Language"))!.parents, []);
    assert.deepEqual((await files.get("Workflow Builder"))!.parents, ["Job"]);
    assert.ok(job.children.some((c) => c.name === "Workflow Builder"), "listed among the job's kinds");
    assert.ok(job.docs!.length <= 10_000, `the Job page is read whole (max 10000): ${job.docs!.length}`);
  });

  it("the seeded job's agent holds the app tools, and each read runs as its tool inside a job, as the job's person", async () => {
    const dir = await mkdtemp(join(tmpdir(), "job-seed-apps-"));
    try {
      type Tool = { execute: (input: unknown) => Promise<unknown> };
      const held: string[] = [];
      const out: Record<string, unknown> = {};
      // Stands in for the core `agent` step: builds its tools from the
      // grants as the step does (buildRegistryTools over the run's registry
      // and ctx), then calls each app tool the way a model would.
      const fakeAgent = defineStep({
        type: "agent",
        input: z.object({ agentTools: z.array(z.string()), approve: z.array(z.string()) }).passthrough(),
        output: z.any(),
        async run(cfg, ctx) {
          const tools = buildRegistryTools(cfg.agentTools, ctx.registry, ctx, (d: unknown) => d, { approve: new Set(cfg.approve), session: ctx.job }) as Record<string, Tool>;
          held.push(...Object.keys(tools).filter((k) => k.startsWith("app_")));
          out["list"] = await tools["app_list"]!.execute({});
          out["get"] = await tools["app_get"]!.execute({ name: "trials" });
          out["calls"] = await tools["app_calls"]!.execute({ name: "trials" });
          out["look"] = await tools["app_look"]!.execute({ name: "trials", input: { view: "/trials" } });
          return { result: "ok", object: { text: "ok", artifacts: [] }, steps: 1, usage: {}, cost: 0 };
        },
      });
      // Stands in for the Playwright browser: what app/look hands it.
      const looks: Array<{ runId: string; input: { name: string; version: string; actor?: string; link?: Record<string, string> }; sink: { runId: string; job?: { name: string; root: string } } }> = [];
      const browser = {
        async lookAtApp(runId: string, input: (typeof looks)[number]["input"], sink: (typeof looks)[number]["sink"]) {
          looks.push({ runId, input, sink });
          return { small: Buffer.from("png"), path: "shots/001.png", dir: sink.job!.root, url: "/shot", width: 1280, height: 800, bytes: 3, rendered: true, text: "Trials", errors: [] };
        },
        async dispose() {},
      };
      const strut = await createStrut({
        workspace: new WorkspaceManager(join(dir, "ws")),
        registry: await createRegistry([fakeAgent]),
        services: { browser },
        kit: await kitForTests(),
        // strut's own apps would be built too: only the one published here.
        views: false,
        jamie: false,
        knowledge: false,
        earnings: false,
        staff: false,
        worker: false,
        ...quiet,
      });
      const app = join(dir, "trials-src");
      await mkdir(join(app, "src"), { recursive: true });
      await writeFile(join(app, "app.yaml"), "title: Trials\n");
      await writeFile(join(app, "src", "App.tsx"), "export default function App() { return <p>trials</p>; }\n");
      const published = await strut.apps.publish(app, "trials", { surface: "person" });
      assert.ok(published.ok, published.ok ? "" : published.errors.join("\n"));

      const job = "job-app-reads";
      const run = await strut.run(JOB_WORKFLOW, { prompt: "Screenshot the trials page." }, { job, actor: "ann" });
      assert.equal(run.status, "success", JSON.stringify(run.error));
      for (const t of ["app_calls", "app_get", "app_list", "app_look", "app_init", "app_checkout", "app_build", "app_publish", "app_make_public"]) assert.ok(held.includes(t), `from the seeded workflow's grants: ${t}`);

      const ok = (v: unknown) => assert.ok(typeof v !== "string", `a tool's error, which the model would read: ${String(v)}`);
      for (const k of ["list", "get", "calls", "look"]) ok(out[k]);
      assert.deepEqual((out["list"] as { apps: Array<{ name: string }> }).apps.map((a) => a.name), ["trials"]);
      assert.equal((out["get"] as { manifest: { title: string } }).manifest.title, "Trials");
      assert.deepEqual((out["calls"] as { calls: unknown[] }).calls, [], "the person's own calls: none yet");
      // The look runs as the job's person, and its shot lands in the job's directory.
      assert.equal(looks.length, 1);
      assert.deepEqual([looks[0]!.input.name, looks[0]!.input.version, looks[0]!.input.actor, looks[0]!.input.link], ["trials", "v1", "ann", { view: "/trials" }]);
      assert.equal(looks[0]!.sink.job?.name, job);
      assert.equal(looks[0]!.runId, run.runId);
      const look = out["look"] as { name: string; version: string; rendered: boolean };
      assert.deepEqual([look.name, look.version, look.rendered], ["trials", "v1", true]);
      assert.equal(mediaOf(look)?.[0]?.mediaType, "image/png", "the agent SEES the shot");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    // A page is added or changed with a tool of the job's own, on the person's yes.
    assert.ok(flat(job.docs!).includes("knowledge/add-page adds a page and knowledge/edit-page changes one; each waits for the person's yes on a card, so say in `text` what you proposed."), "how a new kind is recorded");

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
      // Stands in for context/recent: its section heads the prompt.
      const fakeRecent = defineStep({
        type: "context/recent",
        input: z.object({ name: z.string().optional() }).passthrough(),
        output: z.any(),
        async run() {
          return { text: "RECENT\n\n", hash: "h" };
        },
      });
      const strut = await createStrut({ workspace: new WorkspaceManager(dir), registry: await createRegistry([fakeAgent, fakeConcept, fakeRecent]), ...quiet });
      const { kindLead, kindEnd } = (yaml.load(await jobWorkflowYaml()) as { params: { kindLead: string; kindEnd: string } }).params;
      const job = "job-kind-test";

      const coded = await strut.run(JOB_WORKFLOW, { prompt: "Add the line.", workspace: "acme", kind: "Code Change" }, { job });
      assert.equal(coded.status, "success", JSON.stringify(coded.error));
      assert.equal(prompts[0], `RECENT\n\nThis job runs on this server, @acme. Your job id: ${job}. ${kindLead}PAGE: how a code change is done here.${kindEnd}Add the line.`);
      assert.ok(kindLead.includes("\n\n") && kindEnd.includes("\n\n"), "the page stands apart from the lines around it");

      const unknown = await strut.run(JOB_WORKFLOW, { prompt: "Again.", kind: "Nope" }, { job });
      assert.equal(unknown.status, "success", JSON.stringify(unknown.error));
      assert.equal(prompts[1], `RECENT\n\nYour job id: ${job}. Again.`, "no page for the kind: the prompt as without one");
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
      // No graph: the Recent Work pages strut ships, from their files, head
      // the prompt (what each lists is recent-pages.test.ts's: the apps here
      // depend on a built kit).
      const ownLines = (prompt: string) => prompt.replace(/^\[Recent Work:[\s\S]*?\[end of Recent Work\]\n\n/, "");
      assert.ok(turns[0]!.prompt.startsWith("[Recent Work:") && ["Recent Apps:\n", "Recent Jobs:\n", "Recent Workflows:\n"].every((p) => turns[0]!.prompt.includes(p)), turns[0]!.prompt);
      assert.equal(ownLines(turns[0]!.prompt), `This job runs on this server, @acme. Your job id: ${job}. Plan dark mode.`, "the server line, then the job's id");
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
      assert.equal(ownLines(turns[2]!.prompt), "Just a note.", "no job, no id line");
      const own = ((await (await strut.app.request(`/workflows/${JOB_WORKFLOW}/runs/${alone.runId}/artifacts`)).json()) as { artifacts: Array<{ url?: string }> }).artifacts;
      assert.deepEqual(own.map((l) => l.url), [`/artifacts/${alone.runId}/plan.md`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
