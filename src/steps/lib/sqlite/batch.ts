import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { BATCH_MAX, runBatch } from "../../../apps/data.js";
import { appDatabase, appSchema, paramsSchema } from "./_shared.js";

/** Several writes on an app's own database in ONE transaction (plans/apps.md
 *  §4.4). From a page, kept as a step run with its viewer (§9). */
export default defineStep({
  type: "sqlite/batch",
  effect: "write",
  description:
    `Run several SQL statements (at most ${BATCH_MAX}) on an app's own SQLite database in ONE transaction — all of them, or none: \`{ results: [{ changes, lastInsertRowid }] }\`, one per statement, in order. ` +
    "Each is SQL text, or { sql, params } with its values. A failing statement rolls the whole batch back and says which it was. " +
    "From an app's page or a run it launched the database is that app's; elsewhere name it with `app`.",
  input: z.object({
    statements: z
      .array(z.union([z.string().min(1), z.object({ sql: z.string().min(1), params: paramsSchema })]))
      .min(1)
      .max(BATCH_MAX)
      .describe("The statements, in order: SQL text, or { sql, params }."),
    app: appSchema,
  }),
  output: z.object({ results: z.array(z.object({ changes: z.number(), lastInsertRowid: z.union([z.number(), z.string()]) })) }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const db = await appDatabase(ctx, cfg.app, "sqlite/batch");
    return runBatch(db, cfg.statements);
  },
});
