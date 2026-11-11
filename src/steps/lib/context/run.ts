import { z } from "zod";
import { defineStep } from "../../../core.js";

/**
 * A run as a JUDGE's context: what it was asked, what it returned (or the
 * error it ended in) and the Concept pages it opened, as one bounded block
 * of text. A check on a claim about a Concept is handed the run that opened
 * the page (`claims.ts` `RunCheckSubject`); a run's input and output are
 * whatever its workflow made them, megabytes at times, so they are cut here,
 * in code, before a model reads them: the head and the tail of each kept.
 *
 * Pure: it reads nothing. Not under `knowledge/`, whose writers are sealed:
 * a check an AI stamped may reach this.
 */
const cut = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  return `${s.slice(0, head)}\n[…${s.length - max} characters left out…]\n${s.slice(s.length - (max - head))}`;
};
const show = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : (JSON.stringify(v, null, 2) ?? ""));

export default defineStep({
  type: "context/run",
  effect: "read",
  description:
    "Render a run as one bounded block of text for a model that judges it: what it was asked (`input`), what it returned (`output`) or the error it ended in, and the Concept pages it opened (`concepts`). " +
    "Each part is cut to its head and tail (`max` characters in all, default 12000), so a large output never reaches a prompt whole. Output: { text }.",
  input: z.object({
    input: z.any().optional().describe("The run's input: what it was asked."),
    output: z.any().optional().describe("The run's output."),
    error: z.any().optional().describe("The error the run ended in, when it failed."),
    concepts: z.any().optional().describe("The Concept pages the run opened, by name."),
    max: z.number().int().positive().max(100_000).optional().default(12_000).describe("Most characters in all (default 12000)."),
  }),
  output: z.object({ text: z.string() }),
  async run(cfg) {
    const opened = Array.isArray(cfg.concepts) ? cfg.concepts.filter((c: unknown): c is string => typeof c === "string") : [];
    const error = cfg.error && typeof cfg.error === "object" ? ((cfg.error as { message?: unknown }).message ?? cfg.error) : cfg.error;
    const parts = [
      `WHAT IT WAS ASKED:\n${cut(show(cfg.input), Math.floor(cfg.max * 0.25)) || "(nothing)"}`,
      error ? `IT FAILED WITH:\n${cut(show(error), Math.floor(cfg.max * 0.15))}` : `WHAT IT RETURNED:\n${cut(show(cfg.output), Math.floor(cfg.max * 0.7)) || "(nothing)"}`,
      `CONCEPT PAGES IT OPENED: ${opened.length ? opened.join(", ") : "none"}`,
    ];
    return { text: parts.join("\n\n") };
  },
});
