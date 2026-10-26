/**
 * What a home box serves a strut that keeps a read copy of its memory
 * (src/home-sync.ts): dictation/changes-since and dictation/apply-changes
 * between two real memories, memory/export's hash short-circuit, and
 * home-pull / home-push open to a person token only.
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
    box = await createStrut({ workspace: new WorkspaceManager(join(dir, "box-ws")), store: new MemoryRunStore(), dataDir: join(dir, "box"), homeSync: true, ...NO_SEEDS });
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

  it("home-pull and home-push run for a person token, and are refused to the plain peer key", async () => {
    const run = async (wf: string, input: unknown, token: string) => {
      const res = await request(box, `/workflows/${wf}/run`, { input }, token);
      return { status: res.status, body: (await res.json()) as any };
    };
    const settled = async (wf: string, runId: string): Promise<RunSummary> => {
      for (let i = 0; i < 400; i++) {
        const s = await box.store.getRunSummary(wf, runId);
        if (s) return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`${wf}/${runId} did not settle`);
    };
    const refused = await run("home-pull", {}, PEER_KEY);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /person's credential only/);
    assert.equal((await run("home-push", {}, PEER_KEY)).status, 403);

    const person = personToken("tom")!.token;
    const pulled = await run("home-pull", {}, person);
    assert.equal(pulled.status, 202, JSON.stringify(pulled.body));
    const first = await settled("home-pull", pulled.body.runId);
    assert.equal(first.status, "success", JSON.stringify(first.error));
    const hash = (first.output as any).content_hash;
    assert.ok((first.output as any).data);
    const again = await settled("home-pull", (await run("home-pull", { hash }, person)).body.runId);
    assert.deepEqual(again.output, { unchanged: true, content_hash: hash });

    const pushed = await settled("home-push", (await run("home-push", { dictation: [{ op: "learn", heard: "strut", written: "Strut", at: new Date().toISOString() }] }, person)).body.runId);
    assert.equal(pushed.status, "success", JSON.stringify(pushed.error));
    assert.deepEqual((pushed.output as any).dictation.applied.map((a: any) => a.result), ["learned"]);
    // With nothing to push, the run is still a success.
    const empty = await settled("home-push", (await run("home-push", {}, person)).body.runId);
    assert.equal(empty.status, "success", JSON.stringify(empty.error));
    assert.deepEqual((empty.output as any).dictation.applied, []);
  });

  it("a strut that does not ask for them seeds neither", async () => {
    for (const wf of ["home-pull", "home-push"]) assert.equal(await mac.workspace.getWorkflowMetadata(wf), null, wf);
  });
});
