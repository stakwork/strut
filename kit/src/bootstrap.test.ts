import { teardownDom } from "./test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { bootstrap, readToken, TOKEN_META, type Transport } from "./bootstrap.js";
import { useHost, useToolInput } from "./hooks.js";

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** A fake MCP Apps HOST on the other end of the bridge: answers
 *  `ui/initialize` with a host context, answers every `tools/call`, and
 *  records what the app sent. */
class FakeHost implements Transport {
  sent: Msg[] = [];
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  onmessage?: (message: Msg) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  constructor(readonly hostContext: Record<string, unknown>) {}
  async start() {}
  async close() { this.onclose?.(); }
  async send(message: Msg) {
    this.sent.push(message);
    if (message.id === undefined || !message.method) return;
    const reply = (result: unknown) => queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "ui/initialize") {
      reply({
        protocolVersion: (message.params as { protocolVersion: string }).protocolVersion,
        hostInfo: { name: "fake-host", version: "1" },
        hostCapabilities: { serverTools: {}, openLinks: {} },
        hostContext: this.hostContext,
      });
    } else if (message.method === "tools/call") {
      const p = message.params as { name: string; arguments?: Record<string, unknown> };
      this.toolCalls.push(p);
      reply({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], structuredContent: { ok: true } });
    } else {
      reply({});
    }
  }
  /** The host notifies the app. */
  notify(method: string, params: Record<string, unknown>) {
    this.onmessage?.({ jsonrpc: "2.0", method, params });
  }
  requests(method: string) { return this.sent.filter((m) => m.method === method); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A fresh mount point per test (React warns on a second createRoot on one container). */
function freshRoot(): HTMLElement {
  document.getElementById("root")?.remove();
  const el = document.createElement("div");
  el.id = "root";
  document.body.appendChild(el);
  return el;
}

function setMeta(token: string | undefined) {
  document.querySelector(`meta[name="${TOKEN_META}"]`)?.remove();
  if (token !== undefined) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", TOKEN_META);
    meta.setAttribute("content", token);
    document.head.appendChild(meta);
  }
}

function TestApp() {
  const host = useHost();
  const input = useToolInput<{ view?: string }>();
  return createElement("div", { id: "out" }, `${host.connected}:${host.theme}:${host.displayMode}:${host.locale}:${input?.view ?? "-"}`);
}

function ThrowingApp(): never {
  throw new Error("render exploded");
}

