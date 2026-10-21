import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry } from "../../registry.js";
import { recommend, resolvePriorities, checkScore, checkRatedOn, normalizeAgainst, PRESETS, type Priorities } from "./_fgc.js";
import setPriorities from "./set-priorities.js";
import rateOption from "./rate-option.js";
import scoreEffect from "./score-effect.js";
import recommendStep from "./recommend.js";

const A = { id: "A", rated: { fast: 0.9, good: 0.2, cheap: 0.8 } };
const B = { id: "B", rated: { fast: 0.6, good: 0.9, cheap: -0.4 } };
const C = { id: "C", rated: { fast: 0.1, good: 0.8, cheap: 0.7 } };
const OPTS = [A, B, C];
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
const totals = (r: ReturnType<typeof recommend>) => Object.fromEntries(r.ranked.map((x) => [x.id, x.total]));

describe("recommend — worked example", () => {
  it("Phase 1 (F1, C1, G0.3): A=1.76, C=1.04, B=0.47 → A", () => {
    const r = recommend({ options: OPTS, priorities: { milestone: { fast: 1, cheap: 1, good: 0.3 } } });
    const t = totals(r);
    near(t.A, 1.76); near(t.C, 1.04); near(t.B, 0.47);
    assert.deepEqual(r.ranked.map((x) => x.id), ["A", "C", "B"]);
    assert.equal(r.recommended, "A");
  });
  it("Phase 3 (G1, C0.8, F0.3): C=1.39, A=1.11, B=0.76 → C", () => {
    const r = recommend({ options: OPTS, priorities: { milestone: { good: 1, cheap: 0.8, fast: 0.3 } } });
    const t = totals(r);
    near(t.C, 1.39); near(t.A, 1.11); near(t.B, 0.76);
    assert.equal(r.recommended, "C");
  });
  it("per-dimension contributions", () => {
    const a = recommend({ options: OPTS, priorities: { milestone: { fast: 1, cheap: 1, good: 0.3 } } }).ranked[0];
    near(a.contributions.fast, 0.9); near(a.contributions.good, 0.06); near(a.contributions.cheap, 0.8);
  });
  it("the presets reproduce the example", () => {
    const p1 = recommend({ options: OPTS, priorities: { initiative: PRESETS.stage1.weights } });
    assert.equal(p1.recommended, "A");
    assert.equal(recommend({ options: OPTS, priorities: { initiative: PRESETS.stage3.weights } }).recommended, "C");
  });
});

describe("recommend — resolution", () => {
  it("nearest PRIORITISES wins per corner (feature > milestone > initiative)", () => {
    const p: Priorities = {
      feature: { fast: 0.2 },
      milestone: { fast: 0.5, cheap: 0.6 },
      initiative: { fast: 0.9, cheap: 0.1, good: 0.4 },
    };
    const r = resolvePriorities(p);
    assert.deepEqual(r.weights, { fast: 0.2, cheap: 0.6, good: 0.4 });
    assert.deepEqual(r.source, { fast: "feature", cheap: "milestone", good: "initiative" });
  });
  it("good_min: nearest edge, else fallback, else -0.5", () => {
    assert.equal(resolvePriorities({ feature: { good: { weight: 1, good_min: 0.1 } }, initiative: { good: { weight: 1, good_min: -0.9 } } }).good_min, 0.1);
    assert.equal(resolvePriorities({}, 0.2).good_min, 0.2);
    assert.equal(resolvePriorities({}).good_min, -0.5);
    assert.equal(resolvePriorities({}).hasPriorities, false);
  });
  it("a Good score below good_min excludes the option (listed last, flagged)", () => {
    const D = { id: "D", rated: { fast: 1, good: -0.8, cheap: 1 } };
    const r = recommend({ options: [...OPTS, D], priorities: { milestone: { fast: 1, cheap: 1, good: 0.3 } } });
    const d = r.ranked.at(-1)!;
    assert.equal(d.id, "D"); assert.equal(d.excluded, true); near(d.total, 1.76);
    assert.equal(r.recommended, "A");
    assert.equal(recommend({ options: [{ id: "E", rated: { good: -0.5 } }], priorities: { milestone: { good: 1 } } }).ranked[0].excluded, false);
  });
  it("a missing weight is 0; no included option → recommended null", () => {
    const r = recommend({ options: OPTS, priorities: { initiative: { fast: 1 } } });
    assert.deepEqual(r.weights, { fast: 1, good: 0, cheap: 0 });
    near(totals(r).A, 0.9);
    assert.equal(recommend({ options: [{ id: "X", rated: { good: -1 } }] }).recommended, null);
  });
  it("'only two of three > 0.5' is a warning, never enforced", () => {
    const r = recommend({ options: [{ id: "all", rated: { fast: 0.9, good: 0.9, cheap: 0.9 } }, A], priorities: { initiative: { fast: 1 } } });
    assert.deepEqual(r.warnings, ["all_three_above_0.5"]);
    assert.deepEqual(r.ranked.find((x) => x.id === "all")!.warnings, ["all_three_above_0.5"]);
    assert.equal(r.recommended, "all");
    assert.deepEqual(recommend({ options: [A] }).warnings, []);
  });
});

