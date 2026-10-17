/**
 * BrowserService: the browser the `browser/*` lib steps drive
 * (`ctx.services.browser`, built by `createStrut` from `BROWSER_*` unless
 * the host brought its own). ONE lazy Playwright connection, ONE
 * `BrowserContext` + page per run keyed by `runId`, observations accumulated
 * from the moment the page exists, a ref table from the last accessibility
 * snapshot, settle after every action, a per-call timeout and a per-run
 * budget (losing either closes the run's pages), and `dispose(runId)` wired
 * into `services.onRunEnd`.
 *
 * Three backends, one service; the environment picks.
 *   - `BROWSER_WS_URL` (+ `BROWSER_WS_PATH`): a Playwright SERVER beside this
 *     host (images/browser — the compose file's `browser` service, published
 *     as ghcr.io/stakwork/strut-browser). Every run gets a
 *     context of its own, cookies, storage and page, closed when the run
 *     ends. The server refuses a client on another Playwright major.minor:
 *     `playwright-core` in package.json and the server image move together.
 *   - `BROWSER_CDP_URL`: a real Chrome someone started with
 *     `--remote-debugging-port` on a dedicated profile and logged into. The
 *     service connects over CDP and opens ONE PAGE PER RUN in the browser's
 *     DEFAULT context: runs share the profile's cookies and are isolated only
 *     by page, and `dispose` closes the run's pages, never the context. So
 *     over CDP `storageStateSecret` is refused (the profile's state is the
 *     session), `viewport` is refused (the window is the human's) and
 *     `browser/state` is refused (it would export the whole profile).
 *   - Neither: a local headless Chrome (`BROWSER_EXECUTABLE`, else the
 *     `BROWSER_CHANNEL` channel, default `chrome`). For a desktop strut
 *     and development.
 * Setting both URLs is refused.
 *
 * Every `browser/*` step is a thin wrapper over one verb here: the
 * Playwright calls, the artifact write and the downscale live once, in the
 * service, where a host can swap them for its own.
 * `capture` runs its declared list through the same verbs (`drive`), and so
 * does `verify`, the check: the same list, then expectations, and a page
 * that fails them is a result, not an error (verdict.ts).
 *
 * A check (`verify`, `walkthrough`) runs in a session of its OWN under the
 * run — a fresh context, no cookies or storage from what the run's
 * `browser/open` signed into — because strut's verify pass replays it in a
 * run of its own: what the agent sees mid-turn is what the pass will see.
 * The run's page is left where it was.
 *
 * A KEPT page is the JOB's, not a run's (`open { session }`, `keep`): kept
 * under `job:<job>/<session>`, it outlives the run that opened it, so a
 * later turn — a person's answer to a captcha, say — finds the page where
 * the last one left it. A run that opens or keeps one is ATTACHED to it:
 * every verb the run calls reaches that page, and `dispose(runId)` only
 * detaches. A kept page has no run budget; it closes after
 * `sessionIdleMs` without a call (`BROWSER_SESSION_IDLE_MS`, 12 min), when
 * a call times out, or on `closeKept`, and at most `sessionsMax`
 * (`BROWSER_SESSIONS_MAX`, 4) are open at once. Not over CDP (v1): there the
 * pages are the human's profile's.
 *
 * `playwright-core` is imported lazily, on the first connection, so a strut
 * that never opens a browser never loads it (the lib step convention).
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page, Locator } from "playwright-core";
import type { ArtifactsCapability } from "../capabilities.js";
import { settle as settlePage, sleep } from "./settle.js";
import { saveShot, type Shot, type ShotSink } from "./shot.js";
import { Recording, type WalkthroughFrame } from "./walkthrough.js";
import { parseDenyList, denyReason, type DenyRule } from "./deny.js";
import { judgeVerify, urlMatches, type Expectation, type StoppedAt, type Verdict } from "./verdict.js";
import { captchaFiles, captchaManifest, siteOf, writeCaptcha, type CaptchaManifest, type CaptchaMode } from "./captcha.js";

export interface Observations {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
}

export interface Viewport {
  width: number;
  height: number;
}

/** Exactly one of `ref` (from the last `snapshot`) or a Playwright selector. */
export interface Target {
  ref?: string;
  selector?: string;
}

export interface BrowserServiceOptions {
  /** `ws://host:port` of a Playwright server (`playwright run-server`); the
   *  secret endpoint path goes in `wsPath`. Unset → launch a local browser. */
  wsUrl?: string;
  wsPath?: string;
  /** A real Chrome over CDP instead of a Playwright server. */
  cdpUrl?: string;
  /** Local launch only: a browser binary, else a branded `channel`
   *  (default `chrome` — the Google Chrome on the machine, no download). */
  executablePath?: string;
  channel?: string;
  /** Default viewport for `open` (1280×800). */
  viewport?: Viewport;
  /** Per-call cap, default 10 s. */
  stepTimeoutMs?: number;
  /** Per-run browser budget, default 10 min. */
  runBudgetMs?: number;
  /** A kept page closes after this long without a call, default 12 min. */
  sessionIdleMs?: number;
  /** At most this many kept pages at once, default 4. */
  sessionsMax?: number;
  /** `BROWSER_URL_DENY` (see deny.ts). */
  deny?: string;
}

/** A page the JOB keeps (the file comment): which job, its name, and what
 *  to call when it ends on its own (idle, a timeout) — the step that kept
 *  it lets the job's hold go there. */
export interface KeptSession {
  job: string;
  name: string;
  onEnd?: () => void;
}

/** The key a kept page lives under. A session name has no `/`, so the
 *  last segment is always the name. */
export function keptKey(job: string, name: string): string {
  return `job:${job}/${name}`;
}

export interface Navigated {
  url: string;
  title: string;
  /** HTTP status of the main document; 0 when nothing was fetched. */
  status: number;
}

export type CaptureStep = { do: string } & Record<string, unknown>;

/** What `verify` tests once the steps ran — each is one expectation. */
export interface VerifyExpect {
  /** Each visible on the page (case-insensitive, a substring of an element's text). */
  text?: string[];
  /** Where the page ended up: a glob (`**` any, `*` within a segment), else a substring. */
  url?: string;
  /** Each matches at least one element. */
  selector?: string[];
  /** No console error, page error, failed request or HTTP error since the page opened. */
  noErrors?: boolean;
  /** JavaScript in the page; holds when the result is truthy. */
  evaluate?: string;
}

/** `verify`'s answer: the shot where the page got to, the verdict, and what was seen. */
export type Verified = Shot & Verdict & { small: Buffer; errors: string[]; pageUrl: string; title: string };

/** `walkthrough`'s answer: `verify`'s verdict, the recording's manifest as
 *  the locator, its frames, and the model's copy of the last one. */
export type Walked = Verdict & {
  path: string;
  url: string;
  frames: Array<{ file: string; caption: string; url: string }>;
  small: Buffer;
  errors: string[];
  pageUrl: string;
  title: string;
};

