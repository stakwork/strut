/**
 * PROVENANCE — where a thing in a run's output came from, read off the
 * run's own log (plans/spot-check.md): the engine of the spot check.
 *
 * A SUBJECT is what a person picked — a value as shown, and where it is when
 * the viewer knows: a sheet `cell`, a graph `node`, a `file`. The answer is
 * its MOMENTS, oldest first: every tool call or step it passed through, and
 * which way — `wrote` (in what went into the call: a cell, a file, a node, a
 * command, a step's config) or `read` (in what came out: a document, a sheet
 * read, a graph read, a page, a step's output, the run's input). A moment is
 * `exact` when it matched by address, else by content. A `wrote` moment in
 * an agent says `why` (the agent's words before the call) and what it did
 * just `before`.
 *
 * Reads the RAW log: tool inputs whole on `step.start`, tool outputs whole
 * in the agents' transcripts (`messages` on their `step.end`). Pure.
 */
import type { RunEvent } from "./core.js";

export interface ProvenanceSubject {
  /** The thing as shown: a cell's value, a selected passage, a node's name. */
  value?: string;
  /** A sheet range: `FACTS!B13`, `'SOURCE: a.xlsx — Detail'!K2:K248`, `B13`. */
  cell?: string;
  /** The Google Sheet (id or URL), when a run writes several. */
  spreadsheet?: string;
  /** A graph node's ref_id. */
  node?: string;
  /** A file's path or name. */
  file?: string;
}

/** A call an agent made just before a write: what it ran and what it got. */
export interface ProvenanceCall {
  tool: string;
  path: string;
  input: string;
  output?: string;
}

export interface ProvenanceMoment {
  at: string;
  /** The tool call's or step's path in the run. */
  path: string;
  /** The agent that made the call (its step path); absent for a workflow step. */
  agent?: string;
  /** The tool (`sheets_update_values`, `bash`), or the step's type. */
  tool: string;
  toolCallId?: string;
  /** `wrote`: it went into something the call wrote (a cell, a file, a node,
   *  a writing step); `used`: into anything else the call was given (a
   *  command, a query, a prompt, a step's config); `read`: it came out. */
  kind: "wrote" | "used" | "read";
  /** Matched by address (the cell, the node, the file), not by content. */
  exact: boolean;
  /** Where, in words: a cell, a file, a command, a node, a page. */
  where: string;
  /** The sheet cell the value sits in at this moment, when known. */
  cell?: string;
  /** The graph node of this moment, when the call named one. */
  node?: { ref_id: string; name?: string; node_type?: string };
  /** The file of this moment, when known. */
  file?: string;
  /** What the cell held at this moment: written, or read back. */
  value?: string;
  /** The text around the match. */
  snippet: string;
  /** Cells the snippet cites (`FACTS!B93`): a writer often cites the cell beside the number. */
  cites?: string[];
  /** A call an agent made (`wrote`, `used`): its words before the call. */
  why?: string;
  /** `wrote` in an agent: the calls it made just before this one. */
  before?: ProvenanceCall[];
}

export interface Provenance {
  subject: ProvenanceSubject;
  moments: ProvenanceMoment[];
  /** Cells a formula reads, or a text cites (`FACTS!B92`): each a subject of its own. */
  refs: string[];
  /** Numbers typed into the formula: no cell behind them. */
  literals: string[];
  /** The formula the cell holds, when it holds one. */
  formula?: string;
  /** Numbers in a passage (`247`, `$54,853`): each a subject of its own. */
  figures: string[];
  /** Moments left out past the cap. */
  omitted?: number;
  /** What the search could not do, in words. */
  note?: string;
}

/** The most moments returned; every exact one is kept first. */
export const PROVENANCE_MAX_MOMENTS = 60;
const SNIPPET = 240;
const WHY_MAX = 1200;
const BEFORE_CALLS = 3;
const BEFORE_INPUT = 300;
const BEFORE_OUTPUT = 600;

