/**
 * The dream (plans/dream.md): lessons on the truth layer of a Ladybug file
 * (`ladybug/lessons.ts`), the steps that write and list them, the step that
 * hands a dream the turns no dream has read, and the shipped workflow.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LadybugBackend } from "./backend.js";
import { testBackends } from "./test-util.js";
import { isLessonId, lessonId, listLessons, recordLesson } from "./ladybug/lessons.js";
import type { ConversationTurn } from "../conversations.js";
import { createRegistry } from "../steps/registry.js";
import { validateWorkflowYaml } from "../validate.js";
import { flowFromYaml } from "../workspace.js";
import { SYSTEM_DIR, isSystemWorkflow } from "../system-workflows.js";
import lessonStep from "../steps/lib/dream/lesson.js";
import lessonsStep from "../steps/lib/dream/lessons.js";
import turnsStep from "../steps/lib/dream/turns.js";
import doneStep from "../steps/lib/dream/done.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const ctxOf = (services: Record<string, unknown>) => ({ runId: "r-1", path: "dream/dream", workflow: "dream", scope: {}, input: undefined, emit: async () => {}, services });
const run = (step: Step, cfg: Record<string, unknown>, services: Record<string, unknown>): Promise<any> => step.run(step.input.parse(cfg), ctxOf(services));

describe("lessons on a ladybug file", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
  });
  const at = Date.parse("2026-11-09T10:00:00Z");
  const turn = (n: number, extra: Record<string, unknown> = {}) => ({ session: "peel/agent-1/dm", turn: n, excerpt: "too long, keep summaries to three lines", strength: -1 as const, observed_at: at + n * 60_000, now: at + n * 60_000, ...extra });

  it("a correction makes a lesson with the turn as evidence; the same turn again writes nothing", async () => {
    const first = await b.tx((tx) => recordLesson(tx, { ...turn(4), text: "Keep summaries to three lines", title: "Summaries too long" }));
    assert.equal(first.lesson, lessonId("Keep summaries to three lines"));
    assert.ok(isLessonId(first.lesson));
    assert.deepEqual([first.created, first.recorded], [true, true]);
    const again = await b.tx((tx) => recordLesson(tx, { ...turn(4), text: "Keep summaries to three lines" }));
    assert.deepEqual([again.created, again.recorded], [false, false]);
    const [l] = await b.tx((tx) => listLessons(tx, undefined));
    assert.equal(l!.title, "Summaries too long");
    assert.equal(l!.text, "Keep summaries to three lines");
    assert.deepEqual([l!.against, l!.for], [1, 0]);
    assert.deepEqual(l!.evidence.map((e) => [e.session, e.turn, e.against]), [["peel/agent-1/dm", 4, true]]);
  });

  it("a second correction lands on the same lesson by id, a confirmation counts for it, and the counts are read, not stored", async () => {
    const { lesson } = await b.tx((tx) => recordLesson(tx, { ...turn(4), text: "Keep summaries to three lines" }));
    await b.tx((tx) => recordLesson(tx, { ...turn(9, { excerpt: "again, too long", why: "an eight-line summary" }), lesson }));
    await b.tx((tx) => recordLesson(tx, { ...turn(12, { excerpt: "yes, exactly like that", strength: 1 as const }), lesson }));
    const lessons = await b.tx((tx) => listLessons(tx, undefined));
    assert.equal(lessons.length, 1);
    assert.deepEqual([lessons[0]!.against, lessons[0]!.for], [2, 1]);
    assert.deepEqual(lessons[0]!.evidence.map((e) => e.turn), [12, 9, 4], "newest first");
    assert.equal(lessons[0]!.evidence[1]!.why, "an eight-line summary");
  });

  it("the most corrected lesson is listed first; an unknown id, or a new lesson with no text, is refused", async () => {
    await b.tx((tx) => recordLesson(tx, { ...turn(1), text: "No greeting in emails to Sam" }));
    const { lesson } = await b.tx((tx) => recordLesson(tx, { ...turn(2), text: "Keep summaries to three lines" }));
    await b.tx((tx) => recordLesson(tx, { ...turn(3), lesson }));
    assert.deepEqual((await b.tx((tx) => listLessons(tx, undefined))).map((l) => l.text), ["Keep summaries to three lines", "No greeting in emails to Sam"]);
    await assert.rejects(b.tx((tx) => recordLesson(tx, { ...turn(5), lesson: "nope" })), /not a lesson id/);
    await assert.rejects(b.tx((tx) => recordLesson(tx, { ...turn(5), lesson: lessonId("never written") })), /pass `text`/);
    await assert.rejects(b.tx((tx) => recordLesson(tx, turn(5))), /needs `text`/);
  });

  it("through the steps: dream/lesson records, stamped with who wrote it; dream/lessons lists with the evidence capped", async () => {
    const made = await run(lessonStep, { text: "Do not ask before reading the calendar", session: "s", turn: 2, at: "2026-11-09T10:00:00Z", excerpt: "don't ask me that again", created_by: "janitor" }, { graph: b });
    assert.deepEqual([made.created, made.recorded], [true, true]);
    await run(lessonStep, { lesson: made.lesson, session: "s", turn: 7, excerpt: "I told you, just read it" }, { graph: b });
    await run(lessonStep, { lesson: made.lesson, session: "s", turn: 8, excerpt: "thanks, that's right", kept: true }, { graph: b });
    const { lessons } = await run(lessonsStep, { evidence: 2 }, { graph: b });
    assert.equal(lessons.length, 1);
    assert.deepEqual([lessons[0].against, lessons[0].for, lessons[0].evidence.length], [2, 1, 2]);
    assert.match(await run(lessonStep, { session: "s", turn: 9, excerpt: "x" }, { graph: b }), /dream\/lesson failed/);
    const [row] = await b.query("MATCH (c:Node {node_type: 'Claim'}) WHERE c.id = $id RETURN c.created_by AS by", { id: made.lesson });
    assert.equal(row!["by"], "janitor");
  });
});

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
    list: async () => ({ conversations: Object.entries(all).map(([id, turns]) => ({ id, title: id, createdAt: turns[0]!.at, updatedAt: turns[turns.length - 1]!.at, turns: turns.length, unread: false })) }),
    get: async (q: { session: string; limit?: number; before?: number }) => {
      const turns = [...(all[q.session] ?? [])].filter((x) => q.before === undefined || x.turn < q.before).sort((a, b) => b.turn - a.turn);
      const page = turns.slice(0, 2);
      return { conversation: {}, participants: [], turns: page, rev: 1, ...(turns.length > page.length ? { next: page[page.length - 1]!.turn } : {}) };
    },
  });

  it("hands over the unread turns oldest first, skips wakes, waits at a turn in flight, and starts after dream/done's mark", async () => {
    const all = {
      a: [t(0, 50), t(1, 40, { wake: true, prompt: undefined }), t(2, 30, { status: "cancelled" }), t(3, 20), t(4, 5, { status: "running" })],
      b: [t(0, 45)],
    };
    const services = { conversations: index(all), dataDir: dir };
    const first = await run(turnsStep, {}, services);
    assert.deepEqual(first.turns.map((x: any) => `${x.session}${x.turn}`), ["a0", "b0", "a2", "a3"], "by time; the wake and the running turn left out");
    assert.equal(first.turns[2].status, "cancelled");
    assert.deepEqual(first.cursor, { a: 3, b: 0 });
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
    assert.equal(JSON.parse(await readFile(join(dir, "dream", "state.json"), "utf-8")).marks.a, 3);
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
  it("is valid, reads the turns before the agent, marks them only after it, and reports text, turns and cost", async () => {
    const text = await readFile(join(SYSTEM_DIR, "dream", "workflow.yaml"), "utf-8");
    const v = validateWorkflowYaml(text, { registry: await createRegistry([]) });
    assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));
    const flow = flowFromYaml("dream", "v1", text);
    assert.deepEqual(flow.steps.map((s) => s.type), ["dream/turns", "if", "agent", "dream/done", "pack", "dream/lessons", "pack"]);
    const agent = flow.steps[2]!;
    const cfg = agent.config as Record<string, unknown>;
    assert.deepEqual(cfg["toolFilter"], ["none"]);
    assert.equal(cfg["model"], undefined);
    // It can record lessons, read, and change facts and pages. It cannot delete or merge.
    const tools = cfg["agentTools"] as string[];
    assert.ok(["dream/lessons", "dream/lesson", "graph/assert", "graph/edit-node", "graph/create-triplet", "graph/move-node"].every((x) => tools.includes(x)));
    assert.ok(!tools.some((x) => /delete|merge/.test(x)));
    assert.equal(flow.steps[3]!.depends, "dream");
    assert.ok(isSystemWorkflow("dream"));
    assert.deepEqual(JSON.parse(await readFile(join(SYSTEM_DIR, "dream", "automation.json"), "utf-8")).trigger, { every: "day", at: ["04:00"] });
  });
});
