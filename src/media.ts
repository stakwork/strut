/**
 * What a MEDIA step shares (the `image` step today, `video` next): where
 * the file it made goes, its name, and the copy a model is shown.
 *
 * WHERE the file goes is the browser screenshots' rule (src/browser/shot.ts):
 * the run's artifacts on a plain run, served at `/artifacts/<runId>/<path>`;
 * the job's directory on a run launched under a JOB, served at
 * `/jobs/<job>/files/<path>`, since a child run's id is one the job's host
 * never saw. On a job run whose host listens (`jobCallback`) the file is
 * also one `job.update`, so a person watching sees it land.
 *
 * The step's output carries the RELATIVE path, never the bytes: a workflow
 * declares it as a deliverable (`artifacts: [{ id, kind: "image", path }]`,
 * src/artifact-refs.ts), which resolves against the same place.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workflowOf, type StepContext } from "./core.js";
import type { StrutCapabilities } from "./capabilities.js";
import { jobRoot } from "./jobs.js";
import { jobFileUrl } from "./artifact-refs.js";

/** A media file a step wrote. */
export interface SavedMedia {
  /** Relative to `dir`: `images/<name>.<ext>`. */
  path: string;
  /** The absolute directory `path` is relative to: the run's artifacts, or the job's directory. */
  dir: string;
  /** The served form, which strut's UI and a job's host render. */
  url: string;
  mediaType: string;
  bytes: number;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** The file extension for a media type: the table's, else its subtype. */
export function extensionFor(mediaType: string): string {
  return EXTENSIONS[mediaType] ?? (mediaType.split("/")[1] ?? "bin").replace(/[^a-z0-9]+/gi, "");
}

/**
 * A file name for what a step made: the author's `name`, else the step's
 * own place in the run (`hero`, `each-3-pic` for a foreach's third
 * iteration), so the steps of one run never write one file twice. On a job
 * run the run id leads an unnamed file: the job's directory outlives the run,
 * and the next turn's file must not replace this one's.
 */
export function mediaFileName(ctx: StepContext<StrutCapabilities> | undefined, name: string | undefined, fallback: string): string {
  const clean = (s: string) => s.replace(/#/g, "-").replace(/\//g, "-").replace(/[^\w.-]+/g, "_").replace(/^[.-]+/, "");
  if (name?.trim()) return clean(name.trim()) || fallback;
  const path = ctx?.path ?? "";
  const root = ctx ? workflowOf(ctx) : "";
  const own = clean(root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path) || fallback;
  return ctx?.job ? `${clean(ctx.runId)}-${own}` : own;
}

/** Write a media file where this run's files go, and tell a listening job host. */
export async function saveMedia(
  ctx: StepContext<StrutCapabilities> | undefined,
  file: { folder: string; name: string; data: Uint8Array; mediaType: string; kind: string },
): Promise<SavedMedia> {
  const path = `${file.folder}/${file.name}.${extensionFor(file.mediaType)}`;
  if (ctx?.job) {
    const root = jobRoot(ctx.services?.dataDir ?? join(tmpdir(), "strut"), ctx.job);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), file.data);
    const url = jobFileUrl(ctx.job, path);
    const jobs = ctx.services?.jobs;
    jobs?.notify?.(ctx.job, { runId: ctx.runId, kind: file.kind, url, state: "done", title: path });
    return { path, dir: root, url, mediaType: file.mediaType, bytes: file.data.length };
  }
  const artifacts = ctx?.services?.artifacts;
  if (!artifacts || !ctx) throw new Error("no `artifacts` capability on ctx.services: a media step needs somewhere to write its file");
  await artifacts.write(ctx.runId, path, file.data);
  return { path, dir: await artifacts.dir(ctx.runId), url: `/artifacts/${ctx.runId}/${path}`, mediaType: file.mediaType, bytes: file.data.length };
}

/** A copy of an image small enough to show a model (the screenshots' 0.6×,
 *  as PNG), or undefined where `sharp` cannot load: the step goes on without
 *  it. */
export async function imagePreview(data: Uint8Array): Promise<{ mediaType: string; data: Uint8Array } | undefined> {
  try {
    const { modelCopy } = await import("./browser/shot.js");
    const { small } = await modelCopy(Buffer.from(data));
    return { mediaType: "image/png", data: small };
  } catch {
    return undefined;
  }
}
