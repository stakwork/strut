// One file of a run, read through `run/files` — the page cannot fetch a
// server's URL, so the bytes come through the one tool, on the importing
// app's `grants.workflows`. The kit's hook; read once and kept.
import { artifactRel, useRunFile as useKitRunFile, type RunFile } from "@strut/kit";

export type { RunFile } from "@strut/kit";

/** A file's path relative to the run's files, from that or a served path (`/artifacts/<runId>/…`). */
export const relPath = (path: string) => artifactRel(path) ?? path.replace(/^\/+/, "");

export function useRunFile(workflow: string, runId: string, path: string, given?: RunFile, enabled = true) {
  return useKitRunFile(workflow, runId, path, given ? { initial: given } : { enabled });
}

const dataUrls = new WeakMap<RunFile, string>();

/** A file as a `data:` URL — an app's page allows `img-src data: blob:`, never
 *  a server's URL. Made once per file read: a read file is kept, so the same
 *  object comes back on every render, and a frame's megabyte of base64 is
 *  not copied again. */
export function dataUrl(f: RunFile): string {
  let url = dataUrls.get(f);
  if (url === undefined) {
    url = f.base64 !== undefined ? `data:${f.mediaType};base64,${f.base64}` : `data:${f.mediaType};charset=utf-8,${encodeURIComponent(f.text ?? "")}`;
    dataUrls.set(f, url);
  }
  return url;
}
