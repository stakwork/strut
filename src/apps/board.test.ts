import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut } from "../createStrut.js";
import { hostConfigFromEnv } from "../server.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { kitForTests } from "../test-util/app-kit.js";
import { treeHash } from "../version.js";
import type { KitLocation } from "./kit.js";
import { BOARD_APP, BOARD_DIR, seedBoardApp } from "./board-seed.js";
import { VIEWS_APP } from "./views-seed.js";
import { JAMIE_APP } from "./jamie-seed.js";
import { buildPlan, cardOf, goalOf, HIVE_PLAN, isLive, newCard, openingGoals, progress, stateOf, type RawNode } from "./board/src/lib/plan.js";
import { boundsOf, freeMap, goalMap, homeMap, CARD_W, GROUP_W, NOTE_STEP, NOTE_W, SPAN, TILE_H, TILE_W } from "./board/src/lib/map.js";
import { asksIn, buildBrainstorms, jobsByCard, openByGoal } from "./board/src/lib/brainstorm.js";
import { buildWhy, parseStory, workFor } from "./board/src/lib/why.js";

/**
 * `strut/board`: the plan as a map. The plan it builds from typed nodes and
 * their edges (which type plays which role is data), where the map puts
 * every card, and its seed beside strut/views.
 */

const node = (ref_id: string, properties: Record<string, unknown> = {}): RawNode => ({ ref_id, name: (properties["name"] as string) ?? ref_id, properties });
const edge = (source: string, target: string, edge_type: string) => ({ source, target, edge_type });

// Ship ─┬─ Collect (1, in progress) ─┬─ feeds (done)
//       │                            └─ watch (in progress)
//       └─ Trust   (2)               ─── checks
// Idea (draft, nothing under it)      Gone (soft-deleted)
const plan = () =>
  buildPlan(
    {
      goal: [node("ship", { name: "Ship", status: "ACTIVE", date_added_to_graph: 5 }), node("idea", { name: "Idea", status: "DRAFT", date_added_to_graph: 9 }), node("gone", { status: "ACTIVE", deleted_at: "2026-11-01" })],
      group: [node("trust", { name: "Trust", status: "NOT_STARTED", sequence: 2 }), node("collect", { name: "Collect", status: "IN_PROGRESS", sequence: 1 })],
      work: [node("watch", { name: "Watch", status: "IN_PROGRESS" }), node("feeds", { name: "Feeds", status: "COMPLETED" }), node("checks", { name: "Checks", status: "BACKLOG" })],
    },
    [
      edge("ship", "collect", "HAS_MILESTONE"),
      edge("ship", "trust", "HAS_MILESTONE"),
      edge("collect", "feeds", "HAS_FEATURE"),
      edge("collect", "watch", "HAS_FEATURE"),
      edge("trust", "checks", "HAS_FEATURE"),
      // Not containment, a card that was never read, a deleted parent, a second parent, the wrong way up: none count.
      edge("ship", "checks", "MENTIONS"),
      edge("ship", "nowhere", "HAS_MILESTONE"),
      edge("gone", "trust", "HAS_MILESTONE"),
      edge("trust", "feeds", "HAS_FEATURE"),
      edge("feeds", "ship", "HAS_FEATURE"),
    ],
  );

