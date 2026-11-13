/**
 * The strut graph backend as one object: a bolt connection plus the writers,
 * the reader, and (optionally) the local embedder — opened once per
 * config and cached, with the boot-time obligations run on open:
 *
 *   1. `migrateVeinToStrut` — one-shot rename of pre-#1664 `Vein*` names;
 *   2. `migrateRunStatus` — one-shot `StrutRun.status` → `run_status`;
 *   2b. `migrateExactKeys` — one-shot re-key of the workspace nodes from the
 *       sanitized name to the exact one (hex);
 *   3. `seedStrutDomain` — schema meta-graph, the native seed types,
 *      constraints, indexes (§4). strut bundles no jarvis library: a graph
 *      jarvis shares has jarvis's own types, and any other type is made at
 *      runtime (plans/ontology.md);
 *   4. the `EmbeddingPass` is STARTED (semantic-search.md §1): a timer in
 *      this process that embeds every marked node whoever wrote it, strips
 *      the no-embed types, and keeps up with newcomers. Nothing waits on it.
 *
 * Consumers (the `graph/*` lab steps, the `GraphWorkspaceStore` and the
 * run projector) call `openGraphBackend(cfg)` and share the instance.
 *
 * A backend IS a `GraphEngine` (`engine.ts`): `kind`, `query`, `tx`, the
 * dialect helpers and the three engine seams, plus the writers, the reader
 * and the boot reports on top. The Neo4j one is built here over a `Bolt`;
 * the Ladybug one (plans/ladybug-backend.md) over a `LadybugHandle`, whose
 * open IS the schema (the DDL, and the ontology seeded as Schema rows from
 * `ladybug/registry.ts`) — no boot seeds, no migrations, no embedding pass
 * (the writer embeds inline), and the
 * `LadybugReader` over its one FTS and one HNSW index.
 */
import { resolve } from "node:path";
import { Bolt, graphConfigFromEnv, type Neo4jConfig } from "./bolt.js";
import { EdgeWriter } from "./edge-writer.js";
import { EmbeddingPass, MiniLMEmbedder, WorkerEmbedder, type EmbeddingPassOptions } from "./embeddings.js";
import type { GraphEngine } from "./engine.js";
import { openLadybug, type LadybugHandle } from "./ladybug/db.js";
import { LadybugEngine } from "./ladybug/engine.js";
import { PRIVATE_NAMESPACE, namespaceName } from "./ladybug/namespaces.js";
import { LadybugReader } from "./ladybug/reader.js";
import { MERGE_TYPE, SCHEMA_TYPE } from "./ladybug/registry.js";
import { Neo4jEngine } from "./neo4j-engine.js";
import { NodeWriter, type Embedder } from "./node-writer.js";
import { SchemaResolver } from "./schema-resolver.js";
import { seedStrutDomain, type SeedReport } from "./schema-seed.js";
import { Neo4jReader, type BranchesHeld, type GraphReader } from "./search.js";
import { migrateVeinToStrut, type VeinMigrationReport } from "./vein-migration.js";
import { migrateRunStatus, type RunStatusMigrationReport } from "./run-status-migration.js";
import { migrateExactKeys, type ExactKeyMigrationReport } from "./exact-key-migration.js";
import { bootEnv } from "../env.js";

/** A LadybugDB file (plans/ladybug-backend.md §3.2). */
export interface LadybugConfig {
  kind: "ladybug";
  /** The database file; its folder is created owner-only. */
  path: string;
  /** Where a write that names no namespace goes: `private` (`default`
   *  reads as it), or another name (`ladybug/namespaces.ts`). */
  namespace: string;
  /** Where the `vector` + `fts` extensions are (`STRUT_LADYBUG_EXTENSION_DIR`). */
  extensionDir?: string;
}

export type GraphConfig = Neo4jConfig | LadybugConfig;

const isLadybug = (cfg: GraphConfig): cfg is LadybugConfig => cfg.kind === "ladybug";

export interface GraphBackendOptions {
  /** `false` disables embeddings entirely (vectors stay NULL, search is
   *  fulltext-only). Pass an `Embedder` to inject one (tests). Default:
   *  load the local MiniLM model. */
  embeddings?: boolean | Embedder;
  /** Skip the boot-time seed + backfill (tests that manage the DB). */
  skipBoot?: boolean;
  /** Tuning for the embedding pass (page sizes, the tick, `autoStart`) —
   *  tests. Not part of the cache key. */
  pass?: EmbeddingPassOptions;
}

