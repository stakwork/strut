// ── What the artifact viewer can render inline ─────────────────────────────
//
// A step's output names a file it wrote as `/artifacts/<runId>/<relPath>`.
// The link opens the raw file in a new tab; the eye beside it opens the file
// in a modal RENDERED — markdown as markdown, an image as an image — for the
// obvious file types. Decided by extension alone (the server's content-type
// map is the same shape); anything else gets no eye.
//
// A path may also sit INSIDE a value — `{ report_md: "/artifacts/…" }`, an
// array of paths, an array of `{ link }` objects — so `findArtifacts` walks a
// value and collects every one; a block holding several gets one eye with a
// pop-down to pick from.

export type ArtifactKind = "markdown" | "image" | "video" | "audio" | "pdf" | "html" | "text";

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

/** The inline viewer for an artifact path, or null when there is none
 *  (unknown extension, no extension, a dotfile). */
export function artifactKind(path: string): ArtifactKind | null {
  const file = path.split("/").pop() ?? "";
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

/** The path without its serving prefix — `systemmap/report.md` for
 *  `/artifacts/1790/systemmap/report.md` — short enough for a menu item and
 *  unambiguous within one run. The whole path when nothing follows the prefix. */
export function artifactLabel(path: string): string {
  const rel = path.replace(/^\/artifacts\/[^/]+\/|^\/jobs\/[^/]+\/files\//, "");
  return rel && rel !== path ? rel : path;
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
