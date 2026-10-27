import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { appKey, appToolInput, namesApp, parseAppKey } from "../app-links";
import { replaceUrl } from "../embed";
import { AppHost } from "./AppHost";

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
// instead of the live one — how `app/look` sees a draft of a held app.
// `?input=` is what the page is opened with (its `tool-input`).

export function SoloApp(props: { app: string; input?: string | null }) {
  // undefined: the listing has not answered; null: the app (or the version) is not in it.
  const [entry, setEntry] = useState<api.AppListEntry | null | undefined>(undefined);
  const ref = parseAppKey(props.app);
  const hosted = (e: api.AppListEntry) => ({ name: e.name, version: ref?.version ?? e.activeVersion, ...(e.peer ? { peer: e.peer } : {}) });
  const [input, setInput] = useState(props.input ?? null);
  /** A link to this same app (the kit's `appLink`): its input, in place,
   *  with the address bar following (replaced, as the full UI does) — so a
   *  host that reads it has the link to what is on screen. Anything else
   *  opens in a new tab. */
  const onNavigate = (params: Record<string, string>) => {
    if (!entry || !namesApp(params["app"], hosted(entry))) return false;
    const next = params["input"] ?? null;
    const url = new URL(location.href);
    if (next) url.searchParams.set("input", next);
    else url.searchParams.delete("input");
    replaceUrl(`${url.pathname}${url.search}${url.hash}`);
    setInput(next);
  };
  const toolInput = appToolInput(input);
  useEffect(() => {
    if (!ref) {
      setEntry(null);
      return;
    }
    let on = true;
    (ref.peer ? api.listPeerApps(ref.peer) : api.listApps())
      .catch((): api.AppListEntry[] => [])
      .then((apps) => {
        const found = apps.find((a) => appKey(a) === appKey(ref));
        if (on) setEntry(found && (!ref.version || found.versions.includes(ref.version)) ? found : null);
      });
    return () => {
      on = false;
    };
  }, [props.app]);
  return (
    <div class="app-solo">
      {entry
        ? <AppHost
            app={hosted(entry)}
            onNavigate={onNavigate}
            {...(toolInput ? { toolInput } : {})}
          />
        : <div class="empty">{entry === null ? `No app "${props.app}"` : "Loading apps…"}</div>}
    </div>
  );
}
