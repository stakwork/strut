import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Ctx, browserOf, keptOf, session } from "./_shared.js";

export default defineStep({
  type: "browser/keep",
  description:
    "Keep the page you are on for the JOB, as `session`: it is not closed when this run ends, and a later run of the job opens it again with browser/open { session } — exactly where you left it, cookies, scroll and an open challenge included. For a page a person must act on before you can go on (a captcha). It closes after 12 idle minutes, or with browser/close { session }. Needs a run launched under a job. Returns { session, url, title }.",
  input: z.object({ session }),
  output: z.object({ session: z.string(), url: z.string(), title: z.string() }),
  async run(cfg, ctx: Ctx) {
    const kept = keptOf(ctx, cfg.session, "keep");
    const out = await browserOf(ctx).keep(ctx.runId, kept.session);
    await kept.hold();
    return { session: cfg.session, ...out };
  },
});
