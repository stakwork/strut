import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { appKey, parseAppKey } from "../app-links";
import { AppHost } from "./AppHost";

// ── An app's page alone (plans/apps.md §7.4) ───────────────────────────────
//
// `?app=<key>&solo=1`: the page and nothing of strut's around it — what a
// native host (Peel) opens in a web view of its own. It reads the ONE
// listing the app is in — this strut's `GET /apps`, or that peer's through
// the read-through — and nothing else: no workflows, no step types, no other
// peer (one that does not answer would hold this app at "Loading apps…"),
// and no poll for as long as the page shows. No `ui/message` and no
// in-place link either: there is nothing of strut's to open them in.
// A key ending in `@vN` shows that version instead of the live one — how
// `app/look` sees a draft of a held app.

export function SoloApp(props: { app: string }) {
  // undefined: the listing has not answered; null: the app (or the version) is not in it.
  const [entry, setEntry] = useState<api.AppListEntry | null | undefined>(undefined);
  const ref = parseAppKey(props.app);
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
        ? <AppHost app={{ name: entry.name, version: ref?.version ?? entry.activeVersion, ...(entry.peer ? { peer: entry.peer } : {}) }} />
        : <div class="empty">{entry === null ? `No app "${props.app}"` : "Loading apps…"}</div>}
    </div>
  );
}
