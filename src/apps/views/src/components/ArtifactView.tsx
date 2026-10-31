import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, FileText } from "lucide-react";
import { artifactKind, parseWalkthrough, useHost } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import { relPath as rel, useRunFile, type RunFile } from "../lib/run-file";
import { DocumentView } from "./DocumentView";

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

const dataUrl = (f: RunFile) => (f.base64 !== undefined ? `data:${f.mediaType};base64,${f.base64}` : `data:${f.mediaType};charset=utf-8,${encodeURIComponent(f.text ?? "")}`);

/** A blob URL for media the browser plays (the document's CSP allows `blob:`). */
function useBlobUrl(f: RunFile | null | undefined): string | null {
  const url = useMemo(() => {
    if (!f?.base64) return null;
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: f.mediaType }));
  }, [f]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}

/**
 * A file a run produced, rendered: markdown, an HTML page and text through
 * DocumentView (an HTML page drawn from its safe elements — nothing of it
 * runs), an image, a video or a sound to play, a walkthrough
 * (`browser/walkthrough`'s manifest) as frames to scrub. The page cannot
 * fetch a URL (connect-src 'none'), so the bytes come through `run/files`; a
 * PDF — which the document may not frame — opens in strut instead.
 */
export function ArtifactView({ workflow, runId, path, file: given, className }: ArtifactViewProps) {
  const q = useRunFile(workflow, runId, rel(path), given);
  const kind = artifactKind(path);
  const f = q.data;
  if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
  if (q.isPending) return <Skeleton className={cn("h-48 w-full", className)} />;
  if (!f) return <p className={cn("text-sm text-muted-foreground", className)}>No file {rel(path)} in run {runId}.</p>;
  return (
    <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="artifact-view" data-kind={kind ?? "file"}>
      <Body kind={kind} file={f} workflow={workflow} runId={runId} path={path} />
      {f.truncated && <p className="text-xs text-muted-foreground">Cut at {Math.round(f.bytes / 1024)} KB — the rest is in strut.</p>}
    </div>
  );
}

function Body({ kind, file, workflow, runId, path }: { kind: ReturnType<typeof artifactKind>; file: RunFile; workflow: string; runId: string; path: string }) {
  const blob = useBlobUrl(kind === "video" || kind === "audio" ? file : null);
  switch (kind) {
    case "markdown":
    case "html":
      return <DocumentView file={file} kind={kind} />;
    case "image":
      return <img src={dataUrl(file)} alt={rel(path)} className="max-h-[70vh] max-w-full rounded-md border object-contain" />;
    case "video":
      return blob ? <video src={blob} controls className="max-h-[70vh] w-full rounded-md border" /> : null;
    case "audio":
      return blob ? <audio src={blob} controls className="w-full" /> : null;
    case "walkthrough":
      return <Walkthrough text={file.text ?? ""} workflow={workflow} runId={runId} path={path} />;
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

/** A recording's frames to scrub: the manifest read once, each frame read when shown. */
function Walkthrough({ text, workflow, runId, path }: { text: string; workflow: string; runId: string; path: string }) {
  // The manifest's frames resolve against its own directory, as served paths.
  const served = path.startsWith("/") ? path : `/artifacts/${runId}/${path}`;
  const w = useMemo(() => parseWalkthrough(text, served), [text, served]);
  const [at, setAt] = useState(0);
  const frame = w?.frames[Math.min(at, (w?.frames.length ?? 1) - 1)];
  const q = useRunFile(workflow, runId, frame ? rel(frame.path) : "");
  if (!w) return <pre className="rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>;
  if (!w.frames.length) return <p className="text-muted-foreground">The recording has no frames yet.</p>;
  const last = w.frames.length - 1;
  return (
    <div className="flex flex-col gap-2" data-testid="walkthrough">
      {(w.title || w.url) && (
        <div className="text-xs text-muted-foreground">
          {w.title && <span className="font-medium text-foreground">{w.title}</span>} {w.url}
          {w.status && w.status !== "done" && <span> · {w.status}</span>}
        </div>
      )}
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md border bg-muted/40">
        {q.data ? <img src={dataUrl(q.data)} alt={frame?.caption ?? ""} className="max-h-full max-w-full object-contain" /> : <Skeleton className="h-full w-full" />}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" className="size-7" aria-label="Previous frame" disabled={at === 0} onClick={() => setAt((i) => Math.max(0, i - 1))}>
          <ChevronLeft />
        </Button>
        <Slider className="flex-1" min={0} max={last} step={1} value={[Math.min(at, last)]} onValueChange={(v) => setAt(v[0] ?? 0)} aria-label="Frame" />
        <Button variant="outline" size="icon" className="size-7" aria-label="Next frame" disabled={at >= last} onClick={() => setAt((i) => Math.min(last, i + 1))}>
          <ChevronRight />
        </Button>
        <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">
          {Math.min(at, last) + 1} / {w.frames.length}
        </span>
      </div>
      {frame && (
        <p className={cn("text-xs", frame.failed ? "text-destructive" : "text-muted-foreground")}>
          {frame.caption}
          {frame.failed && ` — ${frame.failed}`}
        </p>
      )}
    </div>
  );
}