/** A walkthrough step: a capture verb, and a caption when it earns a frame. */
export type WalkthroughStep = CaptureStep & { caption?: string };

/** The verbs a `capture` list may name — everything that drives the page
 *  the run already has; `open`/`close`/`screenshot` are the compound's own. */
export const CAPTURE_VERBS = ["goto", "click", "fill", "type", "press", "select", "hover", "scroll", "wait", "text", "evaluate", "back"] as const;

type CaptureVerb = (typeof CAPTURE_VERBS)[number];

/** What each verb in a declared list needs: the rules its `browser/*`
 *  step's input schema enforces, which a list — run through the verbs
 *  directly — would otherwise meet only once it got there. */
const STEP_NEEDS: Record<CaptureVerb, { required?: string[]; oneOf?: string[]; atMostOne?: string[] }> = {
  goto: { required: ["url"] },
  click: { oneOf: ["ref", "selector"] },
  fill: { required: ["value"], oneOf: ["ref", "selector"] },
  type: { required: ["text"] },
  press: { required: ["key"] },
  select: { required: ["value"], oneOf: ["ref", "selector"] },
  hover: { oneOf: ["ref", "selector"] },
  scroll: { oneOf: ["ref", "selector", "y"] },
  wait: { oneOf: ["ref", "selector", "text", "url", "ms"] },
  text: { atMostOne: ["ref", "selector"] },
  evaluate: { required: ["expression"] },
  back: {},
};

/** The key a check's own session is kept under: `<runId><CHECK_KEY><n>`. */
const CHECK_KEY = "\u0000check:";

/** A `wait` step in a `verify` list with no `timeoutMs` of its own gives up
 *  after this long, not the run's whole budget (what `capture` allows): a
 *  page that never shows the text is a refutation, and it should not take
 *  ten minutes to say so. */
export const VERIFY_WAIT_MS = 30_000;

export const TEXT_CAP = 50_000;
export const TREE_CAP = 100_000;
const OBS_CAP = 200;
/** Slack over the per-call cap before the hard race closes the context:
 *  settle can add up to ~7.5 s on its own. */
const SETTLE_SLACK_MS = 8_500;

interface Session {
  context: BrowserContext;
  /** The run's own context (a Playwright server) — closed with the run. Over
   *  CDP it is the profile's default context, shared with the human and every
   *  other run, and only `pages` are closed. */
  own: boolean;
  page: Page;
  /** Every page the run opened: the first plus any popup that replaced it. */
  pages: Page[];
  refs: Set<string>;
  /** A popup / new tab became the page since the last snapshot. */
  replaced: boolean;
  obs: Observations;
}

interface Run {
  startedAt: number;
  /** The budget timer — on a kept page, the idle timer. */
  timer?: NodeJS.Timeout;
  exhausted: boolean;
  session?: Session;
  /** An open in flight: a second `page()` call joins it instead of making
   *  a context of its own. */
  opening?: Promise<Page>;
  /** Set on a kept page: no budget, an idle timer that waits while a call
   *  is `busy`. */
  kept?: KeptSession & { busy: number };
}

/** The pause between two taps: a tile that fades as it is selected. */
const TAP_DELAY_MS = 300;

export class BrowserService {
  readonly viewport: Viewport;
  readonly stepTimeoutMs: number;
  readonly runBudgetMs: number;
  readonly sessionIdleMs: number;
  readonly sessionsMax: number;
  private readonly rules: DenyRule[];
  private readonly opts: BrowserServiceOptions;
  private browser?: Browser;
  private connecting?: Promise<Browser>;
  private readonly runs = new Map<string, Run>();
  /** The hard race's slack over a call's cap — `protected` so an offline test can shorten it. */
  protected settleSlackMs = SETTLE_SLACK_MS;
  /** A run attached to a kept page → that page's key (`keptKey`). */
  private readonly attached = new Map<string, string>();
  private checkSeq = 0;

  constructor(opts: BrowserServiceOptions = {}) {
    if (opts.wsUrl && opts.cdpUrl) throw new Error("browser: set BROWSER_WS_URL (a Playwright server) or BROWSER_CDP_URL (a real Chrome), not both");
    this.opts = opts;
    this.viewport = opts.viewport ?? { width: 1280, height: 800 };
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 10_000;
    this.runBudgetMs = opts.runBudgetMs ?? 600_000;
    this.sessionIdleMs = opts.sessionIdleMs ?? 720_000;
    this.sessionsMax = opts.sessionsMax ?? 4;
    this.rules = parseDenyList(opts.deny);
  }

  /** The service the environment describes (see the file comment). */
  static fromEnv(env: Record<string, string | undefined> = process.env): BrowserService {
    const [width, height] = (env["BROWSER_VIEWPORT"] ?? "1280x800").split("x").map(Number);
    if (!width || !height) throw new Error(`BROWSER_VIEWPORT must be WIDTHxHEIGHT, got "${env["BROWSER_VIEWPORT"]}"`);
    return new BrowserService({
      wsUrl: env["BROWSER_WS_URL"] || undefined,
      wsPath: env["BROWSER_WS_PATH"] || undefined,
      cdpUrl: env["BROWSER_CDP_URL"] || undefined,
      executablePath: env["BROWSER_EXECUTABLE"] || undefined,
      channel: env["BROWSER_CHANNEL"] || undefined,
      viewport: { width, height },
      stepTimeoutMs: num(env["BROWSER_STEP_TIMEOUT_MS"], 10_000),
      runBudgetMs: num(env["BROWSER_RUN_BUDGET_MS"], 600_000),
      sessionIdleMs: num(env["BROWSER_SESSION_IDLE_MS"], 720_000),
      sessionsMax: num(env["BROWSER_SESSIONS_MAX"], 4),
      deny: env["BROWSER_URL_DENY"],
    });
  }

  // ── The primitives ───────────────────────────────────────────────────────

  /** True over CDP: pages in a real Chrome's own profile. */
  get cdp(): boolean {
    return Boolean(this.opts.cdpUrl);
  }

  /** The run's page — context + page created on first use. `viewport` and
   *  `storageState` apply only at creation, and only over a Playwright
   *  server (over CDP both are refused — see the file comment). ONE open per
   *  run at a time: the agent step runs a turn's tool calls concurrently, so
   *  two `browser_open`s in one turn arrive together, and each making a
   *  context would orphan the first (`dispose` closes only `run.session`). */
  async page(runId: string, opts: { viewport?: Viewport; storageState?: unknown } = {}): Promise<Page> {
    const key = this.keyOf(runId);
    const run = key === runId ? this.runOf(runId) : this.runs.get(key)!;
    if (run.exhausted) throw new Error(this.spent());
    const live = run.session;
    if (live && !live.page.isClosed()) return live.page;
    if (run.opening) return run.opening;
    const r = run;
    const opening = this.openSession(key, r, opts).finally(() => (r.opening = undefined));
    r.opening = opening;
    return opening;
  }

