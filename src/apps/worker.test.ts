/**
 * `strut/worker` (src/apps/worker-seed.ts, plans/human-steps.md §5): the
 * worker app every server has, strut/views' WorkerPage. It is seeded at boot
 * and built; an admin puts it in the public view; a task type names it as
 * its app — here a STANDING type that takes a photo (§5.7), the open-ended
 * "snap a picture" task — and a worker signed in with their Sphinx account
 * picks a task up, answers it with the photo on `POST /public/mcp` as the
 * page does, and the workflow runs on the answer.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import type { RunSummary } from "../core.js";
import { hostConfigFromEnv } from "../server.js";
import { kitForTests } from "../test-util/app-kit.js";
import { jpeg, publicAppToken, setEnv, sphinxSignIn, stepCall } from "../test-util/public-door.js";
import { treeHash } from "../version.js";
import { WORKER_APP, WORKER_DIR, seedWorkerApp } from "./worker-seed.js";

const KEY = "worker-app-key";
const admin = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = { serveUi: false, enableChat: false, enableMcp: true, scheduler: false, autoResume: false, wakeDelayMs: 0 } as const;
const seedsOff = { jamie: false, knowledge: false, earnings: false, staff: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false } as const;

/** The open-ended task: a photo of a nutrition label, checked only for being there. */
const LABELS = `name: label-photos
params:
  ask: "Photograph a nutrition label: the whole panel, flat, in good light."
steps:
  - id: photo
    type: human
    config:
      task: label-photo
      show:
        ask: "{{ params.ask }}"
  - id: done
    type: pack
    config:
      by: "{{ photo.by }}"
      photos: "{{ photo.attachments.length }}"
      product: "{{ photo.answer.product }}"
`;

describe("strut/worker: the worker app every server has", () => {
  let root: string;
  let restoreEnv: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://labels.test${path}`, init);
  const staff = async (method: string, path: string, body?: unknown, status = 200) => {
    const res = await req(path, { method, headers: admin, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    assert.equal(res.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };

  before(async () => {
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_PEER_KEY: undefined });
    root = await mkdtemp(join(tmpdir(), "strut-worker-app-"));
    strut = await createStrut({ ...quiet, ...seedsOff, workspace: new WorkspaceManager(join(root, "ws")), kit: await kitForTests() });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    restoreEnv?.();
    await rm(root, { recursive: true, force: true });
  });

  it("is seeded at boot and built, first-party but not an admin's; a reboot is a no-op; `worker: false` and STRUT_HOST_CONFIG turn it off", async () => {
    const app = await strut.apps.get(WORKER_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale, app.manifest.admin, app.manifest.title], ["v1", "strut", "seed", false, undefined, "Worker"]);
    assert.deepEqual(app.manifest.permissions, ["camera"]);
    assert.equal(app.hash, await treeHash(WORKER_DIR));
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    assert.deepEqual(info.warnings, []);
    assert.deepEqual(await seedWorkerApp({ workspace: strut.workspace, kit: await kitForTests() }), { version: "v1", changed: false });
    const off = await createStrut({ ...quiet, ...seedsOff, views: false, workspace: new WorkspaceManager(join(root, "off")), kit: await kitForTests(), worker: false });
    assert.equal(await off.apps.get(WORKER_APP), null);
    await off.close?.();
    const file = join(root, "host.json");
    await writeFile(file, JSON.stringify({ worker: false }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { worker: false });
    await writeFile(file, JSON.stringify({ worker: true }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"worker" must be false/);
  });

  it("an open-ended photo task: a standing type drawn by strut/worker in the public view, a worker's pick-up answered with a photo, the workflow run on the answer", async () => {
    // ── The workflow and its type: standing, a photo with each answer, paid, open with no tests (ruling 12).
    await staff("POST", "/workflows", { name: "label-photos", yaml: LABELS }, 201);
    const type = await staff("PUT", "/tasks/types/label-photo", {
      app: WORKER_APP,
      answer: { type: "object", properties: { product: { type: "string", title: "Product", maxLength: 120 } } },
      attachments: { max: 2, min: 1, types: ["image/*"] },
      paySats: 50,
      standing: { workflow: "label-photos" },
    });
    assert.deepEqual([type["type"].open, type["type"].standing], [true, { workflow: "label-photos" }]);
    // The queue finds nothing wrong with the app it names.
    const stats = await staff("GET", "/tasks/stats?type=label-photo");
    assert.equal(stats["types"][0].appProblem, undefined, JSON.stringify(stats["types"][0]));

    // ── An admin puts strut/worker in the public view; a worker signs in with Sphinx.
    await staff("PUT", "/public-view", { apps: [{ name: WORKER_APP }], visitors: { signIn: ["sphinx"] } });
    const page = await publicAppToken(req, WORKER_APP);
    const worker = await sphinxSignIn(req);
    const call = (t: string, config: Record<string, unknown> = {}) => stepCall(req, "/public/mcp", t, config, { authorization: `Bearer ${worker.token}` }, page);

    // ── The page's first ask picks a task up: no run yet.
    const me = (await call("task/me")).result as { status: string; types: Array<{ name: string; payMsat: number }> };
    assert.deepEqual(me.types.map((t) => [t.name, t.payMsat]), [["label-photo", 50_000]]);
    const next = await call("task/next", { wait: 1 });
    const task = next.result as { lease: string; type: string; show: { ask: string }; payMsat: number; attachments: unknown };
    assert.ok(task?.lease, next.error);
    assert.deepEqual([task.type, task.show.ask, task.payMsat, task.attachments], ["label-photo", "Photograph a nutrition label: the whole panel, flat, in good light.", 50_000, { max: 2, min: 1, types: ["image/*"] }]);
    assert.deepEqual(await strut.store.listRuns("label-photos"), [], "nothing runs until they answer");

    // ── No photo: refused, the task still theirs. With one: sent, and the workflow runs on it.
    assert.match(String((await call("task/submit", { lease: task.lease, answer: { product: "oat milk" } })).error), /bad_answer: task type label-photo needs a file with each answer/);
    const photo = jpeg(2048, 3);
    const sent = await call("task/submit", { lease: task.lease, answer: { product: "oat milk" }, attachments: [{ name: "label.jpg", mediaType: "image/jpeg", data: photo.toString("base64") }] });
    assert.deepEqual(sent, { result: { ok: true } });
    const deadline = Date.now() + 10_000;
    let runs: string[] = [];
    while (!runs.length && Date.now() < deadline) {
      await sleep(10);
      runs = await strut.store.listRuns("label-photos");
    }
    assert.equal(runs.length, 1, "the answer started a run");
    let done: RunSummary | null = null;
    while (done?.status !== "success" && Date.now() < deadline) {
      await sleep(10);
      done = await strut.store.getRunSummary("label-photos", runs[0]!);
    }
    assert.equal(done?.status, "success", JSON.stringify(done));
    assert.deepEqual(done!.output, { by: worker.actor, photos: 1, product: "oat milk" });

    // ── What it earned is held; the next ask is another pick-up.
    const after = (await call("task/me")).result as { balance: { heldMsat: number } };
    assert.equal(after.balance.heldMsat, 50_000);
    const again = (await call("task/next", { wait: 1 })).result as { lease: string };
    assert.ok(again.lease && again.lease !== task.lease);
  });
});
