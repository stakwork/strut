// The replay controls every replaying view shares (RunGraph, WalkView): one
// step back, play/pause, one step on, a slider to scrub, the speed, and —
// on a run still in flight, once a person has stepped away from it — Live.
// Presentational: the view says what a step is (a call, a hop) and owns the
// cursor (`useReplay`, ../lib/replay.ts, or its own).
import type { ReactNode } from "react";
import { Pause, Play, Radio, SkipBack, SkipForward } from "lucide-react";
import { REPLAY_SPEEDS } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export interface ReplayBarProps {
  /** Where the replay is, 0 … total (the slider's value). */
  position: number;
  total: number;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSeek: (position: number) => void;
  /** Defaults: back from anywhere past the start, on from anywhere short of the end. */
  canStepBack?: boolean;
  canStepForward?: boolean;
  speed: number;
  onSpeed: (speed: number) => void;
  /** A run in flight: Live shows while the replay is away from its newest step. */
  live?: { following: boolean; onLive: () => void };
  /** What one step is, for the buttons' names: "call", "hop". */
  unit?: string;
  /** Where it is, as text: `hop 3 / 5`. */
  label?: ReactNode;
  className?: string;
}

export function ReplayBar({
  position, total, playing, onPlay, onPause, onStepBack, onStepForward, onSeek, canStepBack, canStepForward, speed, onSpeed, live, unit = "step", label, className,
}: ReplayBarProps) {
  const back = canStepBack ?? position > 0;
  const forward = canStepForward ?? position < total;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} data-testid="replay-bar">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-7 w-7" aria-label={`Previous ${unit}`} disabled={total === 0 || !back} onClick={onStepBack}>
          <SkipBack className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" aria-label={playing ? "Pause" : "Play"} disabled={total === 0} onClick={playing ? onPause : onPlay} data-testid="replay-play">
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" aria-label={`Next ${unit}`} disabled={total === 0 || !forward} onClick={onStepForward}>
          <SkipForward className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Slider className="min-w-32 flex-1" min={0} max={Math.max(total, 1)} step={1} value={[Math.min(position, total)]} disabled={total === 0} onValueChange={([v]) => onSeek(v ?? 0)} aria-label="Replay position" data-testid="replay-slider" />
      <select value={String(speed)} onChange={(e) => onSpeed(Number(e.target.value))} className="h-7 rounded-md border bg-background px-1.5 font-mono text-xs" aria-label="Replay speed" data-testid="replay-speed">
        {REPLAY_SPEEDS.map((s) => (
          <option key={s} value={String(s)}>
            {s}×
          </option>
        ))}
      </select>
      {live && !live.following && (
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs text-emerald-600 dark:text-emerald-400" onClick={live.onLive} data-testid="replay-live">
          <Radio className="h-3.5 w-3.5" /> Live
        </Button>
      )}
      {label !== undefined && <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{label}</span>}
    </div>
  );
}
