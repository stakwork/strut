import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import {
  DRIVE_API,
  SHEETS_API,
  driveFolderIdField,
  errorResult,
  serviceAccountField,
  sheetsCtx,
} from "./_shared.js";

const spreadsheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

export default defineStep({
  type: "sheets/create-spreadsheet",
  secrets: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  effect: "write",
  description:
    "Create a new Google Spreadsheet and return its spreadsheet_id and url. " +
    "When a shared Drive folder is configured (GOOGLE_DRIVE_FOLDER_ID), it is created inside " +
    "that folder, so the user can open it immediately. " +
    "Start here for any calculation task, then write inputs and formulas with sheets_update_values. " +
    "Every spreadsheet starts with one tab named 'Sheet1'; pass extra_sheet_titles to add more tabs up front.",
  input: z.object({
    title: z.string().describe("Spreadsheet title shown in Drive."),
    extra_sheet_titles: z
      .array(z.string())
      .optional()
      .describe("Additional tabs to create beyond the default 'Sheet1'."),
    serviceAccount: serviceAccountField,
    driveFolderId: driveFolderIdField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { api, driveFolderId, clientEmail } = await sheetsCtx(ctx, cfg);
    // A 403/404 here almost always means the folder isn't shared with the SA.
    const shareHint = driveFolderId
      ? ` (if this is a permission error, share the Drive folder ${driveFolderId} with the service account's client_email ${clientEmail})`
      : "";
    try {
      let spreadsheetId: string;
      if (driveFolderId) {
        // Creating through Drive places the file directly in the shared
        // folder (a Sheets-API create would land in the service account's
        // own root Drive, invisible to the user).
        const resp = await api("POST", `${DRIVE_API}?supportsAllDrives=true`, {
          name: cfg.title,
          mimeType: "application/vnd.google-apps.spreadsheet",
          parents: [driveFolderId],
        });
        if (!resp.ok) {
          return errorResult("sheets_create_spreadsheet", resp.status, resp.body) + shareHint;
        }
        spreadsheetId = resp.body.id;
      } else {
        const resp = await api("POST", SHEETS_API, { properties: { title: cfg.title } });
        if (!resp.ok) return errorResult("sheets_create_spreadsheet", resp.status, resp.body);
        spreadsheetId = resp.body.spreadsheetId;
      }

      if (cfg.extra_sheet_titles && cfg.extra_sheet_titles.length > 0) {
        const resp = await api(
          "POST",
          `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
          {
            requests: cfg.extra_sheet_titles.map((t) => ({
              addSheet: { properties: { title: t } },
            })),
          },
        );
        if (!resp.ok) {
          return {
            spreadsheet_id: spreadsheetId,
            url: spreadsheetUrl(spreadsheetId),
            warning: errorResult("adding extra sheets", resp.status, resp.body),
          };
        }
      }

      return {
        spreadsheet_id: spreadsheetId,
        url: spreadsheetUrl(spreadsheetId),
        sheets: ["Sheet1", ...(cfg.extra_sheet_titles ?? [])],
      };
    } catch (err: any) {
      return `sheets_create_spreadsheet failed: ${err?.message ?? String(err)}`;
    }
  },
});
