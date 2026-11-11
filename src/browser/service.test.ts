/**
 * The service's offline surface: what boot accepts, and the session
 * lifecycle over a FAKE Playwright (`launch()` overridden) — no browser is
 * touched. What a real server does with a page is service.live.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { BrowserService, checkLookSteps, checkSteps, debugReadOf, readDebugInPage, strictHint } from "./service.js";
import { sleep } from "./settle.js";

test("BROWSER_WS_URL and BROWSER_CDP_URL together are refused at boot; either alone is a backend", () => {
  assert.throws(() => BrowserService.fromEnv({ BROWSER_WS_URL: "ws://browser:3000", BROWSER_CDP_URL: "http://127.0.0.1:9222" }), /not both/);
  assert.equal(BrowserService.fromEnv({ BROWSER_WS_URL: "ws://browser:3000" }).cdp, false);
  assert.equal(BrowserService.fromEnv({ BROWSER_CDP_URL: "http://127.0.0.1:9222" }).cdp, true);
  assert.equal(BrowserService.fromEnv({}).cdp, false, "unset: a local launch");
  assert.throws(() => BrowserService.fromEnv({ BROWSER_VIEWPORT: "wide" }), /WIDTHxHEIGHT/);
});

test("a strict-mode violation keeps the matches, drops the call log and names the way out", () => {
  const pw = "locator.click: Error: strict mode violation: locator('text=algorithms') resolved to 2 elements:\n    1) <p>…</p>\n    2) <strong>algorithms</strong>\n\nCall log:\n  - waiting for locator('text=algorithms')\n";
  const m = strictHint(pw);
  assert.match(m, /resolved to 2 elements:\n    1\) <p>…<\/p>\n    2\) <strong>algorithms<\/strong>\n→ act by ref instead/);
  assert.doesNotMatch(m, /Call log/);
  assert.equal(strictHint("locator.click: Timeout 5000ms exceeded."), "locator.click: Timeout 5000ms exceeded.", "anything else is untouched");
});

// ── The session lifecycle over a fake Playwright ─────────────────────────────
// Every context the service makes is recorded, with whether it was closed:
// a context the service made and no longer tracks must be closed, or it
// would live in the browser container until the host restarts.

class FakePage {
  closed = false;
  /** Every click a locator on this page made: its selector and position. */
  clicks: Array<{ selector: string; position?: { x: number; y: number } }> = [];
  /** What a locator's boundingBox answers. */
  box = { x: 10, y: 20, width: 400, height: 300 };
  /** `evaluate` never answers: a page whose main thread is wedged. */
  hang = false;
  /** Every key the keyboard sent, in order: `down ArrowRight`, `up ArrowRight`. */
  keys: string[] = [];
  readonly keyboard = {
    down: async (key: string) => {
      if (key === "Nope") throw new Error(`keyboard.down: Unknown key: "${key}"`);
      this.keys.push(`down ${key}`);
    },
    up: async (key: string) => void this.keys.push(`up ${key}`),
  };
  isClosed() { return this.closed; }
  setDefaultTimeout() {}
  on() {}
  url() { return "about:blank"; }
  async title() { return ""; }
  async waitForLoadState() {}
  async evaluate() {
    if (this.hang) await new Promise(() => {});
    return null;
  }
  locator(selector: string) {
    return {
      boundingBox: async () => this.box,
      click: async (o: { position?: { x: number; y: number } } = {}) => void this.clicks.push({ selector, position: o.position }),
    };
  }
  async close() { this.closed = true; }
}

class FakeContext {
  closed = false;
  pages: FakePage[] = [];
  constructor(private readonly pw: FakePlaywright) {}
  async newPage() {
    if (this.pw.newPageFails) throw new Error("Target page, context or browser has been closed");
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }
  /** Like Playwright's: the context's pages go with it. */
  async close() {
    this.closed = true;
    for (const p of this.pages) p.closed = true;
  }
  browser() { return this.pw.browser; }
}

