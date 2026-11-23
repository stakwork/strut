/**
 * McpBrowser: strut's browser verbs on a Browser MCP server
 * (https://github.com/getcabal/browser-mcp) reached over MCP Streamable HTTP
 * (`BROWSER_MCP_URL`, `Authorization: Bearer BROWSER_MCP_TOKEN`). The server
 * drives a visible Chromium through Browser MCP's extension: no headless
 * launch and no remote-debugging port, so a site sees an ordinary browser.
 * The container that serves it is not strut's: its operator builds it.
 *
 * Ported from conceptivehq/unblockable-browser `strut/src/browser.ts`
 * (Apache License 2.0, Copyright 2026 The unblockable-browser authors). That
 * adapter spawned the kit's stdio MCP command; this one speaks to the same
 * server over HTTP, with strut's own deny list (`BROWSER_URL_DENY`) and
 * strut's own screenshot sink.
 *
 * The server runs in window mode (`BROWSER_MCP_PAGE_ISOLATION=window`): each
 * run's page is a window of its own, every call names its tab, and the run's
 * end closes it (`dispose`).
 *
 * What differs from the Playwright service, by design or because Browser MCP
 * has no such tool:
 *   - refs come from the browser's own snapshot (`[uid=@eN]` → `[ref=eN]`);
 *     a page longer than the browser's 800 lines lists its first 800
 *     (browser/text still reads the whole page).
 *   - selectors are `text=…`, `role=…[name=…]` or CSS, found in the page;
 *     Playwright's chains and pseudo-classes are refused with that reason.
 *   - kept pages (`session`) and storageState are refused: the browser signs
 *     in with its own profile.
 *   - screenshots are the window's viewport (no fullPage or element crop).
 *   - a right click is refused; a double click is two clicks.
 *   - capture runs, but its `errors` are always empty, and its steps cannot
 *     hold keys (keydown, keyup).
 *   - observe, state, tap, keydown, keyup, captcha, verify, walkthrough, app
 *     look and keep are refused, each with why.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { bootEnv } from "../env.js";
import { parseDenyList, denyReason, type DenyRule } from "./deny.js";
import { BrowserService, type StrutBrowser } from "./service.js";
import { saveShot, type ShotSink } from "./shot.js";

type Target = { ref?: string; selector?: string };
type Navigated = { url: string; title: string; status: number };

export interface McpBrowserOptions {
  /** The server's MCP endpoint (`BROWSER_MCP_URL`), http or https. */
  url: string;
  /** Sent as `Authorization: Bearer <token>` (`BROWSER_MCP_TOKEN`). */
  token: string;
  stepTimeoutMs?: number;
  runBudgetMs?: number;
  /** `BROWSER_URL_DENY`, as the Playwright service reads it. */
  deny?: string;
  /** Tests: the pause after each action (default 150 ms) and the DOM-quiet wait (default on). */
  settle?: { fixedMs?: number; quiet?: boolean };
}

export const MCP_TREE_CAP = 100_000;
export const MCP_TEXT_CAP = 50_000;
/** The verbs a capture's steps may name: strut's capture verbs without keydown and keyup. */
export const MCP_CAPTURE_STEPS = ["goto", "click", "fill", "type", "press", "select", "hover", "scroll", "wait", "text", "evaluate", "back"] as const;
type CaptureStepVerb = (typeof MCP_CAPTURE_STEPS)[number];
/** The first new_page may wait for the browser's Chromium to start and its extension to connect. */
const FIRST_PAGE_MS = 120_000;
/** Each call's slack over its own timeout, for the round trip. */
const SLACK_MS = 5_000;
const CONNECT_MS = 30_000;
const MARK = "data-fleet-browser";

interface ToolAnswer {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

/** One MCP session with the server, opened on the first call and opened
 *  again after the server went away (a restart drops its sessions); a call
 *  the server answers 404 (the session dropped) runs once more on the new one. */
class McpConnection {
  private client?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<Client> {
    if (this.client) return this.client;
    const p = (async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const client = new Client({ name: "strut-browser", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.token}` } } });
      client.onclose = () => {
        if (this.client === p) this.client = undefined;
      };
      await client.connect(transport, { timeout: CONNECT_MS });
      return client;
    })();
    this.client = p;
    p.catch(() => {
      if (this.client === p) this.client = undefined;
    });
    return p;
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolAnswer> {
    const [{ McpError }, { StreamableHTTPError }] = await Promise.all([
      import("@modelcontextprotocol/sdk/types.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    let result: { content?: unknown; isError?: unknown };
    for (let attempt = 1; ; attempt++) {
      try {
        const client = await this.connect();
        result = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as typeof result;
        break;
      } catch (e) {
        // Not the server's own answer (a refused connection, a session the server no longer knows): the next call connects again.
        if (!(e instanceof McpError)) await this.close();
        // 404: the server dropped the session (a restart, or idle too long) before the call reached the
        // browser, so it runs once more on a new session.
        if (attempt === 1 && e instanceof StreamableHTTPError && e.code === 404) continue;
        throw new Error(`the browser's MCP server: ${message(e).replace(this.token, "***")}`);
      }
    }
    const content: any[] = Array.isArray(result?.content) ? result.content : [];
    const text = content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("\n");
    if (result?.isError) throw new Error(plainError(text.replace(/^Error:\s*/, "").split("\n")[0] || `${name} failed`));
    const images = content.filter((c) => c.type === "image" && typeof c.data === "string").map((c) => ({ data: c.data as string, mimeType: String(c.mimeType ?? "") }));
    return { text, images };
  }

