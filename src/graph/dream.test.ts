/**
 * The dream (plans/dream.md): claims about a Concept page on every graph
 * engine (`concept-claims.ts`), the steps that write, group and list them,
 * the step that hands a dream the turns no dream has read, and the shipped
 * workflow.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphBackend } from "./backend.js";
import { graphView, parseGraphReaders } from "./scope.js";
import { testBackends } from "./test-util.js";
import { conceptClaimId, conceptsOpenedBy, groupClaims, listClaims, recordSaid, treePages, type ClaimGraph, type Said } from "./concept-claims.js";
import type { ConversationTurn } from "../conversations.js";
import { createRegistry } from "../steps/registry.js";
import { validateWorkflowYaml } from "../validate.js";
import { flowFromYaml } from "../workspace.js";
import { SYSTEM_DIR, isSystemWorkflow } from "../system-workflows.js";
import claimStep from "../steps/lib/dream/claim.js";
import claimsStep from "../steps/lib/dream/claims.js";
import groupStep from "../steps/lib/dream/group.js";
import turnsStep from "../steps/lib/dream/turns.js";
import doneStep from "../steps/lib/dream/done.js";

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const ctxOf = (services: Record<string, unknown>) => ({ runId: "dream-run-1", path: "dream/dream", workflow: "dream", scope: {}, input: undefined, emit: async () => {}, services });
const run = (step: Step, cfg: Record<string, unknown>, services: Record<string, unknown>): Promise<any> => step.run(step.input.parse(cfg), ctxOf(services));

for (const tb of testBackends()) {
  describe(`claims about a Concept (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    let g: ClaimGraph;
    /** Personal ─┬─ Writing      Work ── Reports */
    let personal = "", writing = "", work = "", reports = "";
    before(async () => {
      b = await tb.open();
      g = b;
    });
    after(async () => {
      await tb.close(b);
    });
    beforeEach(async () => {
      await tb.clear(b);
      [personal, writing, work, reports] = (await b.nodes.writeMany(["Personal", "Writing", "Work", "Reports"].map((name) => ({ type: "Concept", data: { name } })))).map((r) => r.ref_id) as [string, string, string, string];
      await b.edges.writeMany([
        { edge: "PARENT_OF", source_ref_id: personal, target_ref_id: writing },
        { edge: "PARENT_OF", source_ref_id: work, target_ref_id: reports },
      ]);
    });
    const at = Date.parse("2026-11-09T10:00:00Z");
    const said = (turn: number, extra: Partial<Said> = {}): Said => ({
      source: "conversation", session: "peel/agent-1/dm", turn, excerpt: "too long, keep summaries to three lines", outcome: "missing", observed_at: at + turn * 60_000, ...extra,
    });

    it("a correction makes a claim about its page, with the words as evidence that the claim is right and the assistant was wrong; the same words again write nothing", async () => {
      const first = await recordSaid(g, said(4, { text: "Summaries are three lines or fewer", title: "Summaries too long", about: writing, dream: "dream-1", said_by: "tom", why: "the reply ran long" }));
      assert.equal(first.claim, conceptClaimId(writing, "Summaries are three lines or fewer"));
      assert.deepEqual([first.created, first.recorded], [true, true]);
      const again = await recordSaid(g, said(4, { text: "Summaries are three lines or fewer", about: writing }));
      assert.deepEqual([again.claim, again.created, again.recorded], [first.claim, false, false]);
      const [c] = await listClaims(g, undefined);
      assert.deepEqual([c!.title, c!.text, c!.about, c!.concept], ["Summaries too long", "Summaries are three lines or fewer", writing, "Writing"]);
      assert.deepEqual([c!.corrected, c!.kept], [1, 0]);
      assert.deepEqual(c!.evidence, [{
        source: "conversation", session: "peel/agent-1/dm", turn: 4, said_by: "tom", excerpt: "too long, keep summaries to three lines", why: "the reply ran long",
        denies: false, outcome: "missing", at: new Date(at + 4 * 60_000).toISOString(), dream: "dream-1",
      }]);
    });

    it("later words land on the claim by id: a correction counts against the assistant, a confirmation for it, a denial is the person saying the claim is wrong", async () => {
      const { claim } = await recordSaid(g, said(4, { text: "Summaries are three lines or fewer", about: writing }));
      await recordSaid(g, said(9, { claim, excerpt: "again, too long", outcome: "not_followed" }));
      await recordSaid(g, said(12, { claim, excerpt: "yes, exactly like that", outcome: "followed" }));
      await recordSaid(g, said(15, { claim, excerpt: "actually, long summaries are fine", outcome: "contradicted", denies: true }));
      const [c] = await listClaims(g, undefined);
      assert.deepEqual([c!.corrected, c!.kept], [3, 1], "counted on read");
      assert.deepEqual(c!.evidence.map((e) => [e.turn, e.outcome, e.denies]), [[15, "contradicted", true], [12, "followed", false], [9, "not_followed", false], [4, "missing", false]]);
    });

    it("claims of one kind go under a parent claim, whose counts are theirs; one level, one group each", async () => {
      const sam = (await recordSaid(g, said(1, { text: "No greeting in emails to Sam", about: writing }))).claim;
      const kate = (await recordSaid(g, said(2, { text: "No greeting in emails to Kate", about: writing }))).claim;
      await recordSaid(g, said(3, { claim: kate, outcome: "not_followed" }));
      const group = await groupClaims(g, { text: "Emails have no greeting", about: writing, claims: [sam, kate], at });
      assert.deepEqual([group.created, group.grouped.sort()], [true, [sam, kate].sort()]);
      // A new claim made under the group; grouping again adds nothing.
      const ann = (await recordSaid(g, said(5, { text: "No greeting in emails to Ann", about: writing, parent: group.claim }))).claim;
      assert.deepEqual((await groupClaims(g, { text: "Emails have no greeting", about: writing, claims: [sam], at })).grouped, []);
      const claims = await listClaims(g, undefined);
      const parent = claims.find((c) => c.id === group.claim)!;
      assert.deepEqual([parent.corrected, parent.kept, parent.evidence.length, parent.children], [4, 0, 0, [sam, kate, ann].sort()]);
      assert.equal(claims[0]!.id, group.claim, "the most corrected first");
      assert.ok(claims.filter((c) => c.id !== group.claim).every((c) => c.parent === group.claim));
      await assert.rejects(groupClaims(g, { text: "Another group", about: writing, claims: [sam], at }), /already in the group/);
      await assert.rejects(groupClaims(g, { text: "A group of groups", about: writing, claims: [group.claim], at }), /one level of groups/);
    });

    it("a tree's claims are those about its pages; a claim needs a real Concept, and an unknown claim is refused", async () => {
      await recordSaid(g, said(1, { text: "Summaries are three lines or fewer", about: writing }));
      await recordSaid(g, said(2, { text: "Reports open with the result", about: reports, excerpt: "lead with the result" }));
      await recordSaid(g, said(3, { text: "Ask before booking anything", about: personal, excerpt: "ask me first" }));
      assert.deepEqual((await listClaims(g, undefined, "Personal")).map((c) => c.concept).sort(), ["Personal", "Writing"]);
      assert.deepEqual((await listClaims(g, undefined, "Work")).map((c) => c.concept), ["Reports"]);
      assert.deepEqual(await listClaims(g, undefined, "No such tree"), []);
      assert.equal((await listClaims(g, undefined)).length, 3);
      await assert.rejects(recordSaid(g, said(5, { text: "x", about: "not-a-node" })), /is not a Concept/);
      await assert.rejects(recordSaid(g, said(5, { claim: "nope" })), /no claim "nope"/);
      await assert.rejects(recordSaid(g, said(5, { text: "no page named" })), /needs `text`.*and `about`/);
    });

    it("reads a tree as it stands: the root first, each page under its parent, siblings by name, with its text", async () => {
      const [style] = (await b.nodes.writeMany([{ type: "Concept", data: { name: "Email", description: "How emails are written", docs: "No greeting.\nSign off as Tom." } }])).map((r) => r.ref_id);
      await b.edges.writeMany([{ edge: "PARENT_OF", source_ref_id: writing, target_ref_id: style! }]);
      assert.deepEqual((await treePages(g, undefined, "Personal")).map((p) => [p.depth, p.name, p.parent, p.docs]), [
        [0, "Personal", undefined, undefined],
        [1, "Writing", personal, undefined],
        [2, "Email", writing, "No greeting.\nSign off as Tom."],
      ]);
      assert.equal((await treePages(g, undefined, "Personal"))[2]!.description, "How emails are written");
      assert.deepEqual((await treePages(g, undefined, "Work")).map((p) => p.name), ["Work", "Reports"]);
      assert.deepEqual(await treePages(g, undefined, "No such tree"), []);
    });

    it("says which pages a run opened, and tells none from not known", async () => {
      assert.equal(await conceptsOpenedBy(g, "r-unknown"), null, "the run is not on the graph");
      const [runRef] = (await b.nodes.writeMany([{ type: "StrutRun", data: { run_id: "r-1", workflow_name: "orchestrator", run_status: "success", started_at: "2026-11-09T10:00:00Z" } }])).map((r) => r.ref_id);
      assert.deepEqual(await conceptsOpenedBy(g, "r-1"), [], "on the graph, and it opened none");
      await b.edges.writeMany([{ edge: "ACCESSED", source_ref_id: runRef!, target_ref_id: writing }]);
      assert.deepEqual(await conceptsOpenedBy(g, "r-1"), ["Writing"]);
    });

    it("through the steps: dream/claim records with the dream's run and its writer, dream/group groups, dream/claims lists a tree with the evidence capped", async () => {
      const made = await run(claimStep, { text: "Do not ask before reading the calendar", about: personal, session: "s", turn: 2, at: "2026-11-09T10:00:00Z", excerpt: "don't ask me that again", outcome: "missing", created_by: "janitor" }, { graph: b });
      assert.deepEqual([made.created, made.recorded], [true, true]);
      await run(claimStep, { claim: made.claim, session: "s", turn: 7, excerpt: "I told you, just read it", outcome: "not_opened" }, { graph: b });
      await run(claimStep, { claim: made.claim, session: "s", turn: 8, excerpt: "thanks, that's right", outcome: "followed" }, { graph: b });
      const other = await run(claimStep, { text: "Do not ask before reading email", about: personal, session: "s", turn: 9, excerpt: "same for email", outcome: "missing" }, { graph: b });
      const group = await run(groupStep, { text: "Read what you are allowed to without asking", about: personal, claims: [made.claim, other.claim] }, { graph: b });
      assert.deepEqual(group.grouped.sort(), [made.claim, other.claim].sort());
      const { claims } = await run(claimsStep, { root: "Personal", evidence: 2 }, { graph: b });
      const mine = claims.find((c: any) => c.id === made.claim);
      assert.deepEqual([mine.corrected, mine.kept, mine.evidence.length, mine.parent], [2, 1, 2, group.claim]);
      assert.equal(mine.evidence[0].dream, "dream-run-1", "the run that found it");
      assert.deepEqual(claims.find((c: any) => c.id === group.claim).corrected, 3);
      assert.deepEqual((await run(claimsStep, { root: "Work" }, { graph: b })).claims, []);
      assert.match(await run(claimStep, { session: "s", turn: 9, excerpt: "x", outcome: "missing" }, { graph: b }), /dream\/claim failed/);
    });

    it("dream/turns stops before reading when the run cannot see the tree: no root page, or a run an app's page launched", async () => {
      const services = { conversations: { all: async () => [], get: async () => null }, dataDir: join(tmpdir(), "strut-dream-none"), graph: b };
      assert.equal((await run(turnsStep, {}, services)).count, 0, "the tree is there: nothing new to read");
      await assert.rejects(run(turnsStep, { tree: "No such tree" }, services), /there is no Concept "No such tree" to tend/);
      if (b.kind !== "ladybug") return;
      // Peel's lists: an app's page reads `shared` alone, and the tree is in `private`.
      const scoped = graphView(b, parseGraphReaders({
        assistant: { workflows: ["orchestrator"], namespaces: ["private", "shared"] }, jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] },
        apps: { namespaces: ["shared"], exclude_domains: ["Strut"] }, peers: { namespaces: ["shared"] }, builder: { namespaces: ["*"] }, ui: { namespaces: ["*"] },
      }));
      const asApp = { ...ctxOf({ ...services, graph: scoped }), app: { name: "strut/dream", version: "v1" } };
      await assert.rejects(turnsStep.run(turnsStep.input.parse({}) as any, asApp as any), /may not read "private".*launched from an app's page.*Run the dream from its automation/);
      assert.equal((await run(turnsStep, {}, { ...services, graph: scoped })).count, 0, "the same lists, as one of strut's own jobs");
    });
  });
}