class FakePlaywright {
  contexts: FakeContext[] = [];
  /** `newContext` waits for this before it makes one. */
  gate: Promise<void> = Promise.resolve();
  newPageFails = false;
  readonly browser = {
    isConnected: () => true,
    on: () => {},
    contexts: () => [],
    close: async () => {},
    newContext: async () => {
      await this.gate;
      const c = new FakeContext(this);
      this.contexts.push(c);
      return c;
    },
  } as unknown as Browser;
}

class Service extends BrowserService {
  protected override settleSlackMs = 10;
  constructor(readonly pw: FakePlaywright, runBudgetMs?: number, opts: { sessionIdleMs?: number; sessionsMax?: number } = {}) {
    super({ wsUrl: "ws://fake:3000", ...(runBudgetMs ? { runBudgetMs } : {}), ...opts });
  }
  protected override async launch(): Promise<Browser> {
    return this.pw.browser;
  }
}

const open = (count: number) => (c: FakeContext) => Number(c.closed === false) === count;
const leaked = (pw: FakePlaywright) => pw.contexts.filter(open(1)).length;

test("two page() calls for one run in flight together share ONE context; dispose closes it", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  const [a, b] = await Promise.all([svc.page("r1"), svc.page("r1")]);
  assert.equal(a, b, "the second call joined the first open");
  assert.equal(pw.contexts.length, 1);
  assert.equal(await svc.page("r1"), a, "a later call returns the live page");
  assert.equal(pw.contexts.length, 1);
  await svc.dispose("r1");
  assert.equal(leaked(pw), 0);
  assert.equal(svc.remaining("r1"), svc.runBudgetMs, "the run is forgotten");
});

test("dispose() while the open is in flight: the open closes the context it made and fails", async () => {
  const pw = new FakePlaywright();
  let release!: () => void;
  pw.gate = new Promise<void>((r) => (release = r));
  const svc = new Service(pw);
  const opening = svc.page("r1");
  await sleep(5); // past connect(), parked in newContext
  await svc.dispose("r1");
  release();
  await assert.rejects(opening, /run ended while its page was opening/);
  assert.equal(pw.contexts.length, 1, "the context was made…");
  assert.equal(leaked(pw), 0, "…and closed by the open itself");
  // The run is gone, so the next call starts a fresh one.
  pw.gate = Promise.resolve();
  await svc.page("r1");
  assert.equal(pw.contexts.length, 2);
  await svc.dispose("r1");
  assert.equal(leaked(pw), 0);
});

test("the budget running out while the open is in flight closes the context too", async () => {
  const pw = new FakePlaywright();
  let release!: () => void;
  pw.gate = new Promise<void>((r) => (release = r));
  const svc = new Service(pw, 10);
  const opening = svc.page("r1");
  await sleep(30); // the budget timer fired with no session to close
  release();
  await assert.rejects(opening, /budget \(10 ms\) is spent/);
  assert.equal(leaked(pw), 0);
  await assert.rejects(svc.page("r1"), /is spent/, "the run stays spent until dispose");
  await svc.dispose("r1");
});

test("newPage() failing closes the context it would have lived in; the next call opens again", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  pw.newPageFails = true;
  await assert.rejects(svc.page("r1"), /has been closed/);
  assert.equal(pw.contexts.length, 1);
  assert.equal(leaked(pw), 0);
  pw.newPageFails = false;
  const p = await svc.page("r1");
  assert.equal(pw.contexts.length, 2, "the failed open did not pin the run");
  assert.equal(p.isClosed(), false);
  await svc.dispose("r1");
  assert.equal(leaked(pw), 0);
});

// ── A check's own session ────────────────────────────────────────────────────
// `verify` / `walkthrough` open a context of their own under the run; the
// fake page has no `goto`, so the open fails — which is exactly the path
// that must still close that context.

test("a check opens a context of its own and closes it, even when it fails; the run's session is untouched", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  const runPage = await svc.page("r1");
  const sink = {} as never;
  await assert.rejects(svc.verify("r1", { url: "https://pod.example/settings" }, sink), /browser\/goto/);
  await assert.rejects(svc.walkthrough("r1", { url: "https://pod.example/settings" }, sink), /browser\/goto/);
  assert.equal(pw.contexts.length, 3, "the run's context, then one per check");
  assert.deepEqual(pw.contexts.map((c) => c.closed), [false, true, true]);
  assert.equal(await svc.page("r1"), runPage, "the run's page is the one it had");
  await svc.dispose("r1");
  assert.equal(leaked(pw), 0);
});

