import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RunEvent, RunSummary } from "./core.js";
import { FileRunStore, MemoryRunStore, summarizeFromEvents, type RunStore } from "./store.js";
import { FileWorkspaceStore } from "./workspace.js";
import { pathlessWorkspace } from "./test-util/pathless-workspace.js";
import { workspaceConformance } from "./test-util/workspace-conformance.js";
import { FileChatStore, MemoryChatStore, type ChatStore, type ChatEvent } from "./chat-store.js";
import { FileSecretStore, MemorySecretStore, type SecretStore } from "./secret-store.js";
import { FileSessionStore, MemorySessionStore, idProblem, sessionsCapability, type NewTurn, type SessionStore } from "./session-store.js";

/**
 * The storage boundary's spec, as tests: one behavioral suite per layer,
 * parameterized over implementations. Every backend — file, memory, and a
 * future graph-backed one — passes the same cases. A backend that needs
 * a different assertion here is a backend that changed the contract.
 */

workspaceConformance({ name: "FileWorkspaceStore", make: (dir) => new FileWorkspaceStore(dir) });
workspaceConformance({ name: "path-less WorkspaceStore", make: (dir) => pathlessWorkspace(new FileWorkspaceStore(dir)) });

// ── Run store ──────────────────────────────────────────────────────────────

const runImpls: Array<{ name: string; make: (dir: string) => RunStore }> = [
  { name: "FileRunStore", make: (dir) => new FileRunStore(dir) },
  { name: "MemoryRunStore", make: () => new MemoryRunStore() },
];

const WF = "wf";
const ev = (runId: string, type: RunEvent["type"], extra: Partial<RunEvent> = {}): RunEvent => ({
  ts: new Date().toISOString(),
  runId,
  path: WF,
  type,
  ...extra,
});
const summaryFor = (runId: string): RunSummary => ({
  runId,
  workflow: WF,
  startedAt: "s",
  finishedAt: "f",
  durationMs: 1,
  status: "success",
  input: { q: 1 },
  output: { answer: 42 },
});

