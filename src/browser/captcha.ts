/**
 * A captcha a PERSON solves (hive's captcha card, hive#5545): the
 * challenge's crop and a manifest naming it, side by side under the shot
 * sink's root — the job's directory on a job run —
 *
 *   shots/captcha-2.png
 *   shots/captcha-2.json   { image: "captcha-2.png", instruction, site, mode,
 *                            round, maxRounds, grid?, askedAt, expiresAt, state }
 *
 * — one pair per round (a later captcha starts again at round 1, over the
 * earlier one's files). The job lists the manifest as an
 * artifact `{ id: "captcha", kind: "captcha", path }`; the host reads it at
 * `/jobs/<job>/files/<path>` and the image beside it, and the person's
 * answer comes back as the job's next turn (`[captcha-answer] {…}`).
 *
 * The manifest is written in code, never typed by a model, to the host's
 * parser (`parseCaptchaManifest`): `image` a bare file name beside the
 * manifest, `instruction` ≤ 500 chars, `site` ≤ 253 (the page's host, read
 * off the page), `round` / `maxRounds` whole numbers ≥ 1, `expiresAt` an ISO
 * time, `grid` rows and cols ≤ 20, `state` one of CAPTCHA_STATES. A field the
 * parser would drop is never written.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { jobFileUrl } from "../artifact-refs.js";
import type { ShotSink } from "./shot.js";

export const CAPTCHA_MODES = ["tap", "text", "either"] as const;
export const CAPTCHA_STATES = ["waiting", "sent", "solved", "failed", "expired"] as const;

export type CaptchaMode = (typeof CAPTCHA_MODES)[number];
export type CaptchaState = (typeof CAPTCHA_STATES)[number];

/** The host's caps on the manifest's fields. */
export const INSTRUCTION_MAX = 500;
export const GRID_MAX = 20;
export const ROUND_MAX = 1000;

export interface CaptchaManifest {
  /** The crop, a file name beside the manifest. */
  image: string;
  instruction?: string;
  /** The page's host: what the workspace's captcha allowlist is checked against. */
  site: string;
  mode: CaptchaMode;
  round: number;
  maxRounds: number;
  grid?: { rows: number; cols: number };
  askedAt: string;
  expiresAt: string;
  state: CaptchaState;
}

/** The artifact a job lists for a round — the same id every round. */
export interface CaptchaArtifact {
  id: "captcha";
  kind: "captcha";
  title: string;
  path: string;
}

/** A round's two files: the crop's name (beside the manifest) and the manifest's path under the sink's root. */
export function captchaFiles(round: number): { name: string; image: string; path: string } {
  return { name: `captcha-${round}`, image: `captcha-${round}.png`, path: `shots/captcha-${round}.json` };
}

/** The manifest for a round asked now. */
export function captchaManifest(input: {
  round: number;
  mode: CaptchaMode;
  site: string;
  instruction?: string;
  grid?: { rows: number; cols: number };
  maxRounds: number;
  expiresInMs: number;
  now?: number;
}): CaptchaManifest {
  const now = input.now ?? Date.now();
  const instruction = input.instruction?.trim();
  return {
    image: captchaFiles(input.round).image,
    ...(instruction ? { instruction: instruction.length > INSTRUCTION_MAX ? `${instruction.slice(0, INSTRUCTION_MAX - 1)}…` : instruction } : {}),
    site: input.site,
    mode: input.mode,
    round: input.round,
    maxRounds: input.maxRounds,
    ...(input.grid ? { grid: { rows: input.grid.rows, cols: input.grid.cols } } : {}),
    askedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.expiresInMs).toISOString(),
    state: "waiting",
  };
}

/** The site a captcha is on: the page's host. A page with none (about:blank, data:) has no captcha a person can be asked about. */
export function siteOf(pageUrl: string): string {
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    /* not a URL */
  }
  if (!host) throw new Error(`browser/captcha-ask: the page (${pageUrl}) has no site to ask about`);
  return host;
}

export function captchaArtifact(manifest: CaptchaManifest): CaptchaArtifact {
  return { id: "captcha", kind: "captcha", title: `Captcha on ${manifest.site}`, path: captchaFiles(manifest.round).path };
}

/** The served link of a file under the sink's root. */
export function sinkUrl(sink: ShotSink, path: string): string {
  return sink.job ? jobFileUrl(sink.job.name, path) : `/artifacts/${sink.runId}/${path}`;
}

/** Write a round's manifest — whole, through a temp file and a rename on a
 *  job's directory, so the host never reads half of one. */
export async function writeCaptcha(sink: ShotSink, manifest: CaptchaManifest): Promise<{ path: string; url: string }> {
  const path = captchaFiles(manifest.round).path;
  const text = JSON.stringify(manifest, null, 2);
  if (sink.job) {
    const abs = join(sink.job.root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(`${abs}.tmp`, text);
    await rename(`${abs}.tmp`, abs);
  } else {
    await sink.artifacts.write(sink.runId, path, text);
  }
  return { path, url: sinkUrl(sink, path) };
}

/** A round's manifest as written; null when there is none. */
export async function readCaptcha(sink: ShotSink, round: number): Promise<CaptchaManifest | null> {
  const path = captchaFiles(round).path;
  try {
    const bytes = sink.job ? await readFile(join(sink.job.root, path)) : await sink.artifacts.read(sink.runId, path);
    return JSON.parse(Buffer.from(bytes).toString("utf-8")) as CaptchaManifest;
  } catch {
    return null;
  }
}

/** Set where a round stands (the card shows it). Null when the round has no manifest. */
export async function markCaptcha(sink: ShotSink, round: number, state: CaptchaState): Promise<{ manifest: CaptchaManifest; path: string; url: string } | null> {
  const manifest = await readCaptcha(sink, round);
  if (!manifest) return null;
  manifest.state = state;
  return { manifest, ...(await writeCaptcha(sink, manifest)) };
}