test("dispose(runId) while a check is opening closes the check's context too", async () => {
  const pw = new FakePlaywright();
  let release!: () => void;
  pw.gate = new Promise<void>((r) => (release = r));
  const svc = new Service(pw);
  const checking = svc.verify("r1", { url: "https://pod.example/" }, {} as never);
  await sleep(5); // parked in newContext
  await svc.dispose("r1");
  release();
  await assert.rejects(checking, /run ended while its page was opening/);
  assert.equal(pw.contexts.length, 1);
  assert.equal(leaked(pw), 0);
});

test("a wrong list is refused before a context is made", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  await assert.rejects(svc.walkthrough("r1", { url: "https://pod.example/", steps: [{ do: "wait", timeoutMs: 1000 }] }, {} as never), /walkthrough: step 1 \(wait\)/);
  await assert.rejects(svc.verify("r1", { url: "https://pod.example/", steps: [{ do: "close" }] }, {} as never), /verify: step 1: unknown verb "close"/);
  assert.equal(pw.contexts.length, 0);
  await svc.dispose("r1");
});

test("checkSteps: each step is given what its verb needs, named by its place in the list", () => {
  checkSteps(
    [
      { do: "goto", url: "https://x" },
      { do: "fill", selector: "input[name=q]", value: "" },
      { do: "click", ref: "e3" },
      { do: "wait", ms: 500 },
      { do: "wait", text: "Saved", timeoutMs: 5000 },
      { do: "scroll", y: 400 },
      { do: "text" },
      { do: "evaluate", expression: "1" },
      { do: "back" },
    ],
    "verify",
  );
  // The run that found it (2026-10-15): a pause written as a cap.
  assert.throws(
    () => checkSteps([{ do: "click", selector: "text=dev-user" }, { do: "wait", caption: "User menu", timeoutMs: 1000 }], "walkthrough"),
    /^Error: walkthrough: step 2 \(wait\): give exactly one of ref, selector, text, url, or ms \(timeoutMs only caps a wait; a pause is \{ do: "wait", ms: 1000 \}\)$/,
  );
  assert.throws(() => checkSteps([{ do: "evaluate", script: "fetch('/x')" }], "walkthrough"), /step 1 \(evaluate\): needs `expression`/, "evaluate's input is `expression`");
  assert.throws(() => checkSteps([{ do: "click", ref: "e1", selector: "a" }], "capture"), /step 1 \(click\): give exactly one of ref or selector$/);
  assert.throws(() => checkSteps([{ do: "fill", selector: "input" }], "capture"), /step 1 \(fill\): needs `value`/);
  assert.throws(() => checkSteps([{ do: "text", ref: "e1", selector: "p" }], "capture"), /step 1 \(text\): give ref or selector, not both/);
  assert.throws(() => checkSteps([{ do: "goto", url: "https://x" }, { do: "explode" }], "capture"), /^Error: capture: step 2: unknown verb "explode" \(one of goto, /);
  checkSteps([{ do: "keydown", key: "ArrowRight" }, { do: "wait", ms: 500 }, { do: "keyup", key: "ArrowRight" }, { do: "keydown", key: "+" }], "capture");
  assert.throws(() => checkSteps([{ do: "keydown" }], "capture"), /step 1 \(keydown\): needs `key`/);
  assert.throws(() => checkSteps([{ do: "keyup", key: "Shift+ArrowRight" }], "verify"), /step 1 \(keyup\): one key a step — hold "Shift" with a keydown of its own/);
  assert.throws(() => checkSteps([{ do: "debug" }], "capture"), /step 1: unknown verb "debug"/, "debug is the look's own");
});

test("checkLookSteps: the look's verbs — keys held and let go, debug reads — each target a selector", () => {
  checkLookSteps([
    { do: "click", selector: "canvas" },
    { do: "debug" },
    { do: "keydown", key: "ArrowRight" },
    { do: "keydown", key: "Space" },
    { do: "wait", ms: 500 },
    { do: "keyup", key: "Space" },
    { do: "keyup", key: "ArrowRight" },
    { do: "press", key: "Escape" },
    { do: "debug" },
  ]);
  assert.throws(() => checkLookSteps([{ do: "debug" }, { do: "evaluate", expression: "1" }]), /^Error: app\/look: step 2: unknown verb "evaluate" \(one of click, .*keydown, keyup, .*debug\)$/);
  assert.throws(() => checkLookSteps([{ do: "debug" }, { do: "keydown" }]), /app\/look: step 2 \(keydown\): needs `key`/);
  assert.throws(() => checkLookSteps([{ do: "click", ref: "e3" }]), /give a selector/);
});

test("a declared list lets go of every key it left held — at its end, and when a step fails; a key held before it stays down", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  const page = (await svc.page("r1")) as unknown as FakePage;
  assert.deepEqual(await svc.keydown("r1", { key: "Shift" }), { ok: true, held: ["Shift"] }, "held by the step alone, before any list");

  const ran = await svc.drive("r1", [
    { do: "keydown", key: "ArrowRight" },
    { do: "keydown", key: "Space" },
    { do: "keyup", key: "Space" },
    { do: "keydown", key: "ArrowUp" },
  ]);
  assert.equal(ran.stopped, undefined);
  assert.deepEqual(page.keys, ["down Shift", "down ArrowRight", "down Space", "up Space", "down ArrowUp", "up ArrowUp", "up ArrowRight"], "last down, first up; Shift is not the list's");

  page.keys = [];
  const failed = await svc.drive("r1", [{ do: "keydown", key: "ArrowLeft" }, { do: "keydown", key: "Nope" }, { do: "keyup", key: "ArrowLeft" }]);
  assert.equal(failed.stopped?.step, 2);
  assert.equal(failed.stopped?.verb, "keydown");
  assert.match(failed.stopped?.message ?? "", /Unknown key: "Nope"/);
  assert.deepEqual(page.keys, ["down ArrowLeft", "up ArrowLeft"], "the step after the failure never ran; the key it would have let go of is let go of");

  assert.deepEqual(await svc.keyup("r1", { key: "Shift" }), { ok: true, held: [] });
  await svc.dispose("r1");
});

