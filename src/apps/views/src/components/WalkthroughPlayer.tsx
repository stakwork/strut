// A recording `browser/walkthrough` made (plans/live-artifacts.md §4) —
// one picture per captioned step and a `walkthrough.json` naming them —
// played back like a video. Hive's walkthrough viewer, ported onto
// `run/files`: the page cannot load a server's URL (its CSP allows
// `img-src data: blob:` only), so the manifest and every frame come through
// that one step, a frame as a `data:` URL. Frames are read when wanted —
// the one shown and its neighbours first, a filmstrip thumbnail once it
// scrolls into view — and each is read once (react-query keeps it).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { Pause, Play } from "lucide-react";
import { parseWalkthrough, type Walkthrough, type WalkthroughFrame } from "@strut/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import { dataUrl, relPath, useRunFile, type RunFile } from "../lib/run-file";
import {
  RECORDING_POLL_MS, STEP_MS, frameIndex, keyStep, pickFrame, playBeat, playFrom, servedPath, statusText, stepSegments, stripScroll,
} from "../lib/walkthrough-player";

export type WalkthroughMode = "full" | "compact" | "thumb";

export interface WalkthroughPlayerProps {
  /** The run whose recording to play — read through `run/files` (the importing app's grant). */
  workflow: string;
  runId: string;
  /** The manifest (`…/walkthrough.json`): the served path a step's output names (`/jobs/<job>/files/…`, `/artifacts/<runId>/…`), or relative to the run's files. */
  path: string;
  /** `full` (the default): the frame, its page, play and the slider, a filmstrip, ← → while the player has focus.
   *  `compact`: no filmstrip and no keys, for inside a claim. `thumb`: the newest frame with a play mark. */
  mode?: WalkthroughMode;
  /** A thumb's click: open the recording where it plays. */
  onOpen?: () => void;
  /** Play this manifest instead of reading it (and never read it again). */
  file?: RunFile;
  className?: string;
}

/**
 * A walkthrough played back: Play shows a frame every 800 ms (at the end it
 * starts over), the slider is drawn over a bar of one segment per step,
 * under the frame its number, caption and page, and a filmstrip to jump to
 * any frame. A recording still being made is read again every 3 s and the
 * player follows its newest frame until the reader picks one. A frame where
 * the recording failed is outlined red with the reason.
 */
export function WalkthroughPlayer({ workflow, runId, path, mode = "full", onOpen, file: given, className }: WalkthroughPlayerProps) {
  const q = useRunFile(workflow, runId, relPath(path), given);
  const served = servedPath(path, runId);
  const text = q.data?.text;
  const w = useMemo(() => (text === undefined ? null : parseWalkthrough(text, served)), [text, served]);
  // Rewritten after every frame while it records: read it again until it says otherwise. A failed read keeps what was read.
  const recording = w?.status === "recording" && !given;
  const { refetch } = q;
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => void refetch(), RECORDING_POLL_MS);
    return () => clearInterval(t);
  }, [recording, refetch]);

  if (mode === "thumb") return <Thumb workflow={workflow} runId={runId} w={w} pending={q.isPending} onOpen={onOpen} className={className} />;
  if (q.data === undefined) {
    if (q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
    return <Skeleton className={cn("aspect-video w-full", className)} />;
  }
  if (!q.data) return <p className={cn("text-sm text-muted-foreground", className)}>No recording at {relPath(path)} in run {runId}.</p>;
  if (!w) return <pre className={cn("rounded-md border p-3 font-mono text-xs whitespace-pre-wrap", className)}>{text ?? `A ${q.data.mediaType} file, not a recording.`}</pre>;
  return <Player workflow={workflow} runId={runId} w={w} compact={mode === "compact"} className={className} />;
}

/** The native range, drawn as a round thumb over the step bar behind it. */
const RANGE = cn(
  "relative block h-3 w-full cursor-pointer appearance-none rounded-full bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  "[&::-webkit-slider-runnable-track]:h-3 [&::-webkit-slider-runnable-track]:bg-transparent",
  "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-blue-500 [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow",
  "[&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent",
  "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-blue-500 [&::-moz-range-thumb]:bg-background [&::-moz-range-thumb]:shadow",
);

/** A click on the controls stays in the player, so a card it sits in does not open or fold. */
const keep = (e: MouseEvent) => e.stopPropagation();

