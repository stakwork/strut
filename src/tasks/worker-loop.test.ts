/**
 * The worker loop end to end (plans/human-steps.md §5, §5.6, §8): one test,
 * through the doors a deployment serves, of what a worker app is for.
 *
 * A person publishes the court-filing app and its workflow (`POST /apps`,
 * `POST /workflows`; __fixtures__/court-filing, the 2026-11-15 demo's) and
 * puts the app in the public view. An admin makes a paid task type that
 * takes a photo and grants it to a worker who signed in with their Sphinx
 * account. A run's `human` step posts a task; the worker's page takes it and
 * answers it with the photo on `POST /public/mcp`; the run wakes and its
 * agent (a stand-in model) gets the photo on its prompt. The earning is held,
 * then released (the task store's clock, `createStrut({ tasks: { now } })`).
 * An admin funds the wallet and turns payouts on, and the worker withdraws as
 * strut's account widget does: strut keysends through the stand-in Sphinx
 * daemon (scripts/fake-sphinx-daemon.ts) over HTTP — the real
 * `SphinxDaemonPayer`, wired from `LIGHTNING_*` as docs/running.md "Payments
 * locally" says — and the books agree with the wallet.
 *
 * Each door's edges are its own suite's: worker-door.test.ts (the worker's
 * calls, files, pay, take-back), payout-routes.test.ts (payouts' settings,
 * refusals and books), scripts/fake-sphinx-daemon.test.ts (the daemon).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import type { RunSummary } from "../core.js";
import type { EarningsView } from "../payments/earnings.js";
import { lspFeeFloorMsat } from "../payments/fee.js";
import { kitForTests } from "../test-util/app-kit.js";
import { jpeg, publicAppToken, setEnv, sphinxSignIn, stepCall } from "../test-util/public-door.js";
import { registerModelWrapper } from "../extensions.js";
import { mockModel } from "../privacy/testing/mock-model.js";
import { startFakeSphinxDaemon, type FakeSphinxDaemon } from "../../scripts/fake-sphinx-daemon.js";

const FIXTURE = new URL("./__fixtures__/court-filing/", import.meta.url).pathname;
const KEY = "worker-loop-key";
const admin = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const RECEIVE = "worker-loop-receive";
const PAY = "worker-loop-pay";
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the stand-in model reads off the photo, as the workflow's schema asks. */
const READING = {
  kind: "Judgment Debtor Summons",
  court: "County Court of Lancashire, holden at Preston",
  case: "No. 1234",
  plaintiff: "John Smith",
  defendant: "William Brown",
  appearance: "10 o'clock, 4 March 1890, at the Court House, Preston",
  amount: "£4. 13s. 10d.",
  summary: "A summons to court over a debt. Appear on 4 March 1890 or be committed.",
};
const reader = mockModel({ turns: [[{ type: "tool-call", toolCallId: "r1", toolName: "final_answer", input: JSON.stringify(READING) }]], provider: "openrouter", modelId: "acme/reader" });
registerModelWrapper((model, info) => (info.modelId === "acme/reader" ? (reader as never) : model));

