// ZoomImage's steps, pure: a share of the image's own pixels.

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** The next zoom from `zoom` (null: fitted to its box) one step in `dir`:
 *  from fit, in is 100% and out is 50%; past either end it stays there. */
export function zoomStep(zoom: number | null, dir: 1 | -1): number {
  if (zoom === null) return dir > 0 ? 1 : 0.5;
  if (dir > 0) return STEPS.find((s) => s > zoom + 1e-9) ?? STEPS[STEPS.length - 1]!;
  return [...STEPS].reverse().find((s) => s < zoom - 1e-9) ?? STEPS[0]!;
}
