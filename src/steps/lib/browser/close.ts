import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Ctx, browserOf, holdId, ok, session } from "./_shared.js";

export default defineStep({
  type: "browser/close",
  description:
    "Close the run's browser page and context now. Optional — every run's context is closed when the run ends anyway. A later browser/open starts a fresh one. With `session`, close the page the JOB keeps under that name instead, and let the job's hold on it go (a kept page otherwise closes after 12 idle minutes).",
  input: z.object({ session: session.optional() }),
  output: ok,
  async run(cfg, ctx: Ctx) {
    if (!cfg.session) return browserOf(ctx).closeRun(ctx.runId);
    // Also the hold's release step: strut runs it when the job is deleted or
    // swept, outside any run — and after a restart, when the page is long
    // gone. So no page (or no browser) is not an error; the hold goes anyway.
    const job = ctx.job;
    if (!job) throw new Error("browser/close: `session` names a page the JOB keeps, and this run has no job");
    await ctx.services?.browser?.closeKept(job, cfg.session);
    await ctx.services?.jobs?.release(job, holdId(cfg.session));
    return { ok: true as const };
  },
});
