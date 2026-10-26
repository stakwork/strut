// What a move carries, before it is sealed (AGENTS.md, "Moving strut to
// another host"): a gzip-compressed ustar archive of
//
//   move.json          the manifest (`Manifest`)
//   env.json           { strut: {KEY: value}, sidecars: { <name>: {KEY: value} } }
//   host-config.json   STRUT_HOST_CONFIG's file, when the move has one
//   data/…             strut's data folder, minus what is left behind (moved.ts `leftBehind`)
//   sidecars/<name>…   each sidecar: a folder (or one file), opaque
//
// Regular files only. Written and read as streams, so a large workspace
// never has to fit in memory.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { z } from "zod";
import { bootEnv } from "../env.js";
import { applyMove, leftBehind, MOVED_FILE, type Moved } from "../moved.js";
import { parseTarHeader, TAR_END, tarHeader, tarPadding } from "../tar.js";

export const FORMAT = "strut-move";
export const FORMAT_VERSION = 1;

/** Where a move's parts are on this host: read from when packing, written
 *  to when unpacking. */
export interface MoveFolders {
  /** strut's data folder (STRUT_WORKSPACE). */
  data: string;
  /** STRUT_HOST_CONFIG's file. */
  hostConfig?: string;
  /** Each sidecar's folder or file, by name. */
  sidecars?: Record<string, string>;
  /** strut's own env values. Packing also takes a sidecar's here, as `<name>.KEY`. */
  envFile?: string;
  /** Each sidecar's env values, by name. */
  sidecarEnv?: Record<string, string>;
}

/** A host's bridge: where callbacks reach it. */
export interface Endpoint {
  url: string;
  token: string;
}

const endpointSchema = z.object({ url: z.string().url().refine((u) => /^https?:/.test(u), "must be http(s)"), token: z.string().min(1) }).strict();

const manifestSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(FORMAT_VERSION),
  /** The packing strut's version (`moveVersion`). */
  strut: z.string(),
  graph: z.string().nullable(),
  created: z.string(),
  /** The data folder's absolute path where it was packed. */
  from: z.string(),
  hostConfig: z.boolean(),
  sidecars: z.array(z.string()),
  /** The bridge the packed folder's callbacks point at. */
  callbacks: endpointSchema.optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export interface MoveEnv {
  strut: Record<string, string>;
  sidecars: Record<string, Record<string, string>>;
}

export const SIDECAR_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** strut's settings that belong to a host, never carried by a move. */
const HOST_KEYS = new Set([
  "STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_PORT", "STRUT_HOST", "STRUT_WORKSPACE", "STRUT_HOST_CONFIG", "STRUT_PUBLIC_URL",
  "STRUT_WEB_DIST", "STRUT_CACHE_DIR", "STRUT_MODEL_DIR", "STRUT_MODEL_CACHE", "STRUT_GRAPH_DB", "STRUT_MEMORY_DB",
  "STRUT_LADYBUG_EXTENSION_DIR", "STRUT_EXIT_ON_STDIN_EOF", "STRUT_READY_KEY", "STRUT_VERSION",
]);

/** What `check` compares: a move only goes between equal struts. `STRUT_VERSION`
 *  is the build a packager names (a commit); else package.json's version. `graph`
 *  is the Ladybug core the graph files were written with. */
export function moveVersion(): { strut: string; graph: string | null } {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string };
  // Its package.json is not in its exports: found where node would look.
  let graph: string | null = null;
  for (const dir of createRequire(import.meta.url).resolve.paths("@ladybugdb/core") ?? []) {
    try {
      graph = (JSON.parse(readFileSync(join(dir, "@ladybugdb", "core", "package.json"), "utf-8")) as { version: string }).version;
      break;
    } catch {
      /* not here */
    }
  }
  return { strut: bootEnv()["STRUT_VERSION"] || pkg.version, graph };
}

// ── env files ──────────────────────────────────────────────────────────────

/** `KEY=value` lines; `#` comments and blank lines skipped; a value in
 *  single quotes (as `writeEnvFile` writes it) unquoted. */
export function parseEnv(text: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`${file}: bad line ${JSON.stringify(line)}`);
    let value = line.slice(eq + 1);
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("'\\''", "'");
    out.set(line.slice(0, eq), value);
  }
  return out;
}

/** Values as `KEY='value'` lines, which a shell can source and Compose's
 *  `env_file` reads. Owner-only, written whole. */
