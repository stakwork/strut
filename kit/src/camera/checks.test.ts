import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAMERA_CAPABILITY, CAMERA_CHECK_DEFAULTS, createBridgeCamera, parseCaptureParams, runChecks, sharpness, toGray, cameraChecksOf, type CameraChecks, type Pixels } from "./index.js";

const W = 64;
const H = 64;
/** A grey image from a function of x, y. */
const image = (f: (x: number, y: number) => number): Pixels => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.fill(f(x, y), (y * W + x) * 4, (y * W + x) * 4 + 3), (data[(y * W + x) * 4 + 3] = 255);
  return { data, width: W, height: H };
};
const sharp = image((x, y) => ((x >> 2) + (y >> 2)) % 2 ? 230 : 40);
/** The same picture, box-blurred hard. */
const blurred = (() => {
  const g = toGray(sharp);
  const out = new Uint8Array(g.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) (s += g[yy * W + xx]!), n++;
    }
    out[y * W + x] = s / n;
  }
  return image((x, y) => out[y * W + x]!);
})();
const dark = image(() => 10);
const bright = image(() => 250);
const all: CameraChecks = { ...CAMERA_CHECK_DEFAULTS } as CameraChecks;
const photo = { width: 1600, height: 1200 };

describe("the camera's quality checks", () => {
  it("scores a sharp picture above a blurred one of the same scene", () => {
    const s = sharpness(toGray(sharp), W, H);
    const b = sharpness(toGray(blurred), W, H);
    assert.ok(s > CAMERA_CHECK_DEFAULTS.blur.min && b < CAMERA_CHECK_DEFAULTS.blur.min, `sharp ${s}, blurred ${b}`);
    assert.equal(sharpness(toGray(dark), W, H), 0);
  });

  it("passes a sharp, well lit, big enough photo and reports every measurement", () => {
    const r = runChecks(all, sharp, photo);
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
    for (const n of ["blur", "brightness", "resolution"] as const) assert.equal((r.results[n] as { ok: boolean }).ok, true, n);
    assert.equal((r.results.resolution as { value: number }).value, 1600);
  });

  it("names why a photo failed: blur, dark, bright, small", () => {
    assert.deepEqual(runChecks(all, blurred, photo).reasons, ["blur"]);
    assert.deepEqual(runChecks(all, dark, photo).reasons.sort(), ["blur", "dark"]);
    assert.deepEqual(runChecks(all, bright, photo).reasons.sort(), ["blur", "bright"]);
    const small = runChecks(all, sharp, { width: 400, height: 300 });
    assert.deepEqual(small.reasons, ["small"]);
    assert.equal(small.ok, false);
  });

  it("runs only the checks asked for", () => {
    const r = runChecks({ blur: all.blur } as CameraChecks, dark, photo);
    assert.deepEqual(Object.keys(r.results), ["blur"]);
  });

  it("skips what would start past its budget, and a skipped check never fails the photo", () => {
    let t = 0;
    const r = runChecks(all, dark, photo, { budgetMs: 5, now: () => (t += 4) });
    const skipped = Object.values(r.results).filter((x) => "skipped" in x);
    assert.ok(skipped.length > 0);
    assert.ok(skipped.every((x) => (x as { skipped: string }).skipped === "budget"));
    assert.ok(!r.reasons.some((x) => x === "blur"));
    // A check that throws is skipped, not failed.
    const bad = runChecks(all, { data: [], width: W, height: H }, photo);
    assert.deepEqual(bad.results.brightness, { skipped: "error" });
  });
});

describe("a page's checks option", () => {
  it("true is every check at its defaults; an object fills what it leaves out", () => {
    const ok = (p: unknown) => (parseCaptureParams(p) as { ok: true; params: { checks?: CameraChecks; checkBudgetMs?: number } }).params;
    assert.equal(ok({}).checks, undefined);
    assert.equal(ok({ checks: false }).checks, undefined);
    assert.deepEqual(ok({ checks: true }).checks, CAMERA_CHECK_DEFAULTS);
    assert.deepEqual(ok({ checks: { blur: { min: 50 }, brightness: true } }).checks, { blur: { min: 50 }, brightness: CAMERA_CHECK_DEFAULTS.brightness });
    assert.equal(ok({ checks: true, checkBudgetMs: 30, onFail: "warn" }).checkBudgetMs, 30);
  });

  it("refuses what it cannot run", () => {
    const err = (p: unknown) => (parseCaptureParams(p) as { error?: string }).error;
    assert.match(err({ checks: { glare: {} } })!, /unknown check "glare"/);
    assert.match(err({ checks: { blur: { max: 1 } } })!, /no field "max"/);
    assert.match(err({ checks: { blur: { min: "x" } } })!, /is a number/);
    assert.match(err({ checks: "yes" })!, /true or an object/);
    assert.match(err({ checks: { brightness: { min: 200, max: 100 } } })!, /min above max/);
    assert.match(err({ onFail: "block" })!, /onFail is "warn"/);
    assert.match(err({ checkBudgetMs: 0 })!, /checkBudgetMs/);
  });
});

describe("checks over the bridge", () => {
  const report = { ok: false, reasons: ["blur"], results: {}, totalMs: 3 };
  const mk = (cap: unknown, asked: Array<Record<string, unknown> | undefined>) =>
    createBridgeCamera({
      getHostCapabilities: () => ({ experimental: { [CAMERA_CAPABILITY]: cap } }),
      request: async (r) => (asked.push(r.params), { name: "p.jpg", mediaType: "image/jpeg", data: "AQI=", checks: report }),
    });

  it("a host lists its checks; one that lists none runs none", () => {
    assert.deepEqual(cameraChecksOf({ experimental: { [CAMERA_CAPABILITY]: { v: 1, checks: ["blur", "nope", "resolution"] } } }), ["blur", "resolution"]);
    assert.deepEqual(cameraChecksOf({ experimental: { [CAMERA_CAPABILITY]: { v: 1 } } }), []);
    assert.deepEqual(cameraChecksOf({}), []);
  });

  it("sends checks only for what the host runs, and hands the report back with the photo", async () => {
    const asked: Array<Record<string, unknown> | undefined> = [];
    const got = (await mk({ v: 1, checks: ["blur", "brightness"] }, asked).captureOrAction({ checks: { blur: { min: 40 }, resolution: true }, checkBudgetMs: 20, onFail: "warn" })) as { checks?: unknown };
    assert.deepEqual(asked[0], { checks: { blur: { min: 40 } }, checkBudgetMs: 20, onFail: "warn" });
    assert.deepEqual(got.checks, report);
  });

  it("an older host never sees the fields, and the page's photo is the same as before", async () => {
    const asked: Array<Record<string, unknown> | undefined> = [];
    await mk({ v: 1, actions: true }, asked).captureOrAction({ title: "t", checks: true, checkBudgetMs: 20, onFail: "warn" });
    assert.deepEqual(asked[0], { title: "t" });
  });

  it("omitting checks sends none", async () => {
    const asked: Array<Record<string, unknown> | undefined> = [];
    await mk({ v: 1, checks: ["blur"] }, asked).captureOrAction({ title: "t" });
    assert.deepEqual(asked[0], { title: "t" });
  });
});
