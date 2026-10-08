import { useEffect, useState } from "preact/hooks";
import { artifactUrl, fileToken } from "./api";

/** The browser URL for a served-file path once its read token is known
 *  (`api.fileToken`: one listing fetch per run or job, cached) — null until
 *  then, and for a null path. A fetch that fails falls back to the bare
 *  URL: on an open server it works, on a gated one the 401 opens Settings. */
export function useArtifactUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!path) return;
    let cancelled = false;
    fileToken(path).then(
      (t) => { if (!cancelled) setUrl(artifactUrl(path, t)); },
      () => { if (!cancelled) setUrl(artifactUrl(path)); },
    );
    return () => { cancelled = true; };
  }, [path]);
  return url;
}
