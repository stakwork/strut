import type { StepContext } from "./host.js";

/** A step type → the name the agent step gives its tool. */
export const toolNameFor = (type: string): string => type.replace(/[^a-zA-Z0-9_]/g, "_");

/** Steps that act on the world or write what outlives the run: a placeholder the model made up
 *  must not reach them. A step def says so itself with `sideEffects: true` (or `effect: "write"`). */
export const SIDE_EFFECT_STEPS = [
  "sphinx/send", "sphinx/post", "sphinx/approve",
  "memory/remember", "memory/merge", "memory/forget", "memory/attributes",
  "automation/create", "automation/update", "automation/delete",
  "job/start", "strut/run-workflow",
];
const SIDE_EFFECT_TOOLS = new Set(SIDE_EFFECT_STEPS.map(toolNameFor));

function defOf(name: string, ctx: StepContext | undefined): Record<string, any> | undefined {
  const reg = ctx?.registry as Record<string, any> | undefined;
  if (!reg) return undefined;
  for (const [type, def] of Object.entries(reg)) if (toolNameFor(type) === name) return def;
  return undefined;
}

export function isSideEffecting(name: string, ctx: StepContext | undefined): boolean {
  if (SIDE_EFFECT_TOOLS.has(name)) return true;
  const d = defOf(name, ctx);
  return d?.sideEffects === true || d?.effect === "write";
}

/** `privacy: keep` on a step def: the tool keeps the pseudonyms the model wrote. */
export const keepsPseudonyms = (name: string, ctx: StepContext | undefined): boolean => defOf(name, ctx)?.privacy === "keep";
