/**
 * What adding an item to the PUBLIC VIEW brings along (plans/public-surface.md
 * §2, "The dialog cascades, in the open"; decision 20): the Public view
 * dialog asks before it saves, and pre-checks what the item needs to be
 * read, each line with what it exposes. The record it then saves names
 * everything, so a later release that grants one more workflow never widens
 * the public view by itself.
 *
 * - An APP: the workflows it grants, WITH their runs (the page reads them);
 *   the custom steps those workflows and their subflows run; the app's own
 *   granted reads (§5's `reads`); the Concept roots its workflows read.
 * - A WORKFLOW: its custom steps and its Concept roots; its runs unchecked
 *   (a person opens them on purpose).
 *
 * A workflow names a root with `context/concept { name }`: a literal, or a
 * `{{ params.X }}` read off the flow's own params (the way `closure.ts`
 * reads a `{{ params.tools }}` grant). A name taken from the run's input is
 * chosen per run; it is said, not guessed — the pages a public run did read
 * are visible through the run anyway (§4).
 */
import type { StepRegistry } from "./core.js";
import type { WorkspaceStore } from "./workspace.js";
import { flowClosure, globToRegExp, walkSteps } from "./closure.js";
import type { PublicConceptTree } from "./public-surface.js";
import { VISITOR_GRAPH_READS, VISITOR_RUN_READS } from "./public-surface.js";

/** One line of the dialog's cascade: what it is, whether it starts checked,
 *  and what adding it shows anyone. */
export interface NeedLine {
  name: string;
  checked: boolean;
  note: string;
}

export interface PublicViewNeeds {
  app?: { name: string; version: string; title: string };
  workflow?: string;
  workflows: Array<NeedLine & { runs: boolean }>;
  steps: NeedLine[];
  reads: NeedLine[];
  concepts: Array<NeedLine & { pages: number; from: string[]; missing?: true }>;
  /** What could not be known before a run: a Concept named by the input. */
  perRun: string[];
}

export interface PublicViewDeps {
  workspace: Pick<WorkspaceStore, "getWorkflow" | "getWorkflowVersion">;
  registry: () => StepRegistry;
  stepSources: () => Record<string, string>;
  /** The app's manifest at the version the public view would serve. */
  app?: (name: string) => Promise<{ version: string; title: string; grants: { workflows: string[]; steps: string[] } } | null>;
  walk: (roots: string[]) => Promise<PublicConceptTree>;
}

/** Steps whose reads reach a service outside this server, by namespace:
 *  what the dialog says about them. */
const OUTSIDE: Array<[prefix: string, what: string]> = [
  ["sheets/", "Google Sheets"],
  ["gdrive/", "Google Drive"],
  ["github/", "GitHub"],
  ["slack/", "Slack"],
  ["x/", "X"],
];

const RUNS_NOTE = "every run, whole: its input, outputs, agents' transcripts and files";
const DEFINITION_NOTE = "its definition and versions";
const STEP_NOTE = "its schema, its source and the helpers it imports";

function readNote(type: string, custom: boolean): string {
  const out = OUTSIDE.find(([p]) => type.startsWith(p));
  if (out) return `calls ${out[1]} with this server's credentials: anything that account can open, by id, a visitor's page can read`;
  if (custom) return "this server's own code, run with reads only (no graph writes, no shell, no files); it may still call outside services with this server's secrets";
  return "a read of this server";
}

const PARAM_REF = /^\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/** The Concept roots one flow's `context/concept` steps name, and the names
 *  only a run decides. */
function conceptRootsOf(flow: { steps: unknown[]; params?: Record<string, unknown> }): { roots: string[]; perRun: string[] } {
  const roots: string[] = [];
  const perRun: string[] = [];
  walkSteps(flow.steps as never, (s) => {
    if (s.type !== "context/concept") return;
    const name = (s.config as Record<string, unknown> | undefined)?.["name"];
    if (typeof name !== "string" || !name) return;
    if (!name.includes("{{")) return void roots.push(name);
    const ref = name.match(PARAM_REF);
    const v = ref ? flow.params?.[ref[1]!] : undefined;
    if (typeof v === "string" && v && !v.includes("{{")) roots.push(v);
    else perRun.push(name);
  });
  return { roots, perRun };
}

