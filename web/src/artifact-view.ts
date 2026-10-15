// ── What the artifact viewer can render inline ─────────────────────────────
//
// A step's output names a file it wrote as `/artifacts/<runId>/<relPath>`.
// The link opens the raw file in a new tab; the eye beside it opens the file
// in a modal RENDERED — markdown as markdown, an image as an image — for the
// obvious file types. Decided by extension alone (the server's content-type
// map is the same shape); anything else gets no eye — except a DIRECTORY,
// which the listing of the scope's files reveals (`viewerKind`): the viewer
// shows it as one level of folders and files.
//
// A path may also sit INSIDE a value — `{ report_md: "/artifacts/…" }`, an
// array of paths, an array of `{ link }` objects — so `findArtifacts` walks a
// value and collects every one; a block holding several gets one eye with a
// pop-down to pick from.
//
// The viewer moves between the files of ONE scope — a run's artifacts or a
// job's files. A link in a markdown file resolves against that file's
// directory (`resolveArtifactLink`); a directory row opens what it names.
// Nothing here leaves the scope: an external URL stays a link, and another
// run's files are not this run's.

export type ArtifactKind = "markdown" | "image" | "video" | "audio" | "pdf" | "html" | "text" | "walkthrough" | "directory";

const BY_EXT: Record<string, ArtifactKind> = {
  md: "markdown", markdown: "markdown",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio",
  pdf: "pdf",
  html: "html", htm: "html",
  txt: "text", json: "text", csv: "text", tsv: "text", yaml: "text", yml: "text",
  toml: "text", xml: "text", log: "text", vtt: "text", srt: "text", diff: "text",
  patch: "text", js: "text", ts: "text", py: "text", sh: "text",
};

/** A recording's manifest (`browser/walkthrough`, plans/live-artifacts.md
 *  §4) is known by its NAME — a `.json` that is a walkthrough. The server's
 *  `artifactKind` reads it the same way (`src/artifact-refs.ts`). */
const WALKTHROUGH_MANIFEST = "walkthrough.json";

/** The inline viewer for an artifact path by its extension, or null when
 *  there is none (unknown extension, no extension, a dotfile). Never
 *  "directory": that takes the listing (`viewerKind`). */
export function artifactKind(path: string): ArtifactKind | null {
  const file = path.split("/").pop() ?? "";
  if (file === WALKTHROUGH_MANIFEST) return "walkthrough";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXT[file.slice(dot + 1).toLowerCase()] ?? null;
}

/** True for a served-file path as steps put it in their output — a run's
 *  `/artifacts/<runId>/<relPath>` (see `ctx.services.artifacts`) or a job's
 *  `/jobs/<job>/files/<relPath>` (`job/dir`). */
export function isArtifactPath(v: unknown): v is string {
  return typeof v === "string" && (v.startsWith("/artifacts/") || v.startsWith("/jobs/"));
}

/** The scope a served-file path reads from — `/artifacts/<runId>` or
 *  `/jobs/<id>/files` — whose listing names every file under it and mints
 *  the token for them; null for anything else. */
export function fileScopeOf(path: string): string | null {
  const m = path.match(/^\/artifacts\/[^/]+/) ?? path.match(/^\/jobs\/[^/]+\/files/);
  return m ? m[0] : null;
}

/** The path within its scope, as the listing spells it — `chapters/README.md`
 *  for `/artifacts/1790/chapters/README.md`, `book` for `/artifacts/1790/book/`,
 *  "" for the scope itself; null for a path that is not a served file. */
export function artifactRel(path: string): string | null {
  const scope = fileScopeOf(path);
  if (scope == null) return null;
  return path.slice(scope.length).replace(/^\/+|\/+$/g, "");
}

/** The path without its serving prefix — `systemmap/report.md` for
 *  `/artifacts/1790/systemmap/report.md` — short enough for a menu item and
 *  unambiguous within one run. The whole path when nothing follows the prefix. */
export function artifactLabel(path: string): string {
  const rel = path.replace(/^\/artifacts\/[^/]+\/|^\/jobs\/[^/]+\/files\//, "");
  return rel && rel !== path ? rel : path;
}

/** True when `path` names a directory of its scope: `files` — the scope's
 *  listing, paths within it — has something under it. The scope's root is
 *  one. A file with no extension is not, whatever its name. */
export function isDirectory(files: string[], path: string): boolean {
  const rel = artifactRel(path);
  if (rel == null) return false;
  if (rel === "") return true;
  const prefix = rel + "/";
  return files.some((f) => f.startsWith(prefix));
}

/** What the viewer shows for a path: `artifactKind`, else "directory" when
 *  the scope's listing has files under it. Null when nothing renders it —
 *  or, for a path with no extension, while the listing is not in yet. */
export function viewerKind(path: string, files: string[] | null): ArtifactKind | null {
  return artifactKind(path) ?? (files && isDirectory(files, path) ? "directory" : null);
}

/** One level of a directory in a listing: the names of the folders and of
 *  the files directly inside `dir` (a path within the scope; "" for its
 *  root), each sorted. */
export function directoryEntries(files: string[], dir: string): { dirs: string[]; files: string[] } {
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
  const dirs = new Set<string>();
  const leaves: string[] = [];
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) { if (rest) leaves.push(rest); }
    else if (slash > 0) dirs.add(rest.slice(0, slash));
  }
  return { dirs: [...dirs].sort(), files: leaves.sort() };
}

