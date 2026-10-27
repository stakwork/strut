import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { QUERY_CHARS_MAX, QUERY_ROWS_MAX } from "../../../apps/sqlite.js";
import { appDatabase, appField, paramsField } from "./_shared.js";

export default defineStep({
  type: "sqlite/query",
  description:
    "Read an app's own SQLite database (plans/apps.md §4.4): ONE statement, on a read-only connection, so nothing it says can write. " +
    `Returns { columns, rows } — rows as objects keyed by column, bytes as { base64 } — at most ${QUERY_ROWS_MAX} rows or ${QUERY_CHARS_MAX / 1024 / 1024} MB, with truncated: true past that. ` +
    "The tables are the ones the app's db/*.sql migrations created. Writes are sqlite/exec and sqlite/batch.",
  effect: "read",
  input: z.object({
    sql: z.string().describe("One SELECT (or a read PRAGMA such as table_info), with ? or :name for values."),
    params: paramsField,
    app: appField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return (await appDatabase(ctx, "sqlite/query", cfg.app)).query(cfg.sql, cfg.params);
  },
});