/** What every backend has, whatever the engine. */
export interface GraphBackendBase extends GraphEngine {
  readonly cfg: GraphConfig;
  readonly nodes: NodeWriter;
  readonly edges: EdgeWriter;
  readonly reader: GraphReader;
  /** Live schema resolution shared by the writers and reader. */
  readonly schemas: SchemaResolver;
  /** Whether the graph holds a Concept branch (src/branches.ts), one object
   *  every handle and view shares: the branches service keeps it, and a
   *  Ladybug search that names no namespace leaves `branch-*` out only
   *  while it is set. Absent on a backend not opened here. */
  readonly branches?: BranchesHeld;
  readonly embedder: Embedder | undefined;
  /** What the boot-time seed did (undefined when skipped). */
  readonly seed: SeedReport | undefined;
  /** The pass, running on its timer; undefined with embeddings off or the
   *  boot skipped. `status()` is `GET /graph/embeddings`. */
  readonly embeddings: EmbeddingPass | undefined;
  /** Let go of this handle. Every `openGraphBackend` call is a handle on
   *  ONE shared connection per config; the connection closes when the last
   *  handle does (or at `closeGraphBackends`), so a step that opens the
   *  deployment's own graph and closes it at the end leaves everyone else's
   *  open (2026-10-28, swarm38: a builder step's `close()` took the
   *  workspace, claims and projector down with "Pool is closed"). */
  close(): Promise<void>;
}

/** The Neo4j backend: the driver, and the one-shot migrations a long-lived
 *  jarvis graph needs (a fresh Ladybug file has none of them). */
export interface Neo4jBackend extends GraphBackendBase {
  readonly kind: "neo4j";
  readonly cfg: Neo4jConfig;
  readonly bolt: Bolt;
  readonly veinMigration: VeinMigrationReport | undefined;
  readonly runStatusMigration: RunStatusMigrationReport | undefined;
  readonly exactKeyMigration: ExactKeyMigrationReport | undefined;
}

/** The Ladybug backend: one file, its ontology in the file as Schema rows. */
export interface LadybugBackend extends GraphBackendBase {
  readonly kind: "ladybug";
  readonly cfg: LadybugConfig;
  readonly lbug: LadybugHandle;
}

export type GraphBackend = Neo4jBackend | LadybugBackend;

/** One open connection per config, and how many handles hold it. */
interface Entry {
  readonly backend: Promise<GraphBackend>;
  holders: number;
}

const cache = new Map<string, Entry>();

function keyOf(cfg: GraphConfig, opts: GraphBackendOptions): string {
  const emb = opts.embeddings === false ? "off" : typeof opts.embeddings === "object" ? "custom" : "minilm";
  if (isLadybug(cfg)) return ["ladybug", resolve(cfg.path), cfg.namespace, emb].join("|");
  return [cfg.uri, cfg.user, cfg.database ?? "", cfg.namespace, emb].join("|");
}

/**
 * Open (or reuse) the backend for `cfg`. The first call per config pays for
 * connectivity, seeding, embedder load, and the backfill sweep; later calls
 * share its connection. A failed open is not cached. Each call returns a
 * handle of its own: its `close()` lets go of that handle, and the
 * connection closes with the last one.
 */
export function openGraphBackend(cfg: Neo4jConfig, opts?: GraphBackendOptions): Promise<Neo4jBackend>;
export function openGraphBackend(cfg: LadybugConfig, opts?: GraphBackendOptions): Promise<LadybugBackend>;
export function openGraphBackend(cfg: GraphConfig, opts?: GraphBackendOptions): Promise<GraphBackend>;
export function openGraphBackend(cfg: GraphConfig, opts: GraphBackendOptions = {}): Promise<GraphBackend> {
  const key = keyOf(cfg, opts);
  let entry = cache.get(key);
  if (!entry) {
    const backend = (isLadybug(cfg) ? openLadybugBackend(cfg, opts) : open(cfg, opts)).catch((e) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw e;
    });
    entry = { backend, holders: 0 };
    cache.set(key, entry);
  }
  const held = entry;
  held.holders++;
  return held.backend.then(
    (b) => {
      let released = false;
      const out = {
        ...b,
        async close() {
          if (released) return;
          released = true;
          if (--held.holders > 0 || cache.get(key) !== held) return;
          cache.delete(key);
          await b.close();
        },
      };
      // A Ladybug file's embedder arrives after the open (`attach`): read it from the backend.
      Object.defineProperty(out, "embedder", { get: () => b.embedder, enumerable: true, configurable: true });
      return out;
    },
    (e) => {
      held.holders--;
      throw e;
    },
  );
}

