// SheetView's pure parts: A1 notation, every source folded to one table
// model (a Google sheet as `sheets/get-values` reads it, a CSV/TSV/JSON file a
// run wrote, rows handed in), what changed between two reads, and which cells
// a `sources` map marks. No React, no DOM.

/** A cell's place in the sheet, 0-based (`B3` → `{ row: 2, col: 1 }`). */
export interface CellRef {
  row: number;
  col: number;
}

/** One cell as SheetView draws it. */
export interface SheetCell {
  /** What is drawn: the source's display text. */
  text: string;
  /** The value behind it — a number stays a number. */
  value: string | number | boolean | null;
  /** The formula, where the source has one (`=B4/B5`). */
  formula?: string;
  /** Right-aligned: a number, or text that reads as one (`$1,200`, `25%`, `2.50x`). */
  numeric: boolean;
}

export interface SheetTable {
  /** Every row `width` cells long. Row 0 is the header. */
  rows: SheetCell[][];
  width: number;
  /** Where `rows[0][0]` sits in the sheet. */
  origin: CellRef;
}

/** A source folded: its tabs, and the table of the one read. */
export interface SheetBook {
  /** The spreadsheet's own title. */
  title?: string;
  /** Where it opens (a Google sheet's URL, at the tab read). */
  url?: string;
  /** Tab names, in order; one unnamed tab is `[""]`. */
  tabs: string[];
  /** The tab `table` is. */
  tab: string;
  table: SheetTable;
  /** Every tab's table, when the source holds them all (a file, rows); a Google sheet is read one tab at a time. */
  tables?: Record<string, SheetTable>;
  /** A Google sheet's tab ids (`gid`), by name. */
  tabIds?: Record<string, number>;
}

// ── A1 ─────────────────────────────────────────────────────────────────────

/** `A`…`Z`, `AA`… for a 0-based column. */
export function columnLetters(col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** The 0-based column of `A`…`ZZZ`. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const cellA1 = (ref: CellRef) => `${columnLetters(ref.col)}${ref.row + 1}`;

/** One cell (`B3`, `$B$3`), or null. */
export function parseCell(a1: string): CellRef | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a1.trim());
  if (!m || Number(m[2]) < 1) return null;
  return { row: Number(m[2]) - 1, col: columnIndex(m[1]!) };
}

/** A range's tab and its cells: `'Deal Terms'!B2:F9` → `{ tab: "Deal Terms", cells: "B2:F9" }`; a bare tab name is all tab. */
export function splitRange(range: string): { tab?: string; cells: string } {
  const r = range.trim();
  const bang = r.lastIndexOf("!");
  if (bang >= 0) return { tab: unquoteTab(r.slice(0, bang)), cells: r.slice(bang + 1) };
  if (CELLS.test(r) && /\d|:/.test(r)) return { cells: r };
  return { tab: unquoteTab(r), cells: "" };
}

/** Cells alone: `B2`, `B2:F9`, `C:F`, `3:9` — a bare word is a tab's name. */
const CELLS = /^\$?[A-Za-z]{0,3}\$?\d*(:\$?[A-Za-z]{0,3}\$?\d*)?$/;

const unquoteTab = (s: string) => s.replace(/^'(.*)'$/s, "$1").replace(/''/g, "'");

/** A tab name as A1 writes it: always quoted, a quote doubled. */
export const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** The same cells on another tab: (`A1:F40`, `Inputs`) → `'Inputs'!A1:F40`; no cells, the whole tab. */
export function rangeForTab(range: string | undefined, tab: string): string {
  const cells = range ? splitRange(range).cells : "";
  return cells ? `${quoteTab(tab)}!${cells}` : quoteTab(tab);
}

