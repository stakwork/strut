/**
 * The dream end to end (plans/dream.md): a whole strut on a Ladybug graph
 * with Peel's reader lists and its `Personal` tree, and a stand-in model
 * that answers each stage as that stage's own agent. A person corrects the
 * assistant and says "always"; the shipped `dream` workflow finds the
 * moment, sorts it onto a new claim, sees it is due (said to last), writes
 * one line on a new Concept and notes the fix. A dream with nothing new calls
 * no model. The same correction again lands on the same claim, is due again
 * (corrected since its fix), and the line is replaced, not added to. With
 * `review` the edit is a proposal and nothing is written. A correction that
 * comes with a request of its own leaves its claim a check; with
 * `maxChecks` the dream runs it through `dream-check` against a stand-in
 * for the assistant, and what it finds is evidence from the check.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { assertEdge } from "./temporal.js";
import { parseGraphReaders } from "./scope.js";
import { testBackends } from "./test-util.js";
import { createStrut, type Strut } from "../createStrut.js";
import { ORCHESTRATOR_WORKFLOW } from "../orchestrator-seed.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { SYSTEM_WRITER } from "../system-workflows.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

const PEEL_READERS = parseGraphReaders({
  assistant: { workflows: ["orchestrator", "peel-automation-run"], namespaces: ["private", "shared"] },
  jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] },
  apps: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  peers: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  builder: { namespaces: ["*"] },
  ui: { namespaces: ["*"] },
});

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

const CLAIM = "Summaries are three lines or fewer";
const LINE_1 = "Summaries are three lines or fewer.";
const LINE_2 = "A summary is at most three lines. Count them before sending.";

describe("the dream on the graph, under Peel's reader lists (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let dir = "";
  let provider: http.Server;
  let strut: Strut | undefined;
  /** Which stage's agent each model call was for, in order, and the prompt each was sent. */
  let calls: string[] = [];
  let prompts: Record<string, string> = {};
  /** The turn the stand-in FIND reports a correction in, and whether the person said it is to last. */
  let found: { turn: number; excerpt: string; lasting: boolean; prompt?: string } | null = null;
  /** What the stand-in judge of a check answers. */
  let verdict = false;
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    // The stand-in model: each stage's agent is known by its system prompt, and answers with that stage's
    // structured object, reading the ids it needs out of the prompt it was sent.
    let n = 0;
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as { system?: unknown; messages: Array<{ role: string; content: unknown }> };
        const system = JSON.stringify(body.system ?? "");
        const prompt = JSON.stringify(body.messages[0]?.content ?? "");
        const answer = (stage: string, object: unknown) => {
          calls.push(stage);
          prompts[stage] = prompt;
          res.end(toolUse(`toolu_${++n}`, "final_answer", object));
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (system.includes("pick out the moments")) {
          return answer("find", { moments: found ? [{ session: "c-1", turn: found.turn, excerpt: found.excerpt, statement: CLAIM, kind: "correction", lasting: found.lasting, prompt: found.prompt ?? "" }] : [] });
        }
        if (system.includes("You sort things a person said")) {
          const claim = new RegExp(`- ([0-9a-f]{32}) \\\\"${CLAIM}`).exec(prompt)?.[1];
          const root = /- ([0-9a-f-]{36}) \\"Personal\\"/.exec(prompt)?.[1];
          return answer("match", { decisions: [claim ? { i: 0, claim, outcome: "not_followed", why: "an eight-line summary" } : { i: 0, text: CLAIM, title: "Summaries too long", concept: root, outcome: "missing", why: "the reply ran long" }] });
        }
        if (system.includes("You write the one line a Concept needs")) {
          const claim = /CLAIM ([0-9a-f]{32}) /.exec(prompt)?.[1];
          const concept = /its Concept ([0-9a-f-]{36}) \\"Writing\\"/.exec(prompt)?.[1];
          return answer("fix", { edits: [concept ? { claim, action: "replace", concept, old_line: LINE_1, new_line: LINE_2, first: true, why: "it came back" } : { claim, action: "add_concept", concept_name: "Writing", new_line: LINE_1, why: "no Concept had it" }] });
        }
        if (system.includes("which claims about how an assistant should act")) return answer("group", { groups: [] });
        if (system.includes("You judge whether an assistant did what a rule says")) return answer("judge", verdict ? { supports: true, content: "three lines" } : { supports: false, content: "eight lines" });
        res.end(toolUse(`toolu_${++n}`, "final_answer", { text: "Hello.", artifacts: [] }));
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
    b = (await lb.open()) as LadybugBackend;
  });
  after(async () => {
    provider.close();
    await lb.close(b);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  beforeEach(async () => {
    await lb.clear(b);
    calls = [];
    prompts = {};
    found = null;
    dir = join(tmpdir(), `strut-dream-run-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      graph: b,
      store: new MemoryRunStore(),
      serveUi: false, enableChat: false, scheduler: false, stt: false, autoResume: false,
      job: false, builder: false, orchestrator: {}, concepts: { personal: true },
      graphReaders: PEEL_READERS,
    });
    await strut.secretStore.set("STRUT_DEFAULT_MODEL", "anthropic/claude-sonnet-4-5");
  });
  afterEach(async () => {
    await strut?.close();
    strut = undefined;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Runs `workflow` to its end: its summary. */
  async function runOf(workflow: string, body: unknown = {}): Promise<Record<string, any>> {
    const res = await strut!.app.request(`/workflows/${workflow}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 202, await res.clone().text());
    const { runId } = (await res.json()) as { runId: string };
    for (let i = 0; i < 3000; i++) {
      const s = (await (await strut!.app.request(`/workflows/${workflow}/runs/${runId}`)).json()) as Record<string, any>;
      if (s["status"] && s["status"] !== "running" && !s["partial"]) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${workflow} never finished`);
  }
  const say = (text: string) => runOf(ORCHESTRATOR_WORKFLOW, { input: { prompt: text, session: "c-1" } });
  const dream = async (input: Record<string, unknown> = {}) => {
    calls = [];
    const run = await runOf("dream", { input });
    assert.equal(run["status"], "success", JSON.stringify(run).slice(0, 1500));
    return run;
  };
  const docsOf = async (name: string) => (await b.query("MATCH (p:Node {node_type: 'Concept', name: $name}) RETURN p.docs AS docs", { name }))[0]?.["docs"];

  it("lists the facts memory holds in the run's output: what holds now first, an ended one kept and marked", async () => {
    await createNodeSchema(b, b.schemas, { type: "Town", attributes: {}, role: "entity" });
    await b.schemas.createEdgeSchema("Person", "LIVES_IN", "Town", { temporal: true, cardinality: "one" });
    const [tom, boston, canton] = await b.nodes.writeMany([{ type: "Person", data: { name: "Tom" } }, { type: "Town", data: { name: "Boston" } }, { type: "Town", data: { name: "Canton" } }]);
    await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: tom!.ref_id, target_ref_id: boston!.ref_id, text: "Tom lives in Boston", valid_at: "2015", namespace: "private" });
    await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: tom!.ref_id, target_ref_id: canton!.ref_id, text: "Tom lives in Canton", valid_at: "2021", namespace: "private" });
    const out = (await dream())["output"] as Record<string, any>;
    assert.deepEqual(calls, [], "listing facts calls no model");
    assert.equal(out["fact_count"], 2);
    assert.deepEqual(out["fact_list"].map((f: any) => [f.text, f.kind, f.subject, f.object, f.since?.slice(0, 4), !!f.ended]), [
      ["Tom lives in Canton", "LIVES_IN", "Tom", "Canton", "2021", false],
      ["Tom lives in Boston", "LIVES_IN", "Tom", "Boston", "2015", true],
    ]);
  });

  it("finds a correction said to last, sorts it onto a new claim, fixes it with one line on a new concept; nothing new calls no model; corrected again, the line is replaced", async () => {
    assert.equal((await say("summarise my notes from Monday"))["status"], "success");
    assert.equal((await say("too long, always keep summaries to three lines"))["status"], "success");
    found = { turn: 1, excerpt: "too long, always keep summaries to three lines", lasting: true };

    const first = await dream();
    assert.deepEqual(calls, ["find", "match", "fix"], "a stage with nothing to do is skipped: no facts, no neighbours to group");
    assert.match(prompts["find"]!, /turn 1 · [^\]]+\]\\n(OPENED: [^\\]*\\n)?PERSON: too long, always keep summaries to three lines/);
    assert.match(prompts["match"]!, /MOMENT 0 \[session c-1 · turn 1\] \(said to last\)/);
    assert.doesNotMatch(prompts["match"]!, /PERSON: summarise/, "the sorting reads the moment and its candidates, not the transcript");
    assert.match(prompts["fix"]!, /it sits on the root, which is left alone/);
    const out = first["output"] as Record<string, any>;
    assert.deepEqual([out["root"], out["turns"], out["moments"], out["due"]], ["Personal", 2, 1, 1]);
    assert.deepEqual(out["records"].map((r: any) => [r.i, r.created, r.recorded, r.outcome]), [[0, true, true, "missing"]]);
    assert.deepEqual(out["changes"].map((c: any) => [c.title, c.concept.name, c.kind, c.removed, c.added]), [["Summaries too long", "Writing", "added", [], [LINE_1]]]);
    assert.equal(await docsOf("Writing"), LINE_1);
    const [claim] = out["claims"];
    assert.deepEqual([claim.text, claim.concept, claim.corrected, claim.lasting, claim.open], [CLAIM, "Personal", 1, true, 0], "fixed: nothing open");
    assert.deepEqual(claim.fixes.map((f: any) => [f.line, f.dream]), [[LINE_1, first["runId"]]]);
    assert.equal(claim.evidence[0].dream, first["runId"]);
    assert.deepEqual(out["tree"].map((p: any) => [p.depth, p.name]), [[0, "Personal"], [1, "Writing"]]);
    assert.ok(out["cost"] > 0);
    const [row] = await b.query("MATCH (c:Node {node_type: 'Claim'}) RETURN c.created_by AS by, c.namespace AS ns");
    assert.deepEqual([row!["by"], row!["ns"]], [SYSTEM_WRITER, "private"]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "dream", "personal.json"), "utf-8")).marks, { "c-1": 1 });

    const quiet = await dream();
    assert.deepEqual(calls, [], "nothing new to read, nothing due: no model call");
    assert.deepEqual([quiet["output"]["turns"], quiet["output"]["moments"], quiet["output"]["due"], quiet["output"]["changes"]], [0, 0, 0, []]);
    assert.equal(quiet["output"]["claims"].length, 1, "the claim is still reported");

    await say("again, too long");
    found = { turn: 2, excerpt: "again, too long", lasting: false };
    const back = await dream();
    assert.deepEqual(calls, ["find", "match", "fix"]);
    assert.match(prompts["match"]!, /\(on Personal, corrected 1×\)/, "the existing claim is among the moment's candidates");
    assert.match(prompts["fix"]!, /already written for it, and it came back/);
    assert.deepEqual(back["output"]["records"].map((r: any) => [r.created, r.outcome]), [[false, "not_followed"]]);
    assert.deepEqual(back["output"]["changes"].map((c: any) => [c.concept.name, c.kind, c.removed, c.added]), [["Writing", "changed", [LINE_1], [LINE_2]]]);
    assert.equal(await docsOf("Writing"), LINE_2, "replaced, not added to");
    const again = back["output"]["claims"][0];
    assert.deepEqual([again.corrected, again.open, again.fixes.length], [2, 0, 2]);
  });

  it("a correction leaves its claim one check; run, it asks a sealed stand-in through dream-check and its verdict is evidence from the check, on no count; a check that fails writes nothing", async () => {
    // The assistant's stand-in: the same input and output, sealed as the orchestrator is, and no model.
    const ws = new WorkspaceManager(dir);
    await ws.publishWorkflow("stand-in", "v1", "name: stand-in\nsealed: true\ninput:\n  prompt: { type: string }\nsteps:\n  - id: result\n    type: pack\n    config:\n      text: \"Here is a summary of {{ input.prompt }}, in eight lines.\"\n      cost: 0\n");
    const PROMPT = "Summarise the notes from Monday's planning meeting";
    const checking = (workflow: string) => ({ params: { maxChecks: 5 }, paramOverrides: { "dream-check": { workflow } } });
    const run = async (extra: Record<string, unknown> = {}) => {
      calls = [];
      const r = await runOf("dream", { input: {}, ...extra });
      assert.equal(r["status"], "success", JSON.stringify(r).slice(0, 1500));
      return r;
    };
    const checkNodes = () => b.query("MATCH (k:Node {node_type: 'Check'})-[:TESTS]->(c:Node {node_type: 'Claim'}) RETURN k.id AS id, c.id AS claim, k.created_at AS at, k.created_by AS by, k.publisher AS publisher, k.step_type AS type, k.step_config AS config");
    const results = () => b.query("MATCH (c:Node {node_type: 'Claim'})-[eb:EVIDENCED_BY]->(e:Node)-[:PRODUCED_BY]->(k:Node {node_type: 'Check'}) RETURN eb.strength AS s, eb.context AS context, e.content AS content, k.id AS k");

    await say("summarise my notes from Monday");
    await say("too long, always keep summaries to three lines");
    found = { turn: 1, excerpt: "too long, always keep summaries to three lines", lasting: true, prompt: PROMPT };
    // As shipped: the check is written, and none runs.
    const first = await run();
    assert.deepEqual(calls, ["find", "match", "fix"], "no check runs by default");
    assert.match(prompts["find"]!, /also give `prompt`/);
    const [node] = await checkNodes();
    const out = first["output"] as Record<string, any>;
    const claim = out["claims"][0];
    assert.deepEqual([node!["claim"], node!["by"], node!["publisher"], node!["type"], JSON.parse(String(node!["config"]))], [claim.id, SYSTEM_WRITER, SYSTEM_WRITER, "subflow", { workflow: "dream-check", input: { prompt: PROMPT, claim: CLAIM } }]);
    assert.ok(Number(node!["at"]) > 0, "a Check is stamped with when it was written");
    assert.deepEqual([out["records"][0].check, out["checks"], out["check_pass"], out["check_total"], claim.check], [node!["id"], [], 0, 0, { id: node!["id"], prompt: PROMPT, history: [] }]);

    // Corrected again, and checked: a check that fails (no such workflow) is skipped, and nothing is written.
    await say("again, too long");
    found = { turn: 2, excerpt: "again, too long", lasting: false, prompt: "Summarise something else" };
    const broken = await run(checking("no-such-workflow"));
    assert.deepEqual(calls, ["find", "match", "fix"], "nothing to judge");
    assert.equal((await checkNodes()).length, 1, "a second dream makes no second check");
    const [skipped] = broken["output"]["checks"];
    assert.deepEqual([skipped.claim, skipped.prompt, skipped.supports, typeof skipped.skipped, broken["output"]["check_total"]], [claim.id, PROMPT, undefined, "string", 0]);
    assert.match(skipped.skipped, /no-such-workflow/);
    assert.deepEqual([await results(), broken["output"]["claims"][0].check.history], [[], []]);

    // Against: −1 from the check. The claim's counts are what people said, as before.
    await say("still too long");
    found = { turn: 3, excerpt: "still too long", lasting: false };
    verdict = false;
    const failed = await run(checking("stand-in"));
    assert.deepEqual(calls, ["find", "match", "fix", "judge"]);
    assert.match(prompts["judge"]!, /THE RULE: Summaries are three lines or fewer/);
    assert.match(prompts["judge"]!, /in eight lines/, "the judge reads what the sealed stand-in answered");
    const o = failed["output"] as Record<string, any>;
    assert.deepEqual([o["checks"], o["check_pass"], o["check_total"]], [[{ claim: claim.id, prompt: PROMPT, supports: false, content: "eight lines" }], 0, 1]);
    const [ev] = await results();
    const context = JSON.parse(String(ev!["context"]));
    assert.deepEqual([Number(ev!["s"]), ev!["content"], ev!["k"], context.kind, context.dream, context.prompt, typeof context.ms], [-1, "eight lines", node!["id"], "check", failed["runId"], PROMPT, "number"]);
    const c1 = o["claims"][0];
    assert.deepEqual([c1.corrected, c1.kept, c1.evidence.length, c1.evidence.every((e: any) => e.session === "c-1")], [3, 0, 3, true], "the check's result is on no count and not among what was said");
    assert.deepEqual([c1.check.supports, c1.check.content, c1.check.history.map((h: any) => [h.supports, h.dream])], [false, "eight lines", [[false, failed["runId"]]]]);

    // For: +1, the newest on top.
    await say("too long again");
    found = { turn: 4, excerpt: "too long again", lasting: false };
    verdict = true;
    const held = await run(checking("stand-in"));
    const c2 = held["output"]["claims"][0];
    assert.deepEqual([held["output"]["check_pass"], held["output"]["check_total"], c2.corrected, c2.check.supports, c2.check.history.map((h: any) => h.supports)], [1, 1, 4, true, [true, false]]);
    assert.deepEqual((await results()).map((r) => Number(r["s"])).sort(), [-1, 1]);
    assert.equal((await checkNodes()).length, 1);
  });

  it("one remark alone is recorded and changes no concept; a tree with no root Concept is not dreamt on", async () => {
    await say("summarise my notes from Monday");
    await say("too long");
    found = { turn: 1, excerpt: "too long", lasting: false };
    const run = await dream();
    assert.deepEqual(calls, ["find", "match"], "not due: corrected once, and not said to last");
    assert.deepEqual([run["output"]["due"], run["output"]["changes"], run["output"]["claims"][0].open], [0, [], 1]);
    assert.equal(await docsOf("Writing"), undefined);

    calls = [];
    const none = await runOf("dream", { input: { root: "Elsewhere" } });
    assert.equal(none["status"], "error");
    assert.match(none["error"]["message"], /there is no Concept "Elsewhere" to tend/);
    assert.deepEqual(calls, []);
    // Another tree is another input, with its own marks: its dream reads the same turns.
    await b.nodes.write({ type: "Concept", data: { name: "Elsewhere" } });
    found = null;
    const other = await dream({ root: "Elsewhere" });
    assert.deepEqual([other["output"]["turns"], other["output"]["root"], other["output"]["claims"]], [2, "Elsewhere", []]);
  });

  it("with review a fix is a proposal: the Concept is not written and the claim stays open", async () => {
    await say("summarise my notes from Monday");
    await say("too long, always keep summaries to three lines");
    found = { turn: 1, excerpt: "too long, always keep summaries to three lines", lasting: true };
    const run = await dream({ review: true });
    const [change] = run["output"]["changes"];
    assert.deepEqual([change.concept.name, change.kind, change.added, typeof change.proposed], ["Writing", "added", [LINE_1], "string"]);
    assert.equal(await docsOf("Writing"), undefined, "not written");
    assert.deepEqual([run["output"]["claims"][0].open, run["output"]["claims"][0].fixes], [1, []]);
    const { proposals } = (await (await strut!.app.request("/proposals")).json()) as { proposals: Array<{ id: string; step: string; status: string }> };
    assert.deepEqual(proposals.map((p) => [p.id, p.step, p.status]), [[change.proposed, "graph/create-triplet", "pending"]]);
  });
});
