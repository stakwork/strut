/**
 * A graph backend as a run on a Concept BRANCH has it (src/branches.ts,
 * plans/concept-evals.md item b): Concepts only are the branch's, the rest of
 * the graph is the live graph (ruling 3).
 *
 *   - reads: the reader held to the branch (`withBranch`, scope.ts): a
 *     Concept is read in the branch's namespace alone, and nothing else is
 *     read there; a keyed read of a Concept (by name) reads the branch's;
 *     raw queries are off;
 *   - writes (here): a Concept is written in the branch's namespace; a
 *     write to a Concept that is not on the branch is refused, and so is
 *     anything else written into the branch's namespace. An edge with a
 *     page of the branch at one end has one at the other: a branch's pages
 *     link to one another and to nothing outside, so no read on main walks
 *     onto them — and a page outside the branch is not the run's to link.
 *
 * Every other write goes through as it would.
 */
import type { GraphBackend } from "./backend.js";
import type { EdgeInput, EdgeLocator, EdgeMove } from "./edge-writer.js";
import type { NodeInput, WriteOptions } from "./node-writer.js";
import { ScopeRefused, boundsOf, branchOf, withBranch } from "./scope.js";
import { DEFAULT_NAMESPACE } from "./search.js";

const CONCEPT = "Concept";
const isConcept = (type: unknown) => typeof type === "string" && type.trim().toLowerCase() === "concept";

/** A refused write on a branch: read as a `GraphReadError` with code
 *  `REFUSED` (`graphErrorCode`), what a step says back. */
const refused = (branch: string, why: string) => new ScopeRefused(`this run is on Concept branch "${branchName(branch)}": ${why}`);

/** A branch's name from its namespace (`branch-<name>`). */
const branchName = (ns: string) => ns.replace(/^branch-/, "");

/** One node's type and namespace, deleted or not, read past every view. */
async function nodeAt(b: GraphBackend, query: GraphBackend["query"], ref_id: string): Promise<{ concept: boolean; ns: string } | null> {
  const at = b.kind === "neo4j" ? "(n:Data_Bank {ref_id: $r})" : "(n:Node {ref_id: $r})";
  const [row] = await query(`MATCH ${at} RETURN ${b.dialect.isType("n", [CONCEPT])} AS concept, coalesce(n.namespace, $d) AS ns LIMIT 1`, { r: ref_id, d: b.kind === "neo4j" ? DEFAULT_NAMESPACE : b.namespace });
  return row ? { concept: row["concept"] === true, ns: String(row["ns"]) } : null;
}

/** An edge's two ends, by its ref_id. */
async function endsOf(b: GraphBackend, query: GraphBackend["query"], ref_id: string): Promise<string[]> {
  const [row] = await query(`MATCH (s)-[r]->(t) WHERE r.ref_id = $r RETURN s.ref_id AS s, t.ref_id AS t LIMIT 1`, { r: ref_id });
  return row ? [String(row["s"]), String(row["t"])] : [];
}

/** An edge a run on `branch` may write between `refs`: a page of the
 *  branch at either end has one at the other, and no live page at all. An
 *  end not found is the writer's to report. */
async function linkOnBranch(b: GraphBackend, query: GraphBackend["query"], branch: string, refs: string[]): Promise<void> {
  const ends = (await Promise.all(refs.map((r) => nodeAt(b, query, r)))).filter((e): e is { concept: boolean; ns: string } => e !== null);
  if (ends.some((e) => e.concept && e.ns !== branch)) throw refused(branch, "a Concept of the live tree is not linked from a run on a branch — link the branch's page of that name");
  if (ends.some((e) => e.ns === branch) && !ends.every((e) => e.ns === branch)) throw refused(branch, "a page of the branch links only to the branch's other pages");
}

/** The link rule for a write that goes past the guarded writers (graph/assert's
 *  facts, in a transaction of their own): nothing off a branch view. */
export async function assertBranchLink(b: GraphBackend, refs: string[]): Promise<void> {
  const branch = branchOf(b);
  if (branch) await linkOnBranch(b, boundsOf(b)!.query, branch, refs.filter(Boolean));
}

/**
 * The backend as a run on the branch whose namespace is `branch` has it:
 * reads held to the branch, writes guarded (above). Idempotent; a view on
 * another branch is refused (`withBranch`).
 */
