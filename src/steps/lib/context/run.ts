import { z } from "zod";
import { defineStep } from "../../../core.js";
import { renderWork, type WorkCapability, type WorkRun } from "../../../work.js";

/**
 * A run as a JUDGE's context: what it was asked, what it returned (or the
 * error it ended in) and the Concept pages it opened, as one bounded block
 * of text. A run's input and output are whatever its workflow made them,
 * megabytes at times, so they are cut here, in code, before a model reads
 * them: the head and the tail of each kept.
 *
 * Inside a check the verify pass runs over a WORK (a claim on a Concept,
 * src/work.ts), it renders that work instead — the run that took the
 * request and every run it caused, in order, with the folders their files
 * are in — read from the capability the pass put on the bag
 * (`ctx.services.work`), never from the input. A work of one run reads
 * exactly as one run always did.
 *
 * It reads nothing else. Not under `knowledge/`, whose writers are sealed:
 * a check an AI stamped may reach this.
 */
export default defineStep({
  type: "context/run",
  effect: "read",
  description:
    "Render a run as one bounded block of text for a model that judges it: what it was asked (`input`), what it returned (`output`) or the error it ended in, and the Concept pages it opened (`concepts`). " +
    "Inside a check the verify pass runs over a whole piece of work, it renders that work instead: each run in the order it started, how it came about, and the folders of files it made. " +
    "Each part is cut to its head and tail (`max` characters in all, default 12000), so a large output never reaches a prompt whole. Output: { text }.",
  input: z.object({
    input: z.any().optional().describe("The run's input: what it was asked."),
    output: z.any().optional().describe("The run's output."),
    error: z.any().optional().describe("The error the run ended in, when it failed."),
    concepts: z.any().optional().describe("The Concept pages the run opened, by name."),
    max: z.number().int().positive().max(100_000).optional().default(12_000).describe("Most characters in all (default 12000)."),
  }),
  output: z.object({ text: z.string() }),
  async run(cfg, ctx) {
    const work = (ctx?.services as { work?: WorkCapability } | undefined)?.work?.work;
    if (work?.runs?.length) return { text: renderWork(work, cfg.max) };
    const opened = Array.isArray(cfg.concepts) ? cfg.concepts.filter((c: unknown): c is string => typeof c === "string") : [];
    const error = cfg.error && typeof cfg.error === "object" ? ((cfg.error as { message?: unknown }).message ?? cfg.error) : cfg.error;
    const run: WorkRun = {
      n: 1,
      workflow: "",
      runId: "",
      status: error ? "error" : "success",
      input: cfg.input,
      ...(error ? { error: typeof error === "string" ? error : (JSON.stringify(error) ?? "") } : { output: cfg.output }),
      concepts: opened,
    };
    return { text: renderWork({ root: { workflow: "", runId: "" }, runs: [run], concepts: opened, files: {} }, cfg.max) };
  },
});