async function writeEnvFile(file: string, values: Record<string, string>): Promise<void> {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'\n`)
    .join("");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, body, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/** The env a move carries, from `envFile` (strut's keys, and `<name>.KEY`
 *  for a sidecar's) and `sidecarEnv`. strut's host settings stay behind. */
export async function readMoveEnv(f: MoveFolders): Promise<MoveEnv> {
  const env: MoveEnv = { strut: {}, sidecars: {} };
  const sidecar = (name: string, file: string) => {
    if (!f.sidecars?.[name]) throw new Error(`${file}: values for "${name}", which is not a sidecar of this move`);
    return (env.sidecars[name] ??= {});
  };
  if (f.envFile) {
    for (const [key, value] of parseEnv(await readFile(f.envFile, "utf-8"), f.envFile)) {
      const dot = key.indexOf(".");
      const [name, k] = dot < 0 ? [null, key] : [key.slice(0, dot), key.slice(dot + 1)];
      if (!KEY.test(k) || (name !== null && !SIDECAR_NAME.test(name))) throw new Error(`${f.envFile}: bad key ${JSON.stringify(key)}`);
      oneLine(f.envFile, key, value);
      if (name !== null) sidecar(name, f.envFile)[k] = value;
      else if (!HOST_KEYS.has(k) && !k.startsWith("STRUT_MOVE_")) env.strut[k] = value;
    }
  }
  for (const [name, file] of Object.entries(f.sidecarEnv ?? {})) {
    for (const [k, value] of parseEnv(await readFile(file, "utf-8"), file)) {
      if (!KEY.test(k)) throw new Error(`${file}: bad key ${JSON.stringify(k)}`);
      oneLine(file, k, value);
      sidecar(name, file)[k] = value;
    }
  }
  return env;
}

function oneLine(file: string, key: string, value: string) {
  if (/[\n\0]/.test(value)) throw new Error(`${file}: ${key} is not one line`);
}

// ── packing ────────────────────────────────────────────────────────────────

export function manifestFor(f: MoveFolders, callbacks?: Endpoint): Manifest {
  if (callbacks) endpointSchema.parse(callbacks);
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    ...moveVersion(),
    created: new Date().toISOString(),
    from: resolve(f.data),
    hostConfig: !!f.hostConfig,
    sidecars: Object.keys(f.sidecars ?? {}).sort(),
    ...(callbacks ? { callbacks } : {}),
  };
}

/** Every regular file under `dir`, `/`-separated and sorted, minus what
 *  `skip` leaves out (a folder skipped is not entered). */
async function filesUnder(dir: string, skip: (rel: string, isDir: boolean) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    const entries = (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip(path, true)) await walk(path);
      } else if (e.isFile() && !skip(path, false)) out.push(path);
    }
  };
  await walk("");
  return out;
}

/** One file as tar bytes. A file that changes size while it is read was
 *  not stopped: refused. */
async function* fileEntry(name: string, path: string): AsyncGenerator<Buffer> {
  const { size } = await stat(path);
  yield tarHeader(name, size);
  let read = 0;
  if (size > 0) {
    for await (const chunk of createReadStream(path, { start: 0, end: size - 1 }) as AsyncIterable<Buffer>) {
      read += chunk.length;
      yield chunk;
    }
  }
  if (read !== size) throw new Error(`${path} changed while it was packed: stop strut and its sidecars first`);
  yield tarPadding(size);
}

/** The archive's plaintext (a tar), file by file. */
async function* tarStream(f: MoveFolders, manifest: Manifest, env: MoveEnv): AsyncGenerator<Buffer> {
  const small = (name: string, body: string) => [tarHeader(name, Buffer.byteLength(body)), Buffer.from(body), tarPadding(Buffer.byteLength(body))];
  yield* small("move.json", JSON.stringify(manifest, null, 2));
  yield* small("env.json", JSON.stringify(env));
  if (f.hostConfig) yield* fileEntry("host-config.json", f.hostConfig);
  for (const rel of await filesUnder(f.data, leftBehind)) yield* fileEntry(`data/${rel}`, join(f.data, rel));
  for (const name of manifest.sidecars) {
    const path = f.sidecars![name]!;
    if ((await stat(path)).isDirectory()) {
      for (const rel of await filesUnder(path)) yield* fileEntry(`sidecars/${name}/${rel}`, join(path, rel));
    } else yield* fileEntry(`sidecars/${name}`, path);
  }
  yield TAR_END;
}

