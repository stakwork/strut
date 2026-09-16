import { z } from "zod";
import { defineStep } from "../../core.js";

const EXAMPLE = `- id: process_changes
  type: foreach
  config:
    items: "{{ fetch.changes }}"
    body:
      id: handle
      type: subflow
      config:
        workflow: process-pr
        input:
          change: "{{ $current }}"
          index: "{{ $index }}"`;

export default defineStep({
  type: "foreach",
  description: `Run one body step once per item of a list (or N times), sequentially by default or through a bounded pool. Output: the array of body outputs, one per item, in input order (each iteration keeps its own #i event path).\n\n${EXAMPLE}`,
  input: z.object({
    items: z.any().describe("template expression resolving to an array, or a non-negative integer N to iterate 0..N-1"),
    body: z.any().describe("the single step to run per item ({ id, type, config }); inside it {{ $current }} is the item and {{ $index }} its zero-based position"),
    maxIterations: z.number().int().positive().optional().describe("safety cap: the step fails if items has more entries than this"),
    concurrency: z.number().int().positive().optional().describe("run up to N iterations at once (default 1, sequential); size it to what the body's targets tolerate — rate-limited sites want 1-4"),
  }),
  output: z.any(),
  async run() {
    // Control flow handled by runner — this should never be called directly
    throw new Error("foreach step must be executed by the runner");
  },
});
