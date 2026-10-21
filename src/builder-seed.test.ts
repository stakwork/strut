import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { BUILDER_WORKFLOW, builderWorkflowYaml, seedBuilderWorkflow } from "./builder-seed.js";

type Params = { tools: string[]; builtins: string[]; system: string; concept: string };
type Doc = { peer?: boolean; params: Params };
const docOf = (text: string) => yaml.load(text) as Doc;
const paramsOf = (text: string) => docOf(text).params;

const quiet = () => ({ serveUi: false, enableChat: false, scheduler: false as const, stt: false as const, store: new MemoryRunStore() });

describe("the builder workflow strut ships", () => {
  it("the template is a valid workflow over strut's own registry: job/dir → concept → if → agent | strut/run-workflow → pack; meta/* and the web tools, never bash", async () => {
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
    assert.deepEqual(builtins, ["web_search", "web_fetch"], "the web tools are the only built-ins");
    assert.equal(concept, "Workflow Builder");
    assert.ok(tools.includes("meta/*"), "the whole authoring surface, by glob");
    for (const t of ["graph/graph-get", "job/list", "job/get", "job/read"]) assert.ok(tools.includes(t), t);
    for (const t of tools) if (!t.includes("*")) assert.ok(registry[t], `a grant strut cannot honor: ${t}`);
    const twins = Object.keys(registry).filter((t) => t.startsWith("meta/"));
    for (const t of ["meta/publish-workflow", "meta/create-step", "meta/edit-step", "meta/validate-workflow", "meta/run-step", "meta/add-claim"]) assert.ok(twins.includes(t), t);
    assert.ok(twins.length >= 20, `the glob reaches the twins (${twins.length})`);
    assert.ok(!tools.includes("strut/run-workflow"), "the builder on a strut builds for that strut");
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

  it("createStrut seeds it by content hash beside job and orchestrator: once, as a seed; a reboot is a no-op; a changed delta publishes; `builder: false` seeds nothing", async () => {
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

      const off = await createStrut({ workspace: new WorkspaceManager(fresh), ...quiet(), builder: false });
      const names = ((await (await off.app.request("/workflows")).json()) as Array<{ name: string }>).map((w) => w.name);
      assert.ok(!names.includes(BUILDER_WORKFLOW));
      assert.ok(names.includes(JOB_WORKFLOW) && names.includes(ORCHESTRATOR_WORKFLOW), "the others are seeded on their own switches");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(fresh, { recursive: true, force: true });
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

  it("a builder turn under a job: the authoring twins and the web tools, no bash; strut's prompt then the host's; the job's thread; run.end to the callback", async () => {
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
    for (const t of ["meta_list_workflows", "meta_get_step", "meta_create_step", "meta_run_step", "meta_validate_workflow", "meta_publish_workflow", "meta_run_workflow", "meta_add_claim", "graph_graph_get", "job_list", "final_answer"]) {
      assert.ok(names.includes(t), `${t} in ${names.join(",")}`);
    }
    for (const t of ["bash", "str_replace_based_edit_tool", "repo_overview", "fulltext_search", "file_summary"]) assert.ok(!names.includes(t), `no ${t}`);
    assert.ok(names.includes("web_search") && names.includes("web_fetch"), "the web tools stay");
    const system = JSON.stringify(req.system);
    assert.ok(system.includes("You are a workflow BUILDER"), "strut's prompt");
    assert.ok(system.includes("HOSTSECTION"), "the host's section after it");
    assert.ok(system.indexOf("workflow BUILDER") < system.indexOf("HOSTSECTION"));
    const lastUser = JSON.stringify(req.messages.filter((m: any) => m.role === "user").at(-1));
    assert.ok(lastUser.includes("Workspace: @acme, the one this strut belongs to. Build a hello-world workflow"), lastUser);
  });
});
