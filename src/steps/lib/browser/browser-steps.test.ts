/**
 * Every browser/* step over a FAKE BrowserService (offline). A step is a thin
 * wrapper: validate its input (as the runner does), forward to one verb with
 * the run id, return the verb's output. So the tests check that mapping, the
 * one-of refinements, the two steps that touch secrets/artifacts, and that
 * the lib files load through strut's registry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaOf, type AnyStepDef } from "../../../core.js";
import { deleteJob, jobRoot, jobsCapability, readJobRecord, releaseWith } from "../../../jobs.js";
import { captchaManifest, writeCaptcha } from "../../../browser/captcha.js";
import { mapCheckResult } from "../../../verify.js";
import { buildRegistry } from "../../registry.js";
import { CAPTURE_VERBS as SERVICE_VERBS } from "../../../browser/service.js";
import { CAPTURE_VERBS, type Ctx } from "./_shared.js";

const STEPS_DIR = dirname(fileURLToPath(import.meta.url));

import open from "./open.js";
import goto from "./goto.js";
import snapshot from "./snapshot.js";
import click from "./click.js";
import fill from "./fill.js";
import type_ from "./type.js";
import press from "./press.js";
import select from "./select.js";
import hover from "./hover.js";
import scroll from "./scroll.js";
import wait from "./wait.js";
import text from "./text.js";
import screenshot from "./screenshot.js";
import evaluate from "./evaluate.js";
import observe from "./observe.js";
import back from "./back.js";
import state from "./state.js";
import close from "./close.js";
import capture from "./capture.js";
import verify from "./verify.js";
import walkthrough from "./walkthrough.js";
import keep from "./keep.js";
import tap from "./tap.js";
import captchaAsk from "./captcha-ask.js";
import captchaState from "./captcha-state.js";

const STEPS = { open, goto, snapshot, click, fill, type: type_, press, select, hover, scroll, wait, text, screenshot, evaluate, observe, back, state, close, capture, verify, walkthrough, keep, tap, "captcha-ask": captchaAsk, "captcha-state": captchaState };

const NAV = { url: "https://example.com/", title: "Example Domain", status: 200 };
const SHOT = { path: "shots/001.png", dir: "/art/r1", url: "/artifacts/r1/shots/001.png", width: 1280, height: 800, bytes: 4321, small: Buffer.from("png") };
const OBS = { console: ["boom"], pageErrors: [], failedRequests: [], httpErrors: ["500 GET /api"] };
/** A refuting verify: the page opened, one expectation failed (verdict.ts's wording). */
const VERDICT = {
  supports: false,
  content: "/settings reached; 1 of 2 expectations failed: text \"Notification preferences\" not visible",
  failed: ['text "Notification preferences": not visible'],
  errors: [],
  pageUrl: "https://pod.example/settings",
  title: "Settings",
};

/** A refuting walkthrough: two frames, the manifest as the locator. */
const WALKED = {
  ...VERDICT,
  path: "walkthroughs/001/walkthrough.json",
  url: "/artifacts/r1/walkthroughs/001/walkthrough.json",
  frames: [
    { file: "01.png", caption: "Open settings", url: "/artifacts/r1/walkthroughs/001/01.png" },
    { file: "02.png", caption: "Stopped at step 1", url: "/artifacts/r1/walkthroughs/001/02.png" },
  ],
  small: Buffer.from("png"),
};

