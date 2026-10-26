/**
 * A data folder moved from another host (AGENTS.md, "Moving a data
 * folder"). Whoever
 * copies a stopped strut's folder to a new host — Peel moving the brain to
 * a home server, the server's setup service sending it back — leaves a
 * `moved.json` at the folder's root. The next boot, before any store opens,
 * reads it, rewrites what still points at the old host, and removes it:
 *
 *   {
 *     "from": "/Users/tom/Library/Application Support/Peel/Strut/workspace",
 *     "bridge": {
 *       "from": { "url": "http://127.0.0.1:54321", "token": "<old token>" },
 *       "to":   { "url": "http://127.0.0.1:8090",  "token": "<new token>" }
 *     },
 *     "secrets": { "PEEL_BRIDGE_PORT": "8090", "PEEL_BRIDGE_TOKEN": "<new token>" }
 *   }
 *
 * Every field is optional.
 *
 *   - `from`: the folder's absolute path on the old host. Paths strut saved
 *     into the conversations it replays — chat uploads (`uploads/`) and run
 *     attachments (`artifacts/`), in `chats/` and `sessions/` messages —
 *     are moved onto this folder's path. Run history is left as it is.
 *   - `bridge`: a callback host the old strut posted to, and where it is
 *     now. Every stored callback that starts with `from.url` — automations'
 *     run.end URLs, runs' `callback.json` / `job-callback.json` / `mcp.json`,
 *     `jobs/.callbacks/` — is moved onto `to.url`, and `from.token` in it
 *     becomes `to.token`. Leave it out when the new host's bridge is not
 *     known yet: the host points them anew once it is, as Peel does at
 *     every bridge start.
 *   - `secrets`: deployment secrets to set (a string) or delete (`null`)
 *     through the secret store.
 *
 * Files rebuilt at boot or tied to the old machine (`DROP`) are removed,
 * and so are each job's checkouts (`jobCheckouts`), which its record then
 * forgets; the job's own files stay. Each step can run again with the same
 * result, so a boot cut short does the whole move again; the file goes only
 * once all of it is done. A
 * `moved.json` that cannot be read or parsed fails the boot.
 */
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AUTOMATION_CALLBACKS_FILE } from "./automations.js";
import { FileSecretStore } from "./secret-store.js";

export const MOVED_FILE = "moved.json";

const endpoint = z.object({ url: z.string().url(), token: z.string().min(1) }).strict();

export const movedSchema = z
  .object({
    from: z.string().refine((p) => p.startsWith("/"), "must be an absolute path").optional(),
    bridge: z.object({ from: endpoint, to: endpoint }).strict().optional(),
    secrets: z.record(z.string(), z.string().nullable()).optional(),
  })
  .strict();

export type Moved = z.infer<typeof movedSchema>;

/** Under the data folder: rebuilt at boot, scratch, or tied to the old
 *  machine (peel docs/always-on.md, "What in strut's folder is tied to the
 *  Mac"). A job's checkouts are too, but they sit among the job's own files:
 *  `jobCheckouts`. */
const DROP = [
  "steps/_graph",
  "steps/_graph-versions",
  "graph/snapshots",
  "memory/snapshots",
  "memory/backups",
  "audio/tmp",
  "audio/dictation.json",
  "repos",
  "worktrees",
  "privacy/vault",
  "acp/sessions",
];
/** Top-level names dropped by pattern: a store's temp file, a secret file
 *  moved aside, the file workspace kept after its import. */
const DROP_TOP = /^(?:[^/]+\.json\.(?:corrupt-[^/]+|[0-9a-f-]{36}\.tmp)|fs-workspace\.imported-.+)$/;

/** Whether a path under the data folder (`/`-separated) is left out when
 *  strut packs the folder to move it (src/move/archive.ts): what a move
 *  drops on arrival, temp files anywhere, and a `moved.json` not applied
 *  yet (the receiving side writes its own). `leftBehindIn` adds the jobs'
 *  checkouts. */
export function leftBehind(rel: string, dir: boolean): boolean {
  if (DROP.includes(rel) || (!rel.includes("/") && DROP_TOP.test(rel)) || rel === MOVED_FILE) return true;
  return !dir && rel.endsWith(".tmp");
}

