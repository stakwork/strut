import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { useFileScope } from "../use-artifact-url";
import { connectAppHost, type AppHostConnection } from "../app-host";

// ── An app's page, hosted (plans/apps.md §7.3) ─────────────────────────────
//
// The version's document is a FILE of the version: its files are listed
// (which mints the read token — `useFileScope`, as for a run's artifacts),
// `dist/index.html` is fetched under that token (the server writes the
// app's identity into it as it serves it), and the TEXT is framed as a blob
// URL in `<iframe sandbox="allow-scripts">` — an opaque origin, never
// `allow-same-origin`, no `src` that carries a credential. The relay
// (../app-host) is connected over the frame's window BEFORE the document
// loads, so the page's `ui/initialize` finds a host; its tools/call go to
// `/mcp` as they are. The same component will render a job's app in the
// job timeline and the artifact viewer (work item 2).

export function AppHost(props: {
  name: string;
  version: string;
  /** Bumped to reload the frame (a new version published). */
  reload?: number;
  theme?: "light" | "dark";
  /** `ui/message` from the page: for the builder chat. */
  onMessage: (text: string) => void | Promise<void>;
  /** `ui/open-link` with a strut deep link: its params. */
  onNavigate: (params: Record<string, string>) => void;
}) {
  const scope = useFileScope(api.appFilesScope(props.name, props.version));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; error?: string }>({ status: "loading" });
  const connRef = useRef<AppHostConnection | null>(null);
  const handlers = useRef({ onMessage: props.onMessage, onNavigate: props.onNavigate });
  handlers.current = { onMessage: props.onMessage, onNavigate: props.onNavigate };
  const theme = props.theme ?? "dark";

  useEffect(() => {
    if (!scope) return;
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    let conn: AppHostConnection | null = null;
    setState({ status: "loading" });
    void (async () => {
      try {
        const html = await api.fetchAppDocument(props.name, props.version, scope.token);
        if (cancelled) return;
        conn = await connectAppHost({
          frame,
          theme,
          handlers: {
            onMessage: (text) => handlers.current.onMessage(text),
            onNavigate: (params) => handlers.current.onNavigate(params),
          },
        });
        if (cancelled) { await conn.close(); return; }
        connRef.current = conn;
        blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        frame.src = blobUrl;
        setState({ status: "ready" });
      } catch (err) {
        if (!cancelled) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
      connRef.current = null;
      void conn?.close();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      if (frame) frame.removeAttribute("src");
    };
    // The token is the scope's; a reload re-fetches the document (a new
    // version was published under the same label only on a rebuild).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.name, props.version, props.reload, scope?.token]);

  useEffect(() => {
    connRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <div class="app-host">
      <iframe ref={frameRef} class="app-frame" sandbox="allow-scripts" title={props.name} />
      {state.status !== "ready" && (
        <div class={`app-host-overlay${state.status === "error" ? " is-error" : ""}`}>
          {state.status === "loading" ? "Loading the app…" : `The app could not be loaded: ${state.error}`}
        </div>
      )}
    </div>
  );
}
