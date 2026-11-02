import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { readDocFile, writeDocFile } from "./_docx.js";
import { docxToHtml } from "./_html.js";

const EXAMPLE = `- id: read
  type: docx/to-html
  config:
    path: uploads/msa-from-counterparty.docx
    out: msa-from-counterparty.html`;

const HTML_PAGE = (title: string, body: string) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>` +
  `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}` +
  `ins{color:#1a7f37;text-decoration:underline}del{color:#cf222e}table{border-collapse:collapse}` +
  `td,th{border:1px solid #ccc;padding:.25rem .5rem;vertical-align:top}</style></head>\n<body>\n${body}\n</body></html>\n`;

/**
 * A .docx read for a person and for a model: the HTML a view draws
 * (strut/views' DocumentView keeps everything it writes) and the text a model
 * reads. Built in JavaScript straight off the document's XML, not through
 * pandoc: every deployment runs it (the desktop has no pandoc), it is the
 * same reading of the parts docx/redline writes into, and a tracked change
 * maps to <ins>/<del> with its author and date directly, where pandoc's
 * `--track-changes=all` emits spans to rewrite. See _html.ts for what is kept.
 */
export default defineStep({
  type: "docx/to-html",
  effect: "read",
  description:
    `Read a Word .docx as HTML and plain text. \`path\` is a file of this run (relative to the job's directory on a job run, else the run's artifacts) or a served link (/jobs/<job>/files/…, /artifacts/<runId>/…). ` +
    `Kept: headings, paragraphs, Word's own list numbers ("12.3", "(b)") as text, bullet lists, tables (merged cells), links, bold/italic/underline/strike. ` +
    `Tracked changes come out as <ins>/<del> carrying author and date (datetime, title, data-author), and as \`changes\`; comments, footnotes and endnotes as numbered notes [n] listed at the end, and as \`notes\` (a comment's anchor is the text it is on). ` +
    `\`text\` is the document as it reads with every change accepted — copy a docx/redline \`find\` from it. Images, text boxes and headers/footers are left out. ` +
    `\`out\` also writes the HTML as a page into this run's files (a deliverable). Output: { html, text, title, changes, notes, source, out? }\n\n${EXAMPLE}`,
  input: z.object({
    path: z.string().min(1).describe("The .docx: relative to this run's files (the job's directory, else the run's artifacts), or a served link."),
    out: z.string().optional().describe("Also write the HTML as a page here, in this run's files (e.g. contract.html)."),
  }),
  output: z.object({
    html: z.string(),
    text: z.string(),
    title: z.string().nullable(),
    changes: z.array(
      z.object({
        kind: z.enum(["insert", "delete"]),
        text: z.string(),
        author: z.string().optional(),
        date: z.string().optional(),
        move: z.literal(true).optional(),
      }),
    ),
    notes: z.array(
      z.object({
        n: z.number(),
        kind: z.enum(["comment", "footnote", "endnote"]),
        text: z.string(),
        author: z.string().optional(),
        date: z.string().optional(),
        anchor: z.string().optional(),
      }),
    ),
    source: z.object({ path: z.string(), url: z.string() }),
    out: z.object({ path: z.string(), url: z.string() }).optional(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const file = await readDocFile(ctx, cfg.path);
    const doc = docxToHtml(file.bytes);
    const result = { ...doc, source: { path: file.path, url: file.url } };
    if (!cfg.out) return result;
    const page = HTML_PAGE(doc.title ?? file.path.split("/").pop() ?? "document", doc.html);
    return { ...result, out: await writeDocFile(ctx, cfg.out, page) };
  },
});
