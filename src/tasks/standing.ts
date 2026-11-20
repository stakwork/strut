/**
 * A standing type's workflow (plans/human-steps.md §5.7, item 9): what a
 * worker's pick-up is made of, read off the workflow alone, before any run.
 *
 * Its FIRST step is the type's `human` step: the task a worker picks up is
 * that step's, keyed by the workflow, a run id chosen at the pick-up and the
 * step's path, so the run launched once they answer finds it answered and
 * goes on. Its `show` is resolved with the workflow's input defaults and
 * params, which is all a run started with no input has at its first step.
 */
import type { Flow } from "../core.js";
import { exprRoots, resolveConfig, templateExprs } from "../expr.js";
import type { StandingTask } from "./tasks.js";

/** What `show` may read: a run's first step has nothing else yet. */
const SHOW_ROOTS = new Set(["input", "params"]);

/** The pick-up `flow` makes for task type `type`, or why it cannot. */
export function standingTask(flow: Flow, type: string): StandingTask | { problem: string } {
  const first = flow.steps[0];
  if (!first) return { problem: `workflow ${flow.name} has no steps; its first step must be the human step of task type ${type}` };
  if (first.type !== "human") return { problem: `workflow ${flow.name} starts with ${first.id} (${first.type}); a standing workflow's first step is the human step of task type ${type}` };
  const cfg = first.config ?? {};
  if (cfg["task"] !== type) return { problem: `workflow ${flow.name}'s first step, ${first.id}, asks for task type ${JSON.stringify(cfg["task"])}, not ${type}` };
  const deps = first.depends === undefined ? [] : [first.depends].flat();
  if (deps.length) return { problem: `workflow ${flow.name}'s first step, ${first.id}, waits on ${deps.join(", ")}; a standing workflow's human step runs first` };
  const files = cfg["files"];
  if (files !== undefined && !(Array.isArray(files) && files.length === 0)) {
    return { problem: `workflow ${flow.name}'s human step names files, and no run has files when a worker picks a standing task up` };
  }
  let reads: string[];
  try {
    reads = rootsOf(cfg["show"]).filter((r) => !SHOW_ROOTS.has(r));
  } catch (err) {
    return { problem: `workflow ${flow.name}'s human step's show does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (reads.length) return { problem: `workflow ${flow.name}'s human step shows ${reads.join(", ")}; a standing task's show reads only input and params` };
  let input: unknown;
  try {
    input = flow.input.parse({});
  } catch {
    return { problem: `workflow ${flow.name} needs input it has no default for; each answer starts it with none` };
  }
  let show: unknown;
  try {
    show = resolveConfig(cfg["show"] ?? null, { input, params: flow.params ?? {} });
  } catch (err) {
    return { problem: `workflow ${flow.name}'s human step's show does not resolve: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { path: `${flow.name}/${first.id}`, show };
}

/** Every scope root a config's templates read. */
function rootsOf(v: unknown): string[] {
  if (typeof v === "string") return templateExprs(v).flatMap((e) => exprRoots(e));
  if (Array.isArray(v)) return v.flatMap(rootsOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(rootsOf);
  return [];
}
