import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { DRIVE_API, SHEETS_API, serviceAccountField, sheetsCtx, truncate } from "./_shared.js";

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the label used in tab names.
 * - An explicit `label` param always wins.
 * - For converted (non-native) sources, fall back to the Drive filename.
 * - For native Google Sheet sources, fall back to the spreadsheet's own title.
 */
function resolveLabel({
  explicitLabel,
  driveFileName,
  sourceSpreadsheetTitle,
  isNative,
}: {
  explicitLabel?: string;
  driveFileName: string;
  sourceSpreadsheetTitle: string;
  isNative: boolean;
}): string {
  if (explicitLabel) return explicitLabel;
  return isNative ? sourceSpreadsheetTitle : driveFileName;
}

/**
 * Build the raw (pre-collision-check) tab name from label + sheet title.
 * - Single-sheet source → `SOURCE: <label>`
 * - Multi-sheet source  → `SOURCE: <label> — <sheet title>`
 */
function buildTabName(label: string, sheetTitle: string, totalSheets: number): string {
  if (totalSheets === 1) return `SOURCE: ${label}`;
  return `SOURCE: ${label} — ${sheetTitle}`;
}

/**
 * Given a candidate tab name and a Set of already-taken names, return a
 * non-colliding name. If the candidate is already taken, appends " (2)",
 * " (3)", etc., incrementing past any existing suffixes.
 */
function resolveCollisionSuffix(candidate: string, existingNames: Set<string>): string {
  if (!existingNames.has(candidate)) return candidate;
  let n = 2;
  while (existingNames.has(`${candidate} (${n})`)) n++;
  return `${candidate} (${n})`;
}

/**
 * Given a list of formula strings and a list of other sheet titles, returns
 * the subset of titles that are literally referenced in at least one formula
 * (heuristic: `'Title'!` or `Title!` — standard A1 cross-sheet syntax).
 */