/** `leftBehind` for the data folder at `root`, its jobs' checkouts included. */
export async function leftBehindIn(root: string): Promise<(rel: string, dir: boolean) => boolean> {
  const checkouts = new Set((await jobCheckouts(resolve(root))).flatMap((j) => j.checkouts));
  return (rel, dir) => leftBehind(rel, dir) || (dir && checkouts.has(rel));
}

/** Each job's checkouts, as `/`-separated paths under the data folder. A
 *  job's folder holds its own files (a plan, screenshots, deliverables) and
 *  the repositories `git/checkout` put there, which its record lists in
 *  `repos` by absolute path on the host that made them (src/jobs.ts). A
 *  checkout is a worktree of a cache in `repos/`, which never moves, so the
 *  job's files move and its checkouts stay behind. Each is found by what
 *  follows its own job's folder in that path, whichever host wrote it. */
async function jobCheckouts(root: string): Promise<Array<{ record: string; checkouts: string[] }>> {
  const out: Array<{ record: string; checkouts: string[] }> = [];
  for (const name of await list(join(root, "jobs"))) {
    if (!name.endsWith(".json")) continue;
    const job = name.slice(0, -".json".length);
    let repos: Record<string, unknown> = {};
    try {
      repos = (JSON.parse(await readFile(join(root, "jobs", name), "utf-8")) as { repos?: Record<string, unknown> }).repos ?? {};
    } catch {
      continue; // not a record strut can read: nothing to leave out
    }
    const checkouts: string[] = [];
    for (const dir of Object.keys(repos)) {
      const path = dir.replaceAll("\\", "/").replace(/\/+$/, "");
      const at = path.lastIndexOf(`/jobs/${job}/`);
      const rest = at < 0 ? "" : path.slice(at + `/jobs/${job}/`.length);
      if (rest && !rest.split("/").some((p) => !p || p === "." || p === "..")) checkouts.push(`jobs/${job}/${rest}`);
    }
    if (Object.keys(repos).length) out.push({ record: join(root, "jobs", name), checkouts });
  }
  return out;
}

/** Read `<dataDir>/moved.json` and apply it; nothing when there is none.
 *  Returns what it did, for the boot log and tests. */
