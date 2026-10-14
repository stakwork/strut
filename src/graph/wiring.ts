/**
 * Env-driven wiring for the graph-backed workspace. Graph is the DEFAULT:
 * the default server keeps workflows/steps in Neo4j (connection from the
 * `NEO4J_*` vars, defaulting to localhost:7687) unless
 * `STRUT_WORKSPACE_BACKEND=fs` opts back into the filesystem workspace, or
 * `STRUT_WORKSPACE_BACKEND=ladybug` keeps them in one LadybugDB file under
 * `dataDir` (plans/ladybug-backend.md — the desktop's backend: no daemon,
 * no port). Neo4j is therefore a boot dependency by default — `bolt.verify()`
 * fails loudly when nothing is listening. Runs, chats, secrets, artifacts,
 * and cassettes stay local under `dataDir` (`STRUT_WORKSPACE`) on every
 * backend — the run/chat projector (`projector.ts`, or the `graph/project`
 * step) builds their graph view.
 */
import { join } from "node:path";
import type { GraphBackend, GraphBackendOptions, LadybugBackend, LadybugConfig } from "./backend.js";
import { embeddingsOn, openGraphBackend, openGraphBackendFromEnv } from "./backend.js";
import { GraphWorkspaceStore, type GraphWorkspaceStoreOptions } from "./workspace-store.js";

export type WorkspaceBackend = "neo4j" | "ladybug" | "fs";

/** `STRUT_WORKSPACE_BACKEND`, case-insensitive: `fs` (or `file` /
 *  `filesystem`) is the filesystem workspace, `ladybug` a LadybugDB file;
 *  anything else — unset, the legacy `graph`, `neo4j` — is Neo4j. */
export function workspaceBackendFromEnv(env: Record<string, string | undefined> = process.env): WorkspaceBackend {
  const v = (env["STRUT_WORKSPACE_BACKEND"] ?? "").toLowerCase();
  if (v === "fs" || v === "file" || v === "filesystem") return "fs";
  if (v === "ladybug") return "ladybug";
  return "neo4j";
}

/** Graph (Neo4j or Ladybug) unless `STRUT_WORKSPACE_BACKEND=fs`. */
export function graphWorkspaceRequested(env: Record<string, string | undefined> = process.env): boolean {
  return workspaceBackendFromEnv(env) !== "fs";
}

/** Same default as the mcp host's own Neo4j client and the `graph/*` steps:
 *  a local Neo4j needs nothing configured. */
export const DEFAULT_NEO4J_HOST = "localhost:7687";

/**
 * Where the graph store materializes active custom steps for the module
 * loader: INSIDE the data dir, beside where a file workspace would keep
 * `steps/custom`. Custom steps `import "strut"` (and "zod"), and Node resolves
 * that by walking up from the FILE's directory — so the dir must sit in the
 * same tree as the file store's, never under the OS temp dir. Distinct from
 * `steps/custom` so switching backends on one dir can't prune the other's
 * files.
 */
export function graphMaterializeDir(dataDir: string): string {
  return join(dataDir, "steps", "_graph");
}

/**
 * Open the graph backend from env and wrap it in a `GraphWorkspaceStore`.
 * Connection: `NEO4J_URI`, else `bolt://<NEO4J_HOST>` (default
 * `localhost:7687`); `NEO4J_USER` / `NEO4J_PASSWORD` default to
 * neo4j / testtest — the same resolution as the mcp host, so a deployment's
 * existing vars just work and a local Neo4j needs none. `dataDir` (default
 * `STRUT_WORKSPACE` / `./workspace`) is where custom steps are materialized.
 */
export async function graphWorkspaceFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { dataDir?: string; backend?: GraphBackendOptions; store?: GraphWorkspaceStoreOptions } = {},
): Promise<{ backend: GraphBackend; workspace: GraphWorkspaceStore }> {
  const backend = await openGraphBackendFromEnv({ NEO4J_HOST: DEFAULT_NEO4J_HOST, ...env }, opts.backend)!;
  const dataDir = opts.dataDir ?? env["STRUT_WORKSPACE"] ?? "./workspace";
  const store = { materializeDir: graphMaterializeDir(dataDir), ...opts.store };
  return { backend, workspace: new GraphWorkspaceStore(backend, store) };
}

// ── Ladybug ─────────────────────────────────────────────────────────────────

/** The graph file's default place: its own owner-only folder under the
 *  data dir (the handle makes the FOLDER 0700, so the file never sits
 *  beside the runs and artifacts in `dataDir` itself), the twin of the
 *  memory steps' `<dataDir>/memory/graph.lbug`. */
export function ladybugGraphPath(dataDir: string): string {
  return join(dataDir, "graph", "graph.lbug");
}

/** `STRUT_GRAPH_DB` (default `<dataDir>/graph/graph.lbug`), the extension
 *  folder from `STRUT_LADYBUG_EXTENSION_DIR` (unset → the handle INSTALLs
 *  them), and the namespace — `default`, the only one a file holds; a
 *  `STRUT_GRAPH_NAMESPACE` set to anything else fails the open, loudly. */
export function ladybugConfigFromEnv(env: Record<string, string | undefined>, dataDir: string): LadybugConfig {
  const extensionDir = env["STRUT_LADYBUG_EXTENSION_DIR"];
  return {
    kind: "ladybug",
    path: env["STRUT_GRAPH_DB"] || ladybugGraphPath(dataDir),
    namespace: env["STRUT_GRAPH_NAMESPACE"] || "default",
    ...(extensionDir ? { extensionDir } : {}),
  };
}

/**
 * The Ladybug twin of `graphWorkspaceFromEnv`: open the file named by
 * `ladybugConfigFromEnv` (`STRUT_GRAPH_EMBEDDINGS=off` leaves the embedder
 * out, as on Neo4j) and wrap it in a `GraphWorkspaceStore` materializing
 * custom steps under `dataDir`. An open without the addon or the two
 * extensions throws with the install hint (ruling 4) — never a degraded
 * backend.
 */
export async function ladybugWorkspaceFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { dataDir?: string; backend?: GraphBackendOptions; store?: GraphWorkspaceStoreOptions } = {},
): Promise<{ backend: LadybugBackend; workspace: GraphWorkspaceStore }> {
  const dataDir = opts.dataDir ?? env["STRUT_WORKSPACE"] ?? "./workspace";
  const backend = await openGraphBackend(ladybugConfigFromEnv(env, dataDir), { embeddings: embeddingsOn(env), ...opts.backend });
  const store = { materializeDir: graphMaterializeDir(dataDir), ...opts.store };
  return { backend, workspace: new GraphWorkspaceStore(backend, store) };
}