/** Steps whose input or output only repeats other steps'. */
const SKIPPED_STEPS = new Set(["if", "loop", "foreach", "subflow", "pack", "log", "wait"]);
const GRAPH_WRITE_RE = /(^|[/_-])(create|edit|update|delete|remove|write|merge|upsert|register|move)([/_-]|$)/;
const SHEET_WRITE_RE = /^sheets[_/-](update|batch[_-]update|append)/;
const SHEET_READ_RE = /^sheets[_/-]get[_-]values/;
const EDIT_TOOL = "str_replace_based_edit_tool";

// ── Sheet addresses ─────────────────────────────────────────────────────────

interface Range {
  /** The tab, unquoted; null when the range names none. */
  tab: string | null;
  c1: number;
  r1: number;
  /** Inclusive; Infinity for an open end (`A:A`, a tab alone). */
  c2: number;
  r2: number;
}

const colNumber = (letters: string) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = (n: number) => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** `'Tab'!A1:B2`, `Tab!A1`, `A1`, `A:A`, `Tab` → a range; null for anything else. */
export function parseRange(text: string): Range | null {
  const s = text.trim();
  const bang = s.lastIndexOf("!");
  let tab: string | null = null;
  let rest = s;
  if (bang >= 0) {
    const t = s.slice(0, bang);
    tab = t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t;
    rest = s.slice(bang + 1);
  }
  const m = /^\$?([A-Za-z]{1,3})\$?(\d*)(?::\$?([A-Za-z]{1,3})\$?(\d*))?$/.exec(rest);
  if (!m) {
    // A tab alone: the whole tab.
    if (bang < 0 && s && !/[!:]/.test(s)) return { tab: s.replace(/^'|'$/g, ""), c1: 1, r1: 1, c2: Infinity, r2: Infinity };
    return null;
  }
  const c1 = colNumber(m[1]!);
  const r1 = m[2] ? Number(m[2]) : 1;
  const c2 = m[3] ? colNumber(m[3]) : m[2] ? c1 : c1;
  const r2 = m[3] ? (m[4] ? Number(m[4]) : Infinity) : m[2] ? r1 : Infinity;
  return { tab, c1, r1, c2, r2 };
}

/** A cell's address as written in a formula: `FACTS!B13`, `'SOURCE: x'!K2`. */
export function cellAddress(tab: string | null, col: number, row: number): string {
  const a1 = `${colLetters(col)}${row}`;
  if (!tab) return a1;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tab) ? `${tab}!${a1}` : `'${tab.replace(/'/g, "''")}'!${a1}`;
}

const sameTab = (a: string | null, b: string | null) => a === null || b === null || a === b;
const overlaps = (a: Range, b: Range) => sameTab(a.tab, b.tab) && a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2;

interface SheetCellValue {
  address: string;
  tab: string | null;
  col: number;
  row: number;
  value: string;
}

/** Each cell of `values` laid out from the range's top-left corner. */
function cellsOf(range: Range, values: unknown): SheetCellValue[] {
  if (!Array.isArray(values)) return [];
  const out: SheetCellValue[] = [];
  values.forEach((row, ri) => {
    if (!Array.isArray(row)) return;
    row.forEach((v, ci) => {
      const col = range.c1 + ci;
      const r = range.r1 + ri;
      out.push({ address: cellAddress(range.tab, col, r), tab: range.tab, col, row: r, value: v == null ? "" : typeof v === "string" ? v : JSON.stringify(v) });
    });
  });
  return out;
}

/** The `{ range, values }` blocks a sheet call wrote (its input) or read (its result). */
function sheetBlocks(v: unknown): Array<{ range: Range; values: unknown; spreadsheet?: string }> {
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  const id = typeof o["spreadsheet_id"] === "string" ? o["spreadsheet_id"] : undefined;
  const one = (r: unknown, values: unknown) => {
    const range = typeof r === "string" ? parseRange(r) : null;
    return range ? [{ range, values, ...(id ? { spreadsheet: id } : {}) }] : [];
  };
  if (Array.isArray(o["data"])) return (o["data"] as Array<Record<string, unknown>>).flatMap((d) => (d && typeof d === "object" ? one(d["range"], d["values"]) : []));
  // A grid read (`grid: true`) answers each cell's formula beside its value.
  if (Array.isArray(o["formulas"])) return [...one(o["range"], o["values"]), ...one(o["range"], o["formulas"])];
  return one(o["range"], o["values"]);
}

