/**
 * The dream's parts that need no graph: the turns it is handed (with the
 * report of a job that ended kept as context, and the pages each run
 * opened), its marks, the run a judge is shown, and which pages a run's log
 * says it opened. The dream itself runs end to end in
 * `src/graph/dream.test.ts`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "./core.js";
import type { ConversationEntry, ConversationTurn, ConversationView } from "./conversations.js";
import contextRun from "./steps/lib/context/run.js";
import done from "./steps/lib/dream/done.js";
import turns, { renderTurns, type DreamTurn } from "./steps/lib/dream/turns.js";
import { conceptsOpenedIn } from "./verify.js";

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const turn = (n: number, over: Partial<ConversationTurn> = {}): ConversationTurn => ({
  turn: n,
  runId: `17${n}`,
  workflow: "orchestrator",
  at: at(100 - n),
  status: "success",
  prompt: `message ${n}`,
  text: `reply ${n}`,
  proposals: [],
  jobs: [],
  ...over,
});

describe("dream/turns", () => {
  let dir = "";
  let convs: Record<string, ConversationTurn[]>;
  let root: boolean;
  const services = () => ({
    dataDir: dir,
    conversations: {
      all: async (): Promise<ConversationEntry[]> =>
        Object.entries(convs).map(([id, ts]) => ({ id, title: id, createdAt: ts[0]!.at, updatedAt: ts.at(-1)!.at, turns: ts.length })),
      get: async (q: { session: string }): Promise<ConversationView | null> =>
        convs[q.session] ? ({ turns: [...convs[q.session]!].reverse() } as ConversationView) : null,
    },
    knowledge: {
      page: async () => (root ? { name: "Personal" } : null),
      // The pages a run opened, off its log: the job's run opened Planning, a run from before versions says nothing.
      opened: async (workflow: string, run: string) => (run === "171" ? null : workflow === "job" ? ["Job", "Planning"] : ["Personal"]),
    },
  });
  const read = async (cfg: Record<string, unknown> = {}) =>
    (await turns.run(turns.input.parse(cfg), { services: services() } as never)) as { count: number; turns: DreamTurn[]; cursor: Record<string, number>; more?: true; text: string };
  const mark = (cursor: Record<string, number>) => done.run(done.input.parse({ cursor }), { services: services() } as never);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-dream-turns-"));
    root = true;
    convs = {
      "c-1": [
        turn(0, { prompt: "write me a plan for the launch", by: "evan" }),
        // A wake: strut's own turn after the job ended. No person spoke, and it is what the next turn corrects.
        turn(1, { prompt: undefined, wake: { job: "j-1", runId: "900" }, delivered: [{ job: "j-1", runId: "900", workflow: "job", artifacts: [] }], text: "The plan is ready." }),
        turn(2, { prompt: "  no, a plan needs a rollout section  ", by: "evan" }),
        turn(3, { status: "running", prompt: "still going" }),
      ],
    };
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("hands over the turns no dream has read, oldest first: each with its run and the pages it opened, a job's report kept as context, a turn in flight left for later", async () => {
    const r = await read();
    assert.equal(r.count, 3);
    assert.deepEqual(
      r.turns.map((t) => [t.turn, t.workflow, t.run, t.said, t.reply, t.opened, t.said_by, t.jobs]),
      [
        [0, "orchestrator", "170", "write me a plan for the launch", "reply 0", ["Personal"], "evan", undefined],
        [1, "orchestrator", "171", undefined, "The plan is ready.", null, undefined, [{ job: "j-1", workflow: "job", run: "900", opened: ["Job", "Planning"] }]],
        [2, "orchestrator", "172", "no, a plan needs a rollout section", "reply 2", ["Personal"], "evan", undefined],
      ],
    );
    assert.deepEqual(r.cursor, { "c-1": 2 }, "the turn in flight, and what follows it, wait");
    assert.equal(r.more, undefined);
    assert.equal(
      r.text,
      [
        `[session c-1 · turn 0 · ${at(100)} · success · run orchestrator 170 · said by evan]\nOPENED: Personal\nPERSON: write me a plan for the launch\nASSISTANT: reply 0`,
        `[session c-1 · turn 1 · ${at(99)} · success · run orchestrator 171 · after a job ended]\nOPENED: not known\nJOB j-1 (run job 900) OPENED: Job, Planning\nASSISTANT: The plan is ready.`,
        `[session c-1 · turn 2 · ${at(98)} · success · run orchestrator 172 · said by evan]\nOPENED: Personal\nPERSON: no, a plan needs a rollout section\nASSISTANT: reply 2`,
      ].join("\n\n"),
    );
    assert.equal(renderTurns([{ session: "s", turn: 0, at: "t", status: "success", workflow: "w", run: "1", opened: [], said: "hi", reply: "" }]), "[session s · turn 0 · t · success · run w 1]\nOPENED: no Concept page\nPERSON: hi\nASSISTANT: (no reply)");
  });

  it("marks only move when dream/done is called, and only forward: a dream that failed reads the same turns again", async () => {
    const first = await read();
    assert.equal((await read()).count, 3, "nothing marked yet");
    await mark(first.cursor);
    assert.deepEqual([(await read()).count, (await read()).cursor], [0, {}]);
    await mark({ "c-1": 0 });
    assert.equal((await read()).count, 0, "a mark never moves back");
    // The turn in flight ended, and the person said more: the next dream reads from there.
    convs["c-1"]![3]!.status = "success";
    convs["c-1"]!.push(turn(4, { prompt: "thanks" }));
    const next = await read();
    assert.deepEqual([next.turns.map((t) => t.turn), next.cursor], [[3, 4], { "c-1": 4 }]);
    // Each tree keeps its own marks: another tree's dream reads the same conversations from the start.
    assert.equal((await read({ tree: "Job" })).count, 5);
  });

  it("a limit leaves the rest for the next dream; the first dream reads only the last days; no tree, no dream", async () => {
    const capped = await read({ limit: 2 });
    assert.deepEqual([capped.count, capped.more, capped.cursor], [2, true, { "c-1": 1 }]);
    await mark(capped.cursor);
    assert.deepEqual((await read({ limit: 2 })).turns.map((t) => t.turn), [2]);

    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "strut-dream-turns-"));
    convs = { old: [turn(0, { at: new Date(NOW - 30 * 86_400_000).toISOString() }), turn(1, { at: at(5), prompt: "recent" })] };
    const firstEver = await read({ days: 14 });
    assert.deepEqual([firstEver.turns.map((t) => t.said), firstEver.cursor], [["recent"], { old: 1 }], "the mark moves past what the window left out");

    root = false;
    await assert.rejects(read(), /there is no Concept "Personal" to tend/);
    await assert.rejects(() => turns.run(turns.input.parse({}), { services: { dataDir: dir } } as never) as Promise<unknown>, /needs the conversation index/);
  });
});

describe("context/run: a run as a judge reads it", () => {
  const brief = async (cfg: Record<string, unknown>) => ((await contextRun.run(contextRun.input.parse(cfg), undefined as never)) as { text: string }).text;

  it("what it was asked, what it returned and the pages it opened, as text", async () => {
    assert.equal(
      await brief({ input: { prompt: "summarise Monday" }, output: { text: "Three lines." }, concepts: ["Personal", "Writing"] }),
      'WHAT IT WAS ASKED:\n{\n  "prompt": "summarise Monday"\n}\n\nWHAT IT RETURNED:\n{\n  "text": "Three lines."\n}\n\nCONCEPT PAGES IT OPENED: Personal, Writing',
    );
    assert.equal(await brief({ input: "hi", error: { message: "boom", stack: "…" } }), "WHAT IT WAS ASKED:\nhi\n\nIT FAILED WITH:\nboom\n\nCONCEPT PAGES IT OPENED: none");
    assert.equal(await brief({}), "WHAT IT WAS ASKED:\n(nothing)\n\nWHAT IT RETURNED:\n(nothing)\n\nCONCEPT PAGES IT OPENED: none");
  });

  it("a large output never reaches the prompt whole: its head and its tail are kept", async () => {
    const big = `START ${"x".repeat(50_000)} END`;
    const text = await brief({ input: "q", output: big, max: 1000 });
    assert.ok(text.length < 1300, String(text.length));
    assert.match(text, /WHAT IT RETURNED:\nSTART x+\n\[…\d+ characters left out…\]\nx+ END/);
  });
});

describe("conceptsOpenedIn: the pages a run's log says it opened", () => {
  const end = (nodes: RunEvent["nodes"]): RunEvent => ({ ts: "t", runId: "r", path: "wf/s", type: "step.end", nodes });
  const page = (name: string, version?: string, extra: object = {}) => ({ ref_id: `ref-${name}`, node_type: "Concept", name, ...(version ? { version } : {}), ...extra });

  it("by name, first opened first; null when the log cannot say", () => {
    assert.deepEqual(conceptsOpenedIn([end([page("Job", "v1")]), end([page("Planning", "v2"), page("Job", "v3")]), end([{ ref_id: "f", node_type: "Function", name: "main" }])]), ["Job", "Planning"]);
    assert.deepEqual(conceptsOpenedIn([{ ts: "t", runId: "r", path: "wf", type: "run.start" }]), [], "a run that named no Concept opened none");
    assert.deepEqual(conceptsOpenedIn([end([page("Theirs", "v", { peer: "acme" })])]), [], "another strut's page is not this graph's");
    assert.equal(conceptsOpenedIn([]), null, "no such run");
    assert.equal(conceptsOpenedIn([end([page("Job")])]), null, "a run from before reads recorded a version: it says nothing either way");
  });
});
