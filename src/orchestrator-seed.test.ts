import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { contentHash } from "./version.js";
import { createRegistry } from "./steps/registry.js";
import { validateWorkflowYaml } from "./validate.js";
import { WorkspaceManager, flowFromYaml } from "./workspace.js";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { hostConfigFromEnv } from "./server.js";
import { JOB_WORKFLOW } from "./job-seed.js";
import { ORCHESTRATOR_WORKFLOW, orchestratorWorkflowYaml, personalOrchestratorSystem, seedOrchestratorWorkflow } from "./orchestrator-seed.js";

type Params = { tools: string[]; system: string };
const paramsOf = (text: string) => (yaml.load(text) as { params: Params }).params;

const quiet = () => ({ serveUi: false, enableChat: false, scheduler: false as const, stt: false as const, store: new MemoryRunStore() });

describe("the orchestrator workflow strut ships", () => {
  it("the template is a valid workflow over strut's own registry: job/dir → context/concept three times (the kinds of job, the kinds of build, no docs; the person's own pages) → strut/list-peers → agent (session, no built-ins) → pack, every grant a strut step", async () => {
    const text = await orchestratorWorkflowYaml();
    const registry = await createRegistry([]);
    const v = validateWorkflowYaml(text, { registry });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));

    const flow = flowFromYaml(ORCHESTRATOR_WORKFLOW, "v1", text);
    assert.deepEqual(flow.steps.map((s) => s.type), ["job/dir", "context/concept", "context/concept", "context/concept", "strut/list-peers", "agent", "if", "job/start", "pack"]);
    const personalOf = (t: string) => (yaml.load(t) as { params: { personalConcept?: string } }).params.personalConcept;
    assert.equal(personalOf(text), "", "no person's pages unless the host keeps them");
    assert.equal(personalOf(await orchestratorWorkflowYaml({ personalConcept: "Personal" })), "Personal");
    assert.equal(flow.inputBlock?.["prompt"]?.required ?? true, true);
    for (const k of ["session", "context"]) assert.equal(flow.inputBlock?.[k]?.required, false, `${k} is optional`);
    // Two lists, one per agent's tree, children alone: the kinds of work a
    // job does here (Job) and the kinds of thing the builder builds
    // (Workflow Builder). The pages' docs are those agents' instructions,
    // and this agent has no graph-get to open a page with.
    assert.deepEqual(flow.steps[1]!.config, { name: "{{ params.concept }}", docs: false, tool: "" });
    assert.deepEqual(flow.steps[2]!.config, { name: "{{ params.buildConcept }}", docs: false, tool: "" });
    const params = (yaml.load(text) as { params: { concept: string; buildConcept: string } }).params;
    assert.deepEqual([params.concept, params.buildConcept], ["Job", "Workflow Builder"]);
    // The person's own pages are this agent's to follow: their root's docs, and how to open one.
    assert.deepEqual(flow.steps[3]!.config, { name: "{{ params.personalConcept }}", tool: "graph_graph_get" });
    const turn = flow.steps[5]!.config as Record<string, unknown>;
    assert.equal(turn["systemAtCompaction"], undefined, "a session keeps its first turn's prompt");
    assert.deepEqual(turn["toolFilter"], ["none"]);
    assert.equal(turn["system"], "{{ params.system }}\n{{ concepts.text }}\n{{ builds.text }}\n{{ personal.text }}", "the two lists, then the person's pages, close the prompt");

    const { tools } = paramsOf(text);
    for (const t of ["job/start", "job/continue", "job/list", "job/get", "job/read"]) assert.ok(tools.includes(t), t);
    // Memory is a host's, per person (Peel grants it): one store for a whole
    // workspace is nobody's.
    assert.deepEqual(tools.filter((t) => t.startsWith("memory/")), []);
    assert.ok(!/memory\//.test(paramsOf(text).system), "the prompt names no memory step");
    for (const t of tools) {
      assert.ok(!t.includes("*"), `strut's own list names steps, never globs: ${t}`);
      assert.ok(registry[t], `a grant strut cannot honor: ${t}`);
    }

    // A workflow build is a job on `workflow: builder` (plans/builder-job.md
    // §2, amended): ONE sentence here — what is built is the `Workflow
    // Builder` tree's kinds (the second list this prompt ends with), and the
    // rule rides on job/start's own schema, beside the call. `builder` is a
    // field value, never a noun the person hears: the prompt names no
    // "builder job", and tells the agent to talk in the person's words.
    const system = (yaml.load(text) as { params: { system: string } }).params.system.replace(/\s+/g, " ");
    assert.ok(
      system.includes("To build, change, test or debug a workflow, or an app that lives in a workspace, start the job with `workflow: builder`, in the workspace it belongs to (`peer` when that is not this one)."),
      system,
    );
    assert.doesNotMatch(system, /builder job/i, "no internal noun for the person to repeat");
    assert.ok(system.includes("under `Workflow Builder`, the kinds of workflow built here, and the apps over them"), "the second list says what it is");
    assert.ok(system.includes("Talk to the person in their words, not this prompt's"), "a posture for every reply, not a renaming table");
    const start = z.toJSONSchema(registry["job/start"]!.input) as { properties: Record<string, { enum?: string[]; description?: string }> };
    assert.deepEqual(start.properties["workflow"]!.enum, ["job", "builder"], "a closed set: the model never names an arbitrary workflow");
    assert.match(start.properties["workflow"]!.description!, /`builder`: the thing to build, change, test or debug is a WORKFLOW/);
    // An app that lives in a workspace is a builder's too — on a peer as
    // here — and an app over a job's own results stays the job's.
    assert.match(start.properties["workflow"]!.description!, /or an APP that lives in a workspace/);
    assert.match(start.properties["workflow"]!.description!, /`job` \(the default\):[^.]*an app over this job's own results/);
    assert.match(start.properties["peer"]!.description!, /^With workflow: builder only/);
  });

  it("model, reasoning and stream are launch KNOBS: grantWidenedBy passes them, and still refuses a tool the template does not grant", async () => {
    const { grantWidenedBy } = await import("./closure.js");
    const text = await orchestratorWorkflowYaml();
    const registry = await createRegistry([]);
    const flow = flowFromYaml(ORCHESTRATOR_WORKFLOW, "v1", text);
    assert.equal(grantWidenedBy(flow, { model: "claude-haiku-4-5", reasoning: "none", stream: true }, registry), null);
    assert.equal(grantWidenedBy(flow, { tools: ["job/start"] }, registry), null, "narrowing is fine");
    assert.match(grantWidenedBy(flow, { tools: ["job/start", "exec"] }, registry) ?? "", /"exec" \(params\.tools\)/);
    const p = (yaml.load(text) as { params: Record<string, unknown> }).params;
    assert.deepEqual([p["model"], p["reasoning"], p["stream"]], ["claude-sonnet-5-5", "medium", false], "defaults keep today's behaviour");
    const turn = flow.steps.find((st) => st.id === "turn")!.config as Record<string, unknown>;
    assert.equal(turn["reasoning"], "{{ params.reasoning }}");
    assert.equal(turn["stream"], "{{ params.stream }}");
    const reply = turn["schema"] as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(reply.properties).slice(0, 2), ["text", "start"], "text first, so it streams before the rest");
    assert.deepEqual((reply.properties["start"] as any).required, ["brief", "title"]);
    // `start` takes what the job/start tool takes, but a DAG step after the
    // agent sees only THIS turn's files: the agent hands its tools alone the
    // files of the thread's earlier turns.
    assert.deepEqual(Object.keys((reply.properties["start"] as any).properties), ["brief", "title", "kind", "workflow", "peer", "repos", "attachments"]);
    const started = flow.steps.find((st) => st.id === "started")!.config as Record<string, unknown>;
    for (const k of ["peer", "repos", "attachments"]) assert.equal(started[k], `{{ turn.object.start.${k} }}`);
    assert.ok(
      String(p["system"]).replace(/\s+/g, " ").includes("or to hand the job a file from an earlier message: `start` carries only this message's files."),
    );
  });
  it("the host's delta is appended after strut's tools and prompt, and changes the hash; an empty one does not", async () => {
    const plain = await orchestratorWorkflowYaml();
    const delta = await orchestratorWorkflowYaml({ tools: ["sphinx/*", "calendar/*"], system: "\nThe person's chats are on their Mac.\n" });
    const p = paramsOf(plain);
    const d = paramsOf(delta);
    assert.deepEqual(d.tools, [...p.tools, "sphinx/*", "calendar/*"]);
    assert.equal(d.system, `${p.system.trimEnd()}\n\nThe person's chats are on their Mac.\n`);
    assert.notEqual(contentHash(plain), contentHash(delta));
    assert.equal(contentHash(await orchestratorWorkflowYaml({ tools: [], system: " " })), contentHash(plain));
  });

  it("is sealed: a job's meta/run-workflow never reaches a host's private tools through it", async () => {
    assert.equal((yaml.load(await orchestratorWorkflowYaml()) as { sealed?: boolean }).sealed, true);
  });

  it("a person's own strut's section (plans/chained-orchestrators.md §1): where a request belongs, the org's orchestrator on the person's thread with a room, the reply relayed", async () => {
    const section = personalOrchestratorSystem("tom-1");
    const strutsOwn = paramsOf(await orchestratorWorkflowYaml()).system.trimEnd();
    const text = await orchestratorWorkflowYaml({ system: section });
    assert.equal(paramsOf(text).system, `${strutsOwn}\n\n${section.trim()}\n`, "appended after strut's own, as any host's");
    // One thread per LOCAL conversation on the org, never one for every conversation (hive#5602 review).
    assert.ok(section.includes('strut/run-workflow { peer: <org>, workflow: "orchestrator", input: { prompt, session: "tom-1/<conversation>" }, room: true }'));
    assert.ok(!section.includes("tom-1/<org>"));
    assert.match(section, /`text` is your `text`, word for word; its `ask` is your `ask`; its `artifacts` are your `artifacts`/);
    // It renders a valid workflow, no `{{ }}` for the params resolver to touch.
    assert.ok(!section.includes("{{"));
    assert.equal(paramsOf(text).system, flowFromYaml(ORCHESTRATOR_WORKFLOW, "v1", text).params!["system"]);
    // The person's id heads a session id, so it must be one's segment.
    assert.throws(() => personalOrchestratorSystem("tom 1"), /first segment of a session id/);
    assert.throws(() => personalOrchestratorSystem(""), /first segment of a session id/);
  });

  it("is open to another strut only through a person's credential (`peer: person`); a host's delta may close it", async () => {
    assert.equal((yaml.load(await orchestratorWorkflowYaml()) as { peer?: unknown }).peer, "person");
    assert.ok(!("peer" in (yaml.load(await orchestratorWorkflowYaml({ peer: false })) as object)));
  });

  it("the host's delta may name the model, or none (null), so the turn runs on the connected model", async () => {
    assert.equal(paramsOf(await orchestratorWorkflowYaml({ model: "openai/gpt-5" })).model, "openai/gpt-5");
    assert.ok(!("model" in paramsOf(await orchestratorWorkflowYaml({ model: null }))));
    assert.equal(paramsOf(await orchestratorWorkflowYaml()).model, paramsOf(await orchestratorWorkflowYaml({ tools: [] })).model);
  });

  it("createStrut seeds it by content hash beside job: once, as a seed; a reboot is a no-op; a changed delta publishes, and taking it back out makes the first version active again; `orchestrator: false` seeds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-seed-"));
    const fresh = await mkdtemp(join(tmpdir(), "orch-seed-off-"));
    try {
      const ws = () => new WorkspaceManager(dir);
      const versions = async () => {
        const meta = await ws().getWorkflowMetadata(ORCHESTRATOR_WORKFLOW);
        return Object.entries(meta!.versions).map(([v, m]) => [v, m.source]).sort();
      };

      const a = await createStrut({ workspace: ws(), ...quiet() });
      const listed = (await (await a.app.request("/workflows")).json()) as Array<{ name: string; category?: string }>;
      assert.equal(listed.find((w) => w.name === ORCHESTRATOR_WORKFLOW)?.category, "orchestrator");
      assert.ok(listed.some((w) => w.name === JOB_WORKFLOW), "job is still seeded");
      assert.deepEqual(await versions(), [["v1", "seed"]]);
      assert.equal(await ws().getWorkflowSource(ORCHESTRATOR_WORKFLOW, "v1"), await orchestratorWorkflowYaml(), "published as the template's text");

      await createStrut({ workspace: ws(), ...quiet() });
      assert.deepEqual(await versions(), [["v1", "seed"]], "the same template publishes nothing");

      await createStrut({ workspace: ws(), ...quiet(), orchestrator: { tools: ["sphinx/*"] } });
      assert.deepEqual(await versions(), [["v1", "seed"], ["v2", "seed"]]);
      assert.equal((await ws().getWorkflowMetadata(ORCHESTRATOR_WORKFLOW))!.active, "v2");
      assert.equal(paramsOf(await ws().getWorkflowSource(ORCHESTRATOR_WORKFLOW, "v2")).tools.at(-1), "sphinx/*");

      // Taken back out: v1 is active again, nothing new published.
      await createStrut({ workspace: ws(), ...quiet() });
      assert.deepEqual(await versions(), [["v1", "seed"], ["v2", "seed"]]);
      assert.equal((await ws().getWorkflowMetadata(ORCHESTRATOR_WORKFLOW))!.active, "v1");

      const off = await createStrut({ workspace: new WorkspaceManager(fresh), ...quiet(), orchestrator: false });
      const names = ((await (await off.app.request("/workflows")).json()) as Array<{ name: string }>).map((w) => w.name);
      assert.ok(!names.includes(ORCHESTRATOR_WORKFLOW));
      assert.ok(names.includes(JOB_WORKFLOW), "job is seeded on its own switch");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("the bundled server takes the host's delta from the file STRUT_HOST_CONFIG names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-host-config-"));
    try {
      assert.deepEqual(hostConfigFromEnv({}), {}, "unset: no delta");

      const file = join(dir, "host.json");
      await writeFile(file, JSON.stringify({ orchestrator: { tools: ["sphinx/*"], system: "Peel's section." }, job: { tools: ["pod/*"] } }));
      const opts = hostConfigFromEnv({ STRUT_HOST_CONFIG: file });
      assert.deepEqual(opts, { orchestrator: { tools: ["sphinx/*"], system: "Peel's section." }, job: { tools: ["pod/*"] } });

      const ws = new WorkspaceManager(join(dir, "ws"));
      await createStrut({ workspace: ws, ...quiet(), ...opts });
      const seeded = paramsOf(await ws.getWorkflowSource(ORCHESTRATOR_WORKFLOW, "v1"));
      assert.equal(seeded.tools.at(-1), "sphinx/*");
      assert.ok(seeded.system.trimEnd().endsWith("Peel's section."));
      assert.equal(paramsOf(await ws.getWorkflowSource(JOB_WORKFLOW, "v1")).tools.at(-1), "pod/*");

      await writeFile(file, "{ not json");
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /STRUT_HOST_CONFIG: could not read/);
      await writeFile(file, JSON.stringify({ orchestrator: { tools: "sphinx/*" } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"orchestrator" must be/);
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: join(dir, "missing.json") }), /could not read/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The seeded orchestrator through a whole strut, against a stand-in
// Anthropic endpoint and a stand-in host collecting run.end callbacks.
describe("the orchestrator, end to end", () => {
  let dir = "";
  const servers: http.Server[] = [];
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orch-e2e-"));
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

  /** A strut with the seeded orchestrator (the host's section added) and a
   *  stand-in `job` (strut's has the coding built-ins). `orch` is every
   *  orchestrator request, `job` every job request. */
  const boot = async (
    orchReply: (n: number, body: any) => string,
    peers?: { id: string; baseUrl: string; token: string; label?: string }[],
    self?: { id: string; label?: string },
  ) => {
    const seen = { orch: [] as any[], job: [] as string[] };
    process.env["ANTHROPIC_BASE_URL"] = await listen((body, raw) => {
      if (JSON.stringify(body.system ?? "").includes("JOBAGENT")) {
        seen.job.push(raw);
        return toolUse("toolu_j", "final_answer", { text: "Three flights.", artifacts: [] });
      }
      seen.orch.push(body);
      return orchReply(seen.orch.length, body);
    });
    const ends: any[] = [];
    const callback = `${await listen((body) => void ends.push(body))}/run-end?sig=s3cret`;
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      builder: false,
      orchestrator: { system: "HOSTSECTION: the person's chats are on their Mac." },
      ...(peers ? { peers } : {}),
      ...(self ? { self } : {}),
    });
    await strut.workspace.publishWorkflow("job", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        {
          id: "work",
          type: "agent",
          config: {
            cwd: "{{ dir.path }}", system: "JOBAGENT", prompt: "{{ input.prompt }}", session: "{{ $job }}", toolFilter: ["none"],
            schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
          },
        },
        { id: "result", type: "pack", config: { text: "{{ work.object.text }}" } },
      ],
    });
    // A stand-in `builder` too: strut's dispatches to the peer when `peer` is set.
    await strut.workspace.publishWorkflow("builder", "v1", { steps: [{ id: "result", type: "pack", config: { text: "Built." } }] });
    /** Launch one turn; `extra` is more of the launch body (attachments). */
    const turn = async (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const res = await strut.app.request(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, callback: { url: callback }, ...extra }),
      });
      assert.equal(res.status, 202);
      const runId = ((await res.json()) as any).runId as string;
      return until(() => ends.find((e) => e.runId === runId));
    };
    return { strut, seen, ends, turn };
  };
  /** The text of a request's last user message. */
  const lastUser = (body: any) => JSON.stringify(body.messages.filter((m: any) => m.role === "user").at(-1));

  it("two turns in one session: the second starts a job and ends; the job's run.end reaches its callback; one prompt", async () => {
    const replies = [
      toolUse("toolu_1", "final_answer", { text: "Kate's birthday is 3 May.", artifacts: [] }),
      toolUse("toolu_2", "job_start", { prompt: "Find flights to Lisbon for 3 May", title: "Flights to Lisbon" }),
      toolUse("toolu_3", "final_answer", { text: "Started a job for the flights.", artifacts: [] }),
    ];
    const { strut, seen, ends, turn } = await boot((n) => replies[n - 1] ?? assert.fail(`unexpected orchestrator request #${n}`));
    const session = "peel/agent-1/dm";

    const first = await turn({ prompt: "When is Kate's birthday?", session, context: { line: "Thu 16 Oct 14:02, Europe/London. " } });
    assert.equal(first.workflow, ORCHESTRATOR_WORKFLOW);
    assert.equal(first.status, "success", JSON.stringify(first));
    assert.equal(first.output.text, "Kate's birthday is 3 May.");
    assert.equal(first.output.session.id, session);
    assert.ok(lastUser(seen.orch[0]).includes("Thu 16 Oct 14:02, Europe/London. When is Kate's birthday?"), "the host's line heads the prompt; no peers, no list");
    const system = JSON.stringify(seen.orch[0].system);
    assert.ok(system.includes("Start a JOB"), "strut's prompt");
    assert.ok(system.includes("HOSTSECTION"), "the host's section after it");
    const tools = seen.orch[0].tools.map((t: any) => t.name);
    assert.ok(tools.includes("job_start") && tools.includes("job_continue"), tools.join(","));
    assert.ok(!tools.some((t: string) => t.startsWith("memory_")), "no memory by default");
    assert.ok(!tools.includes("bash"), "no built-ins");

    // A revised prompt (a host's new section) between turns does not reach
    // the running session: its prompt is its first turn's.
    await seedOrchestratorWorkflow(strut.workspace, { system: "REVISED SECTION" });

    const second = await turn({ prompt: "Find me flights there for it", session, context: { line: "Thu 16 Oct 14:05, Europe/London. " } });
    assert.equal(second.status, "success", JSON.stringify(second));
    assert.equal(second.output.text, "Started a job for the flights.");
    assert.ok(JSON.stringify(seen.orch[1].messages).includes("Kate's birthday is 3 May."), "turn 2 continues the session");
    assert.deepEqual(seen.orch[1].system, seen.orch[0].system, "the system prompt is fixed within a session");
    assert.ok(!JSON.stringify(seen.orch[1].system).includes("REVISED"));

    const started = seen.orch[2].messages.at(-1).content.find((b: any) => b.type === "tool_result");
    const { job: jobId, runId: jobRun, callback: hasCallback } = JSON.parse(typeof started.content === "string" ? started.content : started.content[0].text);
    assert.equal(hasCallback, true);
    const jobEnd = await until(() => ends.find((e) => e.workflow === "job"));
    assert.equal(jobEnd.runId, jobRun);
    assert.equal(jobEnd.job, jobId);
    assert.equal(jobEnd.status, "success");
    assert.equal(jobEnd.output.text, "Three flights.");
    assert.ok(seen.job[0]!.includes("Find flights to Lisbon for 3 May"));
    assert.equal(seen.orch.length, 3, "the orchestrator never waited on the job");
  });
  it("a reply's `start` starts the job after the turn: ONE model call, the job inherits the callback, the result names the job", async () => {
    const { seen, ends, turn } = await boot(() =>
      toolUse("toolu_1", "final_answer", {
        text: "Looking into the flights.",
        start: { brief: "Find flights to Lisbon for 3 May", title: "Flights to Lisbon" },
        artifacts: [],
      }),
    );
    const first = await turn({ prompt: "flights to Lisbon?", session: "peel/agent-1/dm-s" });
    assert.equal(first.status, "success", JSON.stringify(first));
    assert.equal(first.output.text, "Looking into the flights.");
    assert.equal(seen.orch.length, 1, "no job/start tool call, so no second model call");
    const jobEnd = await until(() => ends.find((e) => e.workflow === "job"));
    assert.equal(jobEnd.status, "success");
    assert.equal(jobEnd.job, first.output.job, "the pack names the started job");
    assert.equal(jobEnd.runId, first.output.runId);
    assert.equal(jobEnd.startedBy?.runId, first.runId, "started by this turn, the callback the turn was launched with");
    assert.ok(seen.job[0]!.includes("Find flights to Lisbon for 3 May"));
  });
  /** The job run `start` launched, and its `run.start` as the job's log keeps it. */
  const startedJob = async (strut: any, ends: any[], workflow: string) => {
    const end = await until(() => ends.find((e) => e.workflow === workflow));
    const runStart = (strut.store.getEvents(workflow, end.runId) as any[]).find((e) => e.type === "run.start");
    return { end, runStart };
  };
  it("`start` carries `peer` to a build on another workspace, as job/start would", async () => {
    const { strut, ends, turn } = await boot(() =>
      toolUse("toolu_1", "final_answer", {
        text: "On it.",
        start: { brief: "Build a digest workflow", title: "Digest", workflow: "builder", peer: "acme-web" },
        artifacts: [],
      }),
    );
    const first = await turn({ prompt: "Build a digest on @acme-web", session: "peel/agent-1/dm-p" });
    assert.equal(first.status, "success", JSON.stringify(first));
    const { end, runStart } = await startedJob(strut, ends, "builder");
    assert.equal(end.runId, first.output.runId);
    assert.equal(runStart.input.peer, "acme-web");
    assert.equal(runStart.input.prompt, "Build a digest workflow");
  });
  it("`start` carries `repos` and THIS message's `attachments` to the job, which keeps its own copy of the file", async () => {
    const notes = "# Notes\nThe flaky test is in ci.yml.";
    const { strut, ends, turn } = await boot(() =>
      toolUse("toolu_1", "final_answer", {
        text: "Looking into it.",
        start: { brief: "Fix the flaky CI test", title: "Flaky CI", repos: ["https://github.com/acme/web"], attachments: ["notes.md"] },
        artifacts: [],
      }),
    );
    const first = await turn(
      { prompt: "fix the flaky test, see my notes", session: "peel/agent-1/dm-r" },
      { attachments: [{ name: "notes.md", mediaType: "text/markdown", data: Buffer.from(notes).toString("base64") }] },
    );
    assert.equal(first.status, "success", JSON.stringify(first));
    const { end, runStart } = await startedJob(strut, ends, "job");
    assert.equal(end.runId, first.output.runId);
    assert.deepEqual(runStart.input.repos, ["https://github.com/acme/web"]);
    assert.deepEqual(runStart.attachments, [{ name: "notes.md", mediaType: "text/markdown", size: Buffer.byteLength(notes), path: "attachments/notes.md" }]);
    assert.equal(await (await strut.app.request(`/artifacts/${end.runId}/attachments/notes.md`)).text(), notes);
  });
  it("`start` with a kind on a builder job drops the kind (job/start refuses it) and the build starts", async () => {
    const { strut, ends, turn } = await boot(() =>
      toolUse("toolu_1", "final_answer", {
        text: "On it.",
        start: { brief: "Build a digest workflow", title: "Digest", workflow: "builder", kind: "Code Change" },
        artifacts: [],
      }),
    );
    const first = await turn({ prompt: "build me a digest", session: "peel/agent-1/dm-k" });
    assert.equal(first.status, "success", JSON.stringify(first));
    assert.equal(first.output.startError, undefined);
    const { end, runStart } = await startedJob(strut, ends, "builder");
    assert.equal(end.runId, first.output.runId);
    assert.equal(runStart.input.kind, undefined);
  });
  it("a `start` job/start refuses never fails the turn: the reply goes out saying the job did not start, with `startError`", async () => {
    const { turn, seen } = await boot(() =>
      toolUse("toolu_1", "final_answer", {
        text: "Looking into it.",
        start: { brief: "Read my notes", title: "Notes", attachments: ["from-yesterday.md"] },
        artifacts: [],
      }),
    );
    const ended = await turn({ prompt: "use the notes I sent yesterday", session: "peel/agent-1/dm-e" });
    assert.equal(ended.status, "success", JSON.stringify(ended));
    assert.match(ended.output.startError, /from-yesterday\.md/);
    assert.match(ended.output.text, /^Looking into it\. \(The job did not start: .*from-yesterday\.md/);
    assert.equal(ended.output.job, undefined);
    assert.equal(seen.job.length, 0);
  });
  it("without `start` the job step is skipped and the result carries no job", async () => {
    const { turn, seen } = await boot(() => toolUse("toolu_1", "final_answer", { text: "Kate's birthday is 3 May.", artifacts: [] }));
    const ended = await turn({ prompt: "when is Kate's birthday?", session: "peel/agent-1/dm-n" });
    assert.equal(ended.status, "success", JSON.stringify(ended));
    assert.equal(ended.output.job, undefined);
    assert.equal(seen.job.length, 0);
  });
  it("per-launch knobs: params.model, params.reasoning and params.stream ride on a launch (no grant guard); the voice line heads the turn's prompt, never the system prompt; deltas stay in the log, off the sink", async () => {
    const { strut, seen, turn } = await boot(() => toolUse("toolu_1", "final_answer", { text: "Sure thing.", artifacts: [] }));
    // The default launch: the template's own model and reasoning.
    await turn({ prompt: "hi", session: "peel/agent-1/dm-k1" });
    const base = seen.orch[0];
    assert.equal(base.model, "claude-sonnet-5-5");

    const res = await strut.app.request(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { prompt: "what's on today?", session: "peel/agent-1/dm-k2", context: { line: "On a voice call: answer in a sentence or two. " } },
        params: { model: "claude-haiku-4-5", reasoning: "none", stream: true },
      }),
    });
    assert.equal(res.status, 202, "a knob is not a grant");
    const runId = ((await res.json()) as any).runId as string;
    const end = await until(() => (strut as any).store.getSummary?.(ORCHESTRATOR_WORKFLOW, runId));
    assert.equal(end.status, "success", JSON.stringify(end));
    const body = seen.orch[1];
    assert.equal(body.model, "claude-haiku-4-5");
    assert.deepEqual(base.output_config, { effort: "medium" }, "the default is what the turn always ran at");
    assert.deepEqual(body.thinking, { type: "disabled" }, "reasoning none: no thinking");
    assert.ok(lastUser(body).includes("On a voice call: answer in a sentence or two. what's on today?"));
    assert.ok(!JSON.stringify(body.system).includes("On a voice call"), "the line is the turn's, not the session's frozen system prompt");
    const events = (strut as any).store.getEvents(ORCHESTRATOR_WORKFLOW, runId);
    const deltas = events.filter((e: any) => e.type === "reply.delta");
    assert.equal(deltas.map((d: any) => d.text).join(""), "Sure thing.");
    assert.ok(deltas.every((d: any) => d.path === `${ORCHESTRATOR_WORKFLOW}/turn`));
  });
  it("each turn's message lists the peers it can ask, by id and label, so a label finds the id and a peer added mid-session is known", async () => {
    const { seen, turn } = await boot(
      () => toolUse("toolu_p", "final_answer", { text: "Asked.", artifacts: [] }),
      [{ id: "hive", baseUrl: "http://127.0.0.1:9", token: "t", label: "Stakwork" }, { id: "senza-backend", baseUrl: "http://127.0.0.1:9", token: "t" }],
    );
    const ended = await turn({ prompt: "ask stakwork how the app works", session: "peel/agent-1/dm-p", context: { line: "Fri 23 Oct 18:52, GMT+1. " } });
    assert.equal(ended.status, "success", JSON.stringify(ended));
    assert.ok(
      lastUser(seen.orch[0]).includes("Fri 23 Oct 18:52, GMT+1. Workspaces you can ask: @hive (Stakwork), @senza-backend. ask stakwork how the app works"),
      lastUser(seen.orch[0]),
    );
  });
  it("with a self record, this workspace is named first and the list is the others, so a host's own `@<slug>` before the message reads as this one", async () => {
    const { seen, turn } = await boot(
      () => toolUse("toolu_s", "final_answer", { text: "Looked.", artifacts: [] }),
      [{ id: "hive", baseUrl: "http://127.0.0.1:9", token: "t", label: "Stakwork" }],
      { id: "acme-web", label: "Acme Web" },
    );
    const ended = await turn({ prompt: "@acme-web\nhow does login work", session: "jamie-conv-1", context: { line: "Fri 23 Oct 18:52, Europe/London. " } });
    assert.equal(ended.status, "success", JSON.stringify(ended));
    assert.ok(
      lastUser(seen.orch[0]).includes(
        "Fri 23 Oct 18:52, Europe/London. This workspace is @acme-web (Acme Web). Other workspaces you can ask: @hive (Stakwork). @acme-web\\nhow does login work",
      ),
      lastUser(seen.orch[0]),
    );
  });
});
