import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { SHEETS_API, errorResult, serviceAccountField, sheetsCtx } from "./_shared.js";
import { StepFailure, stepFailed } from "../../../public-call.js";

/** `grid: true` asks one `spreadsheets.get` for the title, every tab, and
 *  per cell its display text, value and formula — one request, so a page
 *  polling a sheet as a run fills it stays inside Google's read quota
 *  (60 a minute for one service account). */
const GRID_FIELDS =
  "spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden)," +
  "data(startRow,startColumn,rowData(values(formattedValue,effectiveValue,userEnteredValue(formulaValue)))))";

type Value = string | number | boolean | null;

/** `A`, …, `Z`, `AA`, … for a 0-based column. */
function columnLetters(col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** The tab a range names (`'Deal Terms'!A1:F9` → `Deal Terms`), if it names one. */
function tabOf(range: string): string | undefined {
  const bang = range.lastIndexOf("!");
  // Cells alone (`B2:F9`, `C:F`) name no tab; a bare word is one.
  const cellsOnly = /^\$?[A-Za-z]{0,3}\$?\d*(:\$?[A-Za-z]{0,3}\$?\d*)?$/.test(range) && /\d|:/.test(range);
  const name = bang >= 0 ? range.slice(0, bang) : cellsOnly ? "" : range;
  return name ? name.replace(/^'(.*)'$/, "$1").replace(/''/g, "'") : undefined;
}

function effective(v: any): Value {
  if (!v || typeof v !== "object") return null;
  if (typeof v.numberValue === "number") return v.numberValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (v.errorValue) return String(v.errorValue.type ?? "#ERROR");
  return null;
}

/** Trailing empty cells and rows off, as `values.get` returns them. */
function trim<T>(rows: T[][], empty: (v: T) => boolean): T[][] {
  const out = rows.map((r) => {
    let n = r.length;
    while (n > 0 && empty(r[n - 1]!)) n--;
    return r.slice(0, n);
  });
  while (out.length && !out[out.length - 1]!.length) out.pop();
  return out;
}

/** The grid read (`grid: true`): the tab the range named, else the first. */
export function foldGrid(body: any, spreadsheetId: string, range: string) {
  const sheets: any[] = body?.sheets ?? [];
  const named = tabOf(range);
  const sheet =
    (named !== undefined ? sheets.find((s) => s.properties?.title === named) : undefined) ??
    sheets.find((s) => s.data?.some((d: any) => d?.rowData?.length)) ??
    sheets.find((s) => !s.properties?.hidden);
  const data = sheet?.data?.[0] ?? {};
  const startRow: number = data.startRow ?? 0;
  const startCol: number = data.startColumn ?? 0;
  const values: Value[][] = [];
  const display: string[][] = [];
  const formulas: Array<Array<string | null>> = [];
  for (const row of data.rowData ?? []) {
    const cells: any[] = row?.values ?? [];
    values.push(cells.map((c) => effective(c?.effectiveValue)));
    display.push(cells.map((c) => (typeof c?.formattedValue === "string" ? c.formattedValue : "")));
    formulas.push(cells.map((c) => (typeof c?.userEnteredValue?.formulaValue === "string" ? c.userEnteredValue.formulaValue : null)));
  }
  const shown = trim(display, (v) => v === "");
  const height = shown.length;
  const width = Math.max(0, ...shown.map((r) => r.length));
  const title: string = sheet?.properties?.title ?? named ?? "";
  const sheetId: number | undefined = sheet?.properties?.sheetId;
  const tab = `'${title.replace(/'/g, "''")}'`;
  const start = `${columnLetters(startCol)}${startRow + 1}`;
  const anyFormula = formulas.some((r) => r.some((f) => f !== null));
  return {
    spreadsheet_id: body?.spreadsheetId ?? spreadsheetId,
    title: body?.properties?.title as string | undefined,
    url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(body?.spreadsheetId ?? spreadsheetId)}/edit${sheetId !== undefined ? `#gid=${sheetId}` : ""}`,
    sheet: title,
    sheetId,
    tabs: sheets.filter((s) => !s.properties?.hidden).map((s) => ({ id: s.properties?.sheetId as number, title: String(s.properties?.title ?? "") })),
    range: height && width ? `${tab}!${start}:${columnLetters(startCol + width - 1)}${startRow + height}` : `${tab}!${start}`,
    values: values.slice(0, height).map((r, i) => r.slice(0, shown[i]!.length)),
    display: shown,
    ...(anyFormula ? { formulas: formulas.slice(0, height).map((r, i) => r.slice(0, shown[i]!.length)) } : {}),
  };
}

export default defineStep({
  type: "sheets/get-values",
  secrets: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  effect: "read",
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
    grid: z
      .boolean()
      .optional()
      .describe(
        "Read the range the way a page draws it, in one request: the spreadsheet's title and url, its tabs, " +
          "and per cell `values` (computed), `display` (formatted text) and `formulas` (null where none); " +
          "an empty `range` reads the first tab whole. " +
          "`render` is ignored. For a viewer (strut/views' SheetView); reading numbers, leave it off.",
      ),
    serviceAccount: serviceAccountField,
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { api } = await sheetsCtx(ctx, cfg);
    try {
      if (cfg.grid) {
        const base = `${SHEETS_API}/${encodeURIComponent(cfg.spreadsheet_id)}`;
        let range = cfg.range.trim();
        if (!range) {
          // No range: the first tab, whole — its name read first.
          const meta = await api("GET", `${base}?fields=${encodeURIComponent("sheets(properties(title,hidden))")}`);
          if (!meta.ok) return errorResult("sheets_get_values", meta.status, meta.body);
          const first = meta.body?.sheets?.find((s: any) => !s?.properties?.hidden)?.properties?.title;
          if (typeof first !== "string") return stepFailed("sheets_get_values failed: the spreadsheet has no tab to read");
          range = `'${first.replace(/'/g, "''")}'`;
        }
        const resp = await api("GET", `${base}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(GRID_FIELDS)}`);
        if (!resp.ok) return errorResult("sheets_get_values", resp.status, resp.body);
        return foldGrid(resp.body, cfg.spreadsheet_id, range);
      }
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
      if (err instanceof StepFailure) throw err;
      return stepFailed(`sheets_get_values failed: ${err?.message ?? String(err)}`);
    }
  },
});
