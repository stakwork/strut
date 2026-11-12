import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { createStrut, type Strut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, type StepRegistry } from "../core.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { appIdentity } from "../auth.js";
import { appSessionId, peerSessionId } from "../session-store.js";
import { kitForTests } from "../test-util/app-kit.js";
import { ORCHESTRATOR_WORKFLOW } from "../orchestrator-seed.js";
import { reservedAppName } from "./files.js";
import { STEP_RUN_TOOL, buildAppTools, firstPartyApp } from "./tools.js";
import decideStep from "../steps/lib/proposal/decide.js";

/**
 * First-party apps (plans/jamie-app.md §3): an app strut ships — a `strut/`
 * name, a seeded version — acts with its viewer's own rights. Names under
 * `strut/` are reserved on every door but the seed. A first-party page
 * reaches the sealed orchestrator with no grant, its viewer's runs whoever
 * launched them; its turns open the person's own session, keep the gated
 * tools, start the person's own jobs and get strut's wake; it reads the
 * person's conversations and proposals and decides them. A model-written
 * page gets none of it.
 */

const KEY = "first-party-key";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(find: () => T | undefined | Promise<T | undefined>, what = "it"): Promise<T> => {
  for (let i = 0; i < 1500; i++) {
    const v = await find();
    if (v !== undefined) return v;
    await sleep(10);
  }
  throw new Error(`${what} never happened`);
};

