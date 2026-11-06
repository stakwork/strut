import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { displayActor } from "../actor";
import { AppGlyph } from "../icons";
import { memberApps, soloAppHref } from "../page";

// ── A member's apps (plans/member-rights.md) ───────────────────────────────
//
// What a MEMBER sees who opens strut directly: a host signed them in as a
// member, whose session opens the apps here and nothing else, so the shell
// would be a wall of refusals. Each app opens alone (`?app=<name>&solo=1`),
// strut's own assistant first. To change an app, a member asks it.

export function MemberApps({ actor }: { actor?: string }) {
  const [apps, setApps] = useState<api.AppListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listApps().then(
      (listed) => setApps(memberApps(listed)),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  return (
    <div class="member-apps">
      <header class="member-apps-head">
        <h1>Apps</h1>
        {actor && <span class="member-apps-who">Signed in as {displayActor(actor)}</span>}
      </header>
      {error ? (
        <div class="empty">Could not list the apps: {error}</div>
      ) : apps === null ? (
        <div class="empty">Loading apps…</div>
      ) : apps.length === 0 ? (
        <div class="empty">No apps here yet.</div>
      ) : (
        <ul class="member-apps-list">
          {apps.map((app) => (
            <li key={app.name}>
              <a href={soloAppHref(app.name)}>
                <AppGlyph size={16} />
                <span class="member-apps-title">{app.title || app.name}</span>
                {app.description && <span class="member-apps-desc">{app.description}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
