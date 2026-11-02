/**
 * An app's per-VIEWER state: what one person's page remembers between
 * visits — a tab, a filter, a draft. A page has no browser storage: every
 * host frames it as `srcdoc` under `sandbox="allow-scripts"` with no
 * `allow-same-origin` (web/src/components/AppHost.tsx, Hive's and Peel's
 * frames alike), so its origin is opaque and `localStorage`,
 * `sessionStorage`, IndexedDB and cookies all throw — and the origin it
 * would get otherwise is its host's, credential and all. So strut keeps it:
 * one JSON object per (app, viewer), `<dataDir>/apps/<name>/.state/<sha256
 * of the actor>.json`, read and written by the `app/state` step through
 * `step_run` (always granted, never kept as a run) and the kit's
 * `useAppState`. On every backend, like the version directories. Every
 * version shares it, the builder's previews too, so a publish keeps what
 * people set; it follows the person to every host and device. A strut
 * that names no actor keeps one state for everyone. Small by design
 * (`APP_STATE_MAX_BYTES`): what an agent should find belongs in the graph,
 * a person's files in a job's uploads.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withLock } from "../jobs.js";
import { appDir, appsRoot } from "./files.js";

export type AppState = Record<string, unknown>;

/** The state folder inside an app's folder (a dot folder, as `.usage`). */
export const APP_STATE_DIR = ".state";
/** One viewer's whole state, as JSON. */
export const APP_STATE_MAX_BYTES = 256 * 1024;
export const APP_STATE_KEY_MAX = 200;

export function appStateFile(dataDir: string, app: string, actor?: string): string {
  const who = actor ? createHash("sha256").update(actor).digest("hex") : "_";
  return join(appDir(appsRoot(dataDir), app), APP_STATE_DIR, `${who}.json`);
}

async function readFileState(file: string): Promise<AppState> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as AppState;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

export function readAppState(dataDir: string, app: string, actor?: string): Promise<AppState> {
  return readFileState(appStateFile(dataDir, app, actor));
}

/** Set keys (`null` removes one) and answer the whole state. Refused, with
 *  nothing written, past the size cap. */
export function updateAppState(dataDir: string, app: string, actor: string | undefined, set: Record<string, unknown>): Promise<AppState> {
  const file = appStateFile(dataDir, app, actor);
  for (const key of Object.keys(set)) {
    if (!key || key.length > APP_STATE_KEY_MAX) throw new Error(`app/state: a key is 1 to ${APP_STATE_KEY_MAX} characters`);
  }
  return withLock(`app-state:${file}`, async () => {
    const state = await readFileState(file);
    for (const [key, value] of Object.entries(set)) {
      if (value === null || value === undefined) delete state[key];
      else state[key] = value;
    }
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > APP_STATE_MAX_BYTES) {
      throw new Error(
        `app/state: this viewer's state would be ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB, over the ${APP_STATE_MAX_BYTES / 1024} KB cap — ` +
          "it is for what one person's page remembers (a tab, a filter, a draft); data others or an agent should see goes in the graph, files in a job (useUpload)",
      );
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, text);
    await rename(`${file}.tmp`, file);
    return state;
  });
}

/** Every viewer's state of an app — when the app is deleted, so a new app
 *  of the same name starts with none. */
export async function removeAppState(dataDir: string, app: string): Promise<void> {
  await rm(join(appDir(appsRoot(dataDir), app), APP_STATE_DIR), { recursive: true, force: true });
}