/** Records every verb call; each verb returns a canned output. */
class FakeBrowser {
  calls: Array<{ verb: string; runId: string; args: unknown[] }> = [];
  fail?: string;
  /** What `open` answers for `resumed`. */
  resumed = false;
  private rec<T>(verb: string, runId: string, args: unknown[], out: T): T {
    this.calls.push({ verb, runId, args });
    if (this.fail === verb) throw new Error(`browser/${verb}: nope`);
    return out;
  }
  async open(runId: string, input: unknown) { return this.rec("open", runId, [input], { ...NAV, resumed: this.resumed }); }
  async keep(runId: string, session: unknown) { return this.rec("keep", runId, [session], { url: NAV.url, title: NAV.title }); }
  async closeKept(job: string, name: string) { return this.rec("closeKept", "", [job, name], { ok: true as const }); }
  async tap(runId: string, input: unknown) { return this.rec("tap", runId, [input], { url: NAV.url, taps: 2 }); }
  async captcha(runId: string, input: unknown, sink: unknown) {
    const manifest = captchaManifest({ round: 1, mode: "tap", site: "www.google.com", grid: { rows: 3, cols: 3 }, maxRounds: 5, expiresInMs: 600_000, now: 0 });
    return this.rec("captcha", runId, [input, sink], { manifest, path: "shots/captcha-1.json", url: "/jobs/job-1/files/shots/captcha-1.json", image: { ...SHOT, path: "shots/captcha-1.png", url: "/jobs/job-1/files/shots/captcha-1.png" }, small: Buffer.from("png") });
  }
  async goto(runId: string, input: unknown) { return this.rec("goto", runId, [input], NAV); }
  async snapshot(runId: string) { return this.rec("snapshot", runId, [], { ...NAV, tree: '- link "x" [ref=e1]' }); }
  async click(runId: string, input: unknown) { return this.rec("click", runId, [input], { url: NAV.url }); }
  async fill(runId: string, input: unknown) { return this.rec("fill", runId, [input], { ok: true as const }); }
  async type(runId: string, input: unknown) { return this.rec("type", runId, [input], { ok: true as const }); }
  async press(runId: string, input: unknown) { return this.rec("press", runId, [input], { url: NAV.url }); }
  async select(runId: string, input: unknown) { return this.rec("select", runId, [input], { ok: true as const }); }
  async hover(runId: string, input: unknown) { return this.rec("hover", runId, [input], { ok: true as const }); }
  async scroll(runId: string, input: unknown) { return this.rec("scroll", runId, [input], { ok: true as const }); }
  async wait(runId: string, input: unknown) { return this.rec("wait", runId, [input], { ok: true as const, waitedMs: 12 }); }
  async text(runId: string, input: unknown) { return this.rec("text", runId, [input], { text: "hello" }); }
  async screenshot(runId: string, input: unknown, artifacts: unknown) { return this.rec("screenshot", runId, [input, artifacts], SHOT); }
  async evaluate(runId: string, input: unknown) { return this.rec("evaluate", runId, [input], { result: 3 }); }
  observe(runId: string) { return this.rec("observe", runId, [], OBS); }
  async back(runId: string, input: unknown) { return this.rec("back", runId, [input], { url: NAV.url, title: NAV.title }); }
  async state(runId: string, artifacts: unknown) { return this.rec("state", runId, [artifacts], { path: "state.json", url: "/artifacts/r1/state.json" }); }
  async closeRun(runId: string) { return this.rec("close", runId, [], { ok: true as const }); }
  async capture(runId: string, input: unknown, artifacts: unknown) { return this.rec("capture", runId, [input, artifacts], { ...SHOT, errors: ["http: 500 GET /api"], pageUrl: "https://example.com/after", title: "After" }); }
  async verify(runId: string, input: unknown, sink: unknown) { return this.rec("verify", runId, [input, sink], { ...SHOT, ...VERDICT }); }
  async walkthrough(runId: string, input: unknown, sink: unknown) { return this.rec("walkthrough", runId, [input, sink], WALKED); }
}

const artifacts = { tag: "artifacts" };
/** What screenshot and capture hand the service on a plain run: the artifacts and the run id. */
const sink = { artifacts, runId: "r1" };

function ctxFor(browser: FakeBrowser, secrets: Record<string, string> = {}): Ctx {
  return {
    runId: "r1",
    path: "wf/step",
    scope: {},
    input: {},
    emit: async () => {},
    services: {
      browser: browser as never,
      artifacts: artifacts as never,
      http: {} as never,
      secrets: { get: async (name: string) => secrets[name] },
    },
  };
}

