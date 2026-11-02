// The gallery's client: the steps the components call, answered from the
// fixtures — so every component draws as it would against a strut, with no
// grant and no run. A launch is remembered by its key, as `run/launch` is.
import type { StrutClient } from "@strut/kit";
import { FILES, TRANSCRIPT } from "./content";
import { getBatched, neighbors, search } from "./graph";
import { CHILD_EVENTS, CHILD_RUN_ID, EXPLORE_PATH, RUNS, RUN_EVENTS, RUN_ID, WORKFLOW_INFO } from "./runs";
import { REPORT_EVENTS, REPORT_RUN_ID } from "./report";
import { TRACE_EVENTS, TRACE_LIVE_RUN_ID, TRACE_RUN_ID, traceTranscript } from "./trace";
import { COVENANT_SHEET, NDA_FRAMES, NDA_SHEET, NDA_WORKFLOW, SHEET_FILES, covenantSheet, ndaFrame, ndaPlaybook, ndaRun } from "./sheets";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFixtureClient(): StrutClient {
  const launched = new Map<string, string>();
  let next = 1790000001000;
  // The live run: each read of its log reveals a little more, as a run in
  // flight would have written; read from the start, it starts over.
  let revealed = 0;
  const liveLog = (skip: number) => {
    if (skip === 0) revealed = 12;
    revealed = Math.min(TRACE_EVENTS.length, revealed + 9);
    return TRACE_EVENTS.slice(0, revealed);
  };
  // The NDA review: each read of its matrix finds one more provision written,
  // until the run ends; launching it again starts the matrix over.
  const nda = { runId: "", reads: 0 };
  const ndaDone = () => nda.reads >= NDA_FRAMES;
  const sheet = (c: Record<string, unknown>) => {
    const range = String(c["range"] ?? "");
    if (c["spreadsheet_id"] === COVENANT_SHEET) return covenantSheet(range);
    if (c["spreadsheet_id"] !== NDA_SHEET) return `sheets_get_values failed: HTTP 404: Requested entity was not found.`;
    if (/^'?Playbook'?(!|$)/.test(range)) return ndaPlaybook();
    return ndaFrame(Math.min(NDA_FRAMES - 1, nda.reads++));
  };
  const answer = (type: string, c: Record<string, unknown>): unknown => {
    switch (type) {
      case "run/list":
        return RUNS.filter((r) => r.workflow === c["workflow"]).slice(0, Number(c["limit"] ?? 50));
      case "run/get":
        if (c["runId"] === nda.runId) return ndaRun(nda.runId, ndaDone());
        return RUNS.find((r) => r.runId === c["runId"]) ?? null;
      case "run/events": {
        const skip = Number(c["skip"] ?? 0);
        if (c["runId"] === RUN_ID) return RUN_EVENTS.slice(skip);
        if (c["runId"] === CHILD_RUN_ID) return CHILD_EVENTS.slice(skip);
        if (c["runId"] === REPORT_RUN_ID) return REPORT_EVENTS.slice(skip);
        if (c["runId"] === TRACE_RUN_ID) return TRACE_EVENTS.slice(skip);
        if (c["runId"] === TRACE_LIVE_RUN_ID) return liveLog(skip).slice(skip);
        throw new Error(`no run ${String(c["runId"])}`);
      }
      case "run/workflow":
        return WORKFLOW_INFO;
      case "run/launch": {
        const key = typeof c["key"] === "string" ? c["key"] : undefined;
        const existing = key ? launched.get(key) : undefined;
        if (existing) return { runId: existing, existing: true };
        const runId = String(next++);
        if (key) launched.set(key, runId);
        if (c["workflow"] === NDA_WORKFLOW) Object.assign(nda, { runId, reads: 0 });
        return { runId };
      }
      case "run/cancel":
        return { ok: true };
      case "run/files":
        return FILES[String(c["path"])] ?? SHEET_FILES[String(c["path"])] ?? null;
      case "run/transcript": {
        if (c["runId"] === RUN_ID && c["path"] === EXPLORE_PATH) return { path: EXPLORE_PATH, messages: TRANSCRIPT };
        const live = c["runId"] === TRACE_LIVE_RUN_ID;
        const messages = c["runId"] === TRACE_RUN_ID || live ? traceTranscript(String(c["path"]), live ? TRACE_EVENTS.slice(0, revealed) : undefined) : undefined;
        if (messages) return { path: c["path"], messages };
        throw new Error(`No transcript at "${String(c["path"])}" in run "${String(c["runId"])}"`);
      }
      case "graph/graph-get-batched":
        return getBatched((c["ref_ids"] as string[]) ?? []);
      case "graph/graph-neighbors":
        return neighbors(String(c["ref_id"]), c["edge_type"] as string[] | undefined);
      case "sheets/get-values":
        return sheet(c);
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
