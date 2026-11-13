// The worker's door (plans/human-steps.md §5, §6; §13's row 3): a run asks
// a person with a `human` step, a worker signed in to the worker app takes
// the task through the `task/*` steps on `POST /public/mcp` (or a member's
// page on `POST /mcp`), answers it, and the run goes on. The staff's
// `/tasks` routes make the types and grant them.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { z } from "zod";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { defineStep, type RunSummary, type StepContext } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { appIdentity } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";
import { STEP_RUN_TOOL } from "../apps/tools.js";
import { createRegistry } from "../steps/registry.js";
import { TASK_REQUESTS_PER_MINUTE } from "./tasks.js";
import { PUBLIC_REQUESTS_PER_MINUTE } from "../public-routes.js";

const KEY = "worker-door-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const json = { "content-type": "application/json" };
const TYPE = "pet-match";
/** A worker's balance with nothing earned (§8.1). */
const NOTHING = { totalMsat: 0, heldMsat: 0, withdrawableMsat: 0 };
const MATCH = {
  type: "object",
  properties: { same: { type: "boolean" }, note: { type: "string", maxLength: 200 } },
  required: ["same"],
};

const subtle = webcrypto.subtle;
const hex = (b: ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString("hex");
const p256Key = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const p256Sign = async (key: CryptoKeyPair, message: string) => ({
  key: hex(await subtle.exportKey("raw", key.publicKey)),
  sig: hex(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(message))),
});

/** Writes files under the run's artifacts. */
const writeFiles = defineStep({
  type: "test/write-files",
  input: z.object({ paths: z.array(z.string()) }),
  output: z.any(),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    for (const p of cfg.paths) await ctx!.services.artifacts!.write(ctx!.runId, p, `file ${p}`);
    return cfg.paths;
  },
});

const PETS = `name: pets
steps:
  - id: photos
    type: test/write-files
    config:
      paths: ["found.jpg", "lost/a.jpg", "lost/b.jpg", "notes.txt"]
  - id: review
    type: human
    config:
      task: ${TYPE}
      show:
        guess: "{{ input.guess }}"
      files: ["found.jpg", "lost/*.jpg"]
  - id: done
    type: pack
    config:
      same: "{{ review.answer.same }}"
      by: "{{ review.by }}"
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 60 * 60 * 1000;

/** A paid type's workflow (plans/human-steps.md §8.1). */
const PAID = `name: paid
steps:
  - id: review
    type: human
    config:
      task: paid-match
