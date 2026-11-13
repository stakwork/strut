/**
 * Concept branches (src/branches.ts, plans/concept-evals.md item b), end to
 * end on each engine: a whole strut on a graph workspace. A branch is made
 * from the live tree, a run is pointed at it (`branch` on the launch), its
 * Concepts are the branch's and the rest of the graph is live, every run it
 * starts is on it, and it is dropped.
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
import { projectionsSettled } from "./projector.js";
import { testBackends } from "./test-util.js";
import { GraphWorkspaceStore } from "./workspace-store.js";
import { defineStep, type RunEvent, type StepRegistry } from "../core.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { KnowledgeCapability } from "../knowledge.js";
import { EVERYTHING, packageFiles } from "../packages/build.js";
import { packageCache } from "../packages/cache.js";
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

for (const tb of testBackends()) describe(`Concept branches, on ${tb.name}`, { skip: tb.skip }, () => {
  let backend: GraphBackend;
  let provider: http.Server;
  let dir = "";
  let store: RunStore;
  const struts: Strut[] = [];
  let waker: ParkWaker | undefined;
  let answers: Map<string, unknown>;
  /** `test/hold` waits for this. */
  let held: Promise<void> = Promise.resolve();
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "STRUT_PEER_KEY", "AI_SDK_LOG_WARNINGS"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    let n = 0;
    // The model: a person's turn hands the work to a job; the job's report is answered.
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
        const last = body.messages.at(-1);
        const afterTool = Array.isArray(last?.content) && (last!.content as Array<{ type?: string }>).some((c) => c.type === "tool_result");
        const say = (name: string, input: unknown) => res.end(toolUse(`toolu_${++n}`, name, input));
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (JSON.stringify(body.messages).includes("<<<job reply")) return say("final_answer", { text: "The job is done.", artifacts: [] });
        if (!afterTool && /DO THIS/.test(JSON.stringify(last))) return say("job_start", { prompt: "Do the thing.", title: "The thing" });
        say("final_answer", { text: afterTool ? "I started a job." : "Hello.", artifacts: [] });
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_PEER_KEY"];
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
    answers = new Map();
    held = Promise.resolve();
    dir = join(tmpdir(), `strut-branches-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    store = new MemoryRunStore();
  });
  afterEach(async () => {
    delete process.env["STRUT_PEER_KEY"];
    await projectionsSettled(backend);
    for (const s of struts.splice(0)) await s.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** What branch the step ran on, as every step sees it. */
  const branchOf = defineStep({
    type: "test/branch-of",
    input: z.object({}),
    output: z.any(),
    async run(_cfg, ctx) {
      return { branch: ctx.branch ?? "main" };
    },
  });
  const waitFor = defineStep({
    type: "test/wait-for",
    input: z.object({ key: z.string() }),
    output: z.any(),
    async run(cfg, ctx) {
      const on = `ans:${cfg.key}`;
      return answers.has(on) ? answers.get(on) : ctx.park!(on);
    },
  });
  const hold = defineStep({
    type: "test/hold",
    input: z.object({}),
    output: z.any(),
    async run() {
      await held;
      return { held: true };
    },
  });
  const source: ParkSource = { settled: async (on) => answers.has(on) };

  const boot = async (): Promise<Strut> => {
    const registry: StepRegistry = await createRegistry([branchOf, waitFor, hold]);
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
    const publish = (name: string, steps: string[]) => strut.workspace.publishWorkflowByContent(name, [`name: ${name}`, "steps:", ...steps, ""].join("\n"));
    await publish("read-page", [
      "  - id: page",
      "    type: context/concept",
      '    config: { name: "{{ input.name }}" }',
      "  - id: who",
      "    type: test/branch-of",
      "  - id: out",
      "    type: pack",
      '    config: { text: "{{ page.text }}", branch: "{{ who.branch }}" }',
    ]);
    await publish("park", [
      "  - id: before",
      "    type: test/branch-of",
      "  - id: wait",
      "    type: test/wait-for",
      "    config: { key: go }",
      "  - id: after",
      "    type: test/branch-of",
      "  - id: out",
      "    type: pack",
      '    config: { before: "{{ before.branch }}", after: "{{ after.branch }}" }',
    ]);
    await publish("hold", ["  - id: h", "    type: test/hold"]);
    // A job in small: it says which branch it ran on.
    await publish("job", [
      "  - id: who",
      "    type: test/branch-of",
      "  - id: result",
      "    type: pack",
      '    config: { text: "ran on {{ who.branch }}", artifacts: [] }',
    ]);
    return strut;
  };

  const res = (strut: Strut, path: string, init?: RequestInit) => strut.app.request(path, init);
  const json = async <T = Record<string, any>>(strut: Strut, path: string, init?: RequestInit): Promise<T> => {
    const r = await res(strut, path, init);
    assert.ok(r.status < 300, `${path}: ${r.status} ${await r.clone().text()}`);
    return (await r.json()) as T;
  };
  const send = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const post = (strut: Strut, path: string, body: unknown = {}) => json(strut, path, send("POST", body));
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
  /** Launch over HTTP and wait for the end. */
  const launch = async (strut: Strut, workflow: string, body: Record<string, unknown>) => {
    const { runId } = await post(strut, `/workflows/${workflow}/run`, body);
    return { runId: runId as string, summary: await summaryOf(workflow, runId) };
  };
  const startOf = async (workflow: string, runId: string): Promise<RunEvent> => (await store.getRunStart(workflow, runId))!;
  /** A single-step run of `type` with `config`, on `branch` or main. */
  const step = async (strut: Strut, type: string, config: Record<string, unknown>, branch?: string) => {
    const name = `step-${randomUUID().slice(0, 8)}`;
    await strut.workspace.publishWorkflowByContent(name, [`name: ${name}`, "steps:", "  - id: s", `    type: ${type}`, `    config: ${JSON.stringify(config)}`, ""].join("\n"));
    const { summary } = await launch(strut, name, { input: {}, ...(branch ? { branch } : {}) });
    return summary.output as any;
  };
  const conceptsIn = async (ns: string) =>
    (await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { namespace: "$ns" })} WHERE ${backend.dialect.live("c")} RETURN c.name AS name, c.docs AS docs, c.ref_id AS ref_id, c.unique_source_id AS usid`, { ns }))
      .map((r) => ({ name: String(r["name"]), docs: r["docs"], ref_id: String(r["ref_id"]), usid: r["usid"] ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const linksIn = async (ns: string) =>
    (await backend.query(
      `MATCH ${backend.dialect.node("p", "Concept", { namespace: "$ns" })}-[r:PARENT_OF]->${backend.dialect.node("c", "Concept", { namespace: "$ns" })} RETURN p.name AS p, c.name AS c`,
      { ns },
    )).map((r) => `${r["p"]} > ${r["c"]}`).sort();
  /** A small tree of our own on main: Guide > Tone. */
  const tree = async () => {
    const [guide, tone] = await backend.nodes.writeMany([
      { type: "Concept", data: { name: "Guide", description: "how we work", docs: "MAIN guide docs." } },
      { type: "Concept", data: { name: "Tone", description: "how we sound", docs: "MAIN tone docs." } },
    ]);
    await backend.edges.write({ edge: "PARENT_OF", source_ref_id: guide!.ref_id, target_ref_id: tone!.ref_id });
    return { guide: guide!.ref_id, tone: tone!.ref_id };
  };

  it("create copies every live page and the PARENT_OF edges among them, no seed stamp on a copy; list; an empty one; a name taken or malformed is refused", async () => {
    const strut = await boot();
    await tree();
    const main = await conceptsIn(backend.namespace);
    assert.ok(main.some((c) => c.name === "Job" && typeof c.usid === "string"), "strut's seeded Job page is on main, stamped");

    const made = await post(strut, "/branches", { name: "try", from: "main" });
    assert.deepEqual([made["name"], made["namespace"], made["from"], made["pages"]], ["try", "branch-try", "main", main.length]);
    const copies = await conceptsIn("branch-try");
    assert.deepEqual(copies.map((c) => c.name), main.map((c) => c.name));
    assert.deepEqual(copies.map((c) => c.docs), main.map((c) => c.docs));
    assert.ok(copies.every((c) => c.usid === null), "a copy is nobody's seed or package");
    assert.ok(copies.every((c) => !main.some((m) => m.ref_id === c.ref_id)), "copies are nodes of their own");
    assert.ok((await linksIn("branch-try")).includes("Guide > Tone"));
    assert.deepEqual(await linksIn("branch-try"), await linksIn(backend.namespace));
    assert.equal(made["links"], (await linksIn(backend.namespace)).length);

    assert.deepEqual((await json(strut, "/branches"))["branches"].map((b: { name: string }) => b.name), ["try"]);
    assert.equal((await res(strut, "/branches", send("POST", { name: "try" }))).status, 409);
    assert.equal((await res(strut, "/branches", send("POST", { name: "Try/1" }))).status, 400);
    const empty = await post(strut, "/branches", { name: "blank", from: "empty" });
    assert.deepEqual([empty["pages"], empty["links"]], [0, 0]);
    assert.deepEqual(await conceptsIn("branch-blank"), []);
    // Main is as it was.
    assert.deepEqual(await conceptsIn(backend.namespace), main);
  });

  it("a run on the branch reads the branch's text through context/concept, a run on main reads main's; the launch's branch is on run.start, the summary and ctx", async () => {
    const strut = await boot();
    await tree();
    await post(strut, "/branches", { name: "try" });
    const copy = (await conceptsIn("branch-try")).find((c) => c.name === "Guide")!;
    await backend.nodes.update(copy.ref_id, { set: { docs: "BRANCH guide docs." } });

    const onMain = await launch(strut, "read-page", { input: { name: "Guide" } });
    assert.match(String((onMain.summary.output as any).text), /MAIN guide docs/);
    assert.equal((onMain.summary.output as any).branch, "main");
    assert.equal((await startOf("read-page", onMain.runId)).branch, undefined);

    const onBranch = await launch(strut, "read-page", { input: { name: "Guide" }, branch: "try" });
    assert.equal(onBranch.summary.status, "success", JSON.stringify(onBranch.summary.error));
    assert.match(String((onBranch.summary.output as any).text), /BRANCH guide docs/);
    assert.doesNotMatch(String((onBranch.summary.output as any).text), /MAIN guide docs/);
    // Its table of contents is the branch's too.
    assert.match(String((onBranch.summary.output as any).text), /Tone — how we sound/);
    assert.equal((onBranch.summary.output as any).branch, "try");
    assert.equal((await startOf("read-page", onBranch.runId)).branch, "try");
    assert.equal(onBranch.summary.branch, "try");
    assert.ok(!("branch" in (onBranch.summary.input as object)), "never in input");

    // Search and find answer the branch's pages.
    const hits = await step(strut, "graph/find", { node_type: "Concept", where: { name: "Guide" } }, "try");
    assert.deepEqual(hits.nodes.map((n: { ref_id: string }) => n.ref_id), [copy.ref_id]);
    const got = await step(strut, "graph/graph-get", { ref_id: copy.ref_id }, "try");
    assert.equal(got.properties.docs, "BRANCH guide docs.");
    const live = (await conceptsIn(backend.namespace)).find((c) => c.name === "Guide")!;
    assert.match(String(await step(strut, "graph/graph-get", { ref_id: live.ref_id }, "try")), /not found/, "a live page is not read from a branch");
  });

  it("a Concept written on the branch lands there and main is unchanged; a write to a main Concept is refused; a non-Concept is read and written live", async () => {
    const strut = await boot();
    const { guide } = await tree();
    await post(strut, "/branches", { name: "try" });
    const before = await conceptsIn(backend.namespace);

    const made = await step(strut, "graph/create-node", { node_type: "Concept", node_data: { name: "Branch Only", description: "new here", docs: "only on the branch" } }, "try");
    assert.equal(made.status, "Success", JSON.stringify(made));
    assert.ok((await conceptsIn("branch-try")).some((c) => c.name === "Branch Only" && c.ref_id === made.ref_id));
    assert.deepEqual(await conceptsIn(backend.namespace), before, "main is unchanged");

    // A page of the live tree is the branch's to read through its copy, never to change.
    assert.match(String(await step(strut, "graph/edit-node", { ref_id: guide, node_data: { docs: "changed" } }, "try")), /Concept of the live tree/);
    assert.equal((await conceptsIn(backend.namespace)).find((c) => c.name === "Guide")!.docs, "MAIN guide docs.");
    // A link from a branch page to a page outside it is refused.
    assert.match(String(await step(strut, "graph/create-triplet", { source_ref_id: guide, target_ref_id: made.ref_id, edge_type: "PARENT_OF" }, "try")), /Concept of the live tree/);

    // Any other type is the live graph's: written there, read from there.
    const schema = await step(strut, "graph/create-schema", { type: "SourceDoc", attributes: { title: "string", url: "?string" }, node_key: "title" });
    assert.ok(schema.created || schema.type, JSON.stringify(schema));
    const doc = await step(strut, "graph/create-node", { node_type: "SourceDoc", node_data: { title: "Release notes" } }, "try");
    assert.equal(doc.status, "Success", JSON.stringify(doc));
    const [row] = await backend.query(`MATCH ${backend.dialect.node("n", "SourceDoc", { ref_id: "$r" })} RETURN n.namespace AS ns`, { r: doc.ref_id });
    assert.equal(row?.["ns"], backend.namespace);
    const found = await step(strut, "graph/find", { node_type: "SourceDoc", where: { title: "Release notes" } }, "try");
    assert.deepEqual(found.nodes.map((n: { ref_id: string }) => n.ref_id), [doc.ref_id]);
    // …and nothing but Concepts is written in the branch's namespace.
    assert.match(String(await step(strut, "graph/create-node", { node_type: "SourceDoc", node_data: { title: "Sneaky" }, namespace: "branch-try" }, "try")), /holds its Concepts alone/);
    // A branch page links to the branch's other pages alone.
    assert.match(String(await step(strut, "graph/create-triplet", { source_ref_id: made.ref_id, target_ref_id: doc.ref_id, edge_type: "CITES", create_schema_if_missing: true }, "try")), /links only to the branch's other pages/);
    // Raw queries are off on a branch: their rows could not be held to it.
    const name = `step-${randomUUID().slice(0, 8)}`;
    await strut.workspace.publishWorkflowByContent(name, [`name: ${name}`, "steps:", "  - id: s", "    type: graph/query", '    config: { cypher: "MATCH (n) RETURN count(n) AS n" }', ""].join("\n"));
    const raw = await launch(strut, name, { input: {}, branch: "try" });
    assert.match(JSON.stringify(raw.summary), /raw graph queries are off in a run on a Concept branch/);
  });

  it("a job a run on the branch starts, and the turn that reports on it, are on the branch; the conversation refuses a turn on main", async () => {
    const strut = await boot();
    await post(strut, "/branches", { name: "try" });
    const { runId: turn } = await post(strut, `/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { input: { prompt: "DO THIS", session: "c-1" }, wake: true, branch: "try" });
    assert.equal((await summaryOf(ORCHESTRATOR_WORKFLOW, turn)).status, "success");
    assert.equal((await startOf(ORCHESTRATOR_WORKFLOW, turn)).branch, "try");
    const job = await until(async () => (await store.listRuns("job"))[0], "the job's run");
    const jobEnd = await summaryOf("job", job, "success");
    assert.equal((jobEnd.output as any).text, "ran on try");
    assert.equal((await startOf("job", job)).branch, "try");
    const wake = await until(async () => (await store.listRuns(ORCHESTRATOR_WORKFLOW)).find((id) => id !== turn), "the wake turn");
    assert.equal((await summaryOf(ORCHESTRATOR_WORKFLOW, wake)).status, "success");
    assert.equal((await startOf(ORCHESTRATOR_WORKFLOW, wake)).branch, "try");
    // Each turn of the conversation says its branch.
    const turns = (await strut.sessionStore.turns("c-1")).map((t) => t.branch);
    assert.deepEqual(turns, ["try", "try"]);

    // A turn on main in the same conversation is refused: it stays on its first turn's branch.
    const { runId: other } = await post(strut, `/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { input: { prompt: "hi", session: "c-1" } });
    const refused = await summaryOf(ORCHESTRATOR_WORKFLOW, other);
    assert.equal(refused.status, "error");
    assert.match(String(refused.error?.message), /session_branch/);
    // And a conversation begun on main refuses a turn on the branch.
    await post(strut, "/branches", { name: "other" });
    const { runId: first } = await post(strut, `/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { input: { prompt: "hi", session: "c-2" } });
    assert.equal((await summaryOf(ORCHESTRATOR_WORKFLOW, first)).status, "success");
    const { runId: second } = await post(strut, `/workflows/${ORCHESTRATOR_WORKFLOW}/run`, { input: { prompt: "hi", session: "c-2" }, branch: "other" });
    assert.match(String((await summaryOf(ORCHESTRATOR_WORKFLOW, second)).error?.message), /session_branch/);
  });

  it("a run a run on the branch starts is on it and names no other; a run on main may start one on a branch", async () => {
    const strut = await boot();
    await post(strut, "/branches", { name: "try" });
    await post(strut, "/branches", { name: "other" });
    const child = async (cfg: Record<string, unknown>, branch?: string) => step(strut, "meta/run-workflow", { name: "read-page", input: { name: "Job" }, ...cfg }, branch);
    assert.equal((await child({}, "try")).output.branch, "try", "inherited");
    assert.equal((await child({ branch: "try" })).output.branch, "try", "main may start a run on a branch");
    assert.equal((await child({})).output.branch, "main");
    const name = `step-${randomUUID().slice(0, 8)}`;
    await strut.workspace.publishWorkflowByContent(name, [`name: ${name}`, "steps:", "  - id: s", "    type: meta/run-workflow", `    config: { name: read-page, input: { name: Job }, branch: other }`, ""].join("\n"));
    const { summary } = await launch(strut, name, { input: {}, branch: "try" });
    assert.equal(summary.status, "error");
    assert.match(String(summary.error?.message), /branch_fixed/);
  });

  it("a resumed run keeps its branch", async () => {
    const strut = await boot();
    await post(strut, "/branches", { name: "try" });
    const { runId } = await post(strut, "/workflows/park/run", { input: {}, branch: "try" });
    await summaryOf("park", runId, "waiting");
    answers.set("ans:go", "now");
    waker!.wake("park", runId);
    const end = await summaryOf("park", runId, "success");
    assert.deepEqual(end.output, { before: "try", after: "try" });
    assert.equal(end.branch, "try");
    assert.ok((await store.getRunEvents("park", runId)).some((e) => e.type === "run.resumed"));
  });

  it("a launch's branch: the deployment's alone, never a peer's; an unknown one is refused", async () => {
    const strut = await boot();
    await post(strut, "/branches", { name: "try" });
    process.env["STRUT_PEER_KEY"] = "peer";
    const asPeer = await res(strut, "/workflows/read-page/run", send("POST", { input: { name: "Job" }, branch: "try" }, { authorization: "Bearer peer" }));
    assert.equal(asPeer.status, 403);
    assert.match(await asPeer.text(), /branch/);
    assert.equal((await res(strut, "/branches", { headers: { authorization: "Bearer peer" } })).status, 403);
    delete process.env["STRUT_PEER_KEY"];
    assert.equal((await res(strut, "/workflows/read-page/run", send("POST", { input: { name: "Job" }, branch: "nope" }))).status, 404);
    assert.equal((await res(strut, "/workflows/read-page/run", send("POST", { input: { name: "Job" }, branch: "Bad Name" }))).status, 400);
  });

  it("search answers the branch's pages on the branch and never on main; the Knowledge door reads the branch and adds no claim; the verify pass records nothing about a branch page; the snapshot leaves the branch out", async () => {
    const strut = await boot();
    const { guide } = await tree();
    const knowledge = (strut.services as unknown as { knowledge: KnowledgeCapability }).knowledge;
    assert.ok("ok" in (await knowledge.addClaim({ concept: "Guide", text: "Answers are short" })));
    await post(strut, "/branches", { name: "try" });
    const copy = (await conceptsIn("branch-try")).find((c) => c.name === "Guide")!;

    const refs = (hits: unknown) => (Array.isArray(hits) ? hits.map((h: { ref_id: string }) => h.ref_id) : assert.fail(String(hits)));
    for (const type of ["Concept", undefined]) {
      const onMain = refs(await step(strut, "graph/graph-search", { q: "Guide", ...(type ? { type } : {}) }));
      assert.ok(onMain.includes(guide) && !onMain.includes(copy.ref_id), `main sees its own page alone (${type ?? "any type"})`);
      const onBranch = refs(await step(strut, "graph/graph-search", { q: "Guide", ...(type ? { type } : {}) }, "try"));
      assert.ok(onBranch.includes(copy.ref_id) && !onBranch.includes(guide), `the branch sees its copy alone (${type ?? "any type"})`);
    }

    const page = await step(strut, "knowledge/page", { name: "Guide" }, "try");
    assert.deepEqual([page.ref_id, page.docs, page.children.map((c: { name: string }) => c.name)], [copy.ref_id, "MAIN guide docs.", ["Tone"]]);
    assert.equal(page.claims.length, 1, "claims are shared: the page's name carries them");
    assert.match(JSON.stringify(await step(strut, "knowledge/add-claim", { concept: "Guide", text: "Answers are long" }, "try")), /not written from a branch/);

    // A run on main that opens the page is checked against its claim…
    const main = await launch(strut, "read-page", { input: { name: "Guide" } });
    const checked = await post(strut, `/workflows/read-page/runs/${main.runId}/verify`);
    assert.deepEqual((checked["checks"] as Array<{ path: string }>).filter((k) => k.path.startsWith("concept:")).map((k) => k.path), ["concept:Guide"]);
    // …a run on the branch opened the copy: nothing is judged or recorded about it (item d).
    const { runId } = await launch(strut, "read-page", { input: { name: "Guide" }, branch: "try" });
    const verified = await post(strut, `/workflows/read-page/runs/${runId}/verify`);
    assert.deepEqual((verified["checks"] as Array<{ path: string }>).filter((k) => k.path.startsWith("concept:")), []);

    // The workspace's snapshot (the history's, an everything package) is main's.
    const { files } = await packageFiles({ workspace: strut.workspace, cache: packageCache(dir), graph: backend }, EVERYTHING);
    assert.ok([...files.keys()].some((f) => f.startsWith("concepts/")));
    assert.deepEqual([...files.keys()].filter((f) => f.includes("branch-")), []);
  });

  it("drop: refused while a run on it is in flight; removes its pages and its record; a run on it then fails", async () => {
    const strut = await boot();
    await tree();
    const made = await post(strut, "/branches", { name: "try" });
    let release!: () => void;
    held = new Promise((r) => (release = r));
    const { runId } = await post(strut, "/workflows/hold/run", { input: {}, branch: "try" });
    await until(async () => ((await store.getRunEvents("hold", runId)).some((e) => e.type === "step.start") ? true : undefined), "the run under way");
    const busy = await res(strut, "/branches/try", { method: "DELETE" });
    assert.equal(busy.status, 409);
    release();
    await summaryOf("hold", runId, "success");

    const dropped = await json(strut, "/branches/try", { method: "DELETE" });
    assert.deepEqual(dropped, { name: "try", pages: made["pages"] });
    assert.deepEqual(await conceptsIn("branch-try"), []);
    assert.deepEqual((await json(strut, "/branches"))["branches"], []);
    assert.equal((await res(strut, "/branches/try", { method: "DELETE" })).status, 404);
    assert.equal((await res(strut, "/workflows/read-page/run", send("POST", { input: { name: "Guide" }, branch: "try" }))).status, 404);
    const late = await strut.run("read-page", { name: "Guide" }, { branch: "try" });
    assert.equal(late.status, "error");
    assert.match(String(late.error?.message), /no_branch/);
    // Main's pages are all there.
    assert.ok((await conceptsIn(backend.namespace)).some((c) => c.name === "Guide" && c.docs === "MAIN guide docs."));
  });
});