/** `source` through a zlib stream; an error on either side ends the read. */
function through(source: AsyncIterable<Buffer>, t: Transform): AsyncIterable<Buffer> {
  pipeline(Readable.from(source), t).catch(() => {});
  return t;
}

/** The move's plaintext: the archive, gzip-compressed. */
export function pack(f: MoveFolders, manifest: Manifest, env: MoveEnv): AsyncIterable<Buffer> {
  for (const name of manifest.sidecars) if (!SIDECAR_NAME.test(name)) throw new Error(`bad sidecar name ${JSON.stringify(name)}`);
  return through(tarStream(f, manifest, env), createGzip());
}

/** Fold the workspace graph's WAL into its file before it moves. Ladybug
 *  logs every `LOAD EXTENSION '<absolute path>'` in the WAL and replays it
 *  at the next open, so a WAL left by a strut that did not close its graph
 *  (killed, or a container stopped without a handler) makes the graph fail
 *  to open on any host where that path does not exist. Opened and closed
 *  here, with this host's extensions, it leaves no WAL. A strut still
 *  running holds the file: the open fails, and so does the move. */
async function checkpointGraph(data: string): Promise<void> {
  const file = join(resolve(data), "graph", "graph.lbug");
  if (!existsSync(`${file}.wal`)) return;
  // Lazy: the Ladybug addon is an optional native dependency, and most
  // folders reach here with no WAL.
  const { openLadybug } = await import("../graph/ladybug/db.js");
  await (await openLadybug(file)).close();
  if (existsSync(`${file}.wal`)) throw new Error(`${file}.wal is still there after closing the graph: is strut still running?`);
}

/** Pack this host's stopped folders: the manifest, and the sealed-to-be
 *  plaintext. A `moved.json` strut has not applied yet (a folder moved here
 *  and sent on before strut booted) is applied first, so what is packed
 *  points at this host, as the manifest says. */
export async function packFolders(f: MoveFolders, callbacks?: Endpoint): Promise<{ manifest: Manifest; plain: AsyncIterable<Buffer> }> {
  await applyMove(f.data);
  await checkpointGraph(f.data);
  const manifest = manifestFor(f, callbacks);
  return { manifest, plain: pack(f, manifest, await readMoveEnv(f)) };
}

// ── unpacking ──────────────────────────────────────────────────────────────

/** Where an entry may land, or why not. */
function entryProblem(name: string): string | null {
  const parts = name.split("/");
  if (!name || name.startsWith("/") || name.includes("\\") || parts.some((p) => !p || p === "." || p === "..")) return "not a plain relative name";
  const [top] = parts;
  if (parts.length === 1 && ["move.json", "env.json", "host-config.json"].includes(top!)) return null;
  if (top === "data" && parts.length > 1) return null;
  if (top === "sidecars" && parts.length > 1 && SIDECAR_NAME.test(parts[1]!)) return null;
  return "not part of a move";
}

