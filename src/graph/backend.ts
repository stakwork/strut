/**
 * The strut graph backend as one object: a bolt connection plus the writers,
 * the reader, and (optionally) the local embedder — opened once per
 * config and cached, with the boot-time obligations run on open:
 *
 *   1. `migrateVeinToStrut` — one-shot rename of pre-#1664 `Vein*` names;
 *   2. with `seedOntology`: `upgradeClaimSchema` (one-shot, the standalone
 *      mirror of jarvis migration 124), then `seedJarvisOntology`;
 *   2b. `migrateRunStatus` — one-shot `StrutRun.status` → `run_status`;
 *   2c. `migrateExactKeys` — one-shot re-key of the workspace nodes from the
 *       sanitized name to the exact one (hex);
 *   3. `seedStrutDomain` — schema meta-graph, constraints, indexes (§4);
 *   3b. `reconcileIndexLists` — stale Schema `index` lists widened to the
 *       bundled library's, once per fixture version (semantic-search.md §2);
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
 * open IS the schema (the DDL from the closed registry) — no seeds, no
 * migrations, no embedding pass (the writer embeds inline), and the
 * `LadybugReader` over its one FTS and one HNSW index.
 */
import { resolve } from "node:path";
import { Bolt, graphConfigFromEnv, type Neo4jConfig } from "./bolt.js";
import { upgradeClaimSchema, type ClaimSchemaUpgradeReport } from "./claim-schema-upgrade.js";
import { EdgeWriter } from "./edge-writer.js";
import { EmbeddingPass, MiniLMEmbedder, WorkerEmbedder, type EmbeddingPassOptions } from "./embeddings.js";
import type { GraphEngine } from "./engine.js";
import { reconcileIndexLists, type IndexReconcileReport } from "./index-reconcile.js";
import { openLadybug, type LadybugHandle } from "./ladybug/db.js";
import { LadybugEngine } from "./ladybug/engine.js";
import { LadybugReader } from "./ladybug/reader.js";
import { Neo4jEngine } from "./neo4j-engine.js";
import { NodeWriter, type Embedder } from "./node-writer.js";
import { seedJarvisOntology, type OntologySeedReport } from "./ontology-seed.js";
import { SchemaResolver } from "./schema-resolver.js";
import { seedStrutDomain, type SeedReport } from "./schema-seed.js";
import { Neo4jReader, type GraphReader } from "./search.js";
import { migrateVeinToStrut, type VeinMigrationReport } from "./vein-migration.js";
import { migrateRunStatus, type RunStatusMigrationReport } from "./run-status-migration.js";
import { migrateExactKeys, type ExactKeyMigrationReport } from "./exact-key-migration.js";

/** A LadybugDB file (plans/ladybug-backend.md §3.2). */
export interface LadybugConfig {
  kind: "ladybug";
  /** The database file; its folder is created owner-only. */
  path: string;
  /** Always `default`: one namespace per file. */
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
  /** Also seed the bundled jarvis ontology (`fixtures/jarvis-ontology.ts`)
   *  — add-only, a no-op on a jarvis-seeded DB — so a standalone Neo4j can
   *  host jarvis-typed data (Document, EvalSet, Concept, …) with no jarvis
   *  process. Env: `STRUT_GRAPH_SEED_ONTOLOGY=1`. */
  seedOntology?: boolean;
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
  readonly embedder: Embedder | undefined;
  /** What the boot-time seed did (undefined when skipped). */
  readonly seed: SeedReport | undefined;
  /** The pass, running on its timer; undefined with embeddings off or the
   *  boot skipped. `status()` is `GET /graph/embeddings`. */
  readonly embeddings: EmbeddingPass | undefined;
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
  readonly claimSchemaUpgrade: ClaimSchemaUpgradeReport | undefined;
  readonly ontologySeed: OntologySeedReport | undefined;
  readonly indexReconcile: IndexReconcileReport | undefined;
}

/** The Ladybug backend: one file, the closed registry's ten types. */
export interface LadybugBackend extends GraphBackendBase {
  readonly kind: "ladybug";
  readonly cfg: LadybugConfig;
  readonly lbug: LadybugHandle;
}

export type GraphBackend = Neo4jBackend | LadybugBackend;

const cache = new Map<string, Promise<GraphBackend>>();

function keyOf(cfg: GraphConfig, opts: GraphBackendOptions): string {
  const emb = opts.embeddings === false ? "off" : typeof opts.embeddings === "object" ? "custom" : "minilm";
  if (isLadybug(cfg)) return ["ladybug", resolve(cfg.path), cfg.namespace, emb].join("|");
  return [cfg.uri, cfg.user, cfg.database ?? "", cfg.namespace, emb, opts.seedOntology ? "ont" : ""].join("|");
}

/**
 * Open (or reuse) the backend for `cfg`. The first call per config pays for
 * connectivity, seeding, embedder load, and the backfill sweep; later calls
 * get the same instance. A failed open is not cached.
 */
export function openGraphBackend(cfg: Neo4jConfig, opts?: GraphBackendOptions): Promise<Neo4jBackend>;
export function openGraphBackend(cfg: LadybugConfig, opts?: GraphBackendOptions): Promise<LadybugBackend>;
export function openGraphBackend(cfg: GraphConfig, opts?: GraphBackendOptions): Promise<GraphBackend>;
export function openGraphBackend(cfg: GraphConfig, opts: GraphBackendOptions = {}): Promise<GraphBackend> {
  const key = keyOf(cfg, opts);
  let p = cache.get(key);
  if (!p) {
    p = (isLadybug(cfg) ? openLadybugBackend(cfg, opts) : open(cfg, opts)).catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, p);
  }
  return p;
}