/** Where a link in a served file leads: the served path in the SAME scope —
 *  a relative href resolved against the file's directory (`.` and `..`
 *  folded, a `?query` or `#fragment` dropped, percent-encoding decoded), or
 *  an absolute `/artifacts/…` / `/jobs/…/files/…` path of that scope. Null
 *  for anything else — an external URL, a bare `#anchor`, a path that climbs
 *  out of the scope, another run's files — so the caller leaves it a plain
 *  link. A trailing slash is kept: the link named a directory. */
export function resolveArtifactLink(from: string, href: string): string | null {
  const scope = fileScopeOf(from);
  if (scope == null) return null;
  let target = href.trim().split("#")[0]!.split("?")[0]!;
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  try { target = decodeURIComponent(target); } catch { return null; }
  const trailing = target.endsWith("/");
  let segments: string[];
  if (target.startsWith("/")) {
    if (target !== scope && !target.startsWith(scope + "/")) return null;
    segments = [];
    target = target.slice(scope.length);
  } else {
    const rel = artifactRel(from) ?? "";
    segments = rel ? rel.split("/") : [];
    if (!from.endsWith("/")) segments.pop(); // a file's links resolve against its directory
  }
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  const path = `${scope}/${segments.join("/")}`;
  return segments.length && trailing ? path + "/" : path;
}

const MAX_DEPTH = 8;
const MAX_FOUND = 40;

/** Every artifact path anywhere in `value` — a bare string, object fields,
 *  array items, nested — in encounter order, deduped. Bounded in depth and
 *  count so a huge output stays cheap to render. */
export function findArtifacts(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (found.length >= MAX_FOUND) return;
    if (isArtifactPath(v)) {
      if (!seen.has(v)) { seen.add(v); found.push(v); }
      return;
    }
    if (depth >= MAX_DEPTH || typeof v !== "object" || v === null) return;
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, depth + 1);
  };
  walk(value, 0);
  return found;
}

// ── Walkthroughs ───────────────────────────────────────────────────────────
//
// `browser/walkthrough` records a directory: one PNG per captioned step and
// a `walkthrough.json` naming them in order (plans/live-artifacts.md §4).
// The viewer scrubs through the frames; this reads the manifest, tolerant of
// a half-written one (a recording in progress is rewritten after each frame).

export interface WalkthroughFrame {
  /** The frame's served path, in the manifest's scope. */
  path: string;
  caption: string;
  pageUrl?: string;
  ms?: number;
  /** Set on the frame where the recording stopped: why. */
  failed?: string;
}

export interface Walkthrough {
  title?: string;
  url?: string;
  /** "recording" | "done" | "stopped" — passed through. */
  status?: string;
  frames: WalkthroughFrame[];
  failed: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A manifest's text → its frames, each resolved against the manifest's
 *  directory (`resolveArtifactLink`): a frame that names a file outside the
 *  scope, or no file, is dropped. Null when the text is not a manifest. */
export function parseWalkthrough(text: string, manifestPath: string): Walkthrough | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { frames?: unknown }).frames)) return null;
  const m = raw as Record<string, unknown>;
  const frames: WalkthroughFrame[] = [];
  for (const f of m["frames"] as unknown[]) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    const file = str(r["file"]);
    const path = file ? resolveArtifactLink(manifestPath, file) : null;
    if (!path) continue;
    frames.push({
      path,
      caption: str(r["caption"]) ?? "",
      ...(str(r["pageUrl"]) ? { pageUrl: r["pageUrl"] as string } : {}),
      ...(typeof r["ms"] === "number" ? { ms: r["ms"] } : {}),
      ...(str(r["failed"]) ? { failed: r["failed"] as string } : {}),
    });
  }
  const failed = Array.isArray(m["failed"]) ? (m["failed"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    ...(str(m["title"]) ? { title: m["title"] as string } : {}),
    ...(str(m["url"]) ? { url: m["url"] as string } : {}),
    ...(str(m["status"]) ? { status: m["status"] as string } : {}),
    frames,
    failed,
  };
}
