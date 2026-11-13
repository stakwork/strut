/**
 * The HISTORY (plans/concept-history.md §8, items 2 and 3): src/history.ts —
 * the snapshot, the touches, the commits — and the `history/read` step, on
 * every graph backend. Commits are read back with `git log` through the
 * history's own read door; a test settles the queue (`settle`, the
 * read-your-writes the step uses) instead of waiting out the debounce.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStrut, type Strut } from "./createStrut.js";
import type { StepContext } from "./core.js";
import type { GraphBackend } from "./graph/backend.js";
import { seedStrutDomain } from "./graph/schema-seed.js";
import { testBackends } from "./graph/test-util.js";
import { scopedBackend } from "./graph/scope.js";
import { GraphWorkspaceStore } from "./graph/workspace-store.js";
import { findGit, HISTORY_DIR, HISTORY_EMAIL } from "./history.js";
import { buildPackage } from "./packages/build.js";
import { packageCache } from "./packages/cache.js";
import { MemoryRunStore } from "./store.js";
import { kitForTests } from "./test-util/app-kit.js";

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A step that writes `ctx.services.graph` itself: no graph/* step in the way. */
const CONCEPT_STEP = `import { z, defineStep } from "strut";
export default defineStep({
  type: "t/concept",
  input: z.object({ op: z.string(), name: z.string(), docs: z.string().optional(), parent: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    const g = ctx.services.graph;
    const d = g.dialect;
    const find = async (name) => (await g.query(\`MATCH \${d.node("c", "Concept", { name: "$name" })} WHERE \${d.live("c")} RETURN c.ref_id AS r\`, { name }))[0]?.r;
    if (cfg.op === "create") {
      const { ref_id } = await g.nodes.write({ type: "Concept", data: { name: cfg.name, ...(cfg.docs ? { docs: cfg.docs } : {}) } }, "upsert");
      if (cfg.parent) await g.edges.write({ edge: "PARENT_OF", source_ref_id: await find(cfg.parent), target_ref_id: ref_id });
      return { ref_id };
    }
    const ref = await find(cfg.name);
    await g.nodes.update(ref, { set: { docs: cfg.docs } });
    return { ref_id: ref };
  },
});
`;
const CONCEPT_WF = `name: t-concept
steps:
  - id: write
    type: t/concept
    config: { op: "{{ input.op }}", name: "{{ input.name }}", docs: "{{ input.docs }}", parent: "{{ input.parent }}" }
`;
/** The graph/* steps, one workflow each. */
const GRAPH_WFS: Record<string, string> = {
  "c-create": `name: c-create
steps:
  - id: make
    type: graph/create-triplet
    config: { source_ref_id: "{{ input.parent }}", edge_type: PARENT_OF, target_type: Concept, target_data: "{{ input.data }}" }
`,
  "c-edit": `name: c-edit
steps:
  - id: edit
    type: graph/edit-node
    config: { ref_id: "{{ input.ref }}", node_data: "{{ input.data }}" }
`,
  "c-move": `name: c-move
steps:
  - id: move
    type: graph/move-node
    config: { ref_id: "{{ input.ref }}", edge_type: PARENT_OF, direction: reverse, to_ref_id: "{{ input.to }}" }
`,
  "c-delete": `name: c-delete
steps:
  - id: delete
    type: graph/delete-node
    config: { ref_id: "{{ input.ref }}" }
`,
  "c-instance": `name: c-instance
steps:
  - id: make
    type: graph/create-node
    config: { node_type: "{{ input.type }}", node_data: "{{ input.data }}" }
`,
  "c-schema": `name: c-schema
steps:
  - id: schema
    type: graph/create-schema
    config: { type: "{{ input.type }}", attributes: "{{ input.attributes }}", key: "{{ input.key }}" }
`,
  "c-triplet": `name: c-triplet
steps:
  - id: link
    type: graph/create-triplet
    config: { source_type: "{{ input.s }}", source_data: "{{ input.sd }}", edge_type: "{{ input.edge }}", target_type: "{{ input.t }}", target_data: { name: "{{ input.b }}" }, create_schema_if_missing: true }
`,
};

const LONG = "One paragraph of the page's docs, long enough that git pairs the file across a rename by its content. ".repeat(6);

const gitMissing = await findGit().then((g) => ("missing" in g ? g.missing : false));

