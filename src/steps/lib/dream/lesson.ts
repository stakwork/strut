import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { errText, graphCtx, mayRead } from "../graph/_shared.js";

export default defineStep({
  type: "dream/lesson",
  effect: "write",
  description:
    "Record a LESSON about how the assistant should act, with the conversation turn that shows it (plans/dream.md; a LadybugDB graph only). " +
    "A lesson is one sentence that should hold, said so it can be checked later (\"Keep summaries to three lines\", \"Do not ask before reading the calendar\"), " +
    "with where it applies in the sentence when it is not general (\"In emails to Sam, no greeting\"). The turn is its evidence: the person's own words as `excerpt`. " +
    "Read dream/lessons first: when a lesson already covers it, pass its id as `lesson` so the turn is added to it (a second correction is the signal that a fix did not hold); " +
    "pass `text` only for a new one. `kept: true` when the turn shows the lesson followed or confirmed (\"yes, exactly like that\"); the default is a correction. " +
    "The same turn recorded twice writes nothing. It never changes memory or a page: only the lesson and its evidence.",
  input: z.object({
    lesson: z.string().optional().describe("An existing lesson's id (from dream/lessons). Leave out to make a new one from `text`."),
    text: z.string().optional().describe("A new lesson: one sentence that should hold, naming where it applies when it is not general."),
    title: z.string().optional().describe("A short name for a new lesson (a few words). Default: the sentence."),
    session: z.string().describe("The conversation the turn is in."),
    turn: z.number().int().nonnegative().describe("The turn number."),
    at: z.string().optional().describe("When the turn was (ISO), as the transcript gives it."),
    run: z.string().optional().describe("The turn's run id."),
    excerpt: z.string().describe("The person's words in that turn that show it, verbatim."),
    why: z.string().optional().describe("One line: what the assistant did and what the person wanted."),
    kept: z.boolean().optional().describe("The turn shows the lesson followed or confirmed. Default false: it shows it broken."),
    created_by: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      if (b.kind !== "ladybug") return "dream/lesson failed — WRONG_TYPE: lessons are on a LadybugDB graph only";
      if (!cfg.excerpt.trim()) return "dream/lesson invalid input — excerpt is the person's words, and is required";
      const at = cfg.at ? Date.parse(cfg.at) : NaN;
      const { recordLesson } = await import("../../../graph/ladybug/lessons.js");
      const namespace = await b.reader.resolveNamespace(undefined);
      if (!mayRead(b, namespace)) return "dream/lesson failed — REFUSED: this caller may not read the namespace lessons are kept in";
      const now = Date.now();
      const by = cfg.created_by ?? ctx?.actor;
      return await b.tx((tx) =>
        recordLesson(tx, {
          ...(cfg.lesson ? { lesson: cfg.lesson } : {}),
          ...(cfg.text ? { text: cfg.text } : {}),
          ...(cfg.title ? { title: cfg.title } : {}),
          session: cfg.session,
          turn: cfg.turn,
          ...(cfg.run ? { run: cfg.run } : {}),
          excerpt: cfg.excerpt.trim(),
          ...(cfg.why ? { why: cfg.why } : {}),
          strength: cfg.kept ? 1 : -1,
          observed_at: Number.isFinite(at) ? at : now,
          namespace,
          ...(by ? { created_by: by } : {}),
          now,
        }),
      );
    } catch (e) {
      return errText("dream/lesson", e);
    }
  },
});