export function onBranch(b: GraphBackend, branch: string): GraphBackend {
  if (branchOf(b) === branch) return b;
  const view = withBranch(b, branch);
  // Read past the view: what a node IS decides the rule, wherever it is.
  const query = boundsOf(view)!.query;
  const own = b.namespace;

  /** Where a node write of `type` asked for `ns` goes, or the refusal. */
  const nodeNamespace = (type: string, ns: string | undefined): string | undefined => {
    const asked = ns?.trim().toLowerCase();
    const live = !asked || asked === own || asked === DEFAULT_NAMESPACE;
    if (isConcept(type)) {
      if (live || asked === branch) return branch;
      throw refused(branch, `its Concepts are written on the branch, never in "${ns}"`);
    }
    if (asked === branch) throw refused(branch, `the branch holds its Concepts alone — a ${type} is written in the live graph`);
    return ns;
  };
  /** A node the run may change: not a Concept off the branch. */
  const changeable = async (ref_id: string): Promise<{ concept: boolean; ns: string } | null> => {
    const n = await nodeAt(b, query, ref_id);
    if (n?.concept && n.ns !== branch) throw refused(branch, `${ref_id} is a Concept of the live tree, which a run on a branch only reads — change the branch's page of that name`);
    return n;
  };
  const linkable = (refs: string[]) => linkOnBranch(b, query, branch, refs);

  const nodes = b.nodes;
  const guardedNodes = new Proxy(nodes, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = (v as (...args: unknown[]) => Promise<unknown>).bind(target);
      switch (prop) {
        case "write":
          return (input: NodeInput, mode?: unknown, opts: WriteOptions = {}) => {
            const ns = nodeNamespace(input.type, opts.namespace);
            return fn(input, mode, { ...opts, ...(ns ? { namespace: ns } : {}) });
          };
        case "writeMany":
          return async (inputs: NodeInput[], mode?: unknown, opts: WriteOptions = {}) => {
            const at = inputs.map((i) => nodeNamespace(i.type, opts.namespace));
            if (at.every((ns) => ns === at[0])) return fn(inputs, mode, { ...opts, ...(at[0] ? { namespace: at[0] } : {}) });
            // Concepts and other nodes in one call: two writes, one transaction.
            const split = async (tx: unknown) => {
              const out: unknown[] = new Array(inputs.length);
              for (const ns of new Set(at)) {
                const idx = at.flatMap((n, k) => (n === ns ? [k] : []));
                const res = (await fn(idx.map((k) => inputs[k]!), mode, { ...opts, ...(ns ? { namespace: ns } : {}), tx })) as unknown[];
                idx.forEach((k, j) => (out[k] = res[j]));
              }
              return out;
            };
            return opts.tx ? split(opts.tx) : b.tx(split);
          };
        case "update":
          return async (ref_id: string, ...rest: unknown[]) => {
            await changeable(ref_id);
            return fn(ref_id, ...rest);
          };
        case "deleteNode":
        case "restoreNode":
          return async (ref_id: string, opts: { namespace?: string } = {}) => {
            const n = await changeable(ref_id);
            if (n?.concept) return fn(ref_id, { ...opts, namespace: branch });
            if (opts.namespace?.trim().toLowerCase() === branch) throw refused(branch, "the branch holds its Concepts alone");
            return fn(ref_id, opts);
          };
        default:
          return fn;
      }
    },
  });

  const edges = b.edges;
  const guardedEdges = new Proxy(edges, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = (v as (...args: unknown[]) => Promise<unknown>).bind(target);
      const located = async (where: string | EdgeLocator) => {
        const at: EdgeLocator = typeof where === "string" ? { ref_id: where } : where;
        await linkable("ref_id" in at ? await endsOf(b, query, at.ref_id) : [at.source_ref_id, at.target_ref_id]);
      };
      switch (prop) {
        case "write":
          return async (input: EdgeInput, ...rest: unknown[]) => {
            await linkable([input.source_ref_id, input.target_ref_id]);
            return fn(input, ...rest);
          };
        case "writeMany":
          return async (inputs: EdgeInput[], ...rest: unknown[]) => {
            for (const i of inputs) await linkable([i.source_ref_id, i.target_ref_id]);
            return fn(inputs, ...rest);
          };
        case "update":
        case "delete":
          return async (where: string | EdgeLocator, ...rest: unknown[]) => {
            await located(where);
            return fn(where, ...rest);
          };
        case "move":
          return async (m: EdgeMove, ...rest: unknown[]) => {
            await linkable([m.ref_id, m.to_ref_id, ...(m.from_ref_id ? [m.from_ref_id] : [])]);
            return fn(m, ...rest);
          };
        default:
          return fn;
      }
    },
  });

  return { ...view, nodes: guardedNodes, edges: guardedEdges } as GraphBackend;
}

/** `graph/set-namespace` on a branch: no node or edge moves into or out of
 *  the branch's namespace, and no Concept moves at all — its namespace is
 *  what puts it on the branch or the live tree. */
export function assertBranchMove(b: object, move: { type?: string; from: string; to: string }): void {
  const branch = branchOf(b);
  if (!branch) return;
  if (isConcept(move.type) || move.from === branch || move.to === branch) {
    throw refused(branch, "nothing moves into or out of the branch's namespace, and no Concept moves between namespaces");
  }
}