  async close(): Promise<void> {
    const p = this.client;
    this.client = undefined;
    if (!p) return;
    await p.then((c) => c.close()).catch(() => {});
  }
}

interface Line {
  uid: string;
  depth: number;
  role: string;
  name: string;
}

interface Run {
  tab?: number;
  startedAt: number;
  refs: Set<string>;
  lines: Line[];
  /** performance.timeOrigin of the page the refs were read on: a new document resets them. */
  doc?: number;
}

/** The page lines every tool answers with. */
export function pageOf(text: string): { tab?: number; title: string; url: string } {
  const tab = /^Tab ID: (\d+)$/m.exec(text)?.[1];
  return { tab: tab ? Number(tab) : undefined, title: /^Title: (.*)$/m.exec(text)?.[1] ?? "", url: /^URL: (.*)$/m.exec(text)?.[1] ?? "" };
}

/** The browser's aria snapshot (`role "name" [uid=@eN]`, indented two spaces a level) as strut's tree (`- role "name"
 *  [ref=eN]`), with its lines for browser/text on a ref. */
export function treeOf(text: string): { tree: string; lines: Line[]; refs: Set<string> } {
  const out: string[] = [];
  const lines: Line[] = [];
  const refs = new Set<string>();
  // The browser indents by every DOM ancestor, the unnamed wrappers too; the tree nests by the lines it shows.
  const open: { depth: number; name: string }[] = [];
  let body = false;
  for (const raw of text.split("\n")) {
    if (!body) {
      if (/^Page changed: /.test(raw)) body = true;
      continue;
    }
    // A link's address goes under the link, as Playwright's tree has it.
    const url = /^ *\/url: (\S+)$/.exec(raw);
    if (url) {
      out.push(`${"  ".repeat(open.length)}- /url: ${url[1]}`);
      continue;
    }
    const m = /^( *)(\S+) ("(?:[^"\\]|\\.)*") \[uid=@(e\d+)\]$/.exec(raw);
    if (!m) {
      if (raw.trim()) out.push(`# ${raw.trim()}`);
      continue;
    }
    const depth = m[1]!.length / 2;
    const role = m[2]!;
    let name = "";
    try {
      name = JSON.parse(m[3]!) as string;
    } catch {
      name = m[3]!.slice(1, -1);
    }
    const uid = m[4]!;
    lines.push({ uid, depth, role, name });
    while (open.length && open[open.length - 1]!.depth >= depth) open.pop();
    const pad = "  ".repeat(open.length);
    if (role === "StaticText") {
      // A button's or link's own words come again as its text: the line above already says them.
      if (name && name !== open[open.length - 1]?.name) out.push(`${pad}- text: ${JSON.stringify(name)}`);
      continue;
    }
    refs.add(uid);
    out.push(`${pad}- ${role}${name ? ` ${JSON.stringify(name)}` : ""} [ref=${uid}]`);
    open.push({ depth, name });
  }
  return { tree: out.join("\n"), lines, refs };
}

/** The element's own name and its descendants' names, from the last snapshot. */
export function textUnder(lines: Line[], uid: string): string | undefined {
  const at = lines.findIndex((l) => l.uid === uid);
  if (at < 0) return undefined;
  const parts = [lines[at]!.name];
  for (let i = at + 1; i < lines.length && lines[i]!.depth > lines[at]!.depth; i++) parts.push(lines[i]!.name);
  return parts.filter(Boolean).join("\n");
}

/** Finds the selector's element in the page and marks it (MARK=token); answers whether it found one. Selectors:
 *  `text=Annual` (contains, any case), `text="Annual"` (exact), `role=button[name="Save"]` (contains, any case), CSS. */
