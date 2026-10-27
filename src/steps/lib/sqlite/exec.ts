import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { appDatabase, appField, paramsField } from "./_shared.js";

export default defineStep({
  type: "sqlite/exec",
  description:
    "Write to an app's own SQLite database (plans/apps.md §4.4): ONE statement — an INSERT, UPDATE, DELETE, or a CREATE an app keeps out of its migrations — with ? or :name for values. " +
    "Returns { changes, lastInsertRowid }. Several statements that must land together are sqlite/batch; the schema an app's versions rely on belongs in its db/*.sql.",
  effect: "write",
  input: z.object({
    sql: z.string().describe("One statement, with ? or :name for values."),
    params: paramsField,
    app: appField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return (await appDatabase(ctx, "sqlite/exec", cfg.app)).exec(cfg.sql, cfg.params);
  },
});
