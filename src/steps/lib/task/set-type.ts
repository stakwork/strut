import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { typeCard, typeChangeInput } from "../../../tasks/set-type.js";

/**
 * The builder ASKS for a task type; an ADMIN says yes (plans/human-steps.md
 * §9.8, ruled §9.12). The builder writes the workflow with the `human` step
 * and the worker app, so it is the one that knows a type is needed. It may
 * ask for one; it may not make one. The step runs ONLY as a proposal an
 * admin accepted (`ctx.proposal`, `approver: "admin"`), as `package/install`
 * and `remote/buy-credit` do: a direct tool call, a workflow's step,
 * `meta/run-step` or a subflow is refused, and the door behind it
 * (`ctx.services.taskTypes.save`, src/tasks/set-type.ts) checks the
 * accepted record on disk for this name and this input, so a forged
 * `ctx.proposal` opens nothing.
 *
 * Its input is merged over the type when there is one, so a field left out
 * keeps its value; a new type needs `answer`. It grants no worker, deletes
 * no type and changes no worker: those are a person's, in `strut/staff`.
 * Only the `builder` seed grants it (not `job`, not `orchestrator`, not the
 * builder chat, which has no proposals).
 *
 * The CARD (`describe`) says what the type would be: the app that draws it
 * (a danger when it is missing or does not grant task/next and task/submit),
 * the answer one line per field, lease, expiry, on or off, for a change each
 * field before and after, its open tasks and workers, its pay in sats and
 * dollars with what the last week's answers would have cost (a rise is a
 * danger), and its tests and copies settings. It reads no test: no expected
 * answer is on it.
 */
export default defineStep({
  type: "task/set-type",
  effect: "write",
  approver: "admin",
  description:
    "Ask an admin to make or change a TASK TYPE — what a workflow's `human` step names: the app that draws its tasks, the answer's shape, lease, expiry, on or off, pay, tests and copies. " +
    "The call becomes a proposal an ADMIN of this strut server approves on a card that shows the type, what changes, its workers and its pay; strut saves it when they accept, and tells you the result on a later turn. " +
    "Read task/types first: an existing name is CHANGED, the fields you leave out kept as they are; a new name needs `answer`. The app must grant task/next and task/submit. " +
    "It grants the type to no worker — an admin does, in Tasks and workers (strut/staff); say so in your reply. Put the reason in `rationale`, in the person's terms. " +
    "Never saves on its own: a direct call is refused. When the person is not an admin, the call is refused (admin_required:) — tell them an admin makes task types, and to ask one.",
  input: typeChangeInput,
  output: z.any(),
  async describe(cfg, ctx: StepContext<StrutCapabilities>) {
    const cap = ctx.services?.taskTypes;
    if (!cap) return typeCard(cfg);
    const [types, appProblem, usdPerBtc] = await Promise.all([cap.list().catch(() => []), cap.appProblem(cfg.app).catch(() => undefined), cap.usdPerBtc().catch(() => undefined)]);
    const existing = types.find((t) => t.name === cfg.name);
    return typeCard(cfg, { ...(existing ? { existing } : {}), ...(appProblem ? { appProblem } : {}), ...(usdPerBtc ? { usdPerBtc } : {}) });
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.proposal) {
      throw new Error(
        "task/set-type runs only as a proposal an admin accepted: a task type decides what workers are paid and shown, and an admin decides that, never a tool call. " +
          "Ask for it as a tool call the person approves (the agent's approve: list names it); a workflow step, meta/run-step or a subflow cannot reach it.",
      );
    }
    const door = ctx.services?.taskTypes;
    if (!door) throw new Error("task/set-type needs strut's task types door (ctx.services.taskTypes); the standard strut server provides it.");
    const { name, ...change } = cfg;
    return { type: await door.save(name, change, { proposal: ctx.proposal.id, ...(ctx.actor ? { actor: ctx.actor } : {}) }) };
  },
});
