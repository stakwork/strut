// The memory snapshot memory/export writes and memory/import reads: one
// gzipped tar of what Ladybug's EXPORT DATABASE wrote, under graph/, plus
// manifest.json. Leading-underscore file → skipped by registry discovery.
//
// Phase 0 (Ladybug 0.21.2): EXPORT DATABASE → IMPORT DATABASE round-trips this
// schema: STRING[] lists (empty, NULL, items holding commas), INT64 times,
// DOUBLE, NULLs, columns added by ALTER, every rel table. It writes Parquet only
// (`format="csv"` is refused) — schema.cypher, index.cypher (empty: memory has
// no full-text or vector index yet) and a file or more per table. IMPORT reads
// the folder it is given, never the `storage` path schema.cypher names, so a
// snapshot moves between machines. Chosen over copying graph.lbug, which would
// tie a snapshot to one Ladybug storage format.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { MIGRATION_COUNT, type Query, ownerOnly } from "./_db.js";
import { SEED } from "./_ontology-seed.js";

export const FORMAT = 1;
export const MB = 1024 * 1024;
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `<memory folder>/snapshots/<name>`, made owner-only, and the snapshots folder itself. */
export function snapshotDirs(dbPath: string, name: string): { folder: string; work: string } {
  const folder = join(dirname(dbPath), "snapshots");
  ownerOnly(folder);
  const work = join(folder, name);
  rmSync(work, { recursive: true, force: true });
  return { folder, work };
}

/** Removes `work`, then its folder when nothing else is in it (a kept export stays). */
export function removeWork(work: string): void {
  rmSync(work, { recursive: true, force: true });
  try {
    rmdirSync(dirname(work));
  } catch {}
}
/** The most a base64 `data` may carry; a bigger snapshot is copied over and imported by `path`. */
export const MAX_DATA_BYTES = 100 * MB;
/** The most a snapshot may unpack to, and the largest file import reads by `path`. */
export const MAX_UNPACKED_BYTES = 1024 * MB;

export type Manifest = {
  format: number;
  created_at: string;
  strut?: string;
  ladybug: string;
  /** How many of _db.ts's migrations the tables have had. */
  migrations: number;
  /** Which seeded vocabulary the graph started from. */
  ontology: string;
  counts: Record<string, number>;
  /** sha256 over the graph/ files, in name order: `name\0size\0` then the bytes, for each. */
  content_hash: string;
};

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export const ontologyVersion = () => sha256(JSON.stringify(SEED)).slice(0, 12);

export function strutVersion(): string | undefined {
  try {
    // src/steps/lib/memory or build/steps/lib/memory → the package root.
    return JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return undefined;
  }
}

export function contentHash(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name)!;
    h.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  return h.digest("hex");
}

/** Rows per table, node and rel, whatever tables the graph has. */
export async function countRows(query: Query): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of await query("CALL show_tables() RETURN name, type")) {
    const match = t.type === "REL" ? `()-[x:\`${t.name}\`]->()` : `(x:\`${t.name}\`)`;
    const [row] = await query(`MATCH ${match} RETURN count(x) AS n`);
    counts[t.name] = Number(row?.n ?? 0);
  }
  return counts;
}

/** Drops every table, rels first: what IMPORT DATABASE needs, and what an empty graph starts from. */
export async function dropAll(query: Query): Promise<void> {
  const tables = await query("CALL show_tables() RETURN name, type");
  for (const t of tables.sort((a, b) => Number(b.type === "REL") - Number(a.type === "REL"))) {
    await query(`DROP TABLE \`${t.name}\``);
  }
}

