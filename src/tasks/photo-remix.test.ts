/**
 * The photo-remix demo end to end (__fixtures__/photo-remix, PR #729): a
 * worker snaps a photo in a custom worker app, an image model reimagines it,
 * and the worker sees the result — through the doors a deployment serves,
 * with no browser and no provider key, as worker-loop.test.ts walks the
 * court-filing demo.
 *
 * A person publishes the app and its workflow (`POST /apps`,
 * `POST /workflows`), puts the app in the public view and makes the STANDING
 * type it draws (`PUT /tasks/types/:name`, paid, open). A worker signs in with
 * their Sphinx account; the page's ask makes a task, its answer is the photo,
 * and the answer launches the workflow: its `image` step edits the photo (a
 * stand-in OpenAI, the global fetch, as image.test.ts plays it) and
 * `task/reply` hands the worker the result and their photo, which they open
 * through the lease they answered by; staff read the reply on the task; the
 * pay is held. When the model refuses, the reply is a plain line instead, so
 * the worker is never left waiting.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import type { RunSummary } from "../core.js";
import { parseModelCatalog, setModelCatalog } from "../aieo/index.js";
import { kitForTests } from "../test-util/app-kit.js";
import { jpeg, publicAppToken, setEnv, sphinxSignIn, stepCall } from "../test-util/public-door.js";

const FIXTURE = new URL("./__fixtures__/photo-remix/", import.meta.url).pathname;
const KEY = "photo-remix-key";
const admin = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const STYLE = "Turn the picture into a futuristic sci-fi steampunk highly intricate version of itself";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** gpt-image-1-mini's datasheet row (bifrost's, 2026-11-12), so the edit is priced. */
const CATALOG = JSON.stringify({
  "gpt-image-1-mini": { mode: "image_generation", input_cost_per_token: 0.000002, input_cost_per_image_token: 0.0000025, output_cost_per_image_token: 0.000008 },
});
/** What the stand-in model draws, and what it reports, as OpenAI's edit answers for medium 1024x1536. */
const RESULT = jpeg(3000);
const USAGE = { input_tokens: 1478, input_tokens_details: { text_tokens: 21, image_tokens: 1457 }, output_tokens: 1584, total_tokens: 3062 };
const COST = (21 * 2 + 1457 * 2.5 + 1584 * 8) / 1_000_000;

/** The stand-in OpenAI: every image edit answered as `mode` says; anything else goes out as it would. */
interface Edit {
  auth: string | null;
  form: FormData;
}
function standInOpenAi() {
  const real = globalThis.fetch;
  const edits: Edit[] = [];
  const stub = { edits, mode: "draw" as "draw" | "refuse", restore: () => (globalThis.fetch = real) };
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://api.openai.com/v1/images/edits") return real(input, init);
    edits.push({ auth: new Headers(init?.headers).get("authorization"), form: init!.body as FormData });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (stub.mode === "refuse") {
      return json(400, { error: { message: "Your request was rejected as a result of our safety system.", type: "image_generation_user_error", code: "moderation_blocked" } });
    }
    return json(200, { created: 1, data: [{ b64_json: RESULT.toString("base64") }], usage: USAGE, size: "1024x1536", quality: "medium", output_format: "jpeg" });
  }) as typeof fetch;
  return stub;
}

