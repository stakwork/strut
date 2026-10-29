// The memory snapshot memory/export writes and memory/import reads: one
// gzipped tar of manifest.json and graph/ — memory's nodes, the edges
// between them, and its vocabulary, as JSON (plans/memory-in-workspace-graph.md
// decision 12). Memory lives in the workspace graph, so the snapshot is
// memory's part of it only: never a workflow, run or app node, and no cross
// edge (a fact's OBJECT pointing at an app's node is left out; on the copy
// that fact has no object). Leading-underscore file → skipped by registry
// discovery.
//
// Format 2. Format 1 was Ladybug's EXPORT DATABASE of memory's own file,
// before memory moved into the workspace; a format-1 snapshot is refused
// with the reason (the strut that made it is older: update it).
//
// Every line is written with its keys in order and the nodes and edges
// sorted, so an unchanged memory exports the same content_hash (what
// /home/pull's `if_changed` compares).
//
// The import (`applyDump`) is bounded: it writes in batches of at most
// BATCH (100) nodes or edges a transaction, releasing the workspace's write lock
// between them so run projections and publishes are not stalled, and skips
// a node whose attributes and delete stamps already match. Memory's own
// queue is held across all of them (the caller's memoryExclusive): no
// memory write lands in between.
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { NodeWriter } from "../../../graph/node-writer.js";
import { type Handle, type MemoryTx, type Row, writeOn } from "./_db.js";
import { BASE_SCHEMAS, ENTITY_BASE, EPISODE, FACT, MEMORY_EDGES } from "./_ontology-seed.js";
import { applyTerms, ontologyVersion, termsOf, type Term } from "./_ontology.js";
import { tar, untar } from "../../../tar.js";

export const FORMAT = 2;
export const MB = 1024 * 1024;
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The most a base64 `data` may carry; a bigger snapshot is copied over and imported by `path`. */
export const MAX_DATA_BYTES = 100 * MB;
/** The most a snapshot may unpack to, and the largest file import reads by `path`. */
export const MAX_UNPACKED_BYTES = 1024 * MB;
/** Nodes or edges one import transaction writes (decision 12). Tuned from 500: a write costs
 *  ~2 ms a node, so 500 held the workspace's lock ~1 s a batch and 100 holds it ~0.25 s,
 *  for about the same total time (memory-workspace.test.ts measures it). */
export const BATCH = 100;

/** Where memory keeps its snapshots and backups: `<dataDir>/memory`, else beside the workspace graph's file. */
export function memoryFolder(handle: Handle, dataDir?: string): string {
  return dataDir ? join(dataDir, "memory") : join(dirname(handle.backend.cfg.path), "memory");
}

export type Manifest = {
  format: number;
  created_at: string;
  strut?: string;
  ladybug: string;
  /** Which seeded vocabulary the graph started from. */
  ontology: string;
  counts: Record<string, number>;
  /** sha256 over the graph/ files, in name order: `name\0size\0` then the bytes, for each. */
  content_hash: string;
};

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

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

// ── The dump ────────────────────────────────────────────────────────────────

const attrsOf = (type: string) => Object.entries(BASE_SCHEMAS.find((s) => s["type"] === type)!).filter(([, v]) => typeof v === "string" && /^\??(string|boolean|int|float|list)$/.test(v as string));
/** Each kind's attributes and their types. */
export const FIELDS: Record<"entity" | "Fact" | "Episode", Array<[string, string]>> = {
  entity: attrsOf(ENTITY_BASE) as Array<[string, string]>,
  Fact: attrsOf(FACT) as Array<[string, string]>,
  Episode: attrsOf(EPISODE) as Array<[string, string]>,
};

export type DumpNode = {
  ref_id: string;
  node_type: string;
  attributes: Record<string, unknown>;
  updated_at: number;
  deleted_at?: number;
  deleted_reason?: string;
};
export type DumpEdge = { edge: string; from: string; to: string };
export type Dump = { nodes: DumpNode[]; edges: DumpEdge[]; terms: Term[] };

const kindOf = (type: string): keyof typeof FIELDS => (type === FACT || type === EPISODE ? type : "entity");
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

/** A row's attributes as the kind declares them, nulls left out, in declared order. */
export function pick(type: string, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, t] of FIELDS[kindOf(type)]) {
    const v = row[k];
    if (v === null || v === undefined || (typeof v === "string" && v === "")) continue;
    const base = t.replace("?", "");
    out[k] = base === "int" ? Number(v) : base === "float" ? Number(v) : base === "list" ? (v as unknown[]).map(String) : v;
  }
  return out;
}

/** Every node type that is memory's: the entity types, Fact, Episode. */
export function nodeTypesOf(terms: Term[]): string[] {
  return [...terms.filter((t) => t.kind === "entity_type").map((t) => t.name), FACT, EPISODE];
}