const spreadsheetId = (s: string | undefined) => (s ? (/\/d\/([\w-]+)/.exec(s)?.[1] ?? s.trim()) : undefined);

// ── Formulas and cited cells ────────────────────────────────────────────────

const REF_RE = /(?<![A-Za-z0-9_.$'])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_]*)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)(?![A-Za-z0-9_(])/g;

/** The cells a formula reads (unqualified ones on `tab`) and the numbers typed into it. */
export function formulaParts(formula: string, tab: string | null): { refs: string[]; literals: string[] } {
  const body = formula.replace(/"(?:[^"]|"")*"/g, '""');
  const refs: string[] = [];
  const stripped = body.replace(REF_RE, (_m, qual: string | undefined, a1: string) => {
    const t = qual ? qual.slice(0, -1) : tab ? cellAddress(tab, 1, 1).replace(/!A1$/, "") : null;
    refs.push(t ? `${t}!${a1.replace(/\$/g, "")}` : a1.replace(/\$/g, ""));
    return " ";
  });
  const literals = [...stripped.matchAll(/(?<![A-Za-z_\d.])\d+(?:\.\d+)?(?![\d(])/g)].map((m) => m[0]);
  return { refs: [...new Set(refs)], literals: [...new Set(literals)] };
}

/** The cells a passage cites by sheet (`FACTS!B92`): only tab-qualified ones, so prose like "B12" is not read as one. */
export function citedCells(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) if (m[1]) out.push(`${m[1]}${m[2]!.replace(/\$/g, "")}`);
  return [...new Set(out)];
}

// ── Matching a value by its text ────────────────────────────────────────────

const QUOTES: Array<[RegExp, string]> = [
  [/[‘’‛′]/g, "'"],
  [/[“”‟″]/g, '"'],
  [/[–—−]/g, "-"],
  [/ /g, " "],
];
/** One spelling for what a writer may spell several ways: quotes, dashes, spaces — and
 *  the escapes of source code an agent wrote the text into (`\u201c`, `\"`, `\n`). */
export function normalizeText(s: string): string {
  let out = s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  for (const [re, to] of QUOTES) out = out.replace(re, to);
  return out.replace(/\\(["'])/g, "$1").replace(/\\n/g, " ").replace(/\s+/g, " ");
}

/** The numbers a passage states, each long enough to search for (`$54,853`, `247`, `2.19`). */
export function figuresIn(text: string): string[] {
  const out = [...normalizeText(text).matchAll(/(?<![\w.])[$€£]?\d[\d,]*(?:\.\d+)?%?(?![\w])/g)].map((m) => m[0].replace(/[.,]$/, ""));
  return [...new Set(out.filter((f) => needleOf(f) !== null))];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NUMBER_RE = /^[($€£]?\s*-?\$?\s*\d[\d,]*(?:\.\d+)?\s*%?\)?$/;

/**
 * What to search for: a number in any spelling (`$54,853` finds `54853.4413`
 * and `54,853.44`), a passage by up to three windows of it (a long sentence
 * is often split in the source that wrote it). Null when the value is too
 * short to tell from noise (`11`, `3`, `TRUE`).
 */
export function needleOf(value: string): RegExp | null {
  const v = normalizeText(value).trim().replace(/^["']|["']$/g, "").trim();
  if (!v) return null;
  if (NUMBER_RE.test(v)) {
    const [int = "", frac = ""] = v.replace(/[^\d.]/g, "").split(".");
    const pattern = numberPattern(int, frac);
    if (!pattern) return null;
    // A percentage is often held as its ratio (34.46% as 0.3446…).
    const digits = int.padStart(3, "0");
    const ratio = v.endsWith("%") ? numberPattern(digits.slice(0, -2), digits.slice(-2) + frac) : null;
    return new RegExp(`(?<![\\d.,])(?:${pattern}${ratio ? `|${ratio}` : ""})(?![\\d,]\\d|\\.\\d)`);
  }
  if (v.length < 6) return null;
  if (v.length <= 80) return new RegExp(escapeRe(v), "i");
  // A long passage: its start, middle and end, word-aligned, any one of them.
  const words = v.split(" ");
  const window = (from: number) => {
    let s = "";
    for (let i = from; i < words.length && s.length < 50; i++) s += (s ? " " : "") + words[i];
    return s;
  };
  const picks = [...new Set([window(0), window(Math.floor(words.length / 2)), window(Math.max(0, words.length - 8))])].filter((w) => w.length >= 20);
  return new RegExp(picks.map(escapeRe).join("|"), "i");
}

/**
 * A number as a pattern: the integer part with or without thousands
 * separators, then decimals — any, from four integer digits (54853 finds
 * 54853.4413); else at least one, and as many as make three significant
 * digits (329.47 finds 329.4…, not 329.03; 2.19 finds 2.19…). Null under
 * three significant digits.
 */
function numberPattern(int: string, frac: string): string | null {
  const whole = int.replace(/^0+/, "");
  const sig = whole ? whole.length + frac.length : frac.replace(/^0+/, "").length;
  if (sig < 3) return null;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const intPart = whole ? `(?:${escapeRe(whole)}|${escapeRe(grouped)})` : "0?";
  const lead = whole ? 0 : frac.length - frac.replace(/^0+/, "").length;
  const need = whole.length >= 4 || !frac ? "" : frac.slice(0, Math.max(1, lead + 3 - whole.length));
  return `${intPart}${need ? `\\.${need}\\d*` : "(?:\\.\\d+)?"}`;
}

/** Every string leaf of a value (numbers as text), one per line. */
function textOf(v: unknown, out: string[] = [], depth = 0): string[] {
  if (v == null || depth > 12) return out;
  if (typeof v === "string") out.push(v);
  else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) textOf(x, out, depth + 1);
  else if (typeof v === "object") for (const x of Object.values(v)) textOf(x, out, depth + 1);
  return out;
}

function snippetAround(text: string, at: number, len: number): string {
  const from = Math.max(0, at - Math.floor((SNIPPET - len) / 2));
  const to = Math.min(text.length, from + SNIPPET);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

/** The first match of the needle in a value: its snippet. */
function find(needle: RegExp, v: unknown): string | null {
  const text = normalizeText(textOf(v).join("\n"));
  const m = needle.exec(text);
  needle.lastIndex = 0;
  return m ? snippetAround(text, m.index, m[0].length) : null;
}

const short = (v: unknown, max: number): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// ── The log, as calls ───────────────────────────────────────────────────────

interface Call {
  path: string;
  /** The tool (`bash`) or the step's type (`sheets/batch-update-values`). */
  tool: string;
  isTool: boolean;
  agent?: string;
  toolCallId?: string;
  at: string;
  /** When its output came back. */
  endAt?: string;
  input: unknown;
  output?: unknown;
  nodes?: Array<{ ref_id: string; name?: string; node_type?: string }>;
}

interface TranscriptCall {
  /** The agent's words before the call. */
  why: string;
  /** The call's whole result. */
  result?: unknown;
}

/** Each tool call's result and the agent's words before it, by `toolCallId`. */
function readTranscripts(events: RunEvent[]): Map<string, TranscriptCall> {
  const out = new Map<string, TranscriptCall>();
  for (const e of events) {
    const messages = (e as { messages?: unknown }).messages;
    if (e.type !== "step.end" || !Array.isArray(messages)) continue;
    for (const m of messages as Array<{ role?: string; content?: unknown }>) {
      if (!Array.isArray(m.content)) continue;
      let words: string[] = [];
      let last = "";
      for (const p of m.content as Array<Record<string, unknown>>) {
        if (p["type"] === "text" || p["type"] === "reasoning") {
          if (typeof p["text"] === "string" && p["text"].trim()) words.push(p["text"].trim());
        } else if (p["type"] === "tool-call" && typeof p["toolCallId"] === "string") {
          // Calls made together share the words before the first of them.
          const said = words.join("\n\n");
          const why = said ? (said.length > WHY_MAX ? `…${said.slice(-WHY_MAX)}` : said) : last;
          out.set(p["toolCallId"], { ...out.get(p["toolCallId"]), why });
          last = why;
          words = [];
        } else if (p["type"] === "tool-result" && typeof p["toolCallId"] === "string") {
          const o = p["output"] as { type?: string; value?: unknown } | undefined;
          const result = o && typeof o === "object" && "value" in o ? o.value : (p["output"] ?? p["result"]);
          out.set(p["toolCallId"], { why: out.get(p["toolCallId"])?.why ?? "", result });
        }
      }
    }
  }
  return out;
}

/** A tool result that is JSON text (the sheets tools answer that way) as the value. */
function parsed(v: unknown): unknown {
  if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function callsOf(events: RunEvent[], transcripts: Map<string, TranscriptCall>): Call[] {
  const open = new Map<string, Call>();
  const calls: Call[] = [];
  for (const e of events) {
    if (e.type === "step.start") {
      const type = e.stepType ?? "";
      if (SKIPPED_STEPS.has(type)) continue;
      const isTool = type.startsWith("tool:");
      const toolCallId = (e as { toolCallId?: string }).toolCallId;
      const call: Call = {
        path: e.path,
        tool: isTool ? type.slice(5) : type || "step",
        isTool,
        ...(isTool ? { agent: e.path.slice(0, e.path.lastIndexOf("/")) } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        at: e.ts,
        input: e.input,
      };
      open.set(e.path, call);
      calls.push(call);
    } else if (e.type === "step.end" || e.type === "step.error") {
      const call = open.get(e.path);
      if (!call) continue;
      open.delete(e.path);
      call.endAt = e.ts;
      const whole = call.toolCallId ? transcripts.get(call.toolCallId)?.result : undefined;
      call.output = parsed(whole !== undefined ? whole : e.type === "step.error" ? e.error?.message : e.output);
      const nodes = (e as { nodes?: Call["nodes"] }).nodes;
      if (Array.isArray(nodes) && nodes.length) call.nodes = nodes;
    }
  }
  return calls;
}

/** Where a call was, in words. */
function whereOf(call: Call): string {
  const i = (call.input ?? {}) as Record<string, unknown>;
  if (call.tool === EDIT_TOOL && typeof i["path"] === "string") return i["path"].split("/").pop()!;
  if (call.tool === "bash" && typeof i["command"] === "string") return `$ ${short(i["command"].replace(/\s+/g, " "), 100)}`;
  if (typeof i["url"] === "string") return i["url"];
  if (call.nodes?.length) return call.nodes.slice(0, 3).map((n) => short((n.name ?? n.ref_id).split("\n")[0]!, 60)).join(", ");
  if (!call.isTool) return `step ${call.path.split("/").pop()}`;
  return call.tool;
}

/** Does the call write what it is given — a cell, a file, a node — rather than use it? */
function writes(call: Call): boolean {
  if (SHEET_WRITE_RE.test(call.tool)) return true;
  if (call.tool === EDIT_TOOL) return String((call.input as Record<string, unknown> | undefined)?.["command"] ?? "") !== "view";
  return /^(graph|sheets|docx|memory)[_/]/.test(call.tool) && GRAPH_WRITE_RE.test(call.tool.toLowerCase());
}

// ── The search ──────────────────────────────────────────────────────────────

/**
 * Where `subject` passed through the run whose (raw) log is `events`.
 * Exact moments first by address — every write and read of the cell (a sheet
 * write's ranges laid out cell by cell), every call that named the node,
 * every edit of the file — then, for a value long enough to tell from noise,
 * every other call whose input or output holds it.
 */
export function buildProvenance(events: RunEvent[], subject: ProvenanceSubject): Provenance {
  const transcripts = readTranscripts(events);
  const calls = callsOf(events, transcripts);
  const moments: ProvenanceMoment[] = [];
  const seen = new Set<string>();
  const add = (call: Call, given: Omit<ProvenanceMoment, "at" | "path" | "tool">) => {
    // What went in, by what the call does with it.
    const m = given.kind === "wrote" && !writes(call) ? { ...given, kind: "used" as const } : given;
    const key = `${call.path}\0${m.kind === "read" ? "out" : "in"}`;
    if (seen.has(key)) return;
    seen.add(key);
    const t = call.toolCallId ? transcripts.get(call.toolCallId) : undefined;
    const cites = m.cell ? [] : citedCells(m.snippet);
    moments.push({
      at: m.kind === "read" ? (call.endAt ?? call.at) : call.at,
      path: call.path,
      ...(call.agent ? { agent: call.agent } : {}),
      tool: call.tool,
      ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
      ...m,
      ...(cites.length ? { cites } : {}),
      ...(m.kind !== "read" && t?.why ? { why: t.why } : {}),
    });
  };

  const sheet = spreadsheetId(subject.spreadsheet);
  const target = subject.cell ? parseRange(subject.cell) : null;
  const fileName = subject.file?.split("/").pop();
  const needle = subject.value ? needleOf(subject.value) : null;
  const notes: string[] = [];
  if (subject.cell && !target) notes.push(`"${subject.cell}" is not a sheet range.`);
  if (subject.value && !needle) notes.push(`"${short(subject.value, 40)}" is too short to search for by its text — only where it was written or read by address.`);

  const sheetOf = (call: Call, io: unknown) => {
    const blocks = sheetBlocks(io);
    const id = (call.input as Record<string, unknown> | undefined)?.["spreadsheet_id"];
    return sheet && typeof id === "string" && id !== sheet ? [] : blocks;
  };

  // The run's own input: where a value came in from outside (first, on a tie: nothing in the run precedes it).
  const start = events.find((e) => e.type === "run.start");
  if (needle && start?.input !== undefined) {
    const s = find(needle, start.input);
    if (s) moments.push({ at: start.ts, path: start.path, tool: "run input", kind: "read", exact: false, where: "the run's input", snippet: s });
  }

  for (const call of calls) {
    const isSheetWrite = SHEET_WRITE_RE.test(call.tool);
    const isSheetRead = SHEET_READ_RE.test(call.tool);

    // The cell: every write over it, every read of it.
    if (target && (isSheetWrite || isSheetRead)) {
      const blocks = isSheetWrite ? sheetOf(call, call.input) : sheetOf(call, call.output);
      // Cell by cell from each block's top-left: a write's range may name that cell alone.
      const all = blocks.flatMap((b) => cellsOf(b.range, b.values).filter((c) => overlaps({ tab: c.tab, c1: c.col, r1: c.row, c2: c.col, r2: c.row }, target)));
      // A grid read lists each cell twice (value, formula): the value first.
      const hits = all.filter((c, i) => all.findIndex((d) => d.address === c.address) === i);
      if (hits.length) {
        const first = hits[0]!;
        const shown = hits.length === 1 ? first.value : hits.map((h) => `${h.address} = ${h.value}`).join("; ");
        add(call, {
          kind: isSheetWrite ? "wrote" : "read",
          exact: true,
          where: hits.length === 1 ? first.address : `${first.address} and ${hits.length - 1} more`,
          cell: first.address,
          value: hits.length === 1 ? first.value : undefined,
          snippet: short(shown, SNIPPET),
        });
        continue;
      }
    }

    // The node: every call that named it.
    if (subject.node && call.nodes?.some((n) => n.ref_id === subject.node)) {
      const node = call.nodes.find((n) => n.ref_id === subject.node)!;
      const wrote = writes(call);
      add(call, {
        kind: wrote ? "wrote" : "read",
        exact: true,
        where: node.name ?? node.ref_id,
        node,
        snippet: short(wrote ? call.input : call.output, SNIPPET),
      });
      continue;
    }

    // The file: every edit of it (with a value, the edits that hold it).
    if (fileName && call.tool === EDIT_TOOL) {
      const i = (call.input ?? {}) as Record<string, unknown>;
      const path = typeof i["path"] === "string" ? i["path"] : "";
      if (path.split("/").pop() === fileName) {
        const command = String(i["command"] ?? "");
        const kind: ProvenanceMoment["kind"] = command === "view" ? "read" : "wrote";
        const where = `${command} ${fileName}`;
        if (!needle) add(call, { kind, exact: true, where, file: path, snippet: short(kind === "read" ? call.output : (i["new_str"] ?? i["file_text"] ?? i["insert_text"]), SNIPPET) });
        else {
          const s = find(needle, kind === "read" ? call.output : call.input);
          if (s) add(call, { kind, exact: true, where, file: path, snippet: s });
        }
        if (seen.has(`${call.path}\0${kind === "read" ? "out" : "in"}`)) continue;
      }
    }

    // The value, by its text: in what went in, in what came out.
    if (!needle) continue;
    const io: Array<["wrote" | "read", unknown]> = [["wrote", call.input], ["read", call.output]];
    for (const [kind, v] of io) {
      if (v === undefined) continue;
      // In a sheet's cells: say which cell.
      const blocks = (kind === "wrote" && isSheetWrite) || (kind === "read" && isSheetRead) ? sheetOf(call, v) : [];
      const cell = blocks.flatMap((b) => cellsOf(b.range, b.values)).find((c) => needle.test(normalizeText(c.value)));
      if (cell) {
        add(call, { kind, exact: false, where: cell.address, cell: cell.address, snippet: short(cell.value, SNIPPET) });
        continue;
      }
      const s = find(needle, v);
      if (!s) continue;
      const i = (call.input ?? {}) as Record<string, unknown>;
      const file = call.tool === EDIT_TOOL && typeof i["path"] === "string" ? i["path"] : undefined;
      const node = call.nodes?.length === 1 ? call.nodes[0] : undefined;
      add(call, { kind, exact: false, where: whereOf(call), ...(file ? { file } : {}), ...(node ? { node } : {}), snippet: s });
    }
  }

  moments.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // What each agent did just before it wrote.
  const byAgent = new Map<string, Call[]>();
  for (const c of calls) if (c.agent) byAgent.set(c.agent, [...(byAgent.get(c.agent) ?? []), c]);
  for (const m of moments) {
    if (m.kind !== "wrote" || !m.agent) continue;
    const own = byAgent.get(m.agent) ?? [];
    const at = own.findIndex((c) => c.path === m.path);
    if (at <= 0) continue;
    m.before = own.slice(Math.max(0, at - BEFORE_CALLS), at).map((c) => ({
      tool: c.tool,
      path: c.path,
      input: short(c.input, BEFORE_INPUT),
      ...(c.output !== undefined ? { output: short(c.output, BEFORE_OUTPUT) } : {}),
    }));
  }

  // A formula's cells and typed-in numbers; the cells a passage cites.
  const lastWrite = [...moments].reverse().find((m) => m.exact && m.kind === "wrote" && m.value !== undefined);
  const formula = [lastWrite?.value, subject.value].find((v): v is string => typeof v === "string" && v.trim().startsWith("="));
  const parts = formula ? formulaParts(formula, target?.tab ?? null) : { refs: subject.value ? citedCells(subject.value) : [], literals: [] };
  const figures = !formula && subject.value && !NUMBER_RE.test(normalizeText(subject.value).trim()) ? figuresIn(subject.value) : [];

  // Every exact moment, then the rest by time, up to the cap.
  let kept = moments;
  let omitted = 0;
  if (moments.length > PROVENANCE_MAX_MOMENTS) {
    const exact = moments.filter((m) => m.exact);
    const room = Math.max(0, PROVENANCE_MAX_MOMENTS - exact.length);
    const rest = new Set(moments.filter((m) => !m.exact).slice(0, room));
    kept = moments.filter((m) => m.exact || rest.has(m));
    omitted = moments.length - kept.length;
  }

  if (!kept.length) notes.push("Nothing in this run's log matches it — it may have been written outside the run, or by a script whose command does not hold it.");
  return {
    subject,
    moments: kept,
    refs: parts.refs,
    literals: parts.literals,
    ...(formula ? { formula: formula.trim() } : {}),
    figures,
    ...(omitted ? { omitted } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
