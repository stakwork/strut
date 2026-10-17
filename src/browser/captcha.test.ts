/**
 * The captcha manifest (captcha.ts) against the reader it is written for:
 * hive's `parseCaptchaManifest` (hive#5545,
 * src/app/org/[githubLogin]/_components/artifacts/captchaTaps.ts), ported
 * below rule for rule. A field that parser would drop is a card missing its
 * image, its site or its clock — so every field we write must survive it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { fileArtifactsCapability } from "../capabilities.js";
import { BrowserService } from "./service.js";
import { captchaArtifact, captchaManifest, markCaptcha, readCaptcha, siteOf, writeCaptcha } from "./captcha.js";
import type { ShotSink } from "./shot.js";

// ── hive's parser, verbatim in its rules ─────────────────────────────────────
const IMAGE_FILE = /^[\w.-]+\.(png|jpe?g|webp|gif)$/i;
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined);
function parseCaptchaManifest(raw: unknown, key: string): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const dir = key.slice(0, key.lastIndexOf("/") + 1);
  const file = str(m["image"], 200);
  const grid = typeof m["grid"] === "object" && m["grid"] !== null ? (m["grid"] as Record<string, unknown>) : null;
  const rows = grid ? int(grid["rows"], 20) : undefined;
  const cols = grid ? int(grid["cols"], 20) : undefined;
  const state = (["waiting", "sent", "solved", "failed", "expired"] as const).find((s) => s === m["state"]);
  const mode = (["tap", "text", "either"] as const).find((s) => s === m["mode"]);
  const instruction = str(m["instruction"], 500);
  const site = str(m["site"], 253);
  const round = int(m["round"], 1000);
  const maxRounds = int(m["maxRounds"], 1000);
  const expiresAt = str(m["expiresAt"], 40);
  return {
    ...(file && IMAGE_FILE.test(file) ? { imageKey: `${dir}${file}` } : {}),
    ...(instruction ? { instruction } : {}),
    ...(site ? { site } : {}),
    ...(mode ? { mode } : {}),
    ...(round ? { round } : {}),
    ...(maxRounds ? { maxRounds } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(rows && cols ? { grid: { rows, cols } } : {}),
    ...(state ? { state } : {}),
  };
}

const NOW = Date.parse("2026-10-16T20:00:00.000Z");

test("the manifest survives hive's parser whole: a bare image name beside it, the site, the clock, the grid", () => {
  const m = captchaManifest({ round: 2, mode: "tap", site: "www.google.com", instruction: "Select all images with a bus", grid: { rows: 3, cols: 3 }, maxRounds: 5, expiresInMs: 600_000, now: NOW });
  assert.deepEqual(m, {
    image: "captcha-2.png",
    instruction: "Select all images with a bus",
    site: "www.google.com",
    mode: "tap",
    round: 2,
    maxRounds: 5,
    grid: { rows: 3, cols: 3 },
    askedAt: "2026-10-16T20:00:00.000Z",
    expiresAt: "2026-10-16T20:10:00.000Z",
    state: "waiting",
  });
  const key = "/jobs/job-1/files/shots/captcha-2.json";
  assert.deepEqual(parseCaptchaManifest(m, key), {
    imageKey: "/jobs/job-1/files/shots/captcha-2.png",
    instruction: "Select all images with a bus",
    site: "www.google.com",
    mode: "tap",
    round: 2,
    maxRounds: 5,
    expiresAt: "2026-10-16T20:10:00.000Z",
    grid: { rows: 3, cols: 3 },
    state: "waiting",
  });
  assert.deepEqual(captchaArtifact(m), { id: "captcha", kind: "captcha", title: "Captcha on www.google.com", path: "shots/captcha-2.json" });
});

test("an instruction past hive's 500 chars is cut to fit, never dropped; no instruction and no grid are left out", () => {
  const long = captchaManifest({ round: 1, mode: "text", site: "a.example", instruction: "x".repeat(800), maxRounds: 5, expiresInMs: 1, now: NOW });
  assert.equal(long.instruction!.length, 500);
  assert.equal(parseCaptchaManifest(long, "shots/captcha-1.json")!["instruction"], long.instruction);
  const bare = captchaManifest({ round: 1, mode: "either", site: "a.example", instruction: "  ", maxRounds: 5, expiresInMs: 1, now: NOW });
  assert.ok(!("instruction" in bare) && !("grid" in bare));
});

test("the site is the page's host; a page with none has no captcha to ask about", () => {
  assert.equal(siteOf("https://www.google.com/recaptcha/api2/demo"), "www.google.com");
  assert.equal(siteOf("http://127.0.0.1:3000/x"), "127.0.0.1");
  assert.throws(() => siteOf("about:blank"), /has no site/);
  assert.throws(() => siteOf("data:text/html,hi"), /has no site/);
});

async function withJob<T>(fn: (sink: ShotSink, root: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "strut-captcha-"));
  try {
    const root = join(dir, "jobs", "job-1");
    return await fn({ artifacts: fileArtifactsCapability(join(dir, "artifacts")), runId: "r1", job: { name: "job-1", root } }, root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a round's state is set on its manifest in place; a round never asked is null", async () => {
  await withJob(async (sink, root) => {
    const m = captchaManifest({ round: 1, mode: "tap", site: "a.example", maxRounds: 5, expiresInMs: 1000, now: NOW });
    assert.deepEqual(await writeCaptcha(sink, m), { path: "shots/captcha-1.json", url: "/jobs/job-1/files/shots/captcha-1.json" });
    const marked = await markCaptcha(sink, 1, "solved");
    assert.equal(marked?.manifest.state, "solved");
    assert.deepEqual(await readCaptcha(sink, 1), { ...m, state: "solved" });
    assert.equal(await markCaptcha(sink, 2, "failed"), null);
    assert.deepEqual(await readdir(join(root, "shots")), ["captcha-1.json"], "no temp file left behind");
  });
});

// ── BrowserService.captcha over a fake page ──────────────────────────────────

/** A real 390×390 PNG, so saveShot's downscale has something to read. */
async function png(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width: 390, height: 390, channels: 3, background: "#4a90d9" } }).png().toBuffer();
}

