/**
 * A Concept's VERSION: a hash of what opening its page returns — its name,
 * description and docs, and the name and description of each Concept under
 * it (`PARENT_OF`). The children are in it because they are what a reader
 * of the page is shown to choose from (`context/concept`'s list, graph-get's
 * `children`): rewriting a child's description changes what this page does.
 *
 * It is what a claim about a Concept is versioned by (`claims.ts`, subject
 * kind `concept`), the twin of a workflow's or step's content hash. ONE
 * function computes it for both sides, over the graph as it is, never a
 * reader's scoped view of it, so the two always agree:
 *
 *   - the read: `graph/graph-get` stamps it on the node it reports
 *     (`AccessedNode.version`), so the run's log says which version it read;
 *   - the claims reader: `activeVersion` computes it now.
 *
 * A page elsewhere in the tree does not move it.
 */
import { contentHash } from "../version.js";
import type { GraphBackend } from "./backend.js";

/** `seed-types.ts` `CONCEPT_TYPE` (not imported: that module imports claims.ts, which imports this). */
const CONCEPT = "Concept";
const PARENT_OF = "PARENT_OF";

export interface ConceptPageForVersion {
  name: string;
  description?: string | null;
  docs?: string | null;
  children: ReadonlyArray<{ name: string; description?: string | null }>;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Pure: the version of a page. Children in name order, so the order they
 *  were read in never matters. */
export function conceptVersionOf(page: ConceptPageForVersion): string {
  const children = page.children
    .map((c) => [text(c.name), text(c.description)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return contentHash(JSON.stringify([text(page.name), text(page.description), text(page.docs), children]));
}

/** The version of the live Concept `ref_id` names, or null when there is
 *  none. `query` must be unscoped (a scoped view's is `boundsOf(b).query`). */
export async function readConceptVersion(g: Pick<GraphBackend, "query" | "dialect">, ref_id: string): Promise<string | null> {
  const d = g.dialect;
  const page = await g.query(
    `MATCH ${d.node("p", CONCEPT, { ref_id: "$ref" })} WHERE ${d.live("p")} RETURN p.name AS name, p.description AS description, p.docs AS docs LIMIT 1`,
    { ref: ref_id },
  );
  if (!page.length) return null;
  const children = await g.query(
    `MATCH ${d.node("p", CONCEPT, { ref_id: "$ref" })}-[r:\`${PARENT_OF}\`]->${d.node("c", CONCEPT)}
     WHERE ${d.edgeLive("r")} AND ${d.live("c")} RETURN c.name AS name, c.description AS description`,
    { ref: ref_id },
  );
  return conceptVersionOf({
    name: text(page[0]!["name"]),
    description: text(page[0]!["description"]),
    docs: text(page[0]!["docs"]),
    children: children.map((c) => ({ name: text(c["name"]), description: text(c["description"]) })),
  });
}
