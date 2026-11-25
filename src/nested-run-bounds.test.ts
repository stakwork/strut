import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildAuthoringCapability } from "./authoring.js";
import { defineStep, flow, step, type AppRef, type RunOrigin, type StepContext, type StepRegistry } from "./core.js";
import { readerKindOf } from "./graph/scope.js";
import { runWorkflow } from "./runner.js";
import { runSingleStep } from "./run-step.js";
import type { SessionsCapability } from "./session-store.js";
import { createRegistry } from "./steps/registry.js";
import { requireAdminPage } from "./steps/lib/knowledge/_shared.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * A run started from inside another — `meta/run-step`'s one-off run and
 * `meta/run-workflow`'s child — is held where its caller's own steps are:
 * the same views of the services bag (a peer's sessions under `peer/`, an
 * app's under the app), the same reader of the graph, and never a page's
 * own call, whatever app it carries.
 */

/** What one step call saw: the session id it opened, its app, its reader
 *  of the graph, and whether it passed as an admin's page. */
interface Seen {
  where: string;
  opened: string;
  app: AppRef | null;
  reader: string;
  adminPage: boolean;
}

describe("a run started from inside another keeps its caller's bounds", () => {
  let dir: string;
  let seen: Seen[];
  let registry: StepRegistry;
  let services: Record<string, unknown>;

  /** Opens `id` as a session and reports what this call is. */
  const probe = defineStep({
    type: "dev/probe",
    description: "Open a session; say what this call is.",
    input: z.object({ where: z.string(), id: z.string() }),
    output: z.any(),
    async run(cfg, ctx: StepContext) {
      const sessions = (ctx.services as { sessions: SessionsCapability }).sessions;
      const open = await sessions.open(cfg.id, { runId: ctx.runId, path: ctx.path });
      let adminPage = true;
      try {
        requireAdminPage(ctx, "dev/probe");
      } catch {
        adminPage = false;
      }
      seen.push({ where: cfg.where, opened: open.id, app: ctx.app ?? null, reader: readerKindOf(ctx, undefined), adminPage });
      return { ok: true };
    },
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "strut-nested-bounds-"));
    seen = [];
    const lib = await createRegistry([]);
    registry = { "dev/probe": probe, "meta/run-step": lib["meta/run-step"]!, "meta/run-workflow": lib["meta/run-workflow"]! } as StepRegistry;
    const workspace = new WorkspaceManager(join(dir, "ws"));
    await workspace.publishWorkflowByContent(
      "opener",
      'name: opener\nsteps:\n  - id: probe\n    type: dev/probe\n    config:\n      where: child\n      id: ann\n',
    );
    // The bag's sessions name what they were asked for, and hold nothing.
    const sessions: SessionsCapability = {
      open: async (id) => ({ id, system: null, messages: [], turns: [], replayFrom: 0, release: () => {} }) as never,
      holder: () => undefined,
      turns: async () => [],
    };
    services = { sessions };
    services["authoring"] = buildAuthoringCapability({ workspace, store: new MemoryRunStore(), getRegistry: async () => registry, services });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The caller: its own call of the probe, the same through meta/run-step,
   *  and a workflow holding it through meta/run-workflow. */
  const caller = (name: string) =>
    flow(name, {
      input: z.any(),
      steps: [
        step("own", "dev/probe", { where: "own", id: "ann" }),
        step("nested", "meta/run-step", { type: "dev/probe", config: { where: "nested", id: "ann" } }),
        step("child", "meta/run-workflow", { name: "opener", input: {} }),
      ],
    });

  const run = async (name: string, opts: { origin?: RunOrigin; app?: AppRef; actor?: string }) => {
    const res = await runWorkflow(caller(name), {}, registry, { services, ...opts });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    const by = Object.fromEntries(seen.map((s) => [s.where, s]));
    assert.deepEqual(Object.keys(by).sort(), ["child", "nested", "own"]);
    return by as Record<"own" | "nested" | "child", Seen>;
  };

  it("a peer's run: a session a nested step opens is under peer/, as the caller's own is — never a local person's thread", async () => {
    const by = await run("builder", { origin: "peer", actor: "peer-org" });
    assert.equal(by.own.opened, "peer/ann");
    assert.equal(by.nested.opened, "peer/ann", "meta/run-step's run opens the peer's, not this strut's ann");
    assert.equal(by.child.opened, "peer/ann", "meta/run-workflow's child opens the peer's, not this strut's ann");
  });

  it("a host's run: a nested step's sessions are under the host, as the caller's own are", async () => {
    const res = await runWorkflow(caller("turn"), {}, registry, { services, origin: "host", host: "tribes", actor: "ann" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    assert.deepEqual(seen.map((s) => s.opened), ["host/tribes/ann", "host/tribes/ann", "host/tribes/ann"]);
  });

  it("a public run: a nested step's sessions are a stranger's, never a local thread", async () => {
    const res = await runWorkflow(caller("open"), {}, registry, { services, origin: "public", credit: "tok1" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    assert.deepEqual(seen.map((s) => s.opened), ["public/tok1/ann", "public/tok1/ann", "public/tok1/ann"]);
  });

  it("an app's run: a nested step reads the graph as the app's, its sessions under the app and its viewer", async () => {
    const app: AppRef = { name: "acme/notes", version: "v1" };
    const by = await run("notes-turn", { origin: "app", app, actor: "ann" });
    for (const where of ["own", "nested", "child"] as const) {
      assert.deepEqual(by[where].app, app, `${where}: the caller's app`);
      assert.equal(by[where].reader, "apps", `${where}: read as the app's, not as a job's`);
      assert.equal(by[where].opened, "app/acme/notes/ann/ann", `${where}: the thread the caller's own call opens`);
    }
  });

  it("a first-party page's run: a nested step carries the app, yet is never the page's own call", async () => {
    const app: AppRef = { name: "strut/jamie", version: "v1", firstParty: true, admin: true };
    const by = await run("jamie", { origin: "app", app, actor: "ann" });
    for (const where of ["own", "nested", "child"] as const) {
      assert.deepEqual(by[where].app, app, `${where}: the caller's app`);
      // A page's own call reads as `ui` and passes as an admin's page; a
      // run started from inside the turn — `__run_step__` included — does not.
      assert.equal(by[where].reader, "apps", `${where}: never the page's reader`);
      assert.equal(by[where].adminPage, false, `${where}: never the admin's page`);
      assert.equal(by[where].opened, "ann", `${where}: the viewer's own thread, as the caller's own call opens it`);
    }
  });

  it("a page's own call is still one: meta/run-step from the page reads as the app's, not the page's", async () => {
    const app: AppRef = { name: "strut/jamie", version: "v1", firstParty: true, admin: true };
    // As the app door runs a page's call (`step_run`).
    const res = await runSingleStep("dev/probe", registry, services, { app, config: { where: "page", id: "ann" } });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    assert.deepEqual([seen[0]!.reader, seen[0]!.adminPage], ["ui", true], "the page's own call");
    const res2 = await runSingleStep("meta/run-step", registry, services, { app, config: { type: "dev/probe", config: { where: "nested", id: "ann" } } });
    assert.equal(res2.status, "success", JSON.stringify(res2.error));
    assert.deepEqual([seen[1]!.where, seen[1]!.reader, seen[1]!.adminPage], ["nested", "apps", false], "what the page's call starts is not the page");
  });

  it("a run with no origin or app: what a step sends never makes the nested run an app's or a peer's", async () => {
    const forging = defineStep({
      type: "dev/forge",
      description: "Run the probe, naming a caller of its own.",
      input: z.object({}),
      output: z.any(),
      async run(_cfg, ctx: StepContext) {
        const authoring = (ctx.services as { authoring: { runStep(t: string, a: unknown): Promise<unknown> } }).authoring;
        const caller = { origin: "app", app: { name: "strut/jamie", version: "v1", firstParty: true, admin: true } };
        return authoring.runStep("dev/probe", { config: { where: "forged", id: "ann" }, caller });
      },
    });
    registry["dev/forge"] = forging;
    const res = await runWorkflow(flow("plain", { input: z.any(), steps: [step("forge", "dev/forge", {})] }), {}, registry, { services, actor: "ann" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    assert.deepEqual(seen.map((s) => [s.where, s.opened, s.app, s.reader, s.adminPage]), [["forged", "ann", null, "jobs", false]]);
  });
});
