import { z } from "zod";
import { defineStep } from "../../core.js";

const EXAMPLE = `- id: check
  type: if
  config:
    cond: "{{ fetch.body.status === 'active' }}"
  - id: yes
    type: log
    config:
      message: "Active!"
    depends: check
    when: true
  - id: no
    type: log
    config:
      message: "Inactive"
    depends: check
    when: false`;

export default defineStep({
  type: "if",
  description: `Conditional gate: returns the truthiness of cond, and downstream steps branch on it with depends: <this id> plus when: true / when: false. Each branch may be a chain; a step that depends on both branches runs when either did.\n\n${EXAMPLE}`,
  input: z.object({
    cond: z.any().describe("template expression, e.g. \"{{ fetch.body.status === 'active' }}\" — the step returns Boolean(cond)"),
  }),
  output: z.boolean(),
  async run(cfg) {
    return Boolean(cfg.cond);
  },
});
