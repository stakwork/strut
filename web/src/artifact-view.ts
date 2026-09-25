// ── What the artifact viewer can render inline ─────────────────────────────
//
// A step's output names a file it wrote as `/artifacts/<runId>/<relPath>`.
// The link opens the raw file in a new tab; the eye beside it opens the file
// in a modal RENDERED — markdown as markdown, an image as an image — for the
// obvious file types. Decided by extension alone (the server's content-type
// map is the same shape); anything else gets no eye.

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