  /** Whether the run already has a live page (its own, or the kept one it is attached to). */
  private hasPage(runId: string): boolean {
    const s = this.runs.get(this.keyOf(runId))?.session;
    return Boolean(s && !s.page.isClosed());
  }

  /** Where the run's calls go: the kept page it is attached to, else its own key. */
  private keyOf(runId: string): string {
    const key = this.attached.get(runId);
    if (key && this.runs.has(key)) return key;
    if (key) this.attached.delete(runId);
    return runId;
  }

  /**
   * The job's page named `session`, the run attached to it: the page the
   * job already keeps (`resumed: true`), else a new one, counted against
   * `sessionsMax`. Its idle clock starts over.
   */
  async openKept(
    runId: string,
    session: KeptSession & { viewport?: Viewport; storageState?: unknown },
  ): Promise<{ page: Page; resumed: boolean }> {
    this.refuseCdp();
    const key = keptKey(session.job, session.name);
    let run = this.runs.get(key);
    if (run?.kept && !run.opening && !this.alive(run.session)) {
      await this.endKept(key, true);
      run = undefined;
    }
    if (run?.kept) {
      if (session.onEnd) run.kept.onEnd = session.onEnd;
      this.attached.set(runId, key);
      const page = run.opening ? await run.opening : run.session!.page;
      this.idle(key, run);
      return { page, resumed: true };
    }
    this.roomForOneMore();
    const r: Run = { startedAt: Date.now(), exhausted: false, kept: { job: session.job, name: session.name, onEnd: session.onEnd, busy: 0 } };
    this.runs.set(key, r);
    this.attached.set(runId, key);
    const opening = this.openSession(key, r, session).finally(() => (r.opening = undefined));
    r.opening = opening;
    try {
      const page = await opening;
      this.idle(key, r);
      return { page, resumed: false };
    } catch (err) {
      // Nothing was kept: forget the entry so it does not count, and no hold was taken to let go.
      if (this.runs.get(key) === r) await this.endKept(key, false);
      throw err;
    }
  }

  /**
   * Move the page the run is on onto the job, as `session`: it outlives
   * the run from here, and the run stays attached to it. A page the job
   * already keeps under that name is replaced (closed, its hold left for
   * the caller to take again).
   */
  async keep(runId: string, session: KeptSession): Promise<{ url: string; title: string }> {
    this.refuseCdp();
    const key = keptKey(session.job, session.name);
    const s = this.live(runId);
    const fromKey = this.keyOf(runId);
    const from = this.runs.get(fromKey)!;
    if (fromKey !== key) {
      if (from.kept) throw new Error(`browser/keep: this page is already kept as "${from.kept.name}" — open that session instead`);
      if (this.runs.has(key)) await this.endKept(key, false);
      else this.roomForOneMore();
      from.session = undefined;
      this.runs.set(key, { startedAt: Date.now(), exhausted: false, session: s, kept: { ...session, busy: 0 } });
      this.attached.set(runId, key);
    } else if (session.onEnd) {
      from.kept!.onEnd = session.onEnd;
    }
    this.idle(key, this.runs.get(key)!);
    return { url: s.page.url(), title: await s.page.title() };
  }

  /** Close the job's page named `session`, if it is open. Its hold is the
   *  caller's to let go (`browser/close`); `onEnd` is not called. */
  async closeKept(job: string, name: string): Promise<{ ok: true }> {
    await this.endKept(keptKey(job, name), false);
    return { ok: true };
  }

  /** The kept pages open now, by job and name. */
  kept(): Array<{ job: string; name: string }> {
    return [...this.runs.values()].flatMap((r) => (r.kept ? [{ job: r.kept.job, name: r.kept.name }] : []));
  }

  private refuseCdp(): void {
    if (this.cdp) throw new Error("browser: a kept page (`session`, browser/keep) does not apply over CDP — the profile's pages are the human's");
  }

  private roomForOneMore(): void {
    if (this.kept().length >= this.sessionsMax) {
      throw new Error(`browser: ${this.sessionsMax} kept pages are open (BROWSER_SESSIONS_MAX) — close one (browser/close { session }) or wait for one to go idle`);
    }
  }

  private alive(s: Session | undefined): boolean {
    return Boolean(s && !s.page.isClosed() && s.context.browser()?.isConnected());
  }

  /** (Re)start a kept page's idle clock — held while a call is in flight. */
  private idle(key: string, run: Run): void {
    if (!run.kept) return;
    clearTimeout(run.timer);
    run.timer = undefined;
    if (run.kept.busy > 0 || this.runs.get(key) !== run) return;
    run.timer = setTimeout(() => void this.endKept(key, true), this.sessionIdleMs);
    run.timer.unref();
  }

  /** A kept page ends: forgotten, every run detached from it, closed.
   *  `ended` = it ended on its own (idle, a timeout, the browser dropped),
   *  so the job's hold is let go through `onEnd`. */
  private async endKept(key: string, ended: boolean): Promise<void> {
    const run = this.runs.get(key);
    if (!run?.kept) return;
    this.runs.delete(key);
    clearTimeout(run.timer);
    for (const [id, k] of this.attached) if (k === key) this.attached.delete(id);
    if (ended) {
      try {
        run.kept.onEnd?.();
      } catch {
        /* the hold stays for the job's sweep */
      }
    }
    await closeQuietly(run.session);
  }

  /** The run, started on first use: its budget clock runs from here. */
  private runOf(runId: string): Run {
    const known = this.runs.get(runId);
    if (known) return known;
    const run: Run = { startedAt: Date.now(), exhausted: false };
    this.runs.set(runId, run);
    this.arm(runId, run, this.runBudgetMs);
    return run;
  }

  /** The budget timer: when it fires, the session under `key` closes and refuses further calls. */
  private arm(key: string, run: Run, ms: number): void {
    run.timer = setTimeout(() => {
      run.exhausted = true;
      void this.closeSession(key);
    }, ms);
    run.timer.unref();
  }

  /**
   * A check's own session (the file comment): a key of its own under the
   * run, so a context of its own, closed when `fn` ends. It spends the run's
   * budget — the same clock — and `dispose(runId)` closes it with the run.
   * Over CDP it is a page of its own in the profile's context, whose cookies
   * every page shares.
   */
  private async inOwnSession<T>(runId: string, fn: (key: string) => Promise<T>): Promise<T> {
    const parent = this.runOf(runId);
    if (parent.exhausted) throw new Error(this.spent());
    const key = `${runId}${CHECK_KEY}${++this.checkSeq}`;
    const run: Run = { startedAt: parent.startedAt, exhausted: false };
    this.runs.set(key, run);
    this.arm(key, run, Math.max(0, this.runBudgetMs - (Date.now() - parent.startedAt)));
    try {
      return await fn(key);
    } finally {
      await this.dispose(key);
    }
  }

