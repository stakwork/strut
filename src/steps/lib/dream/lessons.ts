import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { errText, graphCtx, mayRead } from "../graph/_shared.js";

export default defineStep({
  type: "dream/lessons",
  effect: "read",
  description:
    "The lessons learned about how the assistant should act (plans/dream.md; a LadybugDB graph only), the most corrected first: " +
    "{ lessons: [{ id, title, text, since, against, for, last, evidence: [{ session, turn, excerpt, why, against, at }] }] }. " +
    "`against` counts the turns that showed the lesson broken, `for` the turns that showed it kept: counted on read, never stored. " +
    "A lesson corrected again after it was written into a page is one whose fix did not hold.",
  input: z.object({ evidence: z.number().int().nonnegative().max(200).optional().default(5).describe("Most pieces of evidence per lesson, newest first (default 5).") }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      if (b.kind !== "ladybug") return "dream/lessons failed — WRONG_TYPE: lessons are on a LadybugDB graph only";
      const { listLessons } = await import("../../../graph/ladybug/lessons.js");
      const namespace = await b.reader.resolveNamespace(undefined);
      if (!mayRead(b, namespace)) return { lessons: [] };
      const lessons = await b.tx((tx) => listLessons(tx, namespace));
      return { lessons: lessons.map((l) => ({ ...l, evidence: l.evidence.slice(0, cfg.evidence) })) };
    } catch (e) {
      return errText("dream/lessons", e);
    }
  },
});
