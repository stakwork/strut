import { createHash } from "node:crypto";
import { z } from "zod";
import { stopOf, withStop, type StepContext } from "../../../core.js";
import { triggerSchema } from "../../../automations.js";
import type { AutomationView, Automations } from "../../../scheduler.js";
import { journal, journalKey } from "../job/_shared.js";

/**
 * The `automation/*` steps: an agent's own door onto strut's automations
 * (plans/automations.md), the twin of the builder chat's `set_automation`.
 * They act on ONE workflow, the one the host names (`createStrut({
 * automation: { workflow } })`): an agent schedules its own prompts on it
 * and never touches another workflow's schedules, a system automation
 * least of all. That workflow takes `{ name, prompt, since, now }`
 * (`since`: when its last successful run finished; `now`: the fire).
 *
 * Reading and previewing never ask. Creating, changing, deleting and
 * running one first ask the person through the host's APPROVAL step
 * (`automation.approve`, a registry step type): it is handed `{ intent }`
 * and answers `{ approved, status?, error? }`, or a `withStop` output when
 * nobody has answered yet, which the automation step passes up so the turn
 * ends with nothing changed. Without an approval step the acting steps
 * refuse: an agent never schedules unattended runs on its own say.
 *
 * A host whose approval step can grant an automation more than its prompt
 * (Peel: posting as the person to chats it names, up to a price) says so
 * with `grants`. Then create and update take a `grant`, which strut never
 * reads: it goes to the approval step with the automation's grant KEY and
 * name, and the key is kept in the run's input (`input.grant`), where the
 * host's own steps read it at each fire. The key is strut's, never the
 * model's: a run's step that acts on a grant names it from `ctx.input`, and
 * the model cannot write that.
 */
export interface AutomationStepsOptions {
  /** The workflow the steps schedule. */
  workflow: string;
  /** The registry step that asks the person (`{ intent }` →
   *  `{ approved, status?, error? }`). Absent: the acting steps refuse. */
  approve?: string;
  /** The approval step takes a `grant` (`{ intent, grant }`, the grant with
   *  `automation` (its key) and `name` added): create and update offer one. */
  grants?: boolean;
}

/** `ctx.services.automations`, which `createStrut` sets. */
export interface AutomationStepsCapability extends Partial<AutomationStepsOptions> {
  api: Automations;
  /** The callback the run `runId` belongs to (its root run's), so an
   *  automation made from a turn reports where that turn does. */
  callbackOf(runId: string): Promise<{ url: string } | undefined>;
}

export function requireAutomations(services: unknown): AutomationStepsCapability & { workflow: string } {
  const cap = (services as { automations?: AutomationStepsCapability } | undefined)?.automations;
  if (!cap?.api) throw new Error("automation/* steps need strut's automations (ctx.services.automations); the standard strut server provides them.");
  if (!cap.workflow) {
    throw new Error("automation/* steps: this strut names no workflow for them to schedule (createStrut({ automation: { workflow } }), or STRUT_HOST_CONFIG's \"automation\").");
  }
  return cap as AutomationStepsCapability & { workflow: string };
}

/** What the person is asked to approve: the host's card. */
export interface Intent {
  action: string;
  content?: string;
  details?: string[];
}

/**
 * Ask the person through the host's approval step. `ok` to go ahead;
 * otherwise the output the acting step returns as it is: a `withStop`
 * pending (no answer yet), or the refusal. Nothing is changed either way.
 */
export async function approval(
  ctx: StepContext,
  cap: AutomationStepsCapability,
  intent: Intent,
  grant?: Record<string, unknown>,
): Promise<{ ok: true } | { output: unknown }> {
  if (!cap.approve) {
    throw new Error("automation/* steps: this strut has no approval step (automation.approve), so they cannot change automations.");
  }
  const def = ctx.registry?.[cap.approve];
  if (!def) throw new Error(`automation/* steps: the approval step "${cap.approve}" is not in this strut's registry.`);
  const out = await def.run(def.input.parse({ intent, ...(grant ? { grant } : {}) }), { ...ctx, path: `${ctx.path}/approve` });
  if (stopOf(out)) return { output: withStop({ changed: false, waiting: out }) };
  const answer = (out ?? {}) as { approved?: unknown; status?: unknown; error?: unknown };
  if (answer.approved === true) return { ok: true };
  return {
    output: {
      changed: false,
      status: typeof answer.status === "string" ? answer.status : "denied",
      error: typeof answer.error === "string" ? answer.error : "The person did not allow it. Do not try again unless they ask.",
    },
  };
}

/**
 * Ask, then act, once even across a resume: what the act did is journaled
 * (`journalKey`), so a resumed turn that makes the same call again gets
 * that back rather than a second automation or a second run. A pending or
 * refused approval is not journaled: asked again, it asks again (the
 * approval step's own request id makes that the same question).
 */