  private async openSession(key: string, run: Run, opts: { viewport?: Viewport; storageState?: unknown }): Promise<Page> {
    const stale = run.session;
    run.session = undefined;
    await closeQuietly(stale);
    const browser = await this.connect();
    let context: BrowserContext;
    if (this.cdp) {
      if (opts.storageState) throw new Error("browser: storageStateSecret does not apply over CDP — the Chrome profile's own logged-in state is the session");
      if (opts.viewport) throw new Error("browser: viewport does not apply over CDP — the window's size is the human's, and a shot is what they see");
      context = browser.contexts()[0] ?? fail("browser: the CDP Chrome has no default context (no window open?)");
    } else {
      context = await browser.newContext({
        viewport: opts.viewport ?? this.viewport,
        ...(opts.storageState ? { storageState: opts.storageState as BrowserContextOptions["storageState"] } : {}),
      });
    }
    let page: Page;
    try {
      page = await context.newPage();
    } catch (err) {
      // The context is nobody's yet — nothing else would close it.
      if (!this.cdp) await context.close().catch(() => {});
      throw err;
    }
    const session: Session = { context, own: !this.cdp, page, pages: [page], refs: new Set(), replaced: false, obs: emptyObs() };
    // The run was disposed, or its budget ran out, while this was opening:
    // `dispose` / `closeSession` saw no session, so this one is ours to close.
    if (this.runs.get(key) !== run || run.exhausted) {
      await closeQuietly(session);
      throw new Error(run.exhausted ? this.spent() : run.kept ? "browser: the kept page was closed while it was opening" : "browser: the run ended while its page was opening");
    }
    this.watch(session, page);
    run.session = session;
    return page;
  }

  private spent(): string {
    return `browser: this run's browser budget (${this.runBudgetMs} ms) is spent`;
  }

  /** Observations and ref resets for one of the run's pages — on the
   *  PAGE, not the context: over CDP the context is the human's, shared. A
   *  popup or target=_blank link replaces the page — the newest page
   *  is THE page; the next snapshot says so. */
  private watch(session: Session, p: Page): void {
    p.setDefaultTimeout(this.stepTimeoutMs);
    const push = (arr: string[], v: string) => {
      arr.push(v);
      if (arr.length > OBS_CAP) arr.shift();
    };
    p.on("console", (m) => {
      if (m.type() === "error") push(session.obs.console, m.text());
    });
    p.on("pageerror", (e) => push(session.obs.pageErrors, String(e.message ?? e)));
    p.on("requestfailed", (r) => push(session.obs.failedRequests, `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "failed"}`));
    p.on("response", (r) => {
      const s = r.status();
      if (s >= 400) push(session.obs.httpErrors, `${s} ${r.request().method()} ${r.url()}`);
    });
    // A new DOCUMENT resets the refs — `domcontentloaded`, not `framenavigated`,
    // which also fires for pushState / hash changes (a Framer page does both
    // while it scrolls), where every ref still resolves.
    p.on("domcontentloaded", () => session.refs.clear());
    p.on("popup", (popup) => {
      session.page = popup;
      session.pages.push(popup);
      session.refs.clear();
      session.replaced = true;
      this.watch(session, popup);
    });
  }

  /** Resolve a ref from the latest snapshot, or a selector, to a locator. */
  locate(runId: string, target: Target): Locator {
    const s = this.live(runId);
    if (target.ref && target.selector) throw new Error("browser: give ref OR selector, not both");
    if (target.ref) {
      const ref = target.ref.replace(/^@|^ref=/, "");
      if (!s.refs.has(ref)) {
        throw new Error(`browser: unknown ref "${ref}" — call browser/snapshot first (refs reset on every navigation)`);
      }
      return s.page.locator(`aria-ref=${ref}`);
    }
    if (target.selector) return s.page.locator(target.selector);
    throw new Error("browser: give exactly one of ref or selector");
  }

