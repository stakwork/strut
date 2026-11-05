/**
 * Temporal edges and `assert` on a Ladybug file (plans/graph-memory-plan.md
 * step 3, `temporal.ts`): supersede on a one-value slot, re-confirm with a
 * source once, a back-dated assert kept as history, one current edge after
 * two asserts at once, a failed or killed write leaving nothing, plain
 * creation refused on a temporal type, and facts found by word match. Neo4j
 * has no `assert`, which the last suite checks.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openGraphBackend, type GraphBackend, type LadybugBackend } from "./backend.js";
import { GraphValidationError } from "./node-writer.js";
import { createNodeSchema } from "./schema-crud.js";
import { assertEdge, findFacts, type AssertInput } from "./temporal.js";
import { graphSnapshot, testBackends } from "./test-util.js";
import assertStep from "../steps/lib/graph/assert.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const neo4j = testBackends().find((b) => b.kind === "neo4j");

const refused = (code: string, attribute?: string) => (e: unknown) => e instanceof GraphValidationError && e.code === code && (attribute === undefined || e.attribute === attribute);
const DAY = 86_400_000;

/** The temporal types the suites use: one-value LIVES_IN, many-value KNOWS. */
async function temporalOntology(b: GraphBackend): Promise<void> {
  await createNodeSchema(b, b.schemas, { type: "Place", attributes: {}, role: "entity" });
  await b.schemas.createEdgeSchema("Person", "LIVES_IN", "Place", { temporal: true, cardinality: "one" });
  await b.schemas.createEdgeSchema("Person", "KNOWS", "Person", { temporal: true });
}

type Edge = { ref_id: string; target: string; text: string; sources: string[] | null; valid_at: number | null; invalid_at: number | null; expired_at: number | null; superseded_by: string | null; last_confirmed_at: number | null; created_by: string | null; namespace: string | null };

async function edgesOf(b: GraphBackend, edge: string, source: string): Promise<Edge[]> {
  const rows = await b.query(
    `MATCH (s:Node {ref_id: $s})-[r:\`${edge}\`]->(t:Node)
     RETURN r.ref_id AS ref_id, t.ref_id AS target, r.text AS text, r.sources AS sources, r.valid_at AS valid_at, r.invalid_at AS invalid_at,
            r.expired_at AS expired_at, r.superseded_by AS superseded_by, r.last_confirmed_at AS last_confirmed_at, r.created_by AS created_by, r.namespace AS namespace
     ORDER BY r.created_at`,
    { s: source },
  );
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    ref_id: String(r["ref_id"]),
    target: String(r["target"]),
    text: String(r["text"]),
    sources: (r["sources"] as string[] | undefined) ?? null,
    valid_at: n(r["valid_at"]),
    invalid_at: n(r["invalid_at"]),
    expired_at: n(r["expired_at"]),
    superseded_by: (r["superseded_by"] as string | undefined) ?? null,
    last_confirmed_at: n(r["last_confirmed_at"]),
    created_by: (r["created_by"] as string | undefined) ?? null,
    namespace: (r["namespace"] as string | undefined) ?? null,
  }));
}
const current = (es: Edge[]) => es.filter((e) => e.expired_at === null);