/** Memory's part of the workspace: its nodes, the edges between two of them, its terms. */
export async function dump(handle: Handle): Promise<Dump> {
  const raw = (handle.read as unknown as { raw: (c: string, p?: Record<string, unknown>) => Promise<Row[]> }).raw;
  const terms = await termsOf(raw);
  const types = nodeTypesOf(terms);
  const cols = [...new Set(Object.values(FIELDS).flat().map(([k]) => k))];
  const rows = await raw(
    `MATCH (n:Node) WHERE n.node_type IN $types
     RETURN n.ref_id AS ref_id, n.node_type AS node_type, n.updated_at AS updated_at, n.deleted_at AS deleted_at, n.deleted_reason AS deleted_reason,
            ${cols.map((c) => `n.\`${c}\` AS \`${c}\``).join(", ")}`,
    { types },
  );
  const nodes = rows.map((r): DumpNode => ({
    ref_id: r.ref_id, node_type: r.node_type, attributes: pick(r.node_type, r), updated_at: Number(r.updated_at ?? 0),
    ...(r.deleted_at != null ? { deleted_at: Number(r.deleted_at) } : {}), ...(r.deleted_reason != null ? { deleted_reason: r.deleted_reason } : {}),
  })).sort((a, b) => (a.ref_id < b.ref_id ? -1 : a.ref_id > b.ref_id ? 1 : 0));
  const edges: DumpEdge[] = [];
  for (const edge of MEMORY_EDGES) {
    for (const r of await raw(
      `MATCH (a:Node)-[:\`${edge}\`]->(b:Node) WHERE a.node_type IN $types AND b.node_type IN $types RETURN DISTINCT a.ref_id AS f, b.ref_id AS t`,
      { types },
    )) edges.push({ edge, from: r.f, to: r.t });
  }
  edges.sort((a, b) => cmp(edgeKey(a), edgeKey(b)));
  return { nodes, edges, terms: [...terms].sort((a, b) => cmp(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`)) };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const edgeKey = (e: DumpEdge) => `${e.edge}\u0000${e.from}\u0000${e.to}`;

/** A value as JSON with object keys sorted: the same dump, the same bytes. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Rows per kind of node and per edge type, as memory's tables were named. */
export function countsOf(d: Dump): Record<string, number> {
  const counts: Record<string, number> = { Entity: 0, Fact: 0, Episode: 0, Ontology: d.terms.length };
  for (const n of d.nodes) counts[n.node_type === FACT || n.node_type === EPISODE ? n.node_type : "Entity"]!++;
  for (const e of MEMORY_EDGES) counts[e] = 0;
  for (const e of d.edges) counts[e.edge]!++;
  return counts;
}

/** The graph/ files of a dump. */
export function filesOf(d: Dump): Map<string, Buffer> {
  return new Map([
    ["nodes.jsonl", Buffer.from(d.nodes.map((n) => `${stable(n)}\n`).join(""))],
    ["edges.jsonl", Buffer.from(d.edges.map((e) => `${stable(e)}\n`).join(""))],
    ["ontology.json", Buffer.from(stable(d.terms))],
  ]);
}

/** Memory as a snapshot (.tar.gz bytes). Run in memory's queue (memoryExclusive). */
export async function writeSnapshot(handle: Handle) {
  const d = await dump(handle);
  const graph = filesOf(d);
  const counts = countsOf(d);
  const created = new Date();
  const manifest: Manifest = {
    format: FORMAT,
    created_at: created.toISOString(),
    strut: strutVersion(),
    ladybug: handle.ladybug,
    ontology: ontologyVersion(),
    counts,
    content_hash: contentHash(graph),
  };
  const files = [...graph.keys()].sort().map((name): [string, Buffer] => [`graph/${name}`, graph.get(name)!]);
  const gz = await promisify(gzip)(tar([["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))], ...files]));
  return { gz, dump: d, graph, counts, manifest, name: `memory-${created.toISOString().replace(/[:.]/g, "-")}.tar.gz` };
}

/** The content hash memory exports now, without building the snapshot. */
export async function currentHash(handle: Handle): Promise<string> {
  return contentHash(filesOf(await dump(handle)));
}

// ── Reading one ─────────────────────────────────────────────────────────────

const KINDS = new Set(["entity_type", "predicate"]);
const VALUE: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  int: (v) => typeof v === "number" && Number.isInteger(v),
  float: (v) => typeof v === "number" && Number.isFinite(v),
  list: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
};

function parseLines<T>(bytes: Buffer | undefined, what: string): T[] {
  if (!bytes) throw new Error(`bad_snapshot: no graph/${what}`);
  try {
    return bytes.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    throw new Error(`bad_snapshot: graph/${what} is not JSON lines`);
  }
}

/** Checks a dump in full: node types memory's, attributes declared and typed, edges memory's and between its nodes. */
function checkDump(d: Dump): void {
  for (const t of d.terms) {
    if (!t || !KINDS.has(t.kind) || typeof t.name !== "string" || !/^[A-Za-z0-9_]+$/.test(t.name)) throw new Error("bad_snapshot: ontology.json holds a term memory does not write");
  }
  const types = new Set(nodeTypesOf(d.terms));
  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (typeof n?.ref_id !== "string" || !n.ref_id || typeof n.node_type !== "string" || !types.has(n.node_type)) throw new Error(`bad_snapshot: a node of a type memory does not hold (${JSON.stringify(n?.node_type)})`);
    if (ids.has(n.ref_id)) throw new Error(`bad_snapshot: node ${n.ref_id} is there twice`);
    ids.add(n.ref_id);
    const fields = new Map(FIELDS[kindOf(n.node_type)]);
    for (const [k, v] of Object.entries(n.attributes ?? {})) {
      const t = fields.get(k);
      if (!t || !VALUE[t.replace("?", "")]!(v)) throw new Error(`bad_snapshot: ${n.node_type}.${k} is not an attribute memory writes, or not of its type`);
    }
    if (typeof n.updated_at !== "number" || (n.deleted_at !== undefined && typeof n.deleted_at !== "number") || (n.deleted_reason !== undefined && typeof n.deleted_reason !== "string")) {
      throw new Error(`bad_snapshot: node ${n.ref_id} has a bad stamp`);
    }
  }
  for (const e of d.edges) {
    if (!MEMORY_EDGES.includes(e?.edge) || !ids.has(e.from) || !ids.has(e.to)) throw new Error("bad_snapshot: an edge memory does not write, or not between two of its nodes");
  }
}

/** Opens and checks a snapshot: names, manifest, format, content hash, contents. Throws `code: message`. */
export async function openSnapshot(gz: Buffer): Promise<{ manifest: Manifest; graph: Map<string, Buffer>; dump: Dump }> {
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
  if (manifest.format === 1) {
    throw new Error("old_format: this snapshot is format 1, memory's own file from before it moved into the workspace graph; update the strut that made it");
  }
  if (manifest.format !== FORMAT) throw new Error(`bad_snapshot: unknown format ${manifest.format}`);
  if (contentHash(graph) !== manifest.content_hash) throw new Error("bad_snapshot: the content hash does not match; the file is damaged or was changed");
  for (const name of graph.keys()) if (!["nodes.jsonl", "edges.jsonl", "ontology.json"].includes(name)) throw new Error(`bad_snapshot: unexpected file graph/${name}`);
  let terms: Term[];
  try {
    terms = JSON.parse(graph.get("ontology.json")?.toString("utf8") ?? "null");
  } catch {
    throw new Error("bad_snapshot: graph/ontology.json is not JSON");
  }
  if (!Array.isArray(terms)) throw new Error("bad_snapshot: no graph/ontology.json");
  const d: Dump = { nodes: parseLines<DumpNode>(graph.get("nodes.jsonl"), "nodes.jsonl"), edges: parseLines<DumpEdge>(graph.get("edges.jsonl"), "edges.jsonl"), terms };
  checkDump(d);
  return { manifest, graph, dump: d };
}

// ── Loading one ─────────────────────────────────────────────────────────────

export interface ApplyReport {
  created: number;
  updated: number;
  unchanged: number;
  purged: number;
  edges: { added: number; removed: number };
  /** How long each transaction held the workspace's write lock, ms. */
  lock_ms: number[];
}

type Op = (m: MemoryTx, clock: { at: number }) => Promise<void>;

const sameValue = (a: unknown, b: unknown) => stable(a ?? null) === stable(b ?? null);
const sameAttributes = (a: DumpNode, b: DumpNode) => {
  const keys = new Set([...Object.keys(a.attributes), ...Object.keys(b.attributes)]);
  return [...keys].every((k) => sameValue(a.attributes[k], b.attributes[k]));
};

/**
 * Makes memory's part of the workspace what `target` holds, in bounded
 * transactions. `local` is memory as it is (a `dump`). A node only here is
 * purged; one whose type or deletion differs is purged and made again; one
 * whose attributes differ is updated; the rest are left alone. Each node
 * keeps its ref_id and its stamps (created on the target's clock, deleted at
 * its time). With `keep` (a migration), nothing here is purged or changed:
 * only what is missing is added. With `single`, all of it is one
 * transaction (all or nothing).
 */
export async function applyDump(handle: Handle, target: Dump, local: Dump, opts: { batch?: number; keep?: boolean; single?: boolean } = {}): Promise<ApplyReport> {
  const b = handle.backend;
  const batch = opts.single ? Infinity : opts.batch ?? BATCH;
  const report: ApplyReport = { created: 0, updated: 0, unchanged: 0, purged: 0, edges: { added: 0, removed: 0 }, lock_ms: [] };
  const here = new Map(local.nodes.map((n) => [n.ref_id, n]));
  const memoryTypes = nodeTypesOf([...local.terms, ...target.terms]);

  const purge: string[] = [];
  const create: DumpNode[] = [];
  const update: DumpNode[] = [];
  const stamp: DumpNode[] = [];
  const wanted = new Set(target.nodes.map((n) => n.ref_id));
  if (!opts.keep) for (const n of local.nodes) if (!wanted.has(n.ref_id)) purge.push(n.ref_id);
  for (const n of target.nodes) {
    const have = here.get(n.ref_id);
    if (have && opts.keep) {
      report.unchanged++;
      continue;
    }
    const remade = have && (have.node_type !== n.node_type || (have.deleted_at !== undefined && (n.deleted_at === undefined || have.deleted_reason !== n.deleted_reason)));
    if (remade) purge.push(n.ref_id);
    if (!have || remade) {
      create.push(n);
      if (n.deleted_at !== undefined) stamp.push(n);
      continue;
    }
    if (!sameAttributes(have, n)) update.push(n);
    else report.unchanged++;
    if (n.deleted_at !== undefined && have.deleted_at === undefined) stamp.push(n);
  }
  const gone = new Set(purge);
  const edgesHere = new Set(local.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)).map(edgeKey));
  const edgesThere = new Set(target.edges.map(edgeKey));
  const add = target.edges.filter((e) => !edgesHere.has(edgeKey(e)));
  const remove = opts.keep ? [] : local.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to) && !edgesThere.has(edgeKey(e)));

  // Created on the target's clock: each node keeps its `updated_at`.
  const clock = { at: Date.now() };
  const nodes = new NodeWriter(b, { embedder: b.embedder, resolver: b.schemas, now: () => clock.at });
  const ops: Op[] = [];
  for (const ids of chunks(purge, batch)) {
    ops.push(async (m) => {
      await m.query.raw!(`MATCH (n:Node) WHERE n.ref_id IN $ids AND n.node_type IN $types DETACH DELETE n`, { ids, types: memoryTypes });
      report.purged += ids.length;
    });
  }
  // Created in runs of one clock: a remember's nodes share one `updated_at`.
  for (const group of chunks(create, batch)) {
    ops.push(async (m) => {
      for (const run of byClock(group)) {
        clock.at = run[0]!.updated_at;
        await m.createMany(run.map((n) => ({ type: n.node_type, data: n.attributes, ref_id: n.ref_id })));
      }
      report.created += group.length;
    });
  }
  for (const group of chunks(update, batch)) {
    ops.push(async (m) => {
      for (const n of group) {
        clock.at = n.updated_at;
        const was = here.get(n.ref_id)!;
        await m.set(n.ref_id, { ...Object.fromEntries(Object.keys(was.attributes).map((k) => [k, null])), ...n.attributes });
      }
      report.updated += group.length;
    });
  }
  for (const group of chunks(add, batch)) {
    ops.push(async (m) => {
      await m.linkMany(group);
      report.edges.added += group.length;
    });
  }
  for (const group of chunks(remove, batch)) {
    ops.push(async (m) => {
      for (const e of group) await m.unlink(e.edge, e.from, e.to);
      report.edges.removed += group.length;
    });
  }
  for (const group of chunks(stamp, batch)) {
    ops.push(async (m) => {
      for (const n of group) await m.forget(n.ref_id, n.deleted_reason ?? "", n.deleted_at);
    });
  }

  const run = async (fns: Op[], terms: boolean) => {
    let started = 0;
    await writeOn(handle, async (m) => {
      started = performance.now();
      if (terms) await applyTerms(b, m.tx, target.terms);
      for (const fn of fns) await fn(m, clock);
    }, nodes);
    report.lock_ms.push(Math.round((performance.now() - started) * 10) / 10);
  };
  if (opts.single) await run(ops, true);
  else {
    await run([], true);
    for (const op of ops) await run([op], false);
  }
  handle.backend.schemas.invalidate();
  return report;
}

function chunks<T>(xs: T[], size: number): T[][] {
  if (!xs.length) return [];
  if (!Number.isFinite(size)) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Consecutive runs of nodes stamped at the same time. */
function byClock(nodes: DumpNode[]): DumpNode[][] {
  const out: DumpNode[][] = [];
  for (const n of [...nodes].sort((a, b) => a.updated_at - b.updated_at)) {
    const last = out[out.length - 1];
    if (last && last[0]!.updated_at === n.updated_at) last.push(n);
    else out.push([n]);
  }
  return out;
}

/** Removes `work`, then its folder when nothing else is in it. */
export function removeWork(work: string): void {
  rmSync(work, { recursive: true, force: true });
}
