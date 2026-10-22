/**
 * Deliverables (plans/jobs.md §3): a workflow's output may carry
 * `artifacts: [{ id, kind?, title, path?, url?, content? }]` — what a run
 * hands the human to LOOK at, as opposed to read in prose. Strut resolves
 * the list once, where a host receives it (the `run.end` callback and
 * `GET …/runs/:runId/artifacts`): a `path` becomes a URL on this server —
 * in the job's directory for a run launched with a job, else in the run's
 * own artifact directory — a `url` and a `content` pass through (both, when
 * both are given — the fields are not exclusive), and a missing `kind` is
 * read off the file's extension (or a manifest's name). `output` itself is
 * never rewritten.
 *
 * An entry tagged with a `peer` (plans/builder-job.md §3) is ANOTHER
 * strut's — `strut/run-workflow` tags the deliverables of the run it
 * waited on there — and is left as it came: its `path` is relative to
 * that peer's `job` directory and its `url` is the peer's, so nothing here
 * resolves, checks or rewrites either (the handle rule, plans/federation.md
 * §2.2). The reader resolves it against the peer, by id.
 *
 * `kind` is the HOST's renderer vocabulary (hive's canvas chat:
 * `markdown | html | image | video | audio | pdf | url | diff |
 * pull_request | code | log | json`), passed through unchecked; the
 * inference below only picks a name from that list.
 *
 * One kind is strut's own: `app`. Two forms. `app: "<name>"` (+ `version?`)
 * is an app PUBLISHED in this workspace — what the builder hands over
 * (plans/builder-job.md; 2026-10-22) — and resolves to that version's
 * document, `/apps/<name>/<vN>/files/dist/index.html` (the active version
 * unless one is named), with `app: { name, version, hash, builtAt }`
 * beside it. `path` is the older form (plans/apps.md §6): an APP's
 * directory in the job's, resolved to `/jobs/<job>/files/<path>/dist/index.html`
 * with `app: { job, path, hash, builtAt }`; a directory with an `app.yaml`
 * and no kind given is one too, and not built yet is an error that says
 * so. Either way a host that knows apps renders the document through its
 * bridge (and reloads when the build's hash moves), and one that does not
 * shows the link.
 */
import { scopePath } from "./auth.js";
import { DOCUMENT_FILE } from "./apps/build.js";
import { MANIFEST_FILE } from "./apps/manifest.js";

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
  /** A published app, by name (`kind: "app"`): its active version, or `version`. */
  app?: string;
  version?: string;
  /** Another strut's deliverable: the peer's id, as this strut names it. */
  peer?: string;
  /** With `peer`, two hops away: the strut that holds it, as `peer` names
   *  it — its files are `peer`'s read-through, `/peers/<via>/…` there. */
  via?: string;
  /** With `peer`: the job its files are under on that peer (on `via`, when set). */
  job?: string;
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
  /** Another strut's deliverable, left as it came: `path` (relative to
   *  `job`'s directory there) and `url` are THAT peer's, for the reader to
   *  resolve against it by id — never a link on this strut. */
  peer?: string;
  /** With `peer`, two hops away: the strut that holds it, as `peer` names
   *  it (plans/chained-orchestrators.md §5) — open `path` through `peer`'s
   *  read-through, `/peers/<via>/jobs/<job>/files/<path>`. */
  via?: string;
  job?: string;
  /** With `peer` only. */
  path?: string;
  /** An APP (`kind: "app"`): what a host's bridge needs to render it (`url`
   *  is its document) and the build the document came from (`dist/build.json`
   *  — a new `hash` is a new document to reload). A WORKSPACE app by name
   *  and version (the builder's deliverable), or a job's app by the job and
   *  the app's directory in it (plans/apps.md §6). On a peer's entry the
   *  name and version as given, nothing resolved. */
  app?: WorkspaceAppRef | JobAppRef;
}

/** A published app at a version (`version` is unresolved, so absent when
 *  not given, only on a peer's entry). */
export interface WorkspaceAppRef { name: string; version?: string; hash?: string; builtAt?: string }
/** A job's app: its directory in the job's. */
export interface JobAppRef { job: string; path: string; hash?: string; builtAt?: string }

/** The kind of a deliverable that is an app. */
export const APP_KIND = "app";