/** Run a step the way the runner does: validate, run, validate the output. */
async function run(def: AnyStepDef, input: unknown, browser = new FakeBrowser(), secrets?: Record<string, string>) {
  const cfg = def.input.parse(input);
  const out = await def.run(cfg, ctxFor(browser, secrets));
  return def.output.parse(out);
}

test("every step is browser/<file> and has a description written for a model", async () => {
  const files = (await readdir(STEPS_DIR)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(files.filter((f) => !f.startsWith("_")), Object.keys(STEPS).sort());
  for (const [name, def] of Object.entries(STEPS)) {
    assert.equal(def.type, `browser/${name}`);
    assert.ok((def.description ?? "").length > 40, `${def.type} needs a real description`);
  }
  assert.deepEqual([...CAPTURE_VERBS], [...SERVICE_VERBS], "the step's verb list must match the service's");
});

test("each verb step forwards its validated input to the service under the run id", async () => {
  const cases: Array<[AnyStepDef, unknown, string, unknown]> = [
    [goto, { url: "https://example.com", wait: 100 }, "goto", { url: "https://example.com", wait: 100 }],
    [click, { ref: "e3", double: true }, "click", { ref: "e3", double: true }],
    [click, { selector: "text=Go", button: "right" }, "click", { selector: "text=Go", button: "right" }],
    [fill, { ref: "e1", value: "hi" }, "fill", { ref: "e1", value: "hi" }],
    [type_, { text: "abc", delay: 5 }, "type", { text: "abc", delay: 5 }],
    [press, { key: "Enter" }, "press", { key: "Enter" }],
    [select, { selector: "#s", value: "blue" }, "select", { selector: "#s", value: "blue" }],
    [hover, { ref: "e9" }, "hover", { ref: "e9" }],
    [scroll, { y: -300 }, "scroll", { y: -300 }],
    [scroll, { selector: "footer" }, "scroll", { selector: "footer" }],
    [wait, { text: "Total" }, "wait", { text: "Total" }],
    [wait, { ms: 250 }, "wait", { ms: 250 }],
    [wait, { url: "**/done" }, "wait", { url: "**/done" }],
    [text, {}, "text", {}],
    [text, { ref: "e2" }, "text", { ref: "e2" }],
    [evaluate, { expression: "1+2" }, "evaluate", { expression: "1+2" }],
    [back, { timeoutMs: 500 }, "back", { timeoutMs: 500 }],
  ];
  for (const [def, input, verb, args] of cases) {
    const browser = new FakeBrowser();
    await run(def, input, browser);
    assert.equal(browser.calls.length, 1, `${def.type}: one verb call`);
    assert.equal(browser.calls[0]!.verb, verb, def.type);
    assert.equal(browser.calls[0]!.runId, "r1");
    assert.deepEqual(browser.calls[0]!.args[0], args, def.type);
  }
});

test("snapshot, observe and close take no input and return the verb's result", async () => {
  const browser = new FakeBrowser();
  const snap = await run(snapshot, {}, browser);
  assert.match(snap.tree, /\[ref=e1\]/);
  assert.deepEqual(await run(observe, {}, browser), OBS);
  assert.deepEqual(await run(close, {}, browser), { ok: true });
  assert.deepEqual(browser.calls.map((c) => c.verb), ["snapshot", "observe", "close"]);
});

test("element steps take exactly one of ref / selector", () => {
  for (const def of [click, fill, select, hover]) {
    const extra = def === fill || def === select ? { value: "v" } : {};
    assert.equal(def.input.safeParse({ ...extra }).success, false, `${def.type}: neither`);
    assert.equal(def.input.safeParse({ ref: "e1", selector: "a", ...extra }).success, false, `${def.type}: both`);
    assert.equal(def.input.safeParse({ ref: "e1", ...extra }).success, true, `${def.type}: ref`);
    assert.equal(def.input.safeParse({ selector: "a", ...extra }).success, true, `${def.type}: selector`);
  }
  assert.equal(scroll.input.safeParse({}).success, false);
  assert.equal(scroll.input.safeParse({ ref: "e1", y: 10 }).success, false);
  assert.equal(wait.input.safeParse({}).success, false);
  assert.equal(wait.input.safeParse({ text: "a", ms: 1 }).success, false);
  assert.equal(text.input.safeParse({ ref: "e1", selector: "a" }).success, false);
  assert.equal(screenshot.input.safeParse({ ref: "e1", selector: "a" }).success, false);
  assert.equal(screenshot.input.safeParse({}).success, true);
});

test("open passes the viewport through and loads a storage state from the named secret, never the value into the output", async () => {
  const plain = new FakeBrowser();
  await run(open, { url: "https://example.com", viewport: { width: 800, height: 600 } }, plain);
  assert.deepEqual(plain.calls[0]!.args[0], { url: "https://example.com", viewport: { width: 800, height: 600 }, storageState: undefined, timeoutMs: undefined });
  assert.deepEqual(await run(open, {}, plain), { ...NAV, resumed: false });

  const withState = new FakeBrowser();
  const stateJson = JSON.stringify({ cookies: [{ name: "sid", value: "s3cret" }], origins: [] });
  const out = await run(open, { storageStateSecret: "GITHUB_SESSION" }, withState, { GITHUB_SESSION: stateJson });
  assert.deepEqual((withState.calls[0]!.args[0] as { storageState: unknown }).storageState, JSON.parse(stateJson));
  assert.ok(!JSON.stringify(out).includes("s3cret"));

  await assert.rejects(run(open, { storageStateSecret: "MISSING" }), /secret MISSING is not set/);
  await assert.rejects(run(open, { storageStateSecret: "BAD" }, new FakeBrowser(), { BAD: "not json" }), /not JSON/);
});

test("screenshot hands the service a sink for the run's artifacts, state the capability; the model's copy stays out of the output", async () => {
  const browser = new FakeBrowser();
  const shot = await run(screenshot, { fullPage: true, name: "hero" }, browser);
  assert.deepEqual(browser.calls[0]!.args, [{ fullPage: true, name: "hero" }, sink]);
  assert.deepEqual(shot, { path: "shots/001.png", dir: "/art/r1", url: "/artifacts/r1/shots/001.png", width: 1280, height: 800, bytes: 4321 });
  assert.ok(!("small" in shot));

  const st = await run(state, {}, browser);
  assert.deepEqual(browser.calls[1]!.args, [artifacts]);
  assert.deepEqual(st, { path: "state.json", url: "/artifacts/r1/state.json" });
});

test("under a job, screenshot and capture sink to the job's directory — the one job/dir hands out — so the shot is a job file its host can read", async () => {
  const browser = new FakeBrowser();
  const base = ctxFor(browser);
  const underJob = (dataDir?: string): Ctx => ({ ...base, job: "job-1", services: { ...base.services, ...(dataDir ? { dataDir } : {}) } });
  await screenshot.run(screenshot.input.parse({}), underJob("/data"));
  assert.deepEqual(browser.calls[0]!.args[1], { artifacts, runId: "r1", job: { name: "job-1", root: jobRoot("/data", "job-1") } });
  // No dataDir on the bag: the same fallback job/dir takes, so the two agree on the directory.
  await capture.run(capture.input.parse({ url: "https://example.com" }), underJob());
  assert.deepEqual(browser.calls[1]!.args[1], { artifacts, runId: "r1", job: { name: "job-1", root: jobRoot(join(tmpdir(), "strut"), "job-1") } });
  // A job's check run carries the job (strut RunStepOptions.job): its shot is a job file too.
  await verify.run(verify.input.parse({ url: "https://pod.example/settings" }), underJob("/data"));
  assert.deepEqual(browser.calls[2]!.args[1], { artifacts, runId: "r1", job: { name: "job-1", root: jobRoot("/data", "job-1") } });
});

test("screenshot and capture mark their output with the model's copy (withMedia): one image/png file part, no bytes in the JSON", async () => {
  const cases: Array<[AnyStepDef, unknown, string[]]> = [
    [screenshot, {}, ["bytes", "dir", "height", "path", "url", "width"]],
    [capture, { url: "https://example.com" }, ["bytes", "dir", "errors", "height", "pageUrl", "path", "title", "url", "width"]],
    [verify, { url: "https://example.com" }, ["content", "errors", "failed", "locator", "pageUrl", "supports", "title"]],
  ];
  for (const [def, input, keys] of cases) {
    // The raw run() result, as the agent's tool executor gets it (the runner
    // does not re-parse outputs; zod's parse would drop the marker).
    const out = await def.run(def.input.parse(input), ctxFor(new FakeBrowser()));
    const media = mediaOf(out);
    assert.equal(media?.length, 1, `${def.type}: one media part`);
    assert.deepEqual({ ...media![0], data: undefined }, { mediaType: "image/png", filename: "shots/001.png", data: undefined });
    assert.ok(media![0]!.data instanceof Uint8Array && media![0]!.data.length > 0, `${def.type}: raw bytes, not base64`);
    const json = JSON.stringify(out);
    assert.ok(!json.includes("_media") && !json.includes("cG5n") && !json.includes("small"), `${def.type}: nothing of the image in the JSON: ${json}`); // cG5n = base64("png")
    assert.deepEqual(Object.keys(out).sort(), keys, `${def.type}: the plain output shape`);
    assert.doesNotThrow(() => def.output.parse(out));
  }
});

test("capture validates the declared steps and returns the shot with the page's errors", async () => {
  const browser = new FakeBrowser();
  const steps = [
    { do: "wait", text: "Learn more" },
    { do: "click", selector: "text=Learn more" },
  ];
  const out = await run(capture, { url: "https://example.com", steps, fullPage: false, wait: 50 }, browser);
  assert.equal(browser.calls[0]!.verb, "capture");
  assert.deepEqual(browser.calls[0]!.args, [{ url: "https://example.com", steps, fullPage: false, wait: 50 }, sink]);
  assert.deepEqual(out.errors, ["http: 500 GET /api"]);
  assert.equal(out.pageUrl, "https://example.com/after");
  assert.ok(!("small" in out));
  assert.equal(capture.input.safeParse({ url: "https://x", steps: [{ do: "close" }] }).success, false, "not a capture verb");
  assert.equal(capture.input.safeParse({ url: "https://x", steps: [{ do: "screenshot" }] }).success, false, "the compound shoots itself");
});

test("verify forwards its list and expectations, and answers in the check contract strut's verify pass reads", async () => {
  const browser = new FakeBrowser();
  const input = {
    url: "https://pod.example/settings",
    steps: [{ do: "click", selector: "text=Sign in" }, { do: "wait", url: "**/settings" }],
    wait: 100,
    expect: { text: ["Notification preferences"], url: "**/settings", selector: ["form"], noErrors: true, evaluate: "document.title" },
  };
  const out = await run(verify, input, browser);
  assert.equal(browser.calls[0]!.verb, "verify");
  assert.deepEqual(browser.calls[0]!.args, [input, sink]);
  assert.deepEqual(out, { ...VERDICT, locator: { path: "shots/001.png", url: "/artifacts/r1/shots/001.png" } });
  // What the pass makes of it: evidence (not cannot-run), the shot as the locator.
  assert.deepEqual(mapCheckResult("browser/verify", { status: "success", output: out }), {
    kind: "evidence",
    supports: false,
    content: VERDICT.content,
    locator: { path: "shots/001.png", url: "/artifacts/r1/shots/001.png" },
  });
  assert.equal(verify.input.safeParse({ url: "https://x", steps: [{ do: "screenshot" }] }).success, false, "capture's verbs only");
  assert.equal(verify.input.safeParse({ url: "https://x", expect: { text: "one" } }).success, false, "text is a list");
});

test("walkthrough forwards its list with captions, answers in the check contract with the manifest as the locator, and shows the model the last frame", async () => {
  const browser = new FakeBrowser();
  const input = {
    url: "https://pod.example/settings",
    title: "Switch billing to annual",
    caption: "Open settings",
    steps: [{ do: "click", selector: "text=Billing", caption: "Billing" }, { do: "wait", text: "Plan" }],
    wait: 100,
    expect: { text: ["Billed yearly"] },
  };
  const raw = await walkthrough.run(walkthrough.input.parse(input), ctxFor(browser));
  assert.equal(browser.calls[0]!.verb, "walkthrough");
  assert.deepEqual(browser.calls[0]!.args, [input, sink]);
  const media = mediaOf(raw);
  assert.deepEqual(media?.map((m) => [m.mediaType, m.filename]), [["image/png", "02.png"]], "one frame, the last");
  assert.ok(!JSON.stringify(raw).includes("small"));
  const out = walkthrough.output.parse(raw);
  assert.deepEqual(out, {
    ...VERDICT,
    locator: { path: WALKED.path, url: WALKED.url },
    kind: "walkthrough",
    frames: WALKED.frames,
  });
  assert.deepEqual(mapCheckResult("browser/walkthrough", { status: "success", output: out }), {
    kind: "evidence",
    supports: false,
    content: VERDICT.content,
    locator: { path: WALKED.path, url: WALKED.url },
  });
  assert.equal(walkthrough.input.safeParse({ url: "https://x", steps: [{ do: "screenshot" }] }).success, false, "capture's verbs only");
  assert.equal(walkthrough.input.safeParse({ url: "https://x", steps: [{ do: "click", selector: "a", caption: 3 }] }).success, false, "a caption is text");
});

test("on a job whose host listens, the sink carries notify — bound to the job and the run — so each shot reaches the host as it lands", async () => {
  const browser = new FakeBrowser();
  const base = ctxFor(browser);
  const told: Array<{ job: string; update: Record<string, unknown> }> = [];
  const ctx: Ctx = { ...base, job: "job-1", services: { ...base.services, dataDir: "/data", jobs: { notify: (job: string, update: Record<string, unknown>) => void told.push({ job, update }) } as never } };
  await screenshot.run(screenshot.input.parse({}), ctx);
  const s = browser.calls[0]!.args[1] as { notify?: (u: Record<string, unknown>) => void; job?: unknown };
  assert.deepEqual(s.job, { name: "job-1", root: jobRoot("/data", "job-1") });
  assert.equal(typeof s.notify, "function");
  s.notify!({ kind: "image", url: "/jobs/job-1/files/shots/001.png", state: "done" });
  assert.deepEqual(told, [{ job: "job-1", update: { runId: "r1", kind: "image", url: "/jobs/job-1/files/shots/001.png", state: "done" } }]);
});

test("a failing verb throws through the step (a declared workflow must fail loudly)", async () => {
  const browser = new FakeBrowser();
  browser.fail = "click";
  await assert.rejects(run(click, { ref: "e1" }, browser), /browser\/click: nope/);
});

test("a step on a host with no browser service throws a clear error", async () => {
  const ctx = ctxFor(new FakeBrowser());
  delete (ctx.services as { browser?: unknown }).browser;
  await assert.rejects(snapshot.run({}, ctx), /no `browser` service/);
});

test("the lib files load through strut's registry: every step, as lib; the helper is skipped", async () => {
  const { registry, sources } = await buildRegistry();
  for (const name of Object.keys(STEPS)) {
    const type = `browser/${name}`;
    assert.ok(registry[type], `${type} loaded`);
    assert.equal(sources[type], "lib");
  }
  assert.ok(!registry["browser/_shared"]);
});

// ── A page the JOB keeps: open { session }, keep, close { session } ─────────

/** A ctx under a job whose `jobs` capability is a real one over `dataDir`. */
function jobCtx(browser: FakeBrowser, dataDir: string): Ctx {
  const base = ctxFor(browser);
  return { ...base, job: "job-1", services: { ...base.services, dataDir, jobs: jobsCapability(dataDir) } };
}

async function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "strut-browser-steps-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("`session` with no job is refused before the browser is touched; a bad name is refused by the schema", async () => {
  const browser = new FakeBrowser();
  const ctx = ctxFor(browser);
  await assert.rejects(open.run(open.input.parse({ session: "captcha" }), ctx), /`session` keeps the page for the JOB, and this run has no job/);
  await assert.rejects(keep.run(keep.input.parse({ session: "captcha" }), ctx), /this run has no job/);
  await assert.rejects(close.run(close.input.parse({ session: "captcha" }), ctx), /this run has no job/);
  assert.deepEqual(browser.calls, []);
  assert.equal(keep.input.safeParse({ session: "a/b" }).success, false);
  assert.equal(keep.input.safeParse({}).success, false);
});

