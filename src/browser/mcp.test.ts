import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standInMcp, type StandInMcp, type StandInTool } from "../test-util/mcp-server.js";
import { BrowserService } from "./service.js";
import { McpBrowser, browserFromEnv, pageOf, treeOf } from "./mcp.js";

/** A stand-in Browser MCP server: one page, answering the tools McpBrowser
 *  calls in Browser MCP's own text forms (modelled on unblockable-browser's
 *  test/fixtures/fake-browser.mjs). */
function fakeBrowserTools(): StandInTool[] {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const page = { tab: 0, url: "", title: "", doc: 1 };
  let tabs = 0;
  const lines = () => `Tab ID: ${page.tab}\nTitle: ${page.title}\nURL: ${page.url}`;
  const go = (url: string) => {
    // "redirect-private" lands on a private address, as a redirect would.
    page.url = url.includes("redirect-private") ? "http://10.0.0.5/inside" : url;
    page.title = `Title of ${new URL(page.url).pathname}`;
    page.doc += 1;
  };
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  const answers: Record<string, (a: Record<string, any>) => unknown> = {
    new_page: (a) => {
      tabs += 1;
      page.tab = 100 + tabs;
      go(String(a.url));
      return text(`Opened new page in its own window 9, not brought to the front\n${lines()}`);
    },
    navigate_page: (a) => {
      if (a.type === "url") go(String(a.url));
      else if (a.type === "back") go("https://example.com/before");
      return text(`Navigated page ${a.pageId} (${a.type})\n${lines()}`);
    },
    take_snapshot: () =>
      text(
        `${lines()}\nFormat: aria\nPage changed: true\n` +
          'RootWebArea "Home" [uid=@e1]\n  navigation "" [uid=@e2]\n    link "Pricing" [uid=@e3]\n      /url: https://example.com/pricing\n  main "" [uid=@e4]\n' +
          '    heading "Plans" [uid=@e5]\n      StaticText "Plans" [uid=@e6]\n    combobox "Billing" [uid=@e7]\n    button "Go" [uid=@e8]',
      ),
    evaluate: (a) => {
      const e = String(a.expression);
      if (e.includes("location.href, performance.timeOrigin")) return text(JSON.stringify([page.url, page.doc, page.title]));
      if (e.includes("responseStatus")) return text("200");
      if (e.includes("performance.timeOrigin")) return text(String(page.doc));
      return text("true");
    },
    get_text: () => text("Hello from the page"),
    take_screenshot: () => ({ content: [{ type: "image", mimeType: "image/png", data: PNG }] }),
    close_page: (a) => text(`Closed page ${a.pageId}`),
  };
  for (const name of ["click", "fill", "press_key", "hover", "drag", "type_text", "wait_for_network_idle", "wait_for_condition", "wait_for_url"]) answers[name] = () => text("ok");
  return Object.entries(answers).map(([name, call]) => ({ name, call }));
}

describe("browserFromEnv: which browser createStrut builds", () => {
  it("is the Playwright service without BROWSER_MCP_URL", () => {
    assert.ok(browserFromEnv({}) instanceof BrowserService);
  });
  it("is a Browser MCP server with BROWSER_MCP_URL and BROWSER_MCP_TOKEN", () => {
    assert.ok(browserFromEnv({ BROWSER_MCP_URL: "http://browser-mcp:3000/mcp", BROWSER_MCP_TOKEN: "t" }) instanceof McpBrowser);
  });
  it("refuses the URL without a token", () => {
    assert.throws(() => browserFromEnv({ BROWSER_MCP_URL: "http://browser-mcp:3000/mcp" }), /BROWSER_MCP_TOKEN/);
  });
  it("refuses BROWSER_MCP_URL beside a Playwright server or a CDP Chrome", () => {
    const mcp = { BROWSER_MCP_URL: "http://browser-mcp:3000/mcp", BROWSER_MCP_TOKEN: "t" };
    assert.throws(() => browserFromEnv({ ...mcp, BROWSER_WS_URL: "ws://browser:3000" }), /not both/);
    assert.throws(() => browserFromEnv({ ...mcp, BROWSER_CDP_URL: "http://chrome:9222" }), /not both/);
  });
  it("refuses a URL that is not http or https", () => {
    assert.throws(() => browserFromEnv({ BROWSER_MCP_URL: "ws://browser-mcp:3000", BROWSER_MCP_TOKEN: "t" }), /http or https/);
  });
});

