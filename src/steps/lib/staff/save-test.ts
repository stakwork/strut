import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/save-test` (plans/human-steps.md §9.3): A new test. */
export default defineStep({
  type: "staff/save-test",
  effect: "write",
  // The expected answer never reaches a run's events (§7.9).
  redact: ["expected"],
  description: "A new test (POST /tasks/tests { type, show, files, expected, grade }), or, with id, a change to one never served (PUT /tasks/tests/:id { show, expected, grade }; in_use once served: retire it and make another). expected is checked against the type's answer shape. Answers { test }. Only strut's own staff app, shown to an admin; never kept as a run, and expected is redacted from any event.",
  input: z.object({
    id: z.string().optional(),
    type: z.string().optional(),
    show: z.any().optional(),
    files: z.array(z.string()).optional(),
    expected: z.any().optional(),
    grade: z.any().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { id, type, files, ...rest } = cfg;
    if (id) {
      if (type !== undefined || files !== undefined) throw new Error("staff/save-test: a test's type and files are fixed once it is made");
      return staffCall(ctx, "staff/save-test", "PUT", `/tasks/tests/${seg(id)}`, rest);
    }
    if (!type) throw new Error("staff/save-test: a new test names its type");
    if (rest.expected === undefined) throw new Error("staff/save-test: a new test has an expected answer");
    return staffCall(ctx, "staff/save-test", "POST", "/tasks/tests", { type, ...(files !== undefined ? { files } : {}), ...rest });
  },
});