describe("validation", () => {
  it("score range; absent allowed", () => {
    assert.equal(checkScore(undefined), null); assert.equal(checkScore(-1), null); assert.equal(checkScore(1), null);
    assert.match(checkScore(1.1)!, /-1\.\.1/); assert.match(checkScore("x")!, /-1\.\.1/);
  });
  it("rated_on", () => {
    assert.equal(checkRatedOn({ fast: 1, good: -1 }), null);
    assert.match(checkRatedOn({ fast: 2 })!, /rated_on\.fast/);
    assert.match(checkRatedOn({ slow: 0 })!, /unknown corner/);
  });
  it("against dedupes and rejects non-lists", () => {
    assert.deepEqual(normalizeAgainst(["a", " a ", "b", ""]).ids, ["a", "b"]);
    assert.ok(normalizeAgainst("a").error);
  });
});

// ── steps over a fake backend ────────────────────────────────────────────────
function fakeBackend(existing: Record<string, string> = {}, requirements: Record<string, string> = {}) {
  const calls = { nodes: [] as any[], edges: [] as any[], updates: [] as any[] };
  const nodes = new Map<string, any>();
  const b: any = {
    reader: {
      resolveNamespace: async (n?: string) => n ?? "default",
      getNodeByKey: async (type: string, key: string) => {
        if (type === "Requirement") return requirements[key] ? { ref_id: requirements[key], node_type: "Requirement" } : null;
        return existing[key] ? { ref_id: existing[key], node_type: type } : null;
      },
      getNode: async (ref: string) => nodes.get(ref) ?? (Object.values(requirements).includes(ref) ? { ref_id: ref, node_type: "Requirement" } : null),
      neighbors: async () => ({ nodes: [], edges: [] }),
    },
    nodes: {
      write: async (n: any) => { calls.nodes.push(n); const ref = `new-${n.type}`; nodes.set(ref, { ref_id: ref, node_type: n.type }); return { ref_id: ref }; },
      update: async (ref: string, u: any) => { calls.updates.push([ref, u]); return {}; },
    },
    edges: { write: async (e: any) => { calls.edges.push(e); return { ref_id: `e${calls.edges.length}`, created: true, source_ref_id: e.source_ref_id, target_ref_id: e.target_ref_id }; } },
    schemas: {},
  };
  return { b, calls };
}
const ctxWith = (b: any) => ({ services: { graph: b } }) as any;

describe("choice/set-priorities", () => {
  it("writes PRIORITISES edges from a preset, creating missing corners, good_min on Good only", async () => {
    const { b, calls } = fakeBackend({ "fast-fast": "F1" });
    const out: any = await setPriorities.run({ scope_ref_id: "M1", preset: "stage1" } as any, ctxWith(b));
    assert.equal(out.status, "Success");
    assert.deepEqual(out.corners_created.sort(), ["Cheap", "Good"]);
    assert.equal(calls.edges.length, 3);
    for (const e of calls.edges) { assert.equal(e.edge, "PRIORITISES"); assert.equal(e.source_ref_id, "M1"); }
    const good = calls.edges.find((e) => e.target_ref_id === "new-Good");
    assert.deepEqual(good.properties, { weight: 0.3, good_min: -0.5 });
    assert.deepEqual(calls.edges.find((e) => e.target_ref_id === "F1").properties, { weight: 1 });
  });
  it("explicit weights override the preset; nothing applied by default", async () => {
    const { b, calls } = fakeBackend();
    assert.match(String(await setPriorities.run({ scope_ref_id: "M1" } as any, ctxWith(b))), /preset or at least one weight/);
    assert.equal(calls.edges.length, 0);
    await setPriorities.run({ scope_ref_id: "M1", preset: "stage3", weights: { good: 0.5 } } as any, ctxWith(b));
    assert.equal(calls.edges.find((e) => e.target_ref_id === "new-Good").properties.weight, 0.5);
  });
  it("range checks", async () => {
    const { b } = fakeBackend();
    assert.match(String(await setPriorities.run({ scope_ref_id: "M", weights: { fast: 1.5 } } as any, ctxWith(b))), /0\.\.1/);
    assert.match(String(await setPriorities.run({ scope_ref_id: "M", weights: { fast: 1 }, good_min: -0.5 } as any, ctxWith(b))), /needs a Good weight/);
    assert.match(String(await setPriorities.run({ scope_ref_id: "M", weights: { good: 1 }, good_min: 3 } as any, ctxWith(b))), /-1\.\.1/);
  });
});