for (const impl of runImpls) {
  describe(`RunStore conformance: ${impl.name}`, () => {
    let dir: string;
    let store: RunStore;
    beforeEach(async () => {
      dir = join(tmpdir(), `strut-conf-run-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      store = impl.make(dir);
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("append → getRunEvents → finalize → getRunSummary; unknown runs are empty/null", async () => {
      await store.append(WF, "1000", ev("1000", "run.start", { input: { q: 1 } }));
      await store.append(WF, "1000", ev("1000", "run.end"));
      assert.deepEqual((await store.getRunEvents(WF, "1000")).map((e) => e.type), ["run.start", "run.end"]);
      assert.equal(await store.getRunSummary(WF, "1000"), null);
      await store.finalize(WF, "1000", summaryFor("1000"));
      assert.deepEqual(await store.getRunSummary(WF, "1000"), summaryFor("1000"));
      assert.deepEqual(await store.getRunEvents(WF, "nope"), []);
      assert.equal(await store.getRunSummary(WF, "nope"), null);
    });

    it("listRuns is per-workflow, newest first; lastRunAt is the newest run's start", async () => {
      await store.append(WF, "1000", ev("1000", "run.start"));
      await store.append(WF, "3000", ev("3000", "run.start"));
      await store.append(WF, "2000", ev("2000", "run.start"));
      await store.append("other", "9000", ev("9000", "run.start"));
      assert.deepEqual(await store.listRuns(WF), ["3000", "2000", "1000"]);
      assert.deepEqual(await store.listRuns("never"), []);
      assert.equal(await store.lastRunAt(WF), 3000);
      assert.equal(await store.lastRunAt("never"), null);
    });

    it("deleteRuns removes every run of that workflow and nothing else", async () => {
      await store.append(WF, "1000", ev("1000", "run.start"));
      await store.finalize(WF, "1000", summaryFor("1000"));
      await store.append(WF, "2000", ev("2000", "run.start"));
      await store.append("other", "9000", ev("9000", "run.start"));
      await store.deleteRuns(WF);
      assert.deepEqual(await store.listRuns(WF), []);
      assert.equal(await store.getRunSummary(WF, "1000"), null);
      assert.deepEqual(await store.getRunEvents(WF, "2000"), []);
      assert.equal(await store.lastRunAt(WF), null);
      assert.deepEqual(await store.listRuns("other"), ["9000"]);
      await store.deleteRuns("never"); // nothing to remove is not an error
    });

    it("setRunCallback → getRunCallback: null until set, kept beside the log, gone with deleteRuns", async () => {
      assert.equal(await store.getRunCallback(WF, "1000"), null);
      await store.setRunCallback(WF, "1000", "http://host.test/hook?token=s3cret");
      await store.append(WF, "1000", ev("1000", "run.start"));
      await store.finalize(WF, "1000", summaryFor("1000"));
      assert.equal(await store.getRunCallback(WF, "1000"), "http://host.test/hook?token=s3cret");
      assert.equal(await store.getRunCallback(WF, "1001"), null);
      // Never in what the read endpoints serve.
      assert.ok(!JSON.stringify(await store.getRunEvents(WF, "1000")).includes("s3cret"));
      assert.ok(!JSON.stringify(await store.getRunSummary(WF, "1000")).includes("s3cret"));
      await store.deleteRuns(WF);
      assert.equal(await store.getRunCallback(WF, "1000"), null);
    });

    it("a finalize-less log yields a partial summary (crash / in-flight)", async () => {
      await store.append(WF, "1", ev("1", "run.start", { input: { q: 1 } }));
      await store.append(WF, "1", ev("1", "step.end", { path: `${WF}/a`, output: "A" }));
      await store.append(WF, "1", ev("1", "step.error", { path: `${WF}/b`, error: { message: "boom" } }));
      const partial = summarizeFromEvents(WF, "1", await store.getRunEvents(WF, "1"));
      assert.equal(partial?.partial, true);
      assert.deepEqual(partial?.steps, { a: "A" });
      assert.equal(partial?.lastError?.message, "boom");
      assert.equal(summarizeFromEvents(WF, "nope", await store.getRunEvents(WF, "nope")), null);
    });

    it("tailEvents: history, then live follow, closing at the terminal event", async () => {
      await store.append(WF, "1", ev("1", "run.start"));
      const seen: string[] = [];
      const tail = (async () => {
        for await (const e of store.tailEvents(WF, "1", { intervalMs: 5 })) seen.push(e.type);
      })();
      await new Promise((r) => setTimeout(r, 25));
      await store.append(WF, "1", ev("1", "step.start", { path: `${WF}/a` }));
      await store.append(WF, "1", ev("1", "run.end"));
      await tail;
      assert.deepEqual(seen, ["run.start", "step.start", "run.end"]);
    });

    it("tailEvents: skip consumes the first N events without yielding them, terminality intact", async () => {
      // A client read 2 events from getRunEvents, then tails from there: it
      // gets only what came after — the live appends included.
      await store.append(WF, "1", ev("1", "run.start"));
      await store.append(WF, "1", ev("1", "step.start", { path: `${WF}/a` }));
      const seen: string[] = [];
      const tail = (async () => {
        for await (const e of store.tailEvents(WF, "1", { intervalMs: 5, skip: 2 })) seen.push(e.type);
      })();
      await new Promise((r) => setTimeout(r, 25));
      await store.append(WF, "1", ev("1", "step.end", { path: `${WF}/a`, output: "A" }));
      await store.append(WF, "1", ev("1", "run.end"));
      await tail;
      assert.deepEqual(seen, ["step.end", "run.end"]);

      // Skipping past a finished log's terminal event still closes the tail.
      const none: string[] = [];
      for await (const e of store.tailEvents(WF, "1", { intervalMs: 5, skip: 4 })) none.push(e.type);
      assert.deepEqual(none, []);
      const none2: string[] = [];
      for await (const e of store.tailEvents(WF, "1", { intervalMs: 5, skip: 99 })) none2.push(e.type);
      assert.deepEqual(none2, []);
    });

    it("tailEvents: a run.resumed past a terminal event reopens the log", async () => {
      for (const t of ["run.start", "run.cancelled", "run.resumed", "run.end"] as const) {
        await store.append(WF, "1", ev("1", t));
      }
      const seen: string[] = [];
      for await (const e of store.tailEvents(WF, "1", { intervalMs: 5 })) seen.push(e.type);
      assert.deepEqual(seen, ["run.start", "run.cancelled", "run.resumed", "run.end"]);
    });

    it("tailEvents: stillLive keeps following after a terminal event; abort stops it", async () => {
      await store.append(WF, "1", ev("1", "run.start"));
      await store.append(WF, "1", ev("1", "run.error", { error: { message: "x" } }));
      let live = true;
      const seen: string[] = [];
      const tail = (async () => {
        for await (const e of store.tailEvents(WF, "1", { intervalMs: 5, stillLive: () => live })) {
          seen.push(e.type);
        }
      })();
      await new Promise((r) => setTimeout(r, 25));
      await store.append(WF, "1", ev("1", "run.resumed"));
      await store.append(WF, "1", ev("1", "run.end"));
      live = false;
      await tail;
      assert.deepEqual(seen, ["run.start", "run.error", "run.resumed", "run.end"]);

      const ac = new AbortController();
      const aborted: string[] = [];
      const t2 = (async () => {
        for await (const e of store.tailEvents(WF, "2", { intervalMs: 5, signal: ac.signal })) {
          aborted.push(e.type);
        }
      })();
      await new Promise((r) => setTimeout(r, 15));
      ac.abort();
      await t2;
      assert.deepEqual(aborted, [], "no events yet and aborted → nothing, and it returns");
    });

    it("tailEvents: `live` false at EOF before any terminal event closes a stale log; true keeps following", async () => {
      // A run cut off by a crash: a log with no terminal event and nobody
      // producing. Without `live` the tail would follow it forever.
      await store.append(WF, "1", ev("1", "run.start"));
      await store.append(WF, "1", ev("1", "step.start", { path: `${WF}/a` }));
      const stale: string[] = [];
      for await (const e of store.tailEvents(WF, "1", { intervalMs: 5, live: () => false })) stale.push(e.type);
      assert.deepEqual(stale, ["run.start", "step.start"], "drained, then closed");

      // Live: the same log is followed until its terminal event.
      let live = true;
      const seen: string[] = [];
      const tail = (async () => {
        for await (const e of store.tailEvents(WF, "1", { intervalMs: 5, live: () => live })) seen.push(e.type);
      })();
      await new Promise((r) => setTimeout(r, 25));
      await store.append(WF, "1", ev("1", "step.end", { path: `${WF}/a`, output: 1 }));
      await store.append(WF, "1", ev("1", "run.end"));
      await tail;
      assert.deepEqual(seen, ["run.start", "step.start", "step.end", "run.end"]);
      // A terminal event still closes the tail; `live` is only asked before one.
      live = false;
      const again: string[] = [];
      for await (const e of store.tailEvents(WF, "1", { intervalMs: 5, live: () => live })) again.push(e.type);
      assert.equal(again.length, 4);
    });
  });
}

// ── Chat store ─────────────────────────────────────────────────────────────

const chatImpls: Array<{ name: string; make: (dir: string) => ChatStore }> = [
  { name: "FileChatStore", make: (dir) => new FileChatStore(dir) },
  { name: "MemoryChatStore", make: () => new MemoryChatStore() },
];

const cev = (chatId: string, turn: number, type: ChatEvent["type"], extra: Partial<ChatEvent> = {}): ChatEvent => ({
  ts: new Date().toISOString(),
  chatId,
  turn,
  type,
  ...extra,
});

describe("FileRunStore paths", () => {
  it("refuses a key that would escape the workspace root", async () => {
    const store = new FileRunStore(join(tmpdir(), `strut-conf-run-${randomUUID()}`));
    await assert.rejects(() => store.deleteRuns("../escape"), /Invalid run store key/);
    await assert.rejects(() => store.append("..", "1", ev("1", "run.start")), /Invalid run store key/);
  });
});

for (const impl of chatImpls) {
  describe(`ChatStore conformance: ${impl.name}`, () => {
    let dir: string;
    let store: ChatStore;
    beforeEach(async () => {
      dir = join(tmpdir(), `strut-conf-chat-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      store = impl.make(dir);
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("create → meta → list → messages → delete", async () => {
      const meta = await store.createChat({ id: "c1", title: "t" });
      assert.equal(meta.id, "c1");
      assert.equal((await store.getMeta("c1"))?.title, "t");
      assert.equal(await store.getMeta("nope"), null);
      await store.setMeta("c1", { status: "done" });
      assert.equal((await store.getMeta("c1"))?.status, "done");
      assert.deepEqual((await store.listChats()).map((c) => c.id), ["c1"]);
      await store.appendMessages("c1", [{ role: "user", content: "hi" } as never]);
      assert.equal((await store.loadMessages("c1")).length, 1);
      await store.deleteChat("c1");
      assert.equal(await store.getMeta("c1"), null);
    });

    it("system prompt: null until set, then read back verbatim; gone with the chat", async () => {
      await store.createChat({ id: "c1" });
      assert.equal(await store.getSystem("c1"), null);
      const system = "You build workflows.\n\nAvailable steps:\nsteps/\n  core/\n";
      await store.setSystem("c1", system);
      assert.equal(await store.getSystem("c1"), system);
      await store.deleteChat("c1");
      assert.equal(await store.getSystem("c1"), null);
    });

    it("tailEvents yields one turn's events (history → live) and stops at its terminal", async () => {
      await store.createChat({ id: "c1" });
      await store.appendEvent("c1", cev("c1", 0, "text-delta", { delta: "a" }));
      await store.appendEvent("c1", cev("c1", 0, "chat.end"));
      await store.appendEvent("c1", cev("c1", 1, "text-delta", { delta: "b" }));
      const seen: ChatEvent[] = [];
      const tail = (async () => {
        for await (const e of store.tailEvents("c1", 1, { intervalMs: 5 })) seen.push(e);
      })();
      await new Promise((r) => setTimeout(r, 25));
      await store.appendEvent("c1", cev("c1", 1, "chat.end"));
      await tail;
      assert.deepEqual(seen.map((e) => [e.turn, e.type]), [[1, "text-delta"], [1, "chat.end"]]);
    });
  });
}

// ── Session store ──────────────────────────────────────────────────────────

const sessionImpls: Array<{ name: string; make: (dir: string) => SessionStore }> = [
  { name: "FileSessionStore", make: (dir) => new FileSessionStore(dir) },
  { name: "MemorySessionStore", make: () => new MemorySessionStore() },
];

const turnOf = (runId: string, extra: Partial<NewTurn> = {}): NewTurn => ({
  workflow: WF,
  runId,
  path: `${WF}/work`,
  provider: "anthropic",
  model: "anthropic/claude-sonnet-5-5",
  routed: false,
  ...extra,
});
const user = (text: string) => ({ role: "user", content: text });
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

for (const impl of sessionImpls) {
  describe(`SessionStore conformance: ${impl.name}`, () => {
    let dir: string;
    let store: SessionStore;
    beforeEach(async () => {
      dir = join(tmpdir(), `strut-conf-session-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      store = impl.make(dir);
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("null until a turn is committed; turns append, offsets follow, the system prompt is turn 0's", async () => {
      assert.equal(await store.load("s1"), null);
      assert.deepEqual(await store.list(), []);

      const t0 = await store.appendTurn("s1", { system: "first", messages: [user("a"), reply("b")], record: turnOf("1", { principal: "ann", job: "j-1" }) });
      assert.deepEqual([t0.turn, t0.offset, t0.count], [0, 0, 2]);
      const t1 = await store.appendTurn("s1", { system: "IGNORED", messages: [user("c"), reply("d"), reply("e")], record: turnOf("2", { principal: "bob" }) });
      assert.deepEqual([t1.turn, t1.offset, t1.count], [1, 2, 3]);

      const s = await store.load("s1");
      assert.equal(s?.system, "first");
      assert.deepEqual(s?.messages, [user("a"), reply("b"), user("c"), reply("d"), reply("e")]);
      assert.deepEqual(s?.turns.map((t) => [t.turn, t.runId, t.principal, t.job]), [[0, "1", "ann", "j-1"], [1, "2", "bob", undefined]]);

      const [info] = await store.list();
      assert.deepEqual(
        [info?.id, info?.turns, info?.messages, info?.createdBy, info?.createdAt, info?.updatedAt, info?.jobs],
        ["s1", 2, 5, "ann", t0.at, t1.at, ["j-1"]],
      );
    });

    it("a slash is part of the id, not a hierarchy: abc and abc/review never meet", async () => {
      await store.appendTurn("abc", { system: "w", messages: [user("work")], record: turnOf("1") });
      await store.appendTurn("abc/review", { system: "r", messages: [user("review")], record: turnOf("1", { path: `${WF}/review` }) });
      assert.deepEqual((await store.load("abc"))?.messages, [user("work")]);
      assert.deepEqual((await store.load("abc/review"))?.messages, [user("review")]);
      assert.deepEqual((await store.list()).map((i) => i.id).sort(), ["abc", "abc/review"]);

      await store.delete("abc");
      assert.equal(await store.load("abc"), null);
      assert.equal((await store.load("abc/review"))?.system, "r");
    });

    it("refuses an id that could be a missing template value, or escape the store", async () => {
      for (const id of ["", "/review", "abc/", "a//b", "..", "../x", "a/../b", "-abc", "abc-", "a b", "a%2Fb"]) {
        await assert.rejects(() => store.load(id), /Invalid session id/, id);
        await assert.rejects(() => store.appendTurn(id, { system: "s", messages: [], record: turnOf("1") }), /Invalid session id/, id);
      }
    });

    it("replayFrom: a turn's compaction boundary is read back and inherited by the turns after it", async () => {
      const t0 = await store.appendTurn("s1", { system: "s", messages: [user("a"), reply("b")], record: turnOf("1") });
      assert.equal(t0.replayFrom, 0);
      assert.equal((await store.load("s1"))?.replayFrom, 0);
      // Turn 1 compacted at open: its first message is the summary, and that
      // is where the thread replays from — an absolute index.
      const t1 = await store.appendTurn("s1", {
        system: "s",
        messages: [user("[compaction] …"), user("c"), reply("d")],
        record: turnOf("2", { replayFrom: 2 }),
      });
      assert.equal(t1.replayFrom, 2);
      const t2 = await store.appendTurn("s1", { system: "s", messages: [user("e"), reply("f")], record: turnOf("3") });
      assert.equal(t2.replayFrom, 2);

      const s = await store.load("s1");
      assert.equal(s?.replayFrom, 2);
      assert.equal(s?.messages.length, 7);
      assert.deepEqual(s?.messages.slice(s.replayFrom)[0], user("[compaction] …"));
      assert.deepEqual(s?.turns.map((t) => t.replayFrom), [0, 2, 2]);

      const sessions = sessionsCapability(store);
      const open = await sessions.open("s1", { runId: "4", path: "wf/work" });
      assert.equal(open.replayFrom, 2);
      assert.equal(open.messages.length, 7);
      open.release();
    });

    it("the capability: one holder at a time, released on demand, and by a failed open", async () => {
      const sessions = sessionsCapability(store);
      const a = await sessions.open("s1", { runId: "1", path: "wf/work" });
      assert.equal(a.system, null);
      assert.deepEqual(a.messages, []);
      assert.deepEqual(sessions.holder("s1"), { runId: "1", path: "wf/work" });
      await assert.rejects(
        () => sessions.open("s1", { runId: "2", path: "wf/work" }),
        /^Error: session_busy: session "s1" is in use by run 1 \(wf\/work\)$/,
      );
      // Another session is nobody's business.
      (await sessions.open("s2", { runId: "2", path: "wf/work" })).release();

      await a.commit({ system: "sys", messages: [user("a"), reply("b")], record: turnOf("1") });
      a.release();
      assert.equal(sessions.holder("s1"), undefined);

      const b = await sessions.open("s1", { runId: "2", path: "wf/work" });
      assert.equal(b.system, "sys");
      assert.deepEqual(b.messages, [user("a"), reply("b")]);
      b.release();

      await assert.rejects(() => sessions.open("/bad", { runId: "3", path: "p" }), /Invalid session id/);
      assert.equal(sessions.holder("/bad"), undefined);
    });
  });
}

describe("FileSessionStore on disk", () => {
  it("one flat directory per id; lines past the last committed turn are dropped", async () => {
    const dir = join(tmpdir(), `strut-conf-session-${randomUUID()}`);
    try {
      const store = new FileSessionStore(dir);
      await store.appendTurn("abc/review", { system: "sys", messages: [user("a"), reply("b")], record: turnOf("1") });
      const at = join(dir, "sessions", "abc%2Freview");
      assert.equal(await readFile(join(at, "system.md"), "utf-8"), "sys");

      // A crash after the messages were appended and before the turn line.
      await appendFile(join(at, "messages.jsonl"), JSON.stringify(user("lost")) + "\n");
      assert.deepEqual((await store.load("abc/review"))?.messages, [user("a"), reply("b")]);

      const t1 = await store.appendTurn("abc/review", { system: "sys", messages: [user("c")], record: turnOf("2") });
      assert.equal(t1.offset, 2);
      assert.deepEqual((await store.load("abc/review"))?.messages, [user("a"), reply("b"), user("c")]);
      const raw = (await readFile(join(at, "messages.jsonl"), "utf-8")).trim().split("\n");
      assert.equal(raw.length, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("idProblem", () => {
  it("accepts uuids, dotted and suffixed names", () => {
    for (const id of ["a", "6f1c2a9e-0b1d-4c3e-9a7f-2d5e8b1c4f60", "janitor-daily", "abc/review", "v1.2_x/y-z/3"]) {
      assert.equal(idProblem(id), null, id);
    }
  });
  it("names the likely cause of a ragged id", () => {
    assert.match(idProblem("/review") ?? "", /empty segment — is a template value missing\?/);
    assert.match(idProblem("review-") ?? "", /invalid segment "review-"/);
    assert.match(idProblem("x".repeat(121)) ?? "", /longer than 120/);
    assert.equal(idProblem(undefined), "is empty");
  });
});

// ── Secret store ───────────────────────────────────────────────────────────

const secretImpls: Array<{ name: string; make: (dir: string) => SecretStore }> = [
  { name: "FileSecretStore", make: (dir) => new FileSecretStore(dir) },
  { name: "MemorySecretStore", make: () => new MemorySecretStore() },
];

for (const impl of secretImpls) {
  describe(`SecretStore conformance: ${impl.name}`, () => {
    let dir: string;
    let store: SecretStore;
    beforeEach(async () => {
      dir = join(tmpdir(), `strut-conf-secret-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      store = impl.make(dir);
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("set → get → list (names only, never values) → overwrite → delete", async () => {
      assert.equal(await store.get("API_KEY"), undefined);
      await store.set("API_KEY", "s3cret");
      assert.equal(await store.get("API_KEY"), "s3cret");
      const listed = await store.list();
      assert.deepEqual(listed.map((s) => s.name), ["API_KEY"]);
      assert.equal(JSON.stringify(listed).includes("s3cret"), false, "list never carries values");
      await store.set("API_KEY", "rotated");
      assert.equal(await store.get("API_KEY"), "rotated");
      assert.equal(await store.delete("API_KEY"), true);
      assert.equal(await store.delete("API_KEY"), false);
      assert.equal(await store.get("API_KEY"), undefined);
    });
  });
}
