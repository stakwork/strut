// What the page reads, on the app's grants (app.yaml). The whole Concept
// tree in a few calls, on the app's grants (app.yaml):
// `graph/find` pages every Concept with its properties, then
// `graph/graph-edges` reads the edges among them, 1,000 at a time with
// every Concept as `among`. The same steps on a Neo4j and a Ladybug file.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useStrutClient, type StrutClient } from "@strut/kit";
import { getEdges, getNeighbors, type GraphHit } from "strut/views";
import { buildTree, conceptOf, TREE_TYPE, type Concept, type ConceptTree } from "./tree";
import { groupLinks, isSystemType, orderTypes, typeDescription, type OntologyType } from "./ontology";
import { DREAM, type ClaimedConcept, type PageClaim, type PendingChange } from "./learning";

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

/** A graph step answers a problem (no graph here, a bad argument) as a string: make it a throw. */
function answer<T>(step: string, r: unknown): T {
  if (typeof r === "string") throw new Error(`${step}: ${r}`);
  return r as T;
}

/** The ontology: every domain type `graph/get-ontology` names, counted with `graph/find`, empty ones left out. */
export async function readOntology(client: StrutClient): Promise<OntologyType[]> {
  const o = answer<{ node_types?: Record<string, Array<{ type: string; description?: string }>> }>("graph/get-ontology", await client.run("graph/get-ontology", {}));
  const types = Object.values(o.node_types ?? {})
    .flat()
    .filter((t) => !isSystemType(t.type));
  const counted = await Promise.all(
    types.map(async (t) => {
      const r = await client.run(FIND, { node_type: t.type, limit: 1, count: true });
      return { type: t.type, description: typeDescription(t.description), count: typeof r === "string" ? 0 : ((r as { total?: number }).total ?? 0) };
    }),
  );
  return orderTypes(counted);
}

export function useOntology() {
  const client = useStrutClient();
  return useQuery({ queryKey: ["knowledge", "ontology"], queryFn: () => readOntology(client), staleTime: 5 * 60_000 });
}

/** Search every domain type at once, or one (`type`); strut's own workflows, runs and jobs left out. */
export function useSearch(q: string, opts: { type?: string; limit?: number } = {}) {
  const client = useStrutClient();
  const text = q.trim();
  return useQuery({
    queryKey: ["knowledge", "search", text, opts.type ?? "", opts.limit ?? 40],
    enabled: text.length > 1,
    staleTime: 30_000,
    queryFn: async () => {
      const hits = answer<GraphHit[]>(
        "graph/graph-search",
        await client.run("graph/graph-search", { q: text, limit: opts.limit ?? 40, exclude_domains: "strut", ...(opts.type ? { type: opts.type } : {}) }),
      );
      return (hits ?? []).filter((h) => !isSystemType(h.node_type));
    },
  });
}

export interface ListedNode {
  ref_id: string;
  node_type: string;
  name: string;
  description?: string;
}

/** A type's nodes by name, a page at a time (`graph/find`'s cursor). */
export function useTypeNodes(type: string, pageSize: number) {
  const client = useStrutClient();
  return useInfiniteQuery({
    queryKey: ["knowledge", "type", type, pageSize],
    initialPageParam: undefined as string | undefined,
    staleTime: 60_000,
    queryFn: async ({ pageParam }) => {
      const r = answer<FindPage & { total?: number }>(FIND, await client.run(FIND, { node_type: type, orderBy: "name", limit: pageSize, count: true, ...(pageParam ? { cursor: pageParam } : {}) }));
      return {
        total: r.total,
        cursor: r.cursor,
        nodes: (r.nodes ?? []).map((n): ListedNode => {
          const desc = n.properties?.["description"];
          return { ref_id: n.ref_id, node_type: type, name: n.name || String(n.properties?.["name"] ?? n.ref_id.slice(0, 8)), ...(typeof desc === "string" && desc ? { description: desc } : {}) };
        }),
      };
    },
    getNextPageParam: (last) => last.cursor,
  });
}

/** A node's neighbours, grouped by how they are linked. */
export function useLinks(refId: string | null) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["knowledge", "links", refId],
    enabled: !!refId,
    staleTime: 60_000,
    queryFn: async () => groupLinks(await getNeighbors(client, refId!)),
  });
}

/** A Concept as its keeper reads it (`knowledge/page`): its claims, with what the evidence says. Null when there is
 *  no Concept of that name. Refused where the page may not read the tree's namespace: the error says so at once. */
export function usePage(name: string | undefined) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["knowledge", "page", name],
    enabled: !!name,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const r = await client.run("knowledge/page", { name });
      return typeof r === "string" ? null : (r as { ref_id: string; name: string; claims: PageClaim[] });
    },
  });
}

/** Every Concept that carries claims (`knowledge/claims`): what the page scans for the refuted ones. */
export function useClaimed() {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["knowledge", "claimed"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => answer<{ concepts?: ClaimedConcept[] }>("knowledge/claims", await client.run("knowledge/claims", {})).concepts ?? [],
  });
}

/** The changes to the tree the dream proposed that wait on a person — pending, or accepted and failed (accepted
 *  again once the cause is fixed) — each with what it would run with. An admin sees them; anyone else only their
 *  own (proposal/list). */
export function useChanges() {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["knowledge", "changes"],
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const read = (status: string) => client.run("proposal/list", { workflow: DREAM, status, input: true, limit: 200 });
      const lists = await Promise.all(["pending", "failed"].map(async (s) => answer<{ proposals?: PendingChange[] }>("proposal/list", await read(s)).proposals ?? []));
      return lists.flat();
    },
  });
}