export async function applyMove(dataDir: string): Promise<{ applied: boolean; rewritten: number; dropped: number }> {
  const root = resolve(dataDir);
  const file = join(root, MOVED_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { applied: false, rewritten: 0, dropped: 0 };
    throw err;
  }
  let moved: Moved;
  try {
    moved = movedSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : err}`);
  }

  let dropped = 0;
  for (const rel of DROP) dropped += await remove(join(root, rel));
  for (const name of await list(root)) if (DROP_TOP.test(name)) dropped += await remove(join(root, name));
  for (const name of await list(join(root, "jobs"))) if (name.endsWith(".json.tmp")) dropped += await remove(join(root, "jobs", name));

  let rewritten = 0;
  // A job's checkouts went with `repos/` above: a mover leaves them out, a
  // plain copy brings them broken. The job's files stay; its record forgets
  // them, and the job's next `git/checkout` makes them again.
  for (const { record, checkouts } of await jobCheckouts(root)) {
    for (const rel of checkouts) dropped += await remove(join(root, ...rel.split("/")));
    rewritten += await rewriteText(record, (text) => JSON.stringify({ ...(JSON.parse(text) as object), repos: {} }, null, 2));
  }

  const from = moved.from?.replace(/\/+$/, "");
  if (from && from !== root) {
    const paths = pathRewriter(from, root);
    for (const dir of ["chats", "sessions"]) {
      for (const id of await list(join(root, dir))) rewritten += await rewriteText(join(root, dir, id, "messages.jsonl"), paths);
    }
  }

  if (moved.bridge) {
    const { from: was, to: now } = moved.bridge;
    const url = urlRewriter(was, now);
    const token = (s: string) => s.split(was.token).join(now.token);
    const json = (text: string) => JSON.stringify(rewriteUrls(JSON.parse(text) as unknown, url, token));
    for (const run of await runDirs(root)) {
      for (const name of ["callback.json", "job-callback.json", "mcp.json"]) rewritten += await rewriteText(join(run, name), json);
    }
    const callbacks = join(root, "jobs", ".callbacks");
    for (const name of await list(callbacks)) if (name.endsWith(".json")) rewritten += await rewriteText(join(callbacks, name), json);
    const automations = new FileSecretStore(root, AUTOMATION_CALLBACKS_FILE);
    for (const { name } of await automations.list()) {
      const before = await automations.get(name);
      const after = before === undefined ? before : url(before);
      if (after !== before) {
        await automations.set(name, after!);
        rewritten++;
      }
    }
  }

  if (moved.secrets) {
    const secrets = new FileSecretStore(root);
    for (const [name, value] of Object.entries(moved.secrets)) {
      if (value === null) await secrets.delete(name);
      else if ((await secrets.get(name)) !== value) await secrets.set(name, value);
    }
  }

  await rm(file, { force: true });
  console.log(`[moved] ${root} came from ${moved.from ?? "another host"}: ${rewritten} file(s) and callback(s) rewritten, ${dropped} host-bound part(s) dropped`);
  return { applied: true, rewritten, dropped };
}

/** `from` → `to` where it starts a path (not inside a longer one), for
 *  `uploads/` and `artifacts/`, in text that may be JSON: both are written
 *  as JSON escapes them. Never changes a line count. */
function pathRewriter(from: string, to: string): (text: string) => string {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const re = new RegExp(`(?<![\\w.~/-])${esc(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/(?:uploads|artifacts)/)`, "g");
  const target = esc(to);
  return (text) => text.replace(re, () => target);
}

/** A URL that starts with `from.url` (at a path boundary) moved onto
 *  `to.url`, `from.token` in it becoming `to.token`; any other unchanged. */
function urlRewriter(from: { url: string; token: string }, to: { url: string; token: string }): (url: string) => string {
  const base = from.url.replace(/\/+$/, "");
  const target = to.url.replace(/\/+$/, "");
  return (url) => {
    if (!url.startsWith(base) || !/^(?:$|[/?#])/.test(url.slice(base.length))) return url;
    return (target + url.slice(base.length)).split(from.token).join(to.token);
  };
}

/** Every `url` field in a callback or MCP file; an MCP server whose URL was
 *  the bridge's also gets the new token in its `token` and headers. */
function rewriteUrls(value: unknown, url: (u: string) => string, token: (s: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteUrls(v, url, token));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj["url"] !== "string") return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, rewriteUrls(v, url, token)]));
  const next = url(obj["url"]);
  if (next === obj["url"]) return obj;
  const out: Record<string, unknown> = { ...obj, url: next };
  if (typeof obj["token"] === "string") out["token"] = token(obj["token"]);
  if (obj["headers"] && typeof obj["headers"] === "object") {
    out["headers"] = Object.fromEntries(Object.entries(obj["headers"] as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? token(v) : v]));
  }
  return out;
}

/** Rewrite a file in place (temp file, then rename) when `fn` changes it.
 *  A missing file is nothing to do. Returns 1 when it was rewritten. */
async function rewriteText(file: string, fn: (text: string) => string): Promise<number> {
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return 0;
    throw err;
  }
  const next = fn(text);
  if (next === text) return 0;
  const tmp = `${file}.moved.tmp`;
  await writeFile(tmp, next, { mode: 0o600 });
  await rename(tmp, file);
  return 1;
}

/** Every run's folder, in each of the run store's buckets
 *  (`workflows/<name>/runs/<id>`, `steps/<type…>/runs/<id>`,
 *  `checks/<id>/runs/<id>`; store.ts `FileRunStore`). */
async function runDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const name of await list(dir)) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (name === "runs") for (const id of await list(path)) out.push(join(path, id));
      else if (depth < 8) await walk(path, depth + 1);
    }
  };
  for (const bucket of ["workflows", "steps", "checks"]) await walk(join(root, bucket), 0);
  return out;
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function remove(path: string): Promise<number> {
  try {
    await rm(path, { recursive: true });
    return 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}