describe("dream/turns and dream/done", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-dream-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  const t = (turn: number, minsAgo: number, extra: Partial<ConversationTurn> = {}): ConversationTurn => ({
    turn, runId: `r${turn}`, workflow: "orchestrator", at: iso(minsAgo), status: "success", prompt: `said ${turn}`, text: `reply ${turn}`, proposals: [], jobs: [], ...extra,
  });
  /** A stand-in conversation index: newest first, paged like the real one. */
  const index = (all: Record<string, ConversationTurn[]>) => ({
    all: async () => Object.entries(all).map(([id, turns]) => ({ id, title: id, createdAt: turns[0]!.at, updatedAt: turns[turns.length - 1]!.at, turns: turns.length })),
    get: async (q: { session: string; limit?: number; before?: number }) => {
      const turns = [...(all[q.session] ?? [])].filter((x) => q.before === undefined || x.turn < q.before).sort((a, b) => b.turn - a.turn);
      const page = turns.slice(0, 2);
      return { conversation: {}, participants: [], turns: page, rev: 1, ...(turns.length > page.length ? { next: page[page.length - 1]!.turn } : {}) };
    },
  });

  it("hands over the unread turns oldest first with who spoke, skips wakes, waits at a turn in flight, and starts after dream/done's mark", async () => {
    const all = {
      a: [t(0, 50, { by: "tom" }), t(1, 40, { wake: true, prompt: undefined }), t(2, 30, { status: "cancelled" }), t(3, 20), t(4, 5, { status: "running" })],
      b: [t(0, 45)],
    };
    const services = { conversations: index(all), dataDir: dir };
    const first = await run(turnsStep, {}, services);
    assert.deepEqual(first.turns.map((x: any) => `${x.session}${x.turn}`), ["a0", "b0", "a2", "a3"], "by time; the wake and the running turn left out");
    assert.deepEqual([first.turns[0].source, first.turns[0].said_by, first.turns[0].opened], ["conversation", "tom", undefined], "no graph: which pages it opened is not known");
    assert.equal(first.turns[2].status, "cancelled");
    assert.deepEqual(first.cursor, { a: 3, b: 0 });
    assert.match(first.text, /\[session a · turn 0 · [^\]]+ · success · said by tom\]\nPERSON: said 0/);
    assert.match(first.text, /\[session a · turn 2 · .* · cancelled\]\nPERSON: said 2\nASSISTANT: reply 2/);
    assert.equal(first.more, undefined);

    // Not marked yet: a dream that failed reads them again.
    assert.equal((await run(turnsStep, {}, services)).count, 4);
    await run(doneStep, { cursor: first.cursor }, services);
    assert.equal((await run(turnsStep, {}, services)).count, 0, "the running turn still waits");

    all.a[4] = t(4, 5);
    all.a.push(t(5, 1));
    const next = await run(turnsStep, {}, services);
    assert.deepEqual(next.turns.map((x: any) => x.turn), [4, 5]);
    // A mark never moves back.
    await run(doneStep, { cursor: { a: 1 } }, services);
    assert.equal(JSON.parse(await readFile(join(dir, "dream", "personal.json"), "utf-8")).marks.a, 3);
    // Another tree's dream has its own marks: it has read none of them.
    assert.equal((await run(turnsStep, { tree: "Work / Reports" }, services)).count, 6);
    await run(doneStep, { tree: "Work / Reports", cursor: { a: 5 } }, services);
    assert.equal(JSON.parse(await readFile(join(dir, "dream", "work_reports.json"), "utf-8")).marks.a, 5);
  });

  it("a limit leaves the rest for the next dream, and the first dream reads only its window", async () => {
    const all = { a: [t(0, 60 * 24 * 30), t(1, 30), t(2, 20), t(3, 10)] };
    const services = { conversations: index(all), dataDir: dir };
    const first = await run(turnsStep, { limit: 2, days: 14 }, services);
    assert.deepEqual(first.turns.map((x: any) => x.turn), [1, 2], "the month-old turn is outside the first window");
    assert.equal(first.more, true);
    assert.deepEqual(first.cursor, { a: 2 });
    await run(doneStep, { cursor: first.cursor }, services);
    assert.deepEqual((await run(turnsStep, { limit: 2 }, services)).turns.map((x: any) => x.turn), [3]);
  });
});