function detectCrossSheetFormulaRefs(formulas: string[], sheetTitles: string[]): string[] {
  const referenced: string[] = [];
  for (const title of sheetTitles) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:'${escapedTitle}'|${escapedTitle})!`, "i");
    if (formulas.some((f) => pattern.test(f))) {
      referenced.push(title);
    }
  }
  return referenced;
}

export default defineStep({
  type: "sheets/import-spreadsheet",
  secrets: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  effect: "write",
  description:
    "Import every sheet of a source spreadsheet (uploaded .xlsx or existing Google Sheet) into a " +
    "destination spreadsheet as correctly-named tabs. Source may be any Drive file id; non-native " +
    "files (e.g. .xlsx) are converted to Google Sheets format automatically. Each imported tab is " +
    "named 'SOURCE: <label>' (single-sheet source) or 'SOURCE: <label> — <sheet title>' (multi-sheet). " +
    "Collisions with existing tab names are resolved by auto-appending ' (2)', ' (3)', etc. " +
    "Import is best-effort: one sheet failing does not abort the rest. Returns per-sheet status " +
    "(success / failed / copied_unrenamed) and any formula/range warnings.",
  input: z.object({
    destination_spreadsheet_id: z
      .string()
      .describe("Spreadsheet id of the destination to copy sheets into."),
    source_file_id: z
      .string()
      .describe(
        "Drive file id of the source — may be an uploaded .xlsx or an existing native Google Sheet.",
      ),
    label: z
      .string()
      .optional()
      .describe(
        "Override the label used in tab names. Defaults to the Drive filename (converted) or spreadsheet title (native).",
      ),
    keep_converted_copy: z
      .boolean()
      .optional()
      .describe(
        "When true, the intermediate converted-copy file (for non-native sources) is kept in Drive after import. Default false.",
      ),
    serviceAccount: serviceAccountField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { api } = await sheetsCtx(ctx, cfg);
    const { destination_spreadsheet_id, source_file_id, label, keep_converted_copy } = cfg;
    try {
      // ── Step 1: Fetch Drive metadata for the source file ──────────────
      const metaResp = await api(
        "GET",
        `${DRIVE_API}/${encodeURIComponent(source_file_id)}?supportsAllDrives=true&fields=name,mimeType,parents`,
      );
      if (!metaResp.ok) {
        return `sheets_import_spreadsheet failed: could not fetch source file metadata: HTTP ${metaResp.status}: ${truncate(metaResp.body?.error?.message ?? metaResp.body, 300)}`;
      }
      const sourceMeta: { name: string; mimeType: string; parents?: string[] } = metaResp.body;

      // ── Step 2: Convert if not already a native Google Sheet ──────────
      // tempSpreadsheetId is ONLY the id of the converted copy — never
      // aliased from source_file_id — so the later delete call is
      // unambiguous.
      let tempSpreadsheetId: string | undefined = undefined;
      let workingId: string;

      const SHEETS_MIME = "application/vnd.google-apps.spreadsheet";
      if (sourceMeta.mimeType !== SHEETS_MIME) {
        const parentFolder = sourceMeta.parents?.[0];
        const copyBody: Record<string, unknown> = { mimeType: SHEETS_MIME };
        if (parentFolder) copyBody.parents = [parentFolder];
        const copyResp = await api(
          "POST",
          `${DRIVE_API}/${encodeURIComponent(source_file_id)}/copy?supportsAllDrives=true`,
          copyBody,
        );
        if (!copyResp.ok) {
          return `sheets_import_spreadsheet failed: could not convert source file to Google Sheets: HTTP ${copyResp.status}: ${truncate(copyResp.body?.error?.message ?? copyResp.body, 300)}`;
        }
        // Store in a dedicated variable; NEVER reuse source_file_id.
        tempSpreadsheetId = copyResp.body.id as string;
        workingId = tempSpreadsheetId;
      } else {
        workingId = source_file_id;
      }

      // ── Step 3: Enumerate source sheets ─────────────────────────────
      const srcSheetsResp = await api(
        "GET",
        `${SHEETS_API}/${encodeURIComponent(workingId)}?fields=properties.title,sheets.properties`,
      );
      if (!srcSheetsResp.ok) {
        return `sheets_import_spreadsheet failed: could not read source spreadsheet: HTTP ${srcSheetsResp.status}: ${truncate(srcSheetsResp.body?.error?.message ?? srcSheetsResp.body, 300)}`;
      }
      const sourceSheets: Array<{ sheetId: number; title: string }> = (
        srcSheetsResp.body.sheets ?? []
      ).map((s: any) => ({
        sheetId: s.properties.sheetId as number,
        title: s.properties.title as string,
      }));
      const sourceSpreadsheetTitle: string =
        srcSheetsResp.body.properties?.title ?? sourceMeta.name;

      // ── Step 4: Seed the live title Set from the destination ──────────
      const dstSheetsResp = await api(
        "GET",
        `${SHEETS_API}/${encodeURIComponent(destination_spreadsheet_id)}?fields=sheets.properties.title`,
      );
      if (!dstSheetsResp.ok) {
        return `sheets_import_spreadsheet failed: could not read destination spreadsheet: HTTP ${dstSheetsResp.status}: ${truncate(dstSheetsResp.body?.error?.message ?? dstSheetsResp.body, 300)}`;
      }
      // Single source of truth for collision detection — updated after each rename.
      const existingTitles = new Set<string>(
        (dstSheetsResp.body.sheets ?? []).map((s: any) => s.properties.title as string),
      );

      // ── Step 5: Per-sheet best-effort copy loop ───────────────────────
      const resolvedLabel = resolveLabel({
        explicitLabel: label,
        driveFileName: sourceMeta.name,
        sourceSpreadsheetTitle,
        isNative: sourceMeta.mimeType === SHEETS_MIME,
      });

      const imported: Array<{
        source_sheet: string;
        tab_name: string | null;
        sheet_id: number | null;
        status: "success" | "failed" | "copied_unrenamed";
        error?: string;
      }> = [];

      for (const sheet of sourceSheets) {
        const targetTabName = resolveCollisionSuffix(
          buildTabName(resolvedLabel, sheet.title, sourceSheets.length),
          existingTitles,
        );

        // copyTo
        let copiedSheetId: number;
        try {
          const copyToResp = await api(
            "POST",
            `${SHEETS_API}/${encodeURIComponent(workingId)}/sheets/${sheet.sheetId}:copyTo`,
            { destinationSpreadsheetId: destination_spreadsheet_id },
          );
          if (!copyToResp.ok) {
            imported.push({
              source_sheet: sheet.title,
              tab_name: null,
              sheet_id: null,
              status: "failed",
              error: `copyTo failed: HTTP ${copyToResp.status}: ${truncate(copyToResp.body?.error?.message ?? copyToResp.body, 200)}`,
            });
            continue;
          }
          copiedSheetId = copyToResp.body.sheetId as number;
        } catch (copyErr: any) {
          imported.push({
            source_sheet: sheet.title,
            tab_name: null,
            sheet_id: null,
            status: "failed",
            error: `copyTo threw: ${copyErr?.message ?? String(copyErr)}`,
          });
          continue;
        }

        // rename via batchUpdate
        try {
          const renameResp = await api(
            "POST",
            `${SHEETS_API}/${encodeURIComponent(destination_spreadsheet_id)}:batchUpdate`,
            {
              requests: [
                {
                  updateSheetProperties: {
                    properties: { sheetId: copiedSheetId, title: targetTabName },
                    fields: "title",
                  },
                },
              ],
            },
          );
          if (!renameResp.ok) {
            // Google assigns a default name like "Copy of <original>"
            imported.push({
              source_sheet: sheet.title,
              tab_name: `Copy of ${sheet.title}`,
              sheet_id: copiedSheetId,
              status: "copied_unrenamed",
              error: `rename failed: HTTP ${renameResp.status}: ${truncate(renameResp.body?.error?.message ?? renameResp.body, 200)}`,
            });
            // Do NOT add to existingTitles — we don't know the actual Google-assigned name precisely.
          } else {
            imported.push({
              source_sheet: sheet.title,
              tab_name: targetTabName,
              sheet_id: copiedSheetId,
              status: "success",
            });
            // Update the live title Set immediately so subsequent sheets
            // in this same run see this name as taken.
            existingTitles.add(targetTabName);
          }
        } catch (renameErr: any) {
          imported.push({
            source_sheet: sheet.title,
            tab_name: `Copy of ${sheet.title}`,
            sheet_id: copiedSheetId,
            status: "copied_unrenamed",
            error: `rename threw: ${renameErr?.message ?? String(renameErr)}`,
          });
        }
      }

      // ── Step 6: Cross-sheet formula warnings ─────────────────────────
      const warnings: string[] = [];
      const sourceTitles = sourceSheets.map((s) => s.title);
      const successfulSheets = imported.filter((r) => r.status === "success");

      for (const result of successfulSheets) {
        // Fetch formula cells for this destination sheet
        const formulaResp = await api(
          "GET",
          `${SHEETS_API}/${encodeURIComponent(destination_spreadsheet_id)}/values/${encodeURIComponent(`'${result.tab_name}'`)}?valueRenderOption=FORMULA`,
        );
        if (formulaResp.ok) {
          const cellValues: string[] = (formulaResp.body.values ?? [])
            .flat()
            .filter((v: unknown) => typeof v === "string" && v.startsWith("="));
          // Check formulas against other source sheet titles (not its own)
          const otherTitles = sourceTitles.filter((t) => t !== result.source_sheet);
          const referenced = detectCrossSheetFormulaRefs(cellValues, otherTitles);
          for (const ref of referenced) {
            warnings.push(
              `Tab "${result.tab_name}" contains formula references to source sheet "${ref}", which has been renamed in the destination — cross-sheet references may not resolve correctly.`,
            );
          }
        }
      }
      // Always warn about named/protected range limitation.
      warnings.push(
        "Named ranges and protected ranges defined in the source workbook are not carried over by the Sheets API copyTo operation and are not recreated by this tool.",
      );

      // ── Step 7: Cleanup temp converted file ─────────────────────────
      // converted_copy_deleted is null when no conversion occurred.
      let converted_copy_deleted: boolean | null = null;
      if (tempSpreadsheetId !== undefined) {
        // Safety: tempSpreadsheetId must NEVER equal source_file_id or
        // destination_spreadsheet_id — distinct variables by construction
        // (see Step 2).
        if (!keep_converted_copy) {
          try {
            const deleteResp = await api(
              "DELETE",
              `${DRIVE_API}/${encodeURIComponent(tempSpreadsheetId)}?supportsAllDrives=true`,
            );
            converted_copy_deleted = deleteResp.ok;
          } catch {
            converted_copy_deleted = false;
          }
        } else {
          converted_copy_deleted = false;
        }
      }

      return {
        destination_spreadsheet_id,
        imported,
        converted_copy_deleted,
        warnings,
      };
    } catch (err: any) {
      return `sheets_import_spreadsheet failed: ${err?.message ?? String(err)}`;
    }
  },
});