// ── window.__debug: what a page puts out for a look to read ──────────────────

/** A document root whose window holds `__debug` (or nothing, with NONE). */
const NONE = Symbol("none");
function rootWith(debug: unknown, cap = 100) {
  const w: Record<string, unknown> = {};
  if (debug !== NONE) w["__debug"] = debug;
  return [{ ownerDocument: { defaultView: w } }, cap] as const;
}

test("readDebugInPage: a value, or a function's, as JSON; nothing set is none", async () => {
  assert.deepEqual(await readDebugInPage(...rootWith(NONE)), { none: true });
  assert.deepEqual(await readDebugInPage({ ownerDocument: null }, 100), { none: true }, "no window");
  assert.deepEqual(await readDebugInPage(...rootWith({ x: 3, y: [1, 2] })), { json: '{"x":3,"y":[1,2]}' });
  assert.deepEqual(await readDebugInPage(...rootWith(null)), { json: "null" }, "null is a value");
  let x = 10;
  const live = rootWith(function (this: Record<string, unknown>) {
    return { x, self: this["__debug"] === live[0].ownerDocument.defaultView["__debug"] };
  });
  assert.deepEqual(await readDebugInPage(...live), { json: '{"x":10,"self":true}' }, "called on the window");
  x = 60;
  assert.deepEqual(await readDebugInPage(...live), { json: '{"x":60,"self":true}' }, "read anew each time: state in refs");
  assert.deepEqual(await readDebugInPage(...rootWith(async () => ({ ready: true }))), { json: '{"ready":true}' }, "a promise is awaited");
});