describe("assert on a ladybug file (plans/graph-memory-plan.md step 3)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let kate: string, lisbon: string, porto: string, faro: string, sam: string, note: string;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
    await temporalOntology(b);
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
    const [k, l, p, f, s, n] = await b.nodes.writeMany([
      { type: "Person", data: { name: "Kate" } },
      { type: "Place", data: { name: "Lisbon" } },
      { type: "Place", data: { name: "Porto" } },
      { type: "Place", data: { name: "Faro" } },
      { type: "Person", data: { name: "Sam" } },
      { type: "Concept", data: { name: "A chat in September" } },
    ]);
    [kate, lisbon, porto, faro, sam, note] = [k!.ref_id, l!.ref_id, p!.ref_id, f!.ref_id, s!.ref_id, n!.ref_id];
  });
  const lives = (target: string, extra: Partial<AssertInput> = {}): AssertInput => ({ edge: "LIVES_IN", source_ref_id: kate, target_ref_id: target, text: `Kate lives in ${target}`, ...extra });

  it("a temporal type's table has the temporal columns; a plain one does not; a type made temporal gets them", async () => {
    const cols = async (t: string) => new Set((await b.query(`CALL table_info('${t}') RETURN name`)).map((r) => String(r["name"])));
    for (const c of ["text", "sources", "valid_at", "invalid_at", "expired_at", "superseded_by", "last_confirmed_at"]) assert.ok((await cols("LIVES_IN")).has(c), c);
    await b.schemas.createEdgeSchema("Place", "NEAR", "Place");
    assert.ok(!(await cols("NEAR")).has("text"));
    await b.schemas.createEdgeSchema("Place", "NEAR", "Place", { temporal: true });
    assert.ok((await cols("NEAR")).has("text"));
  });

  it("with cardinality one a different target ends the old edge and creates the new one", async () => {
    const first = await assertEdge(b, b.schemas, lives(lisbon, { valid_at: "2024", created_by: "tom" }));
    assert.deepEqual([first.action, first.ended], ["created", false]);
    const moved = await assertEdge(b, b.schemas, lives(porto, { valid_at: "2026-09" }));
    assert.deepEqual([moved.action, moved.superseded], ["superseded", [first.ref_id]]);
    const es = await edgesOf(b, "LIVES_IN", kate);
    assert.deepEqual(current(es).map((e) => e.target), [porto], "one current edge");
    const old = es.find((e) => e.ref_id === first.ref_id)!;
    assert.ok(old.expired_at !== null);
    assert.equal(old.invalid_at, Date.parse("2026-09-01T00:00:00Z"), "it stopped being true when the new one began");
    assert.equal(old.superseded_by, moved.ref_id);
    assert.deepEqual([old.created_by, old.namespace, old.text], ["tom", "private", `Kate lives in ${lisbon}`]);
  });

  it("a failure at any point in the transaction leaves the graph as it was", async () => {
    await assertEdge(b, b.schemas, lives(lisbon, { valid_at: "2024" }));
    const snap = await graphSnapshot(b);
    // The supersede has run (the old edge ended, the new one made) when the caller's transaction fails.
    await assert.rejects(
      b.tx(async (tx) => {
        const r = await assertEdge(b, b.schemas, lives(porto, { valid_at: "2026" }), { tx });
        assert.equal(r.action, "superseded");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(await graphSnapshot(b), snap);
    // A refusal part way (no edge schema for the target's type) writes nothing either.
    await assert.rejects(assertEdge(b, b.schemas, lives(note)), refused("WRONG_TYPE"));
    assert.deepEqual(await graphSnapshot(b), snap);
  });

  it("the same from, type and to re-confirms: the source added once, the same source again changes nothing", async () => {
    const made = await assertEdge(b, b.schemas, lives(lisbon, { source: note }));
    const again = await assertEdge(b, b.schemas, lives(lisbon, { source: "message-2", valid_at: "2023" }));
    assert.deepEqual([again.ref_id, again.action, again.filled], [made.ref_id, "reconfirmed", ["valid_at"]]);
    const [e] = await edgesOf(b, "LIVES_IN", kate);
    assert.deepEqual(e!.sources, [note, "message-2"]);
    assert.equal(e!.valid_at, Date.parse("2023-01-01T00:00:00Z"), "a missing date filled");
    const snap = await graphSnapshot(b);
    const same = await assertEdge(b, b.schemas, lives(lisbon, { source: "message-2" }));
    assert.deepEqual([same.ref_id, same.action], [made.ref_id, "unchanged"]);
    assert.deepEqual(await graphSnapshot(b), snap, "nothing changed, not even last_confirmed_at");
    assert.equal((await edgesOf(b, "LIVES_IN", kate)).length, 1);
  });

  it("a back-dated assert becomes history and leaves the current edge current", async () => {
    const now = await assertEdge(b, b.schemas, lives(porto, { valid_at: "2025-06" }));
    const before = await assertEdge(b, b.schemas, lives(lisbon, { valid_at: "2019" }));
    assert.deepEqual([before.action, before.ended, before.superseded], ["history", true, []]);
    const es = await edgesOf(b, "LIVES_IN", kate);
    assert.deepEqual(current(es).map((e) => e.ref_id), [now.ref_id]);
    const old = es.find((e) => e.ref_id === before.ref_id)!;
    assert.equal(old.invalid_at, Date.parse("2025-06-01T00:00:00Z"), "ended when the current one began");
    // A fact said to be past is recorded as ended, and ends nothing.
    const gone = await assertEdge(b, b.schemas, lives(faro, { valid_at: "2020", invalid_at: "2021" }));
    assert.deepEqual([gone.action, gone.ended], ["created", true]);
    assert.deepEqual(current(await edgesOf(b, "LIVES_IN", kate)).map((e) => e.ref_id), [now.ref_id]);
  });

  it("observed_at: older evidence becomes history and never replaces newer; last_confirmed_at only moves forward", async () => {
    // Kate said Porto on 1 Sep 2026; an old message of hers, from 3 Mar 2025, says Lisbon.
    const porto1 = await assertEdge(b, b.schemas, lives(porto, { valid_at: "2026-09", observed_at: "2026-09-01", source: "msg-porto" }));
    const late = await assertEdge(b, b.schemas, lives(lisbon, { observed_at: "2025-03-03", source: "msg-lisbon" }));
    assert.deepEqual([late.action, late.ended, late.superseded], ["history", true, []]);
    let es = await edgesOf(b, "LIVES_IN", kate);
    assert.deepEqual(current(es).map((e) => e.ref_id), [porto1.ref_id], "Porto stays current");
    const old = es.find((e) => e.ref_id === late.ref_id)!;
    assert.deepEqual([old.last_confirmed_at, old.invalid_at], [Date.parse("2025-03-03"), Date.parse("2026-09-01")], "observed when the message was sent; ended when Porto began");
    assert.equal(es.find((e) => e.ref_id === porto1.ref_id)!.last_confirmed_at, Date.parse("2026-09-01"));
    // Porto again, from an older message: a source more, its last confirmation kept.
    await assertEdge(b, b.schemas, lives(porto, { observed_at: "2026-08-20", source: "msg-older" }));
    es = await edgesOf(b, "LIVES_IN", kate);
    const p = es.find((e) => e.ref_id === porto1.ref_id)!;
    assert.deepEqual([p.sources, p.last_confirmed_at], [["msg-porto", "msg-older"], Date.parse("2026-09-01")]);
    // Newer evidence of a different place replaces it, as before; a time to come is now.
    const faro1 = await assertEdge(b, b.schemas, lives(faro, { observed_at: "2099-01-01" }));
    assert.deepEqual([faro1.action, faro1.superseded], ["superseded", [porto1.ref_id]]);
    const f = (await edgesOf(b, "LIVES_IN", kate)).find((e) => e.ref_id === faro1.ref_id)!;
    assert.ok(f.last_confirmed_at! <= Date.now(), "never confirmed in the future");
    await assert.rejects(assertEdge(b, b.schemas, lives(lisbon, { observed_at: "last spring" })), refused("WRONG_TYPE", "observed_at"));
  });

  it("many-valued: a different target is another current edge; ending a held one by its end date", async () => {
    await assertEdge(b, b.schemas, { edge: "KNOWS", source_ref_id: kate, target_ref_id: sam, text: "Kate knows Sam" });
    await assertEdge(b, b.schemas, { edge: "KNOWS", source_ref_id: kate, target_ref_id: kate, text: "Kate knows herself" });
    assert.equal(current(await edgesOf(b, "KNOWS", kate)).length, 2);
    const end = await assertEdge(b, b.schemas, { edge: "KNOWS", source_ref_id: kate, target_ref_id: sam, text: "Kate knew Sam", invalid_at: Date.now() - DAY });
    assert.deepEqual([end.action, end.ended, end.filled], ["reconfirmed", true, ["invalid_at"]]);
    assert.equal(current(await edgesOf(b, "KNOWS", kate)).length, 1);
  });

  it("two simultaneous asserts on one slot leave exactly one current edge", async () => {
    const [x, y] = await Promise.all([assertEdge(b, b.schemas, lives(lisbon)), assertEdge(b, b.schemas, lives(porto))]);
    const es = await edgesOf(b, "LIVES_IN", kate);
    assert.equal(es.length, 2);
    assert.equal(current(es).length, 1);
    assert.deepEqual(new Set([x.action, y.action]), new Set(["created", "superseded"]), "the writer ran them one after the other");
  });

  it("plain edge creation on a temporal type is refused, and bad input says why", async () => {
    await assert.rejects(b.edges.write({ edge: "LIVES_IN", source_ref_id: kate, target_ref_id: lisbon }), refused("WRONG_TYPE"));
    await assert.rejects(b.edges.write({ edge: "KNOWS", source_ref_id: kate, target_ref_id: sam }), /graph\/assert/);
    await assert.rejects(assertEdge(b, b.schemas, lives(lisbon, { text: " " })), refused("MISSING_REQUIRED", "text"));
    await assert.rejects(assertEdge(b, b.schemas, lives(lisbon, { valid_at: "2026-02-30" })), refused("WRONG_TYPE", "valid_at"));
    await assert.rejects(assertEdge(b, b.schemas, lives(lisbon, { valid_at: "2026", invalid_at: "2025" })), refused("WRONG_TYPE", "invalid_at"));
    // A plain (non-temporal) type is not `assert`'s.
    await b.schemas.createEdgeSchema("Person", "LIKES", "Place");
    await assert.rejects(assertEdge(b, b.schemas, { edge: "LIKES", source_ref_id: kate, target_ref_id: lisbon, text: "Kate likes Lisbon" }), /not a temporal edge type/);
    assert.equal((await edgesOf(b, "LIVES_IN", kate)).length, 0);
  });

  it("a fact is found by word match over its text, current by default and ended ones when asked", async () => {
    await assertEdge(b, b.schemas, { ...lives(lisbon, { valid_at: "2020" }), text: "Kate lives in Lisbon by the river" });
    await assertEdge(b, b.schemas, { ...lives(porto, { valid_at: "2026" }), text: "Kate moved to Porto for the wine" });
    await assertEdge(b, b.schemas, { edge: "KNOWS", source_ref_id: kate, target_ref_id: sam, text: "Kate knows Sam from the river club" });
    const ids = async (q: string, include_ended = false) => (await findFacts(b, { q, include_ended, stop: ["the"] })).map((h) => h.text);
    assert.deepEqual(await ids("river"), ["Kate knows Sam from the river club"], "the ended Lisbon one is left out");
    assert.deepEqual((await ids("river", true)).sort(), ["Kate knows Sam from the river club", "Kate lives in Lisbon by the river"]);
    assert.deepEqual(await ids("Porto wine"), ["Kate moved to Porto for the wine"]);
    const [top] = await findFacts(b, { q: "Kate river club" });
    assert.deepEqual([top!.text, top!.score, top!.edge_type], ["Kate knows Sam from the river club", 3, "KNOWS"], "most words first");
    assert.deepEqual(await findFacts(b, { q: "river", edge_types: ["LIVES_IN"] }), []);
  });

  it("graph/assert: the step writes it with the caller's actor and reports what it did", async () => {
    const ctx = { services: { graph: b }, actor: "tom" } as never;
    const out = (await assertStep.run({ source_ref_id: kate, edge_type: "lives in", target_ref_id: lisbon, text: "Kate lives in Lisbon", valid_at: "2024" } as never, ctx)) as Record<string, unknown>;
    assert.deepEqual([out["status"], out["action"], out["edge_type"]], ["Success", "created", "LIVES_IN"]);
    assert.equal((await edgesOf(b, "LIVES_IN", kate))[0]!.created_by, "tom");
    const again = (await assertStep.run({ source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: lisbon, text: "Kate lives in Lisbon" } as never, ctx)) as Record<string, unknown>;
    assert.equal(again["action"], "reconfirmed");
    assert.match(String(await assertStep.run({ source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: "nope", text: "x" } as never, ctx)), /MISSING_REQUIRED/);
    const read = (await assertStep.run({ source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: porto, text: "Kate lives in Porto", observed_at: "2020-05-01" } as never, ctx)) as Record<string, unknown>;
    assert.equal(read["action"], "history", "an old message read late does not replace what is held");
  });
});

describe("assert: killing the process mid-write (plans/graph-memory-plan.md step 3)", { skip: lb.skip }, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "strut-lbug-kill-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** A child process that opens the file, runs `body` (the backend `b`,
   *  `assertEdge`, `temporalOntology` in scope) and prints its last line.
   *  The parent never opens the file before its children are gone: a closed
   *  handle keeps the file's lock until the process exits. */
  function child(path: string, body: string) {
    const script = `
      import { openGraphBackend } from ${JSON.stringify(fileURLToPath(new URL("./backend.js", import.meta.url)))};
      import { assertEdge } from ${JSON.stringify(fileURLToPath(new URL("./temporal.js", import.meta.url)))};
      import { createNodeSchema } from ${JSON.stringify(fileURLToPath(new URL("./schema-crud.js", import.meta.url)))};
      ${temporalOntology.toString()}
      const b = await openGraphBackend({ kind: "ladybug", path: ${JSON.stringify(path)}, namespace: "private" }, { embeddings: false, skipBoot: true });
      ${body}`;
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err += String(d)));
    const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
    const line = new Promise<string>((resolve, reject) => {
      let out = "";
      proc.stdout.on("data", (d) => {
        out += String(d);
        if (out.includes("\n")) resolve(out.trim());
      });
      void exited.then((code) => reject(new Error(`the child ended (${code}) before it spoke: ${err}`)));
    });
    return { proc, line, exited };
  }

  it("leaves the write in full or not at all after reopening", async () => {
    const path = join(dir, "graph.lbug");
    // Kate lives in Lisbon, committed; the process exits cleanly.
    const setup = child(
      path,
      `await temporalOntology(b);
       const [k, l, p] = await b.nodes.writeMany([{ type: "Person", data: { name: "Kate" } }, { type: "Place", data: { name: "Lisbon" } }, { type: "Place", data: { name: "Porto" } }]);
       const done = await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: k.ref_id, target_ref_id: l.ref_id, text: "Kate lives in Lisbon", valid_at: "2024" });
       await b.close();
       process.stdout.write(JSON.stringify({ kate: k.ref_id, lisbon: l.ref_id, porto: p.ref_id, done: done.ref_id }) + "\\n");`,
    );
    const ids = JSON.parse(await setup.line) as { kate: string; lisbon: string; porto: string; done: string };
    assert.equal(await setup.exited, 0);

    // Porto supersedes it inside a transaction, and the process is killed before the commit.
    const killed = child(
      path,
      `await b.tx(async (tx) => {
         const r = await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: ${JSON.stringify("$KATE")}, target_ref_id: ${JSON.stringify("$PORTO")}, text: "Kate lives in Porto", valid_at: "2026" }, { tx });
         process.stdout.write("inside " + r.action + "\\n");
         await new Promise(() => {});
       });`.replace('"$KATE"', JSON.stringify(ids.kate)).replace('"$PORTO"', JSON.stringify(ids.porto)),
    );
    assert.equal(await killed.line, "inside superseded");
    killed.proc.kill("SIGKILL");
    await killed.exited;

    const b = await openGraphBackend({ kind: "ladybug", path, namespace: "private" }, { embeddings: false, skipBoot: true });
    try {
      const es = await edgesOf(b, "LIVES_IN", ids.kate);
      assert.deepEqual(es.map((e) => [e.ref_id, e.target, e.expired_at, e.superseded_by]), [[ids.done, ids.lisbon, null, null]], "the killed write left nothing; the committed one is whole");
      // Its search row with it: the committed edge has one, live; the killed one none.
      const rows = await b.query(`MATCH (n:Node {node_type: 'EdgeText'}) RETURN n.edge_ref_id AS e, n.expired_at AS x`);
      assert.deepEqual(rows.map((r) => [r["e"], r["x"] ?? null]), [[ids.done, null]]);
    } finally {
      await b.close();
    }
  });
});

describe("assert on Neo4j", { skip: neo4j?.skip ?? "STRUT_TEST_NEO4J_URI not set" }, () => {
  let b: GraphBackend;
  before(async () => {
    b = await neo4j!.open();
    await neo4j!.wipe(b);
  });
  after(async () => {
    await neo4j!.close(b);
  });

  it("is not on this backend, and the graph is left as it was", async () => {
    const w = await b.nodes.write({ type: "StrutWorkflow", data: { name: "harvey-deliver" } });
    await assert.rejects(assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: w.ref_id, target_ref_id: w.ref_id, text: "x" }), /LadybugDB graph only/);
    await assert.rejects(findFacts(b, { q: "x" }), /LadybugDB/);
    const ctx = { services: { graph: b } } as never;
    assert.match(String(await assertStep.run({ source_ref_id: w.ref_id, edge_type: "LIVES_IN", target_ref_id: w.ref_id, text: "x" } as never, ctx)), /LadybugDB graph only/);
  });
});