export const FIND_FN = String.raw`(sel, token) => {
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const quoted = (s) => { const m = /^(["'])([\s\S]*)\1([is])?$/.exec(s.trim()); return m ? { v: m[2], exact: m[3] !== "i" } : { v: s.trim(), exact: false }; };
  const matches = (hay, q) => q.exact ? norm(hay) === norm(q.v) : norm(hay).toLowerCase().includes(norm(q.v).toLowerCase());
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const name = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" "); if (norm(t)) return t; }
    for (const v of [el.getAttribute("aria-label"), el.labels && el.labels[0] && el.labels[0].innerText, el.getAttribute("alt"), el.getAttribute("title")]) if (norm(v)) return v;
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value;
    const t = el.innerText; if (norm(t)) return t;
    return el.getAttribute("placeholder") || el.value || "";
  };
  const IMPLICIT = { button: "button,input[type=button],input[type=submit],input[type=reset],summary", link: "a[href],area[href]",
    textbox: "input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],input[type=number],textarea,[contenteditable=''],[contenteditable=true]",
    searchbox: "input[type=search]", checkbox: "input[type=checkbox]", radio: "input[type=radio]", combobox: "select", listbox: "select[multiple]",
    heading: "h1,h2,h3,h4,h5,h6", img: "img", list: "ul,ol", listitem: "li", option: "option", navigation: "nav", main: "main", dialog: "dialog", article: "article", row: "tr", cell: "td" };
  let found = null;
  const s = sel.trim();
  // Playwright's chains (a >> b), xpath and nth are refused whatever the first part is: text=… >> … is not a text.
  if (/>>|^xpath=|^nth=|^\/\//.test(s)) throw new Error("selector " + JSON.stringify(sel) + " is not supported on this browser: use text=…, role=…[name=…] or CSS");
  if (/^text=/.test(s)) {
    const q = quoted(s.slice(5));
    const all = [...document.body.querySelectorAll("*")].filter((el) => !["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName) && matches(el.innerText || "", { v: q.v, exact: false }));
    const deepest = all.filter((el) => ![...el.children].some((c) => all.includes(c)));
    found = deepest.find((el) => visible(el) && matches(el.innerText || "", q)) || deepest.find((el) => matches(el.innerText || "", q)) || null;
  } else if (/^role=/.test(s)) {
    const m = /^role=([a-z]+)(?:\[name=([\s\S]*)\])?$/.exec(s);
    if (!m) throw new Error("role selectors are role=<role> or role=<role>[name=\"…\"] on this browser");
    const css = '[role~="' + m[1] + '"]' + (IMPLICIT[m[1]] ? "," + IMPLICIT[m[1]] : "");
    const q = m[2] === undefined ? null : quoted(m[2]);
    const all = [...document.querySelectorAll(css)].filter((el) => !q || matches(name(el), q));
    found = all.find(visible) || all[0] || null;
  } else {
    const css = s.replace(/^css=/, "");
    if (/:has-text\(|:text\(|:visible|nth=|xpath=/.test(css)) throw new Error("selector " + JSON.stringify(sel) + " is not supported on this browser: use text=…, role=…[name=…] or CSS");
    const all = [...document.querySelectorAll(css)];
    found = all.find(visible) || all[0] || null;
  }
  for (const old of document.querySelectorAll("[${MARK}]")) old.removeAttribute("${MARK}");
  if (!found) return false;
  found.setAttribute("${MARK}", token);
  return true;
}`;

