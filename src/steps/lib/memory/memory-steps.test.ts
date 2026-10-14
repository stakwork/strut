import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryDb, memoryWrite } from "./_db.js";
import { invalidate, resolve, vocabulary } from "./_ontology.js";

// Against a real LadybugDB in a temp folder. @ladybugdb/core is an optional
// dependency with a native addon; where it does not load, the suite skips.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("memory/* steps", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-memory-"));
  const ctxWith = (services: unknown) =>
    ({ runId: "test", path: "test", scope: {}, input: undefined, emit: async () => {}, services }) as unknown as StepContext;
  const ctx = ctxWith({ secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "db", "graph.lbug") : undefined) } });
  let run: (type: string, input: unknown, c?: StepContext) => Promise<any>;
  let types: string[];

  before(async () => {
    const { registry } = await buildRegistry();
    types = Object.keys(registry).filter((t) => t.startsWith("memory/"));
    run = (type, input, c = ctx) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const me = { type: "Self", name: "Me" };
  const ids: Record<string, string> = {};

  it("registers the seven steps, and not the shared modules", () => {
    assert.deepEqual(types.sort(), ["memory/duplicates", "memory/forget", "memory/get", "memory/merge", "memory/ontology", "memory/recall", "memory/remember"]);
  });

  it("remember creates Self and the fact, resolving an alias predicate", async () => {
    const out = await run("memory/remember", {
      episode: "My name is Tom.",
      facts: [{ subject: me, predicate: "full_name", text: "The user's name is Tom." }],
    });
    assert.equal(out.entities.length, 1);
    assert.equal(out.entities[0].type, "Self");
    assert.equal(out.entities[0].status, "created");
    assert.equal(out.facts[0].status, "created");
    assert.equal(out.facts[0].predicate, "name");
    assert.deepEqual(out.ontology.resolved, ["full_name → name"]);
    ids.self = out.entities[0].ref_id;
    ids.tom = out.facts[0].ref_id;
    assert.equal((statSync(join(dir, "db")).mode & 0o777), 0o700, "memory folder is owner-only");
  });

  it("a one-value predicate supersedes the current fact", async () => {
    const out = await run("memory/remember", {
      episode: "Actually, call me Thomas.",
      facts: [{ subject: me, predicate: "name", text: "The user's name is Thomas." }],
    });
    assert.equal(out.entities[0].ref_id, ids.self, "the same Self");
    assert.equal(out.entities[0].status, "matched");
    assert.deepEqual(out.facts[0].superseded, [ids.tom]);
    ids.thomas = out.facts[0].ref_id;

    const self = await run("memory/get", { type: "Self" });
    assert.deepEqual(self.facts.map((f: any) => f.text), ["The user's name is Thomas."]);
    const old = await run("memory/get", { ref_id: ids.tom });
    assert.ok(old.expired_at);
    assert.deepEqual(old.superseded_by.map((f: any) => f.ref_id), [ids.thomas]);
  });

  it("recall finds the current fact, and the superseded one only when asked", async () => {
    const hits = await run("memory/recall", { q: "name", type: "Fact" });
    assert.deepEqual(hits.map((h: any) => h.ref_id), [ids.thomas]);
    assert.equal(hits[0].node_type, "Fact");
    const all = await run("memory/recall", { q: "name", type: "Fact", include_expired: true });
    assert.deepEqual(all.map((h: any) => h.ref_id).sort(), [ids.thomas, ids.tom].sort());
  });

  it("an unknown predicate is kept as proposed and listed by memory/ontology", async () => {
    const out = await run("memory/remember", {
      episode: "I play chess with Kate on Sundays.",
      facts: [{ subject: me, predicate: "plays chess with", object: { type: "Person", name: "Kate" }, text: "The user plays chess with Kate." }],
    });
    assert.deepEqual(out.ontology.proposed, ["predicate plays_chess_with"]);
    ids.kate = out.entities.find((e: any) => e.name === "Kate").ref_id;
    ids.chess = out.facts[0].ref_id;

    const ontology = await run("memory/ontology", {});
    const term = ontology.predicates.find((p: any) => p.name === "plays_chess_with");
    assert.equal(term.status, "proposed");
    assert.deepEqual(term.subject_types, ["Self"]);
    assert.deepEqual(term.object_types, ["Person"]);
    assert.equal(term.used, 1);
    assert.equal(ontology.predicates.find((p: any) => p.name === "name").cardinality, "one");
    const active = await run("memory/ontology", { include_proposed: false });
    assert.ok(!active.predicates.some((p: any) => p.name === "plays_chess_with"));
  });

  it("names with no letters or digits are refused, not stored empty", async () => {
    const out = await run("memory/remember", {
      episode: "noise",
      facts: [{ subject: me, predicate: "!!!", text: "Nothing." }, { subject: { type: "???", name: "X" }, predicate: "knows", text: "Nothing." }],
    });
    assert.match(out.error, /^invalid_input: .*type "\?\?\?".*predicate "!!!"/);
    await assert.rejects(async () => run("memory/remember", { episode: "x", mentions: [{ type: "", name: "X" }] }));
    await assert.rejects(async () => run("memory/remember", { episode: "x", facts: [{ subject: me, predicate: "", text: "x" }] }));
    await assert.rejects(resolve(await memoryDb(ctx), "predicate", "--", "test"), /invalid_input/);
    const ontology = await run("memory/ontology", {});
    assert.ok(![...ontology.entity_types, ...ontology.predicates].some((t: any) => !t.name));
    assert.equal((await run("memory/recall", { q: "noise" })).length, 0, "no episode was written");
  });

  it("one entity given by ref_id and by name is listed once", async () => {
    const out = await run("memory/remember", {
      episode: "Kate cooks.",
      mentions: [{ ref_id: ids.kate, type: "Person", name: "Kate" }],
      facts: [{ subject: { type: "Person", name: "kate" }, predicate: "prefers", text: "Kate likes cooking." }],
    });
    assert.deepEqual(out.entities.map((e: any) => e.ref_id), [ids.kate]);
    const kate = await run("memory/get", { ref_id: ids.kate });
    assert.equal(kate.mentioned_in_episodes, 2);
  });

  it("forget soft-deletes a fact, and refuses Self", async () => {
    const out = await run("memory/forget", { ref_id: ids.chess, reason: "the user asked" });
    assert.equal(out.forgotten.node_type, "Fact");
    assert.match((await run("memory/get", { ref_id: ids.chess })).error, /^not_found/);
    const kate = await run("memory/get", { ref_id: ids.kate });
    assert.deepEqual(kate.facts.map((f: any) => f.text), ["Kate likes cooking."]);
    assert.match((await run("memory/forget", { ref_id: ids.self, reason: "test" })).error, /^refused/);
  });

  it("merge repoints the duplicate's facts and leaves it as an alias", async () => {
    const dup = await run("memory/remember", {
      episode: "Katherine lives in Leeds.",
      facts: [{ subject: { type: "Person", name: "Katherine" }, predicate: "lives_in", object: { type: "Place", name: "Leeds" }, text: "Katherine lives in Leeds." }],
    });
    const katherine = dup.entities.find((e: any) => e.name === "Katherine");
    assert.notEqual(katherine.ref_id, ids.kate);
    await run("memory/remember", {
      episode: "Kate knows Katherine.",
      facts: [{ subject: { ref_id: ids.kate, type: "Person", name: "Kate" }, predicate: "knows", object: { ref_id: katherine.ref_id, type: "Person", name: "Katherine" }, text: "Kate knows Katherine." }],
    });

    const out = await run("memory/merge", { keep: ids.kate, duplicate: katherine.ref_id });
    assert.equal(out.moved.subject_of, 1);
    assert.ok(out.aliases.includes("katherine"));

    const via = await run("memory/get", { ref_id: katherine.ref_id });
    assert.equal(via.ref_id, ids.kate);
    assert.equal(via.merged_from, katherine.ref_id);
    assert.deepEqual(via.facts.map((f: any) => f.text).sort(), ["Kate knows Katherine.", "Kate likes cooking.", "Katherine lives in Leeds."]);
    const self = via.facts.find((f: any) => f.predicate === "knows");
    assert.equal(self.role, "subject", "a fact about Kate and herself is listed once, as its subject");
    const byName = await run("memory/get", { type: "Person", name: "Katherine" });
    assert.equal(byName.ref_id, ids.kate);
    ids.katherine = katherine.ref_id;
  });

  it("forget of a merged-away id forgets the entity it was merged into", async () => {
    const out = await run("memory/forget", { ref_id: ids.katherine, reason: "test" });
    assert.equal(out.forgotten.ref_id, ids.kate);
    assert.equal(out.merged_from, ids.katherine);
    assert.equal(out.with_facts, 3);
    assert.match((await run("memory/get", { ref_id: ids.kate })).error, /^not_found/);
  });

  it("without STRUT_MEMORY_DB the graph lives under dataDir/memory", async () => {
    const dataDir = join(dir, "data");
    await run("memory/remember", { episode: "hello", mentions: [me] }, ctxWith({ dataDir }));
    assert.equal(statSync(join(dataDir, "memory")).mode & 0o777, 0o700);
    assert.ok(statSync(join(dataDir, "memory", "graph.lbug")));
  });

  it("with neither STRUT_MEMORY_DB nor a dataDir the steps fail and say so", async () => {
    await assert.rejects(async () => run("memory/recall", { q: "x" }, ctxWith({})), /dataDir.*STRUT_MEMORY_DB/);
  });
});

