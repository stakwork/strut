import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { PROVENANCE_MAX_MOMENTS } from "../../../provenance.js";
import { requireRuns, inFrame, callerOf } from "./_shared.js";

export default defineStep({
  type: "run/provenance",
  effect: "read",
  description:
    "Where a thing in a run's output came from — a SPOT CHECK, read off the run's own log (plans/spot-check.md). Name the thing by `value` (as shown: a number, a passage, a name) " +
    "and, when you know where it sits, by `cell` (a sheet range, `FACTS!B13`), `node` (a graph ref_id) or `file` (a path). " +
    "Answers { moments, refs, literals, formula?, figures, note? }: each time it passed through the run, oldest first — `wrote` (into a cell, a file or a node), " +
    "`used` (in a command, a query, a prompt), `read` (out of a document, a sheet, the graph, a step) — with the agent, the tool, the cell or file or node, a snippet, " +
    "and for a call an agent made its words before it (`why`) and, for a write, the calls just before (`before`). `exact` moments matched by address, the rest by the value's text " +
    `(a number in any spelling); a value too short to search for (\`11\`) is followed by address only. At most ${PROVENANCE_MAX_MOMENTS} moments, every exact one kept. ` +
    "`refs` are the cells a formula reads (or a passage cites), `literals` the numbers typed into a formula, `figures` the numbers a passage states — each a spot check of its own.",
  input: z.object({
    workflow: z.string().describe("The workflow name."),
    runId: z.string().describe("The run id."),
    value: z.string().optional().describe("The thing as shown: a cell's value, a passage, a node's name."),
    cell: z.string().optional().describe("A sheet range the thing sits in: `FACTS!B13`, `'SOURCE: a.xlsx — Detail'!K2:K248`."),
    spreadsheet: z.string().optional().describe("The Google Sheet (id or URL), when the run wrote several."),
    node: z.string().optional().describe("A graph node's ref_id."),
    file: z.string().optional().describe("A file's path or name the thing is in."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!cfg.value && !cfg.cell && !cfg.node && !cfg.file) throw new Error("run/provenance needs the thing: `value`, `cell`, `node` or `file`");
    const runs = requireRuns(ctx.services);
    if (!runs.provenance) throw new Error("run/provenance: this server's runs capability cannot read a run's raw log");
    const out = await runs.provenance(await inFrame(cfg, ctx), callerOf(ctx));
    if (!out) throw new Error(`Run "${cfg.runId}" not found for workflow "${cfg.workflow}"`);
    return out;
  },
});