test("readDebugInPage: a function that throws, or a value that is not JSON, is an answer, never a throw", async () => {
  assert.deepEqual(
    await readDebugInPage(...rootWith(() => {
      throw new TypeError("player is undefined");
    })),
    { error: "window.__debug() threw TypeError: player is undefined" },
  );
  assert.deepEqual(await readDebugInPage(...rootWith(async () => Promise.reject(new Error("later")))), { error: "window.__debug() threw Error: later" });
  const getter = { ownerDocument: { defaultView: Object.defineProperty({}, "__debug", { get: () => { throw new Error("no"); } }) } };
  assert.deepEqual(await readDebugInPage(getter, 100), { error: "window.__debug threw Error: no" });
  assert.deepEqual(await readDebugInPage(...rootWith(() => undefined)), { error: "window.__debug() returned undefined, not a JSON value" });
  const loop: Record<string, unknown> = {};
  loop["self"] = loop;
  assert.match((await readDebugInPage(...rootWith(loop))).error as string, /^window\.__debug is not JSON: .*circular/i);
  assert.match((await readDebugInPage(...rootWith(() => ({ n: 1n })))).error as string, /^window\.__debug\(\) is not JSON: .*BigInt/);
  assert.deepEqual(await readDebugInPage(...rootWith(() => () => 1)), { error: "window.__debug() is a function, not a JSON value" });
});

test("a read is cut at the cap, and the look says so", async () => {
  const big = { cells: Array.from({ length: 50 }, (_, i) => i) };
  const whole = JSON.stringify(big);
  const answer = await readDebugInPage(...rootWith(big, 40));
  assert.deepEqual(answer, { json: whole.slice(0, 40), chars: whole.length });
  assert.deepEqual(debugReadOf(answer), { value: `${whole.slice(0, 40)}\n… (window.__debug's JSON cut at 40 of ${whole.length} chars)` });
  assert.deepEqual(debugReadOf({ json: '{"x":3}' }), { value: { x: 3 } }, "whole: the value itself");
  assert.deepEqual(debugReadOf({ error: "nope" }), { error: "nope" });
  assert.deepEqual(debugReadOf({ none: true }), { none: true });
});

// ── A page the JOB keeps ─────────────────────────────────────────────────────
// `job:<job>/<session>`: outlives the run that opened it, reached by every
// run attached to it, closed by its idle clock, a timeout, or closeKept.

/** onEnd calls, by session name — where the step lets the job's hold go. */
function ended() {
  const calls: string[] = [];
  return { calls, kept: (name: string, job = "job-1") => ({ job, name, onEnd: () => void calls.push(name) }) };
}

test("two runs share one kept page; the first run ending does not close it, closeKept does", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  const e = ended();
  const a = await svc.openKept("rA", e.kept("captcha"));
  assert.equal(a.resumed, false);
  const b = await svc.openKept("rB", e.kept("captcha"));
  assert.equal(b.resumed, true, "the second run resumes the job's page");
  assert.equal(b.page, a.page);
  assert.equal(pw.contexts.length, 1);
  assert.equal(await svc.page("rB"), a.page, "every verb the run calls reaches the kept page");

  await svc.dispose("rA");
  assert.equal(a.page.isClosed(), false, "run A ended; the job's page stays");
  assert.equal(await svc.page("rB"), a.page);
  await svc.dispose("rB");
  assert.equal(a.page.isClosed(), false);
  assert.deepEqual(svc.kept(), [{ job: "job-1", name: "captcha" }]);

  const c = await svc.openKept("rC", e.kept("captcha"));
  assert.equal(c.resumed, true, "a later run finds it where the last one left it");
  await svc.closeKept("job-1", "captcha");
  assert.equal(a.page.isClosed(), true);
  assert.equal(leaked(pw), 0);
  assert.deepEqual(svc.kept(), []);
  assert.deepEqual(e.calls, [], "an explicit close leaves the hold to its caller");
  // The run that was attached falls back to a page of its own.
  assert.notEqual(await svc.page("rC"), a.page);
  await svc.dispose("rC");
  assert.equal(leaked(pw), 0);
});

test("a kept page closes after its idle time and lets the job's hold go; a call in flight holds the clock", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw, undefined, { sessionIdleMs: 40 });
  const e = ended();
  const { page } = await svc.openKept("r1", e.kept("captcha"));
  await svc.dispose("r1");
  await sleep(20);
  await svc.openKept("r2", e.kept("captcha")); // a use starts the clock over
  await sleep(30);
  assert.equal(page.isClosed(), false, "used 30 ms ago, idle for 40");
  await sleep(40);
  assert.equal(page.isClosed(), true);
  assert.deepEqual(e.calls, ["captcha"], "the hold goes with it, once");
  assert.deepEqual(svc.kept(), []);
  assert.equal(leaked(pw), 0);
  await assert.rejects(svc.snapshot("r2"), /no page for this run/, "the run that was attached is told");
  await svc.dispose("r2");
});

