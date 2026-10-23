import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { SHEETS_API, errorResult, serviceAccountField, sheetsCtx, valuesSchema } from "./_shared.js";

export default defineStep({
  type: "sheets/batch-update-values",
  secrets: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  effect: "write",
  description:
    "Write multiple ranges of a spreadsheet in one call — use this instead of repeated " +
    "sheets_update_values when laying out a model (e.g. headers, inputs, and a formula block at once). " +
    "Same formula semantics as sheets_update_values.",
  input: z.object({
    spreadsheet_id: z.string().describe("Spreadsheet id from sheets_create_spreadsheet."),
    data: z
      .array(z.object({ range: z.string(), values: valuesSchema }))
      .describe("One entry per target range."),
    raw: z
      .boolean()
      .optional()
      .describe("Store strings literally instead of parsing formulas/numbers/dates (default false)."),
    serviceAccount: serviceAccountField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { api } = await sheetsCtx(ctx, cfg);
    try {
      const resp = await api(
        "POST",
        `${SHEETS_API}/${encodeURIComponent(cfg.spreadsheet_id)}/values:batchUpdate`,
        { valueInputOption: cfg.raw ? "RAW" : "USER_ENTERED", data: cfg.data },
      );
      if (!resp.ok) return errorResult("sheets_batch_update_values", resp.status, resp.body);
      return {
        total_updated_cells: resp.body.totalUpdatedCells,
        updated_ranges: (resp.body.responses ?? []).map((r: any) => r.updatedRange),
      };
    } catch (err: any) {
      return `sheets_batch_update_values failed: ${err?.message ?? String(err)}`;
    }
  },
});