describe("bootstrap", () => {
  it("reads the token meta", () => {
    setMeta("tok-abc");
    assert.equal(readToken(document), "tok-abc");
    setMeta(undefined);
    assert.equal(readToken(document), undefined);
  });

  it("initializes over the bridge, applies the host context, mounts the app, reports its size and calls step_run with the token", async () => {
    setMeta("tok-123");
    const host = new FakeHost({
      theme: "dark",
      displayMode: "fullscreen",
      locale: "en-GB",
      timeZone: "Europe/London",
      styles: { variables: { "--color-background-primary": "#111111", "--font-sans": "Inter, sans-serif", "--border-radius-md": "4px" }, css: { fonts: "@font-face{font-family:Inter;src:url(data:,)}" } },
    });
    const mounted = await bootstrap(TestApp, { transport: host, document, root: freshRoot(), appInfo: { name: "test-app", version: "1.2.3" } });
    assert.equal(mounted.connected, true);

    const init = host.requests("ui/initialize");
    assert.equal(init.length, 1, "one ui/initialize");
    assert.deepEqual((init[0]!.params as { appInfo: unknown }).appInfo, { name: "test-app", version: "1.2.3" });
    assert.equal(host.requests("ui/notifications/initialized").length, 1);

    const html = document.documentElement;
    assert.equal(html.getAttribute("data-theme"), "dark");
    assert.ok(html.classList.contains("dark"));
    assert.equal(html.getAttribute("data-display-mode"), "fullscreen");
    assert.equal(html.style.getPropertyValue("--color-background-primary"), "#111111");
    assert.equal(html.style.getPropertyValue("--font-sans"), "Inter, sans-serif");
    assert.equal(html.style.getPropertyValue("--border-radius-md"), "4px");
    assert.ok(document.getElementById("strut-host-fonts")?.textContent?.includes("Inter"));

    await until(() => document.getElementById("out")?.textContent === "true:dark:fullscreen:en-GB:-", "the app rendered the host state");

    host.notify("ui/notifications/tool-input", { arguments: { view: "runs" } });
    await until(() => document.getElementById("out")?.textContent === "true:dark:fullscreen:en-GB:runs", "tool-input reached useToolInput");

    host.notify("ui/notifications/host-context-changed", { theme: "light" });
    await until(() => document.getElementById("out")?.textContent?.startsWith("true:light:") === true, "a theme change reached the app");
    assert.equal(html.getAttribute("data-theme"), "light");
    assert.equal(Boolean(html.classList.contains("dark")), false);

    await until(() => host.requests("ui/notifications/size-changed").length > 0, "a size-changed notification");
    const size = host.requests("ui/notifications/size-changed")[0]!.params as { width?: number; height?: number };
    assert.equal(typeof size.width, "number");

    assert.deepEqual(await mounted.client.run("run/list", { workflow: "wf" }), { ok: true });
    assert.equal(host.toolCalls.at(-1)!.name, "step_run");
    assert.deepEqual(host.toolCalls.at(-1)!.arguments, { type: "run/list", config: { workflow: "wf" }, app: "tok-123" });

    await mounted.unmount();
  });

  it("reports a window error and a render failure through app/report-error, once each", async () => {
    setMeta("tok-err");
    const host = new FakeHost({ theme: "light" });
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const mounted = await bootstrap(ThrowingApp, { transport: host, document, root: freshRoot() });
      await until(() => host.toolCalls.some((c) => c.arguments?.type === "app/report-error"), "the render failure's report");
      const render = host.toolCalls.find((c) => c.arguments?.type === "app/report-error")!;
      const cfg = render.arguments!.config as { message: string; stack?: string; componentStack?: string };
      assert.equal(cfg.message, "render exploded");
      assert.equal(typeof cfg.stack, "string");
      assert.equal(typeof cfg.componentStack, "string", "a render failure carries the component stack");
      assert.equal(render.arguments!.app, "tok-err");
      assert.match(document.querySelector("[role=alert]")?.textContent ?? "", /render exploded/, "the boundary's fallback shows the error");

      const before = host.toolCalls.length;
      const boom = new Error("boom at line 3");
      window.dispatchEvent(new ErrorEvent("error", { message: boom.message, error: boom }));
      await until(() => host.toolCalls.length > before, "the window error's report");
      const win = host.toolCalls.at(-1)!.arguments!.config as { message: string; stack?: string; componentStack?: string };
      assert.equal(win.message, "boom at line 3");
      assert.equal(typeof win.stack, "string");
      assert.equal(win.componentStack, undefined);

      window.dispatchEvent(new ErrorEvent("error", { message: boom.message, error: boom }));
      await sleep(50);
      assert.equal(host.toolCalls.length, before + 1, "the same error (message + stack) is reported once");
      await mounted.unmount();
    } finally {
      console.error = quiet;
    }
  });

  it("mounts without a host when ui/initialize goes unanswered", async () => {
    setMeta(undefined);
    const silent: Transport = { async start() {}, async send() {}, async close() {} };
    const quiet = console.warn;
    console.warn = () => undefined;
    try {
      const mounted = await bootstrap(TestApp, { transport: silent, document, root: freshRoot(), connectTimeoutMs: 50 });
      assert.equal(mounted.connected, false);
      await until(() => document.getElementById("out")?.textContent === "false:light:inline:undefined:-", "the app rendered unconnected");
      await mounted.unmount();
    } finally {
      console.warn = quiet;
    }
  });
});

after(() => teardownDom());
