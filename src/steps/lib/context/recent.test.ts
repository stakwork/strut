import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { conceptFiles } from "../../../concept-seed.js";
import { MemorySessionStore, sessionsCapability, type NewTurn } from "../../../session-store.js";
import { createRegistry } from "../../registry.js";
import recent, { alreadySent, capRecent, newerDay, RECENT, recentItems, renderRecent, type RecentPage } from "./recent.js";

const items = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ name: `${tag}${i}` }));

describe("context/recent (pure)", () => {
  it("keeps an item's fields, cuts long ones, and drops one without a name", () => {
    const long = "x".repeat(400);
    assert.deepEqual(recentItems({ items: [{ name: " a ", what: "yours", at: "2026-11-24T10:00:00Z", link: "https://x" }, { what: "no name" }, { name: long }, "junk"] }), [
      { name: "a", what: "yours", at: "2026-11-24T10:00:00Z", link: "https://x" },
      { name: `${"x".repeat(RECENT.fieldMax)}…` },
    ]);
    assert.deepEqual(recentItems({}), []);
    assert.deepEqual(recentItems(null), []);
  });

  it("caps 8 a page and 20 in all, cutting the longest page's tail first", () => {
    const capped = capRecent([
      { name: "A", items: items(12, "a") },
      { name: "B", items: items(8, "b") },
      { name: "C", items: items(8, "c") },
      { name: "D", items: items(2, "d") },
    ]);
    assert.deepEqual(capped.map((p) => p.items.length), [6, 6, 6, 2]);
    assert.deepEqual(capped[0]!.items.map((i) => i.name), ["a0", "a1", "a2", "a3", "a4", "a5"], "a page keeps its step's order: its own first");
    assert.deepEqual(capRecent([{ name: "A", items: items(3, "a") }])[0]!.items.length, 3);
  });

  it("renders the root's docs, then each page's docs and items, with absolute dates", () => {
    const pages: RecentPage[] = [
      { name: "Recent Apps", docs: "Every app: `app_list`.", items: [{ name: "strut/knowledge", what: "Knowledge, you opened it", at: "2026-11-24T23:41:00Z" }, { name: "strut/jamie", what: "Jamie, on this server" }] },
      { name: "Recent Jobs", items: [] },
    ];
    assert.equal(
      renderRecent({ name: "Recent Work", docs: "What they mean." }, pages),
      [
        "[Recent Work: this server's notes on what the person most likely means, not their words]",
        "What they mean.",
        "",
        "Recent Apps:",
        "Every app: `app_list`.",
        "- strut/knowledge: Knowledge, you opened it (2026-11-24)",
        "- strut/jamie: Jamie, on this server",
        "",
        "Recent Jobs:",
        "[end of Recent Work]",
      ].join("\n"),
    );
    assert.equal(renderRecent({ name: "Recent Work" }, []), "", "no page, no section");
    const docs = renderRecent({ name: "R" }, [{ name: "P", docs: "d".repeat(1000), items: [] }]);
    assert.ok(docs.includes(`${"d".repeat(RECENT.docsMax)}…`) && !docs.includes("d".repeat(RECENT.docsMax + 1)));
  });

  it("a thread has the section while its last line keeps the hash and the turn that sent it is still replayed", () => {
    const line = (offset: number, recent?: string, replayFrom = 0) => ({ offset, replayFrom, ...(recent ? { tags: { recent } } : {}) });
    assert.equal(alreadySent([], "h"), false, "a new thread");
    assert.equal(alreadySent([line(0, "h")], "h"), true);
    assert.equal(alreadySent([line(0, "h"), line(4, "h")], "h"), true, "an unchanged list, turn after turn");
    assert.equal(alreadySent([line(0, "h"), line(4, "g")], "h"), false, "it changed since: sent again");
    assert.equal(alreadySent([line(0)], "h"), false, "a turn that kept none");
    assert.equal(alreadySent([line(0, "h"), line(4, "h", 6)], "h"), false, "a compaction dropped the turn that sent it");
    assert.equal(alreadySent([line(0, "g"), line(4, "h"), line(8, "h", 2)], "h"), true, "a compaction before the turn that sent it");
    assert.equal(alreadySent([line(0, "h")], ""), false);
  });

  it("orders a page by the day the section shows, so a time that moves within a day moves nothing", () => {
    const times = ["2026-11-24T23:00:00.000Z", undefined, "2026-11-25T00:30:00.000Z", "2026-11-24T01:00:00.000Z", "not a time"];
    assert.deepEqual([...times].sort(newerDay), ["2026-11-25T00:30:00.000Z", "2026-11-24T23:00:00.000Z", "2026-11-24T01:00:00.000Z", "not a time", undefined]);
    assert.equal(newerDay("2026-11-24T01:00:00.000Z", "2026-11-24T23:00:00.000Z"), 0, "the same day: the step breaks the tie by name");
  });
});

