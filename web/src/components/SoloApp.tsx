import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { appToolInput, namesApp, publicAppHop } from "../app-links";
import { replaceUrl, reportReady } from "../embed";
import { useListedApp } from "../use-listed-app";
import { AppWithPanel } from "./AppWithPanel";
import { words } from "../words";

// ── An app's page alone (plans/apps.md §7.4) ───────────────────────────────
//
// `?app=<key>&solo=1`: the page and nothing of strut's around it — what a
// native host (Peel) opens in a web view of its own. It reads the ONE
// listing the app is in — this strut's `GET /apps`, or that peer's through
// the read-through — and nothing else: no workflows, no step types, no other
// peer (one that does not answer would hold this app at "Loading apps…"),
// and no poll for as long as the page shows. No `ui/message`, and of the
// page's links only one to itself opens in place: there is nothing of
// strut's to open the rest in. A key ending in `@vN` shows that version
// instead of the live one — how `app/look` sees a draft of a held app — and
// one ending in `@preview-<hex>` an unpublished build `app/look { path }`
// hosts, which no listing holds (a new app has none), so it is not read.
// `?input=` is what the page is opened with (its `tool-input`).
//
// `&public=1`: a VISITOR's page (plans/public-surface.md §5) — the app as
// this server's public view serves it, read with no credential: its info
// and document under `/public/apps/<name>`, its calls to `/public/mcp`.
// What the store frames from a publisher's server, and what a person with
// no account opens.
//
// `&public=1&from=<base>`: a visitor's page of ANOTHER strut server
// (../remote-app, specs/API.md §17.9) — read from that server, its calls
// relayed there, a priced launch paid HERE (Peel's wallet with one tap,
// else a QR code), with this page as the trusted host: the stranger's
// server runs nothing here but its sandboxed frame. Always alone (`solo` is
// implied). A `from` this host does not open says so, and never falls back
// to an app of the same name here.
//
// On a visitor's page, a link to ANOTHER app of this server's public view
// opens that app here, in place (`publicAppHop`): the same page, `solo` and
// `public` kept, the address the browser's — or Peel's web view's — history
// goes Back through, and `&back=<the app it came from>`, for which this page
// draws a Back bar over the app. A worker's dashboard (strut/worker) lists
// every app's task types and opens a type of another app this way.
//
// `&theme=light` (or `dark`): the theme the app is handed, for a host whose
// own page is light; strut's UI is dark, the default. The page around it
// matches while the app loads; what strut draws in the side panel's bar and
// its file viewer stays strut's own.

export function SoloApp(props: { app: string; input?: string | null; visitor?: boolean; from?: string; theme?: "light" | "dark" }) {
  const from = props.from;
  const visitor = !!props.visitor || !!from;
  const listed = useListedApp(visitor ? null : props.app);
  // undefined: the public view has not answered; null: the app is not in it.
  const [visitorApp, setVisitorApp] = useState<api.PublicAppInfo | null | undefined>(undefined);
  /** Why another server's app could not be read (it did not answer). */
  const [readError, setReadError] = useState<string | null>(null);
  const shown = visitor
    ? visitorApp ? { name: visitorApp.name, version: visitorApp.version, title: visitorApp.title, ...(from ? { from } : {}) } : null
    : listed.app;
  const [input, setInput] = useState(props.input ?? null);
  /** The app this page was opened from (`&back=`), on a visitor's page: Back returns there. */
  const [back] = useState(() => (visitor && !from ? new URLSearchParams(location.search).get("back") : null));
  /** A link to this same app (the kit's `appLink`): its input, in place,
   *  with the address bar following (replaced, as the full UI does) — so a
   *  host that reads it has the link to what is on screen. A file or
   *  another app never gets here (the panel took it); anything else opens
   *  in a new tab. */
  const onNavigate = (params: Record<string, string>) => {
    if (!shown) return false;
    if (!namesApp(params["app"], shown)) {
      const hop = visitor && !from ? publicAppHop(params, shown.name, location.href) : null;
      if (!hop) return false;
      location.assign(hop);
      return;
    }
    const next = params["input"] ?? null;
    const url = new URL(location.href);
    if (next) url.searchParams.set("input", next);
    else url.searchParams.delete("input");
    replaceUrl(`${url.pathname}${url.search}${url.hash}`);
    setInput(next);
  };
  const toolInput = appToolInput(input);
  useEffect(() => {
    if (!visitor) return;
    let on = true;
    setReadError(null);
    (from ? api.getRemotePublicApp(from, props.app) : api.getPublicApp(props.app).catch(() => null)).then(
      (info) => {
        if (on) setVisitorApp(info);
      },
      (err) => {
        if (!on) return;
        setReadError(err instanceof Error ? err.message : String(err));
        setVisitorApp(null);
      },
    );
    return () => {
      on = false;
    };
  }, [props.app, visitor, from]);
  // Nothing to wait for: the page says why there is no app.
  const missing = visitor ? visitorApp === null : listed.entry === null;
  const server = from ? hostOf(from) : words.thisServer;
  useEffect(() => {
    if (missing) reportReady();
  }, [missing]);
  const goBack = () => {
    if (history.length > 1) history.back();
    else if (back) location.replace(publicAppHop({ app: back }, shown?.name ?? props.app, location.href, { back: false }) ?? location.href);
  };
  return (
    <div class={`app-solo${back && shown ? " has-back" : ""}`}>
      {back && shown && (
        <button type="button" class="app-solo-back" onClick={goBack}>
          <span aria-hidden="true">←</span> {words.back}
        </button>
      )}
      {shown
        ? <AppWithPanel
            app={shown}
            onNavigate={onNavigate}
            {...(toolInput ? { toolInput } : {})}
            {...(visitor ? { visitor: true } : {})}
            {...(props.theme ? { theme: props.theme } : {})}
            onReady={reportReady}
          />
        : <div class="empty">
            {visitor
              ? visitorApp === null ? readError ?? words.notPublic(props.app, server) : words.loadingApp
              : listed.entry === null ? words.noApp(props.app) : words.loadingApps}
          </div>}
    </div>
  );
}

const hostOf = (base: string) => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};
