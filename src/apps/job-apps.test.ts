import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createStrut, type Strut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, type StepRegistry } from "../core.js";
import { FileWorkspaceStore } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { appOfIdentity, fileToken, jobAppIdentity, scopePath } from "../auth.js";
import { resolveArtifactRefs } from "../artifact-refs.js";
import { jobRoot } from "../jobs.js";
import { kitForTests } from "../test-util/app-kit.js";
import type { KitLocation } from "./kit.js";
import { STEP_RUN_TOOL, buildAppTools, grantRefusal } from "./tools.js";
import { parseManifest } from "./manifest.js";

/**
 * Job apps (plans/apps.md §6, §7.2, §14): an app the job's agent writes in
 * the job's directory and hands over as `{ kind: "app", path }`. The
 * deliverable resolves to its document with its build; `app/build` in the
 * job tells the job's host; the job's file token NARROWED to the app's
 * directory opens that subtree and nothing else, and the document read by
 * it carries the app's identity; `step_run` under that identity reads the
 * manifest from the job's files, sets `ctx.app = { job, path }`, and holds
 * the app's own job — its runs, files and record — and no other's; errors
 * are kept per `{ job, path }` and `app/get { path }` reads them with
 * `stale`; a person publishes the job's app to the workspace.
 */

const KEY = "job-apps-key";
const auth = { authorization: `Bearer ${KEY}`, "x-strut-actor": "viewer" };

const whoami = defineStep({
  type: "whoami",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    return { app: ctx.app ?? null, job: ctx.job ?? null, actor: ctx.actor ?? null };
  },
});

const WORKFLOWS: Record<string, string> = {
  // A turn of the job that builds its app and hands it over.
  "make-app": [
    "name: make-app",
    "steps:",
    "  - id: dir",
    "    type: job/dir",
    "  - id: build",
    "    type: app/build",
    "    config: { path: apps/tracker }",
    "  - id: out",
    "    type: pack",
    "    config:",
    "      text: built",
    "      artifacts: [{ id: tracker, kind: app, title: Visit tracker, path: apps/tracker }]",
    "",
  ].join("\n"),
  // Another workflow the job runs (not granted to the app).
  "note-wf": "name: note-wf\nsteps:\n  - id: dir\n    type: job/dir\n  - id: w\n    type: log\n    config: { message: noted }\n",
  "score-wf": "name: score-wf\nsteps:\n  - id: w\n    type: whoami\n",
};

