// ── The app host's relay (plans/apps.md §7.3) ──────────────────────────────
// Strut's own UI is an MCP Apps host: an app's document (a file of its
// version, fetched by token and framed as the srcdoc of a sandboxed iframe
// — components/AppHost.tsx) talks to this page over ext-apps' bridge, and
// the page relays every `tools/call` to strut's MCP door AS IT IS — the
// MCP SDK's client over Streamable HTTP at `/mcp`, with the session cookie
// (or the key) and the `x-strut-ui: 1` header the UI sends on every call.
// Nothing here is hand-rolled: `AppBridge` + `PostMessageTransport` are
// ext-apps', `Client` + `StreamableHTTPClientTransport` the SDK's; the
// bridge forwards tool calls to a connected client by itself. What is
// strut's: `ui/message` goes to the builder chat, `ui/open-link` to the
// SPA's own navigation for a strut link and a new tab for anything else,
// and a theme change to `host-context-changed`.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext, McpUiTheme } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { API_BASE, apiHeaders } from "./api";

/** The deep-link params a strut link may carry (./embed). */
const STRUT_PARAMS = new Set(["wf", "run", "v", "job", "app", "chat"]);

/** Where `ui/open-link` leads: the SPA's own navigation for a link to THIS
 *  strut (the same origin and mount, carrying strut's deep-link params —
 *  `?wf=`, `?run=`, `?job=`, `?app=`), a new tab for anything else. Pure:
 *  `here` is the page's own location. */
export function strutLink(url: string, here: { origin: string; pathname: string }): Record<string, string> | null {
  let u: URL;
  try {
    u = new URL(url, `${here.origin}${here.pathname}`);
  } catch {
    return null;
  }
  if (u.origin !== here.origin) return null;
  const mount = here.pathname.replace(/\/[^/]*$/, "/");
  const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  if (path !== mount && u.pathname !== here.pathname) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (STRUT_PARAMS.has(k) && v) params[k] = v;
  return Object.keys(params).length ? params : null;
}

/** What `ui/message` from an app becomes in the builder chat: the text,
 *  prefixed with which app it is about — the builder edits the directory. */
export function appMessage(app: { name: string; version: string }, text: string): string {
  return `About the app "${app.name}" (${app.version}, open in front of me): ${text.trim()}`;
}

export interface AppHostHandlers {
  /** `ui/message`: the text the page sent, for the builder chat. */
  onMessage: (text: string) => void | Promise<void>;
  /** `ui/open-link` with a strut link: its deep-link params. */
  onNavigate: (params: Record<string, string>) => void;
}

export interface AppHostOptions {
  frame: HTMLIFrameElement;
  theme: McpUiTheme;
  handlers: AppHostHandlers;
  /** The page's location (default: `window.location`), for `strutLink`. */
  here?: { origin: string; pathname: string };
}

export interface AppHostConnection {
  bridge: AppBridge;
  /** A theme change → `ui/notifications/host-context-changed`. */
  setTheme(theme: McpUiTheme): void;
  close(): Promise<void>;
}

/** The MCP client the relay forwards through: one per frame, over `/mcp`,
 *  the UI's credential on every request. */
export function createRelayClient(): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: "strut-ui", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${API_BASE}/mcp`, location.href), {
    requestInit: { headers: apiHeaders() },
  });
  return { client, transport };
}

/** The host context the page is handed at `ui/initialize`. */
export function hostContextFor(theme: McpUiTheme): McpUiHostContext {
  return {
    theme,
    displayMode: "fullscreen",
    availableDisplayModes: ["fullscreen"],
    locale: typeof navigator !== "undefined" ? navigator.language : undefined,
    timeZone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
    userAgent: "strut-ui",
    platform: "web",
  };
}

/**
 * Connect the relay for a frame: the MCP client to `/mcp` (initialize),
 * then the bridge over the frame's window — BEFORE the document loads, so
 * the page's `ui/initialize` finds a host. The bridge forwards tools/call
 * to the client by itself (`AppBridge.connect`); the two requests strut
 * answers in the page are wired here.
 */
export async function connectAppHost(opts: AppHostOptions): Promise<AppHostConnection> {
  const { client, transport } = createRelayClient();
  await client.connect(transport);
  const bridge = new AppBridge(
    client,
    { name: "strut-ui", version: "0" },
    { serverTools: {}, openLinks: {}, message: { text: {} } },
    { hostContext: hostContextFor(opts.theme) },
  );
  bridge.onmessage = async (params) => {
    const text = (params.content ?? [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) await opts.handlers.onMessage(text);
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    const params = strutLink(url, opts.here ?? { origin: location.origin, pathname: location.pathname });
    if (params) opts.handlers.onNavigate(params);
    else window.open(url, "_blank", "noopener");
    return {};
  };
  const win = opts.frame.contentWindow;
  if (!win) throw new Error("the frame has no window yet");
  await bridge.connect(new PostMessageTransport(win, win));
  return {
    bridge,
    setTheme: (theme) => bridge.setHostContext({ ...hostContextFor(theme), theme }),
    async close() {
      await bridge.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}
