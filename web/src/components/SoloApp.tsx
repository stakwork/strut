import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { appToolInput, namesApp } from "../app-links";
import { replaceUrl } from "../embed";
import { useListedApp } from "../use-listed-app";
import { AppWithPanel } from "./AppWithPanel";

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
// `&theme=light` (or `dark`): the theme the app is handed, for a host whose
// own page is light; strut's UI is dark, the default. The page around it
// matches while the app loads; what strut draws in the side panel's bar and
// its file viewer stays strut's own.

export function SoloApp(props: { app: string; input?: string | null; visitor?: boolean; theme?: "light" | "dark" }) {
  const listed = useListedApp(props.visitor ? null : props.app);
  // undefined: the public view has not answered; null: the app is not in it.
  const [visitorApp, setVisitorApp] = useState<api.PublicAppInfo | null | undefined>(undefined);
  const shown = props.visitor
    ? visitorApp ? { name: visitorApp.name, version: visitorApp.version } : null
    : listed.app;
  const [input, setInput] = useState(props.input ?? null);
  /** A link to this same app (the kit's `appLink`): its input, in place,
   *  with the address bar following (replaced, as the full UI does) — so a
   *  host that reads it has the link to what is on screen. A file or
   *  another app never gets here (the panel took it); anything else opens
   *  in a new tab. */
  const onNavigate = (params: Record<string, string>) => {
    if (!shown || !namesApp(params["app"], shown)) return false;
    const next = params["input"] ?? null;
    const url = new URL(location.href);
    if (next) url.searchParams.set("input", next);
    else url.searchParams.delete("input");
    replaceUrl(`${url.pathname}${url.search}${url.hash}`);
    setInput(next);
  };
  const toolInput = appToolInput(input);
  useEffect(() => {
    if (!props.visitor) return;
    let on = true;
    api.getPublicApp(props.app).catch(() => null).then((info) => {
      if (on) setVisitorApp(info);
    });
    return () => {
      on = false;
    };
  }, [props.app, props.visitor]);
  return (
    <div class={`app-solo${props.theme === "light" ? " light" : ""}`}>
      {shown
        ? <AppWithPanel
            app={shown}
            onNavigate={onNavigate}
            {...(toolInput ? { toolInput } : {})}
            {...(props.visitor ? { visitor: true } : {})}
            {...(props.theme ? { theme: props.theme } : {})}
          />
        : <div class="empty">
            {props.visitor
              ? visitorApp === null ? `"${props.app}" is not in this server's public view` : "Loading the app…"
              : listed.entry === null ? `No app "${props.app}"` : "Loading apps…"}
          </div>}
    </div>
  );
}
