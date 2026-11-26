import { createHash } from "node:crypto";
import { z } from "zod";
import { defineStep, workflowOf, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { workflowStep } from "../../../run-step.js";

/**
 * A WORKFLOW posts in a linked place (plans/place-posts.md): a Sphinx tribe
 * today, whose host is the box's treasury daemon. Strut checks the run's
 * person holds a linked account of the host's kind (ruling 1: anyone linked
 * to the box, in any place linked there) and that the place is linked here,
 * then hands the post to the host on the hook it named (`PUT /hosts/me`),
 * `{ event: "post", … }`, and answers what the host sent
 * (`ctx.services.places`, src/people.ts). Strut knows nothing of the
 * medium: a workflow moves to another kind of place by `host` and `key`.
 *
 * Only as a STEP OF A WORKFLOW (ruling 2, run-step.ts `workflowStep`):
 * never an agent's tool, a single-step run (`step_run`, `meta/run-step`) or
 * a proposal's apply.
 *
 * Once per id: the host posts one id once. The id is a hash of the run's
 * workflow and the `id` given, or, with none, of the run and this step's
 * path — so a retry, a resumed run and a lost answer post once.
 */
export default defineStep({
  type: "place/post",
  effect: "write",
  description:
    "Post a message in a linked place (a Sphinx tribe linked to this box: place/list names them), as the box's account there (Jamie). " +
    "The run's person must have a linked account of the place's kind. Each post pays the place's price (a tribe's per message) from the box's treasury. " +
    "`reply` posts under an earlier post (its `id`). `id` makes a post once only across runs (`digest-2026-11-26`); without it, once per run and step. " +
    "A run posts for real, a test run too. Runs only as a step of a workflow, never as an agent's tool. Answers { id, sats?, again? }: the message's id, what it paid, and again: true when this id was posted before and nothing was posted now.\n\n" +
    `- id: post
  type: place/post
  config:
    host: sphinx
    key: "{{ input.tribe }}"
    text: "{{ digest.text }}"`,
  input: z.object({
    host: z.string().min(1).max(64).describe("The place's host: `sphinx` for a tribe."),
    key: z.string().min(1).max(200).describe("The place, as place/list names it: a tribe's pubkey."),
    text: z.string().min(1).max(10_000).describe("What to post: at most 10,000 characters. A long post goes in parts, each paying the place's price."),
    reply: z
      .preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(200).optional())
      .describe("The id of an earlier post in that place (place/post's `id`): this one goes under it, in its thread."),
    id: z
      .preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(200).optional())
      .describe("Makes the post once only across runs of this workflow: a second post with the same id posts nothing. Without it, once per run and step."),
  }),
  output: z.object({ id: z.string(), sats: z.number().optional(), again: z.boolean().optional() }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    if (!ctx || !workflowStep(ctx)) {
      throw new Error("workflow_only: place/post runs as a step of a workflow, never an agent's tool, a single-step run or a proposal (plans/place-posts.md ruling 2) — write it into a workflow and run that");
    }
    const places = ctx.services?.places;
    if (!places) throw new Error("place/post needs this server's places (ctx.services.places). The standard strut server provides them.");
    const workflow = workflowOf(ctx);
    const id = createHash("sha256")
      .update(cfg.id ? `${workflow}\n${cfg.id}` : `${ctx.runId}\n${ctx.path}`)
      .digest("hex")
      .slice(0, 32);
    return places.post({ host: cfg.host, key: cfg.key, text: cfg.text, ...(cfg.reply ? { reply: cfg.reply } : {}), id, run: ctx.runId, workflow }, ctx.principal);
  },
});
