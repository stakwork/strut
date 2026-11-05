import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import { appKey, isPreviewVersion, parseAppKey } from "./app-links";
import type { HostedApp } from "./components/AppHost";

/** The app an `?app=` key names, at the version to show — what the page
 *  alone (`?solo=1`) and the app host's side panel host. It reads the ONE
 *  listing the app is in — this strut's `GET /apps`, or that peer's through
 *  the read-through — and nothing else. A key ending in `@vN` is that
 *  version instead of the live one (a draft, for `app/look`); one ending in
 *  `@preview-<hex>` an unpublished build `app/look { path }` hosts, which no
 *  listing holds, so it is not read. `entry` is undefined until the listing
 *  answers, null when the app (or the version) is not in it; `app` is what
 *  to host. Null `key`: nothing read. */
export function useListedApp(key: string | null): { app: HostedApp | null; entry: api.AppListEntry | null | undefined } {
  const [state, setState] = useState<{ key: string; entry: api.AppListEntry | null } | null>(null);
  const ref = key ? parseAppKey(key) : null;
  const preview = !!ref && !ref.peer && isPreviewVersion(ref.version);
  useEffect(() => {
    if (!key) return;
    if (!ref || preview) {
      setState({ key, entry: null });
      return;
    }
    let on = true;
    (ref.peer ? api.listPeerApps(ref.peer) : api.listApps())
      .catch((): api.AppListEntry[] => [])
      .then((apps) => {
        const found = apps.find((a) => appKey(a) === appKey(ref));
        if (on) setState({ key, entry: found && (!ref.version || found.versions.includes(ref.version)) ? found : null });
      });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const entry = key && state?.key === key ? state.entry : undefined;
  const app: HostedApp | null = preview
    ? { name: ref!.name, version: ref!.version! }
    : entry
      ? { name: entry.name, version: ref?.version ?? entry.activeVersion, ...(entry.peer ? { peer: entry.peer } : {}) }
      : null;
  return { app, entry };
}
