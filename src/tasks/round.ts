/**
 * A ROUND type's workflow (Tasks and workers' Send a round): the workflow
 * whose run makes one task of the type for each item — a `human` step of the
 * type, usually the body of a `foreach` over the run's list. Read off the
 * workflow alone, before any run: whether it can make tasks of the type, and
 * the ITEMS a round sends — its first `json` input whose default is a list,
 * each item labelled by its text fields, so staff can send all or some.
 */
import type { Flow } from "../core.js";
import { resolveConfig } from "../expr.js";

/** One item a round can send: the value as the workflow takes it, and how a
 *  person reads it ("Bean There – 412 Main St"). */
export interface RoundItem {
  label: string;
  value: unknown;
}

/** What a round sends: the input it fills (`input`, the field's name) and
 *  its default items. None when the workflow has no such list: a round
 *  then runs with no input, its defaults deciding what goes out. */
export interface RoundItems {
  input?: string;
  items: RoundItem[];
}

/** Why `flow` cannot make tasks of `type`, or undefined: it has a `human`
 *  step asking for that type, at any depth (a `foreach`'s body included).
 *  A task named by a template is resolved with the workflow's input
 *  defaults and params, as a run with no input starts. */
export function roundProblem(flow: Flow, type: string): string | undefined {
  let input: unknown = {};
  try {
    input = flow.input.parse({});
  } catch {
    // A workflow whose input has no default for everything: its task names
    // are read with nothing for input.
  }
  const scope = { input, params: flow.params ?? {} };
  const asks = humanTasks(flow.steps, scope);
  if (asks.includes(type)) return undefined;
  return asks.length
    ? `workflow ${flow.name}'s human steps ask for ${asks.map((a) => JSON.stringify(a)).join(", ")}, not ${type}`
    : `workflow ${flow.name} has no human step: a round of ${type} is a run whose human step makes one task for each item`;
}

/** The task types `human` steps in `v` ask for, at any depth. */
function humanTasks(v: unknown, scope: Record<string, unknown>): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => humanTasks(x, scope));
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  if (o["type"] === "human" && o["config"] && typeof o["config"] === "object") {
    const task = (o["config"] as Record<string, unknown>)["task"];
    let name: unknown = task;
    try {
      name = resolveConfig(task, scope);
    } catch {
      // A template that needs the run (`$current`): not one we can read.
    }
    if (typeof name === "string" && name) out.push(name);
  }
  for (const x of Object.values(o)) out.push(...humanTasks(x, scope));
  return out;
}

/** The items a round of `flow` sends by default: its first `json` input
 *  whose default is a list (`input:` order). */
export function roundItems(flow: Flow): RoundItems {
  for (const [name, field] of Object.entries(flow.inputBlock ?? {})) {
    if (field.type !== "json" || !Array.isArray(field.default)) continue;
    return { input: name, items: field.default.map((value, i) => ({ label: itemLabel(value, i), value })) };
  }
  return { items: [] };
}

/** An item as a person reads it: a text item itself; an object's text and
 *  number fields joined ("Bean There – 412 Main St"); else its place. */
export function itemLabel(value: unknown, i: number): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const parts = Object.values(value as Record<string, unknown>)
      .filter((x): x is string | number => (typeof x === "string" && !!x.trim()) || typeof x === "number")
      .map((x) => String(x).trim());
    if (parts.length) return parts.join(" – ");
  }
  return `Item ${i + 1}`;
}
