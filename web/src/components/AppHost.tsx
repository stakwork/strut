import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { useFileScope } from "../use-artifact-url";
import { connectAppHost, type AppHostConnection } from "../app-host";

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
// tools/call go to `/mcp` as they are. The same component renders a JOB's
// app (plans/apps.md §6) in the job timeline and the artifact viewer: its
// files listed with the job's token NARROWED to its directory, which is
// what its document is fetched with and what the page then carries as its
// identity — one live directory, reloaded when its build's hash moves.

/** What the host renders: a workspace app at a version, or a job's app. */
export type HostedApp = { name: string; version: string } | api.JobAppRef;

export function AppHost(props: {
  app: HostedApp;
  /** Bumped to reload the frame (a new version published, the Reload button). */
  reload?: number;
  theme?: "light" | "dark";
  /** `ui/message` from the page: for the builder chat. None for a job's app
   *  (no send box for a job here yet, §12). */
  onMessage?: (text: string) => void | Promise<void>;
  /** `ui/open-link` with a strut deep link: its params (absent: a new tab). */
  onNavigate?: (params: Record<string, string>) => void;
}) {
  const app = props.app;
  const job = "job" in app ? app : null;
  const ws = "job" in app ? null : app;
  const wsScope = useFileScope(ws ? api.appFilesScope(ws.name, ws.version) : null);
  // A workspace version's token comes from its (cached) listing; a job's
  // app is listed at each load — its directory is live.
  const ready = job ? true : !!wsScope;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; error?: string }>({ status: "loading" });
  const connRef = useRef<AppHostConnection | null>(null);
  const handlers = useRef({ onMessage: props.onMessage, onNavigate: props.onNavigate });
  handlers.current = { onMessage: props.onMessage, onNavigate: props.onNavigate };
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
        const html = job
          ? await api.fetchJobAppDocument(job.job, job.path, (await api.jobAppScope(job.job, job.path)).token)
          : await api.fetchAppDocument(ws!.name, ws!.version, wsScope!.token);
        if (cancelled) return;
        conn = await connectAppHost({
          frame,
          theme,
          handlers: {
            ...(messages ? { onMessage: (text: string) => handlers.current.onMessage?.(text) } : {}),
            ...(handlers.current.onNavigate ? { onNavigate: (params: Record<string, string>) => handlers.current.onNavigate?.(params) } : {}),
          },
        });
        if (cancelled) { await conn.close(); return; }
        connRef.current = conn;
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
    // version was published under the same label only on a rebuild; a job's
    // app was built again — its hash moved).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.name, ws?.version, job?.job, job?.path, job?.hash, props.reload, wsScope?.token, ready]);

  useEffect(() => {
    connRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <div class="app-host">
      <iframe ref={frameRef} class="app-frame" sandbox="allow-scripts" title={ws ? ws.name : job!.path} />
      {state.status !== "ready" && (
        <div class={`app-host-overlay${state.status === "error" ? " is-error" : ""}`}>
          {state.status === "loading" ? "Loading the app…" : `The app could not be loaded: ${state.error}`}
        </div>
      )}
    </div>
  );
}
