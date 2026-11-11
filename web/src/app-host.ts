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
// with (`?input=`) to `ui/notifications/tool-input`. For a VISITOR's page
// (the public view) the relay also names the visit and PAYS for a priced
// launch (plans/paid-runs.md §10, ./visitor-pay): the one call it does not
// pass through as it is.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext, McpUiTheme } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  WALLET_CAPABILITY, nativeWalletNotifications, nativeWalletOf, probeNativeWallet, relayNativeWallet,
  type NativeWalletApp, type RelayBridge,
} from "@strut/kit/wallet";
import { CHANNELS_CAPABILITY, relayChannels } from "@strut/kit/channels";
import { VISITOR_CAPABILITY, VISITOR_PASS_THROUGH, VISITOR_SIGN_IN_METHOD, VISITOR_SIGN_OUT_METHOD } from "@strut/kit/visitor";
import { API_BASE, apiHeaders, channelSocketUrl, channelTicket, claimPublicCredit, type BrandStyles } from "./api";
import { signOutVisitor, visitorAuth, visitorChannelTicket, visitorInfo, type SignInMethod, type VisitorSession } from "./visitor-signin";
import { strutLink } from "./app-links";
import { mcpPermissions } from "./frame-permissions";
import {
  callPaying, createClaimKeeper, loadPurse, payInTurn, savePurse, visitorHeaders,
  type CallParams, type CallResult, type ClaimEnd, type PaymentRequired, type PayOutcome,
} from "./visitor-pay";

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
  /** The page's `ui/notifications/initialized`: it has started. */
  onInitialized?: () => void;
  /** A VISITOR's priced launch (plans/paid-runs.md §10): show the invoice
   *  until `settled` says how it ended — the host keeps claiming it either
   *  way — and answer the credential (`<macaroon>:<preimage>`), `again` for
   *  a new invoice, or null when the visitor cancels. Absent, the page's
   *  launch answers that the run was not paid for. */
  onPayment?: (p: PaymentRequired, workflow: string, settled: Promise<ClaimEnd>) => Promise<PayOutcome>;
  /** A VISITOR's page asks to sign the visitor in (plans/app-repos.md §5):
   *  sign them in by one of `methods` (the sheet), answering the session,
   *  or null when they closed it. Absent, no sign-in is offered. */
  onSignIn?: (methods: SignInMethod[]) => Promise<VisitorSession | null>;
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
   *  (§4). For a visitor's page, a ticket only once the visitor signed in
   *  (plans/app-repos.md §5.1): until then a join waits and tries again. */
  channels?: { name: string; version: string; peer?: string };
  /** This strut's brand (`GET /brand`): each theme's style variables, sent
   *  in the host context so the kit's tokens take them (src/brand.ts). */
  brand?: BrandStyles | null;
  /** The version's declared `permissions` (its build.json), which the
   *  frame's attributes grant (./frame-permissions `frameAttributes`): MCP
   *  Apps' own four are reported in `ui/initialize` as
   *  `hostCapabilities.sandbox.permissions`. */
  permissions?: string[];
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

/** What this page holds for the visitor's pages it shows (§10): one visit
 *  per tab — the runs launched under it are the ones its pages read back —
 *  the credit credential, credentials paid for and not sent yet, and every
 *  invoice shown and not settled. In this page's `sessionStorage`, so a
 *  reload in the tab keeps the visit's runs and its credit; never a frame's. */
const PURSE_KEY = `strut.visitor:${API_BASE}`;
const purseStorage = (() => {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
})();
const visitorPurse = loadPurse(purseStorage, PURSE_KEY);
const savePurseNow = () => savePurse(purseStorage, PURSE_KEY, visitorPurse);
savePurseNow();
/** Every invoice shown is claimed until it settles or ends, apart from any
 *  sheet: a phone that pays after the visitor pressed Cancel still buys
 *  credit. Those a reload found pending are watched again. */
const claimKeeper = createClaimKeeper({ purse: visitorPurse, claim: claimPublicCredit, save: savePurseNow });
claimKeeper.resume();
/** One payment sheet at a time for that purse, whichever frame asked. */
const visitorPayTurn = payInTurn(visitorPurse);
/** While a paying launch waits, `notifications/progress` for the page's
 *  request this often: the frame's request times out after 60 s unless
 *  progress resets it (ext-apps' `callServerTool` asks for that). */
const PROGRESS_EVERY_MS = 15_000;

/** The MCP client the relay forwards through: one per frame, over `/mcp`
 *  (or a peer's, `/peers/<id>/mcp`), the UI's credential on every request.
 *  A visitor's goes to `/public/mcp` with no credential of the UI's, naming
 *  the visit and, once paid, presenting the credit credential. */
