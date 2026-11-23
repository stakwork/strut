/**
 * FILES ON A NODE (plans/package-seams.md §1): a package keeps files on any
 * node of the graph, in a folder of its own, versioned at each write and
 * kept as long as the node is.
 *
 *   <dataDir>/nodes/<ref_id>/<package>/v<N>/…     one version, as written
 *   <dataDir>/nodes/<ref_id>/<package>/_versions.json
 *
 * the way an app's versions are kept (`<dataDir>/apps/<name>/<vN>`), and the
 * same on every graph backend: the graph holds the node, the disk its files.
 *
 * - **Whose folder.** A write goes to the WRITER's folder alone: a package's
 *   step writes its package's (`stadeum/pods/bake` → `stadeum/pods/`), named
 *   by its type — the fence binds it (src/packages/fence.ts) — and strut's
 *   own steps, and the box's own, write `strut/`. `node/write-files` writes
 *   the calling workflow's package's (`ctx.package`). Reading is open, as a
 *   node's fields are, so a secret never goes in a node's files.
 * - **Versions.** A write replaces the folder whole and makes its next
 *   version, with the run that made it and when. A read takes the latest
 *   unless it names one. The last `NODE_FILES_KEPT` are kept.
 * - **Limits.** Text or bytes, at most `NODE_FILES_MAX_BYTES` a version.
 * - **Kept with the node.** A soft delete keeps them, so a restore brings
 *   them back. A delete for good removes the node's folder: strut deletes
 *   no node for good itself, so the SWEEP (`sweep`, at boot and daily,
 *   createStrut) drops the folder of every node the graph no longer holds
 *   at all, whoever removed it (raw Cypher, another process, a branch's
 *   drop). No package cleans up after another.
 *
 * The capability on the bag (`nodeFiles`) is a VIEW: one package's folder
 * and the run that writes (`bindNodeFiles`, the runner). Strut's own code
 * moves a view to another package (`nodeFilesAs`); a step holds the view it
 * was given.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How many versions of one package's files a node keeps. */
export const NODE_FILES_KEPT = 20;
/** The most one version holds, in bytes. */
export const NODE_FILES_MAX_BYTES = 10 * 1024 * 1024;
/** The folder strut's own steps — and the box's — write. */
export const STRUT_FILES = "strut";

const VERSIONS_FILE = "_versions.json";
/** A ref_id as a folder name: one segment, nothing a path could read twice. */
const REF_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
/** A folder segment: a package name's (`publisher/name`) or `strut`. */
const FOLDER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** One kept version of one package's files on a node. */
export interface NodeFilesVersion {
  package: string;
  version: number;
  at: string;
  /** The run that wrote it, when a run did. */
  runId?: string;
  /** The version's size: every file's bytes. */
  bytes: number;
  paths: string[];
  note?: string;
}

/** One version, read. */
export interface NodeFilesRead {
  package: string;
  version: number;
  at: string;
  runId?: string;
  note?: string;
  files: Record<string, Uint8Array>;
}

/** What a write takes: a path in the folder → its text or bytes. */
export type NodeFilesInput = Record<string, string | Uint8Array>;

/** `ctx.services.nodeFiles`: one package's folder on any node. */
export interface NodeFilesCapability {
  /** Replace this package's folder on the node with `files`: its next
   *  version. The node must be live where the server has a graph. */
  write(ref_id: string, files: NodeFilesInput, opts?: { note?: string }): Promise<{ version: number }>;
  /** A version of a package's folder — this one's unless `package` names
   *  another (`strut` is strut's) — the latest unless `version` names one.
   *  Null when the node holds none, or not that one. */
  read(ref_id: string, opts?: { package?: string; version?: number }): Promise<NodeFilesRead | null>;
  /** Every kept version of every package's folder on the node, each
   *  package's newest first. */
  list(ref_id: string): Promise<NodeFilesVersion[]>;
}

/** The files on disk, for every package and node. */
export interface NodeFileStore {
  readonly root: string;
  write(pkg: string, ref_id: string, files: NodeFilesInput, o?: { note?: string; runId?: string }): Promise<{ version: number }>;
  read(ref_id: string, pkg: string, version?: number): Promise<NodeFilesRead | null>;
  list(ref_id: string): Promise<NodeFilesVersion[]>;
  /** Drop the node's folder, every package's: the node is gone for good. */
  remove(ref_id: string): Promise<boolean>;
  /** Drop the folder of every node `exists` says the graph no longer holds
   *  (live or soft-deleted). Answers the ref_ids dropped. */
  sweep(exists: (ref_id: string) => Promise<boolean>): Promise<string[]>;
}

interface VersionsFile {
  /** The last version number given, kept past the versions dropped. */
  last: number;
  versions: Array<Omit<NodeFilesVersion, "package">>;
}

function checkRef(ref_id: string): string {
  if (typeof ref_id !== "string" || !REF_ID.test(ref_id) || ref_id === "." || ref_id === "..") {
    throw new Error(`node_files_bad_ref: ${JSON.stringify(ref_id)} is not a node's ref_id`);
  }
  return ref_id;
}

