/**
 * The read steps behind strut's own Recent Work pages (plans/recent-work.md
 * §5): `app/recent`, `meta/recent-workflows`, `job/recent`. Each lists the
 * person's own first, then what else the server has, and a person with no
 * history still gets the server's.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { recentWorkflows } from "../../../authoring.js";
import { createJobIndex } from "../../../job-index.js";
import { jobRoot, jobsCapability, touchJob } from "../../../jobs.js";
import { MemoryRunStore } from "../../../store.js";
import type { WorkflowListEntry } from "../../../workspace.js";
import appRecent from "../app/recent.js";
import jobRecent from "../job/recent.js";
import workflowsRecent from "../meta/recent-workflows.js";

const ctxOf = (services: unknown, actor?: string) => ({ runId: "r", path: "p", services, ...(actor ? { actor } : {}) }) as unknown as StepContext<StrutCapabilities>;

describe("app/recent", () => {
  const apps = [
    { name: "strut/earnings", title: "Earnings", admin: true },
    { name: "strut/jamie", title: "Jamie" },
    { name: "strut/knowledge", title: "Knowledge", description: "Concepts, claims and their trials" },
    { name: "acme/board", title: "Board", owner: "ann" },
  ].map((a) => ({ activeVersion: "v1", versions: ["v1"], grants: {}, ...a }));
  const opened: Record<string, string> = { "strut/jamie": "2026-11-24T10:00:00.000Z" };
  const services = {
    apps: {
      list: async () => apps,
      calls: async (name: string, viewer: string | undefined) => ({ app: name, calls: viewer === "ann" && opened[name] ? [{ at: opened[name] }] : [] }),
    },
  };

  it("a person with no history gets the server's apps, an admin's left out, so the Knowledge app is named by its title", async () => {
    const out = await appRecent.run({}, ctxOf(services, "bob"));
    assert.deepEqual(out.items, [
      { name: "acme/board", what: "Board, on this server" },
      { name: "strut/jamie", what: "Jamie, on this server" },
      { name: "strut/knowledge", what: "Knowledge, on this server: Concepts, claims and their trials" },
    ]);
  });

  it("the apps the person opened come first, then the ones they made, then the rest", async () => {
    const out = await appRecent.run({}, ctxOf(services, "ann"));
    assert.deepEqual(out.items.map((i) => [i.name, i.what, i.at]), [
      ["strut/jamie", "Jamie, you opened it", "2026-11-24T10:00:00.000Z"],
      ["acme/board", "Board, you made it", undefined],
      ["strut/knowledge", "Knowledge, on this server: Concepts, claims and their trials", undefined],
    ]);
  });

  it("an app not made here says where it comes from, before its description: where a change to it goes", async () => {
    const origins: Record<string, string> = { "strut/jamie": "strut's own", "strut/knowledge": "strut's own", "acme/board": "repo https://github.com/acme/board, opened here" };
    const out = await appRecent.run({}, ctxOf({ apps: { ...services.apps, origin: async (name: string) => origins[name] } }, "bob"));
    assert.deepEqual(out.items, [
      { name: "acme/board", what: "Board, on this server, repo https://github.com/acme/board, opened here" },
      { name: "strut/jamie", what: "Jamie, on this server, strut's own" },
      { name: "strut/knowledge", what: "Knowledge, on this server, strut's own: Concepts, claims and their trials" },
    ]);
  });
});

describe("meta/recent-workflows", () => {
  const listed = [
    { name: "job", activeSource: "seed" },
    { name: "old", owner: "ann" },
    { name: "busy", description: "Runs a lot" },
    { name: "off", disabled: true },
    { name: "never" },
  ].map((w) => ({ activeVersion: "v1", versions: ["v1"], ...w })) as WorkflowListEntry[];
  const last: Record<string, number> = { busy: Date.parse("2026-11-24T09:00:00Z"), old: Date.parse("2026-11-01T09:00:00Z"), job: Date.parse("2026-11-24T11:00:00Z") };
  const workspace = { listWorkflows: async () => listed };
  const store = { lastRunAt: async (name: string) => last[name] ?? null };

  it("theirs first, then the rest newest run first; strut's own seeds and disabled ones left out", async () => {
    assert.deepEqual((await recentWorkflows(workspace, store, "ann", 8)).map((w) => [w.name, w.mine]), [
      ["old", true],
      ["busy", false],
      ["never", false],
    ]);
    assert.deepEqual((await recentWorkflows(workspace, store, undefined, 8)).map((w) => w.name), ["busy", "old", "never"], "no person: the server's, newest run first");
    assert.equal((await recentWorkflows(workspace, store, "ann", 1)).length, 1);
  });

  it("the step says whose each is, and when it last ran", async () => {
    const authoring = { recentWorkflows: (actor: string | undefined, limit: number) => recentWorkflows(workspace, store, actor, limit) };
    const out = await workflowsRecent.run({}, ctxOf({ authoring }, "bob"));
    assert.deepEqual(out.items, [
      { name: "busy", what: "on this server, Runs a lot", at: "2026-11-24T09:00:00.000Z" },
      { name: "old", what: "on this server", at: "2026-11-01T09:00:00.000Z" },
      { name: "never", what: "on this server" },
    ]);
  });
});

describe("job/recent", () => {
  it("the person's jobs, newest used first, with the repositories each checked out; never another person's", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "job-recent-"));
    try {
      const jobs = jobsCapability(dataDir);
      await jobs.recordRun("j-ann", { workflow: "job", runId: "r1", actor: "ann", title: "Read experiments.md" });
      const root = jobRoot(dataDir, "j-ann");
      await mkdir(join(root, "stadeum"), { recursive: true });
      await touchJob(root, "j-ann", { dir: join(root, "stadeum"), cache: join(dataDir, "repos", "github.com", "stakwork", "stadeum.git"), ref: "main" });
      await jobs.recordRun("j-bob", { workflow: "job", runId: "r2", actor: "bob", title: "Bob's" });
      const index = createJobIndex({ dataDir, store: new MemoryRunStore() });
      const services = { jobs: index };

      const ann = await jobRecent.run({}, ctxOf(services, "ann"));
      assert.equal(ann.items.length, 1);
      assert.deepEqual([ann.items[0]!.name, ann.items[0]!.what], ["Read experiments.md", "job j-ann; github.com/stakwork/stadeum"]);
      assert.ok(ann.items[0]!.at);
      assert.deepEqual((await index.list({ actor: "ann" }))[0]!.repos, ["github.com/stakwork/stadeum"], "GET /jobs names a job's repositories");
      assert.deepEqual((await jobRecent.run({}, ctxOf(services, "cat"))).items, [], "a person with no jobs: none");
      assert.deepEqual((await jobRecent.run({}, ctxOf(services))).items, [], "no person: none");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