describe("strut/board: the plan", () => {
  it("a status in the type's own words is one of four states; blocked wins", () => {
    assert.deepEqual(["COMPLETED", "IN_PROGRESS", "ACTIVE", "BACKLOG", "DRAFT", "", "blocked"].map((s) => stateOf(s.toLowerCase())), ["done", "prog", "prog", "idle", "idle", "idle", "block"]);
    assert.equal(stateOf("in_progress", true), "block");
  });

  it("a card: its name, state, order and who wrote it; a soft-deleted node is not live", () => {
    const { props, ...card } = cardOf("group", node("m1", { name: " Collect ", status: "IN_PROGRESS", sequence: 3, created_by_kind: "jamie", date_added_to_graph: 7 }));
    assert.deepEqual(card, { id: "m1", role: "group", title: "Collect", state: "prog", status: "in_progress", seq: 3, at: 7, by: "agent" });
    assert.equal(props["status"], "IN_PROGRESS", "the graph's own words are kept for its details");
    const bare = cardOf("work", { ref_id: "abcdef123456" });
    assert.deepEqual([bare.title, bare.state, bare.status, bare.by], ["abcdef12", "idle", "", null]);
    assert.equal(cardOf("work", node("w", { created_by_kind: "person" })).by, "person");
    assert.equal(isLive({ deleted_at: "2026-11-01" }), false);
    assert.equal(isLive({ is_deleted: true }), false);
    assert.equal(isLive({}), true);
    assert.equal(isLive(undefined), true);
  });

  it("children follow containment edges between live cards, in sequence then by name; a card has one parent", () => {
    const p = plan();
    assert.deepEqual(Object.keys(p.cards).sort(), ["checks", "collect", "feeds", "idea", "ship", "trust", "watch"], "the deleted goal is gone");
    assert.deepEqual(p.kids["ship"], ["collect", "trust"], "by sequence");
    assert.deepEqual(p.kids["collect"], ["feeds", "watch"], "no sequence: by name");
    assert.deepEqual(p.kids["trust"], ["checks"], "feeds keeps its first parent");
    assert.equal(p.parent["feeds"], "collect");
    assert.equal(p.parent["ship"], undefined, "a goal sits under nothing");
  });

  it("goals in progress come first; the board opens on those, or on every goal when none is", () => {
    const p = plan();
    assert.deepEqual(p.goals, ["ship", "idea"]);
    assert.deepEqual(openingGoals(p), ["ship"]);
    const quiet = buildPlan({ goal: [node("a", { status: "DRAFT" }), node("b", { status: "DRAFT" })], group: [], work: [] }, []);
    assert.deepEqual(openingGoals(quiet).sort(), ["a", "b"]);
    // Only a handful: the centre of the map is read at a glance.
    const busy = buildPlan({ goal: Array.from({ length: 9 }, (_, i) => node(`g${i}`, { status: "ACTIVE", date_added_to_graph: i })), group: [], work: [] }, []);
    assert.deepEqual(openingGoals(busy), ["g8", "g7", "g6", "g5", "g4"], "the first five as the plan orders them");
    assert.equal(openingGoals(busy, 3).length, 3);
  });

  it("finds a card's goal and counts what is done under a card", () => {
    const p = plan();
    assert.equal(goalOf(p, "watch"), "ship");
    assert.equal(goalOf(p, "ship"), "ship");
    assert.equal(goalOf(p, "zz"), null);
    assert.deepEqual(progress(p, "collect"), { done: 1, total: 2 });
    assert.deepEqual(progress(p, "idea"), { done: 0, total: 0 });
  });

  it("reads another graph's types when told which play which role", () => {
    const legal = buildPlan(
      { goal: [node("matter")], group: [node("phase")], work: [node("task")] },
      [edge("matter", "phase", "HAS_PHASE"), edge("phase", "task", "HAS_TASK")],
      { goal: "Matter", group: "Phase", work: "Task", contains: ["HAS_PHASE", "HAS_TASK"] },
    );
    assert.deepEqual([legal.kids["matter"], legal.kids["phase"]], [["phase"], ["task"]]);
  });
});

