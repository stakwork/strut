/**
 * The dream (plans/dream.md): claims about a Concept on every graph
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
import { conceptClaimId, conceptsOpenedBy, groupClaims, listClaims, recordSaid, treeConcepts, type ClaimGraph, type Said } from "./concept-claims.js";
import type { ConversationTurn } from "../conversations.js";
import { createRegistry } from "../steps/registry.js";
import { validateWorkflowYaml } from "../validate.js";
import { flowFromYaml } from "../workspace.js";
import { SYSTEM_DIR, isSystemWorkflow } from "../system-workflows.js";
import claimStep from "../steps/lib/dream/claim.js";
import claimsStep from "../steps/lib/dream/claims.js";
import groupStep from "../steps/lib/dream/group.js";
import turnsStep from "../steps/lib/dream/turns.js";
import candidatesStep from "../steps/lib/dream/candidates.js";
import recordStep from "../steps/lib/dream/record.js";
import neighboursStep from "../steps/lib/dream/neighbours.js";
import dueStep from "../steps/lib/dream/due.js";
import applyStep from "../steps/lib/dream/apply.js";
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

    it("a correction makes a claim about its concept, with the words as evidence that the claim is right and the assistant was wrong; the same words again write nothing", async () => {
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

    it("a tree's claims are those about its concepts; a claim needs a real Concept, and an unknown claim is refused", async () => {
      await recordSaid(g, said(1, { text: "Summaries are three lines or fewer", about: writing }));
      await recordSaid(g, said(2, { text: "Reports open with the result", about: reports, excerpt: "lead with the result" }));
      await recordSaid(g, said(3, { text: "Ask before booking anything", about: personal, excerpt: "ask me first" }));
      assert.deepEqual((await listClaims(g, undefined, "Personal")).map((c) => c.concept).sort(), ["Personal", "Writing"]);
      assert.deepEqual((await listClaims(g, undefined, "Work")).map((c) => c.concept), ["Reports"]);
      assert.deepEqual(await listClaims(g, undefined, "No such tree"), []);
      assert.equal((await listClaims(g, undefined)).length, 3);
      await assert.rejects(recordSaid(g, said(5, { text: "x", about: "not-a-node" })), /is not a Concept/);
      await assert.rejects(recordSaid(g, said(5, { claim: "nope" })), /no claim "nope"/);
      await assert.rejects(recordSaid(g, said(5, { text: "no Concept named" })), /needs `text`.*and `about`/);
    });

    it("reads a tree as it stands: the root first, each Concept under its parent, siblings by name, with its text", async () => {
      const [style] = (await b.nodes.writeMany([{ type: "Concept", data: { name: "Email", description: "How emails are written", docs: "No greeting.\nSign off as Tom." } }])).map((r) => r.ref_id);
      await b.edges.writeMany([{ edge: "PARENT_OF", source_ref_id: writing, target_ref_id: style! }]);
      assert.deepEqual((await treeConcepts(g, undefined, "Personal")).map((p) => [p.depth, p.name, p.parent, p.docs]), [
        [0, "Personal", undefined, undefined],
        [1, "Writing", personal, undefined],
        [2, "Email", writing, "No greeting.\nSign off as Tom."],
      ]);
      assert.equal((await treeConcepts(g, undefined, "Personal"))[2]!.description, "How emails are written");
      assert.deepEqual((await treeConcepts(g, undefined, "Work")).map((p) => p.name), ["Work", "Reports"]);
      assert.deepEqual(await treeConcepts(g, undefined, "No such tree"), []);
    });

    it("says which Concepts a run opened, and tells none from not known", async () => {
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

    it("the stages between the models: candidates for a moment, the sorting written, neighbours, what is due, and one line applied", async () => {
      await b.nodes.update(writing, { set: { docs: "Write plainly.\nNo emoji." }, remove: [] });
      const services = { graph: b };
      const turns = [{ source: "conversation", session: "s", turn: 1, at: "2026-11-09T10:00:00.000Z", status: "success", run: "r1", said: "too long", reply: "ok", opened: ["Writing"] }];
      const moments = [
        { session: "s", turn: 1, excerpt: "too long, keep summaries to three lines", statement: "Summaries are three lines or fewer", kind: "preference", lasting: false },
        { session: "s", turn: 1, excerpt: "Kate lives in Leeds", statement: "Kate lives in Leeds", kind: "fact", lasting: false },
        { session: "nope", turn: 9, excerpt: "x", statement: "an invented turn", kind: "correction", lasting: false },
      ];
      const c = await run(candidatesStep, { moments, turns }, services);
      assert.deepEqual([c.count, c.facts_count], [1, 1], "a fact goes to memory's stage; a moment of no turn is dropped");
      assert.deepEqual(c.items[0].concepts.map((p: any) => [p.name, !!p.opened, !!p.root]), [["Writing", true, false], ["Personal", false, true]], "the Concept it opened, then the root");
      assert.match(c.text, /MOMENT 0 \[session s · turn 1\]\n {2}said: "too long, keep summaries to three lines"/);
      assert.match(c.facts_text, /FACT 0 .*\n {2}said: "Kate lives in Leeds"/);

      const r = await run(recordStep, { items: c.items, decisions: [{ i: 0, text: "Summaries are three lines or fewer", concept: writing, outcome: "missing" }, { i: 7, outcome: "missing" }] }, services);
      assert.deepEqual([r.recorded, r.touched.length, r.skipped.map((x: any) => x.why)], [1, 1, ["no such moment"]]);
      const [claim] = r.touched;
      // The same sentence found again is a candidate, and a claim of another tree's Concept is not written.
      const again = await run(candidatesStep, { moments: [{ ...moments[0], excerpt: "again, too long" }], turns: [{ ...turns[0], turn: 2 }].concat(turns as any).map((t, i) => ({ ...t, turn: i === 0 ? 1 : 1 })) }, services);
      assert.deepEqual(again.items[0].claims.map((x: any) => x.id), [claim]);
      assert.match((await run(recordStep, { items: c.items, decisions: [{ i: 0, claim: "f".repeat(32), outcome: "missing" }] }, services)).skipped[0].why, /no claim .* in this tree/);

      // Once: not due. Said to last, or corrected twice: due, with its Concept as it reads.
      assert.equal((await run(dueStep, {}, services)).count, 0);
      await recordSaid(g, said(3, { claim, session: "s", excerpt: "again, too long", outcome: "not_followed" }));
      const due = await run(dueStep, {}, services);
      assert.deepEqual(due.items.map((d: any) => [d.claim, d.corrected, d.open, d.concept.name]), [[claim, 2, 2, "Writing"]]);
      assert.match(due.text, /its Concept [0-9a-f-]{36} "Writing" reads:\n {4}\| Write plainly\.\n {4}\| No emoji\./);

      const applied = await run(applyStep, {
        items: due.items,
        edits: [
          { claim, action: "replace", concept: writing, old_line: "not on the Concept", new_line: "x" },
          { claim, action: "add", concept: personal, new_line: "on the root" },
          { claim, action: "add", concept: reports, new_line: "on another tree's Concept" },
          { claim: "nope", action: "add", concept: writing, new_line: "x" },
          { claim, action: "add", concept: writing, new_line: "Summaries are three lines or fewer.", first: true },
          { claim, action: "add", concept: writing, new_line: "Summaries are three lines or fewer." },
        ],
      }, services);
      assert.deepEqual(applied.skipped.map((x: any) => x.why), [
        "the line to replace is not on the Concept as written", "the root's own text is left alone", "not a Concept of this tree", "not a claim that is due", "the Concept already says it",
      ]);
      assert.deepEqual(applied.changes.map((x: any) => [x.concept.name, x.kind, x.removed, x.added]), [["Writing", "changed", [], ["Summaries are three lines or fewer."]]]);
      assert.equal((await treeConcepts(g, undefined, "Personal"))[1]!.docs, "Summaries are three lines or fewer.\nWrite plainly.\nNo emoji.", "one line, first; the rest word for word");
      // Fixed: nothing open, so nothing due, until it is corrected again.
      const fixed = (await listClaims(g, undefined, "Personal")).find((x) => x.id === claim)!;
      assert.deepEqual([fixed.open, fixed.fixes.map((f) => f.line), fixed.corrected, fixed.evidence.length], [0, ["Summaries are three lines or fewer."], 2, 2], "a fix is not something said");
      assert.equal((await run(dueStep, {}, services)).count, 0);
      await recordSaid(g, said(0, { claim, session: "s", turn: 9, excerpt: "still too long", outcome: "not_followed", observed_at: Date.now() + 1000 }));
      assert.deepEqual((await run(dueStep, {}, services)).items.map((d: any) => [d.open, d.fixes]), [[1, ["Summaries are three lines or fewer."]]]);

      // Neighbours: claims that share words are offered; a claim under a group is offered as its group.
      const sam = (await recordSaid(g, said(1, { text: "No greeting in emails to Sam", about: writing }))).claim;
      const kate = (await recordSaid(g, said(2, { text: "No greeting in emails to Kate", about: writing }))).claim;
      const near = await run(neighboursStep, { claims: [kate] }, services);
      assert.deepEqual(near.items.map((n: any) => [n.claim.id, n.near.map((o: any) => o.id)]), [[kate, [sam]]]);
      const group = await groupClaims(g, { text: "Emails have no greeting", claims: [sam], at });
      const ann = (await recordSaid(g, said(4, { text: "No greeting in emails to Ann", about: writing }))).claim;
      assert.deepEqual((await run(neighboursStep, { claims: [ann] }, services)).items[0].near.map((o: any) => [o.id, !!o.group]).slice(0, 2).sort(), [[group.claim, true], [kate, false]].sort());
      assert.deepEqual((await groupClaims(g, { parent: group.claim, claims: [ann, kate], at })).grouped.sort(), [ann, kate].sort(), "added to an existing group by its id");
    });

    it("dream/turns stops before reading when the run cannot see the tree: no root concept, or a run an app launched", async () => {
      const services = { conversations: { all: async () => [], get: async () => null }, dataDir: join(tmpdir(), "strut-dream-none"), graph: b };
      assert.equal((await run(turnsStep, {}, services)).count, 0, "the tree is there: nothing new to read");
      await assert.rejects(run(turnsStep, { tree: "No such tree" }, services), /there is no Concept "No such tree" to tend/);
      if (b.kind !== "ladybug") return;
      // Peel's lists: an app reads `shared` alone, and the tree is in `private`.
      const scoped = graphView(b, parseGraphReaders({
        assistant: { workflows: ["orchestrator"], namespaces: ["private", "shared"] }, jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] },
        apps: { namespaces: ["shared"], exclude_domains: ["Strut"] }, peers: { namespaces: ["shared"] }, builder: { namespaces: ["*"] }, ui: { namespaces: ["*"] },
      }));
      const asApp = { ...ctxOf({ ...services, graph: scoped }), app: { name: "strut/dream", version: "v1" } };
      await assert.rejects(turnsStep.run(turnsStep.input.parse({}) as any, asApp as any), /may not read "private".*launched from an app.*Run the dream from its automation/);
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
      const batch = turns.slice(0, 2);
      return { conversation: {}, participants: [], turns: batch, rev: 1, ...(turns.length > batch.length ? { next: batch[batch.length - 1]!.turn } : {}) };
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
    assert.deepEqual([first.turns[0].source, first.turns[0].said_by, first.turns[0].opened], ["conversation", "tom", undefined], "no graph: which Concepts it opened is not known");
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
  it("is valid and staged: a model stage per job, each gated, with code picking, counting and writing between them", async () => {
    const text = await readFile(join(SYSTEM_DIR, "dream", "workflow.yaml"), "utf-8");
    const v = validateWorkflowYaml(text, { registry: await createRegistry([]) });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));
    const flow = flowFromYaml("dream", "v1", text);
    assert.deepEqual(flow.steps.map((s) => `${s.id}:${s.type}`), [
      "turns:dream/turns", "hasTurns:if", "find:agent", "cands:dream/candidates", "hasMoments:if", "match:agent", "record:dream/record",
      "hasFacts:if", "facts:agent", "near:dream/neighbours", "hasNear:if", "group:agent", "grouped:foreach", "due:dream/due", "hasDue:if", "fix:agent",
      "apply:dream/apply", "done:dream/done", "after:dream/claims", "tree:dream/tree", "result:pack",
    ]);
    const step = (id: string) => flow.steps.find((s) => s.id === id)!;
    const cfg = (id: string) => step(id).config as Record<string, any>;
    // The stages that judge read what they are handed and hold no tool: they cannot look further, or write.
    for (const id of ["find", "match", "group", "fix"]) {
      assert.deepEqual([cfg(id)["toolFilter"], cfg(id)["agentTools"], cfg(id)["model"], typeof cfg(id)["schema"]], [["none"], undefined, undefined, "object"], id);
      assert.equal(step(id).when, true, `${id} runs only when there is something for it`);
    }
    // Only the facts stage holds tools: memory's, and no delete or merge. Review gates its one write.
    assert.deepEqual(cfg("facts")["agentTools"], ["graph/resolve", "graph/graph-search", "graph/graph-get", "graph/assert"]);
    assert.equal(cfg("facts")["approve"], "{{ input.review ? params.writes : params.none }}");
    assert.deepEqual((flow as unknown as { params: Record<string, string[]> }).params, { writes: ["graph/assert"], none: [] });
    // A model never reads the whole transcript twice, the claims or the tree: each prompt is its stage's text alone.
    assert.match(cfg("find")["prompt"], /\{\{ turns\.text \}\}/);
    assert.doesNotMatch(cfg("match")["prompt"], /turns\.text/);
    assert.match(cfg("match")["prompt"], /\{\{ cands\.text \}\}/);
    assert.match(cfg("group")["prompt"], /\{\{ near\.text \}\}/);
    assert.match(cfg("fix")["prompt"], /\{\{ due\.text \}\}/);
    assert.match(cfg("find")["prompt"], /always, never, from now on, or remember|said always/i);
    // Marked read only at the end; a tree and review are its input.
    assert.deepEqual(step("done").depends, ["apply", "hasFacts", "facts"]);
    assert.equal(cfg("apply")["review"], "{{ input.review }}");
    assert.equal(cfg("turns")["tree"], "{{ input.root }}");
    assert.ok(isSystemWorkflow("dream"));
    assert.deepEqual(JSON.parse(await readFile(join(SYSTEM_DIR, "dream", "automation.json"), "utf-8")).trigger, { every: "day", at: ["04:00"] });
  });
});
