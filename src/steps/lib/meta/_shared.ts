import { z } from "zod";
import type { AuthoringCapability } from "../../../authoring.js";
import { isAncestorRun, type RunControl } from "../../../run-control.js";

/** `edits` on meta/edit-workflow and meta/edit-step — the chat's own
 *  (src/ai/tools.ts): exact-string replacements over the active version. */
export const editsSchema = z
  .array(
    z.object({
      old: z.string().min(1).describe("Text to replace — must match the current source exactly once (whitespace and indentation included)."),
      new: z.string().describe("Replacement text (empty to delete)."),
    }),
  )
  .min(1)
  .describe("Exact-string replacements applied in order to the ACTIVE version's source — for a small change to a big file, instead of resending it whole.");

/** Cancelling or pausing the run this step is in (or one that launched it)
 *  would stop the caller itself: a paused turn waits for a resume no one
 *  will send. */
export function ownRunRefusal(control: RunControl | undefined, runId: string, action: "cancel" | "pause"): string | null {
  return isAncestorRun(control, runId)
    ? `run ${runId} is this run, or one that launched it — it cannot ${action} itself. End your turn instead.`
    : null;
}

/**
 * The `meta/*` steps are thin plumbing over the authoring capability
 * (`services.authoring`, auto-provided by `createStrut`) — the workspace's
 * author/test/inspect operations as REGISTRY STEPS, so an in-workflow agent
 * (`agentTools: ["meta/*"]`) can author, test, and inspect candidate
 * workflows from inside a run. See EVOLVE_SPEC §5.2, and authoring.ts for
 * the sealed rule the capability enforces (§6, src/sealed.ts).
 *
 * GRANT DISCIPLINE (§5.3.2): an authoring agent gets `meta/*` and nothing
 * else — never `bash` alongside it, and never grader steps. The producing
 * agent (the one whose output is graded) gets no `meta/*` at all.
 */
export interface AuthoringServices {
  authoring?: AuthoringCapability;
}

export function requireAuthoring(services: unknown): AuthoringCapability {
  const authoring = (services as AuthoringServices | undefined)?.authoring;
  if (!authoring) {
    throw new Error(
      "meta/* steps require the authoring capability (ctx.services.authoring). " +
        "The standard strut server provides it automatically; embedders can inject one " +
        "via buildAuthoringCapability (import from 'strut').",
    );
  }
  return authoring;
}