/** Where a range's cells start: `B2:F9` → B2, `C:F` → C1, `3:9` → A3, none → A1. */
export function rangeStart(range: string | undefined): CellRef {
  const first = (range ? splitRange(range).cells : "").split(":")[0] ?? "";
  const m = /^\$?([A-Za-z]{0,3})\$?(\d*)$/.exec(first);
  return { row: m?.[2] ? Number(m[2]) - 1 : 0, col: m?.[1] ? columnIndex(m[1]) : 0 };
}

/** A spreadsheet's id from its id or any of its URLs, with the tab the URL points at. */
export function spreadsheetRef(idOrUrl: string): { id: string; gid?: number } {
  const s = idOrUrl.trim();
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? s;
  const gid = /[#?&]gid=(\d+)/.exec(s)?.[1];
  return gid !== undefined ? { id, gid: Number(gid) } : { id };
}

export const sheetUrl = (id: string, gid?: number) =>
  `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit${gid !== undefined ? `#gid=${gid}` : ""}`;

// ── Cells ──────────────────────────────────────────────────────────────────

const NUMERIC = /^\(?[-+−]?[$€£¥]?\s?(\d{1,3}(,\d{3})+|\d+|\d*\.\d+)(\.\d+)?([eE][-+]?\d+)?\s?(%|x|×)?\)?$/;

/** Text that reads as a number, the way a sheet displays one. */
export const looksNumeric = (text: string) => NUMERIC.test(text.trim());

function numberText(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

/** One cell of any source: a value, or `{ text?, value?, formula? }`. */
export function toCell(v: unknown): SheetCell {
  if (v === null || v === undefined) return { text: "", value: null, numeric: false };
  if (typeof v === "number") return { text: Number.isFinite(v) ? numberText(v) : String(v), value: v, numeric: true };
  if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE", value: v, numeric: false };
  if (typeof v === "string") return { text: v, value: v, numeric: looksNumeric(v) };
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("text" in o || "value" in o || "formula" in o) {
      const inner = toCell(o["value"] ?? null);
      const text = typeof o["text"] === "string" ? o["text"] : inner.text;
      const formula = typeof o["formula"] === "string" && o["formula"] ? o["formula"] : undefined;
      return { text, value: inner.value ?? (text || null), ...(formula ? { formula } : {}), numeric: typeof inner.value === "number" || looksNumeric(text) };
    }
  }
  return { text: JSON.stringify(v), value: JSON.stringify(v), numeric: false };
}

const EMPTY: SheetCell = { text: "", value: null, numeric: false };

/** Rows of cells → a table: trailing empty rows off, every row padded to the widest. */
export function tableOf(rows: SheetCell[][], origin: CellRef = { row: 0, col: 0 }): SheetTable {
  const kept = rows.map((r) => {
    let n = r.length;
    while (n > 0 && !r[n - 1]!.text && !r[n - 1]!.formula) n--;
    return r.slice(0, n);
  });
  while (kept.length && !kept[kept.length - 1]!.length) kept.pop();
  const width = Math.max(0, ...kept.map((r) => r.length));
  return { rows: kept.map((r) => (r.length < width ? [...r, ...Array.from({ length: width - r.length }, () => EMPTY)] : r)), width, origin };
}

/** Records (`[{ provision, risk }]`) or rows (`[["Provision", "Risk"], …]`) → cells; records get a header row of their keys. */
function rowsOf(input: unknown[], columns?: unknown[]): SheetCell[][] {
  if (input.length && input.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const keys: string[] = columns?.map(String) ?? [];
    if (!columns) for (const r of input) for (const k of Object.keys(r as object)) if (!keys.includes(k)) keys.push(k);
    return [keys.map((k) => toCell(k)), ...input.map((r) => keys.map((k) => toCell((r as Record<string, unknown>)[k])))];
  }
  const body = input.map((r) => (Array.isArray(r) ? r.map(toCell) : [toCell(r)]));
  return columns ? [columns.map(toCell), ...body] : body;
}

// ── Sources ────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields, `""` for a quote, CRLF or LF; a BOM and a final newline dropped. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') (field += '"'), i++;
        else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows;
}

