import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { AppHost } from "./AppHost";

// ── A job's app, in the job timeline (plans/apps.md §6, §7.3) ──────────────
//
// A `kind: "app"` deliverable is a live directory in the job's: rendered
// through the same host component a workspace app is (`AppHost` — the
// srcdoc frame, `AppBridge` to `/mcp`), reloaded when the deliverable's
// build hash moves on a refresh, or by hand. "Publish as an app" is a
// PERSON's door: `POST /apps { name, job, path }` makes the directory the
// workspace app's next version (its data along when the app has none).

/** A name for the workspace app, from the directory: its last segment. */
export function appNameFor(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? "app";
  return last.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "app";
}

export function JobAppPanel(props: {
  title: string;
  app: api.JobAppRef;
  /** `ui/open-link` with a strut deep link. */
  onNavigate?: (params: Record<string, string>) => void;
  /** The app was published (the Apps list wants a refresh). */
  onPublished?: (name: string) => void;
  /** Open a published app under Apps. */
  onOpenApp?: (name: string) => void;
  /** Open the app large, in the viewer. */
  onExpand?: () => void;
  onClose?: () => void;
}) {
  const { app } = props;
  const [reload, setReload] = useState(0);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [published, setPublished] = useState<{ name: string; version: string } | null>(null);
  useEffect(() => { setName(null); setError(""); setPublished(null); }, [app.job, app.path]);

  const publish = async () => {
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.publishJobApp(name.trim(), app.job, app.path);
      setPublished({ name: r.name, version: r.version });
      setName(null);
      props.onPublished?.(r.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="job-app">
      <div class="job-app-bar">
        <span class="job-app-title">{props.title}</span>
        <span class="job-app-sub" title={app.hash ? `build ${app.hash}` : undefined}>
          {app.path}{app.builtAt ? ` · built ${new Date(app.builtAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
        <span class="job-app-actions">
          <button class="btn btn-sm" onClick={() => setReload((n) => n + 1)} title="Load the page again">Reload</button>
          {props.onExpand && <button class="btn btn-sm" onClick={props.onExpand} title="Open it large">Expand</button>}
          <button
            class="btn btn-sm"
            onClick={() => { setPublished(null); setError(""); setName((n) => (n === null ? appNameFor(app.path) : null)); }}
            title="Make this directory a workspace app's next version — it then opens under Apps"
          >Publish as an app</button>
          {props.onClose && <button class="btn btn-sm" onClick={props.onClose} title="Close the app">Close</button>}
        </span>
      </div>
      {name !== null && (
        <form class="job-app-publish" onSubmit={(e) => { e.preventDefault(); void publish(); }}>
          <label>
            App name
            <input
              value={name}
              placeholder="visits"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              disabled={busy}
            />
          </label>
          <button type="submit" class="btn btn-sm btn-primary" disabled={busy || !name.trim()}>{busy ? "Publishing…" : "Publish"}</button>
          <span class="job-app-note">A new name is v1; an existing app's name makes its next version.</span>
        </form>
      )}
      {error && <div class="claim-error">{error}</div>}
      {published && (
        <div class="job-app-note">
          Published <b>{published.name}</b> {published.version}.{" "}
          {props.onOpenApp && <button class="turn-link" onClick={() => props.onOpenApp!(published.name)}>Open it under Apps</button>}
        </div>
      )}
      <div class="job-app-frame">
        <AppHost app={app} reload={reload} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})} />
      </div>
    </div>
  );
}
