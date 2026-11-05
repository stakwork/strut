// ── An app's versions, as a person reads them (plans/app-releases.md) ───────
//
// The Versions flyout (components/AppVersionsFlyout.tsx) and the topbar's
// chip draw from these. One row per page version, newest first, with the one
// state a person needs: live, was live (a release named it once — a version
// rolled back from too), or a draft (published while the app is held, after
// the live version, and never made live). Release ids
// (`r9`) are the server's bookkeeping and never a row of their own: a version
// that was live is restored through its newest release. No workflow version
// numbers anywhere — what a lock holds is a record, not something to read.
// Pure, so it is tested without a browser (app-versions.test.ts).

/** What `GET /apps/:name/versions` says, as far as these need it. */
export interface AppVersionsData {
  /** The live version. */
  active: string;
  versions: Record<string, { createdAt: string; source?: string }>;
  /** The live release's id, or `latest` while following. */
  live: string;
  /** Oldest first. */
  releases: Array<{ id: string; version: string; createdAt: string; by?: string }>;
}

export type AppVersionState = "live" | "draft" | "was-live" | "";

export interface AppVersionRow {
  version: string;
  createdAt: string;
  state: AppVersionState;
  /** The newest release of this version, which Restore makes live again. */
  release?: string;
}

/** `v12` → 12. */
export const versionNumber = (v: string): number => Number(v.replace(/^v/, "")) || 0;

/** Held at a release (a publish is a draft), or following latest. */
export const isHeld = (live: string | undefined): boolean => !!live && live !== "latest";

/** A version published after the live one while the app is held. */
export const isDraft = (version: string, active: string, live: string | undefined): boolean =>
  isHeld(live) && versionNumber(version) > versionNumber(active);

/** How many versions are newer than the live one while it is held, from the
 *  app list alone: the topbar's chip until the releases are read. */
export const draftCount = (versions: string[], active: string, live: string | undefined): number =>
  versions.filter((v) => isDraft(v, active, live)).length;

/** Strut seeds the app and makes its committed version live at every boot: it cannot be held. */
export const isSeeded = (data: AppVersionsData): boolean => data.versions[data.active]?.source === "seed";

/** The newest version published. */
export const newestVersion = (versions: string[]): string | undefined =>
  [...versions].sort((a, b) => versionNumber(b) - versionNumber(a))[0];

/** Every version, newest first, each in its state. */
export function appVersionRows(data: AppVersionsData): AppVersionRow[] {
  const newestRelease = new Map<string, string>();
  for (const r of data.releases) newestRelease.set(r.version, r.id);
  return Object.entries(data.versions)
    .sort(([a], [b]) => versionNumber(b) - versionNumber(a))
    .map(([version, info]) => {
      const release = newestRelease.get(version);
      const state: AppVersionState = version === data.active
        ? "live"
        : release
          ? "was-live"
          : isDraft(version, data.active, data.live) ? "draft" : "";
      return { version, createdAt: info.createdAt, state, ...(release ? { release } : {}) };
    });
}

/** The drafts the rows show: what the topbar's chip counts once read. */
export const draftsOf = (data: AppVersionsData): number => appVersionRows(data).filter((r) => r.state === "draft").length;

/** The release that is live while the app is held. */
export const liveRelease = (data: AppVersionsData) =>
  isHeld(data.live) ? data.releases.find((r) => r.id === data.live) : undefined;

export const STATE_LABEL: Record<AppVersionState, string> = {
  live: "live",
  draft: "draft",
  "was-live": "was live",
  "": "",
};

/** What making `version` live does, in the words the confirm button shows. */
export function makeLiveNote(version: string, live: string | undefined): string {
  return isHeld(live)
    ? `Everyone who opens the app gets ${version} now.`
    : `Everyone who opens the app gets ${version} now, and it stays there: later publishes wait as drafts until you make one live.`;
}

/** What Restore does: the version again, as its release recorded it. */
export const restoreNote = (version: string): string => `Everyone who opens the app gets ${version} again.`;

/** What switching to "every publish goes live" does. */
export function followNote(data: AppVersionsData): string {
  const newest = newestVersion(Object.keys(data.versions));
  return newest && newest !== data.active
    ? `Everyone gets ${newest}, the newest publish, now — and every later publish goes live as soon as it is published.`
    : "Every later publish goes live as soon as it is published.";
}

/** What switching to "hold a version" does. */
export const holdNote = (active: string): string =>
  `The app stays at ${active}. Later publishes wait as drafts until you make one live.`;

/** When something happened: relative within a day, then the date. */
export function when(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

/** The chip over an app in the side panel (components/AppWithPanel.tsx):
 *  the version shown and its state, and — on the live one — how many drafts
 *  wait. None for an app with one version that follows latest: nothing to
 *  look at but what is live. */
export function panelChip(shown: string, app: { activeVersion: string; versions: string[]; live?: string }): { label: string; drafts: number } | null {
  if (app.versions.length < 2 && !isHeld(app.live)) return null;
  const state = shown === app.activeVersion ? "live" : isDraft(shown, app.activeVersion, app.live) ? "draft" : "";
  return {
    label: state ? `${shown} · ${state}` : shown,
    drafts: shown === app.activeVersion ? draftCount(app.versions, app.activeVersion, app.live) : 0,
  };
}

/** The key the side panel opens a version of a local app at: the bare name
 *  for the live one (it follows what is live), `name@vN` for any other. */
export const panelKey = (name: string, version: string, active: string): string => (version === active ? name : `${name}@${version}`);
