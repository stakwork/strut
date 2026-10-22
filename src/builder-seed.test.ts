import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { contentHash } from "./version.js";
import { createRegistry } from "./steps/registry.js";
import { validateWorkflowYaml } from "./validate.js";
import { WorkspaceManager, flowFromYaml } from "./workspace.js";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { hostConfigFromEnv } from "./server.js";
import { JOB_WORKFLOW } from "./job-seed.js";
import { ORCHESTRATOR_WORKFLOW } from "./orchestrator-seed.js";
import type { AuthoringCapability } from "./authoring.js";
import { BUILDER_RULES_MARKER, BUILDER_WORKFLOW, builderWorkflowYaml, seedBuilderWorkflow } from "./builder-seed.js";
import { JOB_TOOLS, builderRules } from "./ai/prompts.js";

type Params = { tools: string[]; builtins: string[]; system: string; concept: string };
type Doc = { peer?: boolean; params: Params };
const docOf = (text: string) => yaml.load(text) as Doc;
const paramsOf = (text: string) => docOf(text).params;

const quiet = () => ({ serveUi: false, enableChat: false, scheduler: false as const, stt: false as const, store: new MemoryRunStore() });

describe("the builder workflow strut ships", () => {
  it("the template is a valid workflow over strut's own registry: job/dir → concept → if → agent | strut/run-workflow → pack; meta/* + app/*, the web tools and the editor family, never bash", async () => {
    const text = await builderWorkflowYaml();
    const registry = await createRegistry([]);
    const v = validateWorkflowYaml(text, { registry });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));

    const flow = flowFromYaml(BUILDER_WORKFLOW, "v1", text);
    assert.deepEqual(flow.steps.map((s) => s.type), ["job/dir", "context/concept", "if", "agent", "strut/run-workflow", "pack"]);
    assert.equal(flow.peer, true, "open to other struts");
    assert.equal(flow.sealed, undefined);
    assert.equal(flow.inputBlock?.["prompt"]?.required ?? true, true);
    for (const k of ["workspace", "session", "peer"]) assert.equal(flow.inputBlock?.[k]?.required, false, `${k} is optional`);

    // The gate and its two branches: the agent here, the peer's builder there.
    const [, , gate, build, remote] = flow.steps as Array<{ id: string; depends?: unknown; when?: unknown; config: Record<string, unknown> }>;
    assert.equal(gate!.id, "here");
    assert.equal(build!.depends, "here");
    assert.equal(build!.when, true);
    assert.equal(remote!.depends, "here");
    assert.equal(remote!.when, false);
    assert.equal(remote!.config["workflow"], "builder");
    assert.equal(remote!.config["job"], "{{ $job }}");
    assert.equal(build!.config["toolFilter"], "{{ params.builtins }}");
    assert.equal(build!.config["session"], "{{ input.session || $job }}");

    const { tools, builtins, concept } = paramsOf(text);
    assert.deepEqual(builtins, ["web_search", "web_fetch", "str_replace_based_edit_tool", "repo_overview", "fulltext_search"], "the web tools and the editor family; never bash (plans/apps.md §8)");
    assert.ok(!builtins.includes("bash"), "no shell on a workflow another strut may launch");
    assert.ok(tools.includes("app/*"), "apps are a builder job's kind of work");
    assert.ok(tools.includes("git/checkout"), "a repository to learn from, checked out into the job's directory");
    assert.equal(concept, "Workflow Builder");
    assert.ok(tools.includes("meta/*"), "the whole authoring surface, by glob");
    for (const t of ["graph/graph-get", "job/list", "job/get", "job/read"]) assert.ok(tools.includes(t), t);
    for (const t of tools) if (!t.includes("*")) assert.ok(registry[t], `a grant strut cannot honor: ${t}`);
    const twins = Object.keys(registry).filter((t) => t.startsWith("meta/"));
    for (const t of ["meta/publish-workflow", "meta/create-step", "meta/edit-step", "meta/validate-workflow", "meta/run-step", "meta/add-claim"]) assert.ok(twins.includes(t), t);
    assert.ok(twins.length >= 20, `the glob reaches the twins (${twins.length})`);
    assert.ok(!tools.includes("strut/run-workflow"), "the builder on a strut builds for that strut");
  });

  it("params.system is strut's rules for building — the dialect, the tools and the procedure — in the twins' names, inside the job's own text", async () => {
    const text = await builderWorkflowYaml();
    const { system, tools } = paramsOf(text);
    const rules = builderRules(JOB_TOOLS);
    assert.ok(!system.includes(BUILDER_RULES_MARKER), "the marker is replaced");
    assert.ok(system.includes(rules), "rendered whole, from the one source the chat reads");
    assert.ok(system.startsWith("You are a workflow BUILDER working on a job"), "the job's head first");
    assert.ok(system.indexOf(rules) < system.indexOf("meta/add-claim with subject"), "then the job's claims, kinds and reply");
    const loaded = (flowFromYaml(BUILDER_WORKFLOW, "v1", text).params as Params).system;
    assert.equal(loaded, system, "loaded as written: the rules' {{ params.name }} examples are not param references");

    // The dialect the chat has always had.
    for (const rule of [
      "ALWAYS WRAP TEMPLATE VALUES IN QUOTES",
      `"params" (optional, top level) are the workflow's tunable knobs`,
      `"input" (optional, top level) declares the run payload's fields`,
      "Division of labor (LLM vs code):",
      "Never ask a model to convert or add numbers",
      "A cap is a runaway guard, not a budget",
      `The "if" step is a GATE.`,
      "External capabilities come from ctx.services",
      "ctx.services.secrets.get(\"ENV_NAME\")",
    ]) assert.ok(system.includes(rule), rule);

    // The procedure and the tools, in the names the agent holds.
    for (const said of [
      "1. Call meta/list-workflows FIRST",
      "Call meta/get-step for EVERY step type you will use",
      `meta/run-step(type, config, cassette:"record")`,
      "Call meta/validate-workflow on the YAML",
      "Call meta/run-workflow with a sample input",
      "- meta/publish-workflow(name, yaml, description?, category?)",
      "No shell here",
      "app/init scaffolds one at apps/<name> in the job's directory",
      "say in your reply's `ask` which NAME the person should add under Secrets",
    ]) assert.ok(system.includes(said), said);

    // Never the chat's: no tool of its, no bash, no mechanics it alone has.
    for (const chat of ["list_steps", "search_steps", "get_step", "list_secrets", "create_step", "edit_step", "run_step", "list_workflows", "get_workflow", "validate_workflow", "create_workflow", "edit_workflow", "run_workflow", "list_runs", "get_run", "search_runs", "ask_user", "request_secret", "graph_query", "graph_get(", "set_automation", "set_active_version", "cancel_run", "list_peers", "app_build"]) {
      assert.ok(!system.includes(chat), `the chat's ${chat}`);
    }
    assert.doesNotMatch(system, /\bbash\(|where bash runs|clone a repo/, "never told to use a shell");
    for (const mechanic of ["[run-notification]", "[restart-notification]", "this chat", "scratch/", "`edits`"]) assert.ok(!system.includes(mechanic), mechanic);

    // Every authoring tool it names is a step the agent is granted.
    const registry = await createRegistry([]);
    const named = new Set(system.match(/\b(?:meta|app|job|graph)\/[a-z][a-z-]*/g));
    const granted = (type: string) => tools.some((t) => t === type || (t.endsWith("/*") && type.startsWith(t.slice(0, -1))));
    for (const type of named) {
      assert.ok(registry[type], `a step strut has: ${type}`);
      if (/^(meta|app)\//.test(type) || ["graph/graph-get", "graph/graph-search", "job/read"].includes(type)) assert.ok(granted(type), `granted: ${type}`);
    }
  });

  it("the host's delta is appended after strut's tools and prompt and changes the hash; `peer: false` drops the key", async () => {
    const plain = await builderWorkflowYaml();
    const delta = await builderWorkflowYaml({ tools: ["pod/*"], approve: ["meta/publish-workflow"], system: "\nThis strut builds for acme.\n" });
    const p = paramsOf(plain);
    const d = docOf(delta);
    assert.deepEqual(d.params.tools, [...p.tools, "pod/*"]);
    assert.deepEqual((d.params as { approve?: string[] }).approve, ["meta/publish-workflow"]);
    assert.equal(d.params.system, `${p.system.trimEnd()}\n\nThis strut builds for acme.\n`);
    assert.equal(d.peer, true, "the delta leaves the key");
    assert.notEqual(contentHash(plain), contentHash(delta));
    assert.equal(contentHash(await builderWorkflowYaml({ tools: [], system: " " })), contentHash(plain));

    const closed = await builderWorkflowYaml({ peer: false });
    assert.ok(!("peer" in docOf(closed)), "peer: false deletes the key");
    assert.equal(flowFromYaml(BUILDER_WORKFLOW, "v1", closed).peer, undefined);
    assert.deepEqual(paramsOf(closed), p, "and changes nothing else");
    assert.notEqual(contentHash(closed), contentHash(plain));
  });

  it("createStrut seeds it by content hash beside job and orchestrator: once, as a seed; a reboot is a no-op; a changed delta publishes, and taking it back out makes the first version active again; `builder: false` seeds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-seed-"));
    const fresh = await mkdtemp(join(tmpdir(), "builder-seed-off-"));
    try {
      const ws = () => new WorkspaceManager(dir);
      const versions = async () => {
        const meta = await ws().getWorkflowMetadata(BUILDER_WORKFLOW);
        return Object.entries(meta!.versions).map(([v, m]) => [v, m.source]).sort();
      };

      const a = await createStrut({ workspace: ws(), ...quiet() });
      const listed = (await (await a.app.request("/workflows")).json()) as Array<{ name: string; category?: string }>;
      assert.equal(listed.find((w) => w.name === BUILDER_WORKFLOW)?.category, "job");
      for (const w of [JOB_WORKFLOW, ORCHESTRATOR_WORKFLOW]) assert.ok(listed.some((x) => x.name === w), `${w} is still seeded`);
      assert.deepEqual(await versions(), [["v1", "seed"]]);
      assert.equal(await ws().getWorkflowSource(BUILDER_WORKFLOW, "v1"), await builderWorkflowYaml(), "published as the template's text");
      assert.equal((await ws().getWorkflow(BUILDER_WORKFLOW)).peer, true, "loaded as open to peers");

      await createStrut({ workspace: ws(), ...quiet() });
      assert.deepEqual(await versions(), [["v1", "seed"]], "the same template publishes nothing");

      await createStrut({ workspace: ws(), ...quiet(), builder: { peer: false } });
      assert.deepEqual(await versions(), [["v1", "seed"], ["v2", "seed"]]);
      assert.equal((await ws().getWorkflowMetadata(BUILDER_WORKFLOW))!.active, "v2");
      assert.equal((await ws().getWorkflow(BUILDER_WORKFLOW)).peer, undefined, "closed to peers by the delta");

      // The delta taken back out (the plans/builder-job.md §9 run): the
      // template is v1's text again, so v1 is active again — open to peers.
      await createStrut({ workspace: ws(), ...quiet() });
      assert.deepEqual(await versions(), [["v1", "seed"], ["v2", "seed"]], "nothing new published");
      assert.equal((await ws().getWorkflowMetadata(BUILDER_WORKFLOW))!.active, "v1");
      assert.equal((await ws().getWorkflow(BUILDER_WORKFLOW)).peer, true, "open to peers again");

      const off = await createStrut({ workspace: new WorkspaceManager(fresh), ...quiet(), builder: false });
      const names = ((await (await off.app.request("/workflows")).json()) as Array<{ name: string }>).map((w) => w.name);
      assert.ok(!names.includes(BUILDER_WORKFLOW));
      assert.ok(names.includes(JOB_WORKFLOW) && names.includes(ORCHESTRATOR_WORKFLOW), "the others are seeded on their own switches");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("a builder may not run the builder again with fewer approvals: meta/run-workflow keeps the host's gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-gate-"));
    try {
      const strut = await createStrut({ workspace: new WorkspaceManager(dir), ...quiet(), builder: { approve: ["meta/publish-workflow", "meta/create-step"] } });
      const authoring = (strut.services as { authoring: AuthoringCapability }).authoring;
      for (const approve of [[], ["meta/create-step"]]) {
        const res = (await authoring.runWorkflow(BUILDER_WORKFLOW, { prompt: "publish x" }, { approve })) as { error?: string; runId?: string };
        assert.match(res.error ?? "", /"meta\/(publish-workflow|create-step)" taken out of approval \(params\.approve: approve may only grow\)/);
        assert.equal(res.runId, undefined, "nothing ran");
      }
      // More approvals, or none overridden, pass the gate (checked off the seeded YAML itself).
      const { grantWidenedBy } = await import("./closure.js");
      const flow = await strut.workspace.getWorkflow(BUILDER_WORKFLOW);
      assert.equal(grantWidenedBy(flow, { approve: ["meta/publish-workflow", "meta/create-step", "meta/edit-step"] }, strut.getRegistry()), null);
      assert.equal(grantWidenedBy(flow, { system: "a knob" }, strut.getRegistry()), null);

      // A host with no approvals (Hive's builder today): nothing gated, nothing to keep.
      const hive = await createStrut({ workspace: new WorkspaceManager(join(dir, "hive")), ...quiet() });
      assert.equal(grantWidenedBy(await hive.workspace.getWorkflow(BUILDER_WORKFLOW), { approve: [] }, hive.getRegistry()), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the meta surface may not publish the template: `peer: true` is a person's call (a seed's), never an agent's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-meta-"));
    try {
      const strut = await createStrut({ workspace: new WorkspaceManager(dir), ...quiet() });
      const authoring = (strut.services as { authoring: AuthoringCapability }).authoring;
      const res = (await authoring.publishWorkflow("builder-copy", await builderWorkflowYaml(), "a copy")) as { error?: string };
      assert.match(res.error ?? "", /declares `peer: true`/);
      assert.equal(await strut.workspace.getWorkflowMetadata("builder-copy"), null, "nothing published");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the bundled server takes the host's delta — `peer: false` included — from the file STRUT_HOST_CONFIG names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-host-config-"));
    try {
      const file = join(dir, "host.json");
      await writeFile(file, JSON.stringify({ builder: { tools: ["pod/*"], system: "Acme's section.", peer: false }, job: { tools: ["pod/*"] } }));
      const opts = hostConfigFromEnv({ STRUT_HOST_CONFIG: file });
      assert.deepEqual(opts, { builder: { tools: ["pod/*"], system: "Acme's section.", peer: false }, job: { tools: ["pod/*"] } });

      const ws = new WorkspaceManager(join(dir, "ws"));
      await createStrut({ workspace: ws, ...quiet(), ...opts });
      const text = await ws.getWorkflowSource(BUILDER_WORKFLOW, "v1");
      assert.equal(paramsOf(text).tools.at(-1), "pod/*");
      assert.ok(paramsOf(text).system.trimEnd().endsWith("Acme's section."));
      assert.ok(!("peer" in docOf(text)));

      await writeFile(file, JSON.stringify({ builder: { peer: true } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"builder" must be/, "peer may only be dropped, never granted from a file");
      await writeFile(file, JSON.stringify({ builder: { tools: "meta/*" } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"builder" must be/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The seeded builder through a whole strut, against a stand-in Anthropic
// endpoint and a stand-in host collecting run.end callbacks.
describe("the builder, end to end", () => {
  let dir = "";
  const servers: http.Server[] = [];
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "builder-e2e-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) s.close();
    await rm(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const listen = async (handler: (body: any, raw: string) => string | undefined): Promise<string> => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const out = handler(JSON.parse(raw), raw);
        if (out === undefined) res.writeHead(204).end();
        else {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(out);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as any).port}`;
  };
  const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const start = () =>
    sse({
      type: "message_start",
      message: {
        id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 },
      },
    });
  const toolUse = (id: string, name: string, input: unknown) =>
    start() +
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    sse({ type: "message_stop" });
  const until = async <T>(find: () => T | undefined): Promise<T> => {
    for (let i = 0; i < 1500; i++) {
      const v = find();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("never happened");
  };

  it("a builder turn under a job: the authoring twins, the app steps, the web tools and the editor, no bash; strut's prompt then the host's; the job's thread; run.end to the callback", async () => {
    const seen: any[] = [];
    process.env["ANTHROPIC_BASE_URL"] = await listen((body) => {
      seen.push(body);
      return toolUse("toolu_1", "final_answer", { text: "Published hello-world v1; the test run printed hello.", artifacts: [] });
    });
    const ends: any[] = [];
    const callback = `${await listen((body) => void ends.push(body))}/run-end?sig=s3cret`;
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      ...quiet(),
      job: false,
      orchestrator: false,
      builder: { system: "HOSTSECTION: this strut builds for acme." },
    });
    const res = await strut.app.request(`/workflows/${BUILDER_WORKFLOW}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job: "build-1", input: { prompt: "Build a hello-world workflow", workspace: "acme" }, callback: { url: callback } }),
    });
    assert.equal(res.status, 202);
    const { runId } = (await res.json()) as { runId: string };
    const end = await until(() => ends.find((e) => e.runId === runId));

    assert.equal(end.workflow, BUILDER_WORKFLOW);
    assert.equal(end.job, "build-1");
    assert.equal(end.status, "success", JSON.stringify(end));
    assert.equal(end.output.text, "Published hello-world v1; the test run printed hello.");
    assert.deepEqual(end.output.artifacts, []);
    assert.equal(end.output.session.id, "build-1", "the build is the job's thread");
    assert.equal(end.output.peer, undefined, "built here");

    assert.equal(seen.length, 1, "one model call: the answer");
    const req = seen[0];
    const names: string[] = req.tools.map((t: any) => t.name);
    for (const t of ["meta_list_workflows", "meta_get_step", "meta_create_step", "meta_run_step", "meta_validate_workflow", "meta_publish_workflow", "meta_run_workflow", "meta_add_claim", "graph_graph_get", "job_list", "app_init", "app_build", "app_publish", "app_get", "git_checkout", "final_answer"]) {
      assert.ok(names.includes(t), `${t} in ${names.join(",")}`);
    }
    for (const t of ["bash", "file_summary"]) assert.ok(!names.includes(t), `no ${t}`);
    for (const t of ["str_replace_based_edit_tool", "repo_overview", "fulltext_search"]) assert.ok(names.includes(t), `the editor family: ${t}`);
    assert.ok(names.includes("web_search") && names.includes("web_fetch"), "the web tools stay");
    const system = JSON.stringify(req.system);
    assert.ok(system.includes("You are a workflow BUILDER"), "strut's prompt");
    assert.ok(system.includes("ALWAYS WRAP TEMPLATE VALUES IN QUOTES") && system.includes("1. Call meta/list-workflows FIRST"), "with the builder's rules");
    assert.ok(system.includes("{{ params.greeting }}: {{ fetch.body }}"), "the dialect's templates reach the model as written, never resolved");
    assert.ok(system.includes("HOSTSECTION"), "the host's section after it");
    assert.ok(system.indexOf("workflow BUILDER") < system.indexOf("HOSTSECTION"));
    const lastUser = JSON.stringify(req.messages.filter((m: any) => m.role === "user").at(-1));
    assert.ok(lastUser.includes("Workspace: @acme, the one this strut belongs to. Your job id: build-1. Build a hello-world workflow"), lastUser);
    assert.ok(system.includes("git/checkout, `workdir` your job id"), "how a repository reaches the editor");
  });

  it("a repository to learn from: git/checkout with the job id as `workdir` lands in the job's directory, where the editor reads it", async () => {
    const origin = join(dir, "origin");
    const git = (args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: origin, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    await mkdir(origin, { recursive: true });
    git(["init", "-q", "-b", "main"]);
    await writeFile(join(origin, "Panel.tsx"), "export function Panel() { return <p>PORT ME</p>; }\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);

    const seen: any[] = [];
    process.env["ANTHROPIC_BASE_URL"] = await listen((body) => {
      seen.push(body);
      if (seen.length === 1) return toolUse("toolu_1", "git_checkout", { repo: `file://${origin}`, workdir: "build-2" });
      if (seen.length === 2) return toolUse("toolu_2", "str_replace_based_edit_tool", { command: "view", path: "origin/Panel.tsx" });
      return toolUse("toolu_3", "final_answer", { text: "Read the panel.", artifacts: [] });
    });
    const ends: any[] = [];
    const callback = `${await listen((body) => void ends.push(body))}/run-end`;
    const strut = await createStrut({ workspace: new WorkspaceManager(dir), ...quiet(), job: false, orchestrator: false });
    const res = await strut.app.request(`/workflows/${BUILDER_WORKFLOW}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job: "build-2", input: { prompt: "Port the panel" }, callback: { url: callback } }),
    });
    assert.equal(res.status, 202);
    const { runId } = (await res.json()) as { runId: string };
    const end = await until(() => ends.find((e) => e.runId === runId));
    assert.equal(end.status, "success", JSON.stringify(end));

    assert.equal(seen.length, 3);
    const results = JSON.stringify(seen[2].messages);
    assert.ok(results.includes(join(dir, "jobs", "build-2", "origin")), `checked out into the job's directory: ${results}`);
    assert.ok(results.includes("PORT ME"), "the editor read the checked-out file by its path in the job's directory");
    assert.ok(existsSync(join(dir, "jobs", "build-2", "origin", "Panel.tsx")), "kept for the next turn");
  });
});
