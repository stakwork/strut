import { z } from "zod";
import { defineStep } from "../../core.js";

const EXAMPLE = `- id: greet
  type: log
  config:
    message: "Hello {{ input.name }}"
    level: info`;

export default defineStep({
  type: "log",
  description: `Print a line to the server console — a marker or a human-readable trace of a run. Returns the message itself, so it also works as a pass-through of a resolved value.\n\n${EXAMPLE}`,
  input: z.object({
    message: z.string().describe("text to print; templates resolve first"),
    level: z.enum(["info", "warn", "error"]).default("info").describe("console level (prefix and stream)"),
  }),
  output: z.string(),
  async run(cfg) {
    const prefix = `[${cfg.level.toUpperCase()}]`;
    const line = `${prefix} ${cfg.message}`;

    switch (cfg.level) {
      case "error":
        console.error(line);
        break;
      case "warn":
        console.warn(line);
        break;
      default:
        console.log(line);
    }

    return cfg.message;
  },
});
