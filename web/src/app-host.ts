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
// a theme change to `host-context-changed`, and what a link opened the app
// with (`?input=`) to `ui/notifications/tool-input`.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext, McpUiStyles, McpUiTheme } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  WALLET_CAPABILITY, nativeWalletNotifications, nativeWalletOf, probeNativeWallet, relayNativeWallet,
  type NativeWalletApp, type RelayBridge,
} from "@strut/kit/wallet";
import { CHANNELS_CAPABILITY, relayChannels } from "@strut/kit/channels";
import { API_BASE, apiHeaders, channelSocketUrl, channelTicket } from "./api";
import { strutLink } from "./app-links";
import { variablesFor as brandVariablesFor } from "./instance-theme";

// The pure parts — where a link leads, what a message becomes — are
// ./app-links (tested there; this module's imports need web/node_modules).
export { appMessage, strutLink } from "./app-links";

export interface AppHostHandlers {
  /** `ui/message`: the text the page sent, for the builder chat. Absent (an
   *  app in a job's timeline: strut's UI has no send box for a job yet,
   *  plans/apps.md §12), the host does not offer the capability. */
  onMessage?: (text: string) => void | Promise<void>;
  /** `ui/open-link` with a strut link: its deep-link params. Absent, or
   *  returning false (not a link this host opens in place), it opens in a
   *  new tab like any other. */
  onNavigate?: (params: Record<string, string>) => boolean | void;
}

export interface AppHostOptions {
  frame: HTMLIFrameElement;
  theme: McpUiTheme;
  handlers: AppHostHandlers;
  /** The page's location (default: `window.location`), for `strutLink`. */
  here?: { origin: string; pathname: string };
  /** Where the app lives, as a path prefix: "" here, `/peers/<id>` for a
   *  peer's app, whose tools/call this strut relays to the peer
   *  (plans/apps.md §7.4). */
  base?: string;
  /** A VISITOR's page (the public view, plans/public-surface.md §5): the
   *  relay calls `/public/mcp` with no credential at all. */
  visitor?: boolean;
  /** The app as a native host's wallet names it — its identity, title and
   *  `wallet:` request (specs/WALLET.md §1.1) — for an app that requests a
   *  wallet. When this page is a native host's main frame (Peel's web view),
   *  the host's wallet is offered to the page and its `strut/wallet/*` calls
   *  are relayed there; anywhere else it is unused. */
  wallet?: NativeWalletApp;
  /** The app, at the version on screen: the host then carries its
   *  channels (plans/app-channels.md §3) — one socket to this strut's
   *  `/channels` for the page, opened with a ticket on its first join. A
   *  peer's app names its peer, and this strut relays the socket there
   *  (§4). Left out for a visitor: there is no viewer to mint for. */
  channels?: { name: string; version: string; peer?: string };
}

export interface AppHostConnection {
  bridge: AppBridge;
  /** A theme change → `ui/notifications/host-context-changed`. */
  setTheme(theme: McpUiTheme): void;
  /** What the page is opened with (`?input=`, ./app-links `appToolInput`)
   *  → `ui/notifications/tool-input`, sent once the page has initialized.
   *  Called again (a link to the same app) it is sent in place, `{}` for
   *  none. */
  setToolInput(args: Record<string, string> | undefined): void;
  close(): Promise<void>;
}

/** The MCP client the relay forwards through: one per frame, over `/mcp`
 *  (or a peer's, `/peers/<id>/mcp`), the UI's credential on every request. */
export function createRelayClient(base = "", visitor = false): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: "strut-ui", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${API_BASE}${visitor ? "/public" : base}/mcp`, location.href), {
    requestInit: visitor ? { credentials: "omit" } : { headers: apiHeaders() },
  });
  return { client, transport };
}

/** The host context the page is handed at `ui/initialize` — and again at
 *  `host-context-changed`: the theme, and the server's brand for that theme
 *  as style variables (./instance-theme), which the kit's base stylesheet
 *  reads. Strut's two brand names are not in MCP Apps' list of variables;
 *  the kit applies any `--` name the host sends. */
export function hostContextFor(theme: McpUiTheme): McpUiHostContext {
  const variables = brandVariablesFor(theme);
  return {
    theme,
    ...(variables ? { styles: { variables: variables as unknown as McpUiStyles } } : {}),
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
  const { client, transport } = createRelayClient(opts.base, opts.visitor);
  await client.connect(transport);
  // A native host's wallet (Peel's Sphinx account), asked what it offers
  // this app before the bridge exists: the offer rides in ui/initialize.
  const native = opts.wallet ? nativeWalletOf(window) : undefined;
  const capability = native && opts.wallet ? await probeNativeWallet(native, opts.wallet) : undefined;
  const bridge = new AppBridge(
    client,
    { name: "strut-ui", version: "0" },
    {
      serverTools: {},
      openLinks: {},
      ...(opts.handlers.onMessage ? { message: { text: {} } } : {}),
      ...(capability || opts.channels
        ? { experimental: { ...(capability ? { [WALLET_CAPABILITY]: capability } : {}), ...(opts.channels ? { [CHANNELS_CAPABILITY]: { v: 1 } } : {}) } }
        : {}),
    },
    { hostContext: hostContextFor(opts.theme) },
  );
  let stopWallet = () => {};
  if (native && capability && opts.wallet) {
    const relay = relayNativeWallet({ bridge: bridge as unknown as RelayBridge, native, app: opts.wallet, capability });
    stopWallet = nativeWalletNotifications(window).register(opts.wallet, relay.notify);
  }
  const channels = opts.channels;
  const channelRelay = channels
    ? relayChannels({
        bridge: bridge as unknown as Parameters<typeof relayChannels>[0]["bridge"],
        async open(client) {
          const { ticket } = await channelTicket(channels.name, channels.version, channels.peer);
          return new WebSocket(channelSocketUrl(ticket, client));
        },
      })
    : undefined;
  bridge.onmessage = async (params) => {
    const text = (params.content ?? [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) await opts.handlers.onMessage?.(text);
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    const params = strutLink(url, opts.here ?? { origin: location.origin, pathname: location.pathname });
    if (!params || !opts.handlers.onNavigate || opts.handlers.onNavigate(params) === false) {
      window.open(url, "_blank", "noopener");
    }
    return {};
  };
  // `tool-input` goes after the page's `initialized`, as the spec orders it.
  let initialized = false;
  let toolInput: Record<string, string> | undefined;
  bridge.oninitialized = () => {
    initialized = true;
    if (toolInput) void bridge.sendToolInput({ arguments: toolInput });
  };
  const win = opts.frame.contentWindow;
  if (!win) throw new Error("the frame has no window yet");
  await bridge.connect(new PostMessageTransport(win, win));
  return {
    bridge,
    setTheme: (theme) => bridge.setHostContext({ ...hostContextFor(theme), theme }),
    setToolInput(args) {
      toolInput = args;
      if (initialized) void bridge.sendToolInput({ arguments: args ?? {} });
    },
    async close() {
      stopWallet();
      channelRelay?.close();
      await bridge.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}
