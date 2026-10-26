/**
 * What a home box serves a strut that keeps a read copy of its memory
 * (src/home-sync.ts): dictation/changes-since and dictation/apply-changes
 * between two real memories, memory/export's hash short-circuit, and
 * the /home/pull and /home/push routes, open to a person token only.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "./createStrut.js";
import { MemoryRunStore, type RunSummary } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { personToken } from "./auth.js";

const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

const KEY = "home-box-api-key";
const PEER_KEY = "a-strut-peer-key";

describe("home sync: what the box serves", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-home-sync-"));
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  let box: Strut;
  let mac: Strut;
  const NO_SEEDS = { serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, browserWorkflows: false, job: false, orchestrator: false, builder: false } as const;

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER_KEY;
    box = await createStrut({ workspace: new WorkspaceManager(join(dir, "box-ws")), store: new MemoryRunStore(), dataDir: join(dir, "box"), homeSync: "box", ...NO_SEEDS });
    mac = await createStrut({ workspace: new WorkspaceManager(join(dir, "mac-ws")), store: new MemoryRunStore(), dataDir: join(dir, "mac"), ...NO_SEEDS });
  });
  after(async () => {
    await box.close();
    await mac.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const request = (strut: Strut, path: string, body: unknown, token = KEY) =>
    strut.app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const step = async (strut: Strut, type: string, config: unknown) => {
    const body = (await (await request(strut, `/steps/${type}/run`, { config })).json()) as { status: string; output?: any; error?: string };
    assert.equal(body.status, "success", JSON.stringify(body.error ?? body).slice(0, 600));
    return body.output;
  };
  const lexicon = async (strut: Strut) => step(strut, "memory/lexicon", {});
  const pairs = async (strut: Strut) =>
    (await lexicon(strut)).entities.flatMap((e: any) => e.heard.map((h: any) => `${h.value}→${h.form ?? e.name}`)).sort();
  const undone = async (strut: Strut) => (await lexicon(strut)).undone.map((u: any) => `${u.value}→${u.form ?? u.entity.name}`).sort();

  it("changes-since reads what dictation learned and undid, keyed by pair; apply-changes replays it, and again changes nothing", async () => {
    const start = (await step(mac, "dictation/changes-since", {})).until;
    await step(mac, "dictation/add", { heard: "stack work", written: "Stakwork" });
    await step(mac, "dictation/add", { heard: "ee toy", written: "Itoi", name: "Paul Itoi" });
    await step(mac, "dictation/add", { heard: "pee eight", written: "P8", term: true });
    const learned = await step(mac, "dictation/changes-since", { since: start });
    assert.equal(learned.kind, "dictation");
    assert.deepEqual(learned.changes.map((c: any) => [c.op, c.heard, c.written, c.name, c.term]), [
      ["learn", "stack work", "Stakwork", undefined, undefined],
      ["learn", "ee toy", "Itoi", "Paul Itoi", undefined],
      ["learn", undefined, "P8", undefined, true],
    ]);
    // Nothing between two reads: the next read from `until` is empty.
    assert.deepEqual((await step(mac, "dictation/changes-since", { since: learned.until })).changes, []);

    const first = await step(box, "dictation/apply-changes", { changes: learned.changes });
    assert.deepEqual(first.applied.map((a: any) => a.result), ["learned", "learned", "learned"]);
    assert.deepEqual(await pairs(box), ["ee toy→Itoi", "stack work→Stakwork"]);
    assert.ok((await lexicon(box)).entities.some((e: any) => e.name === "P8"), "the term");
    assert.ok((await lexicon(box)).entities.some((e: any) => e.name === "Paul Itoi"), "the person the name fix is kept on");
    const again = await step(box, "dictation/apply-changes", { changes: learned.changes });
    assert.deepEqual(again.applied.map((a: any) => a.result), ["known", "known", "known"]);
    assert.deepEqual(await pairs(box), ["ee toy→Itoi", "stack work→Stakwork"]);
  });

  it("an undo travels by its pair: the box forgets its own copy (another id), and is never taught it again", async () => {
    const since = (await step(mac, "dictation/changes-since", {})).until;
    const [onMac] = (await lexicon(mac)).entities.filter((e: any) => e.name === "Stakwork");
    const [onBox] = (await lexicon(box)).entities.filter((e: any) => e.name === "Stakwork");
    assert.notEqual(onMac.heard[0].ref_id, onBox.heard[0].ref_id, "the two graphs gave the pair different ids");
    await step(mac, "dictation/undo", { undo: [onMac.ref_id] }); // the learn made the word, so Undo forgets the word
    const changes = (await step(mac, "dictation/changes-since", { since })).changes;
    assert.deepEqual(changes.map((c: any) => [c.op, c.heard, c.written]), [["undo", "stack work", "Stakwork"]]);

    assert.deepEqual((await step(box, "dictation/apply-changes", { changes })).applied.map((a: any) => a.result), ["undone"]);
    assert.deepEqual(await pairs(box), ["ee toy→Itoi"]);
    assert.deepEqual(await undone(box), ["stack work→Stakwork"]);
    assert.ok(!(await lexicon(box)).entities.some((e: any) => e.name === "Stakwork"), "the word dictation made went with it");
    assert.deepEqual((await step(box, "dictation/apply-changes", { changes })).applied.map((a: any) => a.result), ["already undone"]);
    // A term undone the same way.
    const t = (await lexicon(mac)).entities.find((e: any) => e.name === "P8");
    const since2 = (await step(mac, "dictation/changes-since", {})).until;
    await step(mac, "dictation/undo", { undo: [t.ref_id] });
    const termUndo = (await step(mac, "dictation/changes-since", { since: since2 })).changes;
    assert.deepEqual(termUndo.map((c: any) => [c.op, c.written, c.term]), [["undo", "P8", true]]);
    assert.deepEqual((await step(box, "dictation/apply-changes", { changes: termUndo })).applied.map((a: any) => a.result), ["undone"]);
    assert.deepEqual((await step(box, "dictation/apply-changes", { changes: termUndo })).applied.map((a: any) => a.result), ["already undone"]);
    // An undo of a pair the box never had is reported, not an error.
    const stray = [{ op: "undo", heard: "nothing", written: "Nowhere", at: new Date().toISOString() }];
    assert.deepEqual((await step(box, "dictation/apply-changes", { changes: stray })).applied.map((a: any) => a.result), ["not found"]);
  });

  it("memory/export with if_changed: the hash the caller holds short-circuits; any change makes a new one", async () => {
    const full = await step(box, "memory/export", { inline: true });
    assert.match(full.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(full.data);
    assert.deepEqual(await step(box, "memory/export", { inline: true, if_changed: full.content_hash }), { unchanged: true, content_hash: full.content_hash });
    await step(box, "dictation/add", { heard: "lady bug", written: "Ladybug" });
    const changed = await step(box, "memory/export", { inline: true, if_changed: full.content_hash });
    assert.notEqual(changed.content_hash, full.content_hash);
    assert.ok(changed.data, "the new export comes back");
  });

  it("/home/pull and /home/push answer a person token, refuse the plain peer key, and keep nothing a later read could find", async () => {
    const post = async (path: string, body: unknown, token: string) => {
      const res = await request(box, path, body, token);
      return { status: res.status, body: (await res.json()) as any, cache: res.headers.get("cache-control") };
    };
    const refused = await post("/home/pull", {}, PEER_KEY);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /^forbidden/);
    assert.equal((await post("/home/push", {}, PEER_KEY)).status, 403);

    const tom = personToken("tom")!.token;
    const pulled = await post("/home/pull", {}, tom);
    assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
    assert.equal(pulled.cache, "no-store");
    assert.ok(pulled.body.data, "the whole memory");
    const hash = pulled.body.content_hash;
    assert.deepEqual((await post("/home/pull", { hash }, tom)).body, { unchanged: true, content_hash: hash });

    const pushed = await post("/home/push", { dictation: [{ op: "learn", heard: "strut", written: "Strut", at: new Date().toISOString() }] }, tom);
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.deepEqual(pushed.body.dictation.applied.map((a: any) => a.result), ["learned"]);
    assert.deepEqual((await post("/home/push", {}, tom)).body, { dictation: { applied: [] } }, "nothing to push");
    assert.equal((await post("/home/push", { dictation: [{ op: "nope" }] }, tom)).status, 400);

    // Nothing was journaled: no run of any kind holds the export or the
    // changes, so neither another token nor the same one later reads them.
    for (const key of ["home-pull", "home-push", "step:memory/export", "step:dictation/apply-changes"]) {
      assert.deepEqual(await box.store.listRuns(key), [], key);
    }
    const eve = personToken("eve")!.token;
    for (const token of [tom, eve, PEER_KEY]) {
      const runs = await box.app.request("/workflows/home-pull/runs", { headers: { authorization: `Bearer ${token}` } });
      const body = (await runs.json()) as any;
      const list = Array.isArray(body) ? body : body.runs;
      assert.ok(runs.status === 404 || (Array.isArray(list) && list.length === 0), `${runs.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
  });

  it("the routes are off unless the host asks: a strut without homeSync has neither", async () => {
    const res = await request(mac, "/home/pull", {}, personToken("tom")!.token);
    assert.ok(res.status === 403 || res.status === 404, `${res.status}`);
  });

});
