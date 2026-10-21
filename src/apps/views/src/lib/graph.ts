// The graph read hooks strut/views' components share — react-query over the
// three steps in ./graph-steps.ts.
import { useQuery } from "@tanstack/react-query";
import { useStrutClient } from "@strut/kit";
import { answer, getNeighbors, getNodes, SEARCH, GET_BATCHED, NEIGHBORS, type GraphHit } from "./graph-steps";

export * from "./graph-steps";

export function useNode(refId: string | undefined) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["strut", GET_BATCHED, refId],
    queryFn: async () => {
      const n = (await getNodes(client, [refId!])).get(refId!);
      if (!n) throw new Error(`no node ${refId}`);
      if ("error" in n) throw new Error(n.error);
      return n;
    },
    enabled: !!refId,
    staleTime: 60_000,
  });
}

export function useNeighbors(refId: string | undefined, opts: { edgeTypes?: string[]; nodeTypes?: string[] } = {}) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["strut", NEIGHBORS, refId, opts.edgeTypes ?? [], opts.nodeTypes ?? []],
    queryFn: () => getNeighbors(client, refId!, opts),
    enabled: !!refId,
    staleTime: 60_000,
  });
}

export function useGraphSearch(q: string, opts: { type?: string; limit?: number } = {}) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["strut", SEARCH, q, opts.type ?? "", opts.limit ?? 10],
    queryFn: async () => answer<GraphHit[]>(SEARCH, await client.run(SEARCH, { q, limit: opts.limit ?? 10, ...(opts.type ? { type: opts.type } : {}) })),
    enabled: q.trim().length > 1,
    staleTime: 30_000,
  });
}
