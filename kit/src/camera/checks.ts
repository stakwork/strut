/** The camera's quality checks: pure functions over pixels (no DOM, no
 *  dependency), so a host runs them on a small canvas's `ImageData` and a
 *  test on a made-up image. The host hands over a downsampled copy
 *  (`CAMERA_CHECK_SIDE` on its longest side): that is what keeps them cheap
 *  on a low-end phone, and what makes the sharpness score comparable
 *  between devices. Scores are not calibrated to any camera: a page reads
 *  `value` and sets its own thresholds. */
import { CAMERA_CHECK_BUDGET_MS, type CameraCheckName, type CameraCheckReason, type CameraCheckReport, type CameraCheckResult, type CameraChecks } from "./protocol.js";

/** Pixels as a canvas's `getImageData` gives them: RGBA, row by row. */
export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** 8-bit luma of each pixel (integer weights, one pass). */
export function toGray({ data, width, height }: Pixels): Uint8Array {
  if (data.length < width * height * 4) throw new Error("pixels: fewer than width × height RGBA values");
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (77 * data[j]! + 150 * data[j + 1]! + 29 * data[j + 2]!) >> 8;
  return gray;
}

/** Mean brightness, 0 to 255. */
export function meanBrightness(gray: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  return gray.length ? sum / gray.length : 0;
}

/** Sharpness, 0 to 100: the variance of the 3×3 Laplacian (edges are strong
 *  in a sharp picture and wash out in a blurred one), on a log scale. */
export function sharpness(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = 4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!;
      sum += l;
      sumSq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return Math.min(100, 10 * Math.log2(1 + Math.max(0, variance)));
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Runs `checks` on a photo: `small` is the downsampled copy to look at,
 * `photo` the size of the photo the page will get. Cheap checks first; one
 * that would start after `budgetMs` is skipped, a throwing one is skipped,
 * and a skipped check never fails the photo.
 */
export function runChecks(
  checks: CameraChecks,
  small: Pixels,
  photo: { width: number; height: number },
  opts: { budgetMs?: number; now?: () => number } = {},
): CameraCheckReport {
  const now = opts.now ?? (() => performance.now());
  const budget = opts.budgetMs ?? CAMERA_CHECK_BUDGET_MS;
  const t0 = now();
  const results: CameraCheckReport["results"] = {};
  const reasons: CameraCheckReason[] = [];
  let gray: Uint8Array | undefined;
  const run = (name: CameraCheckName, f: () => { ok: boolean; value: number; why?: CameraCheckReason; limits: Record<string, number> }) => {
    if (!checks[name]) return;
    const t = now();
    if (t - t0 > budget) return void (results[name] = { skipped: "budget" });
    try {
      const { ok, value, why, limits } = f();
      results[name] = { ok, value: round(value), ...limits, ms: round(now() - t) } as CameraCheckResult;
      if (!ok && why) reasons.push(why);
    } catch {
      results[name] = { skipped: "error" };
    }
  };
  const grayOf = () => (gray ??= toGray(small));
  run("resolution", () => {
    const value = Math.max(photo.width, photo.height);
    const { minSide } = checks.resolution!;
    return { ok: value >= minSide, value, why: "small", limits: { minSide } };
  });
  run("brightness", () => {
    const value = meanBrightness(grayOf());
    const { min, max } = checks.brightness!;
    return { ok: value >= min && value <= max, value, why: value < min ? "dark" : "bright", limits: { min, max } };
  });
  run("blur", () => {
    const value = sharpness(grayOf(), small.width, small.height);
    const { min } = checks.blur!;
    return { ok: value >= min, value, why: "blur", limits: { min } };
  });
  return { ok: reasons.length === 0, reasons, results, totalMs: round(now() - t0) };
}
