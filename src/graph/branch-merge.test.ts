/**
 * MERGING a Concept branch into main (plans/concept-evals.md item e;
 * src/branch-merge.ts, src/concept-sources.ts), end to end on each engine: a
 * whole strut on a graph workspace with its history. What the branch
 * changed since its fork lands on main — ordinary pages at once, a page
 * whose text comes from git as a proposal into its checkout (strut's own in
 * dev mode, a package opened as a repo) or skipped — and the branch is
 * dropped; a page main changed too refuses it.
 *
 * Dev mode runs against a SCRATCH git checkout of strut's pages: the test
 * points strut's own sets at it (their `dir`), never at this repository's
 * `src/concepts/`.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphBackend } from "./backend.js";
import { projectionsSettled } from "./projector.js";
import { testBackends } from "./test-util.js";
import { GraphWorkspaceStore } from "./workspace-store.js";
import { parseConceptFile, PERSONAL_CONCEPTS, STRUT_CONCEPTS } from "../concept-seed.js";
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

const SHIPPED = { strut: STRUT_CONCEPTS.dir, personal: PERSONAL_CONCEPTS.dir };

for (const tb of testBackends()) describe(`merging a Concept branch, on ${tb.name}`, { skip: tb.skip }, () => {
  let backend: GraphBackend;
  let dir = "";
  let store: RunStore;
  const struts: Strut[] = [];
  const ENV = ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_DEV_CONCEPTS", "STRUT_PACKAGE_INDEXES", "STRUT_SECRET_KEY"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_PEER_KEY"];
    process.env["STRUT_PACKAGE_INDEXES"] = "[]";
    process.env["STRUT_SECRET_KEY"] = "merge-test-secret";
    backend = await tb.open();
    await tb.wipe(backend);
    const { seedStrutDomain } = await import("./schema-seed.js");
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
    dir = join(tmpdir(), `strut-merge-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    store = new MemoryRunStore();
    delete process.env["STRUT_DEV_CONCEPTS"];
  });
  afterEach(async () => {
    await projectionsSettled(backend);
    for (const s of struts.splice(0)) await s.close();
    STRUT_CONCEPTS.dir = SHIPPED.strut;
    PERSONAL_CONCEPTS.dir = SHIPPED.personal;
    delete process.env["STRUT_DEV_CONCEPTS"];
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const boot = async (): Promise<Strut> => {
    const strut = await createStrut({
      workspace: new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps") }),
      store,
      dataDir: dir,
      serveUi: false, enableChat: false, scheduler: false, stt: false, autoResume: false, wakeDelayMs: 0,
      job: false, builder: false, orchestrator: {},
    });
    struts.push(strut);
    return strut;
  };
  /** Strut's own pages in a scratch git checkout, dev mode on: what `npm run dev` from a checkout is. */
  const devCheckout = async (): Promise<string> => {
    const repo = join(dir, "checkout");
    const pages = join(repo, "src", "concepts");
    await cp(SHIPPED.strut, pages, { recursive: true });
    git(dir, "init", "--quiet", repo);
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "strut's pages");
    STRUT_CONCEPTS.dir = `${pages}/`;
    PERSONAL_CONCEPTS.dir = `${join(pages, "personal")}/`;
    process.env["STRUT_DEV_CONCEPTS"] = "1";
    return repo;
  };

  const req = (strut: Strut, path: string, init?: RequestInit) => strut.app.request(path, init);
  const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = async <T = Record<string, any>>(strut: Strut, path: string, init?: RequestInit): Promise<T> => {
    const r = await req(strut, path, init);
    assert.ok(r.status < 300, `${path}: ${r.status} ${await r.clone().text()}`);
    return (await r.json()) as T;
  };
  const post = (strut: Strut, path: string, body: unknown = {}) => json(strut, path, send("POST", body));
  const until = async <T>(find: () => Promise<T | undefined>, what: string, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await find();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`${what} never happened`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** One step as a run of its own, on `branch` or main: its summary. */
  const run = async (strut: Strut, type: string, config: Record<string, unknown>, branch?: string) => {
    const name = `step-${randomUUID().slice(0, 8)}`;
    await strut.workspace.publishWorkflowByContent(name, [`name: ${name}`, "steps:", "  - id: s", `    type: ${type}`, `    config: ${JSON.stringify(config)}`, ""].join("\n"));
    const { runId } = await post(strut, `/workflows/${name}/run`, { input: {}, ...(branch ? { branch } : {}) });
    const summary = await until(async () => {
      const s = await store.getRunSummary(name, runId);
      return s && s.status !== "running" ? s : undefined;
    }, `${name} ending`);
    // Its summary is written before it stops being in flight: a merge waits for that.
    await until(async () => ((await json(strut, "/drain"))["active"].runs === 0 ? true : undefined), `${name} untracked`);
    return summary;
  };
  /** One step as a run of its own: its output, the run a success. */
  const step = async (strut: Strut, type: string, config: Record<string, unknown>, branch?: string) => {
    const summary = await run(strut, type, config, branch);
    assert.equal(summary.status, "success", JSON.stringify(summary.error ?? summary.output));
    return summary.output as any;
  };
  const pagesIn = async (ns: string) =>
    (await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { namespace: "$ns" })} WHERE ${backend.dialect.live("c")} RETURN c.name AS name, c.docs AS docs, c.ref_id AS ref_id, c.unique_source_id AS usid`, { ns }))
      .map((r) => ({ name: String(r["name"]), docs: r["docs"] as string | undefined, ref_id: String(r["ref_id"]), usid: (r["usid"] ?? null) as string | null }));
  const pageOf = async (name: string, ns = backend.namespace) => (await pagesIn(ns)).find((p) => p.name === name);
  const linksIn = async (ns: string) =>
    (await backend.query(
      `MATCH ${backend.dialect.node("p", "Concept", { namespace: "$ns" })}-[r:PARENT_OF]->${backend.dialect.node("c", "Concept", { namespace: "$ns" })} WHERE ${backend.dialect.edgeLive("r")} AND ${backend.dialect.live("p")} AND ${backend.dialect.live("c")} RETURN p.name AS p, c.name AS c`,
      { ns },
    )).map((r) => `${r["p"]} > ${r["c"]}`).sort();
  /** Our own small tree on main: Guide > Tone. */
  const tree = async () => {
    const [guide, tone] = await backend.nodes.writeMany([
      { type: "Concept", data: { name: "Guide", description: "how we work", docs: "MAIN guide docs." } },
      { type: "Concept", data: { name: "Tone", description: "how we sound", docs: "MAIN tone docs." } },
    ]);
    await backend.edges.write({ edge: "PARENT_OF", source_ref_id: guide!.ref_id, target_ref_id: tone!.ref_id });
  };
  /** Edit a page of `branch` (or main) the way a run does: through its graph view, so the history hears it. */
  const edit = async (strut: Strut, name: string, data: Record<string, unknown>, branch?: string) => {
    const page = await pageOf(name, branch ? `branch-${branch}` : backend.namespace);
    assert.ok(page, `${name} on ${branch ?? "main"}`);
    await step(strut, "graph/edit-node", { ref_id: page.ref_id, node_data: data }, branch);
  };
  const mainLog = (strut: Strut) => strut.history!.git(["log", "--format=%s", "refs/heads/main"]);

  it("(i) on a strut with no checkout: the ordinary pages land as one commit, a page from git is skipped and listed, and the branch is dropped (a dry run first changes nothing)", async () => {
    const strut = await boot();
    await tree();
    const appBefore = await pageOf("App");
    assert.match(String(appBefore?.usid), /^strut\/concepts\/App\.md@/, "App is strut's own page, from git");
    await post(strut, "/branches", { name: "try" });
    await edit(strut, "Guide", { docs: "BRANCH guide docs." }, "try");
    await edit(strut, "App", { docs: "BRANCH app docs." }, "try");
    const guideOnTry = await pageOf("Guide", "branch-try");
    await step(strut, "graph/create-triplet", { source_ref_id: guideOnTry!.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "Lists", description: "when to use a list", docs: "BRANCH lists docs." } }, "try");
    // A new page under strut's own App is ordinary: it lands.
    const appOnTry = await pageOf("App", "branch-try");
    await step(strut, "graph/create-triplet", { source_ref_id: appOnTry!.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "App Colours", description: "an app's palette", docs: "BRANCH colours." } }, "try");
    await step(strut, "graph/delete-node", { ref_id: (await pageOf("Tone", "branch-try"))!.ref_id }, "try");

    const dry = await post(strut, "/branches/try/merge", { dryRun: true });
    assert.equal(dry["dryRun"], true);
    assert.deepEqual(dry["landed"].map((p: any) => `${p.name}:${p.change}`).sort(), ["App Colours:added", "Guide:edited", "Lists:added", "Tone:removed"]);
    assert.deepEqual(dry["skipped"].map((p: any) => [p.name, p.change]), [["App", "edited"]]);
    assert.equal((await pageOf("Guide"))?.docs, "MAIN guide docs.", "a dry run writes nothing");
    assert.equal((await json(strut, "/branches"))["branches"].length, 1, "and keeps the branch");

    const merged = await post(strut, "/branches/try/merge");
    assert.deepEqual(merged["landed"].map((p: any) => `${p.name}:${p.change}`).sort(), ["App Colours:added", "Guide:edited", "Lists:added", "Tone:removed"]);
    assert.deepEqual(merged["proposed"], []);
    assert.equal(merged["skipped"].length, 1);
    assert.equal(merged["skipped"][0].name, "App");
    assert.match(merged["skipped"][0].source, /^strut\/concepts\/App\.md$/);
    assert.match(merged["skipped"][0].why, /strut's own pages/);
    // Main has what the branch did, and its own App as it was.
    assert.equal((await pageOf("Guide"))?.docs, "BRANCH guide docs.");
    assert.equal((await pageOf("Lists"))?.docs, "BRANCH lists docs.");
    assert.equal(await pageOf("Tone"), undefined);
    assert.equal((await pageOf("App"))?.docs, appBefore!.docs);
    assert.equal((await pageOf("App"))?.usid, appBefore!.usid);
    const links = await linksIn(backend.namespace);
    assert.ok(links.includes("Guide > Lists") && links.includes("App > App Colours") && !links.includes("Guide > Tone"), links.join(", "));
    // One commit on main; the branch dropped, its git branch kept.
    assert.equal((await mainLog(strut)).split("\n")[0], "merge try");
    assert.equal(merged["commit"], (await strut.history!.git(["rev-parse", "refs/heads/main"])).trim());
    assert.match(merged["dropped"].kept.ref, /^refs\/dropped\/try\//);
    assert.deepEqual((await json(strut, "/branches"))["branches"], []);
    assert.deepEqual(await pagesIn("branch-try"), []);
    // The branch's evidence stayed on it: nothing about Guide is measured on main yet.
    assert.equal((await req(strut, "/branches/try/merge", send("POST", {}))).status, 404);
  });

  it("(v) a page main changed since the fork refuses the merge, naming it; a page only main changed stays as it is", async () => {
    const strut = await boot();
    await tree();
    await post(strut, "/branches", { name: "try" });
    await edit(strut, "Guide", { docs: "BRANCH guide docs." }, "try");
    await edit(strut, "Tone", { docs: "BRANCH tone docs." }, "try");
    await edit(strut, "Guide", { docs: "MAIN guide docs, again." });
    const r = await req(strut, "/branches/try/merge", send("POST", {}));
    assert.equal(r.status, 409);
    const body = (await r.json()) as Record<string, any>;
    assert.deepEqual(body["conflicts"], ["Guide"]);
    assert.match(body["error"], /merge_conflict: main changed Guide since branch "try" forked/);
    // Nothing merged: Tone (only the branch changed it) is main's still, and the branch is there.
    assert.equal((await pageOf("Tone"))?.docs, "MAIN tone docs.");
    assert.equal((await json(strut, "/branches"))["branches"].length, 1);

    // The same change on both sides is no conflict; a page only main changed stays.
    await post(strut, "/branches", { name: "again" });
    await edit(strut, "Tone", { docs: "SAME." }, "again");
    await edit(strut, "Tone", { docs: "SAME." });
    await edit(strut, "Guide", { docs: "MAIN guide, third." });
    const ok = await post(strut, "/branches/again/merge");
    assert.deepEqual(ok["landed"], []);
    assert.equal((await pageOf("Guide"))?.docs, "MAIN guide, third.");
    assert.equal((await pageOf("Tone"))?.docs, "SAME.");
  });

  it("(ii) dev mode in a checkout: the same merge makes ONE proposal for strut's checkout; accepting it writes the file in its own form and reloads the page from there", async () => {
    const repo = await devCheckout();
    const strut = await boot();
    await tree();
    const appBefore = await pageOf("App");
    await post(strut, "/branches", { name: "try" });
    await edit(strut, "Guide", { docs: "BRANCH guide docs." }, "try");
    await edit(strut, "App", { docs: "BRANCH app docs." }, "try");
    await edit(strut, "Game", { docs: "BRANCH game docs." }, "try");
    const merged = await post(strut, "/branches/try/merge");
    assert.deepEqual(merged["landed"].map((p: any) => p.name), ["Guide"]);
    assert.deepEqual(merged["skipped"], []);
    assert.equal(merged["proposed"].length, 1, "one proposal per checkout: App and Game were measured together");
    const [one] = merged["proposed"];
    assert.equal(one.checkout, "strut");
    assert.deepEqual(one.pages.map((p: any) => p.name).sort(), ["App", "Game"]);
    // Nothing changed in the graph or the checkout yet.
    assert.equal((await pageOf("App"))?.docs, appBefore!.docs);
    assert.equal(git(repo, "status", "--porcelain"), "");
    const rec = await json(strut, `/proposals/${one.proposal}`);
    assert.deepEqual([rec["step"], rec["status"], rec["approver"]], ["knowledge/write-pages", "pending", "admin"]);

    const done = await post(strut, `/proposals/${one.proposal}/decide`, { action: "accept" });
    assert.equal(done["status"], "applied", JSON.stringify(done["result"]));
    assert.deepEqual(done["result"].output.written.sort(), ["App.md", "Game.md"]);
    // The old form, its front matter byte for byte: a diff of the docs alone.
    const file = await readFile(join(repo, "src", "concepts", "App.md"), "utf-8");
    const shipped = await readFile(join(SHIPPED.strut, "App.md"), "utf-8");
    assert.equal(file.slice(0, file.indexOf("---", 4) + 4), shipped.slice(0, shipped.indexOf("---", 4) + 4));
    assert.equal(file.slice(file.indexOf("---", 4) + 4), "BRANCH app docs.\n");
    assert.deepEqual(git(repo, "status", "--porcelain").split("\n").map((l) => l.trim()).sort(), ["M src/concepts/App.md", "M src/concepts/Game.md"]);
    // Reloaded from there: the page's text and its new stamp.
    const app = await pageOf("App");
    assert.equal(app?.docs, "BRANCH app docs.");
    assert.notEqual(app?.usid, appBefore!.usid);
    assert.match(String(app?.usid), /^strut\/concepts\/App\.md@/);
    // A direct call writes nothing: the step runs only as an accepted proposal.
    const direct = await run(strut, "knowledge/write-pages", { checkout: "strut", pages: [{ name: "App", set: "strut/concepts/", file: "App.md", text: "---\nname: App\n---\nNOT A PERSON'S.\n" }], cause: "a test" });
    assert.equal(direct.status, "error");
    assert.match(String(direct.error?.message), /runs only as a proposal a person accepted/);
    assert.equal((await pageOf("App"))?.docs, "BRANCH app docs.");
  });

  it("(iii) a package opened as a repo: the merge's proposal writes the page into its working copy and reloads it, and Commit has it as an edit", async () => {
    const remoteDir = join(dir, "remote.git");
    await mkdir(remoteDir, { recursive: true });
    git(remoteDir, "init", "--bare", "--quiet");
    const seed = join(dir, "seed");
    git(dir, "clone", "--quiet", pathToFileURL(remoteDir).href, seed);
    await write(seed, {
      "strut.yaml": "package: acme/notes\nversion: 0.1.0\n",
      "concepts/concept-notes.md": "---\nname: Notes\ndescription: How we take notes\n---\nNOTES from the repo.\n",
    });
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "first");
    git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    const strut = await boot();
    const opened = await post(strut, "/packages/repos", { url: pathToFileURL(remoteDir).href });
    const work = opened["workdir"] as string;
    assert.match(String((await pageOf("Notes"))?.usid), /^pkg\/acme\/notes\/concept-notes\.md@/);
    await post(strut, "/branches", { name: "try" });
    await edit(strut, "Notes", { docs: "NOTES from the branch." }, "try");
    const merged = await post(strut, "/branches/try/merge");
    assert.deepEqual(merged["landed"], []);
    assert.deepEqual(merged["proposed"].map((p: any) => [p.checkout, p.pages.map((x: any) => x.name)]), [["acme/notes", ["Notes"]]]);
    assert.equal((await pageOf("Notes"))?.docs, "NOTES from the repo.");

    const done = await post(strut, `/proposals/${merged["proposed"][0].proposal}/decide`, { action: "accept" });
    assert.equal(done["status"], "applied", JSON.stringify(done["result"]));
    assert.equal(await readFile(join(work, "concepts", "concept-notes.md"), "utf-8"), "---\nname: Notes\ndescription: How we take notes\n---\nNOTES from the branch.\n");
    assert.equal((await pageOf("Notes"))?.docs, "NOTES from the branch.");
    assert.match(done["result"].output.next, /Commit/);
    // The repo has it as this workspace's edit: the next Commit writes it.
    const view = await json(strut, "/packages/repos/acme/notes");
    assert.ok(view["forked"].some((i: any) => i.kind === "concept" && i.name === "Notes"), JSON.stringify(view["forked"]));
  });

  it("(iv) knowledge/edit-page on a page from git: a proposal into strut's checkout in dev mode; skipped on a strut with none; an ordinary page is edited at once", async () => {
    // No checkout: skipped, nothing changed, nothing proposed.
    let strut = await boot();
    await tree();
    const app = await pageOf("App");
    const skipped = await step(strut, "knowledge/edit-page", { ref_id: app!.ref_id, node_data: { docs: "DREAM app docs." } });
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.note, /comes from git \(strut\/concepts\/App\.md\)/);
    assert.equal((await pageOf("App"))?.docs, app!.docs);
    assert.deepEqual((await json(strut, "/proposals"))["proposals"], []);
    const guide = await pageOf("Guide");
    const edited = await step(strut, "knowledge/edit-page", { ref_id: guide!.ref_id, node_data: { docs: "DREAM guide docs." } });
    assert.equal(edited.status, "Success");
    assert.equal((await pageOf("Guide"))?.docs, "DREAM guide docs.");
    // knowledge/add-page refuses a triplet that would change a page from git, and adds a new page under one.
    const refused = await step(strut, "knowledge/add-page", { source_ref_id: guide!.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "App", docs: "x" } });
    assert.equal(refused.status, "refused");
    const added = await step(strut, "knowledge/add-page", { source_ref_id: app!.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "App Notes", description: "notes", docs: "y" } });
    assert.ok(!added.status || added.status !== "refused", JSON.stringify(added));
    assert.ok((await linksIn(backend.namespace)).includes("App > App Notes"));
    for (const s of struts.splice(0)) await s.close();

    // Dev mode: a proposal; accepted, the file is written and the page reloaded.
    const repo = await devCheckout();
    strut = await boot();
    const page = await pageOf("Assistant Conversations");
    const pending = await step(strut, "knowledge/edit-page", { ref_id: page!.ref_id, node_data: { description: "DREAM: the turns of conversations." } });
    assert.equal(pending.status, "pending");
    assert.equal(pending.checkout, "strut");
    assert.equal((await pageOf("Assistant Conversations"))?.docs, page!.docs);
    const done = await post(strut, `/proposals/${pending.proposal}/decide`, { action: "accept" });
    assert.equal(done["status"], "applied", JSON.stringify(done["result"]));
    const file = await readFile(join(repo, "src", "concepts", "Assistant Conversations.md"), "utf-8");
    const parsed = parseConceptFile("Assistant Conversations.md", file, "");
    assert.deepEqual([parsed.name, parsed.description, parsed.parents, parsed.docs], ["Assistant Conversations", "DREAM: the turns of conversations.", ["Dream"], page!.docs]);
    assert.ok(!/^name:/m.test(file), "still the old form");
    assert.match(git(repo, "status", "--porcelain"), /Assistant Conversations\.md/);
    assert.equal((await pageOf("Assistant Conversations"))?.docs, page!.docs);
  });
});