test("open { session } keeps the page for the job and takes the job's hold on a new page — url opened only then; a resumed page is left where it is", async () => {
  await withDataDir(async (dir) => {
    const browser = new FakeBrowser();
    const ctx = jobCtx(browser, dir);
    const out = await open.run(open.input.parse({ session: "captcha", url: "https://example.com" }), ctx);
    assert.deepEqual(out, { ...NAV, resumed: false });
    assert.deepEqual(browser.calls.map((c) => c.verb), ["open", "goto"]);
    const session = (browser.calls[0]!.args[0] as { session: { job: string; name: string; onEnd: unknown } }).session;
    assert.deepEqual({ job: session.job, name: session.name }, { job: "job-1", name: "captcha" });
    assert.equal(typeof session.onEnd, "function");
    const hold = (await readJobRecord(jobRoot(dir, "job-1")))?.holds?.[0];
    assert.deepEqual({ ...hold, since: undefined }, { id: "browser:captcha", kind: "browser", release: { type: "browser/close", input: { session: "captcha" } }, since: undefined });

    // The page ending on its own (idle, a timeout) lets the hold go.
    (session.onEnd as () => void)();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await readJobRecord(jobRoot(dir, "job-1")))?.holds, undefined);

    browser.calls = [];
    browser.resumed = true;
    assert.deepEqual(await open.run(open.input.parse({ session: "captcha", url: "https://example.com" }), ctx), { ...NAV, resumed: true });
    assert.deepEqual(browser.calls.map((c) => c.verb), ["open"], "resumed: no navigation");
    assert.equal((await readJobRecord(jobRoot(dir, "job-1")))?.holds, undefined, "and no hold taken again");
  });
});