`;

describe("the worker's door (plans/human-steps.md §5, §6)", () => {
  let root: string;
  let saved: string | undefined;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let identity: string;
  let otherIdentity: string;
  let ungranted: string;
  let version: string;
  /** The task store's clock, ahead of the wall's by this much. */
  let ahead = 0;

  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://workers.test${path}`, init);
  /** A visitor signs in with a new key: its token and actor. */
  const signIn = async () => {
    const key = await p256Key();
    const { challenge } = (await (await req("/visitors/challenge")).json()) as { challenge: string };
    const res = await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge, method: "key", ...(await p256Sign(key, challenge)) }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as { actor: string; token: string };
  };
  /** A page's call on a door, as its host sends it. */
  const mcp = async (path: string, type: string, config: Record<string, unknown>, headers: Record<string, string>, app: string) => {
    const res = await req(path, {
      method: "POST",
      headers: { ...json, accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { type, config, app } } }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
    const out = JSON.parse(body.result.content[0].text) as Record<string, any>;
    return body.result.isError ? { error: out["error"] as string } : { result: out };
  };
  /** A signed-in visitor's call through the visitor's door. */
  const call = (token: string | undefined, type: string, config: Record<string, unknown> = {}, app = identity) =>
    mcp("/public/mcp", type, config, token ? { authorization: `Bearer ${token}` } : {}, app);
  const staff = (method: string, path: string, body?: unknown) =>
    req(path, { method, headers: auth, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const launch = async (input: Record<string, unknown> = {}) => {
    const res = await req("/workflows/pets/run", { method: "POST", headers: auth, body: JSON.stringify({ input }) });
    assert.equal(res.status, 202, await res.clone().text());
    return ((await res.json()) as { runId: string }).runId;
  };
  const summaryWhen = async (runId: string, pred: (s: RunSummary) => boolean, ms = 8000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = await strut.store.getRunSummary("pets", runId);
      if (s && pred(s)) return s;
      if (Date.now() > deadline) throw new Error(`no summary matched (last: ${JSON.stringify(s?.status)})`);
      await sleep(10);
    }
  };
  /** A run that waits on its `human` step: its task id. */
  const parked = async (input: Record<string, unknown> = {}) => {
    const runId = await launch(input);
    await summaryWhen(runId, (s) => s.status === "waiting");
    const [task] = await strut.tasks.capability.list({ runId });
    return { runId, task: task! };
  };

  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    const kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-worker-door-"));
    const workspace = new WorkspaceManager(join(root, "ws"));
    strut = await createStrut({
      workspace, kit, registry: await createRegistry([writeFiles]),
      scheduler: false, serveUi: false, autoResume: false, wakeDelayMs: 0,
      // $100,000 a bitcoin: a sat is $0.001.
      payments: { rate: async () => ({ usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" }) },
      tasks: { now: () => Date.now() + ahead },
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    await workspace.publishWorkflowByContent("pets", PETS);
    await workspace.publishWorkflowByContent("paid", PAID);
    const apps: Array<[string, string]> = [
      ["workers", "steps: [task/next, task/submit, task/skip, task/file, task/me]"],
      ["other", "steps: [\"task/*\"]"],
      ["plain", "steps: []"],
    ];
    for (const [name, grants] of apps) {
      const dir = join(root, "apps", name);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "app.yaml"), `title: ${name}\ngrants:\n  ${grants}\n`);
      await writeFile(join(dir, "src", "App.tsx"), `export default function App() { return <p>${name}</p>; }\n`);
      const r = await strut.apps.publish(dir, name, { surface: "person" });
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    }
    const view = await req("/public-view", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ apps: [{ name: "workers" }, { name: "other" }, { name: "plain" }], visitors: { signIn: ["key"] } }),
    });
    assert.equal(view.status, 200, await view.clone().text());
    const tokenOf = async (name: string) => {
      const html = await (await req(`/public/apps/${name}/document`)).text();
      return html.match(/<meta name="strut-app-token" content="([^"]+)">/)![1]!.replace(/&amp;/g, "&");
    };
    identity = await tokenOf("workers");
    otherIdentity = await tokenOf("other");
    ungranted = await tokenOf("plain");
    version = identity.match(/^app:workers@(v\d+)\./)![1]!;
    // The staff's: the type, drawn by the worker app.
    // Invite-only, as built in #657: open types are the last test's (ruling 9).
    const put = await staff("PUT", `/tasks/types/${TYPE}`, { app: "workers", answer: MATCH, leaseSeconds: 600, open: false });
    assert.equal(put.status, 200, await put.clone().text());
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await rm(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
  });

  it("end to end: a run parks on human, a signed-in worker's page answers through /public/mcp, and the run finishes", async () => {
    const worker = await signIn();
    // First sight: a new worker, whom staff then grant the type.
    assert.deepEqual(await call(worker.token, "task/me"), { result: { actor: worker.actor, status: "new", types: [], balance: NOTHING } });
    const workers = (await (await staff("GET", "/tasks/workers?status=new")).json()) as { workers: Array<{ actor: string }> };
    assert.ok(workers.workers.some((w) => w.actor === worker.actor), "staff see the new worker");
    const granted = await staff("PUT", `/tasks/workers/${encodeURIComponent(worker.actor)}/grants/${TYPE}`);
    assert.equal(granted.status, 200, await granted.clone().text());
    assert.deepEqual(await call(worker.token, "task/me"), { result: { actor: worker.actor, status: "active", types: [{ name: TYPE, app: "workers", payMsat: 0, qualifying: false }], balance: NOTHING } });

    const { runId, task } = await parked({ guess: "same dog" });
    const next = await call(worker.token, "task/next", { wait: 1 });
    assert.ok(next.result, next.error);
    const got = next.result as { lease: string; type: string; show: unknown; files: string[]; answer: unknown };
    assert.equal(got.type, TYPE);
    assert.deepEqual(got.show, { guess: "same dog" });
    assert.deepEqual(got.files, ["found.jpg", "lost/a.jpg", "lost/b.jpg"]);
    assert.deepEqual(got.answer, MATCH);
    const file = await call(worker.token, "task/file", { lease: got.lease, path: "lost/b.jpg" });
    assert.deepEqual(file.result, { path: "lost/b.jpg", mediaType: "image/jpeg", bytes: 15, text: "file lost/b.jpg" });
    assert.match((await call(worker.token, "task/submit", { lease: got.lease, answer: { same: "yes" } })).error ?? "", /bad_answer/);
    assert.deepEqual(await call(worker.token, "task/submit", { lease: got.lease, answer: { same: true, note: "the collar" } }), { result: { ok: true } });
    const done = await summaryWhen(runId, (s) => s.status === "success");
    assert.deepEqual(done.output, { same: true, by: worker.actor });
    const view = (await (await staff("GET", `/tasks/${task.id}`)).json()) as { task: { status: string; by: string; leases: Array<{ status: string }> } };
    assert.deepEqual([view.task.status, view.task.by, view.task.leases.map((l) => l.status)], ["settled", worker.actor, ["submitted"]]);
  });

  it("pay end to end: the answer earns, the run's totals count it, task/me shows it held then withdrawable, and only staff take it back", async () => {
    const typeOf = async (res: Response) => ((await res.json()) as { type: { paySats?: number; holdHours: number } }).type;
    for (const bad of [{ paySats: -1 }, { paySats: 1_000_001 }, { paySats: 0.0001 }, { holdHours: 0 }, { holdHours: 721 }]) {
      assert.equal((await staff("PUT", "/tasks/types/paid-match", { app: "workers", answer: MATCH, ...bad })).status, 400, JSON.stringify(bad));
    }
    const put = await staff("PUT", "/tasks/types/paid-match", { app: "workers", answer: MATCH, open: false, paySats: 21, holdHours: 1 });
    assert.equal(put.status, 200, await put.clone().text());
    const saved = await typeOf(put);
    assert.deepEqual([saved.paySats, saved.holdHours], [21, 1]);
    const worker = await signIn();
    await staff("PUT", `/tasks/workers/${encodeURIComponent(worker.actor)}/grants/paid-match`);
    assert.deepEqual(await call(worker.token, "task/me"), { result: { actor: worker.actor, status: "active", types: [{ name: "paid-match", app: "workers", payMsat: 21_000, qualifying: false }], balance: NOTHING } });

    /** A paid run, answered: its task and the run as it ended. */
    const answered = async () => {
      const res = await req("/workflows/paid/run", { method: "POST", headers: auth, body: JSON.stringify({ input: {} }) });
      const { runId } = (await res.json()) as { runId: string };
      const deadline = Date.now() + 8000;
      while ((await strut.store.getRunSummary("paid", runId))?.status !== "waiting") {
        if (Date.now() > deadline) throw new Error("never waited");
        await sleep(10);
      }
      const got = (await call(worker.token, "task/next", { wait: 1 })).result as { lease: string; payMsat: number };
      assert.equal(got.payMsat, 21_000, "what this answer earns, before it is given");
      assert.deepEqual(await call(worker.token, "task/submit", { lease: got.lease, answer: { same: true } }), { result: { ok: true } });
      let done: RunSummary | null = null;
      while ((done = await strut.store.getRunSummary("paid", runId))?.status !== "success") {
        if (Date.now() > deadline) throw new Error(`never finished: ${JSON.stringify(done?.status)}`);
        await sleep(10);
      }
      const [task] = await strut.tasks.capability.list({ runId });
      return { task: task!, done: done!, lease: got.lease };
    };
    try {
      const one = await answered();
      assert.equal(one.done.totals?.cost, 0.021, "the run's cost counts its human work");
      assert.equal(one.done.totals?.modelCalls, 0);
      const me = (await call(worker.token, "task/me")).result as { balance: { totalMsat: number; heldMsat: number; withdrawableMsat: number; nextReleaseAt?: number } };
      assert.deepEqual([me.balance.totalMsat, me.balance.heldMsat, me.balance.withdrawableMsat], [21_000, 21_000, 0], "held");
      assert.ok(me.balance.nextReleaseAt! > Date.now() + HOUR - 60_000);

      // Staff see it: the worker's balance and the answer's pay.
      const workers = (await (await staff("GET", "/tasks/workers")).json()) as { workers: Array<{ actor: string; balance: { totalMsat: number } }> };
      assert.equal(workers.workers.find((w) => w.actor === worker.actor)!.balance.totalMsat, 21_000);
      const view = (await (await staff("GET", `/tasks/${one.task.id}`)).json()) as { task: { leases: Array<{ payMsat: number; bookedAt: number; earning: { msat: number; releases: number } }> } };
      assert.deepEqual([view.task.leases[0]!.payMsat, view.task.leases[0]!.earning.msat], [21_000, 21_000]);

      // No one but staff takes pay back: the visitor's own session, a member's page, a peer.
      const takeBack = (headers: Record<string, string>, task = one.task.id, body: unknown = { why: "bad" }) =>
        req(`/tasks/${task}/take-back`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });
      assert.equal((await takeBack({ authorization: `Bearer ${worker.token}` })).status, 403);
      process.env["STRUT_PEER_KEY"] = "worker-door-peer";
      try {
        assert.equal((await takeBack({ authorization: "Bearer worker-door-peer" })).status, 403);
      } finally {
        delete process.env["STRUT_PEER_KEY"];
      }
      assert.ok(!("takeBack" in strut.tasks.worker) && !("takeBack" in strut.tasks.capability), "no capability, so no step, reaches it");
      assert.equal((await takeBack({ authorization: `Bearer ${KEY}` }, one.task.id, { nope: 1 })).status, 400);
      assert.equal((await takeBack({ authorization: `Bearer ${KEY}` }, one.task.id, {})).status, 400, "a take-back says why");
      assert.equal((await takeBack({ authorization: `Bearer ${KEY}` }, "nope")).status, 404);

      // Inside the hold, staff take a second answer's pay back.
      const two = await answered();
      const res = await takeBack({ authorization: `Bearer ${KEY}` }, two.task.id, { why: "the wrong dog", worker: worker.actor });
      assert.equal(res.status, 200, await res.clone().text());
      const body = (await res.json()) as { earnings: Array<{ result: string; worker: string; earning: { takenBackWhy: string } }> };
      assert.deepEqual(body.earnings.map((e) => [e.worker, e.result, e.earning.takenBackWhy]), [[worker.actor, "taken", "the wrong dog"]]);
      assert.equal(((await call(worker.token, "task/me")).result as { balance: { totalMsat: number } }).balance.totalMsat, 21_000, "the first answer's alone");

      // The clock passes the hold: the first answer's pay is withdrawable, and the worker's.
      ahead = HOUR + 60_000;
      const later = (await call(worker.token, "task/me")).result as { balance: unknown };
      assert.deepEqual(later.balance, { totalMsat: 21_000, heldMsat: 0, withdrawableMsat: 21_000 });
      const late = await takeBack({ authorization: `Bearer ${KEY}` });
      assert.equal(late.status, 409);
      assert.equal(((await late.json()) as { code: string }).code, "released");
    } finally {
      ahead = 0;
    }
  });

  it("a visitor without a grant gets nothing; an anonymous one, nothing at all; an app that does not grant the steps, nothing", async () => {
    const { task } = await parked();
    const worker = await signIn();
    assert.match((await call(worker.token, "task/next")).error ?? "", /not_active: you have no task types yet/);
    assert.match((await call(undefined, "task/next")).error ?? "", /task\/next is a worker's: sign in first/);
    assert.match((await call(undefined, "task/me")).error ?? "", /sign in first/);
    await staff("PUT", `/tasks/workers/${encodeURIComponent(worker.actor)}/grants/${TYPE}`);
    assert.match((await call(worker.token, "task/next", {}, ungranted)).error ?? "", /step "task\/next" is not granted to this app/);
    assert.equal((await strut.tasks.capability.task(task.id))!.leases.length, 0, "nobody took it");
  });

  it("a suspended worker's next call is refused, and their lease is let go", async () => {
    await parked();
    const worker = await signIn();
    await staff("PUT", `/tasks/workers/${encodeURIComponent(worker.actor)}/grants/${TYPE}`);
    const got = (await call(worker.token, "task/next")).result as { lease: string };
    assert.ok(got?.lease);
    const res = await staff("PUT", `/tasks/workers/${encodeURIComponent(worker.actor)}`, { status: "suspended", note: "too fast" });
    assert.equal(res.status, 200, await res.clone().text());
    assert.match((await call(worker.token, "task/next")).error ?? "", /not_active: you are suspended/);
    assert.match((await call(worker.token, "task/submit", { lease: got.lease, answer: { same: true } })).error ?? "", /not_active/);
    assert.deepEqual(await call(worker.token, "task/me"), { result: { actor: worker.actor, status: "suspended", types: [{ name: TYPE, app: "workers", payMsat: 0, qualifying: false }], balance: NOTHING } });
  });

  it("a page cannot name another worker: the worker is the session's actor, whatever the config says", async () => {
    await parked();
    const ann = await signIn();
    const bob = await signIn();
    for (const w of [ann, bob]) await staff("PUT", `/tasks/workers/${encodeURIComponent(w.actor)}/grants/${TYPE}`);
    const got = (await call(ann.token, "task/next", { actor: bob.actor })).result as { lease: string };
    const view = (await strut.tasks.capability.list({ type: TYPE, status: "open" })).find((t) => t.leases.some((l) => l.id === got.lease))!;
    assert.equal(view.leases.find((l) => l.id === got.lease)!.worker, ann.actor);
    assert.match((await call(bob.token, "task/submit", { lease: got.lease, answer: { same: true } })).error ?? "", /no_lease/);
    assert.match((await call(bob.token, "task/file", { lease: got.lease, path: "found.jpg" })).error ?? "", /no_lease/);
    await call(ann.token, "task/skip", { lease: got.lease, reason: "not mine" });
  });

  it("a different app cannot pull the type, nor answer by its lease; its next with no type gives none of the type's", async () => {
    await parked();
    const w = await signIn();
    await staff("PUT", `/tasks/workers/${encodeURIComponent(w.actor)}/grants/${TYPE}`);
    assert.match((await call(w.token, "task/next", { type: TYPE }, otherIdentity)).error ?? "", /wrong_app/);
    assert.deepEqual(await call(w.token, "task/next", {}, otherIdentity), { result: { none: true } });
    assert.deepEqual(await call(w.token, "task/me", {}, otherIdentity), { result: { actor: w.actor, status: "active", types: [], balance: NOTHING } });
    const got = (await call(w.token, "task/next")).result as { lease: string };
    assert.match((await call(w.token, "task/submit", { lease: got.lease, answer: { same: true } }, otherIdentity)).error ?? "", /wrong_app/);
    assert.match((await call(w.token, "task/file", { lease: got.lease, path: "found.jpg" }, otherIdentity)).error ?? "", /wrong_app/);
    await call(w.token, "task/skip", { lease: got.lease });
  });

  it("task/file refuses a path not on the task's list, though the run wrote it, and reads a listed one", async () => {
    await parked();
    const w = await signIn();
    await staff("PUT", `/tasks/workers/${encodeURIComponent(w.actor)}/grants/${TYPE}`);
    const got = (await call(w.token, "task/next")).result as { lease: string; files: string[] };
    assert.ok(!got.files.includes("notes.txt"));
    assert.match((await call(w.token, "task/file", { lease: got.lease, path: "notes.txt" })).error ?? "", /not_listed/);
    assert.match((await call(w.token, "task/file", { lease: got.lease, path: "lost/*.jpg" })).error ?? "", /not_listed/, "a pattern is no path: the list was fixed when the task was made");
    assert.equal(((await call(w.token, "task/file", { lease: got.lease, path: "found.jpg" })).result as { text: string }).text, "file found.jpg");
    await call(w.token, "task/skip", { lease: got.lease });
  });

  it("no run is kept and no run directory written for a worker's calls", async () => {
    await parked();
    const w = await signIn();
    await staff("PUT", `/tasks/workers/${encodeURIComponent(w.actor)}/grants/${TYPE}`);
    const dataDir = join(root, "ws");
    const artifactsBefore = await readdir(join(dataDir, "artifacts")).catch(() => [] as string[]);
    const got = (await call(w.token, "task/next")).result as { lease: string };
    await call(w.token, "task/file", { lease: got.lease, path: "found.jpg" });
    await call(w.token, "task/me");
    assert.deepEqual(await call(w.token, "task/submit", { lease: got.lease, answer: { same: false } }), { result: { ok: true } });
    for (const t of ["task/next", "task/submit", "task/skip", "task/file", "task/me"]) {
      assert.deepEqual(await strut.store.listRuns(`step:${t}`), [], t);
      assert.equal(existsSync(join(dataDir, "steps", t, "runs")), false, t);
    }
    assert.deepEqual(await readdir(join(dataDir, "artifacts")).catch(() => [] as string[]), artifactsBefore, "no run directory");
  });

  it("task/next with no type returns a task of any type the worker holds in the calling app", async () => {
    await staff("PUT", "/tasks/types/ballot", { app: "workers", answer: MATCH, open: false });
    const w = await signIn();
    await staff("PUT", `/tasks/workers/${encodeURIComponent(w.actor)}/grants/ballot`);
    // Only `ballot` is held: the pets runs' tasks are not this worker's.
    await strut.tasks.capability.ensure({ type: "ballot", workflow: "ballots", runId: "b1", path: "ballots/check", show: { n: 1 } });
    const got = (await call(w.token, "task/next")).result as { type: string; show: unknown; lease: string };
    assert.deepEqual([got.type, got.show], ["ballot", { n: 1 }]);
    assert.deepEqual(await call(w.token, "task/me"), { result: { actor: w.actor, status: "active", types: [{ name: "ballot", app: "workers", payMsat: 0, qualifying: false }], balance: NOTHING } });
    await call(w.token, "task/submit", { lease: got.lease, answer: { same: true } });
  });

  it("a held next answers when a task is made; a member's page on POST /mcp takes tasks as its viewer", async () => {
    // A member: a ticket with no role, traded for a session.
    const minted = await req("/auth/ticket", { method: "POST", headers: auth, body: JSON.stringify({ actor: "ada-1" }) });
    const { ticket } = (await minted.json()) as { ticket: string };
    const traded = await req("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
    const cookie = traded.headers.get("set-cookie")!.split(";")[0]!;
    const member = { cookie, "x-strut-ui": "1" };
    const page = appIdentity("workers", version);
    assert.deepEqual(await mcp("/mcp", "task/me", {}, member, page), { result: { actor: "ada-1", status: "new", types: [], balance: NOTHING } });
    await staff("PUT", `/tasks/workers/ada-1/grants/${TYPE}`);
    // Clear the queue of open pets tasks first, so the held call waits.
    for (;;) {
      const r = await mcp("/mcp", "task/next", {}, member, page);
      if ((r.result as { none?: true }).none) break;
      await mcp("/mcp", "task/skip", { lease: (r.result as { lease: string }).lease }, member, page);
    }
    const held = mcp("/mcp", "task/next", { wait: 5 }, member, page);
    await sleep(100);
    const t0 = Date.now();
    const { runId } = await parked({ guess: "a cat" });
    const got = (await held).result as { lease: string; show: unknown };
    assert.deepEqual(got.show, { guess: "a cat" });
    assert.ok(Date.now() - t0 < 4000, "woken by the task, not the wait's end");
    assert.deepEqual(await mcp("/mcp", "task/submit", { lease: got.lease, answer: { same: false } }, member, page), { result: { ok: true } });
    assert.deepEqual((await summaryWhen(runId, (s) => s.status === "success")).output, { same: false, by: "ada-1" });
  });

  // After the tests that read `other` as drawing nothing, before the budgets spend the address's requests.
  it("an open type end to end: a new signed-in visitor's page takes and answers a parked run's task through /public/mcp with no grant (ruling 9)", async () => {
    // A paid open type with no tests is refused; unpaid, open is the default.
    const paid = await staff("PUT", "/tasks/types/open-paid", { app: "other", answer: MATCH, paySats: 5 });
    assert.equal(paid.status, 409);
    assert.deepEqual(((await paid.json()) as { code: string }).code, "needs_tests");
    const put = await staff("PUT", "/tasks/types/open-match", { app: "other", answer: MATCH });
    assert.equal(put.status, 200, await put.clone().text());
    assert.equal(((await put.json()) as { type: { open: boolean } }).type.open, true);
    await strut.workspace.publishWorkflowByContent("opened", `name: opened\nsteps:\n  - id: review\n    type: human\n    config:\n      task: open-match\n      show:\n        guess: "{{ input.guess }}"\n`);
    const res = await req("/workflows/opened/run", { method: "POST", headers: auth, body: JSON.stringify({ input: { guess: "a stray" } }) });
    assert.equal(res.status, 202, await res.clone().text());
    const { runId } = (await res.json()) as { runId: string };
    const until = async (status: string) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const s = await strut.store.getRunSummary("opened", runId);
        if (s?.status === status) return s;
        if (Date.now() > deadline) throw new Error(`never ${status}: ${JSON.stringify(s?.status)}`);
        await sleep(10);
      }
    };
    await until("waiting");

    // A stranger signs in: new, offered the open type, and nobody granted them anything.
    const w = await signIn();
    assert.deepEqual(await call(w.token, "task/me", {}, otherIdentity), { result: { actor: w.actor, status: "new", types: [{ name: "open-match", app: "other", payMsat: 0, qualifying: false }], balance: NOTHING } });
    assert.match((await call(undefined, "task/next", {}, otherIdentity)).error ?? "", /sign in first/, "an anonymous visitor, nothing");
    const got = (await call(w.token, "task/next", { wait: 1 }, otherIdentity)).result as { lease: string; type: string; show: unknown };
    assert.deepEqual([got.type, got.show], ["open-match", { guess: "a stray" }]);
    assert.deepEqual(await call(w.token, "task/submit", { lease: got.lease, answer: { same: true } }, otherIdentity), { result: { ok: true } });
    const done = await until("success");
    assert.deepEqual((done.output as { answer: unknown; by: string }).by, w.actor);
    // Staff see the grant the first ask recorded, by open; the worker is active and counted as one.
    const seen = (await (await staff("GET", `/tasks/workers/${encodeURIComponent(w.actor)}`)).json()) as { worker: { status: string; grants: Array<{ type: string; by: string }> } };
    assert.deepEqual([seen.worker.status, seen.worker.grants.map((g) => [g.type, g.by])], ["active", [["open-match", "open"]]]);
    assert.equal(strut.tasks.isActiveWorker(w.actor), true);
    // The worker app's own types stay invite-only: nothing of them through `workers`.
    assert.match((await call(w.token, "task/next", { type: TYPE })).error ?? "", /not_granted: you do not hold task type pet-match: it is invite-only/);

    // Suspended: refused at once, the open type notwithstanding.
    await staff("PUT", `/tasks/workers/${encodeURIComponent(w.actor)}`, { status: "suspended" });
    assert.match((await call(w.token, "task/next", {}, otherIdentity)).error ?? "", /not_active: you are suspended/);
  });

  it("an active worker's requests are counted per worker; a new one's per address", async () => {
    const active = await signIn();
    await staff("PUT", `/tasks/workers/${encodeURIComponent(active.actor)}/grants/${TYPE}`);
    assert.equal(strut.tasks.isActiveWorker(active.actor), true);
    const fresh = await signIn();
    await call(fresh.token, "task/me");
    const get = (token?: string) => req("/public/workflows", token ? { headers: { authorization: `Bearer ${token}` } } : {});
    // The budgets are per minute: start clear of the next minute's turn.
    const into = Date.now() % 60_000;
    if (into > 50_000) await sleep(60_000 - into + 50);
    // The active worker's own budget: 240 a minute, whatever the address has left.
    let n = 0;
    for (; n < TASK_REQUESTS_PER_MINUTE; n++) assert.equal((await get(active.token)).status, 200, `request ${n + 1}`);
    assert.equal((await get(active.token)).status, 429, "past the worker's budget");
    assert.equal((await get()).status, 200, "the address's budget is untouched");
    // A new worker is counted with everyone else on the address.
    let ok = 1; // the anonymous request above
    while ((await get(fresh.token)).status === 200) ok++;
    assert.ok(ok <= PUBLIC_REQUESTS_PER_MINUTE && ok > PUBLIC_REQUESTS_PER_MINUTE - 200, `the address's ${PUBLIC_REQUESTS_PER_MINUTE}, less what the tests before spent (${ok})`);
    assert.equal((await get()).status, 429, "the new worker spent the address's budget");
    assert.equal((await get(active.token)).status, 429, "the active worker's own is still spent");
  });

  it("the staff routes: types, workers, grants and tasks, full scope only", async () => {
    // A peer's read, a member's session: refused (the gate's sweeps in createStrut.test.ts cover every route).
    process.env["STRUT_PEER_KEY"] = "worker-door-peer";
    try {
      assert.equal((await req("/tasks/types", { headers: { authorization: "Bearer worker-door-peer" } })).status, 403);
    } finally {
      delete process.env["STRUT_PEER_KEY"];
    }
    assert.equal((await staff("PUT", "/tasks/types/Bad%20Name", { app: "workers", answer: MATCH })).status, 400);
    assert.equal((await staff("PUT", "/tasks/types/acme%2Fbox", { app: "workers", answer: { type: "string", pattern: "x" } })).status, 400);
    const box = await staff("PUT", "/tasks/types/acme%2Fbox", { app: "workers", answer: MATCH, withinHours: 2, open: false });
    assert.equal(box.status, 200, await box.clone().text());
    assert.deepEqual(((await box.json()) as { type: { name: string; withinHours: number; changedBy?: string } }).type.name, "acme/box");
    const types = (await (await staff("GET", "/tasks/types")).json()) as { types: Array<{ name: string }> };
    assert.ok(types.types.some((t) => t.name === "acme/box"));
    assert.equal((await staff("PUT", "/tasks/workers/eve-1", { status: "nope" })).status, 400);
    assert.equal((await staff("PUT", "/tasks/workers/eve-1", { nope: 1 })).status, 400);
    assert.equal((await staff("PUT", "/tasks/workers/eve-1/grants/acme%2Fnone")).status, 404);
    const g = (await (await staff("PUT", "/tasks/workers/eve-1/grants/acme%2Fbox")).json()) as { worker: { status: string; grants: Array<{ type: string }> } };
    assert.deepEqual([g.worker.status, g.worker.grants.map((x) => x.type)], ["active", ["acme/box"]]);
    const r = (await (await staff("DELETE", "/tasks/workers/eve-1/grants/acme%2Fbox?why=done")).json()) as { worker: { grants: Array<{ why?: string }> } };
    assert.equal(r.worker.grants[0]!.why, "done");
    // A type with an open task is not deleted; one without is, its grants with it.
    const { runId, task } = await parked();
    assert.equal((await staff("DELETE", `/tasks/types/${TYPE}`)).status, 409);
    const listed = (await (await staff("GET", `/tasks?runId=${runId}`)).json()) as { tasks: Array<{ id: string }> };
    assert.deepEqual(listed.tasks.map((t) => t.id), [task.id]);
    assert.equal((await staff("GET", "/tasks?status=nope")).status, 400);
    assert.equal((await staff("GET", "/tasks/nope")).status, 404);
    assert.deepEqual(await (await staff("DELETE", "/tasks/types/acme%2Fbox")).json(), { name: "acme/box", revoked: 0 });
    assert.equal((await staff("DELETE", "/tasks/types/acme%2Fbox")).status, 404);
    assert.ok(existsSync(join(root, "ws", "tasks", "tasks.db")));
  });
});