/** One frame's file, or nothing to read when there is no frame. */
function useFrame(workflow: string, runId: string, frame: WalkthroughFrame | undefined, enabled = true) {
  return useRunFile(workflow, runId, frame ? relPath(frame.path) : "", undefined, enabled);
}

/** A frame's picture, or null while it is not read — or cannot be drawn (missing, cut at the cap). */
const srcOf = (f: RunFile | null | undefined) => (f && !f.truncated ? dataUrl(f) : null);

function Player({ workflow, runId, w, compact, className }: { workflow: string; runId: string; w: Walkthrough; compact: boolean; className?: string }) {
  const count = w.frames.length;
  const recording = w.status === "recording";
  // null: following the newest frame while it records, until the reader picks one; a finished one opens on frame 1.
  const [at, setAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const i = frameIndex(at, count, recording);
  const frame = w.frames[i];
  // The frame shown, then the next and the one before, so a step or a beat of play finds its picture read.
  const cur = useFrame(workflow, runId, frame);
  const next = useFrame(workflow, runId, w.frames[i + 1]);
  useFrame(workflow, runId, w.frames[i - 1]);
  const nextRead = !w.frames[i + 1] || next.data !== undefined || next.isError;
  const pick = (n: number) => setAt(pickFrame(n, count, recording));

  // Playing: the next frame every STEP_MS — once its picture is read — until the last.
  useEffect(() => {
    if (!playing || !nextRead) return;
    const t = setTimeout(() => {
      const beat = playBeat(i, count);
      setAt(pickFrame(beat.at, count, recording));
      if (!beat.playing) setPlaying(false);
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [playing, nextRead, i, count, recording]);
  const togglePlay = () => {
    if (!playing) setAt(playFrom(i, count));
    setPlaying(!playing);
  };

  // ← → step while the player has focus — never the whole page's keys: a page may show several players.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = keyStep(e.key, i, count);
    if (n === null) return;
    e.preventDefault(); // the slider, when it has the focus, would step a second time
    pick(n);
  };

  // While the next picture is read, the last one stays up, dimmed, rather than a blank.
  const src = srcOf(cur.data);
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    if (src) setHeld(src);
  }, [src]);
  const unread = cur.isError ? errorText(cur.error) : cur.data === null ? "This frame's picture is not there." : cur.data?.truncated ? `This frame is ${Math.round(cur.data.bytes / 1024)} KB, too big to show here.` : null;

  // The filmstrip keeps the frame shown in view as it plays or follows.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = strip.current;
    const el = s?.children[i] as HTMLElement | undefined;
    if (!s || !el) return;
    const to = stripScroll(el.offsetLeft, el.offsetWidth, s.scrollLeft, s.clientWidth);
    if (to !== s.scrollLeft) s.scrollLeft = to;
  }, [i, count]);

  return (
    <div
      data-testid="walkthrough"
      data-mode={compact ? "compact" : "full"}
      role="group"
      aria-label={w.title ?? "Walkthrough"}
      tabIndex={compact ? undefined : 0}
      onKeyDown={compact ? undefined : onKeyDown}
      className={cn("flex flex-col gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}
    >
      {!compact && (
        <div className="flex items-baseline gap-2 text-xs">
          <span className="min-w-0 truncate font-medium">{w.title ?? "Walkthrough"}</span>
          {w.url && <span className="min-w-0 truncate text-muted-foreground" title={w.url}>{w.url}</span>}
          {w.status && (
            <span data-testid="walkthrough-status" className={cn("ml-auto shrink-0 text-muted-foreground", w.status === "stopped" && "text-destructive")}>
              {statusText(w.status)}
            </span>
          )}
        </div>
      )}
      {frame ? (
        <>
          <div
            className={cn(
              "flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40",
              compact && "max-h-56",
              frame.failed && "border-destructive/60",
            )}
          >
            {src ? (
              <img src={src} alt={frame.caption} className="max-h-full max-w-full object-contain" />
            ) : unread ? (
              <p className="p-3 text-xs text-muted-foreground">{unread}</p>
            ) : held ? (
              <img src={held} alt="" aria-hidden className="max-h-full max-w-full object-contain opacity-50" />
            ) : (
              <Skeleton className="size-full rounded-none" />
            )}
          </div>
          <div className="flex items-baseline gap-2 text-xs">
            <span data-testid="walkthrough-count" className="shrink-0 tabular-nums text-muted-foreground">
              {i + 1} / {count}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium" title={frame.caption}>
              {frame.caption}
            </span>
            {!compact && frame.pageUrl && (
              <span className="max-w-[40%] truncate text-muted-foreground" title={frame.pageUrl}>
                {frame.pageUrl}
              </span>
            )}
          </div>
          {frame.failed && <p className="text-xs text-destructive">{frame.failed}</p>}
        </>
      ) : (
        <p className="py-6 text-center text-xs text-muted-foreground">{recording ? "Recording — no frames yet." : "The recording has no frames."}</p>
      )}
      {count > 1 && (
        <div className="flex items-center gap-1.5" onClick={keep}>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-blue-600 hover:bg-muted dark:text-blue-400"
          >
            {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
          </button>
          <div className="relative min-w-0 flex-1">
            {/* A segment per step, two blues alternating, the ones still ahead faded; inset by the thumb's radius so its ends meet the first and last frame. */}
            <div data-testid="walkthrough-steps" aria-hidden className="pointer-events-none absolute inset-x-1.5 top-1/2 flex h-1.5 -translate-y-1/2 overflow-hidden rounded-full">
              {stepSegments(count, i).map((s, n) => (
                <span key={n} className={cn("flex-1", s.dark ? "bg-blue-500" : "bg-blue-400", s.ahead && "opacity-40")} />
              ))}
            </div>
            <input type="range" min={0} max={count - 1} value={i} aria-label="Frame" onChange={(e) => pick(Number(e.target.value))} className={RANGE} />
          </div>
        </div>
      )}
      {!compact && count > 1 && (
        <div ref={strip} className="relative flex gap-1 overflow-x-auto pb-1" onClick={keep}>
          {w.frames.map((f, n) => (
            <FilmFrame key={`${n}:${f.path}`} workflow={workflow} runId={runId} frame={f} n={n} active={n === i} onPick={() => pick(n)} />
          ))}
        </div>
      )}
      {!compact && w.failed.length > 0 && !w.frames.some((f) => f.failed) && <p className="text-xs text-destructive">{w.failed.join(" · ")}</p>}
    </div>
  );
}

/** True once the element has come into view, and from then on. */
function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver === "undefined") return void setSeen(true);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/** A filmstrip thumbnail: its frame read once the strip scrolls it into view; a click shows that frame. */
function FilmFrame({ workflow, runId, frame, n, active, onPick }: { workflow: string; runId: string; frame: WalkthroughFrame; n: number; active: boolean; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const seen = useSeen(ref);
  const q = useFrame(workflow, runId, frame, seen);
  const src = srcOf(q.data);
  return (
    <button
      ref={ref}
      type="button"
      title={frame.caption}
      aria-label={`Frame ${n + 1}${frame.caption ? `: ${frame.caption}` : ""}`}
      aria-current={active || undefined}
      onClick={onPick}
      className={cn(
        "aspect-video w-24 shrink-0 overflow-hidden rounded border-2 bg-muted/40 opacity-70 hover:opacity-100",
        active ? "border-foreground/60 opacity-100" : "border-transparent",
        frame.failed && "border-destructive/60",
      )}
    >
      {src && <img src={src} alt="" className="block size-full object-cover object-top" />}
    </button>
  );
}

/** The recording small: its newest frame with a play mark; a click hands it to `onOpen`. */
function Thumb({ workflow, runId, w, pending, onOpen, className }: { workflow: string; runId: string; w: Walkthrough | null; pending: boolean; onOpen?: () => void; className?: string }) {
  const frame = w?.frames.at(-1);
  const q = useFrame(workflow, runId, frame);
  const src = srcOf(q.data);
  const body = (
    <>
      {src ? <img src={src} alt={frame?.caption ?? ""} className="size-full object-cover object-top" /> : (pending || q.isLoading) && <Skeleton className="absolute inset-0 rounded-none" />}
      <PlayMark />
    </>
  );
  const cls = cn("relative block aspect-video w-40 overflow-hidden rounded-md border bg-muted/40", onOpen && "cursor-pointer", className);
  return onOpen ? (
    <button type="button" data-testid="walkthrough-thumb" aria-label={`Play ${w?.title ?? "the walkthrough"}`} onClick={onOpen} className={cls}>
      {body}
    </button>
  ) : (
    <div data-testid="walkthrough-thumb" className={cls}>
      {body}
    </div>
  );
}

/** The play mark on a recording's thumbnail. */
function PlayMark() {
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span className="flex size-7 items-center justify-center rounded-full bg-black/60 text-white">
        <Play aria-hidden className="size-3.5" />
      </span>
    </span>
  );
}
