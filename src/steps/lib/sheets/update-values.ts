import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { SHEETS_API, errorResult, serviceAccountField, sheetsCtx, valuesSchema } from "./_shared.js";

export default defineStep({
  type: "sheets/update-values",
  description:
    "Write a 2D array of values into a spreadsheet range (A1 notation, e.g. 'Sheet1!A1:C10'). " +
    "Strings starting with '=' are entered as LIVE FORMULAS — prefer building calculations with " +
    "formulas over precomputing numbers yourself, so the sheet stays auditable and recalculates " +
    "when inputs change. Read computed results back with sheets_get_values.",
  input: z.object({
    spreadsheet_id: z.string().describe("Spreadsheet id from sheets_create_spreadsheet."),
    range: z.string().describe("A1-notation target range, e.g. 'Sheet1!A1' or 'Model!B2:D20'."),
    values: valuesSchema,
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
      const input = cfg.raw ? "RAW" : "USER_ENTERED";
      const resp = await api(
        "PUT",
        `${SHEETS_API}/${encodeURIComponent(cfg.spreadsheet_id)}/values/${encodeURIComponent(cfg.range)}?valueInputOption=${input}`,
        { values: cfg.values },
      );
      if (!resp.ok) return errorResult("sheets_update_values", resp.status, resp.body);
      const { updatedRange, updatedCells } = resp.body;
      return { updated_range: updatedRange, updated_cells: updatedCells };
    } catch (err: any) {
      return `sheets_update_values failed: ${err?.message ?? String(err)}`;
    }
  },
});
