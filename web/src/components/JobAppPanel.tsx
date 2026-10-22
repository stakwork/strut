import { useState } from "preact/hooks";
import { AppHost, type HostedApp } from "./AppHost";

// ── An app deliverable, in the job timeline (plans/apps.md §7.3) ───────────
//
// A `kind: "app"` deliverable is an app the builder published, by name and
// version. It renders through the same host component the Apps section uses
// (`AppHost` — the srcdoc frame, `AppBridge` to `/mcp`), reloaded when the
// deliverable's build hash moves on a refresh, or by hand.

export function JobAppPanel(props: {
  title: string;
  app: HostedApp & { hash?: string; builtAt?: string };
  /** `ui/open-link` with a strut deep link. */
  onNavigate?: (params: Record<string, string>) => void;
  /** Open the app under Apps. */
  onOpenApp?: (name: string) => void;
  /** Open the app large, in the viewer. */
  onExpand?: () => void;
  onClose?: () => void;
}) {
  const { app } = props;
  const [reload, setReload] = useState(0);
  return (
    <div class="job-app">
      <div class="job-app-bar">
        <span class="job-app-title">{props.title}</span>
        <span class="job-app-sub" title={app.hash ? `build ${app.hash}` : undefined}>
          {`${app.name} ${app.version}`}{app.builtAt ? ` · built ${new Date(app.builtAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
        <span class="job-app-actions">
          <button class="btn btn-sm" onClick={() => setReload((n) => n + 1)} title="Load the page again">Reload</button>
          {props.onExpand && <button class="btn btn-sm" onClick={props.onExpand} title="Open it large">Expand</button>}
          {props.onOpenApp && <button class="btn btn-sm" onClick={() => props.onOpenApp!(app.name)} title="Open it under Apps">Under Apps</button>}
          {props.onClose && <button class="btn btn-sm" onClick={props.onClose} title="Close the app">Close</button>}
        </span>
      </div>
      <div class="job-app-frame">
        <AppHost app={{ name: app.name, version: app.version }} reload={reload} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})} />
      </div>
    </div>
  );
}
