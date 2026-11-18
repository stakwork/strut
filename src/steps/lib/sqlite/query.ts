import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { QUERY_ROWS_DEFAULT, QUERY_ROWS_MAX, runQuery } from "../../../apps/data.js";
import { appDatabase, appSchema, paramsSchema, withActor } from "./_shared.js";

/** One read on an app's own database (plans/apps.md §4.4): the kit's
 *  `useSql`. Never kept as a run: a read records nothing. */
export default defineStep({
  type: "sqlite/query",
  effect: "read",
  description:
    "Run ONE SQL statement that reads (SELECT, WITH, a read PRAGMA) on an app's own SQLite database and get its rows: `{ columns, rows, truncated }`, one object per row keyed by column. " +
    `At most \`maxRows\` rows (default ${QUERY_ROWS_DEFAULT}, at most ${QUERY_ROWS_MAX}) and 4 MB; \`truncated: true\` means there were more — page with LIMIT … OFFSET, or aggregate. ` +
    "Pass values as `params` (`?` or `:name`), never spliced into the text. A blob comes back as { base64 }, an integer past 2^53 as text. " +
    "A write here fails: use sqlite/exec or sqlite/batch. ATTACH, DETACH, VACUUM INTO, load_extension and PRAGMAs that set anything are refused. " +
    "The tables are the app's: its db/*.sql migrations make them. From an app's page or a run it launched the database is that app's; elsewhere name it with `app`.",
  input: z.object({
    sql: z.string().min(1).describe("One statement that reads, e.g. \"SELECT id, total FROM invoices WHERE status = ? ORDER BY due\"."),
    params: paramsSchema,
    maxRows: z.number().int().min(1).max(QUERY_ROWS_MAX).optional().describe(`Row cap (default ${QUERY_ROWS_DEFAULT}). Past it, \`truncated: true\`.`),
    app: appSchema,
  }),
  output: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.any())),
    truncated: z.boolean(),
  }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const db = await appDatabase(ctx, cfg.app, "sqlite/query");
    return runQuery(db, cfg.sql, withActor(cfg.sql, cfg.params, ctx?.actor), cfg.maxRows);
  },
});