async function openLadybugBackend(cfg: LadybugConfig, opts: GraphBackendOptions): Promise<LadybugBackend> {
  const namespace = namespaceName(cfg.namespace, PRIVATE_NAMESPACE);
  if (namespace === null) throw new Error(`a ladybug file's own namespace must be a namespace name; got ${cfg.namespace}`);
  const lbug = await openLadybug(cfg.path, { extensionDir: cfg.extensionDir });
  try {
    // A given embedder is used from the start. MiniLM loads in the
    // background (its first load downloads the model): the file opens
    // keyword-only and its search and writers take the embedder once it is
    // there (`attach`).
    const given = typeof opts.embeddings === "object" ? opts.embeddings : undefined;
    const load = opts.embeddings !== false && !given;
    const branches: BranchesHeld = { held: false };
    const readerOpts: { embedder?: Embedder; branches: BranchesHeld } = { branches };
    const writerOpts: { embedder?: Embedder; resolver?: SchemaResolver; later?: (refs: string[]) => void } = {};
    const engine = new LadybugEngine(lbug, namespace);
    const schemas = new SchemaResolver(engine);
    const backend: LadybugBackend = {
      kind: "ladybug",
      cfg,
      lbug,
      namespace: engine.namespace,
      dialect: engine.dialect,
      query: (cypher, params) => engine.query(cypher, params),
      tx: (fn) => engine.tx(fn),
      nodeEngine: engine.nodeEngine,
      edgeEngine: engine.edgeEngine,
      schemaSource: engine.schemaSource,
      nodes: new NodeWriter(engine, Object.assign(writerOpts, { resolver: schemas })),
      edges: new EdgeWriter(engine, { resolver: schemas }),
      reader: new LadybugReader(engine, readerOpts),
      schemas,
      branches,
      embedder: undefined,
      seed: undefined,
      embeddings: undefined,
      async close() {
        closed = true;
        await engine.nodeEngine.idle?.();
        await passWorker?.close();
        await lbug.close();
      },
    };
    let closed = false;
    let passWorker: WorkerEmbedder | undefined;
    // The facts' search rows a failed embedding or a rename left without a
    // vector (plans/graph-edge-search.md), and the data nodes written while
    // the embedder was off, filled in the background; a close waits for the run.
    const attach = (embedder: Embedder) => {
      if (closed) return;
      readerOpts.embedder = embedder;
      writerOpts.embedder = embedder;
      (backend as { embedder: Embedder | undefined }).embedder = embedder;
      if (opts.skipBoot) return;
      // The catch-up embeds in a worker thread, as on Neo4j: onnxruntime runs
      // a model synchronously, and a sweep of a file's nodes on this thread
      // would hold every request (and the ready line) until it ended. The
      // writers and search keep `embedder` (one short text each). An
      // injected embedder is used as it is.
      passWorker = given ? undefined : new WorkerEmbedder();
      const pass = passWorker ?? embedder;
      const embeddable = async (type: string) => {
        if (type === SCHEMA_TYPE || type === MERGE_TYPE) return false;
        const s = await schemas.schema(type).catch(() => null);
        return !!s && s.embed && s.role !== "record";
      };
      void engine.nodeEngine.embedPendingRows?.(pass);
      void engine.nodeEngine.embedPendingNodes?.(pass, embeddable);
      // A write that asks for `embed: "later"` leaves its nodes with no
      // vector: the same backfill finds them, in the same worker.
      writerOpts.later = () => {
        if (!closed) void engine.nodeEngine.embedPendingNodes?.(pass, embeddable);
      };
    };
    if (given) attach(given);
    else if (load) void loadLadybugEmbedder(cfg.path).then((e) => e && attach(e));
    return backend;
  } catch (e) {
    await lbug.close().catch(() => undefined);
    throw e;
  }
}

/** MiniLM for a Ladybug file, or none: a load that fails (the first
 *  download with no network, a build without the embeddings stack) leaves
 *  the file keyword-only, and the next open tries again. Neo4j's open still
 *  fails instead. */
async function loadLadybugEmbedder(path: string): Promise<Embedder | undefined> {
  try {
    return await MiniLMEmbedder.load();
  } catch (e) {
    console.warn(`[graph] ${path}: the embedding model did not load, so search is keyword-only until the next start: ${String(e).split("\n")[0]}`);
    return undefined;
  }
}

/** `STRUT_GRAPH_EMBEDDINGS`: on unless `off` / `0` / `false`. */
export function embeddingsOn(env: Record<string, string | undefined> = bootEnv()): boolean {
  const emb = (env["STRUT_GRAPH_EMBEDDINGS"] ?? "").toLowerCase();
  return !(emb === "off" || emb === "0" || emb === "false");
}

