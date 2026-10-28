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
  it("the template is a valid workflow over strut's own registry: job/dir → context/concept three times (the kinds of job, the kinds of build, no docs; what the team builds, with docs) → strut/list-peers → agent (session, no built-ins) → pack, every grant a strut step", async () => {
    const text = await orchestratorWorkflowYaml();
    const registry = await createRegistry([]);
    const v = validateWorkflowYaml(text, { registry });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));

    const flow = flowFromYaml(ORCHESTRATOR_WORKFLOW, "v1", text);
    assert.deepEqual(flow.steps.map((s) => s.type), ["job/dir", "context/concept", "context/concept", "context/concept", "strut/list-peers", "agent", "pack"]);
    assert.equal(flow.inputBlock?.["prompt"]?.required ?? true, true);
    for (const k of ["session", "context"]) assert.equal(flow.inputBlock?.[k]?.required, false, `${k} is optional`);
    // Two lists, one per agent's tree, children alone: the kinds of work a
    // job does here (Job) and the kinds of thing the builder builds
    // (Workflow Builder). The pages' docs are those agents' instructions,
    // and this agent has no graph-get to open a page with.
    assert.deepEqual(flow.steps[1]!.config, { name: "{{ params.concept }}", docs: false, tool: "" });
    assert.deepEqual(flow.steps[2]!.config, { name: "{{ params.buildConcept }}", docs: false, tool: "" });
    assert.deepEqual(flow.steps[3]!.config, { name: "{{ params.codebaseConcept }}", docs: true, tool: "" }, "the overview itself is read: it places a request");
    const params = (yaml.load(text) as { params: { concept: string; buildConcept: string; codebaseConcept: string } }).params;
    assert.deepEqual([params.concept, params.buildConcept, params.codebaseConcept], ["Job", "Workflow Builder", "Codebase"]);
    const turn = flow.steps[5]!.config as Record<string, unknown>;
    assert.equal(turn["systemAtCompaction"], undefined, "a session keeps its first turn's prompt");
    assert.deepEqual(turn["toolFilter"], ["none"]);
    assert.equal(turn["system"], "{{ params.system }}\n{{ concepts.text }}\n{{ builds.text }}\n{{ codebase.text }}", "the two lists and the codebase page close the prompt");

    const { tools } = paramsOf(text);
    for (const t of ["job/start", "job/continue", "job/list", "job/get", "job/read", "memory/recall", "memory/remember"]) assert.ok(tools.includes(t), t);
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
      system.includes("To build, change, test or debug a workflow, or an app that lives in a workspace, start the job with `workflow: builder`, on the strut whose workspace it belongs to (`peer` when that is not this one)."),
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
    const turn = async (input: Record<string, unknown>) => {
      const res = await strut.app.request(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, callback: { url: callback } }),
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
    assert.ok(tools.includes("job_start") && tools.includes("job_continue") && tools.includes("memory_recall"), tools.join(","));
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
