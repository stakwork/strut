import { z } from "zod";
import { defineStep, isFirstParty, workflowOf, type StepContext } from "../../../core.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";
import type { SecretBlanks } from "../../../secret-store.js";

/**
 * A secret a PERSON types into strut's own app (plans/member-rights.md
 * "Adding a secret"): the builder's reply names one it needs (`ask.secret`),
 * Jamie shows a password box under the question, and saving it runs this
 * step through `step_run`. It FILLS A BLANK — a name with no value in the
 * deployment's store or its environment — and never overwrites one, so a
 * member cannot replace the team's model or GitHub key with their own; it
 * never lists, reads, changes or deletes a secret. It answers with the name
 * alone.
 *
 * It runs only as a FIRST-PARTY page's own call (a one-step run, for its
 * viewer): never from a model-written page, never as an agent's tool — a
 * model never sees a value. `value` is `redact`ed from the run's events, so
 * no log, sink or kept run holds it.
 */
export default defineStep({
  type: "secret/add",
  effect: "write",
  redact: ["value"],
  description:
    "Store a secret a person typed into strut's own app, under a name this server has no value for (in its secret store or its environment) — never one it has. " +
    "Runs only as strut's own app's call, never an agent's tool. Returns the name alone.",
  input: z.object({
    name: z.string().min(1).describe("The secret's NAME, as a step reads it (secrets.get(\"NAME\")): letters, digits and _."),
    value: z.string().min(1).describe("What the person typed. Never logged, never returned."),
  }),
  output: z.object({ name: z.string() }),
  async run(cfg, ctx: StepContext) {
    if (!isFirstParty(ctx.app) || !ctx.actor || workflowOf(ctx) !== RUN_STEP_FLOW) {
      throw new Error(
        "secret/add is a person's: it runs only as strut's own app's call, for its viewer (plans/member-rights.md). An agent never sees or stores a value — it names the secret in its reply's ask.secret.",
      );
    }
    const blanks = (ctx.services as { secretBlanks?: SecretBlanks } | undefined)?.secretBlanks;
    if (!blanks) throw new Error("secret/add needs strut's own secret store (ctx.services.secretBlanks); this server's secrets are its host's.");
    return blanks.fill(cfg.name.trim(), cfg.value);
  },
});