/** `openGraphBackend` from `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD`/
 *  `STRUT_GRAPH_NAMESPACE`; null when `NEO4J_URI` is unset. Neo4j only: the
 *  Ladybug file is wired by `wiring.ts` (`ladybugConfigFromEnv`). */
export function openGraphBackendFromEnv(
  env: Record<string, string | undefined> = bootEnv(),
  opts: GraphBackendOptions = {},
): Promise<GraphBackend> | null {
  const cfg = graphConfigFromEnv(env);
  if (!cfg) return null;
  return openGraphBackend(cfg, {
    ...opts,
    embeddings: opts.embeddings ?? embeddingsOn(env),
  });
}

/** Drop every cached backend and close its driver, whoever still holds it. */
export async function closeGraphBackends(): Promise<void> {
  const all = [...cache.values()];
  cache.clear();
  await Promise.all(all.map((e) => e.backend.then((b) => b.close()).catch(() => undefined)));
}

async function open(cfg: Neo4jConfig, opts: GraphBackendOptions): Promise<Neo4jBackend> {
  const bolt = new Bolt(cfg);
  const engine = new Neo4jEngine(bolt);
  try {
    await bolt.verify();
    const embedder: Embedder | undefined =
      opts.embeddings === false ? undefined : typeof opts.embeddings === "object" ? opts.embeddings : await MiniLMEmbedder.load();
    let seed: SeedReport | undefined;
    let veinMigration: VeinMigrationReport | undefined;
    let runStatusMigration: RunStatusMigrationReport | undefined;
    let exactKeyMigration: ExactKeyMigrationReport | undefined;
    if (!opts.skipBoot) {
      // Legacy names first, so the seed below extends the renamed Schema
      // nodes instead of creating twins beside them.
      veinMigration = await migrateVeinToStrut(bolt);
      if (veinMigration.status === "migrated") {
        console.warn(`[graph] renamed legacy Vein* graph data to Strut*: ${JSON.stringify(veinMigration)}`);
      } else if (veinMigration.strays > 0) {
        console.warn(`[graph] ${veinMigration.strays} Domain_vein node(s) carry no Vein type label and were left alone`);
      }
      // Before the seed, which is add-only: it would keep the old `status`
      // attribute and the fulltext index built over it.
      runStatusMigration = await migrateRunStatus(bolt);
      if (runStatusMigration.status === "migrated") {
        console.warn(`[graph] moved StrutRun.status to run_status: ${JSON.stringify(runStatusMigration)}`);
      }
      // Workspace nodes an older strut keyed on the sanitized name (one
      // node for `pod/test` and `pod_test`) move to their exact keys.
      exactKeyMigration = await migrateExactKeys(bolt);
      if (exactKeyMigration.status === "migrated") {
        console.warn(`[graph] re-keyed workspace nodes on their exact names: ${JSON.stringify(exactKeyMigration)}`);
      }
      seed = await seedStrutDomain(engine);
    }
    const schemas = new SchemaResolver(engine);
    // The pass starts now and runs in the background; the old awaited
    // backfill held the boot for as long as the sweep took. It embeds in a
    // worker thread: onnxruntime runs a model synchronously, and hours of
    // catch-up on this thread would stall every request the process serves.
    // The writer and search keep `embedder` (a query is one short text). An
    // injected embedder is used as it is.
    const passWorker = embedder && !opts.skipBoot && typeof opts.embeddings !== "object" ? new WorkerEmbedder() : undefined;
    const embeddings = embedder && !opts.skipBoot ? new EmbeddingPass(bolt, passWorker ?? embedder, schemas, opts.pass) : undefined;
    const backend: Neo4jBackend = {
      kind: "neo4j",
      cfg,
      bolt,
      namespace: engine.namespace,
      dialect: engine.dialect,
      query: (cypher, params) => engine.query(cypher, params),
      tx: (fn) => engine.tx(fn),
      nodeEngine: engine.nodeEngine,
      edgeEngine: engine.edgeEngine,
      schemaSource: engine.schemaSource,
      // A write that asks for `embed: "later"` hands its nodes to the pass.
      nodes: new NodeWriter(engine, { embedder, resolver: schemas, ...(embeddings ? { later: (refs: string[]) => embeddings.soon(refs) } : {}) }),
      edges: new EdgeWriter(engine, { resolver: schemas }),
      reader: new Neo4jReader(bolt, { embedder, resolver: schemas }),
      schemas,
      branches: { held: false },
      embedder,
      seed,
      veinMigration,
      runStatusMigration,
      exactKeyMigration,
      embeddings,
      async close() {
        await embeddings?.stop();
        await passWorker?.close();
        await bolt.close();
      },
    };
    return backend;
  } catch (e) {
    await bolt.close().catch(() => undefined);
    throw e;
  }
}
