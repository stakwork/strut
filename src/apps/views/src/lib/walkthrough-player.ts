// The walkthrough player's moves (components/WalkthroughPlayer.tsx), pure so
// they test without a page: where the manifest is served, which frame shows,
// what Play does, the step bar under the slider, a key's step, and how far
// the filmstrip scrolls to keep the frame shown in view.

/** How long each frame shows while playing. */
export const STEP_MS = 800;

/** How often a recording still being made is read again. */
export const RECORDING_POLL_MS = 3_000;

const STATUS_WORDS: Record<string, string> = { recording: "Recording…", done: "Done", stopped: "Stopped" };

/** A manifest's status as the player says it; one it does not know, as written. */
export const statusText = (status: string): string => STATUS_WORDS[status] ?? status;

/** The manifest's served path, which its frames resolve against: the path
 *  itself when it is served (`/artifacts/<runId>/…`, `/jobs/<job>/files/…`),
 *  else the run's `/artifacts/<runId>/<path>`. */
export function servedPath(path: string, runId: string): string {
  return path.startsWith("/") ? path : `/artifacts/${runId}/${path}`;
}

/** The frame shown: the one picked, else (`at` null) the newest while it
 *  records and the first once it is made — a finished recording is watched
 *  from its start — kept within the frames there are. */
export function frameIndex(at: number | null, count: number, recording = true): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(at ?? (recording ? count - 1 : 0), count - 1));
}

/** What picking frame `n` leaves in `at`: `n` — or null, following the
 *  newest frame again, when the pick is the newest of a recording still
 *  being made. */
export function pickFrame(n: number, count: number, recording: boolean): number | null {
  return recording && n >= count - 1 ? null : n;
}

/** Where Play starts: where the reader is, or frame 1 when that is the end. */
export function playFrom(i: number, count: number): number {
  return i >= count - 1 ? 0 : i;
}

/** One beat of play: the next frame, and whether to play on — not once the last is shown. */
export function playBeat(i: number, count: number): { at: number; playing: boolean } {
  const at = Math.min(i + 1, count - 1);
  return { at, playing: at < count - 1 };
}

/** The frame an arrow key steps to — ← one back, → one on, held at the ends —
 *  or null for any other key. */
export function keyStep(key: string, i: number, count: number): number | null {
  if (key === "ArrowLeft") return Math.max(0, i - 1);
  if (key === "ArrowRight") return Math.min(count - 1, i + 1);
  return null;
}

export interface StepSegment {
  /** The darker of the two blues: every other segment, from the first. */
  dark: boolean;
  /** Still ahead of the frame shown: drawn faded. */
  ahead: boolean;
}

/** The bar under the slider: one segment from each frame to the next, two
 *  blues alternating, the ones the frame shown has not reached faded. */
export function stepSegments(count: number, i: number): StepSegment[] {
  return Array.from({ length: Math.max(0, count - 1) }, (_, n) => ({ dark: n % 2 === 0, ahead: n >= i }));
}

/** The filmstrip's `scrollLeft` that shows a thumbnail at `left`, `width`
 *  wide, in a strip `view` wide now scrolled to `scroll`: unchanged when the
 *  thumbnail is in view, else just far enough to bring it in. */
export function stripScroll(left: number, width: number, scroll: number, view: number): number {
  if (left < scroll) return left;
  if (left + width > scroll + view) return Math.min(left, left + width - view);
  return scroll;
}