test("at most sessionsMax kept pages: open and keep past it are refused; a run's own page is not counted", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw, undefined, { sessionsMax: 4 });
  const e = ended();
  for (const n of ["a", "b", "c", "d"]) await svc.openKept(`r-${n}`, e.kept(n));
  await assert.rejects(svc.openKept("r-e", e.kept("e")), /4 kept pages are open \(BROWSER_SESSIONS_MAX\)/);
  await svc.page("r-own");
  await assert.rejects(svc.keep("r-own", e.kept("e")), /4 kept pages are open/);
  assert.equal((await svc.openKept("r-again", e.kept("a"))).resumed, true, "an open one is still reachable");
  await svc.closeKept("job-1", "a");
  await svc.openKept("r-e", e.kept("e"));
  assert.equal(svc.kept().length, 4);
  await svc.close();
  assert.equal(leaked(pw), 0);
});

test("keep moves the run's page onto the job; the run ending leaves it open; a timeout closes it and lets the hold go", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  const e = ended();
  const page = await svc.page("r1");
  await svc.keep("r1", e.kept("captcha"));
  await svc.dispose("r1");
  assert.equal(page.isClosed(), false, "kept: not the run's to close");
  assert.equal(leaked(pw), 1);
  const again = await svc.openKept("r2", e.kept("captcha"));
  assert.equal(again.page, page);
  assert.equal(again.resumed, true);

  (page as unknown as FakePage).hang = true;
  await assert.rejects(svc.evaluate("r2", { expression: "1", timeoutMs: 5 }), /browser\/evaluate: timed out after 5 ms/);
  assert.equal(page.isClosed(), true, "a timeout still closes the page");
  assert.deepEqual(e.calls, ["captcha"]);
  assert.deepEqual(svc.kept(), []);
  assert.equal(leaked(pw), 0);
  await svc.dispose("r2");
});

test("keep under a name the job already keeps replaces that page without letting its hold go", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  const e = ended();
  const first = await svc.openKept("r1", e.kept("captcha"));
  const own = await svc.page("r2");
  await svc.keep("r2", e.kept("captcha"));
  assert.equal(first.page.isClosed(), true);
  assert.equal((await svc.openKept("r3", e.kept("captcha"))).page, own);
  assert.deepEqual(e.calls, [], "the same hold is taken again by the keep");
  await assert.rejects(svc.keep("r3", e.kept("other")), /already kept as "captcha"/);
  await svc.close();
});

test("a kept page is refused over CDP (v1)", async () => {
  const svc = new BrowserService({ cdpUrl: "http://127.0.0.1:9222" });
  await assert.rejects(svc.openKept("r1", { job: "job-1", name: "captcha" }), /does not apply over CDP/);
  await assert.rejects(svc.keep("r1", { job: "job-1", name: "captcha" }), /does not apply over CDP/);
});

test("tap: each point is a click at that fraction of the element's box, kept inside it", async () => {
  const pw = new FakePlaywright();
  const svc = new Service(pw);
  const page = (await svc.page("r1")) as unknown as FakePage;
  page.box = { x: 85, y: 208, width: 390, height: 300 };
  const out = await svc.tap("r1", { selector: "iframe >> table", points: [{ nx: 0.5, ny: 0.25 }, { nx: 1 / 6, ny: 5 / 6 }, { nx: 1, ny: 1 }], delayMs: 0 });
  assert.deepEqual(out, { url: "about:blank", taps: 3 });
  assert.deepEqual(page.clicks, [
    { selector: "iframe >> table", position: { x: 195, y: 75 } },
    { selector: "iframe >> table", position: { x: 65, y: 250 } },
    { selector: "iframe >> table", position: { x: 389, y: 299 } },
  ]);
  await svc.dispose("r1");
});