describe("the photo-remix demo: a photo snapped, reimagined, and shown back", () => {
  let root: string;
  let restoreEnv: () => void;
  let openai: ReturnType<typeof standInOpenAi>;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let call: (type: string, config?: Record<string, unknown>) => Promise<{ result?: Record<string, any>; error?: string }>;
  let worker: Awaited<ReturnType<typeof sphinxSignIn>>;

  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://remix.test${path}`, init);
  const staff = async (method: string, path: string, body?: unknown, status = 200) => {
    const res = await req(path, { method, headers: admin, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    assert.equal(res.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  /** The run an answer launched: the one not seen before, once it has ended. */
  const launched = async (seen: string[]): Promise<RunSummary> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const id = (await strut.store.listRuns("photo-remix")).find((r) => !seen.includes(r));
      const s = id ? await strut.store.getRunSummary("photo-remix", id) : null;
      if (s && s.status !== "running" && s.status !== "waiting") return s;
      if (Date.now() > deadline) throw new Error(`no run ended: ${JSON.stringify(s)}`);
      await sleep(10);
    }
  };
  /** The page's ask (a standing type makes the task) and its answer with a photo. */
  const snap = async (photo: Buffer) => {
    const next = await call("task/next", { wait: 1, type: "photo-remix" });
    const task = next.result as { lease: string; payMsat: number; show: unknown; attachments: unknown };
    assert.ok(task?.lease, next.error);
    const sent = await call("task/submit", { lease: task.lease, answer: {}, attachments: [{ name: "photo.jpg", mediaType: "image/jpeg", data: photo.toString("base64") }] });
    assert.deepEqual(sent, { result: { ok: true } });
    return task;
  };
  const replyOf = async (lease: string) => {
    const history = (await call("task/history")).result as { items: Array<{ lease: string; type: string; status: string; reply?: { show?: unknown; files?: unknown; at: number } }> };
    return history.items.find((i) => i.lease === lease);
  };

  before(async () => {
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_PEER_KEY: undefined, OPENAI_API_KEY: "test-openai-key" });
    setModelCatalog(parseModelCatalog(CATALOG));
    openai = standInOpenAi();
    root = await mkdtemp(join(tmpdir(), "strut-photo-remix-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      kit: await kitForTests(),
      scheduler: false, serveUi: false, autoResume: false, wakeDelayMs: 0,
      views: false, jamie: false, knowledge: false, earnings: false, workersApp: false, tasksApp: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });

    // ── A person publishes the workflow and the worker app, and makes the app public.
    await staff("POST", "/workflows", { name: "photo-remix", yaml: await readFile(join(FIXTURE, "photo-remix.yaml"), "utf8") }, 201);
    const files: Record<string, string> = {};
    const app = join(FIXTURE, "app");
    for (const f of await readdir(app, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) files[relative(app, join(f.parentPath, f.name))] = await readFile(join(f.parentPath, f.name), "utf8");
    }
    assert.deepEqual(Object.keys(files).sort(), ["app.yaml", "src/App.tsx", "src/Compare.tsx", "src/Pictures.tsx", "src/photo.ts", "src/styles.css"]);
    const published = await staff("POST", "/apps", { name: "photo-remix", files }, 201);
    assert.equal(published["live"], true, JSON.stringify(published));
    const built = JSON.parse(await readFile(join((await strut.apps.get("photo-remix"))!.dir, "dist", "build.json"), "utf8"));
    assert.deepEqual(built.warnings, []);
    await staff("PUT", "/public-view", { apps: [{ name: "photo-remix" }], visitors: { signIn: ["sphinx"] } });

    // ── The type: standing on the workflow, a photo with each answer and nothing else, paid, open to anyone signed in.
    const type = await staff("PUT", "/tasks/types/photo-remix", {
      app: "photo-remix",
      answer: { type: "object", properties: {} },
      attachments: { max: 1, min: 1, types: ["image/*"] },
      paySats: 21,
      holdHours: 72,
      standing: { workflow: "photo-remix" },
    });
    assert.deepEqual([type["type"].open, type["type"].standing], [true, { workflow: "photo-remix" }]);
    const stats = await staff("GET", "/tasks/stats?type=photo-remix");
    assert.equal(stats["types"][0].appProblem, undefined, JSON.stringify(stats["types"][0]));

    // ── A worker signs in with their Sphinx account on the app's public page.
    const page = await publicAppToken(req, "photo-remix");
    worker = await sphinxSignIn(req);
    call = (type, config = {}) => stepCall(req, "/public/mcp", type, config, { authorization: `Bearer ${worker.token}` }, page);
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    openai?.restore();
    setModelCatalog(undefined);
    restoreEnv?.();
    await rm(root, { recursive: true, force: true });
  });

  it("a photo answered on the public page launches the workflow; the model's picture and the photo reach the worker's history, open through their lease and show on the staff's task; the pay is held", async () => {
    const photo = jpeg(2048);
    const task = await snap(photo);
    assert.deepEqual([task.payMsat, task.show, task.attachments], [21_000, { ask: "Take a picture of anything", style: STYLE }, { max: 1, min: 1, types: ["image/*"] }]);

    // ── The run: the photo edited by the model the params name, in their style and quality, as a JPEG.
    const done = await launched([]);
    assert.equal(done.status, "success", JSON.stringify(done.error));
    assert.equal(openai.edits.length, 1);
    const [edit] = openai.edits;
    assert.equal(edit!.auth, "Bearer test-openai-key");
    assert.deepEqual(["model", "prompt", "quality", "output_format", "output_compression"].map((k) => edit!.form.get(k)), ["gpt-image-1-mini", STYLE, "medium", "jpeg", "85"]);
    assert.deepEqual(Buffer.from(await (edit!.form.get("image") as Blob).arrayBuffer()), photo, "the worker's photo, byte for byte");
    const [answered] = await strut.tasks.capability.list({ runId: done.runId });
    const saved = { name: "photo.jpg", mediaType: "image/jpeg", size: photo.length, path: `tasks/${answered!.id}/photo.jpg` };
    const result = { name: "remix.jpg", mediaType: "image/jpeg", size: RESULT.length, path: "images/remix.jpg" };
    const out = done.output as Record<string, any>;
    assert.deepEqual([out["by"], out["image"], out["photo"], out["error"]], [worker.actor, result.path, saved.path, undefined]);
    assert.ok(Math.abs(out["cost"] - COST) < 1e-9, `the edit's price: ${out["cost"]}`);
    assert.deepEqual(out["artifacts"], [
      { id: "remix", title: "Reimagined", path: result.path },
      { id: "photo", title: "The photo", path: saved.path },
    ]);

    // ── The reply on the worker's history: the result first, then their photo; both open through the lease they answered by.
    const item = await replyOf(task.lease);
    assert.equal(item?.status, "submitted");
    assert.deepEqual(item?.reply && { show: item.reply.show, files: item.reply.files }, { show: { title: "Your picture, reimagined", style: STYLE }, files: [result, saved] });
    for (const [file, bytes] of [[result, RESULT], [saved, photo]] as const) {
      const opened = await call("task/file", { lease: task.lease, path: file.path });
      assert.equal((opened.result as { base64?: string } | undefined)?.base64, bytes.toString("base64"), opened.error);
    }

    // ── Staff read the same reply on the task; the earning is held.
    const view = await staff("GET", `/tasks/${answered!.id}`);
    assert.deepEqual(view["task"].reply, item!.reply);
    const me = (await call("task/me")).result as { balance: { totalMsat: number; heldMsat: number } };
    assert.deepEqual([me.balance.totalMsat, me.balance.heldMsat], [21_000, 21_000]);
  });

  it("when the model refuses, the run still replies — a plain line and their photo — so the worker's page is not left waiting", async () => {
    openai.mode = "refuse";
    const seen = await strut.store.listRuns("photo-remix");
    const photo = jpeg(1500);
    const task = await snap(photo);
    const done = await launched(seen);
    assert.equal(done.status, "success", JSON.stringify(done.error));
    assert.equal(openai.edits.length, 2, "one call, never retried");
    const out = done.output as Record<string, any>;
    assert.match(out["error"], /rejected as a result of our safety system/);
    assert.equal(out["image"], undefined);
    const [answered] = await strut.tasks.capability.list({ runId: done.runId });
    const saved = { name: "photo.jpg", mediaType: "image/jpeg", size: photo.length, path: `tasks/${answered!.id}/photo.jpg` };
    const item = await replyOf(task.lease);
    assert.deepEqual(item?.reply && { show: item.reply.show, files: item.reply.files }, { show: { title: "This one could not be transformed. Try another picture.", failed: true }, files: [saved] });
    assert.deepEqual((await staff("GET", `/tasks/${answered!.id}`))["task"].reply, item!.reply);
    const me = (await call("task/me")).result as { balance: { heldMsat: number } };
    assert.equal(me.balance.heldMsat, 42_000, "the answer earns: the worker did their part");
  });
});