export async function approvedOnce<T extends object>(
  ctx: StepContext,
  cap: AutomationStepsCapability,
  intent: Intent,
  act: () => Promise<T>,
  grant?: Record<string, unknown>,
): Promise<unknown> {
  const key = journalKey(ctx, "act");
  const prior = key ? ctx.journal?.[key] : undefined;
  if (prior && typeof prior === "object") return prior;
  const asked = await approval(ctx, cap, intent, grant);
  if (!("ok" in asked)) return asked.output;
  const done = await act();
  await journal(ctx, key, done);
  return done;
}

/** An automation's `input` is a template: `{{` and `}}` in the person's
 *  words are kept apart by a zero-width space, which `unescaped` takes out
 *  again (as Peel's own client does, so either reads the other's). */
const GAP = "​";

export function escaped(text: string): string {
  let out = "";
  let last = "";
  for (const ch of text) {
    if (ch === last && (ch === "{" || ch === "}")) out += GAP;
    out += ch;
    last = ch;
  }
  return out;
}

export function unescaped(text: string): string {
  const chars = [...text];
  return chars
    .filter((ch, i) => !(ch === GAP && i > 0 && i + 1 < chars.length && chars[i - 1] === chars[i + 1] && "{}".includes(chars[i - 1]!)))
    .join("");
}

/** What the run is handed, resolved at each fire: `since`, when its last
 *  successful run finished (null before the first), `now`, the fire, and
 *  its grant's key when it has one. */
export function runInput(name: string, prompt: string, grant?: string): Record<string, unknown> {
  return { name: escaped(name), prompt: escaped(prompt), since: "{{ last.finishedAt }}", now: "{{ now }}", ...(grant ? { grant } : {}) };
}

/** An automation's grant key, kept in its input. */
export function grantOf(a: AutomationView): string | undefined {
  const key = (a.input as { grant?: unknown }).grant;
  return typeof key === "string" && key ? key : undefined;
}

/** A new grant's key: the same for the same call (a resumed one asks the
 *  same question), and another for any other. */
export function grantKey(ctx: StepContext): string {
  return "g-" + createHash("sha256").update(`${ctx.runId}\n${ctx.path}`).digest("hex").slice(0, 24);
}

/** The `grant` a host that takes one checks; any other host refuses it. */
export function grantFor(cap: AutomationStepsCapability, grant: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (grant && !cap.grants) throw new Error("automation/* steps: this strut's approval step takes no grant; leave grant out.");
  return grant;
}

/** An automation as the agent reads it. */
export function brief(a: AutomationView) {
  const input = a.input as { prompt?: unknown };
  return {
    id: a.id,
    name: a.name,
    summary: a.summary,
    enabled: a.enabled,
    nextRunAt: a.nextRunAt,
    lastRun: a.lastRun,
    running: a.running,
    prompt: typeof input.prompt === "string" ? unescaped(input.prompt) : "",
    ...(grantOf(a) ? { grant: true } : {}),
    ...(a.lastFireError ? { lastFireError: a.lastFireError } : {}),
  };
}

/** The automation `id` on the steps' workflow; any other is refused. */
export async function find(cap: AutomationStepsCapability & { workflow: string }, id: string): Promise<AutomationView> {
  const found = (await cap.api.list(cap.workflow)).find((a) => a.id === id);
  if (found) return found;
  const elsewhere = (await cap.api.list()).find((a) => a.id === id);
  if (elsewhere) throw new Error(`"${elsewhere.name}" is not one of yours to change (it runs ${elsewhere.workflow}); automation/list shows yours.`);
  throw new Error(`No automation has the id ${id}; automation/list shows them.`);
}

/** strut's sentence for a schedule and its next three fires, in its zone. */
export function schedule(summary: string, next: string[], tz: string | undefined): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(tz ? { timeZone: tz } : {}),
  });
  const fires = next.slice(0, 3).map((iso) => fmt.format(new Date(iso)));
  return summary + (fires.length ? `; next ${fires.join(", ")}` : " (no runs to come)");
}

/** A policy result's error as the step's failure. */
export function unwrap<T>(result: ({ ok: true } & T) | { error: string }): T {
  if ("error" in result) throw new Error(result.error);
  return result;
}

export const idInput = z.object({ id: z.string().min(1).describe("The automation's id, from automation/list.") });
// What a host's card shows whole: a name on one line, a prompt within a page.
export const nameField = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\n\r]*$/, "must be one line")
  .describe("A short name the person will recognise: \"Friday to-do list\".");
export const promptField = z
  .string()
  .min(1)
  .max(4000)
  .describe("The standalone instruction each run carries out. It runs with nobody watching and does not see this conversation.");
export const grantField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Only when your instructions say this strut takes one: what the automation may do beyond its prompt, shown to the person to allow with it. Leave out otherwise.");
export { triggerSchema };
