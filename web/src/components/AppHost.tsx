import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { useFileScope } from "../use-artifact-url";
import { connectAppHost, type AppHostConnection } from "../app-host";
import { nativeWalletOf, type NativeWalletApp } from "@strut/kit/wallet";
import { appToolInput, namesApp, peerAppLink } from "../app-links";
import { frameAttributes } from "../frame-permissions";
import type { ClaimEnd, PaymentRequired, PayOutcome } from "../visitor-pay";
import { PaymentSheet } from "./PaymentSheet";

// ── An app's page, hosted (plans/apps.md §7.3) ─────────────────────────────
//
// The version's document is a FILE of the version: its files are listed
// (which mints the read token — `useFileScope`, as for a run's artifacts),
// `dist/index.html` is fetched under that token (the server writes the
// app's identity into it as it serves it), and the TEXT is framed as the
// `srcdoc` of a sandboxed frame (`allow-scripts allow-downloads allow-forms
// allow-pointer-lock allow-orientation-lock`, ../frame-permissions) — an
// `about:srcdoc` document with an opaque origin (`location.origin` is
// "null"), never `allow-same-origin`, no `src` that carries a credential.
// It may save a file it was handed, use the microphone, write to the
// clipboard (a Copy button), and what a game needs: fullscreen, pointer
// lock, the gamepad, the wake lock (`allow="microphone; clipboard-write;
// fullscreen; gamepad; screen-wake-lock"`); none of them sends anything off
// the page. Motion sensors, the camera and geolocation only when the
// version DECLARES them (`app.yaml`'s `permissions:`, read off its
// `dist/build.json`): the attributes are set before the srcdoc, since the
// browser reads them when the frame navigates, and put back to every app's
// when the page goes, so one version's grants never reach the next. `allow-forms` is what lets a
// `<form onSubmit>` work: without it the browser refuses the submission
// before it fires the `submit` event, so the handler never runs ("Blocked
// form submission", 2026-11-10 — Jamie's SecretBox, strut/views'
// LaunchForm and every form the builder wrote). A form still goes nowhere:
// the document's CSP says `form-action 'none'`. Not a `blob:`
// URL: a blob document's `location.origin` is its creator's while its
// pathname is the whole blob URL, and a JSON-schema validator bundled into
// the MCP SDK does `new URL(location.origin + location.pathname)` at module
// time — the bundle died before the page could mount (2026-10-21). The
// relay (../app-host) is connected over the frame's window BEFORE the
// document loads, so the page's `ui/initialize` finds a host; its
// tools/call go to `/mcp` as they are. The same component renders an app a
// job delivered (the builder's, by name) in the job timeline and the
// artifact viewer. A PEER's app (plans/apps.md §7.4) is the same with every
// URL under `/peers/<id>`: this strut's read-through reads its listing and
// document, and relays its tools/call to the peer with the token on file.
// A VISITOR's page (the public view) may launch a workflow anyone may run;
// when it costs something this host — never the frame — shows the invoice
// over the frame and pays (./PaymentSheet, plans/paid-runs.md §10).

/** The frame every app starts in (../frame-permissions). Constant, so a
 *  render never writes over what the effect set for the version on screen. */
const BASE_FRAME = frameAttributes();

/** What the host renders: a workspace app at a version — here, or on `peer`. */
export type HostedApp = { name: string; version: string; peer?: string };

