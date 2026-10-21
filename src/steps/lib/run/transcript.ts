import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RUN_TRANSCRIPT_MAX_CHARS } from "../../../runs.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/transcript",
  description:
    "ONE agent's transcript from a run, by its step path (`wf/review`; a sub-agent's `wf/review/003-agent`) — what the `transcript` link on that step's step.end in run/events points at: { path, messages } (AI SDK model messages: system, user, assistant, tool). " +
    "`full` on a session turn (an agent step with `session`) gives the thread up to and including it — the system prompt, every earlier turn, this one — `full: true` on the result when it did. " +
    `Capped at ${RUN_TRANSCRIPT_MAX_CHARS} JSON chars: long strings cut to their head and tail first, then messages left out of the middle; \`truncated\` says what went.`,
  input: z.object({
    workflow: z.string().describe("The workflow name."),
    runId: z.string().describe("The run id."),
    path: z.string().describe("The agent step's path in the run (a step.end's `path` in run/events)."),
    full: z.boolean().optional().describe("A session turn: the whole thread up to it, not just the turn."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return requireRuns(ctx.services).transcript(cfg);
  },
});