describe("McpBrowser: strut's verbs on a Browser MCP server over HTTP", () => {
  let server: StandInMcp;
  let browser: McpBrowser;
  let dir: string;
  const named = (name: string) => server.calls.filter((c) => c.name === name);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-browser-"));
    server = await standInMcp(fakeBrowserTools(), { token: "s3cret" });
    browser = new McpBrowser({ url: server.url, token: "s3cret", deny: "file:,169.254.0.0/16,10.0.0.0/8", settle: { fixedMs: 0, quiet: false } });
  });
  after(async () => {
    await browser.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("opens each run's page as a window, sending the token on every call", async () => {
    const out = await browser.open("run-1", { url: "https://example.com/pricing" });
    assert.deepEqual(out, { url: "https://example.com/pricing", title: "Title of /pricing", status: 200, resumed: false });
    assert.equal(named("new_page")[0]!.args.url, "https://example.com/pricing");
    assert.ok(server.calls.every((c) => c.authorization === "Bearer s3cret"));
    const again = await browser.open("run-1", { url: "https://example.com/next" });
    assert.equal(again.resumed, true);
    assert.equal(named("new_page").length, 1, "the run keeps its one page");
    assert.equal(named("navigate_page").at(-1)!.args.url, "https://example.com/next");
  });

  it("refuses denied addresses before and after a navigation, closing a page that landed inside", async () => {
    await assert.rejects(browser.open("run-2", { url: "http://169.254.169.254/latest" }), /refused/);
    await assert.rejects(browser.goto("run-1", { url: "file:///etc/passwd" }), /refused/);
    const closed = named("close_page").length;
    await assert.rejects(browser.goto("run-1", { url: "https://example.com/redirect-private" }), /landed on http:\/\/10\.0\.0\.5/);
    assert.equal(named("close_page").length, closed + 1);
    await assert.rejects(browser.snapshot("run-1"), /call browser\/open/);
  });

  it("answers strut's snapshot tree and clicks by its refs", async () => {
    await browser.open("run-3", { url: "https://example.com/" });
    const snap = await browser.snapshot("run-3");
    assert.equal(
      snap.tree,
      [
        '- RootWebArea "Home" [ref=e1]',
        "  - navigation [ref=e2]",
        '    - link "Pricing" [ref=e3]',
        "      - /url: https://example.com/pricing",
        "  - main [ref=e4]",
        '    - heading "Plans" [ref=e5]',
        '    - combobox "Billing" [ref=e7]',
        '    - button "Go" [ref=e8]',
      ].join("\n"),
    );
    await browser.click("run-3", { ref: "e8" });
    const click = named("click").at(-1)!;
    assert.equal(click.args.uid, "@e8");
    assert.equal(typeof click.args.tabId, "number");
    await assert.rejects(browser.click("run-3", { ref: "e99" }), /unknown ref "e99"/);
    await assert.rejects(browser.click("run-3", { ref: "e8", button: "right" }), /not available/);
  });

  it("saves a screenshot to the run's artifacts", async () => {
    const files = new Map<string, Buffer>();
    const sink = {
      runId: "run-3",
      artifacts: { write: async (_r: string, p: string, d: Buffer) => void files.set(p, d), list: async () => [...files.keys()], dir: async () => dir },
    } as any;
    const shot = await browser.screenshot("run-3", {}, sink);
    assert.equal(shot.path, "shots/001.png");
    assert.ok(files.has("shots/001.png"));
    assert.equal(shot.width, 1);
  });

  it("refuses the verbs it cannot do, saying why", async () => {
    await assert.rejects(browser.open("run-4", { url: "https://example.com/", session: "s" }), /kept page/);
    await assert.rejects(browser.captcha("run-3" as never, {} as never, {} as never), /browser\/captcha: not available/);
  });

  it("closes the run's window when the run ends", async () => {
    const before = named("close_page").length;
    const tab = (await browser.open("run-5", { url: "https://example.com/" })) && named("new_page").length;
    await browser.dispose("run-5");
    assert.equal(named("close_page").length, before + 1);
    assert.equal(named("close_page").at(-1)!.args.pageId, 100 + tab);
    await assert.rejects(browser.snapshot("run-5"), /call browser\/open/);
  });

  it("fails a call with a wrong token without echoing it", async () => {
    const wrong = new McpBrowser({ url: server.url, token: "nope-token", settle: { fixedMs: 0, quiet: false } });
    try {
      const err = await wrong.open("run-6", { url: "https://example.com/" }).catch((e: Error) => e);
      assert.ok(err instanceof Error);
      assert.match(err.message, /browser\/goto: the browser's MCP server/);
      assert.doesNotMatch(err.message, /nope-token/);
    } finally {
      await wrong.close();
    }
  });

  it("runs a call once more on a new session when the server dropped its own", async () => {
    const stateful = await standInMcp(fakeBrowserTools(), { token: "s3cret", sessions: true });
    const b = new McpBrowser({ url: stateful.url, token: "s3cret", settle: { fixedMs: 0, quiet: false } });
    try {
      await b.open("run-7", { url: "https://example.com/" });
      stateful.dropSessions(); // a restart, or the server's idle limit
      const snap = await b.snapshot("run-7");
      assert.match(snap.tree, /link "Pricing"/);
      assert.equal(stateful.calls.filter((c) => c.name === "take_snapshot").length, 1, "the refused call never reached the browser");
    } finally {
      await b.close();
      await stateful.close();
    }
  });
});

describe("Browser MCP's text forms", () => {
  it("reads the page lines", () => {
    assert.deepEqual(pageOf("Tab ID: 7\nTitle: Home\nURL: https://example.com/"), { tab: 7, title: "Home", url: "https://example.com/" });
  });
  it("drops a StaticText that repeats its parent's name", () => {
    const { tree, refs } = treeOf('Page changed: true\nbutton "Go" [uid=@e1]\n  StaticText "Go" [uid=@e2]\n  StaticText "more" [uid=@e3]');
    assert.equal(tree, '- button "Go" [ref=e1]\n  - text: "more"');
    assert.deepEqual([...refs], ["e1"]);
  });
});
