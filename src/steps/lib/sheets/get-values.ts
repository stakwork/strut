import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { SHEETS_API, errorResult, serviceAccountField, sheetsCtx } from "./_shared.js";

export default defineStep({
  type: "sheets/get-values",
  description:
    "Read a range of a spreadsheet (A1 notation). render='computed' (default) returns calculated " +
    "numbers — use it to read the results of formulas you wrote; 'formatted' returns display strings " +
    "(currency symbols, rounding); 'formula' returns the formula text itself for auditing.",
  input: z.object({
    spreadsheet_id: z.string().describe("Spreadsheet id."),
    range: z.string().describe("A1-notation range to read, e.g. 'Sheet1!A1:D20'."),
    render: z
      .enum(["computed", "formatted", "formula"])
      .optional()
      .describe("How to render cell values (default 'computed')."),
    serviceAccount: serviceAccountField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { api } = await sheetsCtx(ctx, cfg);
    try {
      const renderOption =
        cfg.render === "formatted"
          ? "FORMATTED_VALUE"
          : cfg.render === "formula"
            ? "FORMULA"
            : "UNFORMATTED_VALUE";
      const resp = await api(
        "GET",
        `${SHEETS_API}/${encodeURIComponent(cfg.spreadsheet_id)}/values/${encodeURIComponent(cfg.range)}?valueRenderOption=${renderOption}`,
      );
      if (!resp.ok) return errorResult("sheets_get_values", resp.status, resp.body);
      return { range: resp.body.range, values: resp.body.values ?? [] };
    } catch (err: any) {
      return `sheets_get_values failed: ${err?.message ?? String(err)}`;
    }
  },
});
