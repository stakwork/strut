import { useEffect, useState } from "preact/hooks";
import { artifactUrl, fetchArtifactBlob, fileScope, fileScopeOf, type FileScope } from "./api";

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

/** A served file's bytes as an object URL, read with the UI's own
 *  credential — what shows a PEER's file (`isPeerPath`): it is read through
 *  this strut with its token for the peer, so no `?t=` minted here opens it,
 *  and the key must never sit in the `src` of an image or a frame. `type`
 *  as `fetchArtifactBlob` takes it. `url` null until the bytes are in, and
 *  for a null path; revoked when the path changes. */
export function useFileBlob(path: string | null, type?: string): { url: string | null; error: string } {
  const [state, setState] = useState<{ path: string; url: string | null; error: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let url: string | null = null;
    fetchArtifactBlob(path, type).then(
      (blob) => { if (!cancelled) setState({ path, url: (url = URL.createObjectURL(blob)), error: "" }); },
      (e) => { if (!cancelled) setState({ path, url: null, error: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [path, type]);
  return path && state?.path === path ? state : { url: null, error: "" };
}
