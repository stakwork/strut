/**
 * An app's GRAPH TYPES (plans/apps.md §4.3, work item 4): what `data.graph`
 * in `app.yaml` becomes on the workspace's graph.
 *
 * Neo4j only (ruled 2026-10-26). A LadybugDB file keeps its closed registry
 * (plans/ladybug-backend.md ruling 6), and the filesystem workspace has no
 * graph, so on either an app that declares graph types does not build, and
 * the error says why. On Neo4j:
 *
 *   - every BUILD checks the declaration against the graph (`checkAppGraph`):
 *     a type strut keeps for itself is refused, and so is one the graph
 *     already holds with an attribute of another type, another key, or a
 *     required attribute this app does not declare — "a conflicting
 *     declaration is a build error";
 *   - a PUBLISH registers it (`registerAppGraph`), before the version is
 *     recorded: each type through `createNodeSchema` (jarvis's `POST
 *     /v2/schema` shape — a new type, or an existing one extended add-only),
 *     each edge through the resolver's `createEdgeSchema`. A type another
 *     app declared with the same attributes is the same type, and nothing
 *     is ever removed: rolling a version back keeps what it registered.
 *
 * The attribute grammar maps onto jarvis's: `number` → `float`, `string` and
 * `boolean` as they are, `date` → `string` (an ISO date, which compares as
 * text — `graph/find`'s rule), `json` → `string` (JSON text: a Neo4j
 * property cannot hold a map). `x?` → `?x`. `key` is the node_key (default
 * `name`), `search` the index (default the key).
 *
 * `reservedAppType` is also what the app door's write scope reads
 * (./tools.ts), so a manifest published before this check cannot write
 * those types either. The schema writer (and with it the Neo4j driver and
 * jarvis's ontology fixture) is imported on the first app that declares a
 * type, never at boot.
 */
import type { GraphBackend } from "../graph/backend.js";
import { CHECK_TYPE, CLAIM_TYPE, EVIDENCE_TYPE } from "../graph/claims.js";
import type { NodeSchemaInput } from "../graph/schema-crud.js";
import { THING_TYPE, isStrutType } from "../graph/strut-schemas.js";
import { withLock } from "../jobs.js";
import { MANIFEST_FILE, TYPE_LISTS, type AppManifest } from "./manifest.js";

/** The app grammar's base types as jarvis's. */
const BASE_TYPE: Record<string, string> = { string: "string", number: "float", boolean: "boolean", date: "string", json: "string" };

/** `number?` → `?float`. */
export function graphAttributeType(t: string): string {
  const optional = t.endsWith("?");
  const base = BASE_TYPE[t.replace(/\?$/, "")];
  if (!base) throw new Error(`not an app attribute type: ${t}`);
  return `${optional ? "?" : ""}${base}`;
}

const RESERVED: ReadonlyArray<[string[], string]> = [
  [[THING_TYPE, "Schema"], "is the root of the graph's ontology"],
  [["Concept"], "is the workspace's notes, which the builder and the job agent read as instructions — a workflow writes them, never a page"],
  [[CLAIM_TYPE, CHECK_TYPE, EVIDENCE_TYPE], "is the claims layer's — evidence comes from the verify pass and from people (plans/claims.md)"],
];

/** Why an app may neither declare nor write `type`, or null. Case-blind,
 *  as the graph resolves a type. */
export function reservedAppType(type: string): string | null {
  if (isStrutType(type) || /^strut/i.test(type)) return "is one of strut's own types";
  const lower = type.toLowerCase();
  for (const [types, why] of RESERVED) if (types.some((t) => t.toLowerCase() === lower)) return why;
  return null;
}

/** The declared types, each as `createNodeSchema` takes it. */
export function appSchemaInputs(manifest: AppManifest, app?: string): NodeSchemaInput[] {
  const types = manifest.data?.graph?.types ?? {};
  return Object.entries(types).map(([type, spec]) => {
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec)) {
      if ((TYPE_LISTS as readonly string[]).includes(k) || Array.isArray(v)) continue;
      attributes[k] = graphAttributeType(v);
    }
    const key = Array.isArray(spec["key"]) && spec["key"].length ? spec["key"] : ["name"];
    const search = Array.isArray(spec["search"]) && spec["search"].length ? spec["search"] : key;
    // The title a search hit shows: `name` when the type has one, else the key's first field.
    const title = "name" in attributes || key.includes("name") ? undefined : key[0];
    return {
      type,
      attributes,
      node_key: key.join("-"),
      index: [...search],
      ...(title ? { title_key: title } : {}),
      ...(app ? { type_description: `Declared by the app ${app} (app.yaml data.graph).` } : {}),
    };
  });
}

export interface GraphTypesCheck {
  errors: string[];
  warnings: string[];
}

const at = (type: string, attr?: string) => `${MANIFEST_FILE}: data.graph.types.${type}${attr ? `.${attr}` : ""}`;
const baseOf = (t: string) => t.replace(/^\?/, "");