describe("strut/board: the map", () => {
  const overlaps = (boxes: Array<{ x: number; y: number; w: number; h: number }>) => {
    let n = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++;
      }
    }
    return n;
  };

  it("a goal's map: the goal at the gate, its groups along the road in order, each group's work in a plot beside it", () => {
    const p = plan();
    const m = goalMap(p, "ship");
    assert.deepEqual(Object.keys(m.spots).sort(), ["checks", "collect", "feeds", "ship", "trust", "watch"]);
    assert.ok(m.spots["ship"]!.x + CARD_W < m.spots["collect"]!.x, "the goal is left of the first group");
    assert.equal(m.spots["trust"]!.x - m.spots["collect"]!.x, SPAN);
    assert.equal(m.spots["collect"]!.y, m.spots["trust"]!.y, "one road");
    assert.ok(m.spots["feeds"]!.y > m.spots["collect"]!.y, "the first plot is below the road");
    assert.ok(m.spots["checks"]!.y < m.spots["trust"]!.y, "the next is above it");
    // The road: gate → Collect (in progress) → Trust (not started), and a stem to each plot.
    assert.deepEqual(m.roads.map((r) => r.kind), ["prog", "stem", "idle", "stem"]);
    assert.deepEqual(m.plots.map((q) => q.state), ["prog", "idle"]);
    assert.deepEqual(m.rings, []);
    const boxes = Object.entries(m.spots).map(([id, s]) => (p.cards[id]!.role === "work" ? { ...s, w: TILE_W, h: TILE_H } : { ...s, w: p.cards[id]!.role === "goal" ? CARD_W : GROUP_W, h: 100 }));
    assert.equal(overlaps(boxes), 0);
  });

  it("a card added by hand: its own id and first status, its parent's id, and a milestone after the last one", () => {
    const p = buildPlan({ goal: [node("g", { initiative_id: "init-1" })], group: [node("m1", { sequence: 1 }), node("m2", { sequence: 4 })], work: [] }, [edge("g", "m1", "HAS_MILESTONE"), edge("g", "m2", "HAS_MILESTONE")]);
    assert.deepEqual(newCard(HIVE_PLAN, "goal", "New initiative", "id-1"), { name: "New initiative", initiative_id: "id-1", status: "DRAFT" });
    const siblings = p.kids["g"]!.map((k) => p.cards[k]!);
    assert.deepEqual(newCard(HIVE_PLAN, "group", "New milestone", "id-2", { card: p.cards["g"]!, siblings }), { name: "New milestone", milestone_id: "id-2", status: "NOT_STARTED", initiative_id: "init-1", sequence: 5 });
    assert.deepEqual(newCard(HIVE_PLAN, "work", "New feature", "id-3", { card: p.cards["m1"]!, siblings: [] }), { name: "New feature", feature_id: "id-3", status: "BACKLOG" });
  });

  it("a free arrangement starts as the map, keeps a moved card where it was left, and joins each card to what holds it", () => {
    const p = plan();
    const m = goalMap(p, "ship");
    const untouched = freeMap(p, m, {});
    assert.deepEqual(untouched.spots, m.spots, "nothing moved: the map's own places");
    assert.deepEqual([untouched.plots, untouched.rings, untouched.labels], [[], [], []], "the road's drawing is the map's alone");
    const f = freeMap(p, m, { feeds: { x: 900, y: -400 }, gone: { x: 1, y: 1 } });
    assert.deepEqual(f.spots["feeds"], { x: 900, y: -400 });
    assert.equal(f.spots["gone"], undefined, "a card the map no longer shows is not drawn");
    assert.deepEqual(f.spots["trust"], m.spots["trust"]);
    // One line per card under another: two groups under the goal, three pieces of work under them.
    assert.deepEqual(f.roads.map((r) => r.kind).sort(), ["idle", "prog", "stem", "stem", "stem"]);
    const line = f.roads.find((r) => r.b.x === 900 + TILE_W / 2)!;
    assert.equal(line.b.y, -400 + TILE_H / 2, "the line follows the card");
  });

  it("a plot is done only when all its work is; a goal with no groups is its own stop; an unknown goal draws nothing", () => {
    const done = buildPlan({ goal: [node("g")], group: [node("m")], work: [node("a", { status: "COMPLETED" }), node("b", { status: "COMPLETED" })] }, [edge("g", "m", "HAS_MILESTONE"), edge("m", "a", "HAS_FEATURE"), edge("m", "b", "HAS_FEATURE")]);
    assert.deepEqual(goalMap(done, "g").plots.map((q) => q.state), ["done"]);
    const flat = buildPlan({ goal: [node("g")], group: [], work: [node("a"), node("b"), node("c")] }, [edge("g", "a", "HAS_FEATURE"), edge("g", "b", "HAS_FEATURE"), edge("g", "c", "HAS_FEATURE")]);
    const m = goalMap(flat, "g");
    assert.deepEqual(Object.keys(m.spots).sort(), ["a", "b", "c", "g"]);
    assert.deepEqual(m.roads.map((r) => r.kind), ["stem"], "no road to walk, only the stem to its plot");
    assert.deepEqual(goalMap(flat, "zz"), { spots: {}, roads: [], plots: [], rings: [], faded: [], labels: [] });
    assert.equal(boundsOf(goalMap(flat, "zz")), null);
  });

  it("the home map rings the goals round the centre: in progress nearest, with a road in; empty ones faint at the edge; none touching", () => {
    const goals = Array.from({ length: 40 }, (_, i) => node(`g${i}`, { status: i < 5 ? "ACTIVE" : "DRAFT" }));
    const groups = Array.from({ length: 10 }, (_, i) => node(`m${i}`));
    const p = buildPlan({ goal: goals, group: groups, work: [] }, groups.map((m, i) => edge(`g${i + 3}`, m.ref_id, "HAS_MILESTONE")));
    const m = homeMap(p, p.goals);
    assert.equal(Object.keys(m.spots).length, 40);
    assert.equal(m.roads.length, 5, "a road to each goal in progress");
    assert.equal(m.faded.length, 40 - 5 - 8, "goals with nothing under them and not in progress");
    const far = (id: string) => Math.hypot((m.spots[id]!.x + CARD_W / 2) / 1.6, m.spots[id]!.y + 56);
    assert.ok(Math.max(...["g0", "g1", "g2", "g3", "g4"].map(far)) < Math.min(...m.faded.map(far)), "in progress sits inside the empty ones");
    assert.equal(overlaps(Object.values(m.spots).map((s) => ({ ...s, w: CARD_W, h: 130 }))), 0);
    const b = boundsOf(m)!;
    assert.ok(b.x0 < 0 && b.x1 > 0 && b.y0 < 0 && b.y1 > 0, "round the centre");
    // Only what is shown is placed.
    assert.deepEqual(Object.keys(homeMap(p, ["g0", "g1"]).spots).sort(), ["g0", "g1"]);
  });
});