/** The plaintext, gunzipped when it is gzip (a plain tar is taken too). */
async function* gunzipped(plain: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const it = plain[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const rest = (async function* () {
    yield first.value;
    for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
  })();
  if (first.value[0] === 0x1f && first.value[1] === 0x8b) yield* through(rest, createGunzip());
  else yield* rest;
}

/** Unpack a move's plaintext into `dir` (made if missing): regular files
 *  only, each name once, nothing outside the archive's layout. */
export async function unpack(plain: AsyncIterable<Buffer>, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let buf: Buffer = Buffer.alloc(0);
  let file: { handle: Awaited<ReturnType<typeof open>>; left: number; pad: number } | null = null;
  let ended = false;
  for await (const chunk of gunzipped(plain)) {
    if (ended) continue;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (file) {
        if (file.left > 0) {
          if (!buf.length) break;
          const part = buf.subarray(0, Math.min(file.left, buf.length));
          await file.handle.write(part);
          file.left -= part.length;
          buf = buf.subarray(part.length);
          if (file.left > 0) break;
        }
        if (buf.length < file.pad) break;
        buf = buf.subarray(file.pad);
        await file.handle.close();
        file = null;
      }
      if (buf.length < 512) break;
      const entry = parseTarHeader(buf.subarray(0, 512));
      buf = buf.subarray(512);
      if (!entry) {
        ended = true;
        break;
      }
      const problem = entryProblem(entry.name);
      if (problem) throw new Error(`refused entry ${JSON.stringify(entry.name)}: ${problem}`);
      const target = join(dir, ...entry.name.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      file = { handle: await open(target, "wx", 0o600), left: entry.size, pad: (512 - (entry.size % 512)) % 512 };
    }
  }
  if (file) await file.handle.close();
  if (!ended) throw new Error("the move is cut short");
}

// ── putting a move in place ───────────────────────────────────────────────

/** The manifest of an unpacked move, checked. */
export async function readManifest(dir: string): Promise<Manifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, "move.json"), "utf-8"));
  } catch {
    throw new Error("the move has no move.json");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`move.json is not a version-${FORMAT_VERSION} ${FORMAT} manifest: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** What the receiving host adds to `moved.json`: its own bridge, and
 *  secrets to set, whose values may name `{bridge.url}`, `{bridge.port}`
 *  or `{bridge.token}`. */
export interface Arrival {
  bridge?: Endpoint;
  secrets?: Record<string, string>;
}

/** The `moved.json` a move's arrival leaves for strut's next boot (moved.ts). */
export function movedFor(manifest: Manifest, arrival: Arrival): Moved {
  const b = arrival.bridge;
  const fill = (template: string) =>
    template.replace(/\{bridge\.(url|port|token)\}/g, (_, what: string) => {
      if (!b) throw new Error(`${template}: names the bridge, and this host has none (--bridge)`);
      const u = new URL(b.url);
      return what === "url" ? b.url : what === "token" ? b.token : u.port || (u.protocol === "https:" ? "443" : "80");
    });
  return {
    ...(manifest.from.startsWith("/") ? { from: manifest.from } : {}),
    ...(manifest.callbacks && b ? { bridge: { from: manifest.callbacks, to: b } } : {}),
    ...(arrival.secrets ? { secrets: Object.fromEntries(Object.entries(arrival.secrets).map(([k, v]) => [k, fill(v)])) } : {}),
  };
}

/** Move `src` onto `target`: an empty folder there is replaced, anything
 *  else is set aside as `<target>.old-<stamp>`. */
async function place(src: string, target: string, stamp: string): Promise<void> {
  const there = await stat(target).catch(() => null);
  if (there) {
    if (there.isDirectory() && (await readdir(target)).length === 0) await rm(target, { recursive: true });
    else await rename(target, `${target}.old-${stamp}`);
  }
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(src, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(src, target, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

/** Put an unpacked move (`dir`) in place on this host: its parts where `f`
 *  says, `moved.json` in the data folder, then the env files — last, so a
 *  host that waits for them sees a move that is whole. The move's sidecars
 *  must be exactly `f`'s. Returns the manifest. */
export async function install(dir: string, f: MoveFolders, arrival: Arrival = {}): Promise<Manifest> {
  const manifest = await readManifest(dir);
  const want = Object.keys(f.sidecars ?? {}).sort();
  if (JSON.stringify(manifest.sidecars) !== JSON.stringify(want)) {
    throw new Error(`the move's sidecars (${manifest.sidecars.join(", ") || "none"}) are not this host's (${want.join(", ") || "none"})`);
  }
  if (manifest.hostConfig && !f.hostConfig) throw new Error("the move carries a host config and this host names no place for it (--host-config)");
  let env: MoveEnv;
  try {
    env = JSON.parse(await readFile(join(dir, "env.json"), "utf-8")) as MoveEnv;
  } catch {
    throw new Error("the move has no env.json");
  }
  const moved = movedFor(manifest, arrival);
  await mkdir(join(dir, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "data", MOVED_FILE), JSON.stringify(moved, null, 2), { mode: 0o600 });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await place(join(dir, "data"), resolve(f.data), stamp);
  if (manifest.hostConfig) await place(join(dir, "host-config.json"), resolve(f.hostConfig!), stamp);
  for (const name of manifest.sidecars) {
    // An empty sidecar folder packs to no entries.
    const src = join(dir, "sidecars", name);
    if (!(await stat(src).catch(() => null))) await mkdir(src, { recursive: true, mode: 0o700 });
    await place(src, resolve(f.sidecars![name]!), stamp);
  }

  if (f.envFile) await writeEnvFile(f.envFile, env.strut ?? {});
  for (const [name, values] of Object.entries(env.sidecars ?? {})) {
    const file = f.sidecarEnv?.[name];
    if (file) await writeEnvFile(file, values);
    else console.warn(`[move] ${name}'s env values (${Object.keys(values).join(", ")}) have no place on this host (--sidecar-env ${name}=<file>)`);
  }
  return manifest;
}
