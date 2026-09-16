import { z } from "zod";
import { defineStep } from "../../core.js";

const EXAMPLE = `- id: poll
  type: loop
  config:
    maxIterations: 10
    delayMs: 2000
    until: "{{ $current.body.status === 'complete' }}"
    body:
      id: check
      type: http
      config:
        url: "https://api.example.com/status"`;

export default defineStep({
  type: "loop",
  description: `Repeat one body step until a condition holds — polling, retry-until-ready. Fails if maxIterations is reached with until still false (when a hard stop must still yield a result, use the agent step instead). Output: the body output of the iteration that satisfied until.\n\n${EXAMPLE}`,
  input: z.object({
    until: z.string().describe("template expression checked after each iteration; {{ $current }} is that iteration's body output"),
    maxIterations: z.number().int().positive().describe("hard cap — reaching it without until becoming true fails the step"),
    delayMs: z.number().int().nonnegative().optional().describe("pause between iterations"),
    body: z.any().describe("the single step to repeat ({ id, type, config }); inside it {{ $current }} is the previous iteration's output, undefined on the first"),
  }),
  output: z.any(),
  async run() {
    // Control flow handled by runner — this should never be called directly
    throw new Error("loop step must be executed by the runner");
  },
});
