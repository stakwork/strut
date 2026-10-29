import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryWrite } from "./_db.js";
import { NO_LADYBUG, memoryWorkspace, type MemoryWorkspace } from "./_test-workspace.js";

// Dictation's vocabulary: the Lingo type, heard_as facts, memory/lexicon and
// memory/attributes, against a real Ladybug workspace graph as memory-steps.test.ts.
const hasLadybug = !NO_LADYBUG;

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("memory: dictation's vocabulary", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  let ws: MemoryWorkspace;
  let ctx: StepContext;
  let run: (type: string, input: unknown) => Promise<any>;
  before(async () => {
    ws = await memoryWorkspace("strut-memory-lexicon-");
    ctx = ws.ctx();
    const { registry } = await buildRegistry();
    run = (type, input) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), ctx);
    };
  });
  after(() => ws.close());

  const stakwork = { type: "Organization", name: "Stakwork" };
  const bitcoin = { type: "Lingo", name: "Bitcoin" };
  const ids: Record<string, string> = {};
  const heard = (subject: object, value: string, form?: string) =>
    run("memory/remember", {
      episode: `Dictation: corrected “${value}”.`, kind: "note", created_by: "dictation",
      facts: [{ subject, predicate: "heard_as", text: `Dictation hears it as “${value}”.`, value, ...(form ? { form } : {}) }],
    });
  const lexicon = async () => (await run("memory/lexicon", {})) as { entities: any[]; undone: any[] };
  const row = async (name: string) => (await lexicon()).entities.find((e) => e.name === name);

  it("seeds Lingo and heard_as, found by their aliases", async () => {
    const o = await run("memory/ontology", {});
    const lingo = o.entity_types.find((t: any) => t.name === "Lingo");
    assert.ok(lingo.aliases.includes("jargon") && lingo.aliases.includes("term"));
    const p = o.predicates.find((t: any) => t.name === "heard_as");
    assert.equal(p.cardinality, "many");
    assert.equal(p.role, "mishearing");
    assert.deepEqual(p.subject_types, ["*"]);
    const out = await run("memory/remember", {
      episode: "LSAT is a word I use.", mentions: [{ type: "acronym", name: "LSAT" }],
      facts: [{ subject: { type: "jargon", name: "LSAT" }, predicate: "misheard_as", text: "Dictation hears LSAT as el sat.", value: "el sat" }],
    });
    assert.equal(out.entities[0].type, "Lingo");
    assert.equal(out.facts[0].predicate, "heard_as");
    assert.deepEqual(out.ontology.resolved.sort(), ["acronym → Lingo", "jargon → Lingo", "misheard_as → heard_as"]);
  });

  it("a heard-as write keeps value and form and never touches aliases", async () => {
    const me = await run("memory/remember", {
      episode: "I work at Stakwork.", facts: [{ subject: { type: "Self", name: "Tom" }, predicate: "works_at", text: "Tom works at Stakwork.", object: stakwork }],
    });
    ids.stakwork = me.entities.find((e: any) => e.name === "Stakwork").ref_id;
    const out = await heard(stakwork, "stack work");
    assert.equal(out.entities[0].ref_id, ids.stakwork);
    assert.equal(out.facts[0].status, "created");
    ids.stackWork = out.facts[0].ref_id;

    await run("memory/remember", {
      episode: "Bitcoin, BTC for short.",
      facts: [{ subject: bitcoin, predicate: "name", text: "Bitcoin is also called BTC.", object: { type: "Lingo", name: "BTC" } }],
    });
    const btc = await heard(bitcoin, "bee tee see", "BTC");
    ids.bitcoin = btc.entities[0].ref_id;
    ids.beeTeeSee = btc.facts[0].ref_id;

    const got = await run("memory/get", { ref_id: ids.bitcoin });
    assert.deepEqual(got.aliases.sort(), ["bitcoin", "btc"], "the name fact's alias only");
    const fact = got.facts.find((f: any) => f.ref_id === ids.beeTeeSee);
    assert.equal(fact.value, "bee tee see");
    assert.equal(fact.form, "BTC");
    assert.deepEqual((await run("memory/get", { ref_id: ids.stakwork })).aliases, ["stakwork"]);
  });

  it("the same mishearing again is the fact already held, whatever its sentence", async () => {
    const again = await run("memory/remember", {
      episode: "Dictation again.", created_by: "dictation",
      facts: [{ subject: stakwork, predicate: "heard_as", text: "Another sentence.", value: "Stack Work" }],
    });
    assert.equal(again.facts[0].status, "existing");
    assert.equal(again.facts[0].ref_id, ids.stackWork);
    // A form that is the subject's name is stored as no form: the same mishearing.
    const named = await heard(stakwork, "stack work", "stakwork");
    assert.equal(named.facts[0].ref_id, ids.stackWork);
  });

  it("refuses a heard-as fact with no value or with an object, and a value on another predicate", async () => {
    const no = await run("memory/remember", { episode: "x", facts: [{ subject: stakwork, predicate: "heard_as", text: "x" }] });
    assert.match(no.error, /^invalid_input: heard_as needs the misheard text as value/);
    const obj = await run("memory/remember", { episode: "x", facts: [{ subject: stakwork, predicate: "heard_as", text: "x", value: "y", object: bitcoin }] });
    assert.match(obj.error, /heard_as takes no object/);
    const other = await run("memory/remember", { episode: "x", facts: [{ subject: stakwork, predicate: "about", text: "x", value: "y" }] });
    assert.match(other.error, /about takes no value or form/);
  });

  it("a misheard text resolves nothing in remember and pairs nothing in duplicates", async () => {
    // "hive" heard for Stakwork: as an alias it would match a Hive and offer the pair.
    await heard(stakwork, "hive");
    const hive = await run("memory/remember", { episode: "Hive is our product.", mentions: [{ type: "Organization", name: "Hive" }] });
    assert.equal(hive.entities[0].status, "created");
    assert.notEqual(hive.entities[0].ref_id, ids.stakwork);
    const misheard = await run("memory/remember", { episode: "stack work", mentions: [{ type: "Organization", name: "stack work" }] });
    assert.equal(misheard.entities[0].status, "created", "the wrong text is not a name of Stakwork");
    const pairs = await run("memory/duplicates", { limit: 100 });
    assert.deepEqual(pairs.filter((p: any) => [p.a.ref_id, p.b.ref_id].includes(ids.stakwork)), []);
    await run("memory/forget", { ref_id: misheard.entities[0].ref_id, reason: "test" });
    await run("memory/forget", { ref_id: hive.entities[0].ref_id, reason: "test" });
  });

  it("memory/lexicon gives each entity's cased written forms, mishearings and ranking inputs", async () => {
    const { entities, undone } = await lexicon();
    assert.deepEqual(undone, []);
    const s = entities.find((e) => e.ref_id === ids.stakwork);
    assert.deepEqual(Object.keys(s).sort(), ["dictation_off", "facts", "heard", "known_by_user", "name", "ref_id", "type", "updated_at", "written"]);
    assert.equal(s.type, "Organization");
    assert.deepEqual(s.written, ["Stakwork"]);
    assert.deepEqual(s.heard.map((h: any) => [h.value, h.form]), [["stack work", null], ["hive", null]]);
    assert.equal(s.heard[0].ref_id, ids.stackWork);
    assert.ok(Date.parse(s.heard[0].created_at));
    assert.equal(s.known_by_user, true);
    assert.equal(s.dictation_off, false);
    assert.equal(s.facts, 3, "works_at and two mishearings");
    assert.ok(Date.parse(s.updated_at));
    const b = entities.find((e) => e.ref_id === ids.bitcoin);
    assert.deepEqual(b.written, ["Bitcoin", "BTC"], "the name fact's value, cased");
    assert.deepEqual(b.heard.map((h: any) => [h.value, h.form]), [["bee tee see", "BTC"]]);
    assert.equal(b.known_by_user, false);
    assert.equal(entities.find((e) => e.user).name, "Tom");
    assert.equal(entities.filter((e) => e.name === "Hive").length, 0, "forgotten entities are left out");
  });

  it("a merged-in name, kept only as a normalised alias, is no written form", async () => {
    const a = await run("memory/remember", { episode: "Kate.", mentions: [{ type: "Person", name: "Kate" }] });
    const b = await run("memory/remember", { episode: "Kate Moss.", mentions: [{ type: "Person", name: "Kate Moss" }] });
    await run("memory/merge", { keep: b.entities[0].ref_id, duplicate: a.entities[0].ref_id });
    assert.deepEqual((await row("Kate Moss")).written, ["Kate Moss"]);
    assert.equal(await row("Kate"), undefined);
  });

  it("an undone mishearing leaves heard and is listed in undone; another forget is not", async () => {
    await run("memory/forget", { ref_id: ids.beeTeeSee, reason: "undone" });
    const hive = (await row("Stakwork")).heard.find((h: any) => h.value === "hive");
    await run("memory/forget", { ref_id: hive.ref_id, reason: "wrong" });
    const { entities, undone } = await lexicon();
    assert.deepEqual(entities.find((e) => e.ref_id === ids.bitcoin).heard, []);
    assert.deepEqual(entities.find((e) => e.ref_id === ids.stakwork).heard.map((h: any) => h.value), ["stack work"]);
    assert.equal(undone.length, 1);
    assert.deepEqual({ ...undone[0], undone_at: undefined }, {
      ref_id: ids.beeTeeSee, value: "bee tee see", form: "BTC", entity: { ref_id: ids.bitcoin, name: "Bitcoin" }, undone_at: undefined,
    });
    assert.ok(Date.parse(undone[0].undone_at));
    // Undoing a learn that made the entity forgets it whole: its mishearings are undone with it.
    const lsat = (await row("LSAT")).ref_id;
    await run("memory/forget", { ref_id: lsat, reason: "undone" });
    assert.deepEqual((await lexicon()).undone.map((u) => [u.value, u.entity.name]), [["bee tee see", "Bitcoin"], ["el sat", "LSAT"]]);
  });

  it("memory/attributes turns an entity off for dictation and back on", async () => {
    const off = await run("memory/attributes", { ref_id: ids.stakwork, set: { dictation: "off", lingo_type: "company_jargon" } });
    assert.deepEqual(off.attributes, { dictation: "off", lingo_type: "company_jargon" });
    assert.equal((await row("Stakwork")).dictation_off, true);
    assert.deepEqual((await run("memory/get", { ref_id: ids.stakwork })).attributes, { dictation: "off", lingo_type: "company_jargon" });
    const on = await run("memory/attributes", { ref_id: ids.stakwork, set: { dictation: null } });
    assert.deepEqual(on.attributes, { lingo_type: "company_jargon" });
    assert.equal((await row("Stakwork")).dictation_off, false);
    assert.match((await run("memory/attributes", { ref_id: "nope", set: { dictation: "off" } })).error, /^not_found/);
  });

  it("a mishearing given on an alias keeps that alias as its form", async () => {
    const out = await heard({ type: "Lingo", name: "BTC" }, "bitsy");
    assert.equal(out.entities[0].ref_id, ids.bitcoin, "found by the alias");
    assert.deepEqual((await row("Bitcoin")).heard.map((h: any) => [h.value, h.form]), [["bitsy", "BTC"]]);
  });

  it("merge keeps what a formless mishearing meant and tidies repeats by text and form, not sentence", async () => {
    const kept = (await heard({ type: "Project", name: "Sphinx" }, "fix")).entities[0].ref_id;
    // Same sentence, another mishearing: both stay.
    await run("memory/remember", {
      episode: "x", facts: [{ subject: { type: "Project", name: "Sphinx" }, predicate: "heard_as", text: "Misheard.", value: "sphincs" }],
    });
    const dup = (await run("memory/remember", {
      episode: "x", facts: [
        { subject: { type: "Project", name: "Sphinx Chat" }, predicate: "heard_as", text: "Misheard.", value: "sphinx chap" },
        { subject: { type: "Project", name: "Sphinx Chat" }, predicate: "heard_as", text: "Another.", value: "Fix", form: "Sphinx" },
      ],
    })).entities[0].ref_id;
    await run("memory/merge", { keep: kept, duplicate: dup });
    // fix (no form: Sphinx) and Fix (form Sphinx) are one mishearing, the newest kept; "sphinx chap" meant Sphinx Chat.
    const heardOf = (await row("Sphinx")).heard.map((h: any) => [h.value, h.form]);
    assert.deepEqual(heardOf.sort(), [["Fix", "Sphinx"], ["sphincs", null], ["sphinx chap", "Sphinx Chat"]]);
  });

  it("attributes that are not a JSON object read as none", async () => {
    const e = (await row("Bitcoin")).ref_id;
    await memoryWrite(ctx, (m) => m.query("MATCH (e:Entity) WHERE e.ref_id = $e SET e.attributes = 'null'", { e }));
    assert.equal((await row("Bitcoin")).dictation_off, false);
    assert.deepEqual((await run("memory/attributes", { ref_id: e, set: { dictation: "off" } })).attributes, { dictation: "off" });
  });
});
