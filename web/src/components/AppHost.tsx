import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { useFileScope } from "../use-artifact-url";
import { connectAppHost, type AppHostConnection } from "../app-host";
import { appToolInput, namesApp, peerAppLink } from "../app-links";

// ── An app's page, hosted (plans/apps.md §7.3) ─────────────────────────────
//
// The version's document is a FILE of the version: its files are listed
// (which mints the read token — `useFileScope`, as for a run's artifacts),
// `dist/index.html` is fetched under that token (the server writes the
// app's identity into it as it serves it), and the TEXT is framed as the
// `srcdoc` of `<iframe sandbox="allow-scripts">` — an `about:srcdoc`
// document with an opaque origin (`location.origin` is "null"), never
// `allow-same-origin`, no `src` that carries a credential. Not a `blob:`
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
}) {
  const app = props.app;
  // The version's token comes from its (cached) listing.
  const scope = useFileScope(api.appFilesScope(app.name, app.version, app.peer));
  const ready = !!scope;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; error?: string }>({ status: "loading" });
  const connRef = useRef<AppHostConnection | null>(null);
  const handlers = useRef({ onMessage: props.onMessage, onNavigate: props.onNavigate });
  handlers.current = { onMessage: props.onMessage, onNavigate: props.onNavigate };
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
    setState({ status: "loading" });
    void (async () => {
      try {
        const html = await api.fetchAppDocument(app.name, app.version, scope!.token, app.peer);
        if (cancelled) return;
        conn = await connectAppHost({
          frame,
          theme,
          ...(app.peer ? { base: api.peerBase(app.peer) } : {}),
          handlers: {
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
        frame.srcdoc = html;
        setState({ status: "ready" });
      } catch (err) {
        if (!cancelled) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
      connRef.current = null;
      void conn?.close();
      if (frame) frame.removeAttribute("srcdoc");
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
    <div class="app-host">
      <iframe ref={frameRef} class="app-frame" sandbox="allow-scripts" title={app.name} />
      {state.status !== "ready" && (
        <div class={`app-host-overlay${state.status === "error" ? " is-error" : ""}`}>
          {state.status === "loading" ? "Loading the app…" : `The app could not be loaded: ${state.error}`}
        </div>
      )}
    </div>
  );
}
