import { z } from "zod";
import { defineStep } from "../../core.js";

const EXAMPLE = `- id: child
  type: subflow
  config:
    workflow: notify-flow
    version: v2
    input:
      message: "{{ deploy.result }}"`;

export default defineStep({
  type: "subflow",
  description: `Run a published workflow as a child of this run and return its output — reuse a flow from another, or split a big one. The workflow must already exist in the workspace (list_workflows); its input is validated against the child's schema at run time.\n\n${EXAMPLE}`,
  input: z.object({
    workflow: z.string().describe("name of a published workflow"),
    version: z.string().optional().describe("a specific version, e.g. v2 (default: the active version)"),
    input: z.any().describe("the object passed as the child workflow's input"),
  }),
  output: z.any(),
  async run() {
    throw new Error("subflow step must be executed by the runner");
  },
});