for (const tb of testBackends()) {
  describe(`the history (${tb.name})`, { skip: tb.skip || gitMissing }, () => {
    let backend: GraphBackend;
    let scratch: string;
    const struts: Strut[] = [];
    before(async () => {
      backend = await tb.open();
      await tb.wipe(backend);
      await seedStrutDomain(backend);
      backend.schemas.invalidate();
    });
    after(async () => {
      await tb.close(backend);
    });
    beforeEach(async () => {
      await tb.clear(backend);
      backend.schemas.invalidate();
      scratch = await mkdtemp(join(tmpdir(), "strut-history-"));
    });
    afterEach(async () => {
      for (const s of struts.splice(0)) await s.close();
      await rm(scratch, { recursive: true, force: true });
    });

    const boot = async (extra: Record<string, unknown> = {}, dir = join(scratch, `s${struts.length}`)) => {
      const s = await createStrut({
        workspace: new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps"), appsDir: join(dir, "apps") }),
        dataDir: dir,
        store: new MemoryRunStore(),
        serveUi: false,
        scheduler: false,
        enableChat: false,
        systemWorkflows: false,
        browserWorkflows: false,
        privacyWorkflows: false, mediaWorkflows: false,
        job: false,
        orchestrator: false,
        builder: false,
        views: false,
        jamie: false,
        knowledge: false,
        stt: false,
        concepts: false,
        history: true,
        ...extra,
      });
      struts.push(s);
      return s;
    };
    /** Booted, the step and the workflows published, the boot commit in. */
    const ready = async (extra: Record<string, unknown> = {}) => {
      const s = await boot(extra);
      await s.workspace.publishStep("t/concept", CONCEPT_STEP);
      await s.workspace.createWorkflow("t-concept", CONCEPT_WF);
      for (const [name, yaml] of Object.entries(GRAPH_WFS)) await s.workspace.createWorkflow(name, yaml);
      await s.rebuildRegistry();
      await s.history!.settle();
      return s;
    };
    const git = (s: Strut, args: string[]) => s.history!.git(args);
    /** Every commit, newest first: id, author, the whole message. */
    const commits = async (s: Strut) => {
      await s.history!.settle();
      const out = await git(s, ["log", "--format=%x1e%H%x1f%an%x1f%ae%x1f%B", "refs/heads/main"]).catch(() => "");
      return out
        .split("\x1e")
        .filter((c) => c.trim())
        .map((c) => {
          const [id, author, email, body] = c.split("\x1f");
          return { id: id!, author: author!, email: email!, body: body!.trim(), subject: body!.trim().split("\n")[0]! };
        });
    };
    /** The paths a commit changed, with git's status letter. */
    const changed = async (s: Strut, id: string) =>
      (await git(s, ["show", "--name-status", "--format=", "-M", id])).split("\n").filter(Boolean).map((l) => l.split("\t"));
    const fileAt = (s: Strut, id: string, path: string) => git(s, ["show", `${id}:${path}`]);
    const ref = async (name: string) =>
      ((await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { name: "$name" })} WHERE ${backend.dialect.live("c")} RETURN c.ref_id AS r`, { name }))[0]?.["r"] as string | undefined);
    const run = async (s: Strut, wf: string, input: Record<string, unknown>, actor = "ada") => {
      const r = await s.run(wf, input, { actor });
      assert.equal(r.status, "success", JSON.stringify(r.error ?? r.output));
      // A graph/* step answers a failure as text, for a model to read.
      if (typeof r.output === "string") assert.fail(r.output);
      return r;
    };
    /** history/read, as an agent's tool call would run it. */
    const read = async (s: Strut, input: Record<string, unknown>, services?: unknown) => {
      const def = s.getRegistry()["history/read"]!;
      const ctx = { runId: "t", path: "t/read", scope: {}, input: {}, emit: async () => {}, services: services ?? s.services, actor: "ada" } as unknown as StepContext;
      return (await def.run(def.input.parse(input), ctx)) as Record<string, any>;
    };

    it("boots with one commit holding a page strut seeded and a page with / in its name", async () => {
      // A page with / in its name before boot, strut's own pages seeded at boot.
      await backend.nodes.write({ type: "Concept", data: { name: "acme/linear", description: "A repository", docs: "Its code." } }, "create");
      const s = await boot({ concepts: undefined });
      const log = await commits(s);
      assert.equal(log.length, 1);
      assert.equal(log[0]!.subject, "boot");
      assert.equal(log[0]!.author, "strut");
      assert.equal(log[0]!.email, HISTORY_EMAIL);
      const files = (await git(s, ["ls-tree", "-r", "--name-only", log[0]!.id])).split("\n");
      assert.ok(files.includes("concepts/concept-job.md"), files.join(", "));
      assert.ok(files.includes("concepts/concept-acmelinear.md"));
      assert.ok(files.includes("graph/Concept.yaml"));
      assert.ok(files.includes("strut.yaml"));
      assert.match(await fileAt(s, log[0]!.id, "concepts/concept-acmelinear.md"), /^---\nname: acme\/linear\ndescription: A repository\n---\nIts code.\n$/);
      // A second boot over the same data: nothing changed, nothing committed.
      await s.close();
      struts.splice(struts.indexOf(s), 1);
      const again = await createStrut({ workspace: new GraphWorkspaceStore(backend, { materializeDir: join(scratch, "s0", "steps") }), dataDir: join(scratch, "s0"), store: new MemoryRunStore(), serveUi: false, scheduler: false, enableChat: false, systemWorkflows: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false, job: false, orchestrator: false, builder: false, views: false, jamie: false, knowledge: false, stt: false, history: true });
      struts.push(again);
      assert.equal((await commits(again)).length, 1);
    });

    it("commits creating, editing, reparenting and deleting a Concept through graph/* steps, one commit each with its run", async () => {
      const s = await ready();
      await run(s, "t-concept", { op: "create", name: "Law", docs: "Law." });
      await run(s, "t-concept", { op: "create", name: "Practice", docs: "Practice." });
      const base = (await commits(s)).length;

      const created = await run(s, "c-create", { parent: await ref("Law"), data: { name: "Contracts", description: "Contract law", docs: "Offer and acceptance." } });
      let log = await commits(s);
      assert.equal(log.length, base + 1);
      assert.equal(log[0]!.subject, `run ${created.runId}`);
      assert.equal(log[0]!.author, "ada");
      assert.match(log[0]!.body, new RegExp(`\\nRun: ${created.runId}$`));
      assert.deepEqual(await changed(s, log[0]!.id), [["A", "concepts/concept-contracts.md"]]);
      assert.equal(await fileAt(s, log[0]!.id, "concepts/concept-contracts.md"), "---\nname: Contracts\ndescription: Contract law\nparents:\n  - Law\n---\nOffer and acceptance.\n");

      const contracts = (await ref("Contracts"))!;
      const edited = await run(s, "c-edit", { ref: contracts, data: { docs: "Offer, acceptance, consideration." } });
      log = await commits(s);
      assert.equal(log.length, base + 2);
      assert.match(log[0]!.body, new RegExp(`^run ${edited.runId}\\n\\nRun: ${edited.runId}$`));
      assert.deepEqual(await changed(s, log[0]!.id), [["M", "concepts/concept-contracts.md"]]);

      const moved = await run(s, "c-move", { ref: contracts, to: await ref("Practice") });
      log = await commits(s);
      assert.equal(log.length, base + 3);
      assert.equal(log[0]!.subject, `run ${moved.runId}`);
      assert.match(await fileAt(s, log[0]!.id, "concepts/concept-contracts.md"), /parents:\n {2}- Practice\n/);

      const deleted = await run(s, "c-delete", { ref: contracts });
      log = await commits(s);
      assert.equal(log.length, base + 4);
      assert.equal(log[0]!.subject, `run ${deleted.runId}`);
      assert.deepEqual(await changed(s, log[0]!.id), [["D", "concepts/concept-contracts.md"]]);

      // Rewriting a node as it is: nothing to commit.
      await run(s, "c-edit", { ref: (await ref("Law"))!, data: { docs: "Law." } });
      assert.equal((await commits(s)).length, base + 4);
    });

    it("follows a renamed page with git log --follow, and history/read reaches back past the rename", async () => {
      const s = await ready();
      await run(s, "t-concept", { op: "create", name: "Torts", docs: LONG });
      const before = (await commits(s))[0]!.id;
      await run(s, "c-edit", { ref: (await ref("Torts"))!, data: { name: "Tort Law" } });
      const after_ = (await commits(s))[0]!.id;
      assert.deepEqual((await changed(s, after_)).map((c) => [c[0]!.slice(0, 1), ...c.slice(1)]), [["R", "concepts/concept-torts.md", "concepts/concept-tortlaw.md"]]);
      const followed = (await git(s, ["log", "--follow", "--format=%H", "--", "concepts/concept-tortlaw.md"])).split("\n").filter(Boolean);
      assert.deepEqual(followed, [after_, before]);

      const log = await read(s, { action: "log", path: "concepts/concept-tortlaw.md" });
      assert.deepEqual(log.commits.map((c: { id: string }) => c.id), [after_, before]);
      assert.deepEqual(log.commits[0].changes, [{ path: "concepts/concept-tortlaw.md", status: "renamed", from: "concepts/concept-torts.md" }]);
      const d = await read(s, { action: "diff", from: before, to: after_ });
      assert.equal(d.entries.length, 1);
      assert.equal(d.entries[0].status, "renamed");
      assert.equal(d.entries[0].before.parsed.name, "Torts");
      assert.equal(d.entries[0].after.parsed.name, "Tort Law");
    });

    it("hears a workspace step that writes ctx.services.graph itself, and an accepted proposal as `proposal <id>`", async () => {
      const s = await ready();
      const base = (await commits(s)).length;
      const r = await run(s, "t-concept", { op: "create", name: "Evidence Law", docs: "Hearsay." }, "grace");
      let log = await commits(s);
      assert.equal(log.length, base + 1);
      assert.equal(log[0]!.subject, `run ${r.runId}`);
      assert.equal(log[0]!.author, "grace");
      assert.deepEqual(await changed(s, log[0]!.id), [["A", "concepts/concept-evidencelaw.md"]]);

      const proposals = (s.services as { proposals: { propose(p: unknown): Promise<{ id: string }> } }).proposals;
      const p = await proposals.propose({ step: "graph/edit-node", input: { ref_id: (await ref("Evidence Law"))!, node_data: { docs: "Hearsay, and its exceptions." } }, title: "Edit a page.", by: { workflow: "wf", runId: "r9", path: "wf/turn/001" } });
      const res = await s.app.request(`/proposals/${p.id}/decide`, json({ action: "accept" }));
      assert.equal(res.status, 200, await res.text());
      log = await commits(s);
      assert.equal(log.length, base + 2);
      assert.equal(log[0]!.subject, `proposal ${p.id}`);
      assert.doesNotMatch(log[0]!.body, /Run:/);
      assert.deepEqual(await changed(s, log[0]!.id), [["M", "concepts/concept-evidencelaw.md"]]);
    });

    it("commits a new type, an edge rule create-triplet adds, and a type's changed key, one commit each", async () => {
      const s = await ready();
      const base = (await commits(s)).length;
      const schema = await run(s, "c-schema", { type: "Statute", attributes: { name: "string", code: "string" }, key: "name" });
      let log = await commits(s);
      assert.equal(log.length, base + 1);
      assert.equal(log[0]!.subject, `run ${schema.runId}`);
      assert.deepEqual(await changed(s, log[0]!.id), [["A", "graph/Statute.yaml"]]);
      assert.match(await fileAt(s, log[0]!.id, "graph/Statute.yaml"), /code: string/);

      // The type's key changes: one commit, the changed line.
      const rekey = await run(s, "c-schema", { type: "Statute", attributes: { name: "string", code: "string" }, key: "code" });
      log = await commits(s);
      assert.equal(log.length, base + 2);
      assert.equal(log[0]!.subject, `run ${rekey.runId}`);
      const patch = await git(s, ["show", "--format=", log[0]!.id, "--", "graph/Statute.yaml"]);
      assert.match(patch, /\n\+key_spec: .*code/);
      const d = await read(s, { action: "diff", from: log[1]!.id, to: log[0]!.id, path: "graph" });
      assert.deepEqual(d.entries.map((e: { path: string; status: string }) => [e.path, e.status]), [["graph/Statute.yaml", "modified"]]);
      assert.equal(d.entries[0].before.parsed.key_spec, undefined);
      assert.match(d.entries[0].after.parsed.key_spec, /code/);

      // A Statute -[CITES]-> Concept write fits no rule: create-triplet adds one.
      const linked = await run(s, "c-triplet", { s: "Statute", sd: { name: "UCC", code: "ucc" }, edge: "CITES", t: "Concept", b: "Contracts" });
      log = await commits(s);
      assert.equal(log.length, base + 3);
      assert.equal(log[0]!.subject, `run ${linked.runId}`);
      const files = (await changed(s, log[0]!.id)).map((c) => c[1]);
      assert.ok(files.includes("graph/Statute.yaml"), files.join(", "));
      assert.ok(files.includes("concepts/concept-contracts.md"));
      // history/read: the type's new rule, parsed before and after.
      const rule = await read(s, { action: "diff", from: log[1]!.id, to: log[0]!.id, path: "graph/Statute.yaml" });
      assert.deepEqual(rule.entries.map((e: { path: string; status: string }) => [e.path, e.status]), [["graph/Statute.yaml", "modified"]]);
      assert.deepEqual(rule.entries[0].before.parsed.edges, []);
      assert.deepEqual(rule.entries[0].after.parsed.edges, [["CITES", "Concept"]]);
    });

    it("commits a workflow publish, a step publish, a rollback and an install, naming the cause", async () => {
      const s = await ready();
      const base = (await commits(s)).length;
      const flow = (n: string) => `name: notes\nsteps:\n  - { id: s, type: log, config: { message: "${n}" } }\n`;
      const v1 = await s.workspace.createWorkflow("notes", flow("one"), undefined, undefined, undefined, { actor: "lin" });
      let log = await commits(s);
      assert.equal(log.length, base + 1);
      assert.equal(log[0]!.subject, `publish notes ${v1.version}`);
      assert.equal(log[0]!.author, "lin");
      assert.deepEqual(await changed(s, log[0]!.id), [["A", "workflows/notes.yaml"]]);

      const v2 = await s.workspace.publishWorkflowByContent("notes", flow("two"));
      log = await commits(s);
      assert.equal(log[0]!.subject, `publish notes ${v2.version}`);

      await s.workspace.setActiveVersion("notes", v1.version);
      log = await commits(s);
      assert.equal(log.length, base + 3);
      assert.equal(log[0]!.subject, `activate notes ${v1.version}`);
      assert.equal(await fileAt(s, log[0]!.id, "workflows/notes.yaml"), flow("one"));

      const step = await s.workspace.publishStep("t/other", CONCEPT_STEP.replace('"t/concept"', '"t/other"'));
      log = await commits(s);
      assert.equal(log.length, base + 4);
      assert.equal(log[0]!.subject, `publish t/other ${step.version}`);
      assert.deepEqual(await changed(s, log[0]!.id), [["A", "steps/t/other.ts"]]);

      // An install: one commit, its own cause, whatever it published.
      await s.workspace.createWorkflow("acme-sync", "name: acme-sync\nsteps:\n  - { id: s, type: t/other, config: { op: x, name: y } }\n");
      const built = await buildPackage(
        { workspace: s.workspace, cache: packageCache(s.dataDir), getRegistry: async () => (await s.rebuildRegistry(), s.getRegistry()) },
        { package: "acme/sync", version: "1.0.0", workflows: ["acme-sync"] },
      );
      await s.workspace.deleteWorkflow("acme-sync");
      await s.workspace.deleteStep("t/other");
      await s.history!.settle();
      const before_ = (await commits(s)).length;
      const installed = await s.packages.install(`file:${built.dir}`, { actor: "lin" });
      log = await commits(s);
      assert.equal(log.length, before_ + 1);
      assert.equal(log[0]!.subject, `install acme/sync@${installed.digest}`);
      const files = (await changed(s, log[0]!.id)).map((c) => c[1]);
      assert.ok(files.includes("workflows/acme/sync/acme-sync.yaml"), files.join(", "));
      assert.match(await fileAt(s, log[0]!.id, "strut.yaml"), new RegExp(`package: acme/sync\\n\\s+digest: ${installed.digest}`));
    });

    it("commits an app publish with its sources (never dist/), and a release of an older version", async () => {
      const kit = await kitForTests();
      const s = await ready({ kit });
      const draft = join(s.dataDir, "drafts", "board");
      const write = async (files: Record<string, string | Buffer>) => {
        for (const [rel, body] of Object.entries(files)) {
          await mkdir(dirname(join(draft, rel)), { recursive: true });
          await writeFile(join(draft, rel), body);
        }
      };
      const dot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
      await write({ "app.yaml": "title: Board\n", "src/App.tsx": "export default () => <p>one</p>;\n", "public/dot.png": dot });
      const base = (await commits(s)).length;
      const v1 = await s.apps.publish(draft, "board", { surface: "person", actor: "lin" });
      assert.ok(v1.ok, v1.ok ? "" : v1.errors.join("\n"));
      let log = await commits(s);
      assert.equal(log.length, base + 1);
      assert.equal(log[0]!.subject, `publish board ${v1.version}`);
      assert.deepEqual((await changed(s, log[0]!.id)).map((c) => c.join(" ")).sort(), ["A apps/board/app.yaml", "A apps/board/public/dot.png", "A apps/board/src/App.tsx"]);
      assert.equal((await read(s, { action: "show", path: "apps/board/public/dot.png", at: "main" })).binary, true);

      await write({ "src/App.tsx": "export default () => <p>two</p>;\n" });
      const v2 = await s.apps.publish(draft, "board", { surface: "person" });
      assert.ok(v2.ok);
      log = await commits(s);
      assert.equal(log[0]!.subject, `publish board ${v2.version}`);
      const res = await s.app.request("/apps/board/active", json({ version: v1.version }, "PUT"));
      assert.equal(res.status, 200, await res.text());
      log = await commits(s);
      assert.equal(log.length, base + 3);
      assert.match(log[0]!.subject, new RegExp(`^release board ${v1.version}`));
      assert.equal(await fileAt(s, log[0]!.id, "apps/board/src/App.tsx"), "export default () => <p>one</p>;\n");
    });

    it("writes a page byte for byte as the package build writes it", async () => {
      const s = await ready();
      await run(s, "t-concept", { op: "create", name: "Labor", docs: "Work." });
      await run(s, "t-concept", { op: "create", name: "Law", docs: "Law.", parent: "Labor" });
      await run(s, "t-concept", { op: "create", name: "Wages", docs: "Pay.", parent: "Law" });
      await backend.nodes.update((await ref("Wages"))!, { set: { description: "What work pays" } });
      await backend.edges.write({ edge: "PARENT_OF", source_ref_id: (await ref("Labor"))!, target_ref_id: (await ref("Wages"))! });
      await s.history!.sync();
      const built = await buildPackage(
        { workspace: s.workspace, cache: packageCache(s.dataDir), graph: backend, getRegistry: async () => s.getRegistry() },
        { package: "acme/law", version: "1.0.0", concepts: ["Labor"] },
      );
      const head = (await commits(s))[0]!.id;
      assert.match(await fileAt(s, head, "concepts/concept-wages.md"), /parents:\n {2}- Labor\n {2}- Law\n/);
      for (const page of ["concepts/concept-wages.md", "concepts/concept-law.md", "concepts/concept-labor.md"]) {
        assert.equal(await fileAt(s, head, page), await readFile(join(built.dir, page), "utf-8"), page);
      }
    });

    it("catches a raw write at the next touch, or by sync", async () => {
      const s = await ready();
      const base = (await commits(s)).length;
      // Straight to the backend: no view hears it.
      await backend.nodes.write({ type: "Concept", data: { name: "Raw", docs: "Nobody heard." } }, "create");
      await s.history!.settle();
      assert.equal((await commits(s)).length, base);
      const synced = await read(s, { action: "sync" });
      assert.equal(synced.changed, true);
      const log = await commits(s);
      assert.equal(log.length, base + 1);
      assert.equal(log[0]!.subject, "sync");
      assert.equal(log[0]!.id, synced.commit);
      assert.deepEqual(await changed(s, log[0]!.id), [["A", "concepts/concept-raw.md"]]);
      // A second raw write rides with the next run's commit.
      await backend.nodes.write({ type: "Concept", data: { name: "Raw Too" } }, "create");
      const r = await run(s, "t-concept", { op: "create", name: "Heard" });
      const next = (await commits(s))[0]!;
      assert.equal(next.subject, `run ${r.runId}`);
      assert.deepEqual((await changed(s, next.id)).map((c) => c[1]).sort(), ["concepts/concept-heard.md", "concepts/concept-rawtoo.md"]);
    });

    it("takes no snapshot for a run that writes only instances, and the next Concept write commits what waited", async () => {
      const s = await ready();
      await run(s, "c-schema", { type: "Widget", attributes: { name: "string" }, key: "name" });
      const base = (await commits(s)).length;
      // Unheard, so only a snapshot would commit it.
      await backend.nodes.write({ type: "Concept", data: { name: "Unseen" } }, "create");
      const r = await run(s, "c-instance", { type: "Widget", data: { name: "w1" } });
      assert.equal(r.status, "success", r.status === "error" ? r.error.message : "");
      await s.history!.settle();
      assert.equal((await commits(s)).length, base, "a Widget alone took no snapshot");
      const heard = await run(s, "t-concept", { op: "create", name: "Seen" });
      const log = await commits(s);
      assert.equal(log.length, base + 1);
      assert.equal(log[0]!.subject, `run ${heard.runId}`);
      assert.deepEqual((await changed(s, log[0]!.id)).map((c) => c[1]).sort(), ["concepts/concept-seen.md", "concepts/concept-unseen.md"]);
    });

    it("snapshots a few hundred Concepts in time (the cost, logged)", async () => {
      const s = await ready();
      const n = 300;
      const docs = (i: number) => `Page ${i}. ${"A paragraph of what this kind of work is and how it is done here. ".repeat(50)}`;
      await backend.nodes.writeMany([{ type: "Concept", data: { name: "Root", docs: "The root." } }], "create");
      const root = (await ref("Root"))!;
      const written = await backend.nodes.writeMany(
        Array.from({ length: n }, (_, i) => ({ type: "Concept", data: { name: `Page ${i}`, description: `Page ${i} in a line`, docs: docs(i) } })),
        "create",
      );
      await backend.edges.writeMany(written.map((w) => ({ edge: "PARENT_OF", source_ref_id: root, target_ref_id: w.ref_id })));
      const first = (await s.history!.sync())!;
      const unchanged = (await s.history!.sync())!;
      await backend.nodes.update(written[7]!.ref_id, { set: { docs: "Changed." } });
      const one = (await s.history!.sync())!;
      console.log(
        `[history cost, ${tb.name}] ${first.files} files: first snapshot ${first.ms} ms (${first.written} written), ` +
          `unchanged ${unchanged.ms} ms, one page changed ${one.ms} ms`,
      );
      assert.equal(first.changed, true);
      assert.ok(first.files > n);
      assert.equal(unchanged.changed, false);
      assert.equal(one.changed, true);
      assert.equal(one.written, 1);
      assert.ok(one.ms < 5_000, `one page changed took ${one.ms} ms`);
    });

    it("keeps no repository with the setting off", async () => {
      const s = await boot({ history: false });
      await s.workspace.createWorkflow("notes", "name: notes\nsteps:\n  - { id: s, type: log, config: { message: hi } }\n");
      assert.equal(s.history, null);
      assert.equal(await stat(join(s.dataDir, HISTORY_DIR)).catch(() => null), null);
      const r = await read(s, { action: "log" });
      assert.equal(r.history, false);
      assert.match(r.message, /no history/);
    });

    it("reads the earlier commit for a time between two, and log { run } lists that run's commits", async () => {
      const s = await ready();
      const one = await run(s, "t-concept", { op: "create", name: "Alpha", docs: "First." });
      const first = (await commits(s))[0]!;
      const firstTime = (await git(s, ["log", "-1", "--format=%ct", first.id])).trim();
      // Commits are timed to the second: the next one lands in a later second.
      await new Promise((r) => setTimeout(r, 1100));
      const two = await run(s, "t-concept", { op: "edit", name: "Alpha", docs: "Second." });
      const second = (await commits(s))[0]!;
      const between = new Date(Number(firstTime) * 1000 + 500).toISOString();
      const shown = await read(s, { action: "show", path: "concepts/concept-alpha.md", at: between });
      assert.equal(shown.at, first.id);
      assert.equal(shown.parsed.docs, "First.");
      assert.equal((await read(s, { action: "show", path: "concepts/concept-alpha.md", at: second.id })).parsed.docs, "Second.");
      const folder = await read(s, { action: "show", path: "concepts", at: second.id });
      assert.equal(folder.kind, "folder");
      assert.ok(folder.entries.some((e: { name: string }) => e.name === "concept-alpha.md"));

      const byRun = await read(s, { action: "log", run: one.runId });
      assert.deepEqual(byRun.commits.map((c: { id: string }) => c.id), [first.id]);
      assert.deepEqual(byRun.commits[0].runs, [one.runId]);
      assert.deepEqual(byRun.commits[0].changes, [{ path: "concepts/concept-alpha.md", status: "added" }]);
      assert.deepEqual((await read(s, { action: "log", run: two.runId })).commits.map((c: { id: string }) => c.id), [second.id]);
      // from/to: what changed between two moments.
      assert.deepEqual((await read(s, { action: "log", from: between, to: second.id })).commits.map((c: { id: string }) => c.id), [second.id]);
    });

    it("lists a moved page as modified, its parents parsed before and after", async () => {
      const s = await ready();
      await run(s, "t-concept", { op: "create", name: "Law", docs: "Law." });
      await run(s, "t-concept", { op: "create", name: "Practice", docs: "Practice." });
      await run(s, "t-concept", { op: "create", name: "Wills", docs: "Wills.", parent: "Law" });
      const from = (await commits(s))[0]!.id;
      await run(s, "c-move", { ref: (await ref("Wills"))!, to: (await ref("Practice"))! });
      const d = await read(s, { action: "diff", from, to: "main", patch: true });
      assert.deepEqual(d.entries.map((e: { path: string; status: string }) => [e.path, e.status]), [["concepts/concept-wills.md", "modified"]]);
      assert.deepEqual(d.entries[0].before.parsed.parents, ["Law"]);
      assert.deepEqual(d.entries[0].after.parsed.parents, ["Practice"]);
      assert.match(d.entries[0].patch, /-\s+- Law\n\+\s+- Practice/);
    });

    it("leaves a namespace the caller cannot read out of log, show and diff", async () => {
      const s = await ready({ graphReaders: { jobs: { namespaces: ["default"] } } });
      if (backend.kind === "neo4j") await backend.reader.registerNamespace("acme");
      const from = (await commits(s))[0]!.id;
      await backend.nodes.write({ type: "Concept", data: { name: "Mine", docs: "Ours." } }, "create");
      await backend.nodes.write({ type: "Concept", data: { name: "Secret", docs: "Theirs." } }, "create", { namespace: "acme" });
      const synced = await s.history!.sync();
      assert.ok(synced?.commit);
      const all = await changed(s, synced.commit!);
      assert.deepEqual(all.map((c) => c[1]).sort(), ["concepts/concept-mine.md", "namespaces/acme/concepts/concept-secret.md"]);

      const log = await read(s, { action: "log" });
      assert.deepEqual(log.commits[0].changes, [{ path: "concepts/concept-mine.md", status: "added" }]);
      await assert.rejects(read(s, { action: "show", path: "namespaces/acme/concepts/concept-secret.md", at: "main" }), /no namespaces\/acme/);
      const root = await read(s, { action: "show", path: "", at: "main" });
      assert.ok(!root.entries.some((e: { name: string }) => e.name === "namespaces"), JSON.stringify(root.entries));
      const d = await read(s, { action: "diff", from, to: "main" });
      assert.deepEqual(d.entries.map((e: { path: string }) => e.path), ["concepts/concept-mine.md"]);
      assert.deepEqual((await read(s, { action: "log", path: "namespaces/acme" })).commits, []);

      // A commit of only what the caller cannot read is not in its log.
      await backend.nodes.write({ type: "Concept", data: { name: "Secret Two" } }, "create", { namespace: "acme" });
      const hidden = await s.history!.sync();
      assert.ok(hidden?.commit);
      assert.ok(!(await read(s, { action: "log" })).commits.some((c: { id: string }) => c.id === hidden.commit));
    });


    // ── Concept branches: each a git branch (plans/concept-evals.md item c) ──
    describe("Concept branches", () => {
      const post = async (s: Strut, path: string, body: unknown, status = 201) => {
        const res = await s.app.request(path, json(body));
        assert.equal(res.status, status, await res.clone().text());
        return (await res.json()) as Record<string, any>;
      };
      const drop = async (s: Strut, name: string) => {
        const res = await s.app.request(`/branches/${name}`, { method: "DELETE" });
        assert.equal(res.status, 200, await res.clone().text());
        return (await res.json()) as Record<string, any>;
      };
      /** A ref's commit, or null. */
      const tip = async (s: Strut, ref: string) => (await git(s, ["rev-parse", "-q", "--verify", ref]).catch(() => "")).trim() || null;
      /** A ref's commits, newest first, as `commits` gives main's. */
      const commitsOf = async (s: Strut, ref: string) => {
        await s.history!.settle();
        return (await git(s, ["log", "--format=%x1e%H%x1f%an%x1f%B", ref]))
          .split("\x1e")
          .filter((c) => c.trim())
          .map((c) => {
            const [id, author, body] = c.split("\x1f");
            return { id: id!, author: author!, body: body!.trim(), subject: body!.trim().split("\n")[0]! };
          });
      };
      const pageIn = async (ns: string, name: string) =>
        (await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { name: "$name", namespace: "$ns" })} WHERE ${backend.dialect.live("c")} RETURN c.ref_id AS r`, { name, ns }))[0]?.["r"] as string;
      const runOn = async (s: Strut, branch: string, wf: string, input: Record<string, unknown>, actor = "ada") => {
        const r = await s.run(wf, input, { actor, branch });
        assert.equal(r.status, "success", JSON.stringify(r.error ?? r.output));
        if (typeof r.output === "string") assert.fail(r.output);
        return r;
      };
      /** Main with a small tree of our own: Guide > Tone. */
      const tree = async () => {
        const s = await ready();
        await run(s, "t-concept", { op: "create", name: "Guide", docs: "Main guide." });
        await run(s, "t-concept", { op: "create", name: "Tone", docs: "Main tone.", parent: "Guide" });
        return { s, fork: (await commits(s))[0]!.id };
      };

      it("starts a branch at main's commit; a page a run on it writes commits there with its run, and main is left alone", async () => {
        const { s, fork } = await tree();
        const made = await post(s, "/branches", { name: "try" });
        assert.equal(made["pages"], 2);
        // The pages are main's: the git branch is main's commit, nothing committed.
        assert.equal(await tip(s, "refs/heads/try"), fork);
        assert.equal(await tip(s, "refs/heads/main"), fork);
        const listed = await read(s, { action: "branches" });
        assert.deepEqual(listed.branches.map((b: Record<string, string>) => [b.name, b.head, b.base]), [["main", fork, undefined], ["try", fork, fork]]);
        assert.deepEqual(listed.dropped, []);
        // `main` is the history's own branch, never a Concept branch's name.
        assert.match(JSON.stringify(await post(s, "/branches", { name: "main" }, 400)), /history's own branch/);

        const edited = await runOn(s, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "Branch guide." } });
        let log = await commitsOf(s, "refs/heads/try");
        assert.equal(log[0]!.subject, `run ${edited.runId}`);
        assert.match(log[0]!.body, new RegExp(`\\nRun: ${edited.runId}$`));
        assert.equal(log[0]!.author, "ada");
        assert.equal(log[1]!.id, fork, "its parent is the fork point");
        assert.deepEqual(await changed(s, log[0]!.id), [["M", "concepts/concept-guide.md"]]);
        assert.equal(await fileAt(s, log[0]!.id, "concepts/concept-guide.md"), "---\nname: Guide\n---\nBranch guide.\n");

        const added = await runOn(s, "try", "c-instance", { type: "Concept", data: { name: "Branch Only", docs: "Here alone." } });
        log = await commitsOf(s, "refs/heads/try");
        assert.equal(log[0]!.subject, `run ${added.runId}`);
        assert.deepEqual(await changed(s, log[0]!.id), [["A", "concepts/concept-branchonly.md"]]);
        // Everything but concepts/ is the fork's tree, byte for byte.
        const rest = async (id: string) => (await git(s, ["ls-tree", id])).split("\n").filter((l) => l && !l.endsWith("\tconcepts")).join("\n");
        assert.equal(await rest(log[0]!.id), await rest(fork));
        // Main heard none of it.
        assert.equal(await tip(s, "refs/heads/main"), fork);
        assert.equal((await fileAt(s, fork, "concepts/concept-guide.md")).trim().split("\n").pop(), "Main guide.");
        // Rewriting a page as it is: nothing to commit.
        await runOn(s, "try", "c-edit", { ref: await pageIn("branch-try", "Tone"), data: { docs: "Main tone." } });
        assert.equal((await commitsOf(s, "refs/heads/try"))[0]!.id, log[0]!.id);
      });

      it("a write on main leaves the branch alone; main against the branch is exactly the pages apart, the branch's commits listable, its fork point found", async () => {
        const { s, fork } = await tree();
        await post(s, "/branches", { name: "try" });
        const one = await runOn(s, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "Branch guide." } });
        await s.history!.settle();
        const two = await runOn(s, "try", "c-instance", { type: "Concept", data: { name: "Branch Only", docs: "Here alone." } });
        const head = (await commitsOf(s, "refs/heads/try"))[0]!.id;

        const onMain = await run(s, "t-concept", { op: "create", name: "Main Only", docs: "Main alone." });
        const mainLog = await commits(s);
        assert.equal(mainLog[0]!.subject, `run ${onMain.runId}`);
        assert.deepEqual(await changed(s, mainLog[0]!.id), [["A", "concepts/concept-mainonly.md"]]);
        assert.equal(await tip(s, "refs/heads/try"), head, "the branch is where it was");

        const apart = await read(s, { action: "diff", from: "main", to: "try", path: "concepts" });
        assert.deepEqual(apart.entries.map((e: { path: string; status: string }) => [e.path, e.status]), [
          ["concepts/concept-branchonly.md", "added"],
          ["concepts/concept-guide.md", "modified"],
          ["concepts/concept-mainonly.md", "deleted"],
        ]);
        const guide = apart.entries.find((e: { path: string }) => e.path === "concepts/concept-guide.md");
        assert.deepEqual([guide.before.parsed.docs, guide.after.parsed.docs], ["Main guide.", "Branch guide."]);

        // The commits made on the branch, newest first.
        const own = await read(s, { action: "log", from: "main", to: "try" });
        assert.deepEqual(own.commits.map((c: { runs: string[] }) => c.runs), [[two.runId], [one.runId]]);
        // Its fork point: what the branch changed, apart from what main changed since.
        const base = (await read(s, { action: "branches" })).branches.find((b: { name: string }) => b.name === "try").base;
        assert.equal(base, fork);
        const changedOnBranch = await read(s, { action: "diff", from: base, to: "try", path: "concepts" });
        assert.deepEqual(changedOnBranch.entries.map((e: { path: string; status: string }) => [e.path, e.status]), [["concepts/concept-branchonly.md", "added"], ["concepts/concept-guide.md", "modified"]]);
        const changedOnMain = await read(s, { action: "diff", from: base, to: "main", path: "concepts" });
        assert.deepEqual(changedOnMain.entries.map((e: { path: string; status: string }) => [e.path, e.status]), [["concepts/concept-mainonly.md", "added"]]);
        // `log { branch }`: the branch's commits back through main's before it.
        const all = await read(s, { action: "log", branch: "try", path: "concepts/concept-guide.md" });
        assert.equal(all.commits.length, 2);
        assert.deepEqual(all.commits[0].runs, [one.runId]);
        assert.deepEqual(all.commits[1].changes, [{ path: "concepts/concept-guide.md", status: "added" }], "the page made on main, before the fork");
      });

      it("reads a time on a branch as that branch's commit then, and a page there", async () => {
        const { s, fork } = await tree();
        await post(s, "/branches", { name: "try" });
        await runOn(s, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "First on the branch." } });
        const first = (await commitsOf(s, "refs/heads/try"))[0]!;
        const firstTime = Number((await git(s, ["log", "-1", "--format=%ct", first.id])).trim());
        await new Promise((r) => setTimeout(r, 1100));
        await runOn(s, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "Second on the branch." } });
        const between = new Date(firstTime * 1000 + 500).toISOString();
        const shown = await read(s, { action: "show", path: "concepts/concept-guide.md", at: between, branch: "try" });
        assert.equal(shown.at, first.id);
        assert.equal(shown.parsed.docs, "First on the branch.");
        // On main, the same time is main's commit then.
        const onMain = await read(s, { action: "show", path: "concepts/concept-guide.md", at: between });
        assert.equal(onMain.at, fork);
        assert.equal(onMain.parsed.docs, "Main guide.");
        // A branch's name is its last commit.
        assert.equal((await read(s, { action: "show", path: "concepts/concept-guide.md", at: "try" })).parsed.docs, "Second on the branch.");
        await assert.rejects(read(s, { action: "show", path: "concepts", at: "now", branch: "nope" }), /no branch "nope"/);
      });

      it("a branch from empty is one commit holding no page and main's tree besides; a type a run on a branch writes is main's", async () => {
        const { s, fork } = await tree();
        const empty = await post(s, "/branches", { name: "blank", from: "empty" });
        assert.equal(empty["pages"], 0);
        const log = await commitsOf(s, "refs/heads/blank");
        assert.equal(log[0]!.subject, "branch blank from empty");
        assert.equal(log[1]!.id, fork);
        const root = (await git(s, ["ls-tree", "--name-only", log[0]!.id])).split("\n").filter(Boolean);
        assert.ok(!root.includes("concepts") && root.includes("workflows") && root.includes("strut.yaml"), root.join(", "));
        const d = await read(s, { action: "diff", from: "main", to: "blank", path: "concepts" });
        assert.deepEqual(d.entries.map((e: { status: string }) => e.status), ["deleted", "deleted"]);

        // A type is the live graph's (ruling 3): main records it, the branch does not.
        const typed = await runOn(s, "blank", "c-schema", { type: "Statute", attributes: { name: "string", code: "?string" }, key: "name" });
        const mainLog = await commits(s);
        assert.equal(mainLog[0]!.subject, `run ${typed.runId}`);
        assert.deepEqual((await changed(s, mainLog[0]!.id)).map((c) => c[1]), ["graph/Statute.yaml"]);
        assert.equal(await tip(s, "refs/heads/blank"), log[0]!.id);
      });

      it("an accepted proposal made on a branch commits on it as `proposal <id>`", async () => {
        const { s, fork } = await tree();
        await post(s, "/branches", { name: "try" });
        const proposals = (s.services as { proposals: { propose(p: unknown): Promise<{ id: string }> } }).proposals;
        const p = await proposals.propose({
          step: "graph/edit-node",
          input: { ref_id: await pageIn("branch-try", "Tone"), node_data: { docs: "Proposed on the branch." } },
          title: "Edit a page.",
          by: { workflow: "wf", runId: "r9", path: "wf/turn/001", branch: "try" },
        });
        const res = await s.app.request(`/proposals/${p.id}/decide`, json({ action: "accept" }));
        assert.equal(res.status, 200, await res.text());
        const log = await commitsOf(s, "refs/heads/try");
        assert.equal(log[0]!.subject, `proposal ${p.id}`);
        assert.deepEqual(await changed(s, log[0]!.id), [["M", "concepts/concept-tone.md"]]);
        assert.equal(await tip(s, "refs/heads/main"), fork);
      });

      it("drop commits what waits, keeps the git branch under refs/dropped/, and frees the name: made again, it starts at main's commit", async () => {
        const { s, fork } = await tree();
        await post(s, "/branches", { name: "try" });
        // Not settled: the run's touch waits on the debounce when the drop comes.
        const last = await runOn(s, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "Tried." } });
        const dropped = await drop(s, "try");
        assert.equal(dropped["pages"], 2);
        assert.match(dropped["kept"].ref, /^refs\/dropped\/try\/\d{8}T\d{9}Z$/);
        const kept = (await commitsOf(s, dropped["kept"].ref))[0]!;
        assert.equal(kept.id, dropped["kept"].commit);
        assert.equal(kept.subject, `run ${last.runId}`, "what the branch last wrote is in its record");
        assert.equal(await tip(s, "refs/heads/try"), null);
        const listed = await read(s, { action: "branches" });
        assert.deepEqual(listed.branches.map((b: { name: string }) => b.name), ["main"]);
        assert.deepEqual(listed.dropped.map((b: Record<string, string>) => [b.name, b.ref, b.head, b.base]), [["try", dropped["kept"].ref, kept.id, fork]]);
        // What was tried still reads.
        assert.equal((await read(s, { action: "show", path: "concepts/concept-guide.md", at: kept.id })).parsed.docs, "Tried.");

        // The name is free: a new branch starts at main's commit, not where the old one was.
        await run(s, "t-concept", { op: "edit", name: "Tone", docs: "Main tone, later." });
        const now = (await commits(s))[0]!.id;
        await post(s, "/branches", { name: "try" });
        assert.equal(await tip(s, "refs/heads/try"), now);
        assert.equal(await tip(s, dropped["kept"].ref), kept.id);
        assert.equal((await read(s, { action: "show", path: "concepts/concept-guide.md", at: "try" })).parsed.docs, "Main guide.");
      });

      it("a restart carries a branch on from its git branch; a branch made with the history off gets one at boot", async () => {
        const first = await tree();
        const dir = first.s.dataDir;
        await post(first.s, "/branches", { name: "try" });
        await runOn(first.s, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "Before the restart." } });
        const before = (await commitsOf(first.s, "refs/heads/try"))[0]!.id;
        await first.s.close();
        struts.splice(struts.indexOf(first.s), 1);

        const again = await boot({}, dir);
        await again.rebuildRegistry();
        assert.equal(await tip(again, "refs/heads/try"), before, "boot commits nothing on a branch that has not moved");
        const after = await runOn(again, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "After the restart." } });
        const log = await commitsOf(again, "refs/heads/try");
        assert.equal(log[0]!.subject, `run ${after.runId}`);
        assert.equal(log[1]!.id, before);
        assert.deepEqual(await changed(again, log[0]!.id), [["M", "concepts/concept-guide.md"]]);

        // Made while the history was off: no git branch, until the next boot makes one at main's commit.
        await again.close();
        struts.splice(struts.indexOf(again), 1);
        const off = await boot({ history: false }, dir);
        await post(off, "/branches", { name: "late" });
        await off.close();
        struts.splice(struts.indexOf(off), 1);
        const on = await boot({}, dir);
        assert.equal(await tip(on, "refs/heads/late"), await tip(on, "refs/heads/main"));
        assert.equal(await tip(on, "refs/heads/try"), log[0]!.id);
      });

      it("with the history off, a branch is made, run on and dropped as before, and nothing is kept", async () => {
        const s = await boot({ history: false });
        await s.workspace.createWorkflow("c-instance", GRAPH_WFS["c-instance"]!);
        await s.rebuildRegistry();
        await post(s, "/branches", { name: "try" });
        await runOn(s, "try", "c-instance", { type: "Concept", data: { name: "Branch Only", docs: "Here alone." } });
        assert.ok(await pageIn("branch-try", "Branch Only"));
        const dropped = await drop(s, "try");
        assert.equal(dropped["kept"], undefined);
        assert.equal(await stat(join(s.dataDir, HISTORY_DIR)).catch(() => null), null);
        assert.equal((await read(s, { action: "branches" })).history, false);
      });

      it("a caller who cannot read the graph's own pages sees no branch: not listed, not readable, its commits not in a log", async () => {
        const { s } = await tree();
        await post(s, "/branches", { name: "try" });
        const edited = await runOn(s, "try", "c-edit", { ref: await pageIn("branch-try", "Guide"), data: { docs: "Branch guide." } });
        const hidden = { ...(s.services as object), graph: scopedBackend(backend, { namespaces: ["acme"] }) };
        assert.deepEqual((await read(s, { action: "branches" }, hidden)).branches.map((b: { name: string }) => b.name), ["main"]);
        await assert.rejects(read(s, { action: "log", branch: "try" }, hidden), /no branch "try"/);
        const log = await read(s, { action: "log", to: "try" }, hidden);
        assert.ok(!log.commits.some((c: { runs: string[] }) => c.runs.includes(edited.runId)));
        assert.deepEqual((await read(s, { action: "diff", from: "main", to: "try" }, hidden)).entries, []);
        // The same reads, for a caller who may.
        assert.ok((await read(s, { action: "log", to: "try" })).commits.some((c: { runs: string[] }) => c.runs.includes(edited.runId)));
      });
    });
  });
}
