import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { PrChecksCapability } from "../../../pr-checks.js";

/**
 * Look at the recent jobs' pull requests now (plans/pr-checks.md): a job
 * whose pull request's checks all finished with one failed gets one turn to
 * fix it, as the person who ran the turn that opened it, and its end wakes
 * that turn's conversation. Strut decides who and what (src/pr-checks.ts);
 * this step only says when. It takes no person and no text, so whoever
 * runs it can only make strut look sooner. strut-github's schedule runs it,
 * and later its webhook with the pull request's URL.
 */
export default defineStep({
  type: "job/pr-checks",
  effect: "write",
  description:
    `Read the checks on the pull requests recent jobs delivered, and send each job whose checks failed one turn to fix them ` +
    `(once per pull request, as the person who opened it; its end wakes their conversation): { jobs, sent }. ` +
    `With url, that pull request alone. A call while a pass runs gets that pass's result.`,
  input: z.object({
    url: z.string().optional().describe("A pull request's URL (https://github.com/<owner>/<repo>/pull/<n>): look at that one alone."),
  }),
  output: z.object({
    jobs: z.number().describe("Jobs whose pull requests were read."),
    sent: z.number().describe("Jobs sent a turn to fix them."),
  }),
  async run(cfg, ctx) {
    const cap = (ctx?.services as { prChecks?: PrChecksCapability } | undefined)?.prChecks;
    if (!cap) throw new Error("job/pr-checks needs the server's pull request checks (ctx.services.prChecks), which the standard strut server provides");
    return cap.check(cfg.url ? { url: cfg.url } : {});
  },
});