async function openLadybugBackend(cfg: LadybugConfig, opts: GraphBackendOptions): Promise<LadybugBackend> {
  if (cfg.namespace !== "default") throw new Error(`a ladybug file holds one namespace, default; got ${cfg.namespace}`);
  const lbug = await openLadybug(cfg.path, { extensionDir: cfg.extensionDir });
  try {
    const embedder: Embedder | undefined =
      opts.embeddings === false ? undefined : typeof opts.embeddings === "object" ? opts.embeddings : await MiniLMEmbedder.load();
    const engine = new LadybugEngine(lbug, cfg.namespace);
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
      nodes: new NodeWriter(engine, { embedder, resolver: schemas }),
      edges: new EdgeWriter(engine, { resolver: schemas }),
      reader: new LadybugReader(engine, { embedder }),
      schemas,
      embedder,
      seed: undefined,
      embeddings: undefined,
      async close() {
        for (const [k, p] of cache) if ((await p.catch(() => null)) === backend) cache.delete(k);
        await lbug.close();
      },
    };
    return backend;
  } catch (e) {
    await lbug.close().catch(() => undefined);
    throw e;
  }
}

/** `STRUT_GRAPH_EMBEDDINGS`: on unless `off` / `0` / `false`. */
export function embeddingsOn(env: Record<string, string | undefined> = process.env): boolean {
  const emb = (env["STRUT_GRAPH_EMBEDDINGS"] ?? "").toLowerCase();
  return !(emb === "off" || emb === "0" || emb === "false");
}

/** `openGraphBackend` from `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD`/
 *  `STRUT_GRAPH_NAMESPACE`; null when `NEO4J_URI` is unset. Neo4j only: the
 *  Ladybug file is wired by `wiring.ts` (`ladybugConfigFromEnv`). */
export function openGraphBackendFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: GraphBackendOptions = {},
): Promise<GraphBackend> | null {
  const cfg = graphConfigFromEnv(env);
  if (!cfg) return null;
  const ont = env["STRUT_GRAPH_SEED_ONTOLOGY"];
  return openGraphBackend(cfg, {
    ...opts,
    embeddings: opts.embeddings ?? embeddingsOn(env),
    seedOntology: opts.seedOntology ?? (ont === "1" || ont === "true" || ont === "on"),
  });
}

/** Drop every cached backend and close its driver. */
export async function closeGraphBackends(): Promise<void> {
  const all = [...cache.values()];
  cache.clear();
  await Promise.all(all.map((p) => p.then((b) => b.close()).catch(() => undefined)));
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
    let claimSchemaUpgrade: ClaimSchemaUpgradeReport | undefined;
    let ontologySeed: OntologySeedReport | undefined;
    let indexReconcile: IndexReconcileReport | undefined;
    if (!opts.skipBoot) {
      // Legacy names first, so the seed below extends the renamed Schema
      // nodes instead of creating twins beside them.
      veinMigration = await migrateVeinToStrut(bolt);
      if (veinMigration.status === "migrated") {
        console.warn(`[graph] renamed legacy Vein* graph data to Strut*: ${JSON.stringify(veinMigration)}`);
      } else if (veinMigration.strays > 0) {
        console.warn(`[graph] ${veinMigration.strays} Domain_vein node(s) carry no Vein type label and were left alone`);
      }
      // Ontology first so a standalone DB gets jarvis's own Thing (with its
      // ref_id) before the Strut domain hangs off it.
      if (opts.seedOntology) {
        // The seed is add-only, so an already-seeded DB keeps its pre-124
        // `Claim` schema unless this runs first (plans/claims.md §1).
        claimSchemaUpgrade = await upgradeClaimSchema(bolt);
        if (claimSchemaUpgrade.status === "upgraded") {
          console.warn(`[graph] upgraded the Claim schema to claim-id: ${JSON.stringify(claimSchemaUpgrade)}`);
        } else if (claimSchemaUpgrade.status === "skipped_duplicates") {
          console.warn(`[graph] more than one Claim schema node — left alone; claims cannot be written until that is resolved by hand`);
        }
        ontologySeed = await seedJarvisOntology(engine);
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
      // Not gated on `seedOntology`: a jarvis-hosted graph is the one that
      // needs it (its Schemas predate jarvis's own widening).
      indexReconcile = await reconcileIndexLists(bolt);
      if (indexReconcile.status === "reconciled") {
        console.warn(`[graph] widened stale Schema index lists to the bundled library's: ${JSON.stringify(indexReconcile.widened)}`);
      }
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
      nodes: new NodeWriter(engine, { embedder, resolver: schemas }),
      edges: new EdgeWriter(engine, { resolver: schemas }),
      reader: new Neo4jReader(bolt, { embedder, resolver: schemas }),
      schemas,
      embedder,
      seed,
      veinMigration,
      runStatusMigration,
      exactKeyMigration,
      claimSchemaUpgrade,
      ontologySeed,
      indexReconcile,
      embeddings,
      async close() {
        for (const [k, p] of cache) if ((await p.catch(() => null)) === backend) cache.delete(k);
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