describe("the worker loop end to end (plans/human-steps.md §5, §8)", () => {
  let root: string;
  let daemon: FakeSphinxDaemon;
  let restoreEnv: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  /** The task store's clock, ahead of the wall's by this much. */
  let ahead = 0;

  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://court.test${path}`, init);
  const staff = async (method: string, path: string, body?: unknown, status = 200) => {
    const res = await req(path, { method, headers: admin, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    assert.equal(res.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  /** The daemon's own reads, with the receive token. */
  const daemonBalance = async () => ((await (await fetch(`${daemon.url}/balance`, { headers: { authorization: `Bearer ${RECEIVE}` } })).json()) as { msat: number }).msat;
  const runWhen = async (runId: string, status: string) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const s: RunSummary | null = await strut.store.getRunSummary("court-paper", runId);
      if (s?.status === status) return s;
      if (Date.now() > deadline) throw new Error(`never ${status}: ${JSON.stringify(s?.status)} ${JSON.stringify(s?.error ?? "")}`);
      await sleep(10);
    }
  };

  before(async () => {
    // The wallet a deployment names at boot: an empty treasury whose invoices
    // settle only by hand, and its price of a bitcoin for the rate.
    daemon = await startFakeSphinxDaemon({ port: 0, token: RECEIVE, payToken: PAY, settleAfterMs: 0, startSats: 0, usdPerBtc: 100_000 });
    restoreEnv = setEnv({
      STRUT_API_KEY: KEY,
      LIGHTNING_DAEMON_URL: daemon.url,
      LIGHTNING_DAEMON_TOKEN: RECEIVE,
      LIGHTNING_DAEMON_PAY_TOKEN: PAY,
      LIGHTNING_NWC_URL: undefined,
      LIGHTNING_NWC_PAY_URL: undefined,
      STRUT_RATE_URL: `${daemon.url}/prices`,
      STRUT_PEER_KEY: undefined,
      // The stand-in model is reached through a provider that needs a key.
      OPENROUTER_API_KEY: "test",
    });
    root = await mkdtemp(join(tmpdir(), "strut-worker-loop-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      kit: await kitForTests(),
      scheduler: false, serveUi: false, autoResume: false, wakeDelayMs: 0,
      tasks: { now: () => Date.now() + ahead },
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await daemon?.close();
    restoreEnv?.();
    await rm(root, { recursive: true, force: true });
  });

  it("a worker app published, a paid photo task answered through the public page, the photo read, the pay held, released and withdrawn by keysend, the books balanced", async () => {
    // ── A person publishes the worker app and its workflow, and makes the app public.
    await staff("POST", "/workflows", { name: "court-paper", yaml: await readFile(join(FIXTURE, "court-paper.yaml"), "utf8") }, 201);
    const files: Record<string, string> = {};
    for (const f of ["app.yaml", "src/App.tsx", "src/styles.css"]) files[f] = await readFile(join(FIXTURE, "app", f), "utf8");
    const app = await staff("POST", "/apps", { name: "court-filing", files }, 201);
    assert.equal(app["live"], true, JSON.stringify(app));
    await staff("PUT", "/public-view", { apps: [{ name: "court-filing" }], visitors: { signIn: ["sphinx"] } });
    const page = await publicAppToken(req, "court-filing");
    /** The page's call on the visitor's door, as the worker. */
    const call = (token: string, type: string, config: Record<string, unknown> = {}) => stepCall(req, "/public/mcp", type, config, { authorization: `Bearer ${token}` }, page);

    // ── A worker signs in with their Sphinx account; an admin makes the paid type and grants it.
    const worker = await sphinxSignIn(req);
    assert.equal((await call(worker.token, "task/me")).result?.["status"], "new");
    const type = await staff("PUT", "/tasks/types/court-paper", {
      app: "court-filing",
      answer: { type: "object", properties: { note: { type: "string", maxLength: 200 } } },
      attachments: { max: 1, min: 1, types: ["image/*"] },
      paySats: 5_000,
      holdHours: 1,
      open: false,
    });
    assert.deepEqual([type["type"].paySats, type["type"].holdHours, type["type"].attachments], [5_000, 1, { max: 1, min: 1, types: ["image/*"] }]);
    await staff("PUT", `/tasks/workers/${encodeURIComponent(worker.actor)}/grants/court-paper`);

    // ── A run's human step posts the task (the stand-in model reads for it).
    const { runId } = (await staff("POST", "/workflows/court-paper/run", { input: {}, params: { model: "openrouter/acme/reader" } }, 202)) as { runId: string };
    await runWhen(runId, "waiting");

    // ── The worker's page takes it and answers with a photo.
    const next = await call(worker.token, "task/next", { wait: 1, type: "court-paper" });
    const task = next.result as { lease: string; payMsat: number; attachments: unknown; show: { ask: string } };
    assert.ok(task?.lease, next.error);
    assert.deepEqual([task.payMsat, task.attachments], [5_000_000, { max: 1, min: 1, types: ["image/*"] }]);
    assert.match(task.show.ask, /Photograph a court document/);
    const photo = jpeg(4096, 7);
    const sent = await call(worker.token, "task/submit", { lease: task.lease, answer: {}, attachments: [{ name: "summons.jpg", mediaType: "image/jpeg", data: photo.toString("base64") }] });
    assert.deepEqual(sent, { result: { ok: true } });

    // ── The run wakes; its agent gets the photo on its prompt and reads it.
    const done = await runWhen(runId, "success");
    const [taskId] = (await strut.tasks.capability.list({ runId })).map((t) => t.id);
    const saved = { name: "summons.jpg", mediaType: "image/jpeg", size: photo.length, path: `tasks/${taskId}/summons.jpg` };
    assert.deepEqual(done.output, { reading: READING, photo: [saved], by: worker.actor });
    const artifacts = (strut.services as { artifacts: { read(runId: string, path: string): Promise<Uint8Array> } }).artifacts;
    assert.deepEqual(Buffer.from(await artifacts.read(runId, saved.path)), photo, "in the run, byte for byte");
    const prompt = JSON.stringify(reader.prompts.at(-1)!.find((m: { role: string }) => m.role === "user"));
    assert.ok(prompt.includes(photo.toString("base64")), "the image itself is on the agent's prompt");
    assert.match(prompt, /\[attachment\] summons\.jpg \(image\/jpeg, 4 KB\)/);

    // ── The earning is held for the type's hour: nothing to withdraw yet.
    const held = (await call(worker.token, "task/me")).result as { balance: Record<string, number> };
    assert.deepEqual([held.balance["totalMsat"], held.balance["heldMsat"], held.balance["withdrawableMsat"]], [5_000_000, 5_000_000, 0]);

    // ── The hour passes on the task store's clock: it is released.
    ahead = HOUR + 60_000;
    const released = (await call(worker.token, "task/me")).result as { balance: Record<string, number>; payout: { on: boolean; why?: string } };
    assert.deepEqual(released.balance, { totalMsat: 5_000_000, heldMsat: 0, withdrawableMsat: 5_000_000 });
    assert.deepEqual([released.payout.on, released.payout.why], [false, "off"], "the session carries an address; payouts are not on yet");

    // ── An admin funds the treasury (an invoice into the wallet, paid) and turns payouts on.
    const deposit = await staff("POST", "/earnings/deposit", { sats: 20_000 });
    assert.equal(deposit["state"], "pending");
    assert.equal((await fetch(`${daemon.url}/settle/${deposit["paymentHash"]}`, { method: "POST" })).status, 200);
    assert.equal((await staff("POST", `/earnings/deposits/${deposit["paymentHash"]}/read`))["state"], "settled");
    const funded = await daemonBalance();
    assert.equal(funded, 20_000_000);
    await staff("PUT", "/tasks/payouts/settings", { on: true, minSats: 1_000, workerDaySats: 1_000_000, serverDaySats: 10_000_000 });

    // ── The worker withdraws as strut's account widget does: the most task/me offers.
    const open = (await call(worker.token, "task/me")).result as { payout: { on: boolean; maxMsat: number } };
    assert.equal(open.payout.on, true);
    const msat = open.payout.maxMsat;
    assert.ok(msat > 4_900_000 && msat < 5_000_000, `the most whose fee cap still fits: ${msat}`);
    const out = await call(worker.token, "task/withdraw", { msat });
    const paid = out.result as { state: string; key: string; msat: number; feeMsat: number; maxFeeMsat: number };
    assert.equal(paid?.state, "settled", JSON.stringify(out));
    const fee = lspFeeFloorMsat(msat);
    assert.deepEqual([paid.msat, paid.feeMsat], [msat, fee], "the LSP's fee, which the worker pays");
    assert.ok(fee <= paid.maxFeeMsat);

    // ── It went through the daemon, to the worker's own address: both balances moved by amount and fee.
    const keysend = (await (await fetch(`${daemon.url}/keysend/${paid.key}`, { headers: { authorization: `Bearer ${PAY}` } })).json()) as { state: string; fee_msat: number };
    assert.deepEqual([keysend.state, keysend.fee_msat], ["settled", fee]);
    assert.equal(await daemonBalance(), funded - msat - fee);
    const after = (await call(worker.token, "task/me")).result as { balance: Record<string, number>; payout: { out?: unknown } };
    assert.deepEqual(after.balance, { totalMsat: 5_000_000 - msat - fee, heldMsat: 0, withdrawableMsat: 5_000_000 - msat - fee });
    assert.equal(after.payout.out, undefined, "nothing on its way");
    const { payouts } = (await staff("GET", "/tasks/payouts")) as { payouts: Array<{ key: string; worker: string; address: string; state: string }> };
    assert.deepEqual(payouts.map((p) => [p.key, p.worker, p.address, p.state]), [[paid.key, worker.actor, worker.address, "paid"]]);

    // ── The books agree with the wallet.
    const books = (await staff("GET", "/earnings?wallet=1")) as unknown as EarningsView;
    assert.equal(books.wallet!.balance!.msat, funded - msat - fee);
    assert.equal(books.wallet!.differenceMsat, 0, JSON.stringify(books.wallet));
    assert.deepEqual([books.workers!.paidOut.count, books.workers!.paidOut.msat, books.workers!.paidOut.feeMsat], [1, msat, fee]);
    assert.equal(books.wallet!.owedToWorkersMsat, 5_000_000 - msat - fee);
    assert.equal(books.wallet!.coverMsat, funded - msat - fee - (5_000_000 - msat - fee));
    assert.deepEqual([books.deposited.count, books.deposited.msat], [1, 20_000_000]);
  });
});