/** The link strut serves an app version's document at. */
export function appDocumentUrl(name: string, version: string): string {
  return `/apps/${encodeURIComponent(name)}/${version}/files/${DOCUMENT_FILE}`;
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

/** The link strut serves a job's file at — what a deliverable's `path`
 *  resolves to and what a step's `notify` names, so a host can tell they
 *  are the same file (plans/live-artifacts.md §5). */
export function jobFileUrl(job: string, rel: string): string {
  return `/jobs/${encodeURIComponent(job)}/files/${rel.replace(/^\/+/, "")}`;
}

/** A recording's manifest (`browser/walkthrough`, plans/live-artifacts.md
 *  §4): named, not extended — a `.json` that IS a walkthrough. The kind a
 *  step's result already says; this is the fallback where none was given. */
export const WALKTHROUGH_MANIFEST = "walkthrough.json";

/** A captcha round's manifest (`browser/captcha-ask`, src/browser/captcha.ts):
 *  `captcha-<round>.json`, which the host's captcha card reads. The same
 *  fallback: a model that lists the round's artifact without its kind
 *  (2026-10-17, swarm38) still hands the host a captcha, not JSON. */
export const CAPTCHA_MANIFEST = /^captcha-\d+\.json$/;

/** The renderer kind for a file path or URL, by extension; `url` when the
 *  extension says nothing (a link is always showable). */
export function artifactKind(pathOrUrl: string): string {
  const file = pathOrUrl.split("?")[0]!.split("#")[0]!.split("/").pop() ?? "";
  if (file === WALKTHROUGH_MANIFEST) return "walkthrough";
  if (CAPTCHA_MANIFEST.test(file)) return "captcha";
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
  /** A job app's `dist/build.json` — its tree hash and when it was built —
   *  or null; absent, an app ref carries no hash. */
  appBuild?: (job: string, path: string) => Promise<{ hash: string; builtAt?: string } | null>;
  /** A published app's version — the active one, or the one named — with
   *  its build; null for no such app or version. Absent where there are no
   *  apps: an `app` entry is then an error. */
  appVersion?: (name: string, version?: string) => Promise<{ version: string; hash?: string; builtAt?: string } | null>;
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
    const appName = text(raw["app"]);
    const appVersion = text(raw["version"]);
    const hasContent = raw["content"] !== undefined && raw["content"] !== null;
    if (path === undefined && url === undefined && appName === undefined && !hasContent) {
      out.push({ ...ref, error: "one of path, url, app or content is required" });
      continue;
    }
    // The three are not exclusive: a model names a pull request by its
    // link AND its fields, and both reach the host. Only a `path` needs
    // strut (it knows where the file is); it takes the place of a `url`.
    // A `content` rides along whichever way the location resolved.
    let error: string | undefined;
    const peer = text(raw["peer"]);
    if (peer) {
      // Another strut's: kept as it came. Its path and url are the peer's,
      // for the reader to resolve there — nothing here checks either.
      const job = text(raw["job"]);
      const via = text(raw["via"]);
      if (!text(raw["kind"])) ref.kind = appName ? APP_KIND : artifactKind((path ?? url) ?? "");
      Object.assign(ref, { peer, ...(via ? { via } : {}), ...(job ? { job } : {}), ...(path !== undefined ? { path } : {}), ...(url !== undefined ? { url } : {}) });
      if (appName) ref.app = { name: appName, ...(appVersion ? { version: appVersion } : {}) };
    } else if (appName !== undefined && path === undefined && url === undefined) {
      // A published app, by name: the version's document, or why not.
      ref.kind = APP_KIND;
      if (!at.appVersion) error = "no apps here";
      else {
        const v = await at.appVersion(appName, appVersion).catch(() => null);
        if (!v) error = appVersion ? `no such app version: ${appName} ${appVersion}` : `no such app: ${appName}`;
        else {
          ref.url = appDocumentUrl(appName, v.version);
          ref.app = { name: appName, version: v.version, ...(v.hash ? { hash: v.hash } : {}), ...(v.builtAt ? { builtAt: v.builtAt } : {}) };
        }
      }
    } else if (path !== undefined) {
      const rel = path.replace(/^\/+/, "");
      const fileUrl = (r: string) => (at.job ? jobFileUrl(at.job, r) : `/artifacts/${encodeURIComponent(at.runId)}/${r}`);
      const bad = rel.split("/").includes("..") || !rel;
      if (!text(raw["kind"])) {
        ref.kind = artifactKind(rel);
        // An extensionless path that holds an app.yaml is an app.
        const dir = bad ? undefined : scopePath(rel);
        if (ref.kind === "url" && dir && (await at.exists(fileUrl(`${dir}/${MANIFEST_FILE}`)))) ref.kind = APP_KIND;
      }
      if (bad) error = "bad path";
      else if (ref.kind === APP_KIND) error = await resolveApp(ref, rel, at, fileUrl);
      else if (await at.exists(fileUrl(rel))) ref.url = fileUrl(rel);
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
    // inline content is still something to look at, and so is a peer's path.
    if (error && ref.url === undefined && ref.path === undefined && ref.content === undefined) ref.error = error;
    out.push(ref);
  }
  return out;
}

/** An app deliverable: its document's link, and on a job the app's place
 *  and build — or why there is none. */
async function resolveApp(ref: ArtifactRef, rel: string, at: ResolveArtifactsAt, fileUrl: (r: string) => string): Promise<string | undefined> {
  const dir = scopePath(rel);
  if (!dir) return "bad path";
  const doc = fileUrl(`${dir}/${DOCUMENT_FILE}`);
  if (!(await at.exists(doc))) {
    return (await at.exists(fileUrl(`${dir}/${MANIFEST_FILE}`))) ? `not built: no ${DOCUMENT_FILE} in ${dir} — app/build writes it` : "not found";
  }
  ref.url = doc;
  if (at.job) {
    const build = await at.appBuild?.(at.job, dir).catch(() => null);
    ref.app = { job: at.job, path: dir, ...(build?.hash ? { hash: build.hash } : {}), ...(build?.builtAt ? { builtAt: build.builtAt } : {}) };
  }
  return undefined;
}
