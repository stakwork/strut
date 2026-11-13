/**
 * The dream end to end: a whole strut on a graph workspace, the shipped
 * `dream` and `concept-check` workflows, and a stand-in model that plays
 * each agent by its system prompt. A person corrects the assistant; the
 * dream reads the turns, writes a claim on the page with the standard
 * check, records what the person said against it, and CHANGES the tree:
 * at once by default, the history's commit carrying its run; as a
 * proposal a person accepts first where the tree is reviewed (`review`).
 * Either way the page's version moves, the claim reads stale, and the next
 * turn that opens the page is judged by `concept-check`. What a cycle
 * learned is read back afterwards (`knowledge/cycles`). A dream with
 * nothing new calls no model.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphBackend } from "./backend.js";
import { projectionsSettled } from "./projector.js";
import { parseGraphReaders } from "./scope.js";
import { testBackends } from "./test-util.js";
import { GraphWorkspaceStore } from "./workspace-store.js";
import { createStrut, type Strut } from "../createStrut.js";
import { CONCEPT_CHECK_WORKFLOW, KNOWLEDGE_CLAIMS_PER_RUN, type KnowledgeCapability } from "../knowledge.js";
import { ORCHESTRATOR_WORKFLOW } from "../orchestrator-seed.js";
import { isSealedStep, sealedStepPatterns } from "../sealed.js";
import { MemoryRunStore } from "../store.js";
import addClaimStep from "../steps/lib/knowledge/add-claim.js";
import addEvidenceStep from "../steps/lib/knowledge/add-evidence.js";
import pageStep from "../steps/lib/knowledge/page.js";
import claimsStep from "../steps/lib/knowledge/claims.js";
import cyclesStep from "../steps/lib/knowledge/cycles.js";
import doneStep from "../steps/lib/dream/done.js";
import turnsStep from "../steps/lib/dream/turns.js";
import historyRead from "../steps/lib/history/read.js";
import { RUN_STEP_FLOW } from "../run-step.js";

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
const SAID = "too long, keep summaries to three lines";
const NEW_DOCS = "Summaries are three lines or fewer.";

/** A person's own strut (Peel): who reads which namespace. The dream is strut's own job, a `jobs` reader. */
const PEEL_READERS = parseGraphReaders({
  assistant: { workflows: ["orchestrator"], namespaces: ["private", "shared"] },
  jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] },
  apps: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  peers: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  builder: { namespaces: ["*"] },
  ui: { namespaces: ["*"] },
});

// Every engine, and a Ladybug file again under a personal strut's reader lists.
const VARIANTS = testBackends().flatMap((tb) => [{ tb, readers: undefined }, ...(tb.kind === "ladybug" ? [{ tb, readers: PEEL_READERS }] : [])]);

