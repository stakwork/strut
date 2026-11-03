/**
 * Move one node or edge to another namespace (plans/graph-memory-plan.md
 * step 6): the person's deliberate act that puts something in `shared`,
 * or takes it back. Two doors call it, both a person's: `POST
 * /graph/{nodes,edges}/:ref_id/namespace` and `graph/set-namespace`, which
 * runs only as an accepted proposal.
 *
 * Moving a node doesn't move its edges: each edge keeps its own namespace,
 * so one into the moved node stays as hidden or as visible as it was, and
 * a reader still needs both ends (scope.ts). The node's key and its
 * identifiers must be free in the namespace it moves into, as a write
 * there would require. Ladybug only: on Neo4j, namespaces are jarvis's
 * registered partitions and strut leaves them as on main. An edge's search row (`EdgeText`, plans/graph-edge-search.md)
 * moves with its edge, in the same transaction.
 */
import type { GraphBackend } from "./backend.js";
import { GraphValidationError } from "./node-writer.js";
import { namespaceName } from "./ladybug/namespaces.js";
import { EDGE_TEXT_TYPE } from "./ladybug/registry.js";
import { rowKey } from "./ladybug/temporal.js";

export interface SetNamespaceInput {
  kind: "node" | "edge";
  ref_id: string;
  namespace: string;
}

export interface SetNamespaceResult {
  kind: "node" | "edge";
  ref_id: string;
  /** Where it was, and where it is now. */
  from: string;
  namespace: string;
  /** False when it was already there. */
  moved: boolean;
}

export async function setNamespace(b: GraphBackend, input: SetNamespaceInput): Promise<SetNamespaceResult> {
  if (b.kind !== "ladybug") throw new GraphValidationError("WRONG_TYPE", input.kind, `moving between namespaces is not on this backend (${b.kind})`, "namespace");
  const ns = namespaceName(input.namespace, b.namespace);
  if (ns === null || !input.namespace.trim()) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", "namespace", `${input.namespace} is not a namespace name`);
  if (input.kind === "edge") return moveEdge(b, input.ref_id, ns);
  return b.tx(async (tx) => {
    const raw = await b.nodeEngine.readRaw(tx, input.ref_id);
    const type = raw?.type;
    if (!raw || !type || type === "Schema" || raw.props["deleted_at"] != null) throw new GraphValidationError("NOT_FOUND", "node", `no node ${input.ref_id}`);
    const from = String(raw.props["namespace"] ?? b.namespace);
    if (from === ns) return { kind: "node", ref_id: input.ref_id, from, namespace: ns, moved: false };
    const key = raw.props["key"];
    if (typeof key === "string" && key) {
      const held = await b.nodeEngine.refByKey(tx, type, key, ns);
      if (held && held !== input.ref_id) throw new GraphValidationError("DUPLICATE_KEY", type, `${ns} already holds a ${type} with this key (${held})`);
    }
    const schema = await b.schemas.schema(type);
    for (const id of schema?.identifiers ?? []) {
      const value = raw.props[id];
      if (value === undefined || value === null || value === "") continue;
      const holders = (await b.nodeEngine.holdersOf(tx, type, id, [value], ns)).filter((h) => h.ref_id !== input.ref_id);
      if (holders.length) throw new GraphValidationError("DUPLICATE_KEY", type, `${ns} already holds a ${type} with this ${id} (${holders[0]!.ref_id})`, id);
    }
    await tx.run(`MATCH (n:Node {ref_id: $ref_id}) SET n.namespace = $ns, n.updated_at = CAST($now AS INT64)`, { ref_id: input.ref_id, ns, now: Date.now() });
    return { kind: "node", ref_id: input.ref_id, from, namespace: ns, moved: true };
  });
}

async function moveEdge(b: GraphBackend, ref_id: string, ns: string): Promise<SetNamespaceResult> {
  return b.tx(async (tx) => {
    const rows = await tx.run(`MATCH (:Node)-[r {ref_id: $ref_id}]->(:Node) RETURN r.namespace AS ns LIMIT 1`, { ref_id });
    if (!rows.length) throw new GraphValidationError("NOT_FOUND", "edge", `no edge ${ref_id}`);
    const from = String(rows[0]!["ns"] ?? b.namespace);
    if (from === ns) return { kind: "edge", ref_id, from, namespace: ns, moved: false };
    const now = Date.now();
    await tx.run(`MATCH (:Node)-[r {ref_id: $ref_id}]->(:Node) SET r.namespace = $ns, r.updated_at = CAST($now AS INT64)`, { ref_id, ns, now });
    await tx.run(`MATCH (n:Node {node_type: '${EDGE_TEXT_TYPE}', key: $k}) SET n.namespace = $ns, n.updated_at = CAST($now AS INT64)`, { k: rowKey(ref_id), ns, now });
    return { kind: "edge", ref_id, from, namespace: ns, moved: true };
  });
}
