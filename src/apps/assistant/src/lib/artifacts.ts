// Where a deliverable shows (plans/jamie-app.md §4): what `strut/views`
// draws — markdown, text, an HTML page from its safe elements, an image, a
// table, a recording's frames, a Google Sheet — inline in the thread, read
// through `run/files` (or `sheets/get-values`); the rest — a PDF, a video, a
// page whose scripts should run, an app, another workspace's file — handed
// to the HOST as a strut deep link (`?artifact=<served path>`, `?app=<key>`),
// which opens it beside the app (the host's panel) or in its own page. Pure;
// tested by src/apps/assistant.test.ts.

import { artifactKind, peerArtifactPath } from "@strut/kit/folds";
import type { ArtifactRef } from "./types";

/** A run whose files a served path is read through (`run/files`). */
export interface FileRun {
  workflow: string;
  runId: string;
}

export type InlineKind = "markdown" | "html" | "text" | "image" | "table" | "walkthrough";

export type ArtifactPlace =
  /** Read through `run/files` — `run` when the turn knows one, else the
   *  card finds a run of `job` (`job/get`). */
  | { show: "file"; kind: InlineKind; path: string; run?: FileRun; job?: string }
  /** Words the artifact carries itself. */
  | { show: "content"; kind: "markdown" | "text"; text: string }
  /** A Google Sheet, drawn by SheetView. */
  | { show: "sheet"; spreadsheet: string }
  /** A captcha a person answers (src/browser/captcha.ts's manifest). */
  | { show: "captcha"; job: string; path: string; run?: FileRun }
  /** The host opens it: a strut deep link, or a link out. */
  | { show: "link"; href: string; external: boolean; what: string }
  | { show: "missing"; text: string };

const SHEET = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/;

/** A served path without its query: `/jobs/<job>/files/…` or
 *  `/artifacts/<runId>/…` (a token is never part of what we pass on). */
const pathOf = (url: string) => url.split(/[?#]/, 1)[0]!;

/** `/jobs/<job>/files/<rel>` → job + rel; `/artifacts/<runId>/<rel>` → runId + rel. */
export function servedFile(url: string): { job: string; rel: string } | { runId: string; rel: string } | null {
  const p = pathOf(url);
  let m = /^\/jobs\/([^/]+)\/files\/(.+)$/.exec(p);
  if (m) return { job: decodeURIComponent(m[1]!), rel: m[2]! };
  m = /^\/artifacts\/([^/]+)\/(.+)$/.exec(p);
  if (m) return { runId: decodeURIComponent(m[1]!), rel: m[2]! };
  return null;
}

/** What a file's extension reads as inline, or null for one the host shows. */
export function inlineKind(path: string, kind?: string): InlineKind | null {
  if (kind === "captcha") return null;
  if (/\.(csv|tsv)$/i.test(path) || kind === "table") return "table";
  const k = artifactKind(path);
  switch (k) {
    case "markdown":
    case "html":
    case "text":
    case "image":
    case "walkthrough":
      return k;
    default:
      return null;
  }
}

/** An app deliverable's host key: `name`, `name@vN`; `@<peer>/name` for another workspace's. */
export function appKey(ref: ArtifactRef): string | null {
  if (!ref.app?.name) return null;
  const name = ref.peer ? `@${ref.peer}/${ref.app.name}` : ref.app.name;
  return ref.app.version && !ref.peer ? `${name}@${ref.app.version}` : name;
}

/** A deep link the host follows (`ui/open-link`), relative to strut's UI. */
export const artifactLink = (servedPath: string) => `?artifact=${encodeURIComponent(servedPath)}`;
export const appLink = (key: string) => `?app=${encodeURIComponent(key)}`;

/**
 * Where `ref` shows. `runs` are the runs the turn knows, by job and by run
 * id (its own, the jobs it started, the job run a wake woke on), so a file's
 * bytes are read through the right run.
 */
export function placeArtifact(
  ref: ArtifactRef,
  runs: { byJob: ReadonlyMap<string, FileRun>; byRun: ReadonlyMap<string, FileRun> },
): ArtifactPlace {
  if (ref.kind === "app" || ref.app) {
    const key = appKey(ref);
    return key ? { show: "link", href: appLink(key), external: false, what: "app" } : { show: "missing", text: ref.error ?? "This app is not published here." };
  }
  // Another workspace's: its path is THAT strut's, opened through this one's read-through.
  if (ref.peer) {
    const through = peerArtifactPath(ref);
    if (through) return { show: "link", href: artifactLink(through), external: false, what: `@${ref.peer}` };
    if (ref.url && /^https?:\/\//i.test(ref.url)) return { show: "link", href: ref.url, external: true, what: `@${ref.peer}` };
    return { show: "missing", text: `In @${ref.peer}: ${ref.error ?? "nothing to open here"}` };
  }
  if (ref.error && !ref.url && ref.content === undefined) return { show: "missing", text: ref.error };
  if (ref.content !== undefined && ref.url === undefined) {
    const text = typeof ref.content === "string" ? ref.content : JSON.stringify(ref.content, null, 2);
    return { show: "content", kind: typeof ref.content === "string" && ref.kind !== "text" ? "markdown" : "text", text };
  }
  const url = ref.url ?? "";
  const sheet = SHEET.exec(url);
  if (sheet) return { show: "sheet", spreadsheet: sheet[1]! };
  if (/^https?:\/\//i.test(url)) return { show: "link", href: url, external: true, what: hostOf(url) };
  const served = servedFile(url);
  if (!served) return { show: "missing", text: ref.error ?? "Nothing to open." };
  const run = "job" in served ? runs.byJob.get(served.job) : runs.byRun.get(served.runId);
  const job = "job" in served ? served.job : undefined;
  if (ref.kind === "captcha" && job) return { show: "captcha", job, path: served.rel, ...(run ? { run } : {}) };
  const kind = inlineKind(served.rel, ref.kind);
  // A served file the page cannot read without a run (an `/artifacts/` path
  // of a run the turn does not know) or cannot draw: the host shows it.
  if (!kind || (!run && !job)) return { show: "link", href: artifactLink(pathOf(url)), external: false, what: kindWord(served.rel) };
  return { show: "file", kind, path: served.rel, ...(run ? { run } : {}), ...(job ? { job } : {}) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "link";
  }
}

/** A file the host opens, in a word: "PDF", "video", "file". */
export function kindWord(path: string): string {
  const k = artifactKind(path);
  return k === "pdf" ? "PDF" : k === "video" ? "video" : k === "audio" ? "audio" : k === "directory" ? "folder" : "file";
}
