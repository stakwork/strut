/**
 * What a package's build SUGGESTS beyond what was named (the package page
 * offers each as one click; nothing is added by itself):
 *
 *   - GRAPH TYPES the picked workflows' runs wrote: every graph step that
 *     touches nodes reports them on its `step.end` as `nodes`, an agent's
 *     tool calls included (`tool:graph/…`), so a run's log says which types
 *     its WRITE steps wrote. Read off the last few successful runs of each
 *     workflow.
 *   - CONCEPT ROOTS: the pages `context/concept` read in those runs, and the
 *     page names written literally in the workflows' `context/concept`
 *     steps — each climbed to the top of its tree, since naming a page in a
 *     build brings every page under it. The climb stops below a page the
 *     package could not carry (strut's own, another package's).
 *
 * A finished run's log never changes, so what each run says is kept for the
 * life of the run store.
 */
import type { RunEvent } from "../core.js";
import { findConcept } from "../concept-seed.js";
import type { GraphBackend } from "../graph/backend.js";
import { SEED_TYPES } from "../graph/seed-types.js";
import { THING_TYPE, isStrutType } from "../graph/strut-schemas.js";
import { hasTemplates } from "../expr.js";
import type { RunStore } from "../store.js";

/** The graph steps that write the nodes they report (the rest read). */
const GRAPH_WRITES = new Set([
  "graph/create-node",
  "graph/create-triplet",
  "graph/create-batch-triplet",
  "graph/edit-node",
  "graph/edit-edge",
  "graph/assert",
  "graph/merge",
  "graph/move-node",
  "graph/restore-node",
]);
const CONCEPT_STEP = "context/concept";

/** How many successful runs of a workflow are read, and how many run ids
 *  are looked at to find them. */
const RUNS_READ = 5;
const RUNS_SCANNED = 20;

export interface Suggested {
  types: string[];
  concepts: string[];
}

interface RunReading {
  types: string[];
  concepts: string[];
}

/** Per run store: a finished run's log never changes. */
const readingsOf = new WeakMap<object, Map<string, RunReading>>();
const READINGS_MAX = 1000;

/** What one finished run wrote and read: its write steps' node types, the
 *  pages its `context/concept` steps read. */
export function readRun(events: readonly RunEvent[]): RunReading {
  const types = new Set<string>();
  const concepts = new Set<string>();
  for (const e of events) {
    if (e.type !== "step.end" || !e.nodes?.length || !e.stepType) continue;
    const step = e.stepType.replace(/^tool:/, "");
    for (const n of e.nodes) {
      if (n.peer) continue;
      if (GRAPH_WRITES.has(step) && n.node_type) types.add(n.node_type);
      if (step === CONCEPT_STEP && n.node_type === "Concept" && n.name) concepts.add(n.name);
    }
  }
  return { types: [...types], concepts: [...concepts] };
}

export interface SuggestDeps {
  runs?: Pick<RunStore, "listRuns" | "getRunSummary" | "getRunEvents">;
  graph?: GraphBackend;
}

/**
 * The suggestions for a build of `workflows` (names as they are here), whose
 * closures ran `steps`. `known` types and pages are left out: the ones named
 * already, and what a required package carries.
 */
export async function suggest(
  deps: SuggestDeps,
  workflows: readonly string[],
  steps: ReadonlyArray<{ type: string; config?: unknown }>,
  known: { types: ReadonlySet<string>; concepts: ReadonlySet<string>; conceptStamp: (stamp: string) => boolean },
): Promise<Suggested> {
  const types = new Set<string>();
  const pages = new Set<string>();
  for (const s of steps) {
    const name = (s.config as { name?: unknown } | undefined)?.name;
    if (s.type === CONCEPT_STEP && typeof name === "string" && name && !hasTemplates(name)) pages.add(name);
  }
  if (deps.runs) {
    let readings = readingsOf.get(deps.runs);
    if (!readings) readingsOf.set(deps.runs, (readings = new Map()));
    for (const workflow of workflows) {
      let read = 0;
      for (const runId of (await deps.runs.listRuns(workflow).catch(() => [])).slice(0, RUNS_SCANNED)) {
        if (read >= RUNS_READ) break;
        const summary = await deps.runs.getRunSummary(workflow, runId).catch(() => null);
        if (summary?.status !== "success") continue;
        read++;
        const key = `${workflow}\u0000${runId}`;
        let r = readings.get(key);
        if (!r) {
          r = readRun(await deps.runs.getRunEvents(workflow, runId));
          if (readings.size >= READINGS_MAX) readings.delete(readings.keys().next().value!);
          readings.set(key, r);
        }
        for (const t of r.types) types.add(t);
        for (const c of r.concepts) pages.add(c);
      }
    }
  }
  const seed = new Set(SEED_TYPES.map((s) => s.type.toLowerCase()));
  const taken = new Set([...known.types].map((t) => t.toLowerCase()));
  const outTypes = [...types].filter((t) => t !== THING_TYPE && !isStrutType(t) && !seed.has(t.toLowerCase()) && !taken.has(t.toLowerCase()));
  const roots = new Set<string>();
  if (deps.graph && pages.size) {
    for (const page of pages) {
      const root = await rootOf(deps.graph, page, known.conceptStamp);
      if (root && !known.concepts.has(root)) roots.add(root);
    }
  }
  return { types: outTypes.sort(), concepts: [...roots].sort() };
}

/** The top of `name`'s tree, climbing `PARENT_OF` while the parent is one a
 *  package could carry (no stamp, or one `mine` accepts). Null when the page
 *  itself is not one, or is not in the graph. */
async function rootOf(graph: GraphBackend, name: string, mine: (stamp: string) => boolean): Promise<string | null> {
  const schema = await graph.schemas.schema("Concept");
  if (!schema) return null;
  const node = await findConcept(graph, schema, name);
  const carriable = (stamp: unknown) => typeof stamp !== "string" || mine(stamp);
  if (!node || node.deleted || !carriable(node.unique_source_id)) return null;
  let at = { ref: node.ref_id, name };
  const seen = new Set([at.ref]);
  for (;;) {
    const parent = await graph.tx(async (tx) => {
      const edges = await graph.edgeEngine.liveEdgesOf(tx, at.ref, "PARENT_OF", false);
      const raws = await Promise.all((edges?.edges ?? []).map((e) => graph.nodeEngine.readRaw(tx, e.other)));
      // The first parent by name, as the build keeps a top page's.
      return raws
        .filter((r) => r && typeof r.props["name"] === "string")
        .map((r) => ({ ref: r!.ref_id, name: r!.props["name"] as string, stamp: r!.props["unique_source_id"] }))
        .sort((a, b) => a.name.localeCompare(b.name))[0];
    });
    if (!parent || seen.has(parent.ref) || !carriable(parent.stamp)) return at.name;
    seen.add(parent.ref);
    at = { ref: parent.ref, name: parent.name };
  }
}