  /** The accessibility tree with `[ref=eN]` tags; records the ref table. */
  async snapshot(runId: string): Promise<{ url: string; title: string; tree: string }> {
    return this.call(runId, "snapshot", undefined, async (s, ms) => {
      const tree = await s.page.ariaSnapshot({ mode: "ai", timeout: ms });
      // `f1e7`: an element inside an iframe (a captcha's challenge).
      s.refs = new Set([...tree.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((m) => m[1]!));
      const note = s.replaced ? "# a popup / new tab replaced the page; this is the newest page\n" : "";
      s.replaced = false;
      return { url: s.page.url(), title: await s.page.title(), tree: cap(note + tree, TREE_CAP) };
    });
  }

  /** See settle.ts. */
  settle(page: Page, extraMs = 0): Promise<void> {
    return settlePage(page, extraMs);
  }

  /** Drain the observations accumulated since the last call. Empty
   *  when the run has no page. */
  observe(runId: string): Observations {
    const s = this.runs.get(this.keyOf(runId))?.session;
    if (!s) return emptyObs();
    const out = s.obs;
    s.obs = emptyObs();
    return out;
  }

  /** Close the run's context (over CDP: only its pages) and any check's
   *  still open under it, and forget the run. A kept page the run is
   *  attached to stays open: the run only lets go of it. Idempotent; the
   *  `services.onRunEnd` hook. */
  async dispose(runId: string): Promise<void> {
    this.attached.delete(runId);
    const keys = [...this.runs.keys()].filter((k) => k === runId || k.startsWith(`${runId}${CHECK_KEY}`));
    for (const key of keys) {
      const run = this.runs.get(key);
      if (!run) continue;
      this.runs.delete(key);
      if (run.timer) clearTimeout(run.timer);
      await closeQuietly(run.session);
    }
  }

  /** Milliseconds of browser budget the run has left (the whole budget
   *  before its first `open`). */
  remaining(runId: string): number {
    const run = this.runs.get(this.keyOf(runId));
    if (!run) return this.runBudgetMs;
    if (run.kept) return this.sessionIdleMs;
    if (run.exhausted) return 0;
    return Math.max(0, this.runBudgetMs - (Date.now() - run.startedAt));
  }

  /** Throws when the denylist refuses `url`. */
  check(url: string): void {
    const reason = denyReason(url, this.rules);
    if (reason) throw new Error(`browser: refused ${url}: ${reason}`);
  }

  /** Drop the shared connection (tests, shutdown). Every run's context goes
   *  with it; a CDP Chrome is only disconnected from, never closed. */
  async close(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.dispose(id);
    this.attached.clear();
    const b = this.browser;
    this.browser = undefined;
    await b?.close().catch(() => {});
  }

  // ── The verbs — one per browser/* step ───────────────────────────────────

  /** The run's page — or, with `session`, the job's kept page of that name
   *  (`openKept`). `resumed`: the page was already open. A resumed KEPT
   *  page stays where it is: `url` is opened only on a new one. */
  async open(
    runId: string,
    input: { url?: string; viewport?: Viewport; storageState?: unknown; timeoutMs?: number; session?: KeptSession } = {},
  ): Promise<Navigated & { resumed: boolean }> {
    if (input.url) this.check(input.url);
    const opts = { viewport: input.viewport, storageState: input.storageState };
    let page: Page;
    let resumed: boolean;
    if (input.session) ({ page, resumed } = await this.openKept(runId, { ...input.session, ...opts }));
    else {
      resumed = this.hasPage(runId);
      page = await this.page(runId, opts);
    }
    if (input.url && !(input.session && resumed)) return { ...(await this.goto(runId, { url: input.url, timeoutMs: input.timeoutMs })), resumed };
    return { url: page.url(), title: await page.title(), status: 0, resumed };
  }

  async goto(runId: string, input: { url: string; wait?: number; timeoutMs?: number }): Promise<Navigated> {
    this.check(input.url);
    return this.call(runId, "goto", input.timeoutMs, async (s, ms) => {
      const resp = await s.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: ms });
      await this.landed(s);
      await settlePage(s.page, input.wait);
      return { url: s.page.url(), title: await s.page.title(), status: resp?.status() ?? 0 };
    }, input.wait);
  }

  async click(runId: string, input: Target & { button?: "left" | "right" | "middle"; double?: boolean; timeoutMs?: number }): Promise<{ url: string }> {
    return this.call(runId, "click", input.timeoutMs, async (s, ms) => {
      const loc = this.locate(runId, input);
      const o = { button: input.button, timeout: ms };
      if (input.double) await loc.dblclick(o);
      else await loc.click(o);
      await settlePage(s.page);
      await this.landed(s);
      return { url: s.page.url() };
    });
  }

  /**
   * Click points ON an element, each given as fractions (0–1) of its box —
   * a person's taps on a picture of it (a captcha's crop). Each point is a
   * click at that offset in the element's box as it is NOW, with a pause
   * between two (a tile fades as it is picked); one settle at the end. On
   * an iframe the click lands on what the frame shows there, its own
   * document included.
   */
  async tap(runId: string, input: Target & { points: Array<{ nx: number; ny: number }>; delayMs?: number; timeoutMs?: number }): Promise<{ url: string; taps: number }> {
    const delay = input.delayMs ?? TAP_DELAY_MS;
    return this.call(
      runId,
      "tap",
      input.timeoutMs,
      async (s, ms) => {
        const loc = this.locate(runId, input);
        for (const [i, p] of input.points.entries()) {
          if (i) await sleep(delay);
          const box = await loc.boundingBox({ timeout: ms });
          if (!box) throw new Error("the element is not visible");
          await loc.click({ position: { x: within(p.nx * box.width, box.width), y: within(p.ny * box.height, box.height) }, timeout: ms });
        }
        await settlePage(s.page);
        await this.landed(s);
        return { url: s.page.url(), taps: input.points.length };
      },
      delay * Math.max(0, input.points.length - 1),
    );
  }

  async fill(runId: string, input: Target & { value: string; timeoutMs?: number }): Promise<{ ok: true }> {
    return this.call(runId, "fill", input.timeoutMs, async (s, ms) => {
      await this.locate(runId, input).fill(input.value, { timeout: ms });
      await settlePage(s.page);
      return { ok: true };
    });
  }

  async type(runId: string, input: { text: string; delay?: number; timeoutMs?: number }): Promise<{ ok: true }> {
    return this.call(runId, "type", input.timeoutMs, async (s) => {
      await s.page.keyboard.type(input.text, { delay: input.delay });
      await settlePage(s.page);
      return { ok: true };
    });
  }

  async press(runId: string, input: { key: string; timeoutMs?: number }): Promise<{ url: string }> {
    return this.call(runId, "press", input.timeoutMs, async (s) => {
      await s.page.keyboard.press(input.key);
      await settlePage(s.page);
      await this.landed(s);
      return { url: s.page.url() };
    });
  }

  async select(runId: string, input: Target & { value: string; timeoutMs?: number }): Promise<{ ok: true }> {
    return this.call(runId, "select", input.timeoutMs, async (s, ms) => {
      await this.locate(runId, input).selectOption(input.value, { timeout: ms });
      await settlePage(s.page);
      return { ok: true };
    });
  }

  async hover(runId: string, input: Target & { timeoutMs?: number }): Promise<{ ok: true }> {
    return this.call(runId, "hover", input.timeoutMs, async (s, ms) => {
      await this.locate(runId, input).hover({ timeout: ms });
      await settlePage(s.page);
      return { ok: true };
    });
  }

  async scroll(runId: string, input: Target & { y?: number; timeoutMs?: number }): Promise<{ ok: true }> {
    return this.call(runId, "scroll", input.timeoutMs, async (s, ms) => {
      if (input.ref || input.selector) await this.locate(runId, input).scrollIntoViewIfNeeded({ timeout: ms });
      else if (typeof input.y === "number") await s.page.evaluate((y) => window.scrollBy(0, y), input.y);
      else throw new Error("give ref, selector, or y");
      await settlePage(s.page);
      return { ok: true };
    });
  }

  /** The dynamic-data verb: hold until an element is visible, a text is on
   *  the page, the URL matches, or `ms` pass. Its cap is the run's remaining
   *  budget, not the per-call default — outlasting a slow fetch is its job. */
  async wait(runId: string, input: Target & { text?: string; url?: string; ms?: number; timeoutMs?: number }): Promise<{ ok: true; waitedMs: number }> {
    const budget = input.timeoutMs ?? this.remaining(runId);
    return this.call(runId, "wait", budget, async (s, ms) => {
      const t0 = Date.now();
      if (typeof input.ms === "number") await sleep(Math.min(input.ms, ms));
      else if (input.text) await anyVisible(s.page.locator(`text=${input.text}`)).waitFor({ state: "visible", timeout: ms });
      else if (input.url) {
        const want = input.url;
        await s.page.waitForURL(want.includes("*") ? want : (u) => u.href.includes(want), { timeout: ms });
      } else if (input.ref || input.selector) await anyVisible(this.locate(runId, input)).waitFor({ state: "visible", timeout: ms });
      else throw new Error("give ref, selector, text, url, or ms");
      return { ok: true, waitedMs: Date.now() - t0 };
    });
  }

  async text(runId: string, input: Target & { timeoutMs?: number } = {}): Promise<{ text: string }> {
    return this.call(runId, "text", input.timeoutMs, async (s, ms) => {
      const loc = input.ref || input.selector ? this.locate(runId, input) : s.page.locator("body");
      return { text: cap(await loc.innerText({ timeout: ms }), TEXT_CAP) };
    });
  }

  /** The full frame to `shots/NNN.png` under the run's artifacts; the
   *  0.6× copy rides along as `small` for the step to hand the model. */
  async screenshot(
    runId: string,
    input: Target & { fullPage?: boolean; name?: string; timeoutMs?: number },
    sink: ShotSink,
  ): Promise<Shot & { small: Buffer }> {
    return this.call(runId, "screenshot", input.timeoutMs, async (s, ms) => {
      // scale "css": one pixel per CSS pixel — a headed Chrome on a Retina
      // display would otherwise shoot at device pixels (2×: four times the
      // model's tokens); headless is DPR 1 either way.
      const png =
        input.ref || input.selector
          ? await this.locate(runId, input).screenshot({ type: "png", scale: "css", timeout: ms })
          : await s.page.screenshot({ type: "png", scale: "css", fullPage: input.fullPage, timeout: ms });
      return saveShot(sink, png, input.name);
    });
  }

  /**
   * Ask a person to solve a captcha (captcha.ts): the challenge element
   * cropped to `shots/captcha-<round>.png` and the manifest beside it,
   * `site` read off the page. The crop is not announced as an image (no
   * `notify`): the host shows it on the captcha's own card.
   */
  async captcha(
    runId: string,
    input: Target & { round: number; mode: CaptchaMode; grid?: { rows: number; cols: number }; instruction?: string; maxRounds?: number; expiresInMs?: number; timeoutMs?: number },
    sink: ShotSink,
  ): Promise<{ manifest: CaptchaManifest; path: string; url: string; image: Shot; small: Buffer }> {
    const maxRounds = input.maxRounds ?? 5;
    if (input.round > maxRounds) throw new Error(`browser/captcha-ask: round ${input.round} is past maxRounds (${maxRounds}) — the captcha is not solved`);
    return this.call(runId, "captcha-ask", input.timeoutMs, async (s, ms) => {
      const site = siteOf(s.page.url());
      const png = await this.locate(runId, input).screenshot({ type: "png", scale: "css", timeout: ms });
      const { small, ...image } = await saveShot({ ...sink, notify: undefined }, png, captchaFiles(input.round).name);
      const manifest = captchaManifest({ ...input, site, maxRounds, expiresInMs: input.expiresInMs ?? 600_000 });
      return { manifest, ...(await writeCaptcha(sink, manifest)), image, small };
    });
  }

  /** JavaScript IN THE PAGE, never in this host; the JSON result, capped. */
  async evaluate(runId: string, input: { expression: string; timeoutMs?: number }): Promise<{ result: unknown; truncated?: true }> {
    return this.call(runId, "evaluate", input.timeoutMs, async (s) => {
      const result: unknown = await s.page.evaluate(input.expression);
      const json = JSON.stringify(result ?? null);
      if (json.length <= TEXT_CAP) return { result: result ?? null };
      return { result: json.slice(0, TEXT_CAP), truncated: true };
    });
  }

  async back(runId: string, input: { timeoutMs?: number } = {}): Promise<{ url: string; title: string }> {
    return this.call(runId, "back", input.timeoutMs, async (s, ms) => {
      // "commit", not "domcontentloaded": a real Chrome restores history from
      // its back/forward cache, which fires no load events (headless has the
      // cache off). Settle does the waiting either way.
      await s.page.goBack({ waitUntil: "commit", timeout: ms });
      await this.landed(s);
      await settlePage(s.page);
      return { url: s.page.url(), title: await s.page.title() };
    });
  }

  /** The current storage state (cookies + localStorage) to
   *  `state.json` under the run's artifacts, for a human to paste under
   *  Secrets once. */
  async state(runId: string, artifacts: ArtifactsCapability): Promise<{ path: string; url: string }> {
    if (this.cdp) throw new Error("browser/state does not apply over CDP — it would export the human's whole Chrome profile, which is already the session");
    return this.call(runId, "state", undefined, async (s) => {
      const state = await s.context.storageState();
      await artifacts.write(runId, "state.json", JSON.stringify(state, null, 2));
      return { path: "state.json", url: `/artifacts/${runId}/state.json` };
    });
  }

  /** Explicit teardown of the run's context (over CDP: its pages); the
   *  budget clock keeps running. A kept page the run is attached to is the
   *  job's: the run lets go of it, and it stays open (`closeKept` closes it). */
  async closeRun(runId: string): Promise<{ ok: true }> {
    this.attached.delete(runId);
    await this.closeSession(runId);
    return { ok: true };
  }

  /** Run a declared list through the verbs, in order, and stop at the
   *  first step that fails: which one, and why. The page stays where it got
   *  to. A list that is wrong (`checkSteps`) is refused before anything runs. */
  async drive(runId: string, steps: CaptureStep[] = [], label = "capture"): Promise<{ stopped?: StoppedAt }> {
    checkSteps(steps, label);
    for (const [i, step] of steps.entries()) {
      const { do: verb, ...args } = step;
      try {
        await (this[verb as CaptureVerb] as (runId: string, args: unknown) => Promise<unknown>)(runId, args);
      } catch (err) {
        // Whole: `call` already bounded it, and a strict-mode violation's matches and way out are its tail.
        return { stopped: { step: i + 1, verb, args, message: err instanceof Error ? err.message : String(err) } };
      }
    }
    return {};
  }

  /** The declared compound: open → steps → settle → shoot → drain. A
   *  step that fails fails the whole capture, with the step named. */
  async capture(
    runId: string,
    input: { url: string; steps?: CaptureStep[]; fullPage?: boolean; wait?: number; viewport?: Viewport; timeoutMs?: number },
    sink: ShotSink,
  ): Promise<Shot & { small: Buffer; errors: string[]; pageUrl: string; title: string }> {
    checkSteps(input.steps ?? [], "capture");
    await this.open(runId, { url: input.url, viewport: input.viewport, timeoutMs: input.timeoutMs });
    const { stopped } = await this.drive(runId, input.steps);
    if (stopped) throw new Error(`capture: step ${stopped.step} (${stopped.verb} ${JSON.stringify(stopped.args)}) failed: ${stopped.message}`);
    const page = this.live(runId).page;
    await settlePage(page, input.wait);
    const shot = await this.screenshot(runId, { fullPage: input.fullPage, timeoutMs: input.timeoutMs }, sink);
    return { ...shot, errors: flattenObs(this.observe(runId)), pageUrl: page.url(), title: await page.title() };
  }

  /**
   * The check (plans/job-claims.md §4): open → steps → settle → shoot
   * WHERE THE PAGE GOT TO → drain → test `expect`. The page failing is a
   * result — a document that answered HTTP ≥ 400, a step whose target
   * matched nothing, an expectation that does not hold, an error with
   * `noErrors` — and comes back `supports: false` with each named (verdict.ts).
   * Only the instrument failing throws, which the verify pass reads as
   * cannot-run and writes nothing: the browser not starting, the URL not
   * opening at all (DNS, refused, its own timeout, the denylist), the page
   * lost on the way (the per-call race closed it, the budget ran out), an
   * expectation that cannot be evaluated (a selector or a script that does
   * not parse), a list that is wrong (`checkSteps`). It runs in a session
   * of its own (the file comment).
   */
  async verify(
    runId: string,
    input: { url: string; steps?: CaptureStep[]; wait?: number; expect?: VerifyExpect; viewport?: Viewport; timeoutMs?: number },
    sink: ShotSink,
  ): Promise<Verified> {
    const steps = (input.steps ?? []).map((s) => (s.do === "wait" && s["timeoutMs"] === undefined ? { ...s, timeoutMs: VERIFY_WAIT_MS } : s));
    checkSteps(steps, "verify");
    return this.inOwnSession(runId, async (key) => {
      const { status } = await this.open(key, { url: input.url, viewport: input.viewport, timeoutMs: input.timeoutMs });
      const { stopped } = await this.drive(key, steps, "verify");
      const page = this.live(key).page;
      await settlePage(page, input.wait);
      const shot = await this.screenshot(key, { timeoutMs: input.timeoutMs }, sink);
      const errors = flattenObs(this.observe(key));
      const expectations = await this.call(key, "verify", input.timeoutMs, (s) => expectationsOn(s.page, input.expect ?? {}, errors));
      const pageUrl = page.url();
      return { ...shot, ...judgeVerify({ status, stopped, pageUrl, expectations }), errors, pageUrl, title: await page.title() };
    });
  }

  /**
   * `verify` with a frame per captioned step (plans/live-artifacts.md
   * §4): open → frame 1 (the opened page) → each step, and after each one
   * that has a `caption` a frame → settle → judge, exactly as `verify` does.
   * The frames and a manifest are a new directory under the sink's root
   * (walkthrough.ts), told to the job's host as they land. A step that
   * fails, or an expectation that does not hold, ends the recording
   * `stopped` on a last frame of where the page got to, marked with why.
   * The list is checked before anything runs (`checkSteps`): a wrong one
   * starts no recording. Only the instrument failing throws, and it runs in
   * a session of its own, as for `verify`.
   */
  async walkthrough(
    runId: string,
    input: { url: string; title?: string; caption?: string; steps?: WalkthroughStep[]; wait?: number; expect?: VerifyExpect; viewport?: Viewport; timeoutMs?: number },
    sink: ShotSink,
  ): Promise<Walked> {
    const steps = input.steps ?? [];
    checkSteps(steps, "walkthrough");
    return this.inOwnSession(runId, async (key) => {
      const { status } = await this.open(key, { url: input.url, viewport: input.viewport, timeoutMs: input.timeoutMs });
      // Read fresh each time: a step that opens a popup replaces the check's page.
      const page = () => this.live(key).page;
      const rec = await Recording.start(sink, { ...(input.title ? { title: input.title } : {}), url: input.url });
      const frames: Walked["frames"] = [];
      let small: Buffer | undefined;
      const frame = async (caption: string, step?: Record<string, unknown>) => {
        await settlePage(page(), input.wait);
        const png = await this.call(key, "screenshot", input.timeoutMs, (s, ms) => s.page.screenshot({ type: "png", scale: "css", timeout: ms }));
        const f: Omit<WalkthroughFrame, "file" | "ms"> = { caption, pageUrl: page().url(), ...(step ? { step } : {}) };
        const added = await rec.addFrame(png, f);
        frames.push({ file: added.file, caption, url: added.url });
        small = added.small;
      };
      await frame(input.caption || (await page().title()) || input.url);

      let stopped: StoppedAt | undefined;
      let framedLast = steps.length === 0;
      for (const [i, raw] of steps.entries()) {
        const { caption, ...step } = raw;
        const s = (step.do === "wait" && step["timeoutMs"] === undefined ? { ...step, timeoutMs: VERIFY_WAIT_MS } : step) as CaptureStep;
        const r = await this.drive(key, [s], "walkthrough");
        if (r.stopped) {
          stopped = { ...r.stopped, step: i + 1 };
          break;
        }
        framedLast = typeof caption === "string" && caption !== "";
        if (framedLast) await frame(caption as string, step);
      }
      const errors = flattenObs(this.observe(key));
      const expectations = await this.call(key, "walkthrough", input.timeoutMs, (s) => expectationsOn(s.page, input.expect ?? {}, errors));
      const pageUrl = page().url();
      const verdict = judgeVerify({ status, stopped, pageUrl, expectations });
      // Where the page got to, unless the last step's frame already shows it.
      if (stopped || !framedLast) await frame(stopped ? `Stopped at step ${stopped.step}` : (await page().title()) || pageUrl);
      await rec.finish(verdict.failed);
      return {
        ...verdict,
        path: rec.path,
        url: rec.url,
        frames,
        small: small!,
        errors,
        pageUrl,
        title: await page().title(),
      };
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.connecting) {
      this.connecting = this.launch()
        .then((b) => {
          b.on("disconnected", () => {
            if (this.browser === b) this.browser = undefined;
          });
          this.browser = b;
          return b;
        })
        .finally(() => (this.connecting = undefined));
    }
    return this.connecting;
  }

  /** The connection — `protected` so an offline test can hand in a fake. */
  protected async launch(): Promise<Browser> {
    const { wsUrl, wsPath, cdpUrl, executablePath, channel } = this.opts;
    const { chromium } = await import("playwright-core");
    if (cdpUrl) return chromium.connectOverCDP(cdpUrl, { timeout: 30_000 });
    if (wsUrl) return chromium.connect(`${wsUrl.replace(/\/+$/, "")}/${(wsPath ?? "").replace(/^\/+/, "")}`, { timeout: 30_000 });
    try {
      return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: channel ?? "chrome" }) });
    } catch (err) {
      throw new Error(`browser: BROWSER_WS_URL is not set and no local Chrome could be launched: ${message(err)}`);
    }
  }

  private live(runId: string): Session {
    const key = this.keyOf(runId);
    const run = this.runs.get(key);
    if (run?.exhausted) throw new Error(`browser: this run's browser budget (${this.runBudgetMs} ms) is spent`);
    const s = run?.session;
    if (!s) throw new Error("browser: no page for this run — call browser/open first");
    if (!this.alive(s)) {
      if (run!.kept) void this.endKept(key, true);
      else run!.session = undefined;
      throw new Error("browser: the run's page was closed (a timeout, the budget, or the browser dropped) — call browser/open to start again");
    }
    return s;
  }

  /** Run `fn` against the run's session under the per-call cap: the
   *  Playwright action gets `ms` as its own timeout (a clean error), and a
   *  hard race a little longer than that closes the context — what aborts a
   *  `screenshot` or `evaluate` stuck on a wedged main thread. */
  private async call<T>(
    runId: string,
    verb: string,
    timeoutMs: number | undefined,
    fn: (s: Session, ms: number) => Promise<T>,
    extraMs = 0,
  ): Promise<T> {
    const s = this.live(runId);
    const key = this.keyOf(runId);
    const run = this.runs.get(key)!;
    // A kept page's idle clock waits while a call is in flight.
    if (run.kept) {
      run.kept.busy++;
      this.idle(key, run);
    }
    const ms = timeoutMs ?? this.stepTimeoutMs;
    const lost = Symbol("timeout");
    let timer: NodeJS.Timeout | undefined;
    const race = new Promise<typeof lost>((r) => (timer = setTimeout(() => r(lost), ms + this.settleSlackMs + Math.max(0, extraMs))));
    const work = fn(s, ms);
    work.catch(() => {}); // the loser of the race must not surface as unhandled
    try {
      const out = await Promise.race([work, race]);
      if (out === lost) {
        await this.closeSession(key);
        throw new Error(`browser/${verb}: timed out after ${ms} ms; the run's browser context was closed — call browser/open to start again`);
      }
      return out as T;
    } catch (err) {
      const m = strictHint(message(err));
      throw new Error(m.startsWith("browser") || m.startsWith("capture:") ? m : `browser/${verb}: ${m}`);
    } finally {
      clearTimeout(timer);
      if (run.kept) {
        run.kept.busy--;
        this.idle(key, run);
      }
    }
  }

  /** The denylist on the landed URL (redirects). */
  private async landed(s: Session): Promise<void> {
    const url = s.page.url();
    const reason = denyReason(url, this.rules);
    if (!reason) return;
    await s.page.goto("about:blank").catch(() => {});
    throw new Error(`browser: refused, the page landed on ${url}: ${reason}`);
  }

  /** Close the session under `key`: a run's (it stays known, its budget
   *  clock running) or a kept page's, which ends (`endKept`). */
  private async closeSession(key: string): Promise<void> {
    const run = this.runs.get(key);
    if (run?.kept) return this.endKept(key, true);
    const s = run?.session;
    if (!s) return;
    run!.session = undefined;
    await closeQuietly(s);
  }
}