const one = (table: SheetTable, extra: Partial<SheetBook> = {}): SheetBook => ({ tabs: [""], tab: "", table, ...extra });

/** What `sheets/get-values` returned — with `grid: true` (tabs, display text, formulas) or without (`{ range, values }`). */
export function fromGetValues(out: unknown, spreadsheetId?: string): SheetBook {
  const o = (out ?? {}) as Record<string, any>;
  const origin = rangeStart(o["range"]);
  if (Array.isArray(o["display"])) {
    const values: unknown[][] = o["values"] ?? [];
    const formulas: Array<Array<string | null>> = o["formulas"] ?? [];
    const rows = (o["display"] as unknown[][]).map((r, i) =>
      r.map((text, j): SheetCell => {
        const value = (values[i]?.[j] ?? null) as SheetCell["value"];
        const formula = formulas[i]?.[j];
        const t = typeof text === "string" ? text : "";
        return { text: t, value, ...(formula ? { formula } : {}), numeric: typeof value === "number" || (typeof value !== "string" && looksNumeric(t)) };
      }),
    );
    const tabs: Array<{ id: number; title: string }> = o["tabs"] ?? [];
    const tab = String(o["sheet"] ?? splitRange(o["range"] ?? "").tab ?? "");
    return {
      ...(o["title"] ? { title: String(o["title"]) } : {}),
      url: typeof o["url"] === "string" ? o["url"] : spreadsheetId ? sheetUrl(spreadsheetId) : undefined,
      tabs: tabs.length ? tabs.map((t) => t.title) : [tab],
      tab,
      table: tableOf(rows, origin),
      tabIds: Object.fromEntries(tabs.map((t) => [t.title, t.id])),
    };
  }
  const tab = splitRange(String(o["range"] ?? "")).tab ?? "";
  return {
    ...(spreadsheetId ? { url: sheetUrl(spreadsheetId) } : {}),
    tabs: [tab],
    tab,
    table: tableOf(rowsOf(Array.isArray(o["values"]) ? o["values"] : []), origin),
  };
}

/**
 * Anything a run might write as a table, or a page hand in: CSV text, rows
 * (arrays) or records (objects), `{ columns?, rows }` (`values`, `data` and
 * `header` too), `{ tabs: [{ name, rows }] }` for several tabs, or what
 * `sheets/get-values` returned.
 */
export function fromRows(input: unknown): SheetBook {
  if (typeof input === "string") return one(tableOf(rowsOf(parseCsv(input))));
  if (Array.isArray(input)) return one(tableOf(rowsOf(input)));
  const o = (input ?? {}) as Record<string, unknown>;
  if (Array.isArray(o["display"]) || (typeof o["range"] === "string" && Array.isArray(o["values"]))) return fromGetValues(o);
  const tabsIn = o["tabs"] ?? o["sheets"];
  if (Array.isArray(tabsIn)) {
    const tables: Record<string, SheetTable> = {};
    const names: string[] = [];
    tabsIn.forEach((t, i) => {
      const tt = (t ?? {}) as Record<string, unknown>;
      const name = String(tt["name"] ?? tt["title"] ?? `Sheet${i + 1}`);
      if (name in tables) return;
      names.push(name);
      tables[name] = fromRows(tt).table;
    });
    if (names.length) return { tabs: names, tab: names[0]!, table: tables[names[0]!]!, tables, ...(typeof o["title"] === "string" ? { title: o["title"] } : {}) };
  }
  const rows = o["rows"] ?? o["values"] ?? o["data"];
  const columns = o["columns"] ?? o["header"];
  if (Array.isArray(rows)) return one(tableOf(rowsOf(rows, Array.isArray(columns) ? columns : undefined)), typeof o["title"] === "string" ? { title: o["title"] } : {});
  return one(tableOf([]));
}