const TRACKER_YAML = "title: Visit tracker\ngrants:\n  workflows: [score-wf]\n  steps: [whoami]\n";
const APP_TSX = 'export default function App() { return <p className="p-2">visits</p>; }\n';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("job apps (plans/apps.md §6)", () => {
  let kit: KitLocation;
  let root: string;
  let dataDir: string;
  let strut: Strut;
  let registry: StepRegistry;
  const store = new MemoryRunStore();
  let savedKey: string | undefined;
  const posts: any[] = [];
  let hostUrl = "";
  let closeHost = () => {};
  let tools: ReturnType<typeof buildAppTools>;
  let identity: string;
  const runs: Record<string, string> = {};

  const api = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await strut.app.request(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(init.headers ?? auth) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 400 && !cond(); i++) await sleep(25);
    assert.ok(cond(), "condition never held");
  };
  const launch = async (workflow: string, job: string, extra: Record<string, unknown> = {}) => {
    const r = await api(`/workflows/${workflow}/run`, { body: { job, input: {}, ...extra } });
    assert.equal(r.status, 202, r.text);
    const runId = r.json.runId as string;
    for (let i = 0; i < 400 && !(await store.getRunSummary(workflow, runId)); i++) await sleep(25);
    const summary = await store.getRunSummary(workflow, runId);
    assert.equal(summary?.status, "success", JSON.stringify(summary?.error));
    return runId;
  };
  const writeApp = async (job: string, path: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(jobRoot(dataDir, job), path, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text, "utf8");
    }
  };
  const call = async (args: Record<string, unknown>) =>
    (await (tools[STEP_RUN_TOOL] as any).execute(args, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
  const ok = async (args: Record<string, unknown>) => {
    const r = await call({ app: identity, ...args });
    assert.equal(r.error, undefined, r.error);
    return r.result;
  };
  const refused = async (args: Record<string, unknown>, re: RegExp) => {
    const r = await call({ app: identity, ...args });
    assert.ok(r.error, `expected a refusal, got ${String(JSON.stringify(r.result)).slice(0, 200)}`);
    assert.match(r.error, re);
  };

  before(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-job-apps-"));
    dataDir = join(root, "ws");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        posts.push(JSON.parse(body));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    hostUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    closeHost = () => server.close();
    registry = await createRegistry([whoami]);
    const workspace = new FileWorkspaceStore(dataDir);
    strut = await createStrut({
      workspace,
      store,
      registry,
      kit,
      dataDir,
      scheduler: false,
      enableChat: true,
      serveUi: false,
      job: false,
      orchestrator: false,
      builder: false,
      browserWorkflows: false,
      views: false,
    });
    for (const [name, yaml] of Object.entries(WORKFLOWS)) await workspace.publishWorkflowByContent(name, yaml);
    await writeApp("j1", "apps/tracker", { "app.yaml": TRACKER_YAML, "src/App.tsx": APP_TSX });
    await writeApp("j1", "", { "notes.md": "# the job's notes\n", "visits.csv": "date,customer\n2026-10-01,Henderson\n" });
    tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, actor: "viewer", runStepDeps: { store, workspace } });
    identity = jobAppIdentity("j1", "apps/tracker");
  });
  after(async () => {
    closeHost();
    await strut?.close?.().catch(() => {});
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(root, { recursive: true, force: true });
  });

  it("app/build in the job's directory builds the app and tells the job's host; the deliverable resolves to its document with its build — on run.end and …/artifacts", async () => {
    const runId = await launch("make-app", "j1", { jobCallback: { url: hostUrl }, callback: { url: hostUrl } });
    runs["make-app"] = runId;
    await until(() => posts.some((p) => p.event === "job.update" && p.kind === "app") && posts.some((p) => p.event === "run.end"));
    const update = posts.find((p) => p.event === "job.update" && p.kind === "app");
    const build = JSON.parse(await readFile(join(jobRoot(dataDir, "j1"), "apps/tracker/dist/build.json"), "utf8")) as { hash: string; builtAt: string };
    assert.deepEqual(
      [update.job, update.runId, update.state, update.id, update.url, update.title, update.detail.path, update.detail.hash],
      ["j1", runId, "built", "apps/tracker", "/jobs/j1/files/apps/tracker/dist/index.html", "Visit tracker", "apps/tracker", build.hash],
    );
    const expected = {
      id: "tracker",
      kind: "app",
      title: "Visit tracker",
      url: "/jobs/j1/files/apps/tracker/dist/index.html",
      app: { job: "j1", path: "apps/tracker", hash: build.hash, builtAt: build.builtAt },
    };
    const end = posts.find((p) => p.event === "run.end" && p.runId === runId);
    assert.deepEqual(end.output.artifacts[0], { id: "tracker", kind: "app", title: "Visit tracker", path: "apps/tracker" }, "output stays as packed");
    assert.deepEqual(end.artifacts, [expected], "run.end carries it resolved");
    assert.deepEqual((await api(`/workflows/make-app/runs/${runId}/artifacts`)).json.artifacts, [expected]);
    const job = (await api("/jobs/j1")).json;
    assert.deepEqual({ ...job.artifacts[0], runId: undefined, path: undefined }, { ...expected, runId: undefined, path: undefined }, "the job's current deliverables too");
  });

  it("an app not built is a deliverable that says so; a directory holding app.yaml is an app with no kind given; a path out is refused; without a job, a link under the run's artifacts and no `app`", async () => {
    const files = new Set(["/jobs/j/files/apps/a/app.yaml", "/jobs/j/files/apps/b/app.yaml", "/jobs/j/files/apps/b/dist/index.html", "/artifacts/7/apps/b/dist/index.html"]);
    const exists = async (u: string) => files.has(u);
    const appBuild = async () => ({ hash: "h1", builtAt: "2026-10-21T00:00:00.000Z" });
    const refs = await resolveArtifactRefs(
      {
        artifacts: [
          { id: "a", kind: "app", title: "A", path: "apps/a" },
          { id: "b", title: "B", path: "./apps/b/" },
          { id: "c", kind: "app", title: "C", path: "apps/../../x" },
          { id: "d", kind: "app", title: "D", path: "apps/none" },
        ],
      },
      { runId: "7", job: "j", exists, appBuild },
    );
    assert.deepEqual(refs, [
      { id: "a", kind: "app", title: "A", error: "not built: no dist/index.html in apps/a — app/build writes it" },
      { id: "b", kind: "app", title: "B", url: "/jobs/j/files/apps/b/dist/index.html", app: { job: "j", path: "apps/b", hash: "h1", builtAt: "2026-10-21T00:00:00.000Z" } },
      { id: "c", kind: "app", title: "C", error: "bad path" },
      { id: "d", kind: "app", title: "D", error: "not found" },
    ]);
    const plain = await resolveArtifactRefs({ artifacts: [{ id: "b", kind: "app", title: "B", path: "apps/b" }] }, { runId: "7", exists, appBuild });
    assert.deepEqual(plain, [{ id: "b", kind: "app", title: "B", url: "/artifacts/7/apps/b/dist/index.html" }]);
  });

  it("the job's files listing narrowed by ?path= mints a token that opens the app's files and nothing else of the job; the document read by it carries the app's identity and may run", async () => {
    const listed = await api("/jobs/j1/files?path=apps/tracker/");
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.path, "apps/tracker");
    assert.ok(listed.json.files.includes("app.yaml") && listed.json.files.includes("dist/index.html") && listed.json.files.includes("src/App.tsx"), listed.text);
    assert.ok(!listed.json.files.some((f: string) => f.includes("notes.md")), "the subtree only");
    const t = listed.json.token as string;
    assert.equal(t, fileToken({ kind: "job", id: "j1", path: "apps/tracker" }));
    assert.notEqual(t, fileToken({ kind: "job", id: "j1" }), "not the whole job's token");
    assert.equal((await api("/jobs/j1/files?path=apps/nope")).status, 404);
    assert.equal((await api("/jobs/j1/files?path=../j2")).status, 400);

    // The document, read by the narrowed token with no other credential.
    const doc = await api(`/jobs/j1/files/apps/tracker/dist/index.html?t=${encodeURIComponent(t)}`, { headers: {} });
    assert.equal(doc.status, 200, doc.text.slice(0, 200));
    assert.match(doc.text, new RegExp(`<meta name="strut-app-token" content="job:j1/apps/tracker\\.${t}">`));
    assert.equal(doc.headers.get("content-security-policy"), "sandbox allow-scripts");
    assert.deepEqual(appOfIdentity(jobAppIdentity("j1", "apps/tracker")), { job: "j1", path: "apps/tracker" });
    // Its own files open; nothing else of the job does — nor another job's, nor another path's.
    assert.equal((await api(`/jobs/j1/files/apps/tracker/app.yaml?t=${encodeURIComponent(t)}`, { headers: {} })).status, 200);
    assert.equal((await api(`/jobs/j1/files?path=apps/tracker&t=${encodeURIComponent(t)}`, { headers: {} })).status, 200, "its own listing");
    assert.equal((await api(`/jobs/j1/files/notes.md?t=${encodeURIComponent(t)}`, { headers: {} })).status, 401);
    assert.equal((await api(`/jobs/j1/files?t=${encodeURIComponent(t)}`, { headers: {} })).status, 401, "the whole job's listing");
    assert.equal((await api(`/jobs/j1/files/apps/tracker/../../notes.md?t=${encodeURIComponent(t)}`, { headers: {} })).status, 401, "never by `..`");
    assert.equal((await api(`/jobs/j1/files/apps/tracker%2F..%2F..%2Fnotes.md?t=${encodeURIComponent(t)}`, { headers: {} })).status, 401, "nor an encoded one");
    assert.equal((await api(`/jobs/j2/files/apps/tracker/app.yaml?t=${encodeURIComponent(t)}`, { headers: {} })).status, 401, "another job");
    const other = fileToken({ kind: "job", id: "j1", path: "apps/other" })!;
    assert.equal((await api(`/jobs/j1/files/apps/tracker/app.yaml?t=${encodeURIComponent(other)}`, { headers: {} })).status, 401, "another path's token");
    // Read any other way, the document is a file: no identity in it.
    const whole = fileToken({ kind: "job", id: "j1" })!;
    const asFile = await api(`/jobs/j1/files/apps/tracker/dist/index.html?t=${encodeURIComponent(whole)}`, { headers: {} });
    assert.equal(asFile.status, 200);
    assert.match(asFile.text, /<meta name="strut-app-token" content="">/);
    const byKey = await api("/jobs/j1/files/apps/tracker/dist/index.html");
    assert.match(byKey.text, /<meta name="strut-app-token" content="">/);
    assert.equal(byKey.headers.get("content-security-policy"), "sandbox");
    // The identity's spelling is canonical, its token the path's.
    assert.equal(appOfIdentity(`job:j1/apps/tracker/.${t}`), undefined);
    assert.equal(appOfIdentity(`job:j1/apps/other.${t}`), undefined);
    assert.equal(appOfIdentity(`job:j2/apps/tracker.${t}`), undefined);
    assert.equal(appOfIdentity("job:j1/apps/tracker."), undefined, "unsigned, on a strut that signs");
    assert.equal(scopePath("./apps//tracker/"), "apps/tracker");
    assert.equal(scopePath("apps/../x"), undefined);
  });

  it("step_run with a job app's identity: the manifest from the job's files, ctx.app { job, path }, its own job's runs, files and record — and no other job's — under its grants", async () => {
    const noteJ1 = await launch("note-wf", "j1");
    const noteJ2 = await launch("note-wf", "j2");
    await writeApp("j2", "", { "secret.md": "j2's\n" });

    // The manifest is the job's file; ctx.app is the job app.
    assert.deepEqual(await ok({ type: "whoami", config: {} }), { app: { job: "j1", path: "apps/tracker" }, job: null, actor: "viewer" });
    // Its own job's runs, across workflows — the turn that built it and the note.
    const listed = (await ok({ type: "run/list", config: { job: "j1" } })) as Array<{ runId: string; workflow: string }>;
    assert.deepEqual(new Set(listed.map((r) => `${r.workflow}/${r.runId}`)), new Set([`make-app/${runs["make-app"]}`, `note-wf/${noteJ1}`]));
    await refused({ type: "run/list", config: { job: "j2" } }, /reads its own job \(j1\) and no other/);
    await refused({ type: "run/list", config: {} }, /needs `workflow` \(or `job`/);
    // One run of its job, on a workflow it was never granted; not another job's run of it.
    assert.equal((await ok({ type: "run/get", config: { workflow: "note-wf", runId: noteJ1 } })).job, "j1");
    assert.equal((await ok({ type: "run/events", config: { workflow: "note-wf", runId: noteJ1 } })).at(-1).type, "run.end");
    await refused({ type: "run/get", config: { workflow: "note-wf", runId: noteJ2 } }, /not granted .* nor is run .* one of this app's job \(j1\)/);
    await refused({ type: "run/events", config: { workflow: "note-wf", runId: noteJ2 } }, /not granted/);
    await refused({ type: "run/launch", config: { workflow: "note-wf" } }, /not granted/);
    // Its own job's files and record.
    assert.equal((await ok({ type: "run/files", config: { job: "j1", path: "visits.csv" } })).text, "date,customer\n2026-10-01,Henderson\n");
    await refused({ type: "run/files", config: { job: "j2", path: "secret.md" } }, /its own job \(j1\)/);
    const rec = await ok({ type: "job/get", config: { job: "j1" } });
    assert.equal(rec.job, "j1");
    assert.equal((await ok({ type: "job/read", config: { job: "j1", path: "notes.md" } })).text, "# the job's notes\n");
    await refused({ type: "job/get", config: { job: "j2" } }, /reads its own job \(j1\) and no other/);
    await refused({ type: "job/read", config: { job: "j2", path: "secret.md" } }, /no other/);
    // Its grants still apply: an ungranted step, a paid one, a granted workflow.
    await refused({ type: "graph/graph-search", config: { query: "x" } }, /not granted .* grants\.steps: whoami/);
    await refused({ type: "llm", config: {} }, /paid or shell-shaped/);
    await refused({ type: "app/publish", config: {} }, /does not author apps/);
    const scored = await ok({ type: "run/launch", config: { workflow: "score-wf" } });
    const got = await ok({ type: "run/get", config: { workflow: "score-wf", runId: scored.runId, wait: 10_000 } });
    assert.deepEqual([got.origin, got.app, got.output.app], ["app", { job: "j1", path: "apps/tracker" }, { job: "j1", path: "apps/tracker" }], "a run it launches works for it");
    // A token for the whole job, a run's files, another path: no app.
    await refused({ type: "whoami", config: {}, app: fileToken({ kind: "job", id: "j1" }) }, /not a valid app identity/);
    await refused({ type: "whoami", config: {}, app: jobAppIdentity("j1", "apps/none") }, /no app at apps\/none in job j1/);
    // The pure check.
    const m = parseManifest("title: T\n");
    assert.ok(m.ok);
    assert.equal(grantRefusal("job/get", { job: "j" }, m.manifest, registry, { job: "j", path: "a" }), null);
    assert.match(grantRefusal("job/get", { job: "j" }, m.manifest, registry, { name: "n", version: "v1" })!, /not granted/, "a workspace app holds no job");
    assert.match(grantRefusal("job/get", { job: "{{ input.j }}" }, m.manifest, registry, { job: "j", path: "a" })!, /literal job id/);
  });

  it("errors are kept per { job, path }; app/get { path } returns them, and says stale after an edit until app/build runs", async () => {
    const r = await ok({ type: "app/report-error", config: { message: "boom", stack: "at x" } });
    assert.equal(r.ok, true);
    const kept = await store.listRuns("step:app/report-error");
    const summary = (await store.getRunSummary("step:app/report-error", kept[0]!))!;
    assert.deepEqual([summary.actor, summary.app], ["viewer", { job: "j1", path: "apps/tracker" }]);

    const get = () => strut.apps.getDir(join(jobRoot(dataDir, "j1"), "apps/tracker"), { job: "j1", path: "apps/tracker" });
    let view = await get();
    assert.equal(view.stale, false);
    assert.equal(view.manifest?.title, "Visit tracker");
    assert.deepEqual(view.errors?.map((e) => [e.message, e.version, e.runId]), [["boom", undefined, kept[0]]]);
    // Another job's app at the same path keeps its own.
    assert.deepEqual(await strut.apps.errorsOf({ job: "j2", path: "apps/tracker" }), []);
    assert.deepEqual(await strut.apps.errorsOf("apps/tracker"), [], "nor is it a workspace app's");
    await writeApp("j1", "apps/tracker", { "src/App.tsx": APP_TSX.replace("visits", "visits!") });
    view = await get();
    assert.equal(view.stale, true, "an edit since the build");
    const { default: appGet } = await import("../steps/lib/app/get.js");
    const ctx = { runId: "r", job: "j1", services: strut.services } as any;
    const read = (await appGet.run({ path: "apps/tracker" } as any, ctx)) as { stale: boolean; errors: unknown[]; job: string; path: string };
    assert.deepEqual([read.stale, read.job, read.path, read.errors.length], [true, "j1", "apps/tracker", 1]);
    const { default: appBuild } = await import("../steps/lib/app/build.js");
    const built = (await appBuild.run({ path: "apps/tracker" } as any, ctx)) as { ok: boolean; clientErrors: unknown[] };
    assert.equal(built.ok, true);
    assert.equal(built.clientErrors.length, 1, "the build answers with the page's errors");
    assert.equal(((await appGet.run({ path: "apps/tracker" } as any, ctx)) as { stale: boolean }).stale, false);
    await assert.rejects(appBuild.run({ path: "../j2" } as any, ctx), /leaves the job's directory/);
  });

  it("a job app's grants are a model's: app/build in a job refuses llm, agent or exec in grants.steps", async () => {
    await writeApp("j1", "apps/paid", { "app.yaml": "title: Paid\ngrants:\n  steps: [llm]\n", "src/App.tsx": APP_TSX });
    const { default: appBuild } = await import("../steps/lib/app/build.js");
    const built = (await appBuild.run({ path: "apps/paid" } as any, { runId: "r", job: "j1", services: strut.services } as any)) as { ok: boolean; errors: string[] };
    assert.equal(built.ok, false);
    assert.match(built.errors.join("\n"), /"llm" is a paid or shell-shaped step/);
  });

  it("POST /apps { name, job, path } publishes the job's app as the workspace app's next version — a person's door; data.db along only when the app has none; the job's directory untouched", async () => {
    const dir = join(jobRoot(dataDir, "j1"), "apps/tracker");
    await writeFile(join(dir, "data.db"), "job rows v1");
    const distBefore = await readFile(join(dir, "dist/index.html"), "utf8");
    const first = await api("/apps", { body: { name: "visits", job: "j1", path: "apps/tracker" } });
    assert.equal(first.status, 201, first.text);
    assert.deepEqual([first.json.ok, first.json.name, first.json.version], [true, "visits", "v1"]);
    const view = (await api("/apps/visits")).json;
    assert.equal(view.manifest.title, "Visit tracker");
    assert.ok(view.files.includes("dist/index.html") && !view.files.includes("data.db"));
    const appFolder = dirname(view.dir);
    assert.equal(await readFile(join(appFolder, "data.db"), "utf8"), "job rows v1", "the job's data comes along");
    assert.equal(await readFile(join(dir, "dist/index.html"), "utf8"), distBefore, "the job's own document is the agent's");
    // A person's door: grants a model may not write are theirs to give.
    await writeApp("j1", "apps/paid", {});
    assert.equal((await api("/apps", { body: { name: "paid-from-job", job: "j1", path: "apps/paid" } })).status, 201);
    // The next version never overwrites the workspace app's data.
    await writeFile(join(dir, "data.db"), "job rows v2");
    await writeApp("j1", "apps/tracker", { "src/App.tsx": APP_TSX.replace("visits", "visits v2") });
    const second = await api("/apps", { body: { name: "visits", job: "j1", path: "apps/tracker" } });
    assert.deepEqual([second.status, second.json.version], [201, "v2"]);
    assert.equal(await readFile(join(appFolder, "data.db"), "utf8"), "job rows v1");
    // Refusals.
    assert.equal((await api("/apps", { body: { name: "x", job: "j1", path: "apps/none" } })).status, 404);
    assert.equal((await api("/apps", { body: { name: "x", job: "j1", path: "../j2" } })).status, 400);
    assert.equal((await api("/apps", { body: { name: "x", job: "j1", path: "apps/tracker", files: { "app.yaml": "title: X\n" } } })).status, 400);
    assert.equal((await api("/apps", { body: { name: "x", job: "bad//id", path: "apps/tracker" } })).status, 400);
    assert.ok(existsSync(join(dir, "app.yaml")));
  });

  it("/mcp: a tools/call of step_run with a job app's token reads that app's manifest from the job's files and applies its grants", async () => {
    const rpc = async (args: Record<string, unknown>) => {
      const res = await strut.app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: args } }),
      });
      const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "))!;
      return JSON.parse(line.slice(6)).result;
    };
    const me = await rpc({ type: "whoami", config: {}, app: identity });
    assert.equal(me.isError, undefined, JSON.stringify(me));
    assert.deepEqual(me.structuredContent, { app: { job: "j1", path: "apps/tracker" }, job: null, actor: "viewer" });
    const no = await rpc({ type: "job/get", config: { job: "j2" }, app: identity });
    assert.equal(no.isError, true);
  });
});
