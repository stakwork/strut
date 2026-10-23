import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { SHEETS_API, errorResult, serviceAccountField, sheetsCtx } from "./_shared.js";

export default defineStep({
  type: "sheets/add-sheet",
  secrets: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  effect: "write",
  description:
    "Add a new tab to an existing spreadsheet (e.g. a 'Scenarios' tab next to 'Model'). " +
    "Reference its cells from other tabs as 'TabName!A1'.",
  input: z.object({
    spreadsheet_id: z.string().describe("Spreadsheet id."),
    title: z.string().describe("Title of the new tab."),
    serviceAccount: serviceAccountField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { api } = await sheetsCtx(ctx, cfg);
    try {
      const resp = await api(
        "POST",
        `${SHEETS_API}/${encodeURIComponent(cfg.spreadsheet_id)}:batchUpdate`,
        { requests: [{ addSheet: { properties: { title: cfg.title } } }] },
      );
      if (!resp.ok) return errorResult("sheets_add_sheet", resp.status, resp.body);
      const props = resp.body.replies?.[0]?.addSheet?.properties;
      return { sheet_id: props?.sheetId, title: props?.title ?? cfg.title };
    } catch (err: any) {
      return `sheets_add_sheet failed: ${err?.message ?? String(err)}`;
    }
  },
});
