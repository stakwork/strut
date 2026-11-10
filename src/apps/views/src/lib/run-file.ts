// One file of a run, read through `run/files` — the page cannot fetch a
// server's URL, so the bytes come through the one tool, on the importing
// app's `grants.workflows`. The kit's hook; read once and kept.
import { artifactRel, useRunFile as useKitRunFile, type RunFile } from "@strut/kit";

export type { RunFile } from "@strut/kit";

/** A file's path relative to the run's files, from that or a served path (`/artifacts/<runId>/…`). */
export const relPath = (path: string) => artifactRel(path) ?? path.replace(/^\/+/, "");

export function useRunFile(workflow: string, runId: string, path: string, given?: RunFile) {
  return useKitRunFile(workflow, runId, path, given ? { initial: given } : {});
}