describe("strut/board: brainstorms", () => {
  // About Collect: q1 (open, newest) ─┬─ o1 ── q3 (a follow-up, not a root)
  //                                   └─ o2
  // About Watch:   q2 (decided)       ─┬─ o3 (chosen)
  //                                    └─ o4
  // q4 is about a card the board does not hold; q5 was soft-deleted.
  const brainstorms = () =>
    buildBrainstorms(
      [
        node("q1", { text: "Which feed first?", state: "open", made_by: "user", job: "job-1", date_added_to_graph: 9 }),
        node("q2", { name: "Poll or push?", state: "decided", made_by: "model", job: "job-2", date_added_to_graph: 5 }),
        node("q3", { text: "How often?", state: "open" }),
        node("q4", { text: "Elsewhere", state: "open" }),
        node("q5", { text: "Gone", state: "open", deleted_at: "2026-11-01" }),
      ],
      [node("o1", { text: "OSV", state: "open", made_by: "model" }), node("o2", { text: "NVD", state: "open" }), node("o3", { text: "Poll", state: "chosen" }), node("o4", { text: "Push", state: "open" })],
      [
        edge("q1", "collect", "ABOUT"),
        edge("q2", "watch", "ABOUT"),
        edge("q4", "nowhere", "ABOUT"),
        edge("q5", "collect", "ABOUT"),
        edge("q1", "o1", "PARENT_OF"),
        edge("q1", "o2", "PARENT_OF"),
        edge("o1", "q3", "PARENT_OF"),
        edge("q2", "o3", "PARENT_OF"),
        edge("q2", "o4", "PARENT_OF"),
      ],
      plan(),
    );

  it("a question has its text, who asked, its job, the card it is about and its options; a follow-up is not a root", () => {
    const b = brainstorms();
    assert.deepEqual(Object.keys(b.asks).sort(), ["q1", "q2", "q3", "q4"], "the deleted one is gone");
    assert.deepEqual(b.asks["q1"], { id: "q1", text: "Which feed first?", open: true, by: "person", job: "job-1", at: 9, about: "collect", options: ["o1", "o2"], root: true });
    assert.deepEqual([b.asks["q2"]!.text, b.asks["q2"]!.open, b.asks["q2"]!.by], ["Poll or push?", false, "agent"], "the name stands in for a missing text");
    assert.equal(b.asks["q3"]!.root, false);
    assert.deepEqual(b.choices["o1"]!.asks, ["q3"]);
    assert.equal(b.asks["q4"]!.about, null, "about a card the board does not hold");
  });

  it("once a question is decided, what was not chosen was passed over; an open question's options stay open", () => {
    const b = brainstorms();
    assert.deepEqual([b.choices["o3"]!.state, b.choices["o4"]!.state], ["chosen", "rejected"]);
    assert.deepEqual([b.choices["o1"]!.state, b.choices["o2"]!.state], ["open", "open"]);
  });

  it("a card's root questions, a goal's across everything under it (open first), the open count per goal, and the jobs that tie to a card", () => {
    const b = brainstorms();
    assert.deepEqual(b.byCard, { collect: ["q1"], watch: ["q2"] });
    assert.deepEqual(asksIn(plan(), b, "ship"), ["q1", "q2"]);
    assert.deepEqual(asksIn(plan(), b, "idea"), []);
    assert.deepEqual(openByGoal(plan(), b), { ship: 1 });
    assert.deepEqual(jobsByCard(b), { collect: ["job-1"], watch: ["job-2"] });
  });

  it("a goal's map stacks its brainstorms on a shelf under the gate, clear of the road and its plots", () => {
    const m = goalMap(plan(), "ship", ["q1", "q2"]);
    assert.deepEqual(m.labels.map((l) => l.text), ["Brainstorms · 2"]);
    assert.equal(m.spots["q1"]!.x, m.spots["ship"]!.x, "under the gate");
    assert.equal(m.spots["q2"]!.y - m.spots["q1"]!.y, NOTE_STEP);
    assert.ok(m.spots["q1"]!.y > m.spots["ship"]!.y + 100, "below the goal's card");
    assert.ok(m.spots["q1"]!.x + NOTE_W < Math.min(...m.plots.map((q) => q.x)), "left of every plot");
    assert.deepEqual(goalMap(plan(), "ship").labels, [], "no shelf with nothing on it");
  });
});

