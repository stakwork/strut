import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createStrut, type Strut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { defineStep, stopOf, withStop, type StepContext, type StepRegistry } from "./core.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { hostConfigFromEnv } from "./server.js";
import { escaped, unescaped } from "./steps/lib/automation/_shared.js";
import list from "./steps/lib/automation/list.js";
import preview from "./steps/lib/automation/preview.js";
import create from "./steps/lib/automation/create.js";
import update from "./steps/lib/automation/update.js";
import del from "./steps/lib/automation/delete.js";
import runNow from "./steps/lib/automation/run-now.js";

// The automation/* steps: an agent's own door onto strut's automations,
// scoped to the one workflow the host names, the acting ones behind the
// host's approval step.

const WF = "digest";
const OTHER = "other";

/** The host's approval step: answers as the test says, and records what it was asked. */
let answer: "allow" | "deny" | "pending" = "allow";
let asked: { intent: any; grant?: any; path: string }[] = [];
const approve = defineStep({
  type: "test/approve",
  input: z.object({ intent: z.object({ action: z.string(), content: z.string().optional(), details: z.array(z.string()).optional() }), grant: z.any().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    asked.push({ intent: cfg.intent, path: ctx.path, ...(cfg.grant ? { grant: cfg.grant } : {}) });
    if (answer === "pending") return withStop({ status: "pending", note: "Waiting for your Mac" });
    return answer === "allow" ? { approved: true } : { approved: false, status: "denied" };
  },
});

const runInputs = {
  name: { type: "string" },
  prompt: { type: "string" },
  since: { type: "json", required: false },
  now: { type: "string", required: false },
};
const logPrompt = [{ id: "log", type: "log", config: { message: "{{ input.prompt }}" } }];

describe("automation/* steps", () => {
  let dir = "";
  let strut: Strut;
  let store: MemoryRunStore;
  let registry: StepRegistry;
  let saved: string | undefined;

  const boot = async (automation?: { workflow: string; approve?: string; grants?: boolean }) => {
    store = new MemoryRunStore();
    registry = await createRegistry([approve]);
    strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      registry,
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      systemWorkflows: false,
      job: false,
      orchestrator: false,
      ...(automation ? { automation } : {}),
    });
    for (const name of [WF, OTHER]) await strut.workspace.publishWorkflow(name, "v1", { input: runInputs, steps: logPrompt });
  };

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-automation-steps-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    answer = "allow";
    asked = [];
  });
  afterEach(async () => {
    await strut?.close();
    await rm(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
  });

  /** A step as an agent's tool call: `orch/turn/<n>-<tool>`. */
  let call = 0;
  const ctx = (journal?: Record<string, unknown>): StepContext => ({
    runId: "run-1",
    path: `orch/turn/${String(++call).padStart(3, "0")}-automation`,
    scope: {},
    input: undefined,
    emit: async () => {},
    services: strut.services,
    registry,
    agentTool: true,
    ...(journal ? { journal } : {}),
  });
  const run = async (step: { input: z.ZodTypeAny; run: (cfg: any, ctx: StepContext) => Promise<unknown> }, cfg: unknown, c = ctx()) =>
    (await step.run(step.input.parse(cfg), c)) as any;
  const weekly = { every: "week", on: ["fri"], at: ["17:00"], tz: "Europe/London" };

  it("create asks with strut's words for the schedule, and makes it only once allowed", async () => {
    await boot({ workflow: WF, approve: "test/approve" });

    answer = "deny";
    const denied = await run(create, { name: "Friday list", prompt: "Make my to-do list", trigger: weekly });
    assert.deepEqual(denied, { changed: false, status: "denied", error: "The person did not allow it. Do not try again unless they ask." });
    assert.equal((await strut.automations.list(WF)).length, 0, "nothing exists before an allow");
    assert.equal(asked[0]!.intent.action, "Create the automation “Friday list”");
    assert.equal(asked[0]!.intent.content, "Make my to-do list");
    assert.match(asked[0]!.intent.details[0], /^Runs: Fri at 5:00 PM \(London time\); next Fri \d+ \w+, 17:00/);
    assert.match(asked[0]!.path, /^orch\/turn\/\d+-automation\/approve$/, "the approval runs under the call's own path");

    answer = "pending";
    const waiting = await run(create, { name: "Friday list", prompt: "Make my to-do list", trigger: weekly });
    assert.ok(stopOf(waiting), "no answer yet ends the turn");
    assert.equal(waiting.changed, false);
    assert.equal(waiting.waiting.status, "pending");
    assert.equal((await strut.automations.list(WF)).length, 0);

    answer = "allow";
    const made = await run(create, { name: "Friday list", prompt: "Make my {{ list }}", trigger: weekly });
    assert.equal(made.created.name, "Friday list");
    assert.equal(made.created.prompt, "Make my {{ list }}", "the agent reads its own words back");
    const [stored] = await strut.automations.list(WF);
    assert.equal(stored!.enabled, true);
    assert.deepEqual(stored!.input, { name: "Friday list", prompt: escaped("Make my {{ list }}"), since: "{{ last.finishedAt }}", now: "{{ now }}" });
    assert.equal(stored!.callback, undefined, "a call outside a launched run has no callback to inherit");

    await assert.rejects(run(create, { name: "friday LIST", prompt: "again", trigger: weekly }), /exists already/);
    // A one-off already past (a wrong year) is refused before any card.
    const asks = asked.length;
    await assert.rejects(run(create, { name: "Sand the tops", prompt: "p", trigger: { every: "once", at: "2025-10-18T13:00", tz: "Europe/London" } }), /no runs to come/);
    assert.equal(asked.length, asks);
    // What the card shows whole: a one-line name, a prompt within a page.
    await assert.rejects(run(create, { name: "A\nRuns: never", prompt: "p", trigger: weekly }), /one line/);
    await assert.rejects(run(create, { name: "x".repeat(101), prompt: "p", trigger: weekly }));
    await assert.rejects(run(create, { name: "Long", prompt: "p".repeat(4001), trigger: weekly }));
  });

  it("a grant goes on the same card under the automation's id, which every fire's steps read as ctx.automation", async () => {
    await boot({ workflow: WF, approve: "test/approve" });
    const posts = { chats: ["Hive"], max_price_sats: 10 };
    await assert.rejects(run(create, { name: "Hive test", prompt: "Post hi", trigger: weekly, grant: posts }), /takes no grant/);
    assert.equal(asked.length, 0, "a host without grants asks nothing");
    const plain = await run(create, { name: "Plain", prompt: "p", trigger: weekly });
    assert.match(plain.created.id, /^a-[0-9a-f]{8}$/, "the scheduler's own id format");
    await run(update, { id: plain.created.id, enabled: false });
    assert.equal(asked.at(-1)!.grant, undefined, "a host without grants is told nothing about one");
    await strut.close();

    await boot({ workflow: WF, approve: "test/approve", grants: true });
    const c = ctx();
    answer = "pending";
    await run(create, { name: "Hive test", prompt: "Post hi", trigger: weekly, grant: posts }, c);
    const first = asked.at(-1)!.grant;
    assert.match(first.automation, /^a-[0-9a-f]{8}$/);
    assert.deepEqual(first, { ...posts, automation: first.automation, name: "Hive test" });
    const named = async () => (await strut.automations.list(WF)).find((a) => a.name.startsWith("Hive"));
    assert.equal(await named(), undefined, "nothing exists before an allow");
    answer = "allow";
    const made = await run(create, { name: "Hive test", prompt: "Post hi", trigger: weekly, grant: posts }, c);
    assert.equal(asked.at(-1)!.grant.automation, first.automation, "the same call asks the same question");
    assert.equal(made.created.id, first.automation, "the automation IS the id the card named");
    const stored = await named();
    assert.deepEqual(stored!.input, { name: "Hive test", prompt: "Post hi", since: "{{ last.finishedAt }}", now: "{{ now }}" }, "nothing of the grant rides in the input");
    assert.equal(made.created.grant, undefined, "strut keeps nothing of the grant");

    // Another call is another automation; a model-written id is never read.
    await run(create, { name: "Other", prompt: "p", trigger: weekly, grant: { ...posts, automation: first.automation } });
    assert.notEqual(asked.at(-1)!.grant.automation, first.automation, "strut's id wins over one in the grant");

    // A change or a run-now names the automation, with a new grant or without one.
    await run(update, { id: stored!.id, prompt: "Post hello" });
    assert.deepEqual(asked.at(-1)!.grant, { automation: first.automation, name: "Hive test" }, "the card names the automation it changes");
    await run(update, { id: stored!.id, name: "Hive hello" });
    assert.deepEqual(asked.at(-1)!.grant, { automation: first.automation, name: "Hive hello" }, "under its new name");
    const regranted = await run(update, { id: stored!.id, grant: { chats: ["Hive", "Kate"], max_price_sats: 0 } });
    assert.equal(asked.at(-1)!.intent.action, "Change “Hive hello”");
    assert.deepEqual(asked.at(-1)!.grant, { chats: ["Hive", "Kate"], max_price_sats: 0, automation: first.automation, name: "Hive hello" });
    assert.equal(regranted.changed.prompt, "Post hello");

    // The fire hands its run the automation, and nothing a caller sends can.
    const fired = await run(runNow, { id: stored!.id });
    assert.deepEqual(asked.at(-1)!.grant, { automation: first.automation, name: "Hive hello" });
    let start;
    for (let i = 0; i < 300 && !start; i++) {
      start = (store.getEvents(WF, fired.started.runId) as any[]).find((e) => e.type === "run.start");
      if (!start) await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual([start.origin, start.automation], ["schedule", { id: first.automation }]);
    await run(del, { id: stored!.id });
    assert.deepEqual(asked.at(-1)!.grant, { automation: first.automation, name: "Hive hello" }, "a delete names it too, so the host lets its grant go");
  });

  it("every step of a fire sees ctx.automation; a run launched any other way sees none", async () => {
    await boot({ workflow: WF, approve: "test/approve" });
    const seen: unknown[] = [];
    const peek = defineStep({ type: "test/peek", input: z.any(), output: z.any(), async run(_cfg, ctx) { seen.push(ctx.automation); return {}; } });
    await strut.close();
    registry = await createRegistry([approve, peek]);
    strut = await createStrut({ workspace: new WorkspaceManager(dir), registry, store, serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, job: false, orchestrator: false });
    await strut.workspace.publishWorkflow(WF, "v1", { steps: [{ id: "p", type: "test/peek", config: {} }] });
    const made = (await strut.automations.create(WF, { name: "Peek", trigger: weekly, input: {} })) as any;
    const fired = (await strut.automations.fire(WF, made.automation.id)) as any;
    const plain = await strut.app.request(`/workflows/${WF}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {}, automation: { id: made.automation.id } }) });
    assert.equal(plain.status, 202);
    for (let i = 0; i < 300 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [{ id: made.automation.id }, undefined]);
    assert.ok(fired.runId);
  });

  it("list and preview read only the steps' workflow and never ask", async () => {
    await boot({ workflow: WF, approve: "test/approve" });
    await strut.automations.create(OTHER, { name: "Not yours", trigger: weekly, input: { prompt: "x" } });
    await strut.automations.create(WF, { name: "Yours", trigger: weekly, input: { name: "Yours", prompt: escaped("a {{b}}") } });
    const listed = await run(list, {});
    assert.deepEqual(listed.automations.map((a: any) => [a.name, a.prompt]), [["Yours", "a {{b}}"]]);
    const seen = await run(preview, { trigger: { every: "day", at: ["08:00"], tz: "UTC" } });
    assert.match(seen.summary, /^Every day at 8:00 AM \(UTC\); next /);
    assert.equal(seen.next.length, 5);
    await assert.rejects(run(preview, { trigger: { every: "day", at: ["25:00"] } }), /HH:MM/);
    assert.equal(asked.length, 0);
  });

  it("update, delete and run-now act on the steps' workflow only, each once allowed", async () => {
    await boot({ workflow: WF, approve: "test/approve" });
    const other = (await strut.automations.create(OTHER, { name: "System", trigger: weekly, input: { prompt: "x" } })) as any;
    const mine = (await strut.automations.create(WF, { name: "Recap", trigger: weekly, input: { name: "Recap", prompt: "Recap the week" } })) as any;
    for (const step of [update, del, runNow]) {
      await assert.rejects(run(step, { id: other.automation.id, enabled: false }), /not one of yours to change/);
    }
    await assert.rejects(run(del, { id: "nope" }), /No automation has the id nope/);
    assert.equal(asked.length, 0, "a refusal asks nothing");

    assert.deepEqual(await run(update, { id: mine.automation.id }), { changed: false, error: "Nothing to change." });
    const paused = await run(update, { id: mine.automation.id, enabled: false });
    assert.equal(asked.at(-1)!.intent.action, "Pause “Recap”");
    assert.equal(paused.changed.enabled, false);
    await strut.automations.create(WF, { name: "Taken", trigger: weekly, input: { prompt: "t" } });
    await assert.rejects(run(update, { id: mine.automation.id, name: "taken" }), /exists already/);
    await run(update, { id: mine.automation.id, prompt: "Recap the week, briefly" });
    assert.equal(asked.at(-1)!.intent.content, "Recap the week, briefly", "a new prompt is the card's content");
    await run(update, { id: mine.automation.id, prompt: "Recap the week" });
    const renamed = await run(update, { id: mine.automation.id, name: "Weekly recap" });
    assert.equal(renamed.changed.name, "Weekly recap");
    assert.deepEqual((await strut.automations.list(WF))[0]!.input, { name: "Weekly recap", prompt: "Recap the week", since: "{{ last.finishedAt }}", now: "{{ now }}" });

    answer = "deny";
    assert.equal((await run(runNow, { id: mine.automation.id })).changed, false);
    assert.equal((await store.listRuns(WF)).length, 0);
    answer = "allow";
    const started = await run(runNow, { id: mine.automation.id });
    assert.equal(asked.at(-1)!.intent.content, "Recap the week");
    assert.ok(started.started.runId);

    const gone = await run(del, { id: mine.automation.id });
    assert.deepEqual(gone.deleted, { id: mine.automation.id, name: "Weekly recap" });
    assert.deepEqual((await strut.automations.list(WF)).map((a) => a.name), ["Taken"]);
  });

  it("a resumed call gets what it did back, asking and acting nothing again", async () => {
    await boot({ workflow: WF, approve: "test/approve" });
    const c = ctx();
    const key = c.path.replace(/\/([^/]+)$/, "#$1");
    const done = { started: { id: "a1", name: "Recap", runId: "r1" } };
    assert.deepEqual(await run(runNow, { id: "anything" }, { ...c, journal: { [key]: done } }).catch((e) => e), new Error("No automation has the id anything; automation/list shows them."),
      "it still checks the id is its own");
    const mine = (await strut.automations.create(WF, { name: "Recap", trigger: weekly, input: { prompt: "p" } })) as any;
    const replay = await run(runNow, { id: mine.automation.id }, { ...c, journal: { [key]: done } });
    assert.deepEqual(replay, done);
    assert.equal(asked.length, 0);
    assert.equal((await store.listRuns(WF)).length, 0);
  });

  it("refuses to act without an approval step, and everything without a workflow", async () => {
    await boot({ workflow: WF });
    assert.deepEqual((await run(list, {})).automations, [], "reading needs no approval step");
    await assert.rejects(run(create, { name: "x", prompt: "y", trigger: weekly }), /no approval step/);
    assert.equal((await strut.automations.list(WF)).length, 0);
    await strut.close();
    await boot();
    await assert.rejects(run(list, {}), /names no workflow/);
  });

  it("braces in the person's words survive the template, and read back as written", () => {
    for (const text of ["{{ now }}", "a }} b {{", "{x}", "{{{", "plain"]) assert.equal(unescaped(escaped(text)), text);
    assert.equal(escaped("{{ now }}"), "{​{ now }​}");
  });

  it("the bundled server reads the steps' workflow and approval step from STRUT_HOST_CONFIG", async () => {
    const file = join(dir, "host.json");
    await writeFile(file, JSON.stringify({ automation: { workflow: "peel-automation-run", approve: "sphinx/approve" } }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { automation: { workflow: "peel-automation-run", approve: "sphinx/approve" } });
    await writeFile(file, JSON.stringify({ automation: { workflow: "w", approve: "a", grants: true } }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { automation: { workflow: "w", approve: "a", grants: true } });
    await writeFile(file, JSON.stringify({ automation: { workflow: "w", grants: "yes" } }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"automation" must be/);
    await writeFile(file, JSON.stringify({ automation: { approve: "sphinx/approve" } }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"automation" must be/);
  });
});

// Through a whole strut: an orchestrator-shaped turn whose agent is granted
// automation/create, a stand-in model and a stand-in host. The automation
// the turn makes reports where the turn does: its fire's run.end reaches
// the host the turn was launched with.
describe("automation/create from a turn", () => {
  const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const toolUse = (id: string, name: string, input: unknown) =>
    sse({
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
    }) +
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
    sse({ type: "message_stop" });

  let dir = "";
  let provider: http.Server;
  let host: http.Server;
  let hostUrl = "";
  let posts: any[] = [];
  let strut: Strut | undefined;
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  let saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-automation-turn-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    posts = [];
    answer = "allow";
    asked = [];
    let n = 0;
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const last = body.messages.at(-1);
        const answered = Array.isArray(last?.content) && last.content.some((b: any) => b.type === "tool_result");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          answered
            ? toolUse(`toolu_${++n}`, "final_answer", { text: "Set up.", artifacts: [] })
            : toolUse(`toolu_${++n}`, "automation_create", { name: "Daily", prompt: "Say hi", trigger: { every: "day", at: ["08:00"], tz: "UTC" } }),
        );
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    host = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        posts.push(JSON.parse(raw));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    hostUrl = `http://127.0.0.1:${(host.address() as any).port}/hook?token=s3cret`;
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as any).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
  });
  afterEach(async () => {
    await strut?.close();
    provider.close();
    host.close();
    await rm(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("the automation inherits the turn's callback, so its fires reach the host", async () => {
    const store = new MemoryRunStore();
    strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      registry: await createRegistry([approve]),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      systemWorkflows: false,
      job: false,
      orchestrator: false,
      automation: { workflow: WF, approve: "test/approve" },
    });
    await strut.workspace.publishWorkflow(WF, "v1", { input: runInputs, steps: logPrompt });
    await strut.secretStore.set("STRUT_DEFAULT_MODEL", "anthropic/claude-sonnet-4-5");
    await strut.workspace.publishWorkflow("orch", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        {
          id: "turn",
          type: "agent",
          config: {
            // No model of its own: the connected one (a host delta's `model: null`).
            cwd: "{{ dir.path }}", system: "ORCH", prompt: "{{ input.prompt }}", model: "{{ params.model }}", toolFilter: ["none"],
            agentTools: ["automation/create"],
            schema: { type: "object", required: ["text", "artifacts"], properties: { text: { type: "string" }, artifacts: { type: "array" } } },
          },
        },
      ],
    });
    const res = await strut.app.request("/workflows/orch/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { prompt: "say hi every morning" }, callback: { url: hostUrl } }),
    });
    assert.equal(res.status, 202);
    const until = async <T>(find: () => Promise<T | undefined> | T | undefined): Promise<T> => {
      for (let i = 0; i < 1500; i++) {
        const v = await find();
        if (v !== undefined) return v;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("never happened");
    };
    await until(() => posts.find((p) => p.workflow === "orch"));
    assert.equal(asked.length, 1);
    const [made] = await strut.automations.list(WF);
    assert.equal(made!.callback?.origin, new URL(hostUrl).origin);

    const fired = await strut.automations.fire(WF, made!.id);
    assert.ok("runId" in fired);
    const end = await until(() => posts.find((p) => p.workflow === WF));
    assert.equal(end.runId, fired.runId);
    assert.equal(end.status, "success");
  });
});