/** In-page: give a <select> the option whose value or visible label is `want`, as a person picking it would. */
const SELECT_FN = `(el, want) => {
  if (!el || el.tagName !== "SELECT") throw new Error("the element is not a <select>");
  const norm = (s) => String(s).replace(/\\s+/g, " ").trim();
  const opt = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => norm(o.label) === norm(want));
  if (!opt) throw new Error("no option with value or label " + JSON.stringify(want));
  el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

/** In-page: a text field's value, set the way a person's typing ends. */
const FILL_FN = `(el, value) => {
  if (!el) throw new Error("no element");
  el.focus();
  if (el.isContentEditable) { el.textContent = value; el.dispatchEvent(new InputEvent("input", { bubbles: true })); return true; }
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

const HOVER_FN = `(el) => {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o));
  return true;
}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chrome's protocol errors about an element, as Browser MCP passes them on, in words a workflow's agent can act on. */
const ELEMENT_ERRORS: Array<[RegExp, string]> = [
  [/Could not compute box model|Node does not have a layout object/i, "the element is not visible on the page (hidden, collapsed or of no size); take a new snapshot and use a visible element, or open what hides it first"],
  [/Node is detached|No node with given id|Could not find node with given id/i, "the element is no longer on the page; take a new snapshot"],
];
export function plainError(text: string): string {
  let said = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") said = (parsed as { message: string }).message;
  } catch {
    // not JSON: the text as it is
  }
  for (const [pattern, words] of ELEMENT_ERRORS) if (pattern.test(said)) return words;
  return text;
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** strut's browser verbs on a Browser MCP server over HTTP. */
export class McpBrowser implements StrutBrowser {
  private readonly conn: McpConnection;
  private readonly runs = new Map<string, Run>();
  private readonly stepTimeoutMs: number;
  private readonly runBudgetMs: number;
  private readonly rules: DenyRule[];
  private readonly fixedMs: number;
  private readonly quiet: boolean;
  private token = 0;

  constructor(opts: McpBrowserOptions) {
    let u: URL;
    try {
      u = new URL(opts.url);
    } catch {
      throw new Error(`BROWSER_MCP_URL is not a URL: ${opts.url}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("BROWSER_MCP_URL must be http or https");
    if (!opts.token) throw new Error("BROWSER_MCP_URL needs BROWSER_MCP_TOKEN: the browser's server takes no call without it");
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 15_000;
    this.runBudgetMs = opts.runBudgetMs ?? 600_000;
    this.rules = parseDenyList(opts.deny);
    this.fixedMs = opts.settle?.fixedMs ?? 150;
    this.quiet = opts.settle?.quiet ?? true;
    this.conn = new McpConnection(opts.url, opts.token);
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  /** Throws when the denylist refuses `url`. */
  check(url: string): void {
    const reason = denyReason(url, this.rules);
    if (reason) throw new Error(`browser: refused ${url}: ${reason}`);
  }

  remaining(runId: string): number {
    const run = this.runs.get(runId);
    if (!run) return this.runBudgetMs;
    return Math.max(0, this.runBudgetMs - (Date.now() - run.startedAt));
  }

  private runOf(runId: string): Run {
    let run = this.runs.get(runId);
    if (!run) {
      run = { startedAt: Date.now(), refs: new Set(), lines: [] };
      this.runs.set(runId, run);
    }
    return run;
  }

  private live(runId: string): Run & { tab: number } {
    const run = this.runs.get(runId);
    if (!run?.tab) throw new Error("browser: this run has no page — call browser/open (with a url) first");
    return run as Run & { tab: number };
  }

  private tool(name: string, args: Record<string, unknown>, ms: number): Promise<ToolAnswer> {
    return this.conn.call(name, args, ms);
  }

  private async evalIn<T = unknown>(tab: number, expression: string, ms: number): Promise<T> {
    const { text } = await this.tool("evaluate", { tabId: tab, expression: `JSON.stringify(${expression})` }, ms);
    return (text === "" || text === "undefined" ? undefined : JSON.parse(text)) as T;
  }

  /** One verb: the run's budget, the call's own timeout, and strut's error form (`browser/<verb>: …`). */
  private async call<T>(runId: string, verb: string, timeoutMs: number | undefined, fn: (ms: number) => Promise<T>, extraMs = 0): Promise<T> {
    if (this.runs.has(runId) && this.remaining(runId) <= 0) throw new Error(`browser/${verb}: the run's browser budget is spent`);
    const ms = timeoutMs ?? this.stepTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const lost = Symbol("timeout");
    const race = new Promise<typeof lost>((r) => (timer = setTimeout(() => r(lost), ms + SLACK_MS + Math.max(0, extraMs))));
    const work = fn(ms);
    work.catch(() => {});
    try {
      const out = await Promise.race([work, race]);
      if (out === lost) throw new Error(`timed out after ${ms} ms`);
      return out as T;
    } catch (e) {
      const m = message(e);
      throw new Error(m.startsWith("browser") ? m : `browser/${verb}: ${m}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** After an action: the network quiet for a moment (bounded), then a short fixed pause. */
  private async settle(tab: number, extraMs = 0): Promise<void> {
    if (this.quiet) await this.tool("wait_for_network_idle", { tabId: tab, idleMs: 300, timeout: 3_000 }, 3_000 + SLACK_MS).catch(() => {});
    await sleep(this.fixedMs + Math.max(0, extraMs));
  }

  /** Where the page is now; refuses (and closes) a page that landed on a denied address; a new document resets the refs. */
  private async landed(runId: string, run: Run & { tab: number }): Promise<{ url: string; title: string }> {
    const at = await this.evalIn<[string, number, string]>(run.tab, "[location.href, performance.timeOrigin, document.title]", this.stepTimeoutMs);
    const [url, doc, title] = at ?? ["", 0, ""];
    try {
      this.check(url);
    } catch (e) {
      await this.closeRun(runId).catch(() => {});
      throw new Error(`browser: refused, the page landed on ${url}: ${message(e).replace(/^browser: refused \S+: /, "")}`);
    }
    if (run.doc !== doc) {
      run.doc = doc;
      run.refs = new Set();
      run.lines = [];
    }
    return { url, title };
  }

  private async status(tab: number): Promise<number> {
    const s = await this.evalIn<number>(tab, "(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0", this.stepTimeoutMs).catch(() => 0);
    return typeof s === "number" ? s : 0;
  }

  private uid(run: Run, ref: string): string {
    const r = ref.replace(/^@|^ref=/, "");
    if (!run.refs.has(r)) throw new Error(`browser: unknown ref "${r}" — call browser/snapshot first (refs reset on every navigation)`);
    return `@${r}`;
  }

  /** Marks the selector's element; answers the CSS that names it. */
  private async find(tab: number, selector: string, ms: number): Promise<string> {
    const token = `t${++this.token}`;
    const ok = await this.evalIn<boolean>(tab, `(${FIND_FN})(${JSON.stringify(selector)}, ${JSON.stringify(token)})`, ms);
    if (!ok) throw new Error(`no element matches ${JSON.stringify(selector)}`);
    return `[${MARK}="${token}"]`;
  }

  private target(input: Target): "ref" | "selector" {
    if (input.ref && input.selector) throw new Error("browser: give ref OR selector, not both");
    if (input.ref) return "ref";
    if (input.selector) return "selector";
    throw new Error("browser: give exactly one of ref or selector");
  }

  /** Focuses a ref's element (press_key focuses its index before the key; Shift alone types nothing). */
  private async focusRef(tab: number, uid: string, ms: number): Promise<void> {
    await this.tool("press_key", { tabId: tab, index: Number(uid.replace("@e", "")), keys: "Shift" }, ms);
  }

  // ── The verbs ─────────────────────────────────────────────────────────────

  async open(
    runId: string,
    input: { url?: string; viewport?: unknown; storageState?: unknown; timeoutMs?: number; session?: unknown } = {},
  ): Promise<Navigated & { resumed: boolean }> {
    if (input.session) throw refused("open", "a kept page (session) is not available");
    if (input.storageState) throw refused("open", "storageState is not used: the browser signs in with its own profile");
    if (input.url) this.check(input.url);
    const resumed = !!this.runs.get(runId)?.tab;
    this.runOf(runId);
    if (input.url) return { ...(await this.goto(runId, { url: input.url, timeoutMs: input.timeoutMs })), resumed };
    if (resumed) {
      const run = this.live(runId);
      return { ...(await this.call(runId, "open", input.timeoutMs, () => this.landed(runId, run))), status: 0, resumed };
    }
    return { url: "about:blank", title: "", status: 0, resumed };
  }

  async goto(runId: string, input: { url: string; wait?: number; timeoutMs?: number }): Promise<Navigated> {
    this.check(input.url);
    const run = this.runOf(runId);
    return this.call(
      runId,
      "goto",
      input.timeoutMs,
      async (ms) => {
        if (!run.tab) {
          const { text } = await this.tool("new_page", { url: input.url }, Math.max(ms, FIRST_PAGE_MS));
          const tab = pageOf(text).tab;
          if (!tab) throw new Error("the browser opened no page");
          run.tab = tab;
        } else {
          await this.tool("navigate_page", { pageId: run.tab, type: "url", url: input.url, timeoutMs: ms }, ms + SLACK_MS);
        }
        const live = run as Run & { tab: number };
        await this.settle(live.tab, input.wait);
        const at = await this.landed(runId, live);
        return { ...at, status: await this.status(live.tab) };
      },
      FIRST_PAGE_MS + (input.wait ?? 0),
    );
  }

  async snapshot(runId: string): Promise<{ url: string; title: string; tree: string }> {
    const run = this.live(runId);
    return this.call(runId, "snapshot", undefined, async (ms) => {
      const { text } = await this.tool("take_snapshot", { pageId: run.tab, format: "aria", compact: true }, ms);
      const page = pageOf(text);
      const { tree, lines, refs } = treeOf(text);
      run.refs = refs;
      run.lines = lines;
      run.doc = (await this.evalIn<number>(run.tab, "performance.timeOrigin", ms).catch(() => run.doc)) ?? run.doc;
      return { url: page.url, title: page.title, tree: tree.length > MCP_TREE_CAP ? tree.slice(0, MCP_TREE_CAP) : tree };
    });
  }

  async text(runId: string, input: Target & { timeoutMs?: number } = {}): Promise<{ text: string }> {
    const run = this.live(runId);
    return this.call(runId, "text", input.timeoutMs, async (ms) => {
      let text: string;
      if (input.ref) {
        const uid = this.uid(run, input.ref).slice(1);
        text = textUnder(run.lines, uid) ?? "";
      } else if (input.selector) {
        const css = await this.find(run.tab, input.selector, ms);
        text = (await this.evalIn<string>(run.tab, `document.querySelector(${JSON.stringify(css)}).innerText`, ms)) ?? "";
      } else {
        text = (await this.tool("get_text", { tabId: run.tab }, ms)).text;
      }
      return { text: text.length > MCP_TEXT_CAP ? text.slice(0, MCP_TEXT_CAP) : text };
    });
  }

  async click(runId: string, input: Target & { button?: "left" | "right" | "middle"; double?: boolean; timeoutMs?: number }): Promise<{ url: string }> {
    const run = this.live(runId);
    if (input.button && input.button !== "left") throw refused("click", `a ${input.button} click is not available`);
    return this.call(runId, "click", input.timeoutMs, async (ms) => {
      const times = input.double ? 2 : 1;
      if (this.target(input) === "ref") {
        const uid = this.uid(run, input.ref!);
        for (let i = 0; i < times; i++) await this.tool("click", { tabId: run.tab, uid }, ms);
      } else {
        const css = await this.find(run.tab, input.selector!, ms);
        // drag from the element to itself: a real press and release at its centre, i.e. a click.
        for (let i = 0; i < times; i++) await this.tool("drag", { tabId: run.tab, source: css, target: css, duration: 50 }, ms);
      }
      await this.settle(run.tab);
      return { url: (await this.landed(runId, run)).url };
    });
  }

  async fill(runId: string, input: Target & { value: string; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "fill", input.timeoutMs, async (ms) => {
      if (this.target(input) === "ref") await this.tool("fill", { tabId: run.tab, uid: this.uid(run, input.ref!), value: input.value }, ms);
      else {
        const css = await this.find(run.tab, input.selector!, ms);
        await this.evalIn(run.tab, `(${FILL_FN})(document.querySelector(${JSON.stringify(css)}), ${JSON.stringify(input.value)})`, ms);
      }
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async type(runId: string, input: { text: string; delay?: number; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "type", input.timeoutMs, async (ms) => {
      await this.tool("type_text", { tabId: run.tab, text: input.text }, ms);
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async press(runId: string, input: { key: string; timeoutMs?: number }): Promise<{ url: string }> {
    const run = this.live(runId);
    return this.call(runId, "press", input.timeoutMs, async (ms) => {
      await this.tool("press_key", { tabId: run.tab, keys: input.key }, ms);
      await this.settle(run.tab);
      return { url: (await this.landed(runId, run)).url };
    });
  }

  async select(runId: string, input: Target & { value: string; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "select", input.timeoutMs, async (ms) => {
      let el: string;
      if (this.target(input) === "ref") {
        await this.focusRef(run.tab, this.uid(run, input.ref!), ms);
        el = "document.activeElement";
      } else el = `document.querySelector(${JSON.stringify(await this.find(run.tab, input.selector!, ms))})`;
      await this.evalIn(run.tab, `(${SELECT_FN})(${el}, ${JSON.stringify(input.value)})`, ms);
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async hover(runId: string, input: Target & { timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "hover", input.timeoutMs, async (ms) => {
      if (this.target(input) === "ref") await this.tool("hover", { tabId: run.tab, index: Number(this.uid(run, input.ref!).replace("@e", "")), duration: 300 }, ms);
      else {
        const css = await this.find(run.tab, input.selector!, ms);
        await this.evalIn(run.tab, `(${HOVER_FN})(document.querySelector(${JSON.stringify(css)}))`, ms);
      }
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async scroll(runId: string, input: Target & { y?: number; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "scroll", input.timeoutMs, async (ms) => {
      if (input.ref && !input.selector) {
        // hover scrolls its element into view first, then rests the pointer on it briefly.
        await this.tool("hover", { tabId: run.tab, index: Number(this.uid(run, input.ref).replace("@e", "")), duration: 100 }, ms);
      } else if (input.selector && !input.ref) {
        const css = await this.find(run.tab, input.selector, ms);
        await this.evalIn(run.tab, `document.querySelector(${JSON.stringify(css)}).scrollIntoView({ block: "center" })`, ms);
      } else if (typeof input.y === "number" && !input.ref && !input.selector) {
        await this.evalIn(run.tab, `window.scrollBy(0, ${Math.trunc(input.y)})`, ms);
      } else throw new Error("give ref, selector, or y");
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async back(runId: string, input: { timeoutMs?: number } = {}): Promise<{ url: string; title: string }> {
    const run = this.live(runId);
    return this.call(runId, "back", input.timeoutMs, async (ms) => {
      await this.tool("navigate_page", { pageId: run.tab, type: "back", timeoutMs: ms }, ms + SLACK_MS);
      await this.settle(run.tab);
      return this.landed(runId, run);
    });
  }

  /** Its cap is the run's remaining budget, as in the Playwright service: outlasting a slow page is its job. */
  async wait(runId: string, input: Target & { text?: string; url?: string; ms?: number; timeoutMs?: number }): Promise<{ ok: true; waitedMs: number }> {
    const run = this.live(runId);
    const budget = input.timeoutMs ?? this.remaining(runId);
    return this.call(runId, "wait", budget, async (ms) => {
      const t0 = Date.now();
      const until = async (tool: string, args: Record<string, unknown>, what: string) => {
        for (;;) {
          const left = ms - (Date.now() - t0);
          if (left <= 0) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
          const slice = Math.min(left, 60_000);
          try {
            await this.tool(tool, { tabId: run.tab, ...args, timeout: slice }, slice + SLACK_MS);
            return;
          } catch (e) {
            if (!/Timed out/i.test(message(e))) throw e;
          }
        }
      };
      const condition = (expression: string, what: string) => until("wait_for_condition", { expression, pollMs: 250 }, what);
      if (typeof input.ms === "number") await sleep(Math.min(input.ms, ms));
      else if (input.text) {
        const want = JSON.stringify(input.text.toLowerCase());
        await condition(`document.body && document.body.innerText.toLowerCase().includes(${want})`, `text ${JSON.stringify(input.text)}`);
      } else if (input.url) {
        // contains, or a glob with * (anchored), as the browser's wait_for_url reads it.
        await until("wait_for_url", { pattern: input.url }, `URL ${JSON.stringify(input.url)}`);
      } else if (input.ref) this.uid(run, input.ref);
      else if (input.selector) {
        const token = `t${++this.token}`;
        await condition(`(${FIND_FN})(${JSON.stringify(input.selector)}, ${JSON.stringify(token)})`, JSON.stringify(input.selector));
      } else throw new Error("give ref, selector, text, url, or ms");
      return { ok: true as const, waitedMs: Date.now() - t0 };
    });
  }

  /** The window's viewport to shots/NNN.png (strut's sink), with the 0.6× copy for the model. */
  async screenshot(runId: string, input: Target & { fullPage?: boolean; name?: string; timeoutMs?: number }, sink: ShotSink) {
    const run = this.live(runId);
    return this.call(runId, "screenshot", input.timeoutMs, async (ms) => {
      // quality 90 is the browser's PNG; maxWidth past the window keeps the frame at its CSS size.
      const { images } = await this.tool("take_screenshot", { tabId: run.tab, quality: 90, detail: "high", maxWidth: 8_192 }, ms);
      const image = images[0];
      if (!image) throw new Error("the browser answered no image");
      let png = Buffer.from(image.data, "base64");
      if (image.mimeType !== "image/png") {
        const { default: sharp } = await import("sharp");
        png = await sharp(png).png().toBuffer();
      }
      return saveShot(sink, png, input.name);
    });
  }

  async closeRun(runId: string): Promise<{ ok: true }> {
    const run = this.runs.get(runId);
    if (run?.tab) {
      const tab = run.tab;
      run.tab = undefined;
      run.refs = new Set();
      run.lines = [];
      await this.tool("close_page", { pageId: tab }, this.stepTimeoutMs).catch(() => {});
    }
    return { ok: true };
  }

  async closeKept(_job: string, _name: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  /**
   * JavaScript in the run's page, never in this host, as the Playwright service runs it: an expression, or a
   * function that is called with no arguments; a promise is awaited. The answer is its JSON (undefined is null),
   * cut at MCP_TEXT_CAP characters with `truncated`. A page the script sends to a denied address is closed.
   */
  async evaluate(runId: string, input: { expression: string; timeoutMs?: number }): Promise<{ result: unknown; truncated?: true }> {
    const run = this.live(runId);
    return this.call(runId, "evaluate", input.timeoutMs, async (ms) => {
      // The newline lets an expression end in a // comment.
      const expression = `(async () => { const v = (${input.expression}\n); const r = typeof v === "function" ? await v() : await v; return JSON.stringify(r ?? null) ?? "null"; })()`;
      const { text } = await this.tool("evaluate", { tabId: run.tab, expression }, ms);
      await this.landed(runId, run);
      if (text.length <= MCP_TEXT_CAP) return { result: JSON.parse(text) as unknown };
      return { result: text.slice(0, MCP_TEXT_CAP), truncated: true as const };
    });
  }

  /**
   * strut's capture: open the url, run the declared steps, settle (`wait` more milliseconds), and photograph the
   * window. The list is checked before anything opens; a step that fails fails the capture, naming the step.
   * `errors` is always empty: this browser collects no console or network errors (`observe`).
   */
  async capture(runId: string, input: Parameters<StrutBrowser["capture"]>[1], sink: ShotSink): ReturnType<StrutBrowser["capture"]> {
    const steps = input.steps ?? [];
    for (const [i, s] of steps.entries()) {
      if ((MCP_CAPTURE_STEPS as readonly string[]).includes(s.do)) continue;
      const why = s.do === "keydown" || s.do === "keyup" ? `"${s.do}" is not available on this browser (use press)` : `unknown verb "${s.do}" (one of ${MCP_CAPTURE_STEPS.join(", ")})`;
      throw new Error(`capture: step ${i + 1}: ${why}`);
    }
    await this.open(runId, { url: input.url, timeoutMs: input.timeoutMs });
    const verbs = this as unknown as Record<CaptureStepVerb, (runId: string, args: unknown) => Promise<unknown>>;
    for (const [i, { do: verb, ...args }] of steps.entries()) {
      try {
        await verbs[verb as CaptureStepVerb].call(this, runId, args);
      } catch (e) {
        throw new Error(`capture: step ${i + 1} (${verb} ${JSON.stringify(args)}) failed: ${message(e)}`);
      }
    }
    const run = this.live(runId);
    await this.settle(run.tab, input.wait);
    const shot = await this.screenshot(runId, { fullPage: input.fullPage, timeoutMs: input.timeoutMs }, sink);
    const at = await this.landed(runId, run);
    return { ...shot, errors: [], pageUrl: at.url, title: at.title };
  }

  // ── Verbs this browser refuses ────────────────────────────────────────────

  observe(..._: Parameters<StrutBrowser["observe"]>): ReturnType<StrutBrowser["observe"]> {
    throw refused("observe", "console and network observations are not collected");
  }

  async state(..._: Parameters<StrutBrowser["state"]>): ReturnType<StrutBrowser["state"]> {
    throw refused("state", "the profile keeps its own cookies; no storage state is exported");
  }

  async tap(..._: Parameters<StrutBrowser["tap"]>): ReturnType<StrutBrowser["tap"]> {
    throw refused("tap", "use browser/click");
  }

  async keydown(..._: Parameters<StrutBrowser["keydown"]>): ReturnType<StrutBrowser["keydown"]> {
    throw refused("keydown", "use browser/press");
  }

  async keyup(..._: Parameters<StrutBrowser["keyup"]>): ReturnType<StrutBrowser["keyup"]> {
    throw refused("keyup", "use browser/press");
  }

  async captcha(..._: Parameters<StrutBrowser["captcha"]>): ReturnType<StrutBrowser["captcha"]> {
    throw refused("captcha", "a human check is reported as blocked, and a person answers it on the browser's own screen");
  }

  async verify(..._: Parameters<StrutBrowser["verify"]>): ReturnType<StrutBrowser["verify"]> {
    throw refused("verify", "a signed-out check session needs the Playwright browser");
  }

  async walkthrough(..._: Parameters<StrutBrowser["walkthrough"]>): ReturnType<StrutBrowser["walkthrough"]> {
    throw refused("walkthrough", "a recorded walkthrough needs the Playwright browser");
  }

  async lookAtApp(..._: Parameters<StrutBrowser["lookAtApp"]>): ReturnType<StrutBrowser["lookAtApp"]> {
    throw refused("look", "an app's page is served in process to the Playwright browser only");
  }

  async keep(..._: Parameters<StrutBrowser["keep"]>): ReturnType<StrutBrowser["keep"]> {
    throw refused("keep", "a kept page (session) is not available");
  }

  /** The run's window closes when the run ends. */
  async dispose(runId: string): Promise<void> {
    await this.closeRun(runId);
    this.runs.delete(runId);
  }

  /** Every run's window, then the MCP session. The browser itself keeps running: it is its container's. */
  async close(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.dispose(id).catch(() => {});
    await this.conn.close();
  }
}

/** strut's error form for a verb this browser refuses (`browser/<verb>: …`). */
function refused(verb: string, why: string): Error {
  return new Error(`browser/${verb}: not available on the Browser MCP browser (${why})`);
}

/** The browser `createStrut` builds when the host brought none: a Browser
 *  MCP server when `BROWSER_MCP_URL` is set, else strut's Playwright
 *  service (`BrowserService.fromEnv`). Throws on a bad combination; the
 *  caller turns that into a boot warning. */
export function browserFromEnv(env: Record<string, string | undefined> = bootEnv()): StrutBrowser & { close(): Promise<void> } {
  const url = env["BROWSER_MCP_URL"];
  if (!url) return BrowserService.fromEnv(env);
  if (env["BROWSER_WS_URL"] || env["BROWSER_CDP_URL"]) {
    throw new Error("browser: set BROWSER_MCP_URL (a Browser MCP server) or BROWSER_WS_URL / BROWSER_CDP_URL, not both");
  }
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return new McpBrowser({
    url,
    token: env["BROWSER_MCP_TOKEN"] ?? "",
    stepTimeoutMs: num(env["BROWSER_STEP_TIMEOUT_MS"], 15_000),
    runBudgetMs: num(env["BROWSER_RUN_BUDGET_MS"], 600_000),
    deny: env["BROWSER_URL_DENY"],
  });
}