/** Each expectation against the page as it is. A missing text or element
 *  is a result; a selector or script that cannot be evaluated is the
 *  check's own fault, and throws. */
async function expectationsOn(page: Page, expect: VerifyExpect, errors: string[]): Promise<Expectation[]> {
  const out: Expectation[] = [];
  for (const t of expect.text ?? []) {
    const n = await page.getByText(t).filter({ visible: true }).count();
    out.push({ label: `text ${JSON.stringify(t)}`, holds: n > 0, ...(n ? {} : { detail: "not visible" }) });
  }
  if (expect.url !== undefined) {
    const at = page.url();
    const holds = urlMatches(at, expect.url);
    out.push({ label: `url ${expect.url}`, holds, ...(holds ? {} : { detail: `the page is at ${at}` }) });
  }
  for (const sel of expect.selector ?? []) {
    let n: number;
    try {
      n = await page.locator(sel).count();
    } catch (err) {
      throw new Error(`selector ${JSON.stringify(sel)} cannot be evaluated: ${message(err)}`);
    }
    out.push({ label: `selector ${sel}`, holds: n > 0, ...(n ? {} : { detail: "matches nothing" }) });
  }
  if (expect.noErrors) {
    const holds = errors.length === 0;
    out.push({ label: "no errors", holds, ...(holds ? {} : { detail: `${errors.length} on the page, first ${errors[0]}` }) });
  }
  if (expect.evaluate !== undefined) {
    try {
      const v: unknown = await page.evaluate(expect.evaluate);
      out.push({ label: "evaluate", holds: Boolean(v), ...(v ? {} : { detail: `${JSON.stringify(v ?? null)} is not truthy` }) });
    } catch (err) {
      const m = message(err);
      if (/SyntaxError/.test(m)) throw new Error(`evaluate does not parse: ${m}`);
      out.push({ label: "evaluate", holds: false, detail: `threw ${m.split("\n")[0]}` });
    }
  }
  return out;
}

