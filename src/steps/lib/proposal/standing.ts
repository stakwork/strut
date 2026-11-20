import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminStanding, proposalsOf } from "../../../proposals.js";

/** Whether the person this run is for is an ADMIN of this strut server
 *  (plans/member-rights.md), as the records say — the check a proposal
 *  only an admin accepts makes (`adminStanding`): a page's turn says
 *  (`ctx.app.admin`), a peer's launch is not one, a job's run or a wake asks
 *  the turn that started it. `admin` is left out when nothing says (a
 *  host's launch with the key, an automation). The orchestrator puts it
 *  before the person's message, so a turn says "you approve it" to an
 *  admin and "an admin approves it" to anyone else. */
export default defineStep({
  type: "proposal/standing",
  description:
    "Whether the person this run is for is an admin of this strut server: { admin?: boolean }. " +
    "true: they accept, on its card, what only an admin does; false: an admin must; left out when nothing says.",
  input: z.object({}),
  output: z.object({ admin: z.boolean().optional() }),
  async run(_cfg, ctx: StepContext) {
    const admin = await adminStanding(ctx, proposalsOf(ctx.services));
    return admin === undefined ? {} : { admin };
  },
});
