/**
 * A package's Concept pages through a REPO's round trip (src/packages/
 * repos.ts): a page edited here goes back to the file it has, in that
 * file's form; Diff writes nothing to the working copy or its index; a page
 * new to the package takes its key; a page renamed here moves its file.
 * Against a local bare repository, on each graph engine.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphBackend } from "../graph/backend.js";
import { projectionsSettled } from "../graph/projector.js";
import { testBackends } from "../graph/test-util.js";
import { GraphWorkspaceStore } from "../graph/workspace-store.js";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore, type RunStore } from "../store.js";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
}

/** The old form: the file names the page, its description folded nowhere. */
const CALL = "---\ndescription: The scribe of a recorded call, writing what people said onto the canvas.\nparent: Notes\n---\nCALL docs from the repo.\n";
const SCORE = "name: acme/notes/score\ndescription: Keep the score\nsteps:\n  - id: say\n    type: log\n    config: { message: one }\n";
const NOTES = "---\nname: Notes\ndescription: How we take notes\n---\nNOTES from the repo.\n";

for (const tb of testBackends()) describe(`a repo's Concept pages, on ${tb.name}`, { skip: tb.skip }, () => {
  let backend: GraphBackend;
  let dir = "";
  let store: RunStore;
  let strut: Strut;
  let remote = "";
  let work = "";
  const ENV = ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_DEV_CONCEPTS", "STRUT_PACKAGE_INDEXES", "STRUT_SECRET_KEY"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_PEER_KEY"];
    delete process.env["STRUT_DEV_CONCEPTS"];
    process.env["STRUT_PACKAGE_INDEXES"] = "[]";
    process.env["STRUT_SECRET_KEY"] = "repo-pages-test-secret";
    backend = await tb.open();
    await tb.wipe(backend);
    const { seedStrutDomain } = await import("../graph/schema-seed.js");
    await seedStrutDomain(backend);
    backend.schemas.invalidate();
  });
  after(async () => {
    await tb.close(backend);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  beforeEach(async () => {
    await tb.clear(backend);
    dir = join(tmpdir(), `strut-repo-pages-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    store = new MemoryRunStore();
    remote = join(dir, "remote.git");
    await mkdir(remote, { recursive: true });
    git(remote, "init", "--bare", "--quiet");
    const seed = join(dir, "seed");
    git(dir, "clone", "--quiet", pathToFileURL(remote).href, seed);
    await write(seed, { "strut.yaml": "package: acme/notes\nversion: 0.1.0\n", "concepts/Call Canvas.md": CALL, "concepts/concept-notes.md": NOTES, "workflows/score.yaml": SCORE });
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "first");
    git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    strut = await createStrut({
      workspace: new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps") }),
      store,
      dataDir: dir,
      serveUi: false, enableChat: false, scheduler: false, stt: false, autoResume: false, wakeDelayMs: 0,
      job: false, builder: false, orchestrator: {},
    });
    work = (await post("/packages/repos", { url: pathToFileURL(remote).href }))["workdir"] as string;
  });
  afterEach(async () => {
    await projectionsSettled(backend);
    await strut.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = async <T = Record<string, any>>(path: string, init?: RequestInit): Promise<T> => {
    const r = await strut.app.request(path, init);
    assert.ok(r.status < 300, `${path}: ${r.status} ${await r.clone().text()}`);
    return (await r.json()) as T;
  };
  const post = (path: string, body: unknown = {}) => json(path, send("POST", body));
  const until = async <T>(find: () => Promise<T | undefined>, what: string, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await find();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`${what} never happened`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** One step as a run of its own: its output, the run a success. */
  const step = async (type: string, config: Record<string, unknown>) => {
    const name = `step-${randomUUID().slice(0, 8)}`;
    await strut.workspace.publishWorkflowByContent(name, [`name: ${name}`, "steps:", "  - id: s", `    type: ${type}`, `    config: ${JSON.stringify(config)}`, ""].join("\n"));
    const { runId } = await post(`/workflows/${name}/run`, { input: {} });
    const summary = await until(async () => {
      const s = await store.getRunSummary(name, runId);
      return s && s.status !== "running" ? s : undefined;
    }, `${name} ending`);
    await until(async () => ((await json("/drain"))["active"].runs === 0 ? true : undefined), `${name} untracked`);
    assert.equal(summary.status, "success", JSON.stringify(summary.error ?? summary.output));
    return summary.output as any;
  };
  const refOf = async (name: string) => {
    const [row] = await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { namespace: "$ns" })} WHERE c.name = $name AND ${backend.dialect.live("c")} RETURN c.ref_id AS ref_id`, { ns: backend.namespace, name });
    assert.ok(row, `the page ${name}`);
    return String(row["ref_id"]);
  };
  /** A page changed in the graph since the commit installed it (as an
   *  accepted proposal, a merge or a person leaves it): its docs, by an edit. */
  const editDocs = async (name: string, from: string, to: string) => backend.nodes.update(await refOf(name), { set: {}, remove: [], edits: [{ old: from, new: to }] });
  const rename = async (from: string, to: string) => backend.nodes.update(await refOf(from), { set: { name: to }, remove: [] });
  const commit = (message: string) => post("/packages/repos/acme/notes/commit", { message, branch: "main" });
  const remoteFiles = () => git(remote, "ls-tree", "-r", "--name-only", "main").split("\n").sort();
  const remoteFile = (path: string) => spawnSync("git", ["show", `main:${path}`], { cwd: remote, encoding: "utf8" }).stdout;

  it("an edited page whose file is `Call Canvas.md` stays at that path, its front matter kept, and Diff touches neither the working copy nor its index", async () => {
    await editDocs("Call Canvas", "CALL docs from the repo.", "CALL docs edited here.");
    const status = git(work, "status", "--porcelain");
    const index = git(work, "write-tree");
    const head = git(work, "rev-parse", "HEAD");

    const diff = await json("/packages/repos/acme/notes/diff");
    assert.deepEqual(diff["files"], [{ path: "concepts/Call Canvas.md", status: "modified" }]);
    assert.match(diff["patch"], /\+CALL docs edited here\./);
    assert.doesNotMatch(diff["patch"], /^[-+]description|^[-+]---/m, "the front matter is not rewritten");
    // Viewing the diff wrote and staged nothing.
    assert.equal(git(work, "status", "--porcelain"), status);
    assert.equal(git(work, "write-tree"), index);
    assert.equal(git(work, "rev-parse", "HEAD"), head);
    assert.equal(await readFile(join(work, "concepts", "Call Canvas.md"), "utf8"), CALL);
    assert.doesNotMatch(git(work, "worktree", "list"), /diff-/, "the scratch worktree is gone");

    await commit("Edit the call page");
    assert.deepEqual(remoteFiles(), ["concepts/Call Canvas.md", "concepts/concept-notes.md", "strut.yaml", "workflows/score.yaml"]);
    assert.equal(remoteFile("concepts/Call Canvas.md"), CALL.replace("CALL docs from the repo.", "CALL docs edited here."));
    assert.equal(remoteFile("concepts/concept-notes.md"), NOTES, "an untouched page is left as it is");
  });

  it("a page new to the package is written under its key", async () => {
    await step("graph/create-triplet", { source_ref_id: await refOf("Notes"), edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "Meeting Notes", description: "notes of a meeting", docs: "MEETING docs." } });
    const diff = await json("/packages/repos/acme/notes/diff");
    assert.deepEqual(diff["files"], [{ path: "concepts/concept-meetingnotes.md", status: "added" }]);
    await commit("Add a page");
    assert.ok(remoteFiles().includes("concepts/concept-meetingnotes.md"), remoteFiles().join(", "));
    assert.match(remoteFile("concepts/concept-meetingnotes.md"), /name: Meeting Notes[\s\S]*MEETING docs\./);
  });

  it("a page renamed here moves its file: named after the page where the old one was, else by its key", async () => {
    await rename("Call Canvas", "Call Scribe");
    await rename("Notes", "Field Notes");
    const diff = await json("/packages/repos/acme/notes/diff");
    assert.deepEqual(
      diff["files"].map((f: any) => `${f.status} ${f.path}`).sort(),
      ["added concepts/Call Scribe.md", "added concepts/concept-fieldnotes.md", "deleted concepts/Call Canvas.md", "deleted concepts/concept-notes.md"],
    );
    await commit("Rename two pages");
    assert.deepEqual(remoteFiles(), ["concepts/Call Scribe.md", "concepts/concept-fieldnotes.md", "strut.yaml", "workflows/score.yaml"]);
    assert.match(remoteFile("concepts/concept-fieldnotes.md"), /name: Field Notes[\s\S]*NOTES from the repo\./);
    assert.match(remoteFile("concepts/Call Scribe.md"), /CALL docs from the repo\./);
  });
});