/** What adding `app` or `workflow` to the public view brings along. */
export async function publicViewNeeds(deps: PublicViewDeps, q: { app?: string; workflow?: string }): Promise<PublicViewNeeds | { error: string }> {
  const registry = deps.registry();
  const sources = deps.stepSources();
  const isCustom = (t: string) => sources[t] === "custom";
  const out: PublicViewNeeds = { workflows: [], steps: [], reads: [], concepts: [], perRun: [] };
  let workflows: string[];
  let runs: boolean;
  if (q.app) {
    const app = deps.app ? await deps.app(q.app) : null;
    if (!app) return { error: `no app "${q.app}" on this strut server` };
    out.app = { name: q.app, version: app.version, title: app.title };
    workflows = app.grants.workflows;
    runs = true;
    for (const type of app.grants.steps) {
      // A page reaches runs and the graph through the public view's own
      // rules (§5): nothing to tick for those, nor for a step no visitor
      // may call whatever is ticked.
      // (Launching, a job, a graph write, a paid step: refused to a visitor
      // whatever is ticked, `visitorRefusal`.)
      if (VISITOR_RUN_READS.has(type) || VISITOR_GRAPH_READS.has(type) || /^(?:run|app|job|graph)\//.test(type) || ["llm", "agent", "exec", "acp/prompt"].includes(type)) continue;
      const def = registry[type];
      const custom = isCustom(type);
      out.reads.push({ name: type, checked: def?.effect === "read", note: def ? readNote(type, custom) : "not a step on this server" });
    }
  } else if (q.workflow) {
    workflows = [q.workflow];
    out.workflow = q.workflow;
    runs = false;
  } else {
    return { error: "name an app (?app=) or a workflow (?workflow=)" };
  }

  const roots = new Map<string, Set<string>>();
  const steps = new Set<string>();
  const seenFlows = new Set<string>();
  for (const name of workflows) {
    let flow;
    try {
      flow = await deps.workspace.getWorkflow(name);
    } catch {
      out.workflows.push({ name, runs, checked: false, note: "not a workflow on this strut server" });
      continue;
    }
    out.workflows.push({ name, runs, checked: true, note: runs ? `${DEFINITION_NOTE}, and ${RUNS_NOTE}` : `${DEFINITION_NOTE} (its runs only if you open them)` });
    const closure = await flowClosure(flow, deps.workspace as never);
    for (const t of closure.types) if (isCustom(t)) steps.add(t);
    for (const g of closure.agentTools) {
      const re = g.includes("*") ? globToRegExp(g) : undefined;
      for (const t of re ? Object.keys(registry).filter((k) => re.test(k)) : [g]) if (isCustom(t)) steps.add(t);
    }
    // The flow and every subflow it reaches, each with its own params.
    const flows = [{ name, flow }];
    for (const child of closure.workflows) {
      try {
        flows.push({ name: child.workflow, flow: child.version ? await deps.workspace.getWorkflowVersion(child.workflow, child.version) : await deps.workspace.getWorkflow(child.workflow) });
      } catch {
        // a subflow that is gone: its roots are unknown
      }
    }
    for (const f of flows) {
      if (seenFlows.has(f.name)) continue;
      seenFlows.add(f.name);
      const found = conceptRootsOf(f.flow as never);
      for (const r of found.roots) (roots.get(r) ?? roots.set(r, new Set()).get(r)!).add(f.name);
      for (const p of found.perRun) out.perRun.push(`${f.name}: a Concept named per run (${p})`);
    }
  }
  out.steps = [...steps].sort().map((t) => ({ name: t, checked: true, note: STEP_NOTE }));
  for (const [root, from] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    const tree = await deps.walk([root]);
    const missing = tree.missing.includes(root);
    out.concepts.push({
      name: root,
      checked: !missing,
      pages: tree.concepts.length,
      from: [...from].sort(),
      note: missing ? "no Concept of that name in this server's graph" : `the root and every page under it (${tree.concepts.length}), live`,
      ...(missing ? { missing: true as const } : {}),
    });
  }
  return out;
}
