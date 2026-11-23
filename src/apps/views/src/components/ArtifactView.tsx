import { useEffect, useMemo } from "react";
import { ExternalLink, FileText } from "lucide-react";
import { artifactKind, runFileBlob, useHost } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import { dataUrl, relPath as rel, useRunFile, type RunFile } from "../lib/run-file";
import { DocumentView } from "./DocumentView";
import { WalkthroughPlayer } from "./WalkthroughPlayer";
import { ZoomImage } from "./ZoomImage";

export type { RunFile } from "../lib/run-file";

export interface ArtifactViewProps {
  /** The run whose file to show — read through `run/files` (the importing app's grant). */
  workflow: string;
  runId: string;
  /** The file: relative to the run's files, or the served path a step's output names (`/artifacts/<runId>/…`, `/jobs/<job>/files/…`). */
  path: string;
  /** Draw this file instead of reading it. */
  file?: RunFile;
  className?: string;
}

/** A blob URL for media the browser plays (the document's CSP allows `blob:`). */
function useBlobUrl(f: RunFile | null | undefined): string | null {
  const url = useMemo(() => (f?.base64 && !f.truncated ? URL.createObjectURL(runFileBlob(f)) : null), [f]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}

/**
 * A file a run produced, rendered: markdown, an HTML page and text through
 * DocumentView (an HTML page drawn from its safe elements — nothing of it
 * runs), an image, a video or a sound to play, a walkthrough
 * (`browser/walkthrough`'s manifest) played by WalkthroughPlayer. The page
 * cannot fetch a server's URL, so the bytes come through `run/files`; a
 * PDF — which the document may not frame — opens in strut instead.
 */
export function ArtifactView({ workflow, runId, path, file: given, className }: ArtifactViewProps) {
  const q = useRunFile(workflow, runId, rel(path), given);
  const kind = artifactKind(path);
  const f = q.data;
  // A failed read AGAIN (a recording the player re-reads) keeps what was read.
  if (f === undefined) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    return <Skeleton className={cn("h-48 w-full", className)} />;
  }
  if (!f) return <p className={cn("text-sm text-muted-foreground", className)}>No file {rel(path)} in run {runId}.</p>;
  return (
    <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="artifact-view" data-kind={kind ?? "file"}>
      <Body kind={kind} file={f} given={given} workflow={workflow} runId={runId} path={path} />
      {f.truncated && <p className="text-xs text-muted-foreground">Cut at {Math.round(f.bytes / 1024)} KB — the rest is in strut.</p>}
    </div>
  );
}

function Body({ kind, file, given, workflow, runId, path }: { kind: ReturnType<typeof artifactKind>; file: RunFile; given?: RunFile; workflow: string; runId: string; path: string }) {
  const blob = useBlobUrl(kind === "video" || kind === "audio" ? file : null);
  switch (kind) {
    case "markdown":
    case "html":
      return <DocumentView file={file} kind={kind} />;
    case "image":
      return <ZoomImage src={dataUrl(file)} alt={rel(path)} />;
    case "video":
      return blob ? <video src={blob} controls className="max-h-[70vh] w-full rounded-md border" /> : null;
    case "audio":
      return blob ? <audio src={blob} controls className="w-full" /> : null;
    case "walkthrough":
      // The player reads the same manifest (one query, already read) and reads it again while it records — unless it was handed in.
      return <WalkthroughPlayer workflow={workflow} runId={runId} path={path} file={given} />;
    case "pdf":
      return <OpenInStrut workflow={workflow} runId={runId} path={path} what="A PDF" />;
    default:
      return file.text !== undefined ? (
        <DocumentView file={file} kind="text" />
      ) : (
        <OpenInStrut workflow={workflow} runId={runId} path={path} what={`A ${file.mediaType} file`} />
      );
  }
}

/** A file the document may not frame or play: a link that asks the host to open the run in strut. */
function OpenInStrut({ workflow, runId, path, what }: { workflow: string; runId: string; path: string; what: string }) {
  const host = useHost();
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed p-3 text-muted-foreground">
      <FileText className="size-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {what}: <span className="font-mono">{rel(path)}</span>
      </span>
      <Button variant="outline" size="sm" onClick={() => void host.openLink(`?wf=${encodeURIComponent(workflow)}&run=${encodeURIComponent(runId)}`)}>
        <ExternalLink />
        Open in strut
      </Button>
    </div>
  );
}