describe("first-party apps: the pure parts", () => {
  it("names under strut/ are reserved for the seed", () => {
    assert.match(reservedAppName("strut/jamie")!, /reserved for the apps strut ships/);
    assert.match(reservedAppName("strut/jamie", "api")!, /reserved/);
    assert.equal(reservedAppName("strut/jamie", "seed"), null);
    assert.equal(reservedAppName("acme/strut/x"), null);
    assert.equal(reservedAppName("struts"), null);
  });

  it("a first-party page: a strut/ name at a seeded version, shown to a person, never a visitor", () => {
    const app = { name: "strut/jamie", version: "v1" };
    assert.equal(firstPartyApp(app, true, "alice", false), true);
    assert.equal(firstPartyApp(app, false, "alice", false), false, "a version strut did not seed");
    assert.equal(firstPartyApp(app, true, undefined, false), false, "no person");
    assert.equal(firstPartyApp(app, true, "alice", true), false, "a visitor");
    assert.equal(firstPartyApp({ name: "plain", version: "v1" }, true, "alice", false), false, "not a strut/ name");
  });

  it("its runs open the viewer's own sessions as they are; any other under the app", () => {
    assert.equal(appSessionId("alice/c1", "strut/jamie", "alice", undefined, true), "alice/c1");
    assert.equal(appSessionId("alice", "strut/jamie", "alice", undefined, true), "alice");
    assert.equal(appSessionId("bob/c1", "strut/jamie", "alice", undefined, true), "app/strut/jamie/alice/bob/c1");
    assert.equal(appSessionId("alice/c1", "plain", "alice"), "app/plain/alice/alice/c1", "a model-written page's");
    // The conversation the run continues (plans/jamie-app.md §2.2), as it is.
    assert.equal(appSessionId("hive-1", "strut/jamie", "alice", undefined, true, "hive-1"), "hive-1");
    assert.equal(appSessionId("hive-2", "strut/jamie", "alice", undefined, true, "hive-1"), "app/strut/jamie/alice/hive-2");
    assert.equal(appSessionId("hive-1", "plain", "alice", undefined, false, "hive-1"), "app/plain/alice/hive-1", "never a model-written page's");
    assert.equal(peerSessionId("hive-1", "alice", "hive-1"), "hive-1");
    assert.equal(peerSessionId("hive-1", undefined, "hive-1"), "peer/hive-1", "never a plain peer's");
  });

  it("proposal/decide refuses an agent's tool call, a model-written page and no person", async () => {
    const services = { proposals: { get: async () => null, decide: async () => ({ status: 200, body: { id: "p" } }) } };
    const fp = { name: "strut/jamie", version: "v1", firstParty: true as const };
    const cfg = { id: "p", action: "accept" as const };
    await assert.rejects(() => decideStep.run(cfg, { app: fp, actor: "alice", workflow: ORCHESTRATOR_WORKFLOW, services } as never), /a person's decision/);
    await assert.rejects(() => decideStep.run(cfg, { app: { name: "plain", version: "v1" }, actor: "alice", workflow: "__run_step__", services } as never), /a person's decision/);
    await assert.rejects(() => decideStep.run(cfg, { app: fp, workflow: "__run_step__", services } as never), /a person's decision/);
    assert.equal(((await decideStep.run(cfg, { app: fp, actor: "alice", workflow: "__run_step__", services } as never)) as { id: string }).id, "p");
  });
});

describe("first-party apps through a whole strut", () => {
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS", "STRUT_PACKAGE_INDEXES"];
  let saved: Record<string, string | undefined> = {};
  let root = "";
  let server: http.Server;
  let strut: Strut;
  let registry: StepRegistry;
  const store = new MemoryRunStore();
  const requests: any[] = [];
  const noted: string[] = [];

  const note = defineStep({
    type: "note",
    effect: "write",
    input: z.object({ text: z.string() }),
    output: z.any(),
    async run(cfg) {
      noted.push(cfg.text);
      return { noted: cfg.text };
    },
  });

  /** What only an admin accepts (`approver: "admin"`): package/install's kind. */
  const installed: string[] = [];
  const installer = defineStep({
    type: "installer",
    effect: "write",
    approver: "admin",
    input: z.object({ name: z.string() }),
    output: z.any(),
    async run(cfg) {
      installed.push(cfg.name);
      return { installed: cfg.name };
    },
  });

  const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
  const toolUse = (name: string, input: unknown) =>
    sse({
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    }) +
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${requests.length}`, name, input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    sse({ type: "message_stop" });
  const lastUser = (body: any) => JSON.stringify(body.messages.filter((m: any) => m.role === "user").at(-1));
  const toolsOf = (body: any): string[] => (body.tools ?? []).map((t: any) => t.name);

  const headers = (actor?: string) => ({ "content-type": "application/json", authorization: `Bearer ${KEY}`, ...(actor ? { "x-strut-actor": actor } : {}) });
  const idle = () =>
    until(async () => {
      const active = (await (await strut.app.request("/runs/active", { headers: headers() })).json()) as unknown[];
      return active.length ? undefined : true;
    }, "idle");

  /** A page's `step_run`, as the viewer `actor` (none: no person); `admin`
   *  when the door holds full scope (an admin's session, the key). */
  const page = (name: string, actor?: string, admin = false) => {
    const tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, ...(actor ? { actor } : {}), admin, runStepDeps: { store, workspace: strut.workspace } });
    const app = appIdentity(name, "v1");
    const call = async (type: string, config: Record<string, unknown> = {}) =>
      (await (tools[STEP_RUN_TOOL] as any).execute({ type, config, app }, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
    const ok = async (type: string, config: Record<string, unknown> = {}) => {
      const r = await call(type, config);
      assert.equal(r.error, undefined, r.error);
      return r.result;
    };
    /** A turn of the orchestrator from the page, waited for. */
    const turn = async (session: string, prompt: string) => {
      const { runId } = await ok("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt, session } });
      const done = await ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId, wait: 20_000 });
      assert.equal(done.status, "success", JSON.stringify(done.error));
      return runId as string;
    };
    return { call, ok, turn };
  };

  const MANIFEST = ["title: Assistant", "grants:", "  workflows: [orchestrator]", "  steps: [conversation/*, proposal/*, job/get]", ""].join("\n");

  const writeApp = async (dir: string, manifest = MANIFEST) => {
    for (const [rel, text] of Object.entries({ "app.yaml": manifest, "src/App.tsx": 'export default function App() { return <p>hi</p>; }\n' })) {
      await mkdir(join(dir, dirname(rel)), { recursive: true });
      await writeFile(join(dir, rel), text, "utf8");
    }
    return dir;
  };

  before(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["STRUT_API_KEY"] = KEY;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    // A package/install proposal reads its card off the followed indexes: none, never the real one.
    process.env["STRUT_PACKAGE_INDEXES"] = "[]";
    root = await mkdtemp(join(tmpdir(), "strut-first-party-"));

    // The stand-in model: a wake says "Summary."; "note it" calls the gated
    // `note` when the turn holds it; "find flights" starts a job.
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const user = lastUser(body);
        const reply = (input: unknown) => res.writeHead(200, { "content-type": "text/event-stream" }).end(toolUse("final_answer", input));
        if (user.includes("<<<job reply")) return reply({ text: "Summary.", artifacts: [] });
        if (user.includes("install it") && toolsOf(body).includes("installer")) {
          return res.writeHead(200, { "content-type": "text/event-stream" }).end(toolUse("installer", { name: "pkg", rationale: "asked to" }));
        }
        if (user.includes("note it") && toolsOf(body).includes("note")) {
          return res.writeHead(200, { "content-type": "text/event-stream" }).end(toolUse("note", { text: "remember milk", rationale: "asked to" }));
        }
        if (user.includes("find flights")) return reply({ text: "Looking.", start: { brief: "Find flights", title: "Flights" }, artifacts: [] });
        return reply({ text: "Hello.", artifacts: [] });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;

    registry = await createRegistry([note, installer]);
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store,
      registry,
      kit: await kitForTests(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      builder: false,
      autoResume: false,
      browserWorkflows: false,
      privacyWorkflows: false, mediaWorkflows: false,
      orchestrator: { tools: ["note", "installer"], approve: ["note", "installer"] },
      // The test publishes its own stand-in for strut's app (below).
      jamie: false,
    });
    await strut.workspace.publishWorkflow("job", "v1", {
      steps: [{ id: "result", type: "pack", config: { text: "{{ input.prompt }}: found 3", artifacts: [] } }],
    });
    // strut's own app, as the seed publishes it — no grant of anything.
    assert.ok((await strut.apps.publish(await writeApp(join(root, "apps", "jamie")), "strut/jamie", { surface: "person", source: "seed" })).ok);
    await strut.apps.revoke("strut/jamie", ORCHESTRATOR_WORKFLOW);
    assert.deepEqual(await strut.apps.grantsOf("strut/jamie"), []);
    // A model-written app a person granted the orchestrator, for contrast.
    assert.ok((await strut.apps.publish(await writeApp(join(root, "apps", "plain")), "plain", { surface: "person" })).ok);
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("no door but the seed publishes under strut/", async () => {
    const dir = await writeApp(join(root, "apps", "other"));
    for (const opts of [{ surface: "person" as const }, { surface: "ai" as const }, { surface: "person" as const, source: "install" as const }]) {
      const r = await strut.apps.publish(dir, "strut/other", opts);
      assert.equal(r.ok, false, JSON.stringify(opts));
      assert.match((r as { errors: string[] }).errors[0]!, /reserved for the apps strut ships/);
    }
    const preview = await strut.apps.preview(dir, "strut/other", { surface: "ai" });
    assert.equal(preview.ok, false);
    const res = await strut.app.request("/apps", { method: "POST", headers: headers("alice"), body: JSON.stringify({ name: "strut/other", files: { "app.yaml": MANIFEST } }) });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /reserved/);
  });

  it("a turn from strut's own app: the person's session, the gated tools kept, the proposal theirs to decide", async () => {
    const alice = page("strut/jamie", "alice");
    const runId = await alice.turn("alice/c1", "note it");

    const start = (await alice.ok("run/events", { workflow: ORCHESTRATOR_WORKFLOW, runId })).find((e: any) => e.type === "run.start");
    assert.deepEqual(start.app, { name: "strut/jamie", version: "v1", firstParty: true });
    assert.equal(start.wakeAsked, true, "strut is the page's host: it wakes the conversation");
    assert.ok(requests.some((b) => lastUser(b).includes("note it") && toolsOf(b).includes("note")), "the gated tool was offered");

    // The person's own conversation, recorded in the index.
    const list = await alice.ok("conversation/list");
    assert.deepEqual(list.conversations.map((c: any) => c.id), ["alice/c1"]);
    const view = await alice.ok("conversation/get", { session: "alice/c1" });
    assert.equal(view.turns[0].prompt, "note it");

    // The proposal it made, listed for alice alone, decided by her.
    const { proposals } = await alice.ok("proposal/list", { status: "pending" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].step, "note");
    const bob = page("strut/jamie", "bob");
    assert.deepEqual((await bob.ok("proposal/list", { status: "pending" })).proposals, []);
    assert.match((await bob.call("proposal/decide", { id: proposals[0].id, action: "accept" })).error!, /not yours to decide/);
    assert.deepEqual(noted, []);

    const decided = await alice.ok("proposal/decide", { id: proposals[0].id, action: "accept" });
    assert.equal(decided.status, "applied");
    assert.equal(decided.decision.by, "alice");
    assert.deepEqual(noted, ["remember milk"]);
    assert.match((await alice.call("proposal/decide", { id: proposals[0].id, action: "accept" })).error!, /is applied/);
  });

  it("what only an admin accepts: a member's turn proposes nothing and says why; an admin's card is theirs to accept, never their member session's", async () => {
    // A member's page: the turn's tool call is refused, the model reads why.
    const mo = page("strut/jamie", "mo");
    await mo.turn("mo/c1", "install it");
    assert.deepEqual((await mo.ok("proposal/list", { status: "pending" })).proposals, []);
    assert.ok(
      requests.some((b) => JSON.stringify(b.messages).includes("admin_required: installer is an admin's decision on this strut server")),
      "the model was told an admin decides it",
    );

    // An admin's page: proposed, the record saying who accepts it.
    const ada = page("strut/jamie", "ada", true);
    const runId = await ada.turn("ada/c1", "install it");
    const start = (await ada.ok("run/events", { workflow: ORCHESTRATOR_WORKFLOW, runId })).find((e: any) => e.type === "run.start");
    assert.deepEqual(start.app, { name: "strut/jamie", version: "v1", firstParty: true, admin: true });
    const { proposals } = await ada.ok("proposal/list", { status: "pending" });
    assert.deepEqual(proposals.map((p: any) => [p.step, p.approver]), [["installer", "admin"]]);
    const id = proposals[0].id;
    assert.deepEqual((await ada.ok("proposal/get", { id })).viewer, { admin: true });

    // The same person through a member's session: told, and refused.
    const adaMember = page("strut/jamie", "ada");
    assert.deepEqual((await adaMember.ok("proposal/get", { id })).viewer, { admin: false });
    assert.match((await adaMember.call("proposal/decide", { id, action: "accept" })).error!, /^admin_required: only an admin of this strut server accepts/);
    assert.equal((await ada.ok("proposal/get", { id })).status, "pending");
    assert.deepEqual(installed, []);

    const decided = await ada.ok("proposal/decide", { id, action: "accept" });
    assert.equal(decided.status, "applied");
    assert.deepEqual(installed, ["pkg"]);
  });

  it("the viewer's runs of the sealed orchestrator, whoever launched them; never another's", async () => {
    const alice = page("strut/jamie", "alice");
    const res = await strut.app.request(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
      method: "POST",
      headers: headers("alice"),
      body: JSON.stringify({ input: { prompt: "hi from hive", session: "alice/c2" } }),
    });
    assert.equal(res.status, 202);
    const { runId: fromHost } = (await res.json()) as { runId: string };
    const bobs = await page("strut/jamie", "bob").turn("bob/c1", "hi");
    await idle();

    const mine = (await alice.ok("run/list", { workflow: ORCHESTRATOR_WORKFLOW })).map((r: any) => r.runId);
    assert.ok(mine.includes(fromHost), "a run the host launched for her");
    assert.ok(!mine.includes(bobs), "never bob's");
    assert.match((await alice.call("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId: bobs })).error!, /not found/);
    assert.equal((await alice.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId: fromHost })).runId, fromHost);

    // With no person, strut's own app is an app like any other: no grant, no orchestrator.
    assert.match((await page("strut/jamie").call("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "x", session: "c" } })).error!, /holds no grant of it/);
  });

  it("its jobs are the person's, and the wake comes back to the conversation", async () => {
    const alice = page("strut/jamie", "alice");
    await alice.turn("alice/c3", "find flights");
    const wake = await until(async () => {
      const turns = (await alice.ok("conversation/get", { session: "alice/c3" })).turns;
      return turns.length === 2 && turns[0].status === "success" ? turns : undefined;
    }, "the wake turn");
    await idle();
    const [woke, person] = wake;
    assert.equal(person.prompt, "find flights");
    assert.equal(person.jobs.length, 1);
    assert.ok(!person.jobs[0].job.startsWith("app/"), `the person's own job, not the app's: ${person.jobs[0].job}`);
    assert.deepEqual(woke.wake, { job: person.jobs[0].job, runId: person.jobs[0].runId });
    assert.equal(woke.text, "Summary.");
    assert.ok((await alice.ok("job/get", { job: person.jobs[0].job })).job, "the page reads the person's job");
  });

  it("a conversation Hive started: the viewer continues it once they took a turn in it, or it is shared; never another's", async () => {
    // Hive's ids are bare; its turns run with the deployment's key.
    const host = async (actor: string, session: string, prompt: string) => {
      const res = await strut.app.request(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
        method: "POST",
        headers: headers(actor),
        body: JSON.stringify({ input: { prompt, session } }),
      });
      assert.equal(res.status, 202);
      await idle();
    };
    await host("alice", "hive-conv-1", "plan the offsite");
    const alice = page("strut/jamie", "alice");
    const bob = page("strut/jamie", "bob");

    const runId = await alice.turn("hive-conv-1", "add a budget");
    const start = (await alice.ok("run/events", { workflow: ORCHESTRATOR_WORKFLOW, runId })).find((e: any) => e.type === "run.start");
    assert.equal(start.continues, "hive-conv-1");
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("plan the offsite"), "the thread's history was sent");
    assert.deepEqual((await alice.ok("conversation/get", { session: "hive-conv-1" })).turns.map((t: any) => t.prompt), ["add a budget", "plan the offsite"]);
    const sessions = ((await (await strut.app.request("/sessions", { headers: headers() })).json()) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    assert.ok(!sessions.some((id) => id.endsWith("hive-conv-1") && id !== "hive-conv-1"), sessions.join(", "));

    const refused = await bob.call("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "me too", session: "hive-conv-1" } });
    assert.match(refused.error!, /conversation_not_yours/);
    await alice.ok("conversation/update", { session: "hive-conv-1", shared: true });
    await bob.turn("hive-conv-1", "me too");
    assert.deepEqual((await bob.ok("conversation/get", { session: "hive-conv-1" })).participants, ["alice", "bob"]);
  });

  it("a model-written page gets none of it", async () => {
    const plain = page("plain", "alice");
    const { runId } = await plain.ok("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "note it", session: "alice/c9" } });
    await plain.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId, wait: 20_000 });
    const start = (await plain.ok("run/events", { workflow: ORCHESTRATOR_WORKFLOW, runId })).find((e: any) => e.type === "run.start");
    assert.deepEqual(start.app, { name: "plain", version: "v1" });
    assert.equal(start.wakeAsked, undefined);
    const asked = requests.filter((b) => lastUser(b).includes("note it"));
    assert.ok(!toolsOf(asked.at(-1)).includes("note"), "the gated tool left out");
    assert.match((await plain.call("conversation/list")).error!, /not available to an app's page/);
    assert.match((await plain.call("proposal/decide", { id: "x", action: "reject" })).error!, /a person's decision/);
    // Its session is the app's, never the person's conversation.
    const ids = (await page("strut/jamie", "alice").ok("conversation/list")).conversations.map((c: any) => c.id);
    assert.ok(!ids.includes("alice/c9"), ids.join(", "));
  });
});
