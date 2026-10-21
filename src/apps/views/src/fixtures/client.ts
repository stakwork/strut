// The gallery's client: the steps the components call, answered from the
// fixtures — so every component draws as it would against a strut, with no
// grant and no run. A launch is remembered by its key, as `run/launch` is.
import type { StrutClient } from "@strut/kit";
import { FILES, TRANSCRIPT } from "./content";
import { getBatched, neighbors, search } from "./graph";
import { CHILD_EVENTS, CHILD_RUN_ID, EXPLORE_PATH, RUNS, RUN_EVENTS, RUN_ID, WORKFLOW_INFO } from "./runs";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFixtureClient(): StrutClient {
  const launched = new Map<string, string>();
  let next = 1790000001000;
  const answer = (type: string, c: Record<string, unknown>): unknown => {
    switch (type) {
      case "run/list":
        return RUNS.filter((r) => r.workflow === c["workflow"]).slice(0, Number(c["limit"] ?? 50));
      case "run/get":
        return RUNS.find((r) => r.runId === c["runId"]) ?? null;
      case "run/events":
        if (c["runId"] === RUN_ID) return RUN_EVENTS;
        if (c["runId"] === CHILD_RUN_ID) return CHILD_EVENTS;
        throw new Error(`no run ${String(c["runId"])}`);
      case "run/workflow":
        return WORKFLOW_INFO;
      case "run/launch": {
        const key = typeof c["key"] === "string" ? c["key"] : undefined;
        const existing = key ? launched.get(key) : undefined;
        if (existing) return { runId: existing, existing: true };
        const runId = String(next++);
        if (key) launched.set(key, runId);
        return { runId };
      }
      case "run/cancel":
        return { ok: true };
      case "run/files":
        return FILES[String(c["path"])] ?? null;
      case "run/transcript":
        if (c["runId"] === RUN_ID && c["path"] === EXPLORE_PATH) return { path: EXPLORE_PATH, messages: TRANSCRIPT };
        throw new Error(`No transcript at "${String(c["path"])}" in run "${String(c["runId"])}"`);
      case "graph/graph-get-batched":
        return getBatched((c["ref_ids"] as string[]) ?? []);
      case "graph/graph-neighbors":
        return neighbors(String(c["ref_id"]), c["edge_type"] as string[] | undefined);
      case "graph/graph-search":
        return search(String(c["q"] ?? ""), c["type"] as string | undefined, Number(c["limit"] ?? 10));
      default:
        throw new Error(`"${type}" is not in the gallery's fixtures`);
    }
  };
  return {
    async run<T>(type: string, config: Record<string, unknown> = {}): Promise<T> {
      await pause(120);
      return answer(type, config) as T;
    },
  };
}
