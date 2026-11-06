// The whole Concept tree in a few calls, on the app's grants (app.yaml):
// `graph/find` pages every Concept with its properties, then
// `graph/graph-edges` reads the edges among them, 1,000 at a time with
// every Concept as `among`. The same steps on a Neo4j and a Ladybug file.
import { useQuery } from "@tanstack/react-query";
import { useStrutClient, type StrutClient } from "@strut/kit";
import { getEdges } from "strut/views";
import { buildTree, conceptOf, TREE_TYPE, type Concept, type ConceptTree } from "./tree";

export const FIND = "graph/find";
/** A page of Concepts: docs run to ~6k chars, so 200 stays far under step_run's 5 MB. */
const PAGE = 200;
/** graph-edges' `ref_ids` per call, and the most `among` may hold. */
const EDGES_IDS = 1000;
export const MAX_CONCEPTS = 5000;

interface FindPage {
  nodes: Array<{ ref_id: string; name?: string; properties?: Record<string, unknown> }>;
  cursor?: string;
}

export async function readTree(client: StrutClient): Promise<{ tree: ConceptTree; truncated: boolean }> {
  const concepts: Concept[] = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const r = await client.run(FIND, { node_type: TREE_TYPE, orderBy: "name", limit: PAGE, ...(cursor ? { cursor } : {}) });
    // A graph step answers a problem (no graph here, a bad argument) as a string.
    if (typeof r === "string") throw new Error(r);
    const page = r as FindPage;
    for (const n of page.nodes ?? []) concepts.push(conceptOf(n));
    cursor = page.cursor;
    if (cursor && concepts.length >= MAX_CONCEPTS) {
      truncated = true;
      break;
    }
  } while (cursor);
  const ids = concepts.map((c) => c.id);
  const edges: Array<{ source: string; target: string; edge_type: string }> = [];
  for (let i = 0; i < ids.length; i += EDGES_IDS) {
    const r = await getEdges(client, ids.slice(i, i + EDGES_IDS), { among: ids });
    edges.push(...r.edges);
    if (r.truncated) truncated = true;
  }
  return { tree: buildTree(concepts, edges), truncated };
}

export function useConceptTree() {
  const client = useStrutClient();
  return useQuery({ queryKey: ["knowledge", "tree"], queryFn: () => readTree(client), staleTime: 5 * 60_000 });
}
