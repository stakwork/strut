import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { runExec } from "../../../apps/data.js";
import { appDatabase, appSchema, paramsSchema, withActor } from "./_shared.js";

/** One write on an app's own database (plans/apps.md §4.4). From a page,
 *  kept as a step run with its viewer (§9, src/apps/tools.ts). */
export default defineStep({
  type: "sqlite/exec",
  effect: "write",
  description:
    "Run ONE SQL statement that writes (INSERT, UPDATE, DELETE, CREATE …) on an app's own SQLite database: `{ changes, lastInsertRowid }`. " +
    "Pass values as `params` (`?` or `:name`), never spliced into the text; `{ base64 }` is a blob. Several statements that must all happen or none: sqlite/batch. " +
    "A statement may not open or end a transaction; ATTACH, DETACH, VACUUM INTO, load_extension and PRAGMAs that set anything are refused. " +
    "From an app's page or a run it launched the database is that app's; elsewhere name it with `app`. Tables come from the app's db/*.sql migrations.",
  input: z.object({
    sql: z.string().min(1).describe("One statement, e.g. \"UPDATE invoices SET status = 'paid' WHERE id = ?\"."),
    params: paramsSchema,
    app: appSchema,
  }),
  output: z.object({ changes: z.number(), lastInsertRowid: z.union([z.number(), z.string()]) }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const db = await appDatabase(ctx, cfg.app, "sqlite/exec");
    return runExec(db, cfg.sql, withActor(cfg.sql, cfg.params, ctx?.actor));
  },
});
