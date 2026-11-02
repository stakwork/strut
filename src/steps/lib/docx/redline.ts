import { posix } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { readDocFile, writeDocFile } from "./_docx.js";
import { redlineDocx } from "./_redline.js";

const EXAMPLE = `- id: redline
  type: docx/redline
  config:
    path: uploads/msa.docx
    out: msa-redline.docx
    edits:
      - find: "within thirty (30) days"
        replace: "within sixty (60) days"
        reason: "Our standard payment term is net 60."
        sources: ["Playbook § 4.2"]
      - find: "Supplier"
        replace: "Vendor"
        all: true
      - find: "shall indemnify"
        paragraph: "12.3"
        replace: "shall indemnify, defend and hold harmless"`;

const source = z.union([
  z.string(),
  z.object({
    title: z.string().optional(),
    url: z.string().optional(),
    ref_id: z.string().optional(),
    quote: z.string().optional(),
  }),
]);

const result = z.object({
  index: z.number(),
  find: z.string(),
  status: z.enum(["applied", "unplaced"]),
  count: z.number(),
  matched: z.enum(["exact", "normalized"]).optional(),
  reason: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  skipped: z.array(z.string()).optional(),
  comment: z.boolean().optional(),
});

/**
 * A redline: edits written into a copy of a .docx as Word's own tracked
 * changes, each reason a comment beside it — what a lawyer sends back, and
 * what Word and LibreOffice show as a markup to accept or reject. The
 * original is never changed. See _redline.ts for how text is found and
 * changed.
 */
export default defineStep({
  type: "docx/redline",
  // No `effect`: it writes a new file into this run's own files, nothing outside the run.
  description:
    `Write edits into a Word .docx as TRACKED CHANGES (w:ins / w:del, author and date), each edit's reason (and sources) as a Word comment on it, and save the result as a new .docx in this run's files — the original is left as it is. ` +
    `\`path\`: the original, as docx/to-html takes it. Each edit: \`find\` — the exact text, within ONE paragraph, as docx/to-html's \`text\` shows it (list numbers like "12.3" are not text: leave them out; curly quotes and dashes match plain ones); \`replace\` — the new text (only the words that differ are marked; "" deletes; omitted: comment only, with a reason); \`paragraph\` — text the right paragraph contains, when \`find\` occurs more than once; \`all: true\` — change every occurrence (one comment, on the first). ` +
    `An edit that cannot be placed — not found, ambiguous, inside a tracked change already there or a field — changes nothing and comes back in \`unplaced\` with the reason and, where it helps, the paragraphs it was seen in; fix it and run again. ` +
    `\`out\` defaults to <name>.redline.docx beside the original. Output: { path, url, applied, unplaced, edits }\n\n${EXAMPLE}`,
  input: z.object({
    path: z.string().min(1).describe("The original .docx: relative to this run's files, or a served link."),
    edits: z
      .array(
        z.object({
          find: z.string().min(1).describe("Exact text of the document, within one paragraph."),
          replace: z.string().optional().describe('The new text; "" deletes; omitted: a comment only.'),
          reason: z.string().optional().describe("Why — becomes a Word comment on the change."),
          sources: z.array(source).optional().describe("What the change rests on (a Concept, a case, a passage) — listed in the comment."),
          paragraph: z.string().optional().describe("Text the paragraph holding the match contains, to choose among several matches."),
          all: z.boolean().optional().describe("Change every occurrence."),
        }),
      )
      .min(1),
    out: z.string().optional().describe("Where to write the redline in this run's files (default <name>.redline.docx beside the original)."),
    author: z.string().min(1).default("Strut").describe("The author Word shows on every change and comment."),
    date: z.string().optional().describe("ISO time stamped on the changes (default now)."),
  }),
  output: z.object({
    path: z.string(),
    url: z.string(),
    applied: z.number(),
    unplaced: z.array(result),
    edits: z.array(result),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (cfg.date && Number.isNaN(Date.parse(cfg.date))) throw new Error(`docx/redline: date "${cfg.date}" is not an ISO time`);
    const file = await readDocFile(ctx, cfg.path);
    const { bytes, results } = redlineDocx(file.bytes, cfg.edits, { author: cfg.author, date: cfg.date });
    const stem = posix.basename(file.path).replace(/\.docx$/i, "");
    const beside = file.own ? posix.dirname(file.path) : ".";
    const written = await writeDocFile(ctx, cfg.out ?? posix.join(beside, `${stem}.redline.docx`), bytes);
    return {
      ...written,
      applied: results.filter((r) => r.status === "applied").length,
      unplaced: results.filter((r) => r.status === "unplaced"),
      edits: results,
    };
  },
});
