import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Sheet, SquareFunction } from "lucide-react";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { isInFlight, useHost, useRun, useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import type { GraphNode } from "../lib/graph";
import type { RunFile } from "../lib/run-file";
import {
  cellA1, cellKey, diffTables, fromFile, fromGetValues, fromRows, hasFormulas, rangeForTab, resolveSources, spreadsheetRef,
  type SheetBook, type SheetCell, type SheetChanges, type SheetTable,
} from "../lib/sheet";
import { NodeCard } from "./NodeCard";

/** The step a Google sheet is read through — the importing app grants it in `grants.steps`. */
export const SHEETS_STEP = "sheets/get-values";
/** How often a live sheet is read: one request each, under Google's 60 reads a minute per service account. */
export const SHEET_INTERVAL_MS = 3_000;

export interface SheetViewProps {
  /** A Google Sheet, by id or URL (`sheets/get-values` in `grants.steps`)… */
  spreadsheet?: string;
  /** …and what of it: `'Deal Terms'!A1:H40`, `A1:H40` (the first tab), a tab's name; none, the first tab whole. The tab strip reads the same cells on another tab. */
  range?: string;
  /** Or a CSV, TSV or JSON table in the run's files (`run/files`, the run's workflow in `grants.workflows`)… */
  path?: string;
  /** …or the rows: CSV text, rows, records, `{ columns, rows }`, `{ tabs: [{ name, rows }] }`. A new array is a new read. */
  rows?: unknown;
  /** The run that writes the sheet (and holds `path`): read again every `intervalMs` while it is in flight, and once when it ends (`run/get`, `grants.workflows`). */
  workflow?: string;
  runId?: string;
  /** Read again every `intervalMs` whatever any run is doing. */
  live?: boolean;
  /** Read again whenever this changes. */
  refresh?: unknown;
  intervalMs?: number;
  /** How long a changed cell stays lit. */
  highlightMs?: number;
  /** Where each cell came from: a cell (`C4`, `'Deal Terms'!C4` — the sheet's own address) or a row's key (its first column's text) → graph ref_ids. A marked cell opens their NodeCards (`graph/graph-get-batched`). */
  sources?: Record<string, string[]>;
  /** A node in a marked cell's card was clicked. */
  onOpenNode?: (node: GraphNode) => void;
  /** Over the source's own title. */
  title?: string;
  /** The grid's height before it scrolls (default 28rem). */
  maxHeight?: number | string;
  className?: string;
}

/** A step answers a problem as a string (a Sheets API error, no credentials): make it one. */
function answer<T>(v: unknown): T {
  if (typeof v === "string") throw new Error(v);
  return v as T;
}

interface Read {
  /** Which source: a change of it is a new sheet, never a change to diff. */
  key: string;
  /** `undefined` while the first read is out; `null`, a run's file not written yet. */
  book: SheetBook | null | undefined;
  /** The tab a URL's `#gid=` points at. */
  gid?: number;
  truncated?: boolean;
  q?: UseQueryResult<unknown>;
}

/** The book, from whichever source the props name. */
function useBook(p: SheetViewProps, tab: string | undefined, polling: boolean, intervalMs: number): Read {
  const client = useStrutClient();
  const ref = p.spreadsheet ? spreadsheetRef(p.spreadsheet) : undefined;
  const range = tab !== undefined ? rangeForTab(p.range, tab) : (p.range ?? "");
  const sheet = useQuery({
    queryKey: ["strut", SHEETS_STEP, ref?.id, range],
    queryFn: async () => fromGetValues(answer(await client.run(SHEETS_STEP, { spreadsheet_id: ref!.id, range, grid: true })), ref!.id),
    enabled: !!ref,
    refetchInterval: polling ? intervalMs : false,
    // Another tab keeps the last one's book (its tab strip) until it is read.
    placeholderData: keepPreviousData,
  });
  const fileWanted = !ref && !!p.path && !!p.workflow && !!p.runId;
  const file = useQuery({
    queryKey: ["strut", "run/files", p.workflow, p.runId, p.path, "sheet"],
    queryFn: async () => {
      const f = await client.run<RunFile | null>("run/files", { workflow: p.workflow, runId: p.runId, path: p.path });
      if (!f) return null;
      if (f.text === undefined) throw new Error(`${p.path} is not a table (${f.mediaType}).`);
      return { book: fromFile(p.path!, f.text), truncated: !!f.truncated };
    },
    enabled: fileWanted,
    refetchInterval: polling ? intervalMs : false,
  });
  const given = useMemo(() => (!ref && !p.path && p.rows !== undefined ? fromRows(p.rows) : undefined), [ref, p.path, p.rows]);
  if (ref) return { key: `sheet:${ref.id}`, gid: ref.gid, book: sheet.data, q: sheet };
  if (fileWanted) return { key: `file:${p.runId}/${p.path}`, book: file.data === null ? null : file.data?.book, truncated: file.data?.truncated, q: file };
  return { key: "rows", book: given };
}

/**
 * A spreadsheet drawn in the page — the work product itself, filling in as a
 * workflow writes it. Three sources: a Google Sheet read through
 * `sheets/get-values { grid: true }` (one request a read: the tabs, each
 * cell's display text, value and formula), a CSV/TSV/JSON table a run wrote
 * (`run/files`), or rows handed in. It reads again while the run that writes
 * it is in flight (`workflow` + `runId`), on `live`, or when `refresh`
 * changes, and lights the cells and rows each read changed. The header row
 * and the first column stay put while the rest scrolls inside the component;
 * numbers sit right; a cell with a formula shows it when selected, or all of
 * them with fx. `sources` marks the cells a work product cites: a click opens
 * the graph nodes they came from. An app may not frame Google, so the sheet
 * is drawn here and "Open in Google Sheets" asks the host to open it.
 */
export function SheetView(props: SheetViewProps) {
  const { workflow, runId, live, refresh, sources, onOpenNode, title, className } = props;
  const intervalMs = props.intervalMs ?? SHEET_INTERVAL_MS;
  const highlightMs = props.highlightMs ?? 2_500;
  const host = useHost();
  const run = useRun(workflow ?? "", runId, { live: true, enabled: !!workflow && !!runId });
  const inFlight = isInFlight(run.data);
  const polling = !!live || inFlight;
  const [tab, setTab] = useState<string | undefined>();
  const [sel, setSel] = useState<{ row: number; col: number } | null>(null);
  const [formulas, setFormulas] = useState(false);
  const { key, gid, book, truncated, q } = useBook(props, tab, polling, intervalMs);
  const refetch = q?.refetch;

  // One more read when the run ends (its last writes), and on each new `refresh`.
  const wasInFlight = useRef(false);
  useEffect(() => {
    if (wasInFlight.current && !inFlight) void refetch?.();
    wasInFlight.current = inFlight;
  }, [inFlight, refetch]);
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) return void (firstRefresh.current = false);
    void refetch?.();
  }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // A URL's #gid= names the tab to open on.
  useEffect(() => {
    if (tab !== undefined || gid === undefined || !book?.tabIds) return;
    const named = Object.entries(book.tabIds).find(([, id]) => id === gid)?.[0];
    if (named !== undefined && named !== book.tab) setTab(named);
  }, [tab, gid, book]);

  const shown = tab ?? book?.tab ?? "";
  const table = book ? (book.tables?.[shown] ?? (book.tab === shown ? book.table : undefined)) : undefined;
  // The tab the view opened on: a `sources` key that names no tab is its.
  const home = useRef<{ key: string; tab: string } | null>(null);
  if (book && tab === undefined && home.current?.key !== key) home.current = { key, tab: book.tab };
  // Another source starts on its own first tab.
  const source = useRef(key);
  useEffect(() => {
    if (source.current === key) return;
    source.current = key;
    setTab(undefined);
    setSel(null);
  }, [key]);

  // What each read changed, lit for `highlightMs`.
  const last = useRef<{ at: string; table: SheetTable } | null>(null);
  const [flash, setFlash] = useState<SheetChanges | null>(null);
  useEffect(() => {
    if (!table) return;
    const at = `${key}|${shown}`;
    const before = last.current?.at === at ? last.current.table : undefined;
    last.current = { at, table };
    if (before === table) return;
    const d = before ? diffTables(before, table) : null;
    setFlash(d && (d.cells.size || d.rows.size) ? d : null);
  }, [table, key, shown]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), highlightMs);
    return () => clearTimeout(t);
  }, [flash, highlightMs]);

  const marks = useMemo(() => (table ? resolveSources(table, sources, shown, home.current?.tab) : new Map<string, string[]>()), [table, sources, shown]);
  const withFormulas = !!table && hasFormulas(table);
  const name = title ?? book?.title ?? props.path?.split("/").pop();
  const selected = sel && table?.rows[sel.row]?.[sel.col];

  const error = q?.isError ? errorText(q.error) : null;
  if (book === undefined && !error) return <Skeleton className={cn("h-48 w-full", className)} />;

  return (
    <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-sm", className)} data-testid="sheet-view">
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-1.5">
        <Sheet className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {polling && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title={`Read every ${Math.round(intervalMs / 1000)} s while ${live ? "live" : "the run is in flight"}`} data-testid="sheet-live">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live
          </span>
        )}
        {withFormulas && (
          <Button variant={formulas ? "secondary" : "ghost"} size="icon-sm" className="size-7" aria-pressed={formulas} aria-label="Show formulas" title="Show formulas" onClick={() => setFormulas((f) => !f)}>
            <SquareFunction />
          </Button>
        )}
        {book?.url && (
          <Button variant="outline" size="xs" onClick={() => void host.openLink(book.url!)}>
            <ExternalLink />
            Open in Google Sheets
          </Button>
        )}
      </div>
      {withFormulas && (
        <div className="flex min-h-8 items-center gap-2 border-b bg-muted/30 px-3 py-1 font-mono text-xs" data-testid="formula-bar">
          <span className="w-12 shrink-0 text-muted-foreground">{sel && table ? cellA1({ row: table.origin.row + sel.row, col: table.origin.col + sel.col }) : ""}</span>
          <SquareFunction className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{selected ? (selected.formula ?? selected.text) : <span className="font-sans text-muted-foreground">Select a cell to see what it holds</span>}</span>
        </div>
      )}
      {error && <p className="border-b px-3 py-1.5 text-xs text-destructive">{error}</p>}
      {table && table.rows.length ? (
        <Grid table={table} flash={flash} marks={marks} showFormulas={formulas} sel={sel} onSelect={setSel} onOpenNode={onOpenNode} maxHeight={props.maxHeight ?? "28rem"} />
      ) : book && !table ? (
        <Skeleton className="m-3 h-40" />
      ) : (
        !error && <p className="px-3 py-6 text-center text-muted-foreground">{polling ? "Waiting for the first rows…" : book === null ? `No file ${props.path} in run ${runId} yet.` : "The sheet is empty."}</p>
      )}
      {truncated && <p className="border-t px-3 py-1 text-xs text-muted-foreground">The file was cut — the rest is in strut.</p>}
      {book && book.tabs.length > 1 && (
        <div className="flex gap-0.5 overflow-x-auto border-t bg-muted/40 px-1" role="tablist" aria-label="Tabs">
          {book.tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === shown}
              onClick={() => (setTab(t), setSel(null))}
              className={cn("shrink-0 rounded-b-md px-3 py-1 text-xs", t === shown ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted")}
            >
              {t || "Sheet1"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface GridProps {
  table: SheetTable;
  flash: SheetChanges | null;
  marks: Map<string, string[]>;
  showFormulas: boolean;
  sel: { row: number; col: number } | null;
  onSelect: (at: { row: number; col: number }) => void;
  onOpenNode?: (node: GraphNode) => void;
  maxHeight: number | string;
}

/** A changed cell: amber over the card, opaque so the sticky row and column stay solid, in either theme. */
const LIT = "bg-[color-mix(in_oklab,oklch(82.8%_0.189_84.429)_30%,var(--card))]";

/** Per column: numbers (most filled body cells are — its header sits right too), and prose (a long cell — kept
 *  wide enough to read, so a wide sheet scrolls sideways rather than squeezing into narrow, tall cells). */
function columnKinds(table: SheetTable): Array<{ numbers: boolean; prose: boolean }> {
  return Array.from({ length: table.width }, (_, c) => {
    const filled = table.rows.slice(1).map((r) => r[c]!).filter((cell) => cell.text);
    return {
      numbers: filled.length > 0 && filled.filter((cell) => cell.numeric).length * 2 > filled.length,
      prose: filled.some((cell) => cell.text.length > 24),
    };
  });
}

function Grid({ table, flash, marks, showFormulas, sel, onSelect, onOpenNode, maxHeight }: GridProps) {
  const kinds = useMemo(() => columnKinds(table), [table]);
  const [header, ...body] = table.rows;
  const cell = (c: SheetCell, row: number, col: number) => {
    const k = cellKey(row, col);
    const lit = !!flash && (flash.rows.has(row) || flash.cells.has(k));
    const refs = marks.get(k);
    const address = cellA1({ row: table.origin.row + row, col: table.origin.col + col });
    const isHead = row === 0;
    const Tag = isHead ? "th" : "td";
    const asFormula = showFormulas && !!c.formula;
    return (
      <Tag
        key={col}
        data-cell={address}
        data-changed={lit || undefined}
        data-sources={refs ? refs.length : undefined}
        title={c.formula && !showFormulas ? c.formula : undefined}
        onClick={() => onSelect({ row, col })}
        className={cn(
          "relative cursor-default border-r border-b px-2 py-1 align-top transition-colors",
          lit ? `${LIT} duration-0` : "duration-1000",
          isHead ? "sticky top-0 z-20 text-left text-xs font-semibold" : "",
          isHead && !lit && "bg-muted",
          col === 0 && "sticky left-0 font-medium",
          col === 0 && (isHead ? "z-30" : "z-10"),
          col === 0 && !isHead && !lit && "bg-card",
          asFormula
            ? "text-left font-mono text-xs whitespace-nowrap text-sky-700 dark:text-sky-400"
            : c.numeric || (isHead && kinds[col]!.numbers)
              ? "text-right whitespace-nowrap tabular-nums"
              : cn("max-w-[22rem] break-words whitespace-pre-wrap", kinds[col]!.prose ? "min-w-[11rem]" : "min-w-[4.5rem]"),
          col === 0 && "min-w-[9rem]",
          sel?.row === row && sel.col === col && "outline-2 -outline-offset-2 outline-primary",
        )}
      >
        {asFormula ? c.formula : c.text}
        {refs && <SourceMarker refs={refs} address={address} onOpenNode={onOpenNode} />}
      </Tag>
    );
  };
  return (
    <div className="overflow-auto" style={{ maxHeight }} data-testid="sheet-grid">
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr>{header!.map((c, col) => cell(c, 0, col))}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i + 1}>{r.map((c, col) => cell(c, i + 1, col))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The corner mark on a cited cell; a click opens the nodes it came from. */
function SourceMarker({ refs, address, onOpenNode }: { refs: string[]; address: string; onOpenNode?: (node: GraphNode) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Sources of ${address}`} className="absolute top-0 right-0 flex size-3.5 items-start justify-end" onClick={(e) => e.stopPropagation()}>
          <span className="size-0 border-t-[7px] border-l-[7px] border-t-sky-500 border-l-transparent" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-96 w-80 flex-col gap-2 overflow-auto p-2" data-testid="sheet-sources">
        <div className="px-1 text-xs text-muted-foreground">
          {address} · {refs.length} source{refs.length === 1 ? "" : "s"}
        </div>
        {refs.map((ref) => (
          <NodeCard key={ref} refId={ref} onOpen={onOpenNode} />
        ))}
      </PopoverContent>
    </Popover>
  );
}