class Fake extends BrowserService {
  shot = Buffer.alloc(0);
  cropped: string[] = [];
  pageUrl = "https://www.google.com/recaptcha/api2/demo";
  protected override async launch(): Promise<Browser> {
    const browser = {
      isConnected: () => true,
      on: () => {},
      close: async () => {},
      newContext: async () => ({
        browser: () => browser,
        close: async () => {},
        newPage: async () => ({
          isClosed: () => false,
          setDefaultTimeout: () => {},
          on: () => {},
          url: () => this.pageUrl,
          title: async () => "reCAPTCHA demo",
          locator: (selector: string) => ({
            screenshot: async () => {
              this.cropped.push(selector);
              return this.shot;
            },
          }),
        }),
      }),
    };
    return browser as unknown as Browser;
  }
}

test("captcha: the element's crop and the manifest land side by side in the job's shots/, hive reads both, and the crop is not announced", async () => {
  await withJob(async (sink, root) => {
    const told: unknown[] = [];
    const svc = new Fake({ wsUrl: "ws://fake:3000" });
    svc.shot = await png();
    await svc.page("r1");
    const out = await svc.captcha(
      "r1",
      { selector: "iframe[title*=challenge] >> internal:control=enter-frame >> table", round: 1, mode: "tap", grid: { rows: 3, cols: 3 }, instruction: "Select all images with a bus" },
      { ...sink, notify: (u) => void told.push(u) },
    );
    assert.deepEqual(svc.cropped, ["iframe[title*=challenge] >> internal:control=enter-frame >> table"]);
    assert.deepEqual(told, [], "no image card beside the captcha's own");
    assert.equal(out.path, "shots/captcha-1.json");
    assert.equal(out.url, "/jobs/job-1/files/shots/captcha-1.json");
    assert.deepEqual({ path: out.image.path, url: out.image.url, width: out.image.width }, { path: "shots/captcha-1.png", url: "/jobs/job-1/files/shots/captcha-1.png", width: 390 });
    assert.ok(out.small.length > 0);
    assert.deepEqual((await readdir(join(root, "shots"))).sort(), ["captcha-1.json", "captcha-1.png"]);

    const raw = JSON.parse(await readFile(join(root, "shots", "captcha-1.json"), "utf-8"));
    const parsed = parseCaptchaManifest(raw, out.url)!;
    assert.equal(parsed["imageKey"], "/jobs/job-1/files/shots/captcha-1.png", "the image hive will load is the crop we wrote");
    assert.deepEqual(
      { ...parsed, expiresAt: undefined },
      { imageKey: parsed["imageKey"], instruction: "Select all images with a bus", site: "www.google.com", mode: "tap", round: 1, maxRounds: 5, expiresAt: undefined, grid: { rows: 3, cols: 3 }, state: "waiting" },
    );
    const left = Date.parse(raw.expiresAt) - Date.parse(raw.askedAt);
    assert.equal(left, 600_000, "ten minutes by default");

    await assert.rejects(svc.captcha("r1", { selector: "table", round: 6, mode: "tap" }, sink), /round 6 is past maxRounds \(5\)/);
    svc.pageUrl = "about:blank";
    await assert.rejects(svc.captcha("r1", { selector: "table", round: 1, mode: "tap" }, sink), /has no site/);
    await svc.close();
  });
});