describe("strut/board: why — the brief, stories, requirements and what answers them", () => {
  // Ship: brief b1; story s1 (oldest) ─┬─ r1 ← feeds, watch     story s2 (accepted) ─── r3 (nothing answers it)
  //                                    └─ r2 ← feeds
  // s3 belongs to no goal; r4 was soft-deleted; "checks" answers nothing.
  const why = () =>
    buildWhy(
      {
        briefs: [node("b1", { text: " Nobody gets hacked. " }), node("b2", { text: "A second brief loses." })],
        stories: [
          node("s2", { text: "As an owner, I need to see every finding", status: "accepted", date_added_to_graph: 4 }),
          node("s1", { text: "As a user, I want fresh advisories, so that I patch in time.", status: "proposed", date_added_to_graph: 2 }),
          node("s3", { text: "Loose" }),
        ],
        requirements: [
          node("r2", { text: "Feeds are polled hourly", status: "accepted", date_added_to_graph: 6 }),
          node("r1", { text: "Every source is read", status: "proposed", date_added_to_graph: 5 }),
          node("r3", { text: "Findings are ranked", status: "proposed" }),
          node("r4", { text: "Gone", deleted_at: "2026-11-01" }),
        ],
      },
      [
        edge("ship", "b1", "HAS_BRIEF"),
        edge("ship", "b2", "HAS_BRIEF"),
        edge("ship", "s2", "HAS_STORY"),
        edge("ship", "s1", "HAS_STORY"),
        edge("s1", "r1", "HAS_REQUIREMENT"),
        edge("s1", "r2", "HAS_REQUIREMENT"),
        edge("s1", "r4", "HAS_REQUIREMENT"),
        edge("s2", "r3", "HAS_REQUIREMENT"),
        edge("feeds", "r1", "SATISFIES"),
        edge("watch", "r1", "SATISFIES"),
        edge("feeds", "r2", "SATISFIES"),
        // Work the board does not hold, and a requirement that is gone: neither counts.
        edge("nowhere", "r3", "SATISFIES"),
        edge("checks", "r4", "SATISFIES"),
      ],
      plan(),
    );

  it("a goal's brief and its stories in the order written; a story's requirements; who has accepted what", () => {
    const w = why();
    assert.deepEqual(w.brief, { ship: "Nobody gets hacked." }, "the first brief, trimmed");
    assert.deepEqual(w.byGoal, { ship: ["s1", "s2"] });
    assert.deepEqual(w.stories["s1"], { id: "s1", text: "As a user, I want fresh advisories, so that I patch in time.", accepted: false, requirements: ["r1", "r2"] });
    assert.equal(w.stories["s2"]!.accepted, true);
    assert.deepEqual(w.requirements["r2"], { id: "r2", text: "Feeds are polled hourly", accepted: true, story: "s1" });
    assert.equal(w.requirements["r4"], undefined, "soft-deleted");
    assert.equal(w.stories["s3"]!.requirements.length, 0);
  });

  it("the work that answers a requirement, what a piece of work is for, and a story's work across its requirements", () => {
    const w = why();
    assert.deepEqual(w.answers, { r1: ["feeds", "watch"], r2: ["feeds"] }, "r3 has nothing; work the board does not hold is left out");
    assert.deepEqual(w.serves, { feeds: ["r1", "r2"], watch: ["r1"] });
    assert.equal(w.serves["checks"], undefined, "it answers no requirement");
    assert.deepEqual(workFor(w, "s1").sort(), ["feeds", "watch"]);
    assert.deepEqual(workFor(w, "s2"), []);
    assert.deepEqual(workFor(w, "zz"), []);
  });

  it("splits a story into who it is for, what they want and why; anything else is left whole", () => {
    assert.deepEqual(parseStory("As a user, I want fresh advisories, so that I patch in time."), { who: "user", want: "Fresh advisories", why: "I patch in time" });
    assert.deepEqual(parseStory("As an owner, I need to see every finding"), { who: "owner", want: "See every finding", why: null });
    assert.deepEqual(parseStory("As a security owner, when a laptop is compromised, I can see what it unlocks, so I know how to lock it down."), {
      who: "security owner", want: "When a laptop is compromised, I can see what it unlocks", why: "I know how to lock it down",
    });
    assert.equal(parseStory("Findings are ranked by reach"), null);
  });
});