/** A path as a Cypher string literal; refuses one Ladybug could misread. */
export function literal(path: string): string {
  if (/['\\\n]/.test(path)) throw new Error(`memory snapshot: the path ${JSON.stringify(path)} cannot be quoted for Ladybug`);
  return `'${path}'`;
}

// A plain ustar archive of regular files: readable with `tar xzf`, and read
// back here with nothing but files whose names the caller allows.
export function tar(files: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of files) {
    // ustar's name field: a longer one would be cut, and the content hash with it.
    if (Buffer.byteLength(name) > 100) throw new Error(`memory snapshot: the file name ${JSON.stringify(name)} is longer than a tar header holds`);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000600\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const text = (from: number, len: number) => buf.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= buf.length; ) {
    if (buf.subarray(at, at + 512).every((b) => b === 0)) return files;
    const name = text(at, 100);
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = text(at + 156, 1) || "0";
    if (type !== "0" || !Number.isFinite(size) || at + 512 + size > buf.length) {
      throw new Error(`bad_snapshot: the archive holds ${type !== "0" ? `a non-file entry (${name})` : "a truncated entry"}`);
    }
    files.set(name, buf.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("bad_snapshot: the archive has no end");
}

const NAME = "`[A-Za-z_][A-Za-z0-9_]*`";
const COLUMN = `${NAME} [A-Z][A-Z0-9]*(?:\\[\\d*\\])?`;
const WITH = "WITH \\(storage = '[^'\\\\\\n]*', format = 'icebug-disk'\\);";
/** One line of EXPORT DATABASE's schema.cypher (Ladybug 0.21.2). */
const TABLE_DDL = new RegExp(
  `^(?:CREATE NODE TABLE ${NAME} \\((?:${COLUMN},)* ?PRIMARY KEY\\(${NAME}\\)\\)` +
    `|CREATE REL TABLE ${NAME} \\(FROM ${NAME} TO ${NAME}(?:, ?${COLUMN})*, (?:MANY|ONE)_(?:MANY|ONE)\\)) ${WITH}$`,
);

/** Opens and checks a snapshot: names, manifest, format, content hash, statements. Throws `code: message`. */
export async function openSnapshot(gz: Buffer): Promise<{ manifest: Manifest; graph: Map<string, Buffer> }> {
  let entries: Map<string, Buffer>;
  try {
    entries = untar(await promisify(gunzip)(gz, { maxOutputLength: MAX_UNPACKED_BYTES }));
  } catch (err) {
    const msg = message(err);
    throw new Error(msg.startsWith("bad_snapshot:") ? msg : `bad_snapshot: not a memory snapshot (.tar.gz): ${msg}`);
  }
  const graph = new Map<string, Buffer>();
  let manifest: Manifest | undefined;
  for (const [name, bytes] of entries) {
    if (name === "manifest.json") {
      try {
        manifest = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("bad_snapshot: manifest.json is not JSON");
      }
    } else if (/^graph\/[A-Za-z0-9_.-]+$/.test(name) && !name.startsWith("graph/.")) graph.set(name.slice(6), bytes);
    else throw new Error(`bad_snapshot: unexpected entry ${JSON.stringify(name)}`);
  }
  if (!manifest || typeof manifest.format !== "number") throw new Error("bad_snapshot: no manifest.json with a format");
  if (manifest.format > FORMAT) {
    throw new Error(`newer_format: this snapshot is format ${manifest.format}; this strut reads format ${FORMAT}. Update strut`);
  }
  if (manifest.format !== FORMAT) throw new Error(`bad_snapshot: unknown format ${manifest.format}`);
  if (typeof manifest.migrations === "number" && manifest.migrations > MIGRATION_COUNT) {
    throw new Error(`newer_format: this snapshot's tables come from a newer strut (${manifest.migrations} migrations, this one knows ${MIGRATION_COUNT}). Update strut`);
  }
  if (contentHash(graph) !== manifest.content_hash) throw new Error("bad_snapshot: the content hash does not match; the file is damaged or was changed");
  // IMPORT DATABASE runs these files as Cypher, so each line of schema.cypher
  // must be one table definition exactly as EXPORT writes it, matched whole:
  // backquoted names, bare types, and a storage path that cannot close its
  // quote. Nothing else gets through, quoted or not. Memory has no index, so
  // index.cypher must be empty.
  if (!graph.has("schema.cypher")) throw new Error("bad_snapshot: no graph/schema.cypher");
  const lines = graph.get("schema.cypher")!.toString("utf8").split("\n").filter((l) => l.trim());
  if (!lines.every((l) => TABLE_DDL.test(l))) throw new Error("bad_snapshot: schema.cypher holds more than table definitions");
  if (graph.get("index.cypher")?.toString("utf8").trim()) throw new Error("bad_snapshot: index.cypher is not empty");
  return { manifest, graph };
}
