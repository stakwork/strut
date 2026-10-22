import { z } from "zod";
import { defineStep } from "../../../core.js";
import { AI_PUBLISHER } from "../../../authoring.js";
import { automationInputSchema, triggerSchema } from "../../../automations.js";
import { brief, unwrap, type AutomationStepsCapability } from "../automation/_shared.js";
import { requireAuthoring } from "./_shared.js";

/**
 * Schedule a workflow the AI published (stakwork/peel
 * docs/connectors-and-authoring.md §6): the builder job's twin of the chat
 * builder's `set_automation`, held to two rules the chat's is not.
 *
 *   - Only a workflow stamped `publisher: ai` — never a seeded one, a
 *     host's or a person's, whose schedules are theirs.
 *   - Only as a proposal a person accepted (`ctx.proposal`): a direct tool
 *     call, a DAG step, `meta/run-step` or a subflow is refused. The host
 *     lists it in the agent's `approve:` (the builder's delta), so the call
 *     becomes a proposal, and strut runs it on accept.
 *     A proposal of it waits for a pending `meta/publish-workflow` of the
 *     same workflow (`after`): the schedule applies after its publish.
 *
 * Its fires' `run.end` go where the run that proposed it reports (its root
 * run's callback), when it has one; else the host points them.
 */
export default defineStep({
  type: "meta/set-automation",
  description:
    "Schedule a workflow you published: create an automation on it, or (with `id`) change one — only the fields you pass change; " +
    "pause with { id, enabled: false }; delete with { id, remove: true }. Only on workflows published through meta/publish-workflow " +
    "(publisher 'ai'), never a seeded or a person's workflow. It runs only on the person's yes: where this strut gates it, the call " +
    "becomes a proposal, applied when they accept it (after the publish of that workflow if that is waiting too); where it does not, " +
    "it is refused and you tell the person to schedule it themselves. Returns the automation and its next fires.",
  input: z.object({
    workflow: z.string().min(1).describe("A workflow you published (meta/publish-workflow)."),
    id: z.string().optional().describe("An existing automation's id on that workflow, to change or remove it. Omit to create."),
    name: z.string().trim().min(1).max(100).optional().describe("Short human label, e.g. 'Weekly YouTube top 5'. Required to create."),
    trigger: triggerSchema.optional().describe("WHEN it runs. Required to create. " + (triggerSchema.description ?? "")),
    input: automationInputSchema.optional(),
    enabled: z.boolean().optional().describe("false = paused. Default true."),
    remove: z.literal(true).optional().describe("Delete the automation `id`."),
  }),
  output: z.any(),
  after: (cfg, pending) => pending.step === "meta/publish-workflow" && (pending.input as { name?: unknown } | null)?.name === cfg.workflow,
  async run(cfg, ctx) {
    // A person's yes, positively: never a direct tool call, a DAG step,
    // meta/run-step or a subflow.
    if (!ctx.proposal) {
      throw new Error(
        "meta/set-automation runs only as a proposal a person accepted, and this strut grants it ungated. " +
          "A host that wants the builder to schedule lists it in the builder's approve: (its delta).",
      );
    }
    const api = (ctx.services as { automations?: AutomationStepsCapability } | undefined)?.automations;
    if (!api?.api) throw new Error("meta/set-automation needs strut's automations (ctx.services.automations); the standard strut server provides them.");
    const wf = (await requireAuthoring(ctx.services).getWorkflow(cfg.workflow)) as { error?: string; publisher?: string };
    if (wf.error) throw new Error(`${wf.error} — publish it with meta/publish-workflow first.`);
    if (wf.publisher !== AI_PUBLISHER) {
      throw new Error(`Workflow "${cfg.workflow}" was not published through meta/publish-workflow (publisher: ${wf.publisher ?? "none"}): only those may be scheduled here.`);
    }
    const { workflow, id, remove, ...fields } = cfg;
    if (remove) {
      if (!id) throw new Error("remove needs the automation's `id`.");
      return { removed: unwrap(await api.api.remove(workflow, id)).id };
    }
    if (id) {
      const saved = unwrap(await api.api.update(workflow, id, fields));
      return { automation: brief(saved.automation), next: saved.next };
    }
    // Where the run that proposed it reports, if it was launched with a callback.
    const callback = await api.callbackOf(ctx.proposal.by.runId).catch(() => undefined);
    const saved = unwrap(await api.api.create(workflow, { ...fields, ...(callback ? { callback } : {}) }));
    return { automation: brief(saved.automation), next: saved.next };
  },
});