describe("strut/board — seeded at boot beside strut/views", () => {
  let kit: KitLocation;
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const quiet = { serveUi: false, enableChat: false, scheduler: false } as const;
  before(async () => {
    kit = await kitForTests();
  });
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("publishes strut/board with strut/views compiled in, lists it in GET /apps as Board; a reboot is a no-op; `board: false` and `views: false` seed none", async () => {
    const dataDir = await tmp("strut-board-seed-");
    const first = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    const app = await first.apps.get(BOARD_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale], ["v1", "strut", "seed", false]);
    assert.equal(app.hash, await treeHash(BOARD_DIR));
    assert.equal(app.manifest.title, "Board");
    // The page's own reads: the plan and its changes, the viewer's jobs and what waits on them. It writes nothing itself.
    assert.deepEqual(app.manifest.grants.steps.slice(0, 8), ["graph/find", "graph/graph-edges", "graph/changes", "graph/edit-node", "graph/create-node", "graph/create-triplet", "job/list", "proposal/list"]);
    assert.deepEqual(Object.keys(app.manifest.data?.graph?.types ?? {}), ["HiveInitiative", "HiveMilestone", "InitiativeFeature", "Question"], "the types a person edits by hand");
    // The rest is what strut/jamie's thread needs, docked beside the map: exactly Jamie's own grants.
    const jamie = (await first.apps.get(JAMIE_APP))!;
    assert.deepEqual(app.manifest.grants.workflows, jamie.manifest.grants.workflows);
    for (const step of jamie.manifest.grants.steps) assert.ok(app.manifest.grants.steps.includes(step), `${step}: Jamie's thread calls it`);
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    const views = (await first.apps.get(VIEWS_APP))!;
    assert.deepEqual(
      [...info.imports].sort((x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name)),
      [{ name: JAMIE_APP, version: jamie.version, hash: jamie.hash }, { name: VIEWS_APP, version: views.version, hash: views.hash }],
      "strut/jamie's thread and strut/views' graph reads compiled in",
    );
    assert.deepEqual(info.warnings, []);
    const html = await readFile(join(app.dir, "dist", "index.html"), "utf8");
    assert.match(html, /Reading the graph/);
    assert.match(html, /sb-road-prog/, "its own stylesheet is in the page");
    assert.doesNotMatch(html, /SPRINT-AF/, "the views gallery's fixtures stay out");
    assert.ok(info.bytes < 2_000_000, `${info.bytes} bytes`);

    const listed = (await (await first.app.request("/apps")).json()) as { apps: Array<{ name: string; title: string; activeVersion: string; publisher?: string }> };
    const row = listed.apps.find((a) => a.name === BOARD_APP);
    assert.deepEqual(row && [row.title, row.activeVersion, row.publisher], ["Board", "v1", "strut"]);

    const again = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    assert.deepEqual(Object.keys((await again.apps.get(BOARD_APP))!.versions), ["v1"], "no second version");
    assert.deepEqual(await seedBoardApp({ workspace: again.workspace, kit }), { version: "v1", changed: false });

    const off = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-board-off-")), store: new MemoryRunStore(), kit, board: false });
    assert.equal(await off.apps.get(BOARD_APP), null);
    assert.ok(await off.apps.get(VIEWS_APP), "the others still seeded");
    const noViews = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-board-noviews-")), store: new MemoryRunStore(), kit, views: false });
    assert.equal(await noViews.apps.get(BOARD_APP), null, "nothing to build it against");
    const noJamie = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-board-nojamie-")), store: new MemoryRunStore(), kit, jamie: false });
    assert.equal(await noJamie.apps.get(BOARD_APP), null, "no thread to dock");
  });

  it("STRUT_HOST_CONFIG may turn it off, and nothing else", async () => {
    const file = join(await tmp("strut-board-host-"), "host.json");
    await writeFile(file, JSON.stringify({ board: false }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { board: false });
    await writeFile(file, JSON.stringify({ board: true }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"board" must be false/);
  });
});