describe("context/recent (step)", () => {
  const page = (name: string, front: Record<string, string>, docs: string) =>
    `---\nname: ${name}\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join("\n")}\nparents:\n  - Recent Work\n---\n${docs}\n`;

  async function setup(opts: { slow?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "context-recent-"));
    await writeFile(join(dir, "Recent Work.md"), "---\ndescription: What they mean\n---\nMatch here first.\n");
    await writeFile(join(dir, "a.md"), page("Recent Things", { step: "test/things" }, "Every thing: `things`."));
    await writeFile(join(dir, "b.md"), page("Recent Writes", { step: "test/writer" }, "Writes."));
    if (opts.slow !== false) await writeFile(join(dir, "c.md"), page("Recent Slow", { step: "test/slow" }, "Slow."));
    await writeFile(join(dir, "d.md"), page("Recent Missing", { step: "test/nope" }, "Missing."));
    await writeFile(join(dir, "e.md"), page("Recent Notes", {}, "Docs alone."));
    await writeFile(join(dir, "f.md"), page("Recent Fails", { step: "test/fails" }, "Fails."));
    const calls: Array<string | undefined> = [];
    let failures = 0;
    let slowRuns = 0;
    const fails = defineStep({
      type: "test/fails",
      effect: "read",
      input: z.object({}),
      output: z.any(),
      async run() {
        failures++;
        throw new Error("no such capability here");
      },
    });
    const things = defineStep({
      type: "test/things",
      effect: "read",
      input: z.object({}),
      output: z.any(),
      async run(_cfg, ctx) {
        calls.push(ctx.actor);
        return { items: [{ name: ctx.actor ? `${ctx.actor}'s thing` : "the server's thing", what: ctx.actor ? "yours" : "on this server" }] };
      },
    });
    const writer = defineStep({
      type: "test/writer",
      effect: "write",
      input: z.object({}),
      output: z.any(),
      async run() {
        throw new Error("a write step must never run here");
      },
    });
    const slow = defineStep({
      type: "test/slow",
      effect: "read",
      input: z.object({}),
      output: z.any(),
      async run() {
        slowRuns++;
        await new Promise((r) => setTimeout(r, RECENT.stepMs + 500));
        return { items: [{ name: "too late" }] };
      },
    });
    const registry = await createRegistry([things, writer, slow, fails]);
    const store = new MemorySessionStore();
    const services = { conceptFiles: conceptFiles([{ dir, prefix: "test/concepts/" }]), sessions: sessionsCapability(store) };
    const ctx = (actor?: string) => ({ runId: "r", path: "wf/recent", services, registry, ...(actor ? { actor } : {}) }) as unknown as StepContext<StrutCapabilities>;
    return { dir, calls, failures: () => failures, slowRuns: () => slowRuns, store, ctx, done: () => rm(dir, { recursive: true, force: true }) };
  }

  it("lists each page's items as the person, leaves out a write step, a missing one and a slow one, and keeps their docs", async () => {
    const t = await setup();
    try {
      const out = await recent.run(recent.input.parse({ name: "Recent Work" }), t.ctx("ann"));
      assert.match(out.hash, /^[0-9a-f]{16}$/);
      assert.ok(out.text.endsWith("[end of Recent Work]\n\n"), "a prompt's head: a blank line after it");
      const text = out.text;
      assert.ok(text.includes("Match here first."), "the root's docs");
      assert.ok(text.includes("Recent Things:\nEvery thing: `things`.\n- ann's thing: yours"), text);
      assert.ok(text.includes("Recent Writes:\nWrites.\n") && !text.includes("must never"), "a write step is refused; its page keeps its docs");
      assert.ok(text.includes("Recent Slow:\nSlow.\n") && !text.includes("too late"), "a slow step is left out");
      assert.ok(text.includes("Recent Missing:\nMissing.\n"));
      assert.ok(text.includes("Recent Notes:\nDocs alone.\n"), "a page that names no step: its docs");
      assert.ok(text.includes("Recent Fails:\nFails.\n"), "a step that fails: its docs");
      assert.deepEqual(t.calls, ["ann"]);

      // A turn while the slow step still runs waits on that run (it ends
      // within this turn's 2 s) and starts no other.
      const during = await recent.run(recent.input.parse({ name: "Recent Work" }), t.ctx("ann"));
      assert.ok(during.text.includes("Recent Slow:\nSlow.\n- too late"), during.text);
      assert.equal(t.slowRuns(), 1, "one run of the slow step, however many turns came while it ran");

      // Kept a while per person: a busy chat does not rerun the steps. The
      // slow step went on, and its answer is kept for the next turn.
      await new Promise((r) => setTimeout(r, 600));
      const again = await recent.run(recent.input.parse({ name: "Recent Work" }), t.ctx("ann"));
      assert.deepEqual(t.calls, ["ann"]);
      assert.equal(t.failures(), 1, "a failure is kept as long as an answer: one log line, not one a turn");
      assert.ok(again.text.includes("Recent Slow:\nSlow.\n- too late"), again.text);
      assert.equal(t.slowRuns(), 1);
      // Another person: their own list. No person: the server's.
      const bob = await recent.run(recent.input.parse({ name: "Recent Work" }), t.ctx("bob"));
      assert.ok(bob.text.includes("- bob's thing: yours") && bob.hash !== out.hash);
      const nobody = await recent.run(recent.input.parse({ name: "Recent Work" }), t.ctx());
      assert.ok(nobody.text.includes("- the server's thing: on this server"));
    } finally {
      await t.done();
    }
  });

  it("with a session: nothing while the thread has this section, again once it changed or a compaction dropped it", async () => {
    const t = await setup({ slow: false });
    try {
      const turn = async (recentHash: string | undefined, replayFrom?: number) => {
        const record: NewTurn = { workflow: "orchestrator", runId: "r", path: "turn", provider: "anthropic", model: "anthropic/x", routed: false, ...(recentHash ? { tags: { recent: recentHash } } : {}), ...(replayFrom !== undefined ? { replayFrom } : {}) };
        await t.store.appendTurn("s1", { system: "sys", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }], record });
      };
      const run = () => recent.run(recent.input.parse({ name: "Recent Work", session: "s1" }), t.ctx("ann"));
      const first = await run();
      assert.ok(first.text, "a new thread gets it");
      await turn(first.hash);
      assert.deepEqual(await run(), { text: "", hash: first.hash }, "the thread has it: only the hash");
      await turn(first.hash);
      assert.deepEqual(await run(), { text: "", hash: first.hash });
      await turn(first.hash, 3);
      assert.deepEqual(await run(), first, "a compaction dropped the copy: sent again");
      await turn("another");
      assert.deepEqual(await run(), first, "the list changed since (another person spoke): sent again");
    } finally {
      await t.done();
    }
  });

  it("renders nothing without a name or a root", async () => {
    const t = await setup({ slow: false });
    try {
      assert.deepEqual(await recent.run(recent.input.parse({}), t.ctx("ann")), { text: "", hash: "" });
      assert.deepEqual(await recent.run(recent.input.parse({ name: "No Such Page" }), t.ctx("ann")), { text: "", hash: "" });
    } finally {
      await t.done();
    }
  });
});