describe("choice/rate-option", () => {
  it("writes Option -RATED_ON{score}-> corner from the Option side", async () => {
    const { b, calls } = fakeBackend({ "good-good": "G1" });
    const out: any = await rateOption.run({ option_ref_id: "O1", rated_on: { good: 0.4, cheap: -1 } } as any, ctxWith(b));
    assert.equal(out.status, "Success");
    assert.deepEqual(calls.edges.map((e) => [e.edge, e.source_ref_id, e.target_ref_id, e.properties.score]), [
      ["RATED_ON", "O1", "G1", 0.4], ["RATED_ON", "O1", "new-Cheap", -1],
    ]);
    assert.deepEqual(calls.nodes.map((n) => n.data), [{ cheap_id: "cheap", name: "Cheap" }]);
  });
  it("rejects out-of-range and empty", async () => {
    const { b, calls } = fakeBackend();
    assert.match(String(await rateOption.run({ option_ref_id: "O", rated_on: { fast: 1.2 } } as any, ctxWith(b))), /rated_on\.fast/);
    assert.match(String(await rateOption.run({ option_ref_id: "O", rated_on: {} } as any, ctxWith(b))), /at least one/);
    assert.equal(calls.edges.length, 0);
  });
});

describe("choice/score-effect", () => {
  it("sets score, links existing Requirements, skips missing ones with a note", async () => {
    const { b, calls } = fakeBackend({}, { "requirement-r1": "R1" });
    const out: any = await scoreEffect.run({ effect_ref_id: "E1", score: -0.7, against: ["r1", "ghost"] } as any, ctxWith(b));
    assert.deepEqual(calls.updates, [["E1", { set: { score: -0.7 }, remove: [] }]]);
    assert.deepEqual(out.linked, ["R1"]); assert.deepEqual(out.skipped, ["ghost"]);
    assert.match(out.note, /ghost/);
    assert.deepEqual(calls.edges.map((e) => [e.edge, e.source_ref_id, e.target_ref_id]), [["AGAINST", "E1", "R1"]]);
  });
  it("score is optional; out of range is refused", async () => {
    const { b, calls } = fakeBackend({}, { "requirement-r1": "R1" });
    await scoreEffect.run({ effect_ref_id: "E1", against: ["r1"] } as any, ctxWith(b));
    assert.equal(calls.updates.length, 0);
    assert.match(String(await scoreEffect.run({ effect_ref_id: "E1", score: 2 } as any, ctxWith(b))), /-1\.\.1/);
  });
});

describe("choice/recommend step", () => {
  it("inline: the worked example", async () => {
    const out: any = await recommendStep.run({ options: OPTS, priorities: { milestone: { good: 1, cheap: 0.8, fast: 0.3 } } } as any, {} as any);
    assert.equal(out.recommended, "C");
  });
  it("reads RATED_ON and PRIORITISES from the graph by ref_id", async () => {
    const { b } = fakeBackend();
    const types: Record<string, string> = { F: "Fast", G: "Good", Ch: "Cheap" };
    b.reader.getNode = async (r: string) => ({ ref_id: r, node_type: types[r] });
    const edge = (target: string, props: any) => ({ source: "x", target, ref_id: "e", edge_type: "X", properties: props });
    b.reader.neighbors = async (ref: string, p: any) => ({
      nodes: [],
      edges: p.edge_types[0] === "PRIORITISES"
        ? [edge("F", { weight: 1 }), edge("Ch", { weight: 1 }), edge("G", { weight: 0.3, good_min: -0.5 })]
        : ref === "oA" ? [edge("F", { score: 0.9 }), edge("G", { score: 0.2 }), edge("Ch", { score: 0.8 })] : [edge("F", { score: 0.6 }), edge("G", { score: 0.9 }), edge("Ch", { score: -0.4 })],
    });
    const out: any = await recommendStep.run({ option_ref_ids: ["oA", "oB"], milestone_ref_id: "M" } as any, ctxWith(b));
    assert.equal(out.recommended, "oA"); near(out.ranked[0].total, 1.76); near(out.ranked[1].total, 0.47);
  });
  it("invalid rated is refused", async () => {
    assert.match(String(await recommendStep.run({ options: [{ id: "a", rated: { fast: 5 } }] } as any, {} as any)), /rated_on\.fast/);
  });
});

describe("registry", () => {
  it("discovers the choice/* lib steps", async () => {
    const { registry, sources } = await buildRegistry();
    for (const t of ["choice/recommend", "choice/set-priorities", "choice/rate-option", "choice/score-effect"]) {
      assert.ok(registry[t], t); assert.equal(sources[t], "lib");
    }
  });
});
