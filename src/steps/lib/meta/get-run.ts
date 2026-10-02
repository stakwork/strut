import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/get-run",
  description:
    "Get one run of an agent-authored workflow as a tree: its summary, the deepest errors first (each with the siblings that ran before it), and its top-level steps with everything below rolled up (an agent's tool calls become a histogram by tool). `path` zooms to one node — its payloads, its children listed one level deep; `fullEvents` adds payload previews to every listed node. Cut to a char budget, never the raw log. Use to debug why a candidate run failed. Runs of workflows the agent surface did not author are refused.",
  input: z.object({
    name: z.string().describe("Workflow name (must be agent-authored)"),
    runId: z.string().describe("Run id (from meta/list-runs or a meta/run-workflow result)"),
    path: z
      .string()
      .optional()
      .describe("Zoom to one node by its event path (`wf/agent`, `wf/items#3`, `wf/agent/042-bash`): it becomes `focus` with payloads, and `steps` lists its children."),
    fullEvents: z
      .boolean()
      .default(false)
      .describe("Also put input/output previews on every listed node (default false: only the focus node carries payloads)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).getRun(cfg.name, cfg.runId, { path: cfg.path, fullEvents: cfg.fullEvents });
  },
});