export function flattenObs(o: Observations): string[] {
  return [
    ...o.console.map((s) => `console: ${s}`),
    ...o.pageErrors.map((s) => `pageerror: ${s}`),
    ...o.failedRequests.map((s) => `request failed: ${s}`),
    ...o.httpErrors.map((s) => `http: ${s}`),
  ].slice(-40);
}

function emptyObs(): Observations {
  return { console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
}

/** The run's own context goes as a whole; in a shared (CDP) context only
 *  the run's pages go — the human's tabs and the other runs' pages stay. */
async function closeQuietly(s: Session | undefined): Promise<void> {
  if (!s) return;
  if (s.own) await s.context.close().catch(() => {});
  else await Promise.all(s.pages.map((p) => p.close().catch(() => {})));
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** An offset into a box `size` long, kept off its far edge (a click AT the
 *  edge is outside the element). */
function within(at: number, size: number): number {
  return Math.min(Math.max(0, at), Math.max(0, size - 1));
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… (truncated at ${n} chars)` : s;
}

function message(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 600 ? `${m.slice(0, 600)}…` : m;
}

/** Playwright's strict-mode error lists the matches but not the way out; a
 *  model that reached for a selector retries with another broad one. */
export function strictHint(m: string): string {
  if (!m.includes("strict mode violation")) return m;
  return `${m.split("\nCall log:")[0]!.trimEnd()}\n→ act by ref instead: browser/snapshot, then the element's [ref=eN] (or narrow the selector, e.g. \`>> nth=1\`)`;
}

/**
 * A declared list (`capture`, `verify`, `walkthrough`), checked before
 * anything runs: each verb known, each step given what its verb needs
 * (`STEP_NEEDS`). A wrong list throws — the author's fault, like a selector
 * that does not parse — so no page opens and no recording starts.
 */
export function checkSteps(steps: readonly CaptureStep[], label: string): void {
  for (const [i, s] of steps.entries()) {
    if (!(CAPTURE_VERBS as readonly string[]).includes(s.do)) {
      throw new Error(`${label}: step ${i + 1}: unknown verb "${s.do}" (one of ${CAPTURE_VERBS.join(", ")})`);
    }
    const at = `${label}: step ${i + 1} (${s.do})`;
    const needs = STEP_NEEDS[s.do as CaptureVerb];
    const given = (k: string) => s[k] !== undefined && s[k] !== "";
    for (const k of needs.required ?? []) if (s[k] === undefined) throw new Error(`${at}: needs \`${k}\``);
    if (needs.oneOf && needs.oneOf.filter(given).length !== 1) {
      // `timeoutMs` alone is the classic mistake: it caps a wait, it is not one.
      const pause = s.do === "wait" && !needs.oneOf.some(given) && s["timeoutMs"] !== undefined ? ` (timeoutMs only caps a wait; a pause is { do: "wait", ms: ${s["timeoutMs"]} })` : "";
      throw new Error(`${at}: give exactly one of ${either(needs.oneOf)}${pause}`);
    }
    if (needs.atMostOne && needs.atMostOne.filter(given).length > 1) throw new Error(`${at}: give ${either(needs.atMostOne)}, not both`);
  }
}

/** `ref, selector, or y`. */
function either(keys: string[]): string {
  return keys.length < 3 ? keys.join(" or ") : `${keys.slice(0, -1).join(", ")}, or ${keys[keys.length - 1]}`;
}

/** What a wait holds for: ANY visible match. A selector that matches
 *  several elements (a list's rows) is not a strict-mode error here, and a
 *  hidden first match (a closed menu's copy) does not hold it up. Acting
 *  stays strict: clicking one of several is a guess. */
function anyVisible(loc: Locator): Locator {
  return loc.filter({ visible: true }).first();
}

function num(v: string | undefined, dflt: number): number {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`expected a positive number, got "${v}"`);
  return n;
}