/** A package's folder: `strut`, or `publisher/name`. Never under `strut/`,
 *  which holds strut's own versions. */
function checkPackage(pkg: string): string {
  const segments = typeof pkg === "string" ? pkg.split("/") : [];
  const ok = (segments.length === 1 && pkg === STRUT_FILES) || (segments.length === 2 && segments[0] !== STRUT_FILES && segments.every((s) => FOLDER_SEGMENT.test(s)));
  if (!ok) throw new Error(`node_files_bad_package: ${JSON.stringify(pkg)} — a node's files are a package's (publisher/name) or strut's (strut)`);
  return pkg;
}

/** A path in a version: `/`-separated, relative, no `.` or `..` segment. */
function checkPath(path: string): string {
  const segments = path.split("/");
  if (!path || path.length > 500 || path.includes("\\") || path.includes("\0") || segments.some((s) => !s || s === "." || s === "..")) {
    throw new Error(`node_files_bad_path: ${JSON.stringify(path)} — a file's path is relative, /-separated, with no empty, . or .. segment`);
  }
  return path;
}

const bytesOf = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? Buffer.from(v, "utf-8") : v);

/** The store under `<dataDir>/nodes`. `live`, where the server has a graph:
 *  whether the graph holds the node live, so a write lands only on one. */
export function nodeFileStore(dataDir: string, o: { live?: (ref_id: string) => Promise<boolean> } = {}): NodeFileStore {
  const root = join(dataDir, "nodes");
  const folderOf = (ref_id: string, pkg: string) => join(root, checkRef(ref_id), ...checkPackage(pkg).split("/"));
  // One write at a time per folder: the next version number is read, then taken.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    queues.set(key, run);
    void run.finally(() => {
      if (queues.get(key) === run) queues.delete(key);
    }).catch(() => {});
    return run;
  };
  const readVersions = async (folder: string): Promise<VersionsFile | null> => {
    try {
      return JSON.parse(await readFile(join(folder, VERSIONS_FILE), "utf-8")) as VersionsFile;
    } catch {
      return null;
    }
  };
  const atomicWrite = async (path: string, text: string) => {
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, text);
    await rename(tmp, path);
  };
  const filesIn = async (dir: string): Promise<Record<string, Uint8Array>> => {
    const out: Record<string, Uint8Array> = {};
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readdir(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) out[p] = new Uint8Array(await readFile(join(dir, p)));
      }
    };
    await walk("");
    return out;
  };
  /** The package folders on a node: `strut`, and each `publisher/name`. */
  const packagesOn = async (ref_id: string): Promise<string[]> => {
    const node = join(root, checkRef(ref_id));
    const out: string[] = [];
    const entries = await readdir(node, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === STRUT_FILES) {
        out.push(STRUT_FILES);
        continue;
      }
      for (const s of await readdir(join(node, e.name), { withFileTypes: true }).catch(() => [])) {
        if (s.isDirectory()) out.push(`${e.name}/${s.name}`);
      }
    }
    return out.sort();
  };

  return {
    root,
    async write(pkg, ref_id, files, w = {}) {
      const folder = folderOf(ref_id, pkg);
      const entries = Object.entries(files ?? {}).map(([path, v]) => {
        checkPath(path);
        if (typeof v !== "string" && !(v instanceof Uint8Array)) throw new Error(`node_files_bad_file: ${path} is neither text nor bytes`);
        return [path, bytesOf(v)] as const;
      });
      const paths = entries.map(([p]) => p).sort();
      for (const p of paths) {
        if (paths.some((q) => q.startsWith(`${p}/`))) throw new Error(`node_files_bad_path: ${p} is a file and a folder (${p}/…) at once`);
      }
      const bytes = entries.reduce((n, [, b]) => n + b.byteLength, 0);
      if (bytes > NODE_FILES_MAX_BYTES) {
        throw new Error(`node_files_too_big: ${bytes} bytes — a node's files are at most ${NODE_FILES_MAX_BYTES} bytes a version; keep more in a store of the package's own, or a repository`);
      }
      if (o.live && !(await o.live(ref_id))) throw new Error(`node_not_found: the graph holds no live node ${ref_id} — files are kept on a node that is there`);
      return serial(folder, async () => {
        const before = (await readVersions(folder)) ?? { last: 0, versions: [] };
        const version = before.last + 1;
        await mkdir(folder, { recursive: true });
        const tmp = join(folder, `.tmp-${randomBytes(6).toString("hex")}`);
        try {
          for (const [p, b] of entries) {
            await mkdir(dirname(join(tmp, p)), { recursive: true });
            await writeFile(join(tmp, p), b);
          }
          await mkdir(tmp, { recursive: true });
          // A version a crash left before its record was written is no version.
          await rm(join(folder, `v${version}`), { recursive: true, force: true });
          await rename(tmp, join(folder, `v${version}`));
        } catch (err) {
          await rm(tmp, { recursive: true, force: true });
          throw err;
        }
        const rec = { version, at: new Date().toISOString(), ...(w.runId ? { runId: w.runId } : {}), bytes, paths, ...(w.note ? { note: w.note } : {}) };
        const versions = [...before.versions, rec];
        const dropped = versions.splice(0, Math.max(0, versions.length - NODE_FILES_KEPT));
        await atomicWrite(join(folder, VERSIONS_FILE), JSON.stringify({ last: version, versions } satisfies VersionsFile, null, 2));
        for (const d of dropped) await rm(join(folder, `v${d.version}`), { recursive: true, force: true });
        return { version };
      });
    },
    async read(ref_id, pkg, version) {
      const folder = folderOf(ref_id, pkg);
      const kept = await readVersions(folder);
      const rec = version === undefined ? kept?.versions.at(-1) : kept?.versions.find((v) => v.version === version);
      if (!rec) return null;
      return { package: pkg, version: rec.version, at: rec.at, ...(rec.runId ? { runId: rec.runId } : {}), ...(rec.note ? { note: rec.note } : {}), files: await filesIn(join(folder, `v${rec.version}`)) };
    },
    async list(ref_id) {
      const out: NodeFilesVersion[] = [];
      for (const pkg of await packagesOn(ref_id)) {
        const kept = await readVersions(folderOf(ref_id, pkg));
        for (const v of [...(kept?.versions ?? [])].reverse()) out.push({ package: pkg, ...v });
      }
      return out;
    },
    async remove(ref_id) {
      const node = join(root, checkRef(ref_id));
      const had = (await readdir(node).catch(() => null)) !== null;
      await rm(node, { recursive: true, force: true });
      return had;
    },
    async sweep(exists) {
      const dropped: string[] = [];
      for (const ref of await readdir(root).catch(() => [] as string[])) {
        if (!REF_ID.test(ref)) continue;
        if (await exists(ref)) continue;
        await rm(join(root, ref), { recursive: true, force: true });
        dropped.push(ref);
      }
      return dropped;
    },
  };
}