describe("the shipped dream workflow", () => {
  it("is valid; a tree and review are its input; it reads the turns before the agent, marks them only after it, and reports text, claims, turns and cost", async () => {
    const text = await readFile(join(SYSTEM_DIR, "dream", "workflow.yaml"), "utf-8");
    const v = validateWorkflowYaml(text, { registry: await createRegistry([]) });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));
    const flow = flowFromYaml("dream", "v1", text);
    assert.deepEqual(flow.steps.map((s) => s.type), ["dream/turns", "if", "dream/tree", "agent", "dream/done", "pack", "dream/claims", "dream/tree", "pack"]);
    const cfg = flow.steps[3]!.config as Record<string, unknown>;
    assert.deepEqual(cfg["toolFilter"], ["none"]);
    assert.equal(cfg["model"], undefined);
    // It can record and group claims, read, and change facts and pages. It cannot delete or merge.
    const tools = cfg["agentTools"] as string[];
    assert.ok(["dream/claims", "dream/claim", "dream/group", "graph/assert", "graph/edit-node", "graph/create-triplet", "graph/move-node"].every((x) => tools.includes(x)));
    assert.ok(!tools.some((x) => /delete|merge/.test(x)));
    // Review gates every write to a page or a fact, and nothing else.
    assert.equal(cfg["approve"], "{{ input.review ? params.writes : params.none }}");
    const params = (flow as unknown as { params: Record<string, string[]> }).params;
    assert.deepEqual([...params["writes"]!].sort(), tools.filter((x) => x.startsWith("graph/") && !/get|neighbors|search|find|resolve/.test(x)).sort());
    assert.deepEqual(params["none"], []);
    assert.match(String(cfg["prompt"]), /name "\{\{ input\.root \}\}"/);
    assert.equal(flow.steps[4]!.depends, "dream");
    assert.equal(flow.steps[3]!.depends, "before", "the tree is read before the agent changes it");
    assert.ok(isSystemWorkflow("dream"));
    assert.deepEqual(JSON.parse(await readFile(join(SYSTEM_DIR, "dream", "automation.json"), "utf-8")).trigger, { every: "day", at: ["04:00"] });
  });
});
