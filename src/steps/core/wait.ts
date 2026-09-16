import { z } from "zod";
import { defineStep } from "../../core.js";

const EXAMPLE = `- id: pause
  type: wait
  config:
    durationMs: 3000
    message: "Waiting for cooldown"`;

export default defineStep({
  type: "wait",
  description: `Pause the run for a fixed duration — rate-limit spacing, a cooldown, giving an external system time to settle. To wait UNTIL something is true, use the loop step with delayMs instead.\n\n${EXAMPLE}`,
  input: z.object({
    durationMs: z.number().int().min(0).default(1000).describe("how long to pause"),
    message: z.string().optional().describe("optional note, echoed in the output"),
  }),
  output: z.object({
    waited: z.number(),
    message: z.string().optional(),
  }),
  async run(cfg) {
    await new Promise((resolve) => setTimeout(resolve, cfg.durationMs));
    return { waited: cfg.durationMs, message: cfg.message };
  },
});
