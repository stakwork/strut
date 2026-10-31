// One file of a run, read through `run/files` — the page cannot fetch a URL
// (connect-src 'none'), so the bytes come through the one tool, on the
// importing app's `grants.workflows`. Read once and kept.
import { useQuery } from "@tanstack/react-query";
import { artifactRel, useStrutClient } from "@strut/kit";

/** One file of a run, as `run/files` returns it (src/runs.ts `RunFile`). */
export interface RunFile {
  path: string;
  mediaType: string;
  bytes: number;
  text?: string;
  base64?: string;
  truncated?: true;
}

/** A file's path relative to the run's files, from that or a served path (`/artifacts/<runId>/…`). */
export const relPath = (path: string) => artifactRel(path) ?? path.replace(/^\/+/, "");

export function useRunFile(workflow: string, runId: string, path: string, given?: RunFile) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["strut", "run/files", workflow, runId, path],
    queryFn: () => client.run<RunFile | null>("run/files", { workflow, runId, path }),
    enabled: !given && !!workflow && !!runId && !!path,
    staleTime: Infinity,
    initialData: given,
  });
}