test("keep takes the hold; close { session } is its release step — deleting the job closes the page and lets the hold go", async () => {
  await withDataDir(async (dir) => {
    const browser = new FakeBrowser();
    const ctx = jobCtx(browser, dir);
    const kept = await keep.run(keep.input.parse({ session: "captcha" }), ctx);
    assert.deepEqual(kept, { session: "captcha", url: NAV.url, title: NAV.title });
    assert.equal(browser.calls.at(-1)!.verb, "keep");
    const root = jobRoot(dir, "job-1");
    assert.equal((await readJobRecord(root))?.holds?.[0]?.id, "browser:captcha");

    // What strut runs on DELETE /jobs/:id (and the idle sweep): the hold's
    // release step, outside any run — runId "jobs", the job set.
    browser.calls = [];
    const services = jobCtx(browser, dir).services;
    const { released } = await deleteJob({} as never, root, "job-1", releaseWith({ "browser/close": close } as never, services));
    assert.deepEqual(released, ["browser:captcha"]);
    assert.deepEqual(browser.calls, [{ verb: "closeKept", runId: "", args: ["job-1", "captcha"] }]);
    assert.equal(await readJobRecord(root), null, "the job is gone");
  });
});

test("close { session } with no browser left (a restart, a host without one) still lets the hold go", async () => {
  await withDataDir(async (dir) => {
    const ctx = jobCtx(new FakeBrowser(), dir);
    await keep.run(keep.input.parse({ session: "captcha" }), ctx);
    delete (ctx.services as { browser?: unknown }).browser;
    assert.deepEqual(await close.run(close.input.parse({ session: "captcha" }), ctx), { ok: true });
    assert.equal((await readJobRecord(jobRoot(dir, "job-1")))?.holds, undefined);
  });
});

