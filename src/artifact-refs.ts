/**
 * Deliverables (plans/jobs.md §3): a workflow's output may carry
 * `artifacts: [{ id, kind?, title, path?, url?, content? }]` — what a run
 * hands the human to LOOK at, as opposed to read in prose. Strut resolves
 * the list once, where a host receives it (the `run.end` callback and
 * `GET …/runs/:runId/artifacts`): a `path` becomes a URL on this server —
 * in the job's directory for a run launched with a job, else in the run's
 * own artifact directory — a `url` and a `content` pass through (both, when
 * both are given — the fields are not exclusive), and a missing `kind` is
 * read off the file's extension. `output` itself is
 * never rewritten.
 *
 * `kind` is the HOST's renderer vocabulary (hive's canvas chat:
 * `markdown | html | image | video | audio | pdf | url | diff |
 * pull_request | code | log | json`), passed through unchecked; the
 * inference below only picks a name from that list.
 */

export interface ArtifactEntry {
  /** Stable across turns: the same id later is a newer version of the same thing. */
  id: string;
  kind?: string;
  title: string;
  /** What it is to the reader — "Plan", "Screenshot", "Pod". */
  label?: string;
  summary?: string;
  /** Relative to the job directory (a plain run: its artifact directory). */
  path?: string;
  /** Absolute (a pod, a pull request), or strut-relative starting with `/`. */
  url?: string;
  /** Inline: a diff, a JSON value, short markdown. */
  content?: unknown;
}

/** One resolved entry, as a host receives it. */
export interface ArtifactRef {
  id: string;
  kind: string;
  title: string;
  label?: string;
  summary?: string;
  url?: string;
  content?: unknown;
  /** Why there is no `url`/`content`: the file is not there, the url is
   *  not one, the content is over the cap. The host shows "unavailable". */
  error?: string;
}

/** Inline content larger than this is refused (the ref carries `error`). */
export const ARTIFACT_CONTENT_MAX_CHARS = 50_000;

const KIND_BY_EXT: Record<string, string> = {
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio",
  pdf: "pdf",
  json: "json",
  diff: "diff", patch: "diff",
  log: "log", txt: "log",
  js: "code", ts: "code", tsx: "code", jsx: "code", py: "code", sh: "code", rb: "code", go: "code", rs: "code",
  yaml: "code", yml: "code", toml: "code", xml: "code", csv: "code", css: "code", sql: "code",
};

/** The renderer kind for a file path or URL, by extension; `url` when the
 *  extension says nothing (a link is always showable). */
export function artifactKind(pathOrUrl: string): string {
  const file = pathOrUrl.split("?")[0]!.split("#")[0]!.split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return "url";
  return KIND_BY_EXT[file.slice(dot + 1).toLowerCase()] ?? "url";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export interface ResolveArtifactsAt {
  runId: string;
  /** The job the run was launched with, if any. */
  job?: string;
  /** Whether the file behind a strut-relative url exists. Absolute urls are
   *  never checked. */
  exists: (url: string) => Promise<boolean>;
}

/** The `artifacts` list of a run's output, if it carries one — the raw
 *  entries, unresolved. */
export function artifactEntriesOf(output: unknown): unknown[] | undefined {
  if (!isRecord(output) || !Array.isArray(output["artifacts"])) return undefined;
  return output["artifacts"];
}

/**
 * Resolve a run's declared artifacts. Entries with no `id` or `title` are
 * dropped (nothing to key or name them by); every other entry comes back,
 * with a `url` and/or `content`, or an `error`. Undefined when the output
 * declares none.
 */
export async function resolveArtifactRefs(output: unknown, at: ResolveArtifactsAt): Promise<ArtifactRef[] | undefined> {
  const entries = artifactEntriesOf(output);
  if (!entries) return undefined;
  const out: ArtifactRef[] = [];
  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const id = text(raw["id"]);
    const title = text(raw["title"]);
    if (!id || !title) {
      console.warn(`[run ${at.runId}] artifacts: an entry without an id and a title was dropped`);
      continue;
    }
    const ref: ArtifactRef = {
      id,
      kind: text(raw["kind"]) ?? "url",
      title,
      ...(text(raw["label"]) ? { label: raw["label"] as string } : {}),
      ...(text(raw["summary"]) ? { summary: raw["summary"] as string } : {}),
    };
    const path = text(raw["path"]);
    const url = text(raw["url"]);
    const hasContent = raw["content"] !== undefined && raw["content"] !== null;
    if (path === undefined && url === undefined && !hasContent) {
      out.push({ ...ref, error: "one of path, url or content is required" });
      continue;
    }
    // The three are not exclusive: a model names a pull request by its
    // link AND its fields, and both reach the host. Only a `path` needs
    // strut (it knows where the file is); it takes the place of a `url`.
    // A `content` rides along whichever way the location resolved.
    let error: string | undefined;
    if (path !== undefined) {
      const rel = path.replace(/^\/+/, "");
      const resolved = at.job
        ? `/jobs/${encodeURIComponent(at.job)}/files/${rel}`
        : `/artifacts/${encodeURIComponent(at.runId)}/${rel}`;
      if (!text(raw["kind"])) ref.kind = artifactKind(rel);
      if (rel.split("/").includes("..") || !rel) error = "bad path";
      else if (await at.exists(resolved)) ref.url = resolved;
      else error = "not found";
    } else if (url !== undefined) {
      if (!text(raw["kind"])) ref.kind = artifactKind(url);
      if (/^(https?:\/\/|\/)/.test(url)) ref.url = url;
      else error = "bad url";
    }
    if (hasContent) {
      const size = typeof raw["content"] === "string" ? raw["content"].length : JSON.stringify(raw["content"]).length;
      if (size > ARTIFACT_CONTENT_MAX_CHARS) error ??= "too large";
      else ref.content = raw["content"];
    }
    // An error only when nothing could be shown: a bad path beside good
    // inline content is still something to look at.
    if (error && ref.url === undefined && ref.content === undefined) ref.error = error;
    out.push(ref);
  }
  return out;
}
