import { useEffect, useState } from "preact/hooks";
import { artifactUrl, fileScope, fileScopeOf, type FileScope } from "./api";

/** The listing of the scope a served-file path belongs to — its files and
 *  their read token (`api.fileScope`: one fetch per run or job, cached) —
 *  null until it is in, and for a null path. A listing that cannot be read
 *  comes back EMPTY with no token, so a caller falls back to the bare URL:
 *  on an open server it works, on a gated one the 401 opens Settings. Keyed
 *  by the scope, so moving between one scope's files never resets it. */
export function useFileScope(path: string | null): FileScope | null {
  const scope = path ? fileScopeOf(path) : null;
  const [state, setState] = useState<{ scope: string; value: FileScope } | null>(null);
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    fileScope(scope).then(
      (value) => { if (!cancelled) setState({ scope, value }); },
      () => { if (!cancelled) setState({ scope, value: { files: [], token: "" } }); },
    );
    return () => { cancelled = true; };
  }, [scope]);
  return scope && state?.scope === scope ? state.value : null;
}

/** The browser URL for a served-file path once its read token is known —
 *  null until then, and for a null path. */
export function useArtifactUrl(path: string | null): string | null {
  const scope = useFileScope(path);
  return path && scope ? artifactUrl(path, scope.token) : null;
}
