/**
 * A claim on a Concept judged against a WORK (src/work.ts, plans/concept-
 * evals.md rulings 5 and 9), end to end: a whole strut on a graph workspace,
 * the shipped `orchestrator` and `concept-check` workflows, a small `job`
 * workflow, and a stand-in model. A person's turn starts a job; the job
 * opens a page the turn never did and writes a plan; strut's wake turn
 * reports on it. The claims on the pages are judged ONCE, after the last of
 * the three runs, against all three, and the judge opens the plan through
 * its one tool. A work still in flight is not judged, and a work that a
 * restart cut in two is judged by the process that saw its end.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GraphBackend } from "./backend.js";
import { evidenceId } from "./claims.js";
import { projectionsSettled } from "./projector.js";
import { testBackends } from "./test-util.js";
import { GraphWorkspaceStore } from "./workspace-store.js";
import { defineStep, type StepRegistry } from "../core.js";
import { createStrut, type Strut } from "../createStrut.js";
import { type KnowledgeCapability } from "../knowledge.js";
import { ORCHESTRATOR_WORKFLOW } from "../orchestrator-seed.js";
import type { ParkSource, ParkWaker } from "../park.js";
import { createRegistry } from "../steps/registry.js";
import { MemoryRunStore, type RunStore } from "../store.js";

const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
const start = sse({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
});
const toolUse = (id: string, name: string, input: unknown) =>
  start +
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
  sse({ type: "message_stop" });

const ROLLOUT = "A plan ends with a rollout section";
const HANDED = "A request for a plan is handed to a job";
const PLAN = "1. Build it.\n2. Rollout: staged, 10% first.";

for (const tb of testBackends()) describe(`a claim on a Concept judged against the whole work, on ${tb.name}`, { skip: tb.skip }, () => {
  let backend: GraphBackend;
  let provider: http.Server;
  let dir = "";
  let store: RunStore;
  const struts: Strut[] = [];
  /** The last strut's waker for `ans:*`. */
  let waker: ParkWaker | undefined;
  /** Each judge RUN's first request, and every request a judge made. */
  let judgeRuns: string[] = [];
  let judgeCalls: string[] = [];
  /** What the judge says of the rule about handing plans to a job: a verdict, or none. */
  let handedVerdict: boolean | null = true;
  /** Wake turns wait for this. */
  let wakeGate: Promise<void> = Promise.resolve();
  let wakesSeen = 0;
  /** The job's step waits on `ans:plan` until it is answered. */
  let answers: Map<string, unknown>;
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    let n = 0;
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", async () => {
        const body = JSON.parse(raw) as { system?: unknown; messages: Array<{ role: string; content: unknown }> };
        const system = JSON.stringify(body.system ?? "");
        const all = JSON.stringify(body.messages);
        const last = body.messages.at(-1);
        const afterTool = Array.isArray(last?.content) && (last!.content as Array<{ type?: string }>).some((c) => c.type === "tool_result");
        const say = (name: string, input: unknown) => res.end(toolUse(`toolu_${++n}`, name, input));
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (system.includes("You judge whether a piece of work did what a rule says")) {
          judgeCalls.push(all);
          if (!afterTool) judgeRuns.push(all);
          if (all.includes(ROLLOUT)) {
            if (!afterTool) {
              const folder = /FOLDERS OF FILES THE WORK MADE: ([A-Za-z0-9._-]+)\//.exec(all)?.[1] ?? "none";
              return say("context_work_file", { path: `${folder}/plan.md` });
            }
            return say("final_answer", all.includes("Rollout: staged") ? { supports: true, content: "the plan's last item is its rollout" } : { content: "no plan to read" });
          }
          return say("final_answer", handedVerdict === null ? { content: "nothing here asked for a plan" } : { supports: handedVerdict, content: "RUN 2 is the job RUN 1 started" });
        }
        if (all.includes("<<<job reply")) {
          wakesSeen++;
          await wakeGate;
          return say("final_answer", { text: "The plan is ready.", artifacts: [] });
        }
        // A person's turn: a request for a plan goes to a job; anything else is answered.
        if (!afterTool && /PLAN THIS/.test(JSON.stringify(last))) return say("job_start", { prompt: "Write the plan for the launch.", title: "Launch plan" });
        say("final_answer", { text: afterTool ? "I started a job for the plan." : "It is noon.", artifacts: [] });
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
    backend = await tb.open();
    await tb.wipe(backend);
    const { seedStrutDomain } = await import("./schema-seed.js");
    await seedStrutDomain(backend);
    backend.schemas.invalidate();
  });
  after(async () => {
    provider.close();
    await tb.close(backend);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  beforeEach(async () => {
    await tb.clear(backend);
    judgeRuns = [];
    judgeCalls = [];
    handedVerdict = true;
    wakeGate = Promise.resolve();
    wakesSeen = 0;
    answers = new Map([["ans:plan", "go"]]);
    dir = join(tmpdir(), `strut-work-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    store = new MemoryRunStore();
  });
  afterEach(async () => {
    await projectionsSettled(backend);
    for (const s of struts.splice(0)) await s.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** A job step that waits on `ans:<key>` until it is answered. */
  const waitFor = defineStep({
    type: "test/wait-for",
    input: z.object({ key: z.string() }),
    output: z.any(),
    async run(cfg, ctx) {
      const on = `ans:${cfg.key}`;
      return answers.has(on) ? answers.get(on) : ctx.park!(on);
    },
  });
  const source: ParkSource = { settled: async (on) => answers.has(on) };

  /** A strut over this test's graph, store and data directory: a second
   *  one is the same deployment after a restart. */
  const boot = async (): Promise<Strut> => {
    const registry: StepRegistry = await createRegistry([waitFor]);
    const strut = await createStrut({
      workspace: new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps") }),
      store,
      registry,
      dataDir: dir,
      serveUi: false, enableChat: false, scheduler: false, stt: false, autoResume: false, wakeDelayMs: 0,
      job: false, builder: false, orchestrator: {},
    });
    struts.push(strut);
    waker = strut.parking.register("ans", source);
    await strut.secretStore.set("STRUT_DEFAULT_MODEL", "anthropic/claude-sonnet-4-5");
    // The job in small: the kind's page opened (only the job opens it), a wait, the plan written, delivered.
    await strut.workspace.publishWorkflowByContent(
      "job",
      [
        "name: job",
        "steps:",
        "  - id: dir",
        "    type: job/dir",
        "  - id: page",
        "    type: graph/graph-get",
        "    config: { node_type: Concept, name: Planning }",
        "  - id: wait",
        "    type: test/wait-for",
        "    config: { key: plan }",
        "  - id: write",
        "    type: exec",
        `    config: { cmd: sh, args: ["-c", 'printf "%s" "$1" > plan.md', "_", ${JSON.stringify(PLAN)}], cwd: "{{ dir.path }}" }`,
        "  - id: result",
        "    type: pack",
        "    config: { text: Wrote the plan., artifacts: [{ id: plan, title: The plan, path: plan.md }] }",
        "",
      ].join("\n"),
    );
    return strut;
  };
  const knowledgeOf = (strut: Strut) => (strut.services as unknown as { knowledge: KnowledgeCapability }).knowledge;
  /** The pages and the two claims: one on a page only the job opens, one on the root the turns open. */
  const claimsOnPages = async (strut: Strut) => {
    await backend.nodes.writeMany([{ type: "Concept", data: { name: "Planning", description: "writing a plan", docs: "A plan ends with a rollout section." } }]);
    const rollout = await knowledgeOf(strut).addClaim({ concept: "Planning", text: ROLLOUT });
    const handed = await knowledgeOf(strut).addClaim({ concept: "Job", text: HANDED });
    assert.ok("ok" in rollout && "ok" in handed, JSON.stringify([rollout, handed]));
    return { rollout: rollout.id, handed: handed.id };
  };
  const json = async <T = Record<string, any>>(strut: Strut, path: string, init?: RequestInit): Promise<T> => {
    const res = await strut.app.request(path, init);
    assert.ok(res.status < 300, `${path}: ${res.status} ${await res.clone().text()}`);
    return (await res.json()) as T;
  };
  const post = (strut: Strut, path: string, body: unknown = {}) => json(strut, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const until = async <T>(find: () => Promise<T | undefined> | T | undefined, what: string, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await find();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`${what} never happened`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const summaryOf = (workflow: string, runId: string, status?: string) =>
    until(async () => {
      const s = await store.getRunSummary(workflow, runId);
      return s && (!status || s.status === status) ? s : undefined;
    }, `${workflow} ${runId} ${status ?? "ending"}`);
  /** A person's message: the turn's run id once it ended. */
  const say = async (strut: Strut, prompt: string): Promise<string> => {
    const { runId } = await post(strut, `/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { input: { prompt, session: "c-1" }, wake: true });
    assert.equal((await summaryOf(ORCHESTRATOR_WORKFLOW, runId)).status, "success");
    return runId as string;
  };
  const verify = (strut: Strut, workflow: string, runId: string) => post(strut, `/workflows/${workflow}/runs/${runId}/verify`);
  const conceptChecks = (r: Record<string, any>) => (r["checks"] as Array<{ path: string; lastVerify: unknown }>).filter((k) => k.path.startsWith("concept:")).map((k) => [k.path, k.lastVerify]);
  const claimOn = async (strut: Strut, name: string) => (await json<{ claims: Array<Record<string, any>> }>(strut, `/claims?kind=concept&name=${encodeURIComponent(name)}`)).claims[0]!;
  const jobRun = () => until(async () => (await store.listRuns("job"))[0], "the job's run");

  it("a turn that starts a job, and the turn that reports on it: judged ONCE after the last of them, against all three, a page only the job opened observed, the plan opened through the judge's tool", async () => {
    const strut = await boot();
    const ids = await claimsOnPages(strut);
    let release!: () => void;
    wakeGate = new Promise((r) => (release = r));

    const turn = await say(strut, "PLAN THIS: the launch");
    // The turn ended, its job is running or done: not the end of the work.
    assert.deepEqual(conceptChecks(await verify(strut, ORCHESTRATOR_WORKFLOW, turn)), []);
    const job = await jobRun();
    await summaryOf("job", job, "success");
    // The job ended; the turn that reports on it is under way.
    await until(() => (wakesSeen ? true : undefined), "the wake turn");
    assert.deepEqual(conceptChecks(await verify(strut, "job", job)), []);
    assert.equal(judgeRuns.length, 0, "nothing is judged while the work goes on");

    release();
    const wake = await until(async () => (await store.listRuns(ORCHESTRATOR_WORKFLOW)).find((id) => id !== turn), "the wake turn's run");
    await summaryOf(ORCHESTRATOR_WORKFLOW, wake, "success");
    // The wake turn's end is the work's: judged by itself, once per claim.
    await until(async () => ((await claimOn(strut, "Planning"))["status"] !== "unknown" && (await claimOn(strut, "Job"))["status"] !== "unknown" ? true : undefined), "the verdicts");
    assert.equal(judgeRuns.length, 2);

    // The judge was handed the whole work, in order, each run's place in it.
    for (const sent of judgeRuns) {
      assert.match(sent, /THE WORK: 3 runs/);
      assert.match(sent, /RUN 1: orchestrator, the request that started the work/);
      assert.match(sent, /RUN 2: job, a job RUN 1 started/);
      assert.match(sent, /RUN 3: orchestrator, a turn reporting on RUN 2/);
      assert.match(sent, /PLAN THIS: the launch/);
      assert.match(sent, /CONCEPT PAGES OPENED IN THE WORK: Job, Workflow Builder, Planning/);
      assert.match(sent, /it delivered: \\+"The plan\\+" at job-[A-Za-z0-9._-]+\/plan\.md/);
    }
    // It opened the plan through its one tool, and judged by what it read.
    const opened = judgeCalls.find((c) => c.includes("tool_result") && c.includes(ROLLOUT));
    assert.ok(opened?.includes("Rollout: staged"), "the plan's text reached the judge");

    // Evidence ABOUT each page at the version the work read, sourced to the ROOT run.
    const planning = await claimOn(strut, "Planning");
    assert.deepEqual([planning["status"], planning["latest"].content, planning["latest"].run.runId], ["supported", "the plan's last item is its rollout", turn]);
    const root = await claimOn(strut, "Job");
    assert.deepEqual([root["status"], root["latest"].run.runId], ["supported", turn]);
    // At the id one run always had: (check, root run, concept:<name>).
    const [chk] = planning["checks"] as Array<{ id: string }>;
    const found = await backend.query(`MATCH ${backend.dialect.node("e", "Evidence", { id: "$id" })} RETURN e.id AS id`, { id: evidenceId(chk!.id, turn, "concept:Planning") });
    assert.equal(found.length, 1);

    // Asked again from any of its runs, the work is judged once: idempotent.
    const again = await verify(strut, ORCHESTRATOR_WORKFLOW, wake);
    assert.deepEqual(conceptChecks(again).sort(), [["concept:Job", { ran: true }], ["concept:Planning", { ran: true }]]);
    assert.equal(again["evidence"], 0);
    assert.equal(judgeRuns.length, 2);
    void ids;
  });

  it("a question-only turn is a work of one run: judged when it ends, and a judge that finds the rule is not about it records nothing", async () => {
    const strut = await boot();
    const ids = await claimsOnPages(strut);
    handedVerdict = null;
    const turn = await say(strut, "what time is it?");
    // The automatic pass, at the turn's end: only the root page was opened.
    await until(() => (judgeRuns.length ? true : undefined), "the judge");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(judgeRuns.length, 1, "judged once, for the one page with a claim the turn opened");
    assert.match(judgeRuns[0]!, /WHAT IT WAS ASKED:[^]*what time is it\?/);
    assert.doesNotMatch(judgeRuns[0]!, /THE WORK: \d+ runs/, "a work of one run reads as one run always did");
    // The judge gave no verdict: nothing is recorded, and the claim stays unknown.
    assert.equal((await backend.query(`MATCH ${backend.dialect.node("e", "Evidence")} RETURN e.id AS id`)).length, 0);
    assert.equal((await claimOn(strut, "Job"))["status"], "unknown");
    assert.equal((await claimOn(strut, "Planning"))["status"], "unknown");
    // Asked by hand, the same: a judge that gives no verdict is never a pass or a fail.
    assert.deepEqual(conceptChecks(await verify(strut, ORCHESTRATOR_WORKFLOW, turn)), [["concept:Job", { skipped: "cannot-launch", reason: "the check returned no { supports, content }" }]]);

    // The next one-run work with a verdict: evidence at the id, path and source one run always had.
    handedVerdict = false;
    const next = await say(strut, "and in Lisbon?");
    const claim = await until(async () => {
      const c = await claimOn(strut, "Job");
      return c["status"] === "unknown" ? undefined : c;
    }, "the verdict");
    assert.deepEqual([claim["status"], claim["latest"].run.runId], ["refuted", next]);
    void ids;
  });

  it("a work still in flight is not judged; after a restart, the process that sees its last run end judges it, from the stores alone", async () => {
    answers.delete("ans:plan");
    const one = await boot();
    await claimsOnPages(one);
    const turn = await say(one, "PLAN THIS: the launch");
    const job = await jobRun();
    // The job waits on something outside it: the work is not done.
    await summaryOf("job", job, "waiting");
    assert.deepEqual(conceptChecks(await verify(one, ORCHESTRATOR_WORKFLOW, turn)), []);
    assert.equal(judgeRuns.length, 0);
    await one.close();

    // A new process over the same stores; what the job waited on happened meanwhile.
    answers.set("ans:plan", "go");
    const two = await boot();
    waker!.wake("job", job);
    await summaryOf("job", job, "success");
    const wake = await until(async () => (await store.listRuns(ORCHESTRATOR_WORKFLOW)).find((id) => id !== turn), "the wake turn's run");
    await summaryOf(ORCHESTRATOR_WORKFLOW, wake, "success");
    await until(async () => ((await claimOn(two, "Planning"))["status"] !== "unknown" ? true : undefined), "the verdict");
    assert.equal(judgeRuns.length, 2);
    assert.match(judgeRuns[0]!, /THE WORK: 3 runs/);
    assert.equal((await claimOn(two, "Planning"))["latest"].run.runId, turn);
  });
});
