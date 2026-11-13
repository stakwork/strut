/**
 * An app's SCREENSHOTS set by a person (`PUT /apps/:name/screenshots`, the
 * Versions flyout's Screenshots section): the list `app.yaml` names, and the
 * image files it names, rewritten in a checked-out copy of a version that is
 * then published like any other edit. The store shows them once the app's
 * package is published again (src/packages/detail.ts).
 *
 * A new image goes in `screenshots/` at the app's root; one taken off the
 * list is deleted only from there, since a file elsewhere (`public/logo.png`)
 * may be the app's own. `app.yaml` keeps its comments and order: only the
 * `screenshots:` key is written.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_TYPES,
  SCREENSHOTS_MAX,
  screenshotPathProblem,
  type AppScreenshot,
} from "./manifest.js";

/** Where a person's new screenshots are written, and the only folder one is deleted from. */
export const SCREENSHOTS_DIR = "screenshots";

/** One entry of the list a person saves: a file the version already holds,
 *  or a new image's bytes (base64) and type. */
export type ScreenshotEntry =
  | { file: string; caption?: string }
  | { data: string; type: string; caption?: string };

const EXTENSION_OF: Record<string, string> = Object.fromEntries(
  Object.entries(SCREENSHOT_TYPES).filter(([ext]) => ext !== ".jpeg").map(([ext, type]) => [type, ext]),
);

/** Why the list cannot be saved, or nothing: what the body must be before a
 *  copy is checked out. The build checks the files again. */
export function screenshotsProblem(list: unknown): string | undefined {
  if (!Array.isArray(list)) return "screenshots is required: a list of { file, caption? } or { data, type, caption? }";
  if (list.length > SCREENSHOTS_MAX) return `at most ${SCREENSHOTS_MAX} screenshots`;
  for (const [i, x] of list.entries()) {
    if (!x || typeof x !== "object") return `screenshots[${i}]: an object`;
    const e = x as Record<string, unknown>;
    if (e.caption !== undefined && (typeof e.caption !== "string" || e.caption.length > 200)) return `screenshots[${i}].caption: text, at most 200 characters`;
    if (typeof e.file === "string") {
      const problem = screenshotPathProblem(e.file);
      if (problem) return `screenshots[${i}]: ${problem}`;
    } else if (typeof e.data === "string" && typeof e.type === "string") {
      if (!EXTENSION_OF[e.type]) return `screenshots[${i}].type: one of ${Object.keys(EXTENSION_OF).join(", ")}`;
      if (Math.floor((e.data.length * 3) / 4) > SCREENSHOT_MAX_BYTES + 3) return `screenshots[${i}]: over ${SCREENSHOT_MAX_BYTES / 1024 / 1024} MB`;
    } else return `screenshots[${i}]: { file } for an image the app has, or { data, type } for a new one`;
  }
  return undefined;
}

/** `app.yaml`'s text with its `screenshots:` key replaced by `list` (taken
 *  out when the list is empty), everything else as it was. */
export function withScreenshots(text: string, list: AppScreenshot[]): string {
  const block = list.length
    ? ["screenshots:", ...list.flatMap((s) => [`  - file: ${JSON.stringify(s.file)}`, ...(s.caption ? [`    caption: ${JSON.stringify(s.caption)}`] : [])])].join("\n") + "\n"
    : "";
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^screenshots\s*:/.test(l));
  let out: string;
  if (start < 0) {
    out = block ? `${text}${text.endsWith("\n") || !text ? "" : "\n"}${block}` : text;
  } else {
    // The key's block: its own line, then every line indented under it, a
    // list item at the margin, or blank — trailing blanks stay outside.
    let end = start + 1;
    while (end < lines.length && (/^(\s+|-\s|-$)/.test(lines[end]!) || lines[end] === "")) end++;
    while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
    const mid = block ? block.slice(0, -1).split("\n") : [];
    out = [...lines.slice(0, start), ...mid, ...lines.slice(end)].join("\n");
  }
  // Read back: a manifest laid out some other way gets a plain rewrite.
  const want = list.length ? list.map((s) => ({ file: s.file, ...(s.caption ? { caption: s.caption } : {}) })) : undefined;
  try {
    const read = (yaml.load(out) ?? {}) as Record<string, unknown>;
    if (JSON.stringify(read.screenshots) === JSON.stringify(want)) return out;
  } catch {
    // not YAML any more: the plain rewrite below
  }
  const doc = { ...((yaml.load(text) ?? {}) as Record<string, unknown>) };
  if (want) doc.screenshots = want;
  else delete doc.screenshots;
  return yaml.dump(doc, { lineWidth: 120, noRefs: true });
}

/** Write `entries` into the app directory `dir`: new images into
 *  `screenshots/`, ones dropped from there deleted, `app.yaml` rewritten.
 *  Returns the list as `app.yaml` now names it. */
export async function applyScreenshots(dir: string, entries: ScreenshotEntry[]): Promise<AppScreenshot[]> {
  const manifestPath = join(dir, "app.yaml");
  const text = await readFile(manifestPath, "utf8");
  const before = ((yaml.load(text) ?? {}) as { screenshots?: unknown }).screenshots;
  const had = (Array.isArray(before) ? before : [])
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { file?: unknown }).file === "string" ? (x as { file: string }).file : null))
    .filter((f): f is string => !!f);
  const taken = new Set((await readdir(join(dir, SCREENSHOTS_DIR)).catch(() => [] as string[])).map((f) => `${SCREENSHOTS_DIR}/${f}`));
  for (const e of entries) if ("file" in e) taken.add(e.file);
  const next = (ext: string): string => {
    for (let n = 1; ; n++) {
      const file = `${SCREENSHOTS_DIR}/${n}${ext}`;
      if (!taken.has(file)) return taken.add(file), file;
    }
  };
  const list: AppScreenshot[] = [];
  for (const e of entries) {
    let file: string;
    if ("file" in e) file = e.file;
    else {
      file = next(EXTENSION_OF[e.type]!);
      await mkdir(join(dir, SCREENSHOTS_DIR), { recursive: true });
      await writeFile(join(dir, file), Buffer.from(e.data, "base64"));
    }
    list.push({ file, ...(e.caption?.trim() ? { caption: e.caption.trim() } : {}) });
  }
  const kept = new Set(list.map((s) => s.file));
  for (const file of had) {
    if (!kept.has(file) && file.startsWith(`${SCREENSHOTS_DIR}/`) && !screenshotPathProblem(file)) await rm(join(dir, file), { force: true });
  }
  await writeFile(manifestPath, withScreenshots(text, list));
  return list;
}
