import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { BATCH_MAX } from "../../../apps/sqlite.js";
import { appDatabase, appField, paramsField } from "./_shared.js";

export default defineStep({
  type: "sqlite/batch",
  description:
    `Several writes to an app's own SQLite database in ONE transaction (plans/apps.md §4.4): all of them land, or none does. Up to ${BATCH_MAX} statements, each one statement with its own params. ` +
    "Returns { results: [{ changes, lastInsertRowid }] } in order; an error names the statement (statements[i]) and rolls every one back.",
  effect: "write",
  input: z.object({
    statements: z
      .array(z.object({ sql: z.string(), params: paramsField }))
      .min(1)
      .describe("The statements, in order."),
    app: appField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return (await appDatabase(ctx, "sqlite/batch", cfg.app)).batch(cfg.statements);
  },
});