/** What a view is: the store, whose folder it writes, for which run. */
interface ViewOf {
  store: NodeFileStore;
  package: string;
  runId?: string;
}
const VIEWS = new WeakMap<NodeFilesCapability, ViewOf>();

/** The capability over `store`: `package`'s folder (strut's unless given),
 *  its writes recorded with `runId`. */
export function nodeFilesCapability(store: NodeFileStore, o: { package?: string; runId?: string } = {}): NodeFilesCapability {
  const pkg = checkPackage(o.package ?? STRUT_FILES);
  const view: NodeFilesCapability = Object.freeze({
    write: (ref_id: string, files: NodeFilesInput, w?: { note?: string }) =>
      store.write(pkg, ref_id, files, { ...(w?.note ? { note: w.note } : {}), ...(o.runId ? { runId: o.runId } : {}) }),
    read: (ref_id: string, r?: { package?: string; version?: number }) => store.read(ref_id, r?.package ?? pkg, r?.version),
    list: (ref_id: string) => store.list(ref_id),
  });
  VIEWS.set(view, { store, package: pkg, ...(o.runId ? { runId: o.runId } : {}) });
  return view;
}

/** `cap` writing `pkg`'s folder, for the same run: the fence's view for a
 *  package's step, `node/write-files`'s for its workflow's package. A
 *  capability strut did not build is answered as it is. */
export function nodeFilesAs(cap: NodeFilesCapability | undefined, pkg: string): NodeFilesCapability | undefined {
  const of = cap ? VIEWS.get(cap) : undefined;
  if (!of || of.package === pkg) return cap;
  return nodeFilesCapability(of.store, { package: pkg, ...(of.runId ? { runId: of.runId } : {}) });
}

/** Whose folder `cap` writes, when strut built it. */
export const nodeFilesPackageOf = (cap: NodeFilesCapability | undefined): string | undefined => (cap ? VIEWS.get(cap)?.package : undefined);

/** The run's bag: its `nodeFiles` records `runId` with each write. The bag
 *  as it is when it holds none strut built. */
export function bindNodeFiles<TServices>(services: TServices, runId: string): TServices {
  if (services == null || typeof services !== "object") return services;
  const cap = (services as { nodeFiles?: NodeFilesCapability }).nodeFiles;
  const of = cap ? VIEWS.get(cap) : undefined;
  if (!of || of.runId === runId) return services;
  return { ...services, nodeFiles: nodeFilesCapability(of.store, { package: of.package, runId }) };
}

/** A file's content for a step's output: its text when it is UTF-8, else
 *  `{ base64 }`. */
export function fileOut(b: Uint8Array): string | { base64: string } {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return { base64: Buffer.from(b).toString("base64") };
  }
}

/** A file's content from a step's input: text as it is, `{ base64 }` as bytes. */
export function fileIn(v: string | { base64: string }): string | Uint8Array {
  return typeof v === "string" ? v : new Uint8Array(Buffer.from(v.base64, "base64"));
}