describe("memory/* speaker and time", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-memory-"));
  const ctx = {
    runId: "test", path: "test", scope: {}, input: undefined, emit: async () => {},
    services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "graph.lbug") : undefined) } },
  } as unknown as StepContext;
  let run: (type: string, input: unknown, c?: StepContext) => Promise<any>;
  before(async () => {
    const { registry } = await buildRegistry();
    run = (type, input, c = ctx) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const me = { type: "Self", name: "Me" };
  const kate = { type: "Person", name: "Kate" };
  const place = (name: string) => ({ type: "Place", name });
  let self: string;

  it("the speaker defaults to the user, made by no one but a fact about them, and mentioned only through one", async () => {
    const first = await run("memory/remember", { episode: "Hello.", mentions: [kate] });
    assert.equal(first.speaker, undefined, "no user entity yet: the speaker stays NULL, which is the user");
    assert.match((await run("memory/get", { type: "Self" })).error, /^not_found/, "no empty user was made");
    const episode = await run("memory/get", { ref_id: first.episode });
    assert.equal(episode.speaker, undefined);
    assert.deepEqual(episode.mentions.map((m: any) => m.ref_id), [first.entities[0].ref_id]);

    const about = await run("memory/remember", {
      episode: "I'm Tom and I like tea.", facts: [{ subject: { type: "Self", name: "Tom" }, predicate: "prefers", text: "The user likes tea." }],
    });
    assert.equal(about.entities[0].name, "Tom", "the user is made from the fact, with its name");
    assert.equal(about.speaker.name, "Tom");
    self = about.speaker.ref_id;
    const mentions = (await run("memory/get", { ref_id: about.episode })).mentions.map((m: any) => m.ref_id);
    assert.deepEqual(mentions, [self]);
    const later = await run("memory/remember", { episode: "Hi again.", mentions: [kate] });
    assert.equal(later.speaker.ref_id, self, "once the user exists, it is the default speaker");
  });

  it("a speaker given as the user is not mentioned; a fact pointing at the user from someone else is flagged", async () => {
    const out = await run("memory/remember", { episode: "Hello Kate.", speaker: me, mentions: [kate] });
    assert.equal(out.speaker.ref_id, self);
    assert.deepEqual((await run("memory/get", { ref_id: out.episode })).mentions.map((m: any) => m.name), ["Kate"]);
    const said = await run("memory/remember", {
      episode: "I owe Tom a book.", speaker: kate,
      facts: [{ subject: kate, predicate: "owes", object: me, text: "Kate owes the user a book." }],
    });
    assert.deepEqual(said.facts[0].about_user_from, { ref_id: said.speaker.ref_id, name: "Kate" });
  });

  it("an episode's speaker and mentions leave out forgotten entities", async () => {
    const zoe = { type: "Person", name: "Zoe" };
    const out = await run("memory/remember", { episode: "Zoe here, with Kate.", speaker: zoe, mentions: [kate] });
    await run("memory/forget", { ref_id: out.speaker.ref_id, reason: "test" });
    const episode = await run("memory/get", { ref_id: out.episode });
    assert.deepEqual(episode.speaker, { forgotten: true });
    assert.deepEqual(episode.mentions.map((m: any) => m.name), ["Kate"]);
  });

  it("Kate's \"I moved to Leeds\" lands on Kate; a fact about the user from Kate is flagged", async () => {
    const out = await run("memory/remember", {
      episode: "I moved to Leeds. Tom owes me a tenner.",
      speaker: kate,
      facts: [
        { subject: kate, predicate: "lives_in", object: place("Leeds"), text: "Kate lives in Leeds." },
        { subject: me, predicate: "owes", object: kate, text: "The user owes Kate a tenner." },
      ],
    });
    const k = out.entities.find((e: any) => e.name === "Kate");
    assert.equal(out.speaker.ref_id, k.ref_id);
    assert.equal(out.facts[0].about_user_from, undefined);
    assert.deepEqual(out.facts[1].about_user_from, { ref_id: k.ref_id, name: "Kate" });
    const fact = await run("memory/get", { ref_id: out.facts[0].ref_id });
    assert.equal(fact.subject.ref_id, k.ref_id);
    assert.equal(fact.valid_at, undefined, "no date in the words, none stored");
    assert.equal((await run("memory/get", { ref_id: out.episode })).speaker.ref_id, k.ref_id);
  });

  it("\"I used to live in London\" then \"I moved to Leeds in September\": London ended with no invented date", async () => {
    const london = await run("memory/remember", {
      episode: "I used to live in London.",
      facts: [{ subject: me, predicate: "lives_in", object: place("London"), text: "The user used to live in London.", ended: true }],
    });
    const leeds = await run("memory/remember", {
      episode: "I moved to Leeds in September.",
      facts: [{ subject: me, predicate: "lives_in", object: place("Leeds"), text: "The user lives in Leeds.", valid_at: "2026-09" }],
    });
    assert.equal(leeds.facts[0].superseded, undefined, "an ended fact is not superseded again");
    const old = await run("memory/get", { ref_id: london.facts[0].ref_id });
    assert.ok(old.expired_at);
    assert.equal(old.invalid_at, undefined);
    assert.equal((await run("memory/get", { ref_id: leeds.facts[0].ref_id })).valid_at, "2026-09-01T00:00:00.000Z");
    const user = await run("memory/get", { type: "Self" });
    const lives = user.facts.filter((f: any) => f.predicate === "lives_in");
    assert.deepEqual(lives.map((f: any) => [f.text, f.since]), [["The user lives in Leeds.", "2026-09-01T00:00:00.000Z"]]);
    const before = user.past.filter((f: any) => f.predicate === "lives_in").map((f: any) => f.text);
    assert.ok(before.includes("The user used to live in London."), "where they lived before comes with the user, as past");
  });

  it("the same fact said again with a date is one fact, two episodes, dated", async () => {
    const jon = { type: "Person", name: "Jon" };
    const first = await run("memory/remember", {
      episode: "Jon plays the cello.", facts: [{ subject: jon, predicate: "plays", text: "Jon plays the cello." }],
    });
    const again = await run("memory/remember", {
      episode: "Jon has played the cello since 2019.", facts: [{ subject: jon, predicate: "plays", text: "Jon plays the cello.", valid_at: "2019" }],
    });
    assert.equal(again.facts[0].ref_id, first.facts[0].ref_id);
    assert.equal(again.facts[0].status, "existing");
    assert.deepEqual(again.facts[0].filled, ["valid_at"]);
    const fact = await run("memory/get", { ref_id: first.facts[0].ref_id });
    assert.equal(fact.episodes.length, 2);
    assert.equal(fact.valid_at, "2019-01-01T00:00:00.000Z");
    const third = await run("memory/remember", {
      episode: "Jon has played since 2020.", facts: [{ subject: jon, predicate: "plays", text: "Jon plays the cello.", valid_at: "2020-05-01" }],
    });
    assert.equal(third.facts[0].filled, undefined, "a known date is never overwritten");
    assert.equal((await run("memory/get", { ref_id: first.facts[0].ref_id })).valid_at, "2019-01-01T00:00:00.000Z");
  });

  it("a supersede ends the old fact when the new one began, and only then", async () => {
    const ann = { type: "Person", name: "Ann" };
    const york = await run("memory/remember", {
      episode: "Ann lives in York.", facts: [{ subject: ann, predicate: "lives_in", object: place("York"), text: "Ann lives in York." }],
    });
    const hull = await run("memory/remember", {
      episode: "Ann lives in Hull now.", facts: [{ subject: ann, predicate: "lives_in", object: place("Hull"), text: "Ann lives in Hull." }],
    });
    assert.deepEqual(hull.facts[0].superseded, [york.facts[0].ref_id]);
    const old = await run("memory/get", { ref_id: york.facts[0].ref_id });
    assert.ok(old.expired_at);
    assert.equal(old.invalid_at, undefined, "no date given, none invented");
    const bath = await run("memory/remember", {
      episode: "Ann moved to Bath on 3 March 2026.",
      facts: [{ subject: ann, predicate: "lives_in", object: place("Bath"), text: "Ann lives in Bath.", valid_at: "2026-03-03" }],
    });
    assert.deepEqual(bath.facts[0].superseded, [hull.facts[0].ref_id]);
    assert.equal((await run("memory/get", { ref_id: hull.facts[0].ref_id })).invalid_at, "2026-03-03T00:00:00.000Z");
  });

  it("a date that is not one is refused before anything is written", async () => {
    for (const valid_at of ["yesterday", "2026-13", "2026-02-30", "26", "", "2026-02-30T10:00Z", "2026-02-30T10:00"]) {
      const out = await run("memory/remember", {
        episode: "Bad date.", facts: [{ subject: { type: "Person", name: "Baddate" }, predicate: "knows", text: "x", valid_at }],
      });
      assert.match(out.error, /^invalid_input: valid_at .* is not a date/, valid_at);
    }
    const out = await run("memory/remember", {
      episode: "Backwards.", facts: [{ subject: me, predicate: "knows", text: "x", valid_at: "2026", invalid_at: "2025" }],
    });
    assert.match(out.error, /^invalid_input: .*ends before it starts/);
    assert.match((await run("memory/get", { type: "Person", name: "Baddate" })).error, /^not_found/);
  });

  it("dates: a time with no offset is UTC, years before 100 and 1970 are dates", async () => {
    const pat = { type: "Person", name: "Pat" };
    const cases: [string, string][] = [
      ["2026-03-03T10:00", "2026-03-03T10:00:00.000Z"],
      ["2026-03-03T10:00+01:00", "2026-03-03T09:00:00.000Z"],
      ["2026-09-01T23:00:00-05:00", "2026-09-02T04:00:00.000Z"],
      ["2026-09-01T00:30:00+01:00", "2026-08-31T23:30:00.000Z"],
      ["0050", "0050-01-01T00:00:00.000Z"],
      ["0099-12", "0099-12-01T00:00:00.000Z"],
      ["1970-01-01", "1970-01-01T00:00:00.000Z"],
    ];
    for (const [i, [valid_at, want]] of cases.entries()) {
      const out = await run("memory/remember", { episode: "Dated.", facts: [{ subject: pat, predicate: "knows", text: `Pat ${i}.`, valid_at }] });
      assert.equal((await run("memory/get", { ref_id: out.facts[0].ref_id })).valid_at, want, valid_at);
    }
    const zero = await run("memory/remember", {
      episode: "Epoch.", facts: [{ subject: pat, predicate: "knows", text: "Pat epoch.", valid_at: "1970-01-01", invalid_at: "1960" }],
    });
    assert.match(zero.error, /ends before it starts/, "an epoch-0 start is still compared");
  });

  it("an end that has passed makes a fact past: it replaces nothing, and said of a held fact it ends it", async () => {
    const bo = { type: "Person", name: "Bo" };
    const hull = await run("memory/remember", { episode: "Bo lives in Hull.", facts: [{ subject: bo, predicate: "lives_in", object: place("Hull"), text: "Bo lives in Hull." }] });
    const york = await run("memory/remember", {
      episode: "Bo lived in York from 2018 to 2020.",
      facts: [{ subject: bo, predicate: "lives_in", object: place("York"), text: "Bo lived in York.", valid_at: "2018", invalid_at: "2020" }],
    });
    assert.equal(york.facts[0].superseded, undefined);
    assert.equal(york.facts[0].ended, true);
    assert.ok((await run("memory/get", { ref_id: york.facts[0].ref_id })).expired_at);
    assert.equal((await run("memory/get", { ref_id: hull.facts[0].ref_id })).expired_at, undefined, "Hull is still held");

    const until = await run("memory/remember", {
      episode: "Bo lived in Hull until 2025.",
      facts: [{ subject: bo, predicate: "lives_in", object: place("Hull"), text: "Bo lives in Hull.", invalid_at: "2025" }],
    });
    assert.deepEqual([until.facts[0].ref_id, until.facts[0].status, until.facts[0].filled, until.facts[0].ended], [hull.facts[0].ref_id, "existing", ["invalid_at"], true]);
    const ended = await run("memory/get", { ref_id: hull.facts[0].ref_id });
    assert.ok(ended.expired_at);
    assert.equal(ended.invalid_at, "2025-01-01T00:00:00.000Z");
  });

  it("ended for a fact held now ends that fact instead of storing a second copy", async () => {
    const cy = { type: "Person", name: "Cy" };
    const held = await run("memory/remember", { episode: "Cy plays golf.", facts: [{ subject: cy, predicate: "plays", object: { type: "Topic", name: "Golf" }, text: "Cy plays golf." }] });
    const out = await run("memory/remember", {
      episode: "Cy stopped playing golf in 2025.",
      facts: [{ subject: cy, predicate: "plays", object: { type: "Topic", name: "Golf" }, text: "Cy plays golf.", ended: true, invalid_at: "2025-06" }],
    });
    assert.deepEqual([out.facts[0].ref_id, out.facts[0].status, out.facts[0].ended], [held.facts[0].ref_id, "existing", true]);
    const fact = await run("memory/get", { ref_id: held.facts[0].ref_id });
    assert.ok(fact.expired_at);
    assert.equal(fact.invalid_at, "2025-06-01T00:00:00.000Z");
    assert.equal(fact.episodes.length, 2);
    const all = await run("memory/recall", { q: "Cy golf", type: "Fact", include_expired: true });
    assert.equal(all.length, 1, "one fact, not an expired copy");
  });

  it("a current fact that began before the one held is history: it ends when that began and replaces nothing", async () => {
    const di = { type: "Person", name: "Di" };
    const leeds = await run("memory/remember", {
      episode: "Di moved to Leeds in 2025.", facts: [{ subject: di, predicate: "lives_in", object: place("Leeds"), text: "Di lives in Leeds.", valid_at: "2025" }],
    });
    const york = await run("memory/remember", {
      episode: "Di lived in York from 2019.", facts: [{ subject: di, predicate: "lives_in", object: place("York"), text: "Di lives in York.", valid_at: "2019" }],
    });
    assert.equal(york.facts[0].superseded, undefined);
    assert.equal(york.facts[0].ended, true);
    const old = await run("memory/get", { ref_id: york.facts[0].ref_id });
    assert.equal(old.invalid_at, "2025-01-01T00:00:00.000Z");
    assert.ok(old.expired_at);
    const now = await run("memory/get", { ref_id: leeds.facts[0].ref_id });
    assert.equal(now.expired_at, undefined);
    assert.equal(now.invalid_at, undefined);

    // A fill that would start a fact after it ended is skipped.
    const club = await run("memory/remember", {
      episode: "Di is in the club until 2030.", facts: [{ subject: di, predicate: "member_of", text: "Di is in the club.", invalid_at: "2030" }],
    });
    const again = await run("memory/remember", {
      episode: "Di joined the club in 2031.", facts: [{ subject: di, predicate: "member_of", text: "Di is in the club.", valid_at: "2031" }],
    });
    assert.equal(again.facts[0].ref_id, club.facts[0].ref_id);
    assert.equal(again.facts[0].filled, undefined);
    assert.equal((await run("memory/get", { ref_id: club.facts[0].ref_id })).valid_at, undefined);
  });

  it("merge keeps the value that began later, never one that has ended, and never ends a fact before it began", async () => {
    const eve = await run("memory/remember", {
      episode: "Eve moved to Leeds in 2026.", facts: [{ subject: { type: "Person", name: "Eve" }, predicate: "lives_in", object: place("Leeds"), text: "Eve lives in Leeds.", valid_at: "2026-01" }],
    });
    const evie = await run("memory/remember", {
      episode: "Evie lives in York since 2020.", facts: [{ subject: { type: "Person", name: "Evie" }, predicate: "lives_in", object: place("York"), text: "Evie lives in York.", valid_at: "2020" }],
    });
    const eveId = eve.entities.find((e: any) => e.name === "Eve").ref_id;
    const evieId = evie.entities.find((e: any) => e.name === "Evie").ref_id;
    // Learned last, with an end that has since passed and nothing that expired it.
    const now = Date.now();
    await (await memoryDb(ctx))(
      `MATCH (s:Entity) WHERE s.ref_id = $s
       CREATE (:Fact {ref_id: 'lapsed', predicate: 'lives_in', text: 'Evie lives in Bath.', valid_at: $t, invalid_at: $t, created_at: $now})-[:SUBJECT]->(s)`,
      { s: evieId, t: now - 1000, now },
    );
    const out = await run("memory/merge", { keep: eveId, duplicate: evieId });
    assert.deepEqual(out.superseded, [evie.facts[0].ref_id], "Leeds began after York, though York was learned last");
    const york = await run("memory/get", { ref_id: evie.facts[0].ref_id });
    assert.ok(york.expired_at);
    assert.equal(york.invalid_at, "2026-01-01T00:00:00.000Z", "York ended when Leeds began");
    assert.equal((await run("memory/get", { ref_id: "lapsed" })).expired_at, undefined, "an ended fact is never a winner or a loser");
  });

  it("merge with no dates to compare keeps the value memory learned last", async () => {
    const a = await run("memory/remember", { episode: "Al lives in Hull.", facts: [{ subject: { type: "Person", name: "Al" }, predicate: "lives_in", object: place("Hull"), text: "Al lives in Hull." }] });
    const b = await run("memory/remember", { episode: "Alan lives in Ely.", facts: [{ subject: { type: "Person", name: "Alan" }, predicate: "lives_in", object: place("Ely"), text: "Alan lives in Ely." }] });
    const out = await run("memory/merge", { keep: a.entities[0].ref_id, duplicate: b.entities[0].ref_id });
    assert.deepEqual(out.superseded, [a.facts[0].ref_id]);
  });

  it("ending a held fact with no end given drops an end still to come", async () => {
    const lease = { subject: { type: "Person", name: "Lou" }, predicate: "rents", text: "Lou rents the flat." };
    await run("memory/remember", { episode: "Lou rents the flat until 2030.", facts: [{ ...lease, invalid_at: "2030" }] });
    const ended = await run("memory/remember", { episode: "Lou moved out.", facts: [{ ...lease, ended: true }] });
    const fact = await run("memory/get", { ref_id: ended.facts[0].ref_id });
    assert.ok(fact.expired_at);
    assert.equal(fact.invalid_at, undefined);
  });

  it("history given an end after the held fact began ends when that began", async () => {
    const mo = { type: "Person", name: "Mo" };
    await run("memory/remember", { episode: "Mo lives in Paris since 2026.", facts: [{ subject: mo, predicate: "lives_in", object: place("Paris"), text: "Mo lives in Paris.", valid_at: "2026-01" }] });
    const berlin = await run("memory/remember", {
      episode: "Mo lived in Berlin 2025 to 2028.",
      facts: [{ subject: mo, predicate: "lives_in", object: place("Berlin"), text: "Mo lived in Berlin.", valid_at: "2025", invalid_at: "2028" }],
    });
    assert.equal((await run("memory/get", { ref_id: berlin.facts[0].ref_id })).invalid_at, "2026-01-01T00:00:00.000Z");
  });

  it("a name given as an object is another name for the subject, not a person of its own", async () => {
    const out = await run("memory/remember", {
      episode: "My name is Sam.",
      facts: [{ subject: { type: "Person", name: "Sammy" }, predicate: "name", object: { type: "Person", name: "Sam Ray" }, text: "Sammy's name is Sam Ray." }],
    });
    assert.deepEqual(out.entities.map((e: any) => e.name), ["Sammy"], "no entity for the name itself");
    const sammy = await run("memory/get", { type: "Person", name: "Sam Ray" });
    assert.equal(sammy.name, "Sammy", "the name finds the entity it names");
  });

  it("forgetting a name fact takes its name back, unless another name fact still gives it", async () => {
    const pip = { type: "Person", name: "Pip" };
    const named = (text: string, name: string) =>
      run("memory/remember", { episode: text, facts: [{ subject: pip, predicate: "name", object: { type: "Person", name }, text }] });
    const finds = async (name: string) => (await run("memory/get", { type: "Person", name })).name;
    const a = await named("Pip's name is Philippa.", "Philippa");
    const b = await named("Pip is called Philippa.", "Philippa");
    const c = await named("Pip goes by Pippa now.", "Pippa");
    assert.deepEqual(c.facts[0].superseded, [b.facts[0].ref_id]);
    assert.equal(await finds("Philippa"), "Pip", "a replaced name still finds them");
    await run("memory/forget", { ref_id: a.facts[0].ref_id, reason: "test" });
    assert.equal(await finds("Philippa"), "Pip", "another name fact still gives it");
    await run("memory/forget", { ref_id: b.facts[0].ref_id, reason: "test" });
    assert.match((await run("memory/get", { type: "Person", name: "Philippa" })).error, /^not_found/);
    assert.equal(await finds("Pippa"), "Pip");
    assert.equal(await finds("Pip"), "Pip", "its own name is never taken back");
  });

  it("a name another entity of a related type goes by is not an alias, and that one is similar", async () => {
    const bea = await run("memory/remember", { episode: "Bea.", mentions: [{ type: "Person", name: "Bea" }] });
    const out = await run("memory/remember", {
      episode: "Kit is called Bea too.",
      facts: [{ subject: { type: "Person", name: "Kit" }, predicate: "name", object: { type: "Person", name: "Bea" }, text: "Kit's name is Bea." }],
    });
    assert.deepEqual(out.facts[0].similar, [{ ref_id: bea.entities[0].ref_id, name: "Bea" }]);
    const kit = await run("memory/get", { type: "Person", name: "Kit" });
    assert.deepEqual(kit.aliases, ["kit"]);
    assert.equal(kit.facts[0].object, undefined, "a name is never linked to another entity");
  });

  it("a friend may go by the user's name: sharing it with the user is no duplicate", async () => {
    const out = await run("memory/remember", {
      episode: "My mate Thomas goes by Tom.",
      facts: [{ subject: { type: "Person", name: "Thomas" }, predicate: "name", object: { type: "Person", name: "Tom", ref_id: "made-up" }, text: "Thomas goes by Tom." }],
    });
    assert.equal(out.facts[0].similar, undefined);
    assert.deepEqual(out.entities.map((e: any) => e.name), ["Thomas"], "a name with a ref_id is still no entity");
    const thomas = await run("memory/get", { type: "Person", name: "Thomas" });
    assert.ok(thomas.aliases.includes("tom"));
    assert.equal(thomas.facts[0].value, "Tom");
  });

  it("the user takes a name a friend also has, and the fact stays the user's", async () => {
    const friend = await run("memory/remember", { episode: "Ali is a friend.", mentions: [{ type: "Person", name: "Ali" }] });
    const out = await run("memory/remember", {
      episode: "Call me Ali.", facts: [{ subject: me, predicate: "name", object: { type: "Person", name: "Ali" }, text: "The user goes by Ali." }],
    });
    assert.equal(out.facts[0].similar, undefined);
    assert.ok((await run("memory/get", { user: true })).aliases.includes("ali"));
    const ali = await run("memory/get", { ref_id: friend.entities[0].ref_id });
    assert.deepEqual(ali.facts, [], "nothing about the user lands on the friend");
  });

  it("forgetting a name fact keeps a name a merge brought", async () => {
    const pat = await run("memory/remember", {
      episode: "Pat is called Patty.", facts: [{ subject: { type: "Person", name: "Pat" }, predicate: "name", object: { type: "Person", name: "Patty" }, text: "Pat is called Patty." }],
    });
    const patty = await run("memory/remember", { episode: "Patty Lu.", mentions: [{ type: "Person", name: "Patty Lu" }] });
    const keep = pat.entities[0].ref_id;
    await run("memory/merge", { keep, duplicate: patty.entities[0].ref_id });
    await run("memory/forget", { ref_id: pat.facts[0].ref_id, reason: "test" });
    assert.match((await run("memory/get", { type: "Person", name: "Patty" })).error, /^not_found/);
    assert.equal((await run("memory/get", { type: "Person", name: "Patty Lu" })).ref_id, keep, "the merged-in name still finds them");
  });

  it("a name for the user from someone else is never an alias of the user", async () => {
    const out = await run("memory/remember", {
      episode: "Tom's real name is Tomasz.", speaker: kate,
      facts: [{ subject: me, predicate: "name", object: { type: "Person", name: "Tomasz" }, text: "The user's name is Tomasz." }],
    });
    assert.ok(out.facts[0].about_user_from);
    assert.ok(!(await run("memory/get", { user: true })).aliases.includes("tomasz"));
  });

  it("a name both mentioned and given as a name makes no entity of its own", async () => {
    const bo = { type: "Person", name: "Bo" };
    const out = await run("memory/remember", {
      episode: "Bo, or Bobby.", mentions: [bo, { type: "Person", name: "Bobby" }],
      facts: [{ subject: bo, predicate: "name", object: { type: "Person", name: "Bobby" }, text: "Bo is called Bobby." }],
    });
    assert.deepEqual(out.entities.map((e: any) => e.name), ["Bo"]);
    assert.equal((await run("memory/get", { type: "Person", name: "Bobby" })).name, "Bo");
  });

  it("a supersede brings an end still to come forward: to when the new one began, else to now", async () => {
    const cy = { type: "Person", name: "Cy" };
    const lives = (name: string, dates: object) => run("memory/remember", {
      episode: `Cy lives in ${name}.`, facts: [{ subject: cy, predicate: "lives_in", object: place(name), text: `Cy lives in ${name}.`, ...dates }],
    });
    const oslo = await lives("Oslo", { invalid_at: "2099" });
    const rome = await lives("Rome", { valid_at: "2026-02" });
    assert.deepEqual(rome.facts[0].superseded, [oslo.facts[0].ref_id]);
    assert.equal((await run("memory/get", { ref_id: oslo.facts[0].ref_id })).invalid_at, "2026-02-01T00:00:00.000Z");
    const lima = await lives("Lima", { invalid_at: "2098" });
    const before = Date.now();
    await lives("Nice", {});
    const end = Date.parse((await run("memory/get", { ref_id: lima.facts[0].ref_id })).invalid_at);
    assert.ok(end >= before && end <= Date.now(), "ended now");
  });

  it("a past fact the entity is the object of comes with it under past", async () => {
    await run("memory/remember", {
      episode: "Dee used to live in Derby.",
      facts: [{ subject: { type: "Person", name: "Dee" }, predicate: "lives_in", object: place("Derby"), text: "Dee used to live in Derby.", ended: true }],
    });
    const derby = await run("memory/get", { type: "Place", name: "Derby" });
    assert.deepEqual(derby.facts, []);
    assert.deepEqual(derby.past.map((f: any) => [f.text, f.role, f.subject, f.until]), [["Dee used to live in Derby.", "object", "Dee", undefined]]);
  });

  it("opening a database written before world time clears record time stored as world time", async () => {
    const path = join(dir, "old", "graph.lbug");
    mkdirSync(dirname(path), { recursive: true });
    const lbug = await import("@ladybugdb/core");
    const db = new lbug.Database(path);
    const conn = new lbug.Connection(db);
    await conn.query(`CREATE NODE TABLE Fact(ref_id STRING PRIMARY KEY, predicate STRING, text STRING, confidence DOUBLE,
      valid_at INT64, invalid_at INT64, expired_at INT64, created_by STRING, created_at INT64, updated_at INT64, deleted_at INT64)`);
    await conn.query(`CREATE (:Fact {ref_id: 'held', valid_at: 100, created_at: 100}),
      (:Fact {ref_id: 'replaced', valid_at: 100, created_at: 100, invalid_at: 200, expired_at: 200}),
      (:Fact {ref_id: 'dated', valid_at: 50, created_at: 100, invalid_at: 150, expired_at: 200})`);
    await conn.close();
    await db.close();
    const old = { ...ctx, services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? path : undefined) } } } as unknown as StepContext;
    const rows = await (await memoryDb(old))("MATCH (f:Fact) RETURN f.ref_id AS id, f.valid_at AS valid, f.invalid_at AS invalid ORDER BY f.ref_id");
    assert.deepEqual(rows.map((r) => [r.id, r.valid, r.invalid]), [["dated", 50, 150], ["held", null, null], ["replaced", null, null]]);
  });

  it("a transaction that caught a failed statement still writes nothing", async () => {
    await assert.rejects(memoryWrite(ctx, async (query) => {
      await query("THIS IS NOT CYPHER").catch(() => undefined);
      await query("CREATE (:Entity {ref_id: 'caught', type: 'Person', name: 'Caught', aliases: []})");
      return "done";
    }));
    assert.equal((await (await memoryDb(ctx))("MATCH (e:Entity) WHERE e.ref_id = 'caught' RETURN e.ref_id AS id")).length, 0);
  });

  it("a remember that fails part-way leaves nothing behind, not even a type it proposed", async () => {
    // A damaged ontology row (a predicate with no name) makes remember throw
    // when it looks up a new predicate: after it has written the episode, the
    // entity and its proposed type, and reloaded the vocabulary inside the
    // transaction.
    const query = await memoryDb(ctx);
    await query(
      `CREATE (:Ontology {key: 'predicate:', kind: 'predicate', description: '', status: 'proposed',
               cardinality: 'many', subject_types: [], object_types: [], aliases: []})`,
    );
    invalidate(query);
    await assert.rejects(run("memory/remember", {
      episode: "Zed is a gizmo.", mentions: [{ type: "Person", name: "Zed" }],
      facts: [{ subject: { type: "Gizmo", name: "Zed" }, predicate: "frobs", text: "Zed frobs." }],
    }));
    assert.equal((await query("MATCH (o:Ontology) WHERE o.name = 'Gizmo' RETURN o.key AS key")).length, 0);
    // Read without invalidating first: the vocabulary memoryWrite left behind.
    assert.equal((await vocabulary(query)).term("entity_type", "Gizmo"), undefined);
    await query("MATCH (o:Ontology) WHERE o.key = 'predicate:' DELETE o");
    invalidate(query);
    assert.match((await run("memory/get", { type: "Person", name: "Zed" })).error, /^not_found/);
    assert.equal((await run("memory/recall", { q: "Zed" })).length, 0);
    const ok = await run("memory/remember", { episode: "Still writable.", mentions: [{ type: "Person", name: "Zed" }] });
    assert.equal(ok.entities[0].status, "created");
  });

  it("with no user type there is no default speaker and nothing is flagged as about the user", async () => {
    const other = {
      ...ctx,
      services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "nouser", "graph.lbug") : undefined) } },
    } as unknown as StepContext;
    const query = await memoryDb(other);
    await query("MATCH (o:Ontology) WHERE o.role = 'user' SET o.role = ''");
    invalidate(query);
    const out = await run("memory/remember", { episode: "Hello.", mentions: [kate] }, other);
    assert.equal(out.speaker, undefined);
    assert.equal((await run("memory/get", { ref_id: out.episode }, other)).speaker, undefined);
    assert.equal((await query("MATCH (e:Entity) WHERE e.type = 'Self' RETURN e.ref_id AS id")).length, 0);
    const said = await run("memory/remember", {
      episode: "Tom owes me a tenner.", speaker: kate,
      facts: [{ subject: me, predicate: "owes", object: kate, text: "Me owes Kate a tenner." }],
    }, other);
    assert.equal(said.facts[0].about_user_from, undefined);
  });
});

