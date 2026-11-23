// Where a deliverable shows (plans/jamie-app.md §4): what `strut/views`
// draws — markdown, text, an HTML page from its safe elements, an image, a
// table, a recording's frames, a Google Sheet — inline in the thread, read
// through `run/files` (or `sheets/get-values`); the rest — a PDF, a video, a
// page whose scripts should run, an app, another workspace's file — handed
// to the HOST as a strut deep link (`?artifact=<served path>`, `?app=<key>`),
// which opens it beside the app (the host's panel) or in its own page. Pure;
// tested by src/apps/jamie.test.ts.

import { artifactKind, peerArtifactPath } from "@strut/kit/folds";
import type { ArtifactRef, ConversationTurn } from "./types";

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

/** What a file reads as inline, or null for one the host shows: the kind
 *  the entry declares where it says more than the extension (a recording,
 *  a table), else the extension's. A table is drawn from CSV, TSV or JSON
 *  only: a spreadsheet file (`.xlsx`) goes to the host. */
export function inlineKind(path: string, kind?: string): InlineKind | null {
  if (kind === "captcha") return null;
  if (/\.(csv|tsv)$/i.test(path)) return "table";
  if (kind === "table") return /\.json$/i.test(path) ? "table" : null;
  if (kind === "walkthrough") return "walkthrough";
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

/** An app version's document as strut serves it: `/apps/<name>/<vN>/files/…`. */
const APP_DOCUMENT = /^\/apps\/(.+)\/(v\d+)\/files\//;

/** An app deliverable's host key: `name`, `name@vN`; `@<peer>/name` for
 *  another workspace's. An app named only by its document's link (a reply
 *  that copied the url) is read off the link. */
export function appKey(ref: ArtifactRef): string | null {
  const doc = !ref.app && !ref.peer && ref.url ? APP_DOCUMENT.exec(pathOf(ref.url)) : null;
  const app = ref.app ?? (doc ? { name: decodeURIComponent(doc[1]!), version: doc[2]! } : undefined);
  if (!app?.name) return null;
  const name = ref.peer ? `@${ref.peer}/${app.name}` : app.name;
  return app.version && !ref.peer ? `${name}@${app.version}` : name;
}

/** A deliverable that opens something: a link, words, an app, or another
 *  workspace's file. One with none of them — a copy that kept only a title,
 *  a file that is not there — is no card among a reply's own. */
export function openable(ref: ArtifactRef): boolean {
  return !!ref.url || ref.content !== undefined || !!ref.app || !!(ref.peer && ref.path);
}

/** A JOB's deliverable has a card even when strut could not resolve it: it
 *  says why (a file that is not there, an app not published) rather than
 *  vanishing from what the job made. */
export function carded(ref: ArtifactRef): boolean {
  return openable(ref) || !!ref.error;
}

/** Declared kinds whose words are plain text, never markdown. */
const TEXT_KINDS = new Set(["text", "code", "diff", "log", "json", "yaml", "csv", "tsv"]);

/** What a card says it is, in a word: the agent's own `label` ("Plan",
 *  "Screenshot") when it gave one, else its kind's. Empty for a page of
 *  words, whose title says it all. */
export function cardWord(ref: Pick<ArtifactRef, "kind" | "label">, path = ""): string {
  if (ref.label) return ref.label;
  const kind = ref.kind === "url" || !ref.kind ? (artifactKind(path) ?? "") : ref.kind;
  return KIND_WORDS[kind] ?? (kind === "directory" ? "folder" : "file");
}

const KIND_WORDS: Record<string, string> = {
  markdown: "", text: "", html: "page", image: "image", video: "video", audio: "audio", pdf: "PDF",
  walkthrough: "recording", table: "table", sheet: "sheet", docx: "document", redline: "redline",
  code: "code", diff: "diff", log: "log", json: "JSON", app: "app", captcha: "captcha", pull_request: "pull request",
};

/** Two entries for the same thing: one id, one link, or one app. */
function same(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.id === b.id || (!!a.url && !!b.url && pathOf(a.url) === pathOf(b.url)) || (!!a.app && !!b.app && a.app.name === b.app.name);
}

/** A card, and the job it came from when known (a pull request's Fix asks it). */
export interface Shown {
  artifact: ArtifactRef;
  job?: string;
}

/**
 * What a turn shows: under a wake's reply, what the job run(s) it woke on
 * delivered (`delivered`, a failed one saying why); then the reply's own
 * deliverables, less any of those again — the reply's copy of a deliverable
 * shows once, as the job made it — and only those that open something.
 */
export function turnDeliverables(turn: Pick<ConversationTurn, "artifacts" | "delivered">): { delivered: Shown[]; own: Shown[] } {
  const delivered = (turn.delivered ?? []).flatMap((d) => d.artifacts.filter(carded).map((artifact) => ({ artifact, job: d.job })));
  const own = (turn.artifacts ?? []).filter((a) => openable(a) && !delivered.some((d) => same(a, d.artifact))).map((artifact) => ({ artifact }));
  return { delivered, own };
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
    // Words are markdown unless their kind is plain text: a diff's `-`/`+`
    // lines are not a list.
    return { show: "content", kind: typeof ref.content === "string" && !TEXT_KINDS.has(ref.kind) ? "markdown" : "text", text };
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
  // A document's rendition (`render`: the HTML strut made of a docx or a
  // redline) is what draws inline; the file itself still opens beside.
  const rendition = ref.render ? servedFile(ref.render) : null;
  if (rendition && /\.html?$/i.test(rendition.rel) && (run || job)) {
    return { show: "file", kind: "html", path: rendition.rel, ...(run ? { run } : {}), ...(job ? { job } : {}) };
  }
  // A recording listed by its directory plays from the manifest inside.
  const rel = ref.kind === "walkthrough" && !served.rel.endsWith("walkthrough.json") ? `${served.rel.replace(/\/+$/, "")}/walkthrough.json` : served.rel;
  const kind = inlineKind(rel, ref.kind);
  // A served file the page cannot read without a run (an `/artifacts/` path
  // of a run the turn does not know) or cannot draw: the host shows it.
  if (!kind || (!run && !job)) return { show: "link", href: artifactLink(pathOf(url)), external: false, what: cardWord(ref, served.rel) };
  return { show: "file", kind, path: rel, ...(run ? { run } : {}), ...(job ? { job } : {}) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "link";
  }
}


// ── How a set of deliverables lays out (Hive's ChatArtifacts) ─────────────
// Pictures in a strip of thumbnails — an image, a recording, a video — so a
// glance shows what the job saw; things to act on or open (a page, a pull
// request, an app, a link) as rows; reference material (a log, JSON, code,
// a diff) folded into one line, "3 more · Log, JSON", each name opening it.

export type Placement = "thumb" | "row" | "folded";

const FOLDED_KINDS = new Set(["log", "json", "code", "diff", "yaml"]);

/** Where one deliverable sits, by where it shows (`placeArtifact`). */
export function placementOf(ref: Pick<ArtifactRef, "kind" | "url">, place: ArtifactPlace): Placement {
  if (place.show === "file" && (place.kind === "image" || place.kind === "walkthrough")) return "thumb";
  if (place.show === "link" && !place.external && (ref.kind === "video" || artifactKind(pathOf(ref.url ?? "")) === "video")) return "thumb";
  if ((place.show === "file" || place.show === "content") && place.kind === "text" && FOLDED_KINDS.has(ref.kind)) return "folded";
  return "row";
}

/** A claim's evidence (`latest.locator`), as the claim draws it: a
 *  screenshot or a recording in place, any other file or page a link. */
export type Evidence = { show: "image" | "walkthrough"; path: string; href: string } | { show: "link"; href: string; external: boolean } | null;

export function evidenceOf(locator: { url?: string; file?: string } | undefined): Evidence {
  const url = locator?.url;
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return { show: "link", href: url, external: true };
  const served = servedFile(url);
  if (!served) return null;
  const k = artifactKind(served.rel);
  if (k === "image" || k === "walkthrough") return { show: k, path: served.rel, href: artifactLink(pathOf(url)) };
  return { show: "link", href: artifactLink(pathOf(url)), external: false };
}