export function createRelayClient(base = "", visitor = false): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: "strut-ui", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${API_BASE}${visitor ? "/public" : base}/mcp`, location.href), {
    requestInit: visitor ? { credentials: "omit" } : { headers: apiHeaders() },
    ...(visitor
      ? {
          // The visit and its credit; and a signed-in visitor's session —
          // its cookie where the browser sends it, its token beside the
          // credit token (plans/app-repos.md §5.2).
          fetch: (url: string | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            for (const [k, v] of Object.entries({ ...visitorAuth(true), ...visitorHeaders(visitorPurse) })) headers.set(k, v);
            return fetch(url, { ...init, headers, credentials: "same-origin" });
          },
        }
      : {}),
  });
  return { client, transport };
}

/** The host context the page is handed at `ui/initialize`, and again on a
 *  theme change: the brand's variables for that theme with it. */
export function hostContextFor(theme: McpUiTheme, brand?: BrandStyles | null): McpUiHostContext {
  // The spec types the variables as every standard name; the brand sets a
  // few, and the page reads a missing one as unset.
  const variables = brand?.[theme]?.variables as NonNullable<McpUiHostContext["styles"]>["variables"] | undefined;
  return {
    theme,
    ...(variables ? { styles: { variables } } : {}),
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
  // A visitor's page: who is signed in, and how one signs in here.
  const signIn = opts.visitor && opts.handlers.onSignIn ? await visitorInfo().catch(() => null) : null;
  const visitorCap = signIn && (signIn.methods.length || signIn.actor) ? { v: 1 as const, methods: signIn.methods, ...(signIn.actor ? { actor: signIn.actor } : {}) } : undefined;
  const bridge = new AppBridge(
    client,
    { name: "strut-ui", version: "0" },
    {
      serverTools: {},
      openLinks: {},
      sandbox: { permissions: mcpPermissions(opts.permissions) },
      ...(opts.handlers.onMessage ? { message: { text: {} } } : {}),
      ...(capability || (opts.channels && !opts.visitor) || visitorCap
        ? {
            experimental: {
              ...(capability ? { [WALLET_CAPABILITY]: capability } : {}),
              ...(opts.channels && (!opts.visitor || visitorCap) ? { [CHANNELS_CAPABILITY]: { v: 1 } } : {}),
              ...(visitorCap ? { [VISITOR_CAPABILITY]: visitorCap } : {}),
            },
          }
        : {}),
    },
    { hostContext: hostContextFor(opts.theme, opts.brand) },
  );
  let stopWallet = () => {};
  if (native && capability && opts.wallet) {
    const relay = relayNativeWallet({ bridge: bridge as unknown as RelayBridge, native, app: opts.wallet, capability });
    stopWallet = nativeWalletNotifications(window).register(opts.wallet, relay.notify);
  }
  // A visitor's page carries channels only where a visitor may sign in.
  const channels = opts.visitor && !visitorCap ? undefined : opts.channels;
  const channelRelay = channels
    ? relayChannels({
        bridge: bridge as unknown as Parameters<typeof relayChannels>[0]["bridge"],
        async open(client) {
          const { ticket } = opts.visitor ? await visitorChannelTicket(channels.name, channels.version) : await channelTicket(channels.name, channels.version, channels.peer);
          return new WebSocket(channelSocketUrl(ticket, client));
        },
      })
    : undefined;
  if (visitorCap) {
    const onSignIn = opts.handlers.onSignIn!;
    bridge.setRequestHandler(VISITOR_SIGN_IN_METHOD as never, { params: VISITOR_PASS_THROUGH } as never, (async () => {
      const session = await onSignIn(visitorCap.methods as SignInMethod[]);
      return session ? { actor: session.actor } : {};
    }) as never);
    bridge.setRequestHandler(VISITOR_SIGN_OUT_METHOD as never, { params: VISITOR_PASS_THROUGH } as never, (async () => {
      await signOutVisitor();
      return {};
    }) as never);
  }
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
    opts.handlers.onInitialized?.();
    if (toolInput) void bridge.sendToolInput({ arguments: toolInput });
  };
  const win = opts.frame.contentWindow;
  if (!win) throw new Error("the frame has no window yet");
  await bridge.connect(new PostMessageTransport(win, win));
  // A visitor's page: every call passes through as it is, but a priced
  // launch is paid for here and sent again (./visitor-pay `callPaying`).
  // Set once connected — `connect` sets the plain forwarder — and still
  // before the document loads.
  if (opts.visitor) {
    const pay = opts.handlers.onPayment;
    bridge.oncalltool = async (params, extra) => {
      // The page's request stays alive while the visitor pays: progress for
      // its token resets the frame's timeout.
      const token = (params as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
      let beats = 0;
      const beat = token === undefined
        ? undefined
        : setInterval(() => {
            void bridge.notification({ method: "notifications/progress", params: { progressToken: token, progress: ++beats, message: "waiting for the payment" } }).catch(() => {});
          }, PROGRESS_EVERY_MS);
      try {
        return (await callPaying(params as CallParams, {
          call: async (p) => (await client.request({ method: "tools/call", params: p }, { signal: extra.mcpReq.signal })) as CallResult,
          purse: visitorPurse,
          save: savePurseNow,
          pay: (p, workflow) =>
            visitorPayTurn((q, w) => {
              if (!pay) return Promise.resolve(null);
              // Claimed from now until it settles or ends, sheet or no sheet;
              // a top-up replaces the credential it was minted to carry from.
              const settled = claimKeeper.watch({
                macaroon: q.macaroon,
                ...(q.expires ? { expires: q.expires } : {}),
                ...(q.carries && visitorPurse.credential ? { carriesFrom: visitorPurse.credential } : {}),
              });
              return pay(q, w, settled);
            }, p, workflow),
        })) as Awaited<ReturnType<NonNullable<typeof bridge.oncalltool>>>;
      } finally {
        if (beat) clearInterval(beat);
      }
    };
  }
  return {
    bridge,
    setTheme: (theme) => bridge.setHostContext({ ...hostContextFor(theme, opts.brand), theme }),
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