for (const { tb, readers } of VARIANTS) describe(`the dream on ${tb.name}${readers ? ", under a personal strut's reader lists" : ""}`, { skip: tb.skip }, () => {
  let backend: GraphBackend;
  let dir = "";
  let provider: http.Server;
  let strut: Strut | undefined;
  /** Which agent each model call was for, in order. */
  let calls: string[] = [];
  /** What the dream's agent was first sent (its system prompt, and its messages), and what each judge was sent. */
  let tendSystem = "";
  let tendPrompt = "";
  /** The tools the dream's agent was offered, as the model sees them. */
  let tendTools = "";
  let judged: string[] = [];
  /** What the stand-in judge answers: a verdict, or none (the rule is not about that run). */
  let verdict: boolean | null = false;
  /** What the stand-in tender does: the usual script, or nothing to learn. */
  let lesson = true;
  /** A page of its own guidance the stand-in tender opens first, by name. */
  let openFirst = "";
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    let n = 0;
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as { system?: unknown; tools?: unknown; messages: Array<{ role: string; content: unknown }> };
        const system = JSON.stringify(body.system ?? "");
        const all = JSON.stringify(body.messages);
        const say = (name: string, input: unknown) => res.end(toolUse(`toolu_${++n}`, name, input));
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (system.includes("You are the dream.")) {
          calls.push("tend");
          const turn = body.messages.filter((m) => m.role === "assistant").length;
          if (turn === 0) [tendSystem, tendPrompt, tendTools] = [system, all, JSON.stringify(body.tools ?? [])];
          if (openFirst && turn === 0) return say("graph_graph_get", { node_type: "Concept", name: openFirst, children: "PARENT_OF" });
          if (!lesson) return say("final_answer", { lessons: [] });
          // The run whose work was corrected (turn 0's), the root's ref_id, and the claim once it is written.
          const run = /turn 0 · [^\]]*? · run orchestrator (\d+)/.exec(all)?.[1];
          const root = /CONCEPT \\+"Personal\\+" \(ref_id ([0-9a-f-]+)\)/.exec(all)?.[1];
          const claim = /\\+"id\\+":\\+"([0-9a-z]{32})\\+"/.exec(all)?.[1];
          if (turn === 0) return say("knowledge_add_claim", { concept: "Personal", text: CLAIM });
          if (turn === 1) return say("knowledge_add_evidence", { claim, workflow: "orchestrator", run, said: SAID, by: "evan" });
          // The root is never edited: the lesson goes on a page under it.
          if (turn === 2)
            return say("graph_create_triplet", {
              source_ref_id: root,
              edge_type: "PARENT_OF",
              target_type: "Concept",
              target_data: { name: "Summaries", description: "How long a summary may be: open it before writing one.", docs: NEW_DOCS },
              rationale: "The person said summaries run long; no page says how long they may be.",
            });
          return say("final_answer", { lessons: [{ session: "c-1", turn: 1, said: SAID, concept: "Personal", claim: CLAIM, claim_id: claim, recorded: true, change: "a Summaries page under Personal" }] });
        }
        if (system.includes("You judge whether a piece of work did what a rule says")) {
          calls.push("judge");
          judged.push(all);
          return say("final_answer", verdict === null ? { content: "this run wrote no summary" } : { supports: verdict, content: verdict ? "three lines" : "eight lines" });
        }
        calls.push("assistant");
        say("final_answer", { text: "Hello.", artifacts: [] });
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
    calls = [];
    judged = [];
    tendSystem = "";
    tendPrompt = "";
    tendTools = "";
    verdict = false;
    lesson = true;
    openFirst = "";
    dir = join(tmpdir(), `strut-dream-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    strut = await createStrut({
      workspace: new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps") }),
      store: new MemoryRunStore(),
      dataDir: dir,
      serveUi: false, enableChat: false, scheduler: false, stt: false, autoResume: false,
      job: false, builder: false, orchestrator: {}, concepts: { personal: true },
      ...(readers ? { graphReaders: readers } : {}),
    });
    await strut.secretStore.set("STRUT_DEFAULT_MODEL", "anthropic/claude-sonnet-4-5");
  });
  afterEach(async () => {
    await projectionsSettled(backend);
    await strut?.close();
    strut = undefined;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const json = async <T = Record<string, any>>(path: string, init?: RequestInit): Promise<T> => {
    const res = await strut!.app.request(path, init);
    assert.ok(res.status < 300, `${path}: ${res.status} ${await res.clone().text()}`);
    return (await res.json()) as T;
  };
  const post = (path: string, body: unknown = {}) => json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** Runs `workflow` to its end: its summary. */
  async function runOf(workflow: string, body: unknown = {}): Promise<Record<string, any>> {
    const { runId } = await post(`/workflows/${workflow}/run`, body);
    for (let i = 0; i < 3000; i++) {
      // 404 until the run's first event is on file.
      const s = (await (await strut!.app.request(`/workflows/${workflow}/runs/${runId}`)).json()) as Record<string, any>;
      if (s["status"] && s["status"] !== "running" && !s["partial"]) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${workflow} never finished`);
  }
  const say = async (text: string) => {
    const run = await runOf(ORCHESTRATOR_WORKFLOW, { input: { prompt: text, session: "c-1" } });
    assert.equal(run["status"], "success", JSON.stringify(run).slice(0, 800));
    return run;
  };
  const dream = async (input: Record<string, unknown> = {}) => {
    calls = [];
    const run = await runOf("dream", { input });
    assert.equal(run["status"], "success", JSON.stringify(run).slice(0, 1500));
    return run;
  };
  /** The verify pass over one run, joined or repeated: what it did. */
  const verified = (workflow: string, runId: string) => post(`/workflows/${workflow}/runs/${runId}/verify`);
  const claimsOn = async (name: string) => (await json<{ claims: Array<Record<string, any>> }>(`/claims?kind=concept&name=${encodeURIComponent(name)}`)).claims;
  const docsOf = async (name: string) => (await (strut!.services as unknown as { knowledge: KnowledgeCapability }).knowledge.page(name))?.docs;

  /** The history's commits carrying `run` that changed a Concept page; null where this strut keeps no history (no `git`). */
  const commitsOf = async (run: string) => {
    const r = (await historyRead.run(historyRead.input.parse({ action: "log", run, path: "concepts" }), { services: strut!.services } as never)) as {
      history?: false;
      commits?: Array<{ subject: string; runs: string[]; changes: Array<{ path: string; status: string }> }>;
    };
    return r.history === false ? null : r.commits!;
  };
  /** What the dream learned, cycle by cycle (the Knowledge door's `cycles`). */
  const cycles = async (opts: { tree?: string } = {}) =>
    (await (strut!.services as unknown as { knowledge: KnowledgeCapability }).knowledge.cycles(opts)) as unknown as Array<Record<string, any>>;
  /** The page strut ships, shown to an admin: what knowledge/cycles answers, and no one else. */
  const ADMIN_PAGE = { workflow: RUN_STEP_FLOW, app: { name: "strut/knowledge", version: "v1", firstParty: true, admin: true } };
  const cyclesAs = async (ctx: Record<string, unknown>) =>
    ((await cyclesStep.run(cyclesStep.input.parse({}), { services: strut!.services, ...ctx } as never)) as { cycles: Array<Record<string, any>> }).cycles;

  it("a correction becomes a claim with the standard check, the person's word against it, and a CHANGE made at once: no proposal, the history's commit carries the run, and the next turn is judged", async () => {
    const first = await say("summarise my notes from Monday");
    await say(SAID);
    const docsBefore = await docsOf("Personal");

    const run = await dream();
    assert.deepEqual(calls, ["tend", "tend", "tend", "tend"]);
    // Its rules come from pages, not from the workflow: the mechanics, then the `Dream` page (what holds for any
    // source, with the sources under it), then the page of the source it reads.
    const at = (s: string) => tendSystem.indexOf(s);
    for (const s of ["You are the dream.", 'the \\"Dream\\" Concept', "## Where a lesson goes", "- Assistant Conversations — ", 'the \\"Assistant Conversations\\" Concept', "Look for the moments a person corrected the assistant"]) assert.ok(at(s) >= 0, s);
    assert.ok(at("You are the dream.") < at('the \\"Dream\\" Concept') && at("## Where a lesson goes") < at('the \\"Assistant Conversations\\" Concept'), "mechanics, the root, then the source");
    // Not reviewed: the tools that change the tree run, and none says it waits for a person.
    assert.ok(tendTools.includes("graph_create_triplet") && tendTools.includes("graph_edit_node"), tendTools.slice(0, 300));
    assert.ok(!tendTools.includes("PROPOSED") && !tendSystem.includes("nothing changes until"), "nothing waits");
    // The transcript the agent was handed: each turn with its run and the pages that run opened, then the root as a tender reads it.
    assert.match(tendPrompt, new RegExp(`\\[session c-1 · turn 0 · [^\\]]* · run orchestrator ${first["runId"]}[^\\]]*\\]\\\\+nOPENED: [^\\\\]*Personal`));
    assert.match(tendPrompt, /PERSON: too long, keep summaries to three lines/);
    assert.match(tendPrompt, /CONCEPT \\+"Personal\\+" \(ref_id [0-9a-f-]+\) — a root/);
    const out = run["output"] as Record<string, any>;
    assert.deepEqual([out["root"], out["review"], out["turns"], out["more"], out["stuck"]], ["Personal", false, 2, false, []]);
    assert.deepEqual(out["lessons"].map((l: any) => [l.session, l.turn, l.concept, l.claim, l.recorded, l.change]), [["c-1", 1, "Personal", CLAIM, true, "a Summaries page under Personal"]]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "dream", "personal.json"), "utf-8")).marks, { "c-1": 1 });

    // The claim: written at once, by the AI, with the one check a tender's claims get.
    let [claim] = await claimsOn("Personal");
    assert.deepEqual([claim!["text"], claim!["speaker"]], [CLAIM, "ai"]);
    assert.deepEqual(
      claim!["checks"].map((k: any) => [k.name, k.type, k.config.workflow, k.config.input.claim, k.policy, k.publisher]),
      [["judge", "subflow", CONCEPT_CHECK_WORKFLOW, CLAIM, "on_change", "ai"]],
    );
    // What the person said is their word against it, about the page as turn 0's run read it. The change then
    // landed, and the root's version covers the pages listed under it: the claim reads stale, waiting for a judge.
    assert.deepEqual([claim!["status"], claim!["unverified"]], ["stale", 1]);
    assert.deepEqual([claim!["latest"].content, claim!["latest"].by, claim!["latest"].run.runId, claim!["latest"].mode], [SAID, "evan", first["runId"], "asserted"]);

    // The change is made, not proposed: a page under the root, the root's own text as it was.
    assert.deepEqual((await json<{ proposals: unknown[] }>(`/proposals?runId=${run["runId"]}`)).proposals, []);
    assert.equal(await docsOf("Personal"), docsBefore);
    assert.equal(await docsOf("Summaries"), NEW_DOCS);

    // What it changed is the history's: the commit carries the dream's run (`Run:`).
    const commits = await commitsOf(run["runId"]);
    assert.equal(commits === null, !strut!.history, "read wherever this strut keeps a history");
    if (commits) {
      assert.ok(commits.length >= 1 && commits.every((c) => c.runs.includes(run["runId"])), JSON.stringify(commits));
      assert.ok(commits.some((c) => c.changes.some((ch) => ch.path === "concepts/concept-summaries.md" && ch.status === "added")), JSON.stringify(commits));
    }

    // And what it learned, read back as strut's own page shows an admin: the cycle, with its lessons.
    const [cycle] = await cycles();
    assert.deepEqual([cycle!["run"], cycle!["status"], cycle!["tree"], cycle!["source"], cycle!["review"], cycle!["turns"]], [run["runId"], "success", "Personal", "Assistant Conversations", false, 2]);
    assert.deepEqual(cycle!["lessons"], [{ session: "c-1", turn: 1, said: SAID, concept: "Personal", claim: CLAIM, claim_id: claim!["id"], recorded: true, change: "a Summaries page under Personal" }]);

    // Nothing new to read: no model is called, nothing is written twice, and it is no cycle.
    const quiet = await dream();
    assert.deepEqual(calls, []);
    assert.deepEqual([quiet["output"]["turns"], quiet["output"]["lessons"]], [0, []]);
    assert.equal((await claimsOn("Personal")).length, 1);
    assert.deepEqual((await cycles()).map((c) => c["run"]), [run["runId"]]);
    assert.deepEqual(await cycles({ tree: "Job" }), []);

    // The dream's own run opened its own pages, never the tree it tends (a tender reads through knowledge/page):
    // it is not checked against the claim on Personal. A quiet dream opened nothing.
    const knowledge = (strut!.services as unknown as { knowledge: KnowledgeCapability }).knowledge;
    assert.deepEqual((await knowledge.opened("dream", run["runId"]))?.sort(), ["Assistant Conversations", "Dream"]);
    assert.deepEqual(await knowledge.opened("dream", quiet["runId"]), []);
    assert.deepEqual((await verified("dream", run["runId"]))["checks"], []);

    // The next turn opens the new page, and the judge is handed that run.
    verdict = true;
    calls = [];
    const next = await say("summarise Tuesday's notes");
    const pass = await verified(ORCHESTRATOR_WORKFLOW, next["runId"]);
    assert.deepEqual(pass["checks"].map((k: any) => [k.path, k.lastVerify]), [["concept:Personal", { ran: true }]]);
    assert.equal(judged.length, 1);
    assert.match(judged[0]!, new RegExp(`THE RULE: ${CLAIM}`));
    assert.match(judged[0]!, /WHAT IT WAS ASKED:[^]*summarise Tuesday's notes/);
    assert.match(judged[0]!, /CONCEPT PAGES IT OPENED: [^\\]*Personal/);
    [claim] = await claimsOn("Personal");
    assert.deepEqual([claim!["status"], claim!["assertedOnly"], claim!["unverified"], claim!["latest"].content, claim!["latest"].mode], ["supported", true, 0, "three lines", "asserted"]);
    assert.match(claim!["latest"].checkVersion, new RegExp(`^${CONCEPT_CHECK_WORKFLOW}@`));

    // Judged once per version of the page: the turn after it runs no judge.
    const again = await say("and Wednesday's");
    assert.deepEqual((await verified(ORCHESTRATOR_WORKFLOW, again["runId"]))["checks"].map((k: any) => k.lastVerify), [{ skipped: "policy" }]);
    assert.equal(judged.length, 1);
  });

  it("a tree under review: each change is a proposal and the tree is as it was until a person accepts it", async () => {
    await say("summarise my notes from Monday");
    await say(SAID);
    const docsBefore = await docsOf("Personal");

    const run = await dream({ review: true });
    // The tools that change the tree say the change waits; the dream's own words hold either way.
    assert.match(tendTools, /graph_create_triplet[^]*PROPOSED, not run/);
    assert.ok(tendSystem.includes("Where a person reviews this tree, the answer says the change"));
    assert.deepEqual([run["output"]["review"], run["output"]["lessons"].length], [true, 1]);

    const { proposals } = await json<{ proposals: Array<Record<string, any>> }>(`/proposals?runId=${run["runId"]}`);
    assert.deepEqual(proposals.map((p) => [p["step"], p["status"]]), [["graph/create-triplet", "pending"]]);
    assert.equal(await docsOf("Personal"), docsBefore);
    assert.equal(await docsOf("Summaries"), undefined);
    assert.equal((await claimsOn("Personal"))[0]!["status"], "refuted");
    // Nothing in the tree changed under the dream's run, and its cycle says its changes waited.
    const commits = await commitsOf(run["runId"]);
    if (commits) assert.deepEqual(commits, []);
    assert.deepEqual((await cycles()).map((c) => [c["run"], c["review"]]), [[run["runId"], true]]);

    // A person accepts: the page lands, and the claim reads stale.
    const decided = await post(`/proposals/${proposals[0]!["id"]}/decide`, { action: "accept" });
    assert.equal(decided["status"], "applied", JSON.stringify(decided).slice(0, 600));
    assert.equal(await docsOf("Personal"), docsBefore);
    assert.equal(await docsOf("Summaries"), NEW_DOCS);
    assert.equal((await claimsOn("Personal"))[0]!["status"], "stale");
  });

  it("knowledge/cycles answers strut's own page shown to an admin, and no one else: the lessons quote what people said", async () => {
    await say(SAID);
    const run = await dream();
    const page = (over: Record<string, unknown>) => ({ ...ADMIN_PAGE, app: { ...ADMIN_PAGE.app, ...over } });
    // A workflow's step or an agent's tool, a run the page launched, a member's page, a page strut did not ship.
    for (const ctx of [{}, { workflow: "some-flow", app: ADMIN_PAGE.app }, page({ admin: false }), page({ firstParty: false }), { workflow: RUN_STEP_FLOW }]) {
      await assert.rejects(async () => cyclesAs(ctx), /knowledge\/cycles is an admin's/, JSON.stringify(ctx));
    }
    // Where a page may not read the tree's namespace (a personal strut), it is refused as the claims are.
    if (readers) await assert.rejects(async () => cyclesAs(ADMIN_PAGE), /may not read "private", where the Concept tree is kept/);
    else assert.deepEqual((await cyclesAs(ADMIN_PAGE)).map((c) => [c["run"], c["lessons"].length]), [[run["runId"], 1]]);
  });

  it("a run the rule is not about is left unjudged: nothing is recorded, and the next run that opens the page is judged in its place", async () => {
    lesson = false;
    await say("hello");
    const knowledge = (strut!.services as unknown as { knowledge: KnowledgeCapability }).knowledge;
    const made = await knowledge.addClaim({ concept: "Personal", text: CLAIM });
    assert.ok("ok" in made);

    verdict = null;
    const a = await say("what time is it in Lisbon?");
    const passA = await verified(ORCHESTRATOR_WORKFLOW, a["runId"]);
    assert.deepEqual(passA["checks"].map((k: any) => k.lastVerify), [{ skipped: "cannot-launch", reason: "the check returned no { supports, content }" }]);
    assert.equal((await claimsOn("Personal"))[0]!["status"], "unknown");

    verdict = false;
    const b = await say("summarise my week");
    assert.deepEqual((await verified(ORCHESTRATOR_WORKFLOW, b["runId"]))["checks"].map((k: any) => k.lastVerify), [{ ran: true }]);
    assert.deepEqual([(await claimsOn("Personal"))[0]!["status"], (await claimsOn("Personal"))[0]!["latest"].content], ["refuted", "eight lines"]);

    // With nothing to learn, the dream writes nothing and still marks the turns read.
    const run = await dream();
    assert.deepEqual([run["output"]["turns"], run["output"]["lessons"]], [3, []]);
    assert.equal((await json<{ proposals: unknown[] }>(`/proposals?runId=${run["runId"]}`)).proposals.length, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "dream", "personal.json"), "utf-8")).marks, { "c-1": 2 });
  });

  it("the dream's rules are pages: the shipped ones a fixed base, the pages a workspace adds around them read and measured, another source swapped in by name", async () => {
    lesson = false;
    const knowledge = (strut!.services as unknown as { knowledge: KnowledgeCapability }).knowledge;
    const under = async (parent: string, data: Record<string, string>) => {
      const [node] = await backend.nodes.writeMany([{ type: "Concept", data }]);
      await backend.edges.write({ edge: "PARENT_OF", source_ref_id: (await knowledge.page(parent))!.ref_id, target_ref_id: node!.ref_id });
    };
    // What a workspace learns about learning is in pages around the shipped ones: one under the conversations'
    // page is listed with how to open it, the dream opens it, and its run records the page as followed.
    await under("Assistant Conversations", { name: "Quiet Corrections", description: "corrections made without saying no", docs: "A person rewriting the reply themselves is a correction." });
    await say("hello");
    openFirst = "Quiet Corrections";
    const around = await dream();
    assert.ok(tendSystem.includes("- Quiet Corrections — corrections made without saying no") && tendSystem.includes("graph_graph_get({ node_type: \\\"Concept\\\", name: \\\"<name>\\\""), "listed under the source, with how to open it");
    assert.deepEqual((await knowledge.opened("dream", around["runId"]))?.sort(), ["Assistant Conversations", "Dream", "Quiet Corrections"]);
    openFirst = "";

    // A second kind of source is a page under Dream: the dream reads it in place of the conversations' page.
    await under("Dream", { name: "Field Notes", description: "notes people wrote", docs: "Look for the lines a person underlined." });

    // A claim on the Dream page itself: what every dream must hold to.
    const rule = await knowledge.addClaim({ concept: "Dream", text: "A lesson quotes the person's own words" });
    assert.ok("ok" in rule);

    await say("hello");
    verdict = true;
    const run = await dream({ source: "Field Notes" });
    assert.ok(tendSystem.includes('the \\"Field Notes\\" Concept') && tendSystem.includes("Look for the lines a person underlined."), "the named source's page");
    assert.ok(!tendSystem.includes('the \\"Assistant Conversations\\" Concept'), "and not the conversations' page");
    assert.ok(tendSystem.includes("## Where a lesson goes"), "the Dream page is read whatever the source");
    assert.deepEqual((await knowledge.opened("dream", run["runId"]))?.sort(), ["Dream", "Field Notes"]);

    // The dream's run opened the Dream page, so the claim on it is judged against that run.
    const pass = await verified("dream", run["runId"]);
    assert.deepEqual(pass["checks"].map((k: any) => [k.path, k.lastVerify]), [["concept:Dream", { ran: true }]]);
    assert.match(judged.at(-1)!, /THE RULE: A lesson quotes the person's own words/);
    assert.equal((await claimsOn("Dream"))[0]!["status"], "supported");
  });

  it("the Knowledge door: a page as a tender reads it, one claim per sentence, a cap per run, words only about a run that opened the page; its writers are sealed", async () => {
    const knowledge = (strut!.services as unknown as { knowledge: KnowledgeCapability }).knowledge;
    const [child] = await backend.nodes.writeMany([{ type: "Concept", data: { name: "Communication Style", description: "tone", docs: "No greeting." } }]);
    const root = await knowledge.page("Personal");
    await backend.edges.write({ edge: "PARENT_OF", source_ref_id: root!.ref_id, target_ref_id: child!.ref_id });

    const made = await knowledge.addClaim({ concept: "Communication Style", text: "  Messages have no greeting  " }, { runId: "r1" });
    assert.ok("ok" in made && !made.existing);
    assert.deepEqual(await knowledge.addClaim({ concept: "Communication Style", text: "Messages have no greeting" }, { runId: "r1" }), { ok: true, id: (made as { id: string }).id, existing: true });
    assert.match(((await knowledge.addClaim({ concept: "Nope", text: "x" })) as { error: string }).error, /concept "Nope" is not in the graph/);
    assert.match(((await knowledge.addClaim({ concept: "Personal", text: "say {{ input.output }}" })) as { error: string }).error, /may not contain \{\{/);
    assert.match(((await knowledge.addClaim({ concept: "Personal", text: "  " })) as { error: string }).error, /text is empty/);

    // A page as a tender reads it: its own claims, and which of the pages under it carry any.
    const page = await knowledge.page("Personal");
    assert.deepEqual([page!.parents, page!.children, page!.claims], [[], [{ name: "Communication Style", description: "tone", has_claims: true }], []]);
    const style = await knowledge.page("Communication Style");
    assert.deepEqual([style!.parents, style!.docs, style!.claims.map((c) => [c.text, c.status, c.speaker])], [["Personal"], "No greeting.", [["Messages have no greeting", "unknown", "ai"]]]);
    assert.equal(await knowledge.page("Nope"), null);
    const asStep = (await pageStep.run(pageStep.input.parse({ name: "Communication Style", text: true }), { services: strut!.services } as never)) as { text: string };
    assert.match(asStep.text, /^CONCEPT "Communication Style" \(ref_id [0-9a-f-]+\) — under "Personal"\ndescription: tone\ndocs:\n  \| No greeting\.\npages under it: none\nclaims on it:\n  - [0-9a-z]{32} \[unknown\] "Messages have no greeting"$/);
    assert.match(String(await pageStep.run(pageStep.input.parse({ name: "Nope" }), { services: strut!.services } as never)), /no Concept named "Nope"/);

    // What a person said is evidence only about a run that opened the claim's page.
    const turn = await say("write to Sam");
    assert.deepEqual(await knowledge.opened(ORCHESTRATOR_WORKFLOW, turn["runId"]), ["Job", "Workflow Builder", "Personal"], "the three roots an orchestrator turn reads");
    assert.equal(await knowledge.opened(ORCHESTRATOR_WORKFLOW, "1"), null, "no such run: its log does not say");
    const unread = await knowledge.addEvidence({ claim: (made as { id: string }).id, workflow: ORCHESTRATOR_WORKFLOW, runId: turn["runId"], supports: false, said: "no greeting, I said" });
    assert.match((unread as { error: string }).error, /did not execute a subject of this claim[^]*only about a run that OPENED "Communication Style"/);
    const onRoot = await knowledge.addClaim({ concept: "Personal", text: "A turn that writes a message opens Communication Style" });
    const heard = await knowledge.addEvidence({ claim: (onRoot as { id: string }).id, workflow: ORCHESTRATOR_WORKFLOW, runId: turn["runId"], supports: false, said: "no greeting, I said", by: "evan" });
    assert.deepEqual([("ok" in heard && heard.concept), (await claimsOn("Personal"))[0]!["status"]], ["Personal", "refuted"]);

    // Every Concept that carries claims, with them: what the Knowledge app scans for the ones that do not hold.
    const claimed = await knowledge.claims();
    assert.deepEqual(
      claimed.map((c) => [c.concept, c.ref_id, c.claims.map((x) => [x.text, x.status])]),
      [
        ["Communication Style", child!.ref_id, [["Messages have no greeting", "unknown"]]],
        ["Personal", root!.ref_id, [["A turn that writes a message opens Communication Style", "refuted"]]],
      ],
    );
    assert.deepEqual(claimed[1]!.claims[0]!.latest, { content: "no greeting, I said", mode: "asserted", by: "evan" });
    assert.deepEqual(await claimsStep.run({}, { services: strut!.services } as never), { concepts: claimed });

    // The door reads the graph as it is, so each step first asks whether its CALLER may read where the tree is
    // kept: on a personal strut an app's page reads `shared` alone, and the tree is private.
    const fromApp = { services: strut!.services, app: { name: "notes", version: "v1" } } as never;
    if (readers) await assert.rejects(async () => pageStep.run(pageStep.input.parse({ name: "Personal" }), fromApp), /this caller may not read "private", where the Concept tree is kept \(an app's page reads only what an app may\)/);
    else assert.equal(((await pageStep.run(pageStep.input.parse({ name: "Personal" }), fromApp)) as { name: string }).name, "Personal");
    if (readers) await assert.rejects(async () => claimsStep.run({}, fromApp), /knowledge\/claims: this caller may not read "private"/);
    else assert.equal(((await claimsStep.run({}, fromApp)) as { concepts: unknown[] }).concepts.length, 2);

    // One run adds at most so many claims.
    for (let i = 0; i < KNOWLEDGE_CLAIMS_PER_RUN; i++) assert.ok("ok" in (await knowledge.addClaim({ concept: "Personal", text: `rule ${i}` }, { runId: "r2" })));
    assert.match(((await knowledge.addClaim({ concept: "Personal", text: "one more" }, { runId: "r2" })) as { error: string }).error, /already added 10 claims/);

    // The door is the dream's alone: its writers, and the reader of every conversation, are sealed from the meta surface.
    const patterns = sealedStepPatterns({});
    const registry = { [addClaimStep.type]: addClaimStep, [addEvidenceStep.type]: addEvidenceStep, [turnsStep.type]: turnsStep, [doneStep.type]: doneStep, [pageStep.type]: pageStep, [claimsStep.type]: claimsStep } as never;
    assert.deepEqual(
      ["knowledge/add-claim", "knowledge/add-evidence", "dream/turns", "dream/done", "knowledge/page", "knowledge/claims"].map((t) => isSealedStep(t, registry, patterns)),
      [true, true, true, true, false, false],
    );
    for (const seed of ["job", "orchestrator", "builder"]) {
      assert.doesNotMatch(await readFile(new URL(`../workflows/${seed}.yaml`, import.meta.url), "utf-8"), /knowledge\/|dream\//, `${seed} is not granted the Knowledge door`);
    }
  });
});