describe("memory/duplicates and merge's created_by", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-memory-dups-"));
  const ctx = ({
    runId: "test", path: "test", scope: {}, input: undefined, emit: async () => {},
    services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "graph.lbug") : undefined) } },
  }) as unknown as StepContext;
  let run: (type: string, input: unknown) => Promise<any>;
  before(async () => {
    const { registry } = await buildRegistry();
    run = (type, input) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), ctx);
    };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const person = (name: string) => ({ type: "Person", name });
  const pairOf = (p: any) => [p.a.name, p.b.name].sort().join(" + ");

  it("offers the user saved as a Person, and Kate beside Katie Moss; not unrelated names", async () => {
    // The name kept on the fact (its object), not read from the sentence.
    await run("memory/remember", { episode: "I'm Tom Smith.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", object: { type: "Person", name: "Tom Smith" }, text: "I'm Tom Smith." }] });
    await run("memory/remember", { episode: "Tom Smith and Tom wrote the doc.", mentions: [person("Tom Smith"), person("Tom")] });
    await run("memory/remember", {
      episode: "My sister Kate lives in Leeds.",
      facts: [{ subject: person("Kate"), predicate: "lives_in", object: { type: "Place", name: "Leeds" }, text: "Kate lives in Leeds." }],
    });
    await run("memory/remember", {
      episode: "Katie Moss lives in Leeds.",
      facts: [{ subject: person("Katie Moss"), predicate: "lives_in", object: { type: "Place", name: "Leeds" }, text: "Katie Moss lives in Leeds." }],
    });
    await run("memory/remember", { episode: "Kate Brown and Bob Lee called.", mentions: [person("Katie Brown"), person("Bob Lee"), person("Robert Lee")] });
    await run("memory/remember", { episode: "Mercury the planet.", mentions: [{ type: "Topic", name: "Mercury" }, person("Mercury")] });

    const pairs = await run("memory/duplicates", {});
    const names = pairs.map(pairOf);
    assert.equal(names[0], "Me + Tom Smith", "the user, strongest");
    assert.equal(pairs[0].a.node_type, "Self");
    assert.match(pairs[0].reason, /named as the user/);
    for (const want of ["Kate + Katie Moss", "Bob Lee + Robert Lee", "Mercury + Mercury"]) assert.ok(names.includes(want), `${want} in ${names}`);
    assert.ok(!names.includes("Katie Brown + Katie Moss"), "different surnames are not offered");
    assert.ok(!names.includes("Me + Tom"), "a Person with only the user's first name is not offered as the user");
    for (const p of pairs) {
      assert.deepEqual(Object.keys(p).sort(), ["a", "b", "reason"]);
      assert.deepEqual(Object.keys(p.a).sort(), ["name", "node_type", "ref_id"]);
    }
    assert.equal((await run("memory/duplicates", { limit: 1 })).length, 1);
  });

  it("merge records who merged, and a merged-away entity is no longer offered", async () => {
    const pairs = await run("memory/duplicates", {});
    const kate = pairs.find((p: any) => pairOf(p) === "Kate + Katie Moss");
    const [keep, dup] = kate.a.name === "Katie Moss" ? [kate.a, kate.b] : [kate.b, kate.a];
    const out = await run("memory/merge", { keep: keep.ref_id, duplicate: dup.ref_id, created_by: "janitor" });
    assert.equal(out.merged.ref_id, dup.ref_id);
    const query = await memoryDb(ctx);
    const [row] = await query("MATCH (e:Entity) WHERE e.ref_id = $id RETURN e.deleted_reason AS why", { id: dup.ref_id });
    assert.equal(row!.why, `merged into ${keep.ref_id} by janitor`);
    assert.ok(!(await run("memory/duplicates", {})).some((p: any) => p.a.ref_id === dup.ref_id || p.b.ref_id === dup.ref_id));
  });
});