/** A file a run wrote: `.json` parsed, `.tsv` split on tabs, anything else read as CSV. */
export function fromFile(path: string, text: string): SheetBook {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === "json") return fromRows(JSON.parse(text));
  return one(tableOf(rowsOf(parseCsv(text, ext === "tsv" ? "\t" : ","))));
}

// ── Reads over time ────────────────────────────────────────────────────────

/** What changed since the last read: cells by `"row:col"` (in `next`'s rows), and rows that are new. */
export interface SheetChanges {
  cells: Set<string>;
  rows: Set<number>;
}

export const cellKey = (row: number, col: number) => `${row}:${col}`;

/** A row's key: its first cell's text. */
export const rowKey = (table: SheetTable, row: number) => (table.rows[row]?.[0]?.text ?? "").trim();

/** The body rows (row 0 is the header) by key, when every one has a key of its own. */
function keyed(table: SheetTable): Map<string, number> | null {
  const m = new Map<string, number>();
  for (let r = 1; r < table.rows.length; r++) {
    const k = rowKey(table, r);
    if (!k || m.has(k)) return null;
    m.set(k, r);
  }
  return m;
}

/**
 * What `next` changed of `prev`. Rows are matched by their key (the first
 * column) when every row has its own — so a row written above the others
 * reads as one new row, not every row below it changed — else by position.
 * A first read, or a read of other cells (another origin), changes nothing.
 */
export function diffTables(prev: SheetTable | undefined, next: SheetTable): SheetChanges {
  const out: SheetChanges = { cells: new Set(), rows: new Set() };
  if (!prev || prev.origin.row !== next.origin.row || prev.origin.col !== next.origin.col) return out;
  const before = keyed(prev);
  const after = before && keyed(next);
  for (let r = 0; r < next.rows.length; r++) {
    const p = r === 0 || !after ? prev.rows[r] : prev.rows[before!.get(rowKey(next, r)) ?? -1];
    if (!p) {
      out.rows.add(r);
      continue;
    }
    next.rows[r]!.forEach((cell, c) => {
      const was = p[c] ?? EMPTY;
      if (was.text !== cell.text || (was.formula ?? "") !== (cell.formula ?? "")) out.cells.add(cellKey(r, c));
    });
  }
  return out;
}

/**
 * Which cells of `tab` a `sources` map marks: a key is a cell (`C4`,
 * `'Deal Terms'!C4` — the sheet's own address, wherever the range starts) or
 * a row's key (its first column's text, marked on that cell). A key that
 * names no tab is `home`'s, the tab the view opened on. The refs of keys that
 * land on one cell are merged.
 */
export function resolveSources(table: SheetTable, sources: Record<string, readonly string[]> | undefined, tab = "", home = tab): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (row: number, col: number, refs: readonly string[]) => {
    const k = cellKey(row, col);
    out.set(k, [...new Set([...(out.get(k) ?? []), ...refs])]);
  };
  for (const [key, refs] of Object.entries(sources ?? {})) {
    if (!refs?.length) continue;
    const { tab: on, cells } = splitRange(key);
    const at = parseCell(cells);
    if (at) {
      if ((on ?? home) !== tab) continue;
      const row = at.row - table.origin.row;
      const col = at.col - table.origin.col;
      if (row >= 0 && col >= 0 && row < table.rows.length && col < table.width) add(row, col, refs);
      continue;
    }
    if (home !== tab) continue;
    const want = key.trim();
    let hit = table.rows.findIndex((_, r) => rowKey(table, r) === want);
    if (hit < 0) hit = table.rows.findIndex((_, r) => rowKey(table, r).toLowerCase() === want.toLowerCase());
    if (hit >= 0) add(hit, 0, refs);
  }
  return out;
}

/** The table has a formula somewhere. */
export const hasFormulas = (table: SheetTable) => table.rows.some((r) => r.some((c) => c.formula));