export function AppHost(props: {
  app: HostedApp;
  /** Bumped to reload the frame (a new version published, the Reload button). */
  reload?: number;
  theme?: "light" | "dark";
  /** `ui/message` from the page: for the builder chat. None in a job's
   *  timeline (no send box for a job here yet, §12). */
  onMessage?: (text: string) => void | Promise<void>;
  /** `ui/open-link` with a strut deep link: its params (absent: a new tab).
   *  A peer's page names apps on the peer, so its `app=<name>` arrives as
   *  `@<peer>/<name>`, and any other strut link of its opens in a new tab.
   *  False: not one to open in place, so a new tab. */
  onNavigate?: (params: Record<string, string>) => boolean | void;
  /** What a link opened the app with (`?input=`): `tool-input` once the
   *  page has initialized, and again, in place, whenever it changes. */
  toolInput?: Record<string, string>;
  /** A VISITOR's page (plans/public-surface.md §5): the document of the
   *  public view (`/public/apps/<name>/document`, its visitor's identity
   *  written in) and calls to `/public/mcp`, with no credential. */
  visitor?: boolean;
  /** The page is on screen: it initialized, or it loaded and never will
   *  (a page without the apps SDK), or it could not be loaded. Once per
   *  load. A host that frames strut fades in on it (../embed `reportReady`). */
  onReady?: () => void;
}) {
  const app = props.app;
  const visitor = !!props.visitor;
  // The version's token comes from its (cached) listing; a visitor has none.
  const scope = useFileScope(visitor ? null : api.appFilesScope(app.name, app.version, app.peer));
  const ready = visitor || !!scope;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; error?: string }>({ status: "loading" });
  /** A priced launch the visitor is asked to pay, and where its answer goes. */
  const [payment, setPayment] = useState<{ p: PaymentRequired; workflow: string; settled: Promise<ClaimEnd>; done: (o: PayOutcome) => void } | null>(null);
  const paymentRef = useRef(payment);
  paymentRef.current = payment;
  const connRef = useRef<AppHostConnection | null>(null);
  const handlers = useRef({ onMessage: props.onMessage, onNavigate: props.onNavigate, onReady: props.onReady });
  handlers.current = { onMessage: props.onMessage, onNavigate: props.onNavigate, onReady: props.onReady };
  const inputKey = props.toolInput ? JSON.stringify(props.toolInput) : "";
  const toolInput = useRef(props.toolInput);
  toolInput.current = props.toolInput;
  /** The input the open connection has (or sends at initialize). */
  const sentInput = useRef("");
  const messages = !!props.onMessage;
  const theme = props.theme ?? "dark";

  useEffect(() => {
    if (!ready) return;
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    let conn: AppHostConnection | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const markReady = () => {
      clearTimeout(readyTimer);
      if (!cancelled) handlers.current.onReady?.();
    };
    // A page that never initializes is on screen a moment after it loads.
    const onLoad = () => {
      if (frame.getAttribute("srcdoc")) readyTimer = setTimeout(markReady, 1000);
    };
    frame.addEventListener("load", onLoad);
    setState({ status: "loading" });
    void (async () => {
      try {
        // This strut's brand, read beside the document (once per page): a
        // visitor's page has no credential to read it with.
        const brand = visitor ? Promise.resolve(null) : api.getBrandStyles();
        // The version's build.json beside it — what its frame is granted;
        // a visitor's from the public view's listing of the app. Unread, the
        // frame gets what every app gets.
        const infoRead = visitor
          ? api.getPublicApp(app.name).catch(() => null)
          : api.fetchAppBuildInfo(app.name, app.version, scope!.token, app.peer);
        const html = visitor ? await api.fetchPublicAppDocument(app.name) : await api.fetchAppDocument(app.name, app.version, scope!.token, app.peer);
        const info = await infoRead;
        if (cancelled) return;
        const permissions = Array.isArray(info?.permissions) ? info.permissions : undefined;
        // In a native host's web view (Peel), the version's wallet request,
        // for its wallet: read only there, and only an app that asks for one
        // is offered a wallet (specs/WALLET.md §1.1).
        let wallet: NativeWalletApp | undefined;
        if (nativeWalletOf(window) && info && "wallet" in info && info.wallet) {
          wallet = { name: app.name, version: app.version, ...(app.peer ? { peer: app.peer } : {}), title: info.title ?? app.name, request: info.wallet };
        }
        conn = await connectAppHost({
          frame,
          theme,
          brand: await brand,
          ...(visitor ? { visitor: true } : {}),
          ...(app.peer ? { base: api.peerBase(app.peer) } : {}),
          ...(wallet ? { wallet } : {}),
          ...(permissions ? { permissions } : {}),
          // Channels as the signed-in viewer: a peer's app's are relayed to the peer.
          ...(!visitor ? { channels: { name: app.name, version: app.version, ...(app.peer ? { peer: app.peer } : {}) } } : {}),
          handlers: {
            onInitialized: markReady,
            ...(visitor
              ? {
                  onPayment: (p: PaymentRequired, workflow: string, settled: Promise<ClaimEnd>) =>
                    new Promise<PayOutcome>((resolve) => {
                      setPayment({
                        p,
                        workflow,
                        settled,
                        done: (o) => {
                          setPayment(null);
                          resolve(o);
                        },
                      });
                    }),
                }
              : {}),
            ...(messages ? { onMessage: (text: string) => handlers.current.onMessage?.(text) } : {}),
            ...(handlers.current.onNavigate ? {
              onNavigate: (params: Record<string, string>) => {
                const to = app.peer ? peerAppLink(params, app.peer) : params;
                if (!to) return false;
                const opened = handlers.current.onNavigate?.(to);
                // A link to this page: its input goes to it now, even one
                // equal to the last — the page may have moved since.
                if (opened !== false && namesApp(to["app"], app)) {
                  const args = appToolInput(to["input"]);
                  sentInput.current = args ? JSON.stringify(args) : "";
                  connRef.current?.setToolInput(args);
                }
                return opened;
              },
            } : {}),
          },
        });
        if (cancelled) { await conn.close(); return; }
        connRef.current = conn;
        // Before the document loads: what initialize is followed by — the
        // input as it is NOW, should it have changed while connecting.
        conn.setToolInput(toolInput.current);
        sentInput.current = toolInput.current ? JSON.stringify(toolInput.current) : "";
        // Every app's attributes and what the version declared, read by the
        // browser at the navigation the srcdoc starts: set first.
        const attrs = frameAttributes(permissions);
        frame.setAttribute("sandbox", attrs.sandbox);
        frame.setAttribute("allow", attrs.allow);
        frame.srcdoc = html;
        setState({ status: "ready" });
      } catch (err) {
        if (!cancelled) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
        markReady();
      }
    })();
    return () => {
      cancelled = true;
      // A sheet still open answers its call: the page is going away.
      paymentRef.current?.done(null);
      clearTimeout(readyTimer);
      frame.removeEventListener("load", onLoad);
      connRef.current = null;
      void conn?.close();
      if (frame) {
        frame.setAttribute("sandbox", BASE_FRAME.sandbox);
        frame.setAttribute("allow", BASE_FRAME.allow);
        frame.removeAttribute("srcdoc");
      }
    };
    // The token is the scope's; a reload re-fetches the document (a new
    // version was published under the same label only on a rebuild).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.name, app.version, app.peer, props.reload, scope?.token, ready]);

  useEffect(() => {
    connRef.current?.setTheme(theme);
  }, [theme]);

  // A new input for the page already open: sent in place, no reload.
  useEffect(() => {
    if (!connRef.current || sentInput.current === inputKey) return;
    sentInput.current = inputKey;
    connRef.current?.setToolInput(toolInput.current);
  }, [inputKey]);

  return (
    <div class={`app-host${theme === "light" ? " light" : ""}`}>
      {/* Every app's attributes; the effect sets the version's before the srcdoc. */}
      <iframe ref={frameRef} class="app-frame" sandbox={BASE_FRAME.sandbox} allow={BASE_FRAME.allow} title={app.name} />
      {payment && <PaymentSheet payment={payment.p} workflow={payment.workflow} settled={payment.settled} onDone={payment.done} />}
      {state.status !== "ready" && (
        <div class={`app-host-overlay${state.status === "error" ? " is-error" : ""}`}>
          {state.status === "loading" ? "Loading the app…" : `The app could not be loaded: ${state.error}`}
        </div>
      )}
    </div>
  );
}
