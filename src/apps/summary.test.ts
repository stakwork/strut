import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileWorkspaceStore } from "../workspace.js";
import { manifestSchema } from "./manifest.js";
import { kitForTests } from "../test-util/app-kit.js";
import { createApps } from "./apps.js";
import { appDiff, oneLine, type AppSummarizer, type AppSummaryInput } from "./summary.js";
import type { KitLocation } from "./kit.js";

/** A version's one-line summary: written after the publish, by an injected summarizer; never the publish's problem. */

let kit: KitLocation;
let root: string;
before(async () => {
  kit = await kitForTests();
  root = await mkdtemp(join(tmpdir(), "strut-summary-"));
});
let n = 0;

async function appDir(body: string): Promise<string> {
  const dir = join(root, `app-${++n}`);
  for (const [rel, text] of Object.entries({ "app.yaml": "title: Tasks\n", "src/App.tsx": `export default function App() { return <p className="p-2">${body}</p>; }\n` })) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text, "utf8");
  }
  return dir;
}

function setup(summarize: AppSummarizer, summaryTimeoutMs?: number) {
  const ws = new FileWorkspaceStore(join(root, `ws-${++n}`));
  const apps = createApps({ workspace: ws, kit, summarize, ...(summaryTimeoutMs ? { summaryTimeoutMs } : {}) });
  return { ws, apps };
}

const settle = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};
const summaryOf = async (ws: FileWorkspaceStore, v: string) => (await ws.getApp("tasks"))?.versions[v]?.summary;

describe("app version summaries", () => {
  it("v1 and v2 each get the summarizer's line; v2's input carries the v1→v2 diff", async () => {
    const seen: AppSummaryInput[] = [];
    const { ws, apps } = setup(async (i) => { seen.push(i); return i.diff === undefined ? "A task list" : "Added an archive button"; });
    assert.equal((await apps.publish(await appDir("one"), "tasks", { surface: "person" })).ok, true);
    await settle(async () => !!(await summaryOf(ws, "v1")));
    assert.equal(await summaryOf(ws, "v1"), "A task list");
    assert.equal((await apps.publish(await appDir("two"), "tasks", { surface: "person" })).ok, true);
    await settle(async () => !!(await summaryOf(ws, "v2")));
    assert.equal(await summaryOf(ws, "v2"), "Added an archive button");
    assert.equal(seen[0]!.diff, undefined);
    assert.match(seen[1]!.diff!, /src\/App\.tsx/);
    assert.match(seen[1]!.diff!, /- .*one/);
    assert.match(seen[1]!.diff!, /\+ .*two/);
    // …and it is on the versions listing the API reads.
    const rec = await ws.getApp("tasks");
    assert.equal(rec?.versions["v2"]?.summary, "Added an archive button");
    assert.equal((await apps.get("tasks"))?.versions["v1"]?.summary, "A task list");
  });

  it("a summarizer that throws still publishes, with no summary, and warns", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const { ws, apps } = setup(async () => { throw new Error("no key"); });
      const r = await apps.publish(await appDir("x"), "tasks", { surface: "person" });
      assert.equal(r.ok, true);
      await settle(async () => warns.length > 0);
      assert.match(warns[0]!, /\[apps\] summary for tasks@v1 not generated: no key/);
      assert.equal(await summaryOf(ws, "v1"), undefined);
      assert.equal((await ws.getApp("tasks"))?.active, "v1");
    } finally {
      console.warn = orig;
    }
  });

  it("a summarizer that never answers is given up on after the timeout", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const { ws, apps } = setup(() => new Promise<never>(() => {}), 50);
      assert.equal((await apps.publish(await appDir("y"), "tasks", { surface: "person" })).ok, true);
      await settle(async () => warns.length > 0);
      assert.match(warns[0]!, /timed out/);
      assert.equal(await summaryOf(ws, "v1"), undefined);
    } finally {
      console.warn = orig;
    }
  });

  it("the diff is compact and capped; oneLine makes one plain line", () => {
    const d = appDiff({ a: "x\ny", gone: "z" }, { a: "x\nw", fresh: "q" });
    assert.match(d, /~~~ a\n- y\n\+ w/);
    assert.match(d, /\+\+\+ fresh/);
    assert.match(d, /--- gone \(deleted\)/);
    assert.ok(appDiff({}, { big: "line\n".repeat(5000) + "x".repeat(9000) }).length <= 6001);
    assert.equal(oneLine('"Added a button."\nmore'), "Added a button");
  });

  it("a summary written while another version is published loses neither", async () => {
    const ws = new FileWorkspaceStore(join(root, `ws-${++n}`));
    const m = manifestSchema.parse({ title: "T" });
    await ws.publishApp("race", "h1", m);
    for (let i = 2; i < 12; i++) {
      await Promise.all([ws.setAppVersionSummary("race", `v${i - 1}`, `line ${i - 1}`), ws.publishApp("race", `h${i}`, m), ws.setAppPinned("race", true)]);
    }
    const rec = await ws.getApp("race");
    assert.deepEqual(Object.keys(rec!.versions).length, 11);
    assert.equal(rec!.pinned, true);
    for (let i = 1; i < 11; i++) assert.equal(rec!.versions[`v${i}`]?.summary, `line ${i}`);
  });
});