test("tap forwards the points to the service; one of ref / selector, fractions within 0–1", async () => {
  const browser = new FakeBrowser();
  const input = { ref: "f5e12", points: [{ nx: 0.5, ny: 0.5 }, { nx: 0.17, ny: 0.83 }] };
  assert.deepEqual(await run(tap, input, browser), { url: NAV.url, taps: 2 });
  assert.deepEqual(browser.calls[0], { verb: "tap", runId: "r1", args: [input] });
  assert.equal(tap.input.safeParse({ points: [{ nx: 0.5, ny: 0.5 }] }).success, false, "no target");
  assert.equal(tap.input.safeParse({ ref: "e1", points: [] }).success, false, "no points");
  assert.equal(tap.input.safeParse({ ref: "e1", points: [{ nx: 1.2, ny: 0 }] }).success, false, "out of the box");
});

test("captcha-ask hands the service the job's sink, answers with the artifact to list, and shows the model the crop", async () => {
  const browser = new FakeBrowser();
  const base = ctxFor(browser);
  const ctx: Ctx = { ...base, job: "job-1", services: { ...base.services, dataDir: "/data" } };
  const input = { ref: "f5e12", round: 1, mode: "tap", grid: { rows: 3, cols: 3 }, instruction: "Select all images with a bus" };
  const raw = await captchaAsk.run(captchaAsk.input.parse(input), ctx);
  assert.deepEqual(browser.calls[0]!.args, [{ ...input, maxRounds: 5, expiresInMs: 600_000 }, { artifacts, runId: "r1", job: { name: "job-1", root: jobRoot("/data", "job-1") } }]);
  assert.deepEqual(mediaOf(raw)?.map((m) => [m.mediaType, m.filename]), [["image/png", "shots/captcha-1.png"]]);
  assert.deepEqual(captchaAsk.output.parse(raw), {
    artifact: { id: "captcha", kind: "captcha", title: "Captcha on www.google.com", path: "shots/captcha-1.json" },
    round: 1,
    site: "www.google.com",
    expiresAt: "1970-01-01T00:10:00.000Z",
    image: { path: "shots/captcha-1.png", url: "/jobs/job-1/files/shots/captcha-1.png" },
  });
  assert.ok(!JSON.stringify(raw).includes("small"));
  assert.equal(captchaAsk.input.safeParse({ ref: "e1", round: 1, mode: "audio" }).success, false, "tap, text or either");
  assert.equal(captchaAsk.input.safeParse({ ref: "e1", round: 1, mode: "tap", grid: { rows: 21, cols: 3 } }).success, false, "hive caps a grid at 20");
  assert.equal(captchaAsk.input.safeParse({ round: 1, mode: "tap" }).success, false, "the element to crop");
});

test("captcha-state sets a round's state on its manifest in the job's directory and returns its artifact; round 0 marks nothing", async () => {
  await withDataDir(async (dir) => {
    const browser = new FakeBrowser();
    const ctx = jobCtx(browser, dir);
    const root = jobRoot(dir, "job-1");
    await writeCaptcha({ artifacts: artifacts as never, runId: "r1", job: { name: "job-1", root } }, captchaManifest({ round: 2, mode: "tap", site: "a.example", maxRounds: 5, expiresInMs: 1, now: 0 }));
    assert.deepEqual(await captchaState.run(captchaState.input.parse({ round: 2, state: "solved" }), ctx), {
      marked: true,
      artifact: { id: "captcha", kind: "captcha", title: "Captcha on a.example", path: "shots/captcha-2.json" },
    });
    const { readFile } = await import("node:fs/promises");
    assert.equal(JSON.parse(await readFile(join(root, "shots", "captcha-2.json"), "utf-8")).state, "solved");
    assert.deepEqual(await captchaState.run(captchaState.input.parse({ round: 0, state: "failed" }), ctx), { marked: false });
    assert.deepEqual(await captchaState.run(captchaState.input.parse({ round: 3, state: "failed" }), ctx), { marked: false });
  });
});