/**
 * Can this app's graph types be registered on `graph`? Nothing to check when
 * the app declares none. Reads only: a build runs it, and a publish before
 * it registers.
 */
export async function checkAppGraph(manifest: AppManifest, graph: GraphBackend | undefined, app?: string): Promise<GraphTypesCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const inputs = appSchemaInputs(manifest, app);
  if (!inputs.length) return { errors, warnings };
  const { planNodeSchema } = await import("../graph/schema-crud.js");

  for (const input of inputs) {
    const reserved = reservedAppType(input.type);
    if (reserved) {
      errors.push(`${at(input.type)}: ${input.type} ${reserved}; an app declares types of its own (plans/apps.md §4.3)`);
      continue;
    }
    try {
      planNodeSchema(input);
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "GraphValidationError") throw e;
      const attribute = (e as Error & { attribute?: string }).attribute;
      const attr = attribute === "node_key" ? "key" : attribute === "index" ? "search" : attribute;
      errors.push(`${at(input.type, attr)}: ${e.message.replace(/^[^:]*: /, "")}`);
    }
  }
  if (errors.length) return { errors, warnings };

  if (!graph) {
    errors.push(`${MANIFEST_FILE}: data.graph: this strut has no graph (its workspace is on the filesystem), so an app that declares graph types does not build here — keep the data in runs, or build the app on a strut whose graph is Neo4j`);
    return { errors, warnings };
  }
  if (graph.kind !== "neo4j") {
    errors.push(`${MANIFEST_FILE}: data.graph: this strut's graph is a LadybugDB file, whose types are fixed in code (plans/ladybug-backend.md §3), so an app that declares graph types does not build here — build it on a strut whose graph is Neo4j`);
    return { errors, warnings };
  }

  for (const input of inputs) {
    const live = await graph.schemas.resolveType(input.type);
    if (!live) continue;
    const reserved = reservedAppType(live);
    if (reserved) {
      errors.push(`${at(input.type)}: the graph holds this type as ${live}, which ${reserved}`);
      continue;
    }
    const schema = await graph.schemas.schema(live);
    if (!schema) continue;
    const named = live === input.type ? input.type : `${input.type} (${live} in the graph)`;
    for (const [k, t] of Object.entries(input.attributes)) {
      const held = schema.attributes[k];
      if (held && baseOf(held) !== baseOf(t)) {
        errors.push(`${at(input.type, k)}: ${named} already holds ${k} as ${baseOf(held)}, and this app declares ${baseOf(t)} — declare it as the graph has it, or name another attribute`);
      }
    }
    const heldKey = schema.node_key.split("-").slice(1);
    const key = planNodeSchema(input).tokens;
    if (heldKey.join("-") !== key.join("-")) {
      errors.push(`${at(input.type, "key")}: ${named} is keyed by [${heldKey.join(", ")}] in the graph, and this app declares [${key.join(", ")}] — two keys would make two identities for one type`);
    }
    for (const [k, t] of Object.entries(schema.attributes)) {
      if (t.startsWith("?") || k in input.attributes || k === "name") continue;
      errors.push(`${at(input.type)}: ${named} requires ${k} (${baseOf(t)}) on every node, and this app does not declare it — the app's writes would be refused`);
    }
    const index = [...(input.index ?? [])].sort().join(",");
    if (index !== [...schema.index].sort().join(",")) {
      warnings.push(`${at(input.type, "search")}: ${named} is indexed on [${schema.index.join(", ")}] in the graph — an existing type keeps its index, so this app's search list does not apply`);
    }
  }
  return { errors, warnings };
}

export interface RegisteredGraph {
  /** Each declared type: whether this publish made it, and the attributes it added. */
  types: Array<{ type: string; created: boolean; added: string[] }>;
  /** Each declared edge, `Source-[EDGE]->Target`, and whether this publish made it. */
  edges: Array<{ edge: string; created: boolean }>;
}

/**
 * Register the declared types and edges on a Neo4j graph, add-only. Run
 * after `checkAppGraph` passed; one registration at a time per process.
 */
export async function registerAppGraph(manifest: AppManifest, graph: GraphBackend, app?: string): Promise<RegisteredGraph> {
  const out: RegisteredGraph = { types: [], edges: [] };
  const inputs = appSchemaInputs(manifest, app);
  if (!inputs.length) return out;
  const { createNodeSchema } = await import("../graph/schema-crud.js");
  return withLock("app-graph-types", async () => {
    const live = new Map<string, string>();
    for (const input of inputs) {
      const r = await createNodeSchema(graph, graph.schemas, input);
      live.set(input.type, r.type);
      out.types.push({ type: r.type, created: r.created, added: r.added });
    }
    for (const [s, edge, t] of manifest.data?.graph?.edges ?? []) {
      const source = live.get(s) ?? s;
      const target = live.get(t) ?? t;
      const r = await graph.schemas.createEdgeSchema(source, edge, target);
      out.edges.push({ edge: `${source}-[${edge}]->${target}`, created: r.created });
    }
    return out;
  });
}
