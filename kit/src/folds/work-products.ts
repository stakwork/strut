// ── Work products: what a run made, as it makes them ───────────────────────
//
// A run's output may declare `artifacts: [{ id, kind?, title, path?, url?,
// render?, content?, from? }]` (src/artifact-refs.ts, specs/CALLBACKS.md §4)
// — what the run hands a person to look at. So may any STEP of it, while the
// run goes (plans/work-products.md §3): a workflow step in its output (an
// agent's structured reply in `output.object`), an agent's tool call on its
// `step.end` (`artifacts`, lifted there because the log keeps only a preview
// of a tool's result). `foldWorkProducts` reads them all off the event log:
// one product per id, in the order they first appeared, each with its
// newest declaration's fields — and the run's own output (`run.end`) wins
// over any step's. The step that FIRST declared a product is the one that
// made it.
//
// Nothing is resolved: a `path` (and a `render`) is relative to the run's
// files, as the step wrote it, which `run/files` reads.

/** The server's renderer names by extension (`artifactKind`,
 *  src/artifact-refs.ts) — the HOST vocabulary, not the viewer's (above);
 *  a root test holds the two lists to the same answers. */
const PRODUCT_KIND_BY_EXT: Record<string, string> = {
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio",
  pdf: "pdf",
  json: "json",
  diff: "diff", patch: "diff",
  log: "log", txt: "log",
  js: "code", ts: "code", tsx: "code", jsx: "code", py: "code", sh: "code", rb: "code", go: "code", rs: "code",
  yaml: "code", yml: "code", toml: "code", xml: "code", css: "code", sql: "code",
  csv: "table", tsv: "table", xlsx: "table",
  docx: "docx",
};

/** A declared product's kind: as given, `app` for one named by app, else
 *  read off the file's name (`url` when that says nothing). */
export function productKind(entry: { kind?: unknown; app?: unknown; path?: unknown; url?: unknown }): string {
  if (typeof entry.kind === "string" && entry.kind) return entry.kind;
  if (typeof entry.app === "string" && entry.app && entry.path === undefined && entry.url === undefined) return "app";
  const at = typeof entry.path === "string" ? entry.path : typeof entry.url === "string" ? entry.url : "";
  const file = at.split("?")[0]!.split("#")[0]!.split("/").pop() ?? "";
  if (file === "walkthrough.json") return "walkthrough";
  if (/^captcha-\d+\.json$/.test(file)) return "captcha";
  const dot = file.lastIndexOf(".");
  return (dot > 0 && PRODUCT_KIND_BY_EXT[file.slice(dot + 1).toLowerCase()]) || "url";
}

export interface WorkProduct {
  id: string;
  kind: string;
  title: string;
  label?: string;
  summary?: string;
  /** Relative to the run's files (the job's directory on a job run). */
  path?: string;
  url?: string;
  /** A file a page draws in its place: a .docx's HTML, a sheet's table. */
  render?: string;
  content?: unknown;
  /** The graph ref_ids it was made from: Concepts, document excerpts. */
  from: string[];
  app?: string;
  version?: string;
  peer?: string;
  via?: string;
  job?: string;
  /** The step that first declared it — its event path and type. */
  step: string;
  stepType?: string;
  /** When it was first declared, and when its newest version was. */
  at?: string;
  updatedAt?: string;
  /** How many different declarations of it there were: each a newer
   *  version. One repeated as it was (a reply listing what a tool already
   *  declared, `pack`, the run's output) is not a new one. */
  versions: number;
  /** The run's own output declared it: the record a host receives. */
  final: boolean;
}

/** What the fold reads of an event. */
export interface WorkProductEvent {
  type: string;
  path?: string;
  stepType?: string;
  ts?: string;
  output?: unknown;
  artifacts?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The entries an event declares: a tool call's lifted list, else its
 *  output's — or an agent's structured reply's. */
function declared(e: WorkProductEvent): unknown[] | undefined {
  if (Array.isArray(e.artifacts)) return e.artifacts;
  const out = e.output;
  if (!isRecord(out)) return undefined;
  if (Array.isArray(out["artifacts"])) return out["artifacts"];
  const obj = out["object"];
  return isRecord(obj) && Array.isArray(obj["artifacts"]) ? obj["artifacts"] : undefined;
}

function refs(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))] : [];
}

/** A step that only hands its input on (`pack`) made nothing: a product it
 *  repeats keeps the step that made it, and one it is first to declare is
 *  the run's. */
const PASS_THROUGH = new Set(["pack"]);

/** Every product the run's events declare, latest declaration per id, the
 *  run's own output winning; in the order they first appeared. */
export function foldWorkProducts(events: readonly WorkProductEvent[]): WorkProduct[] {
  const byId = new Map<string, WorkProduct>();
  const said = new Map<string, string>();
  // The run's own path is its workflow's name, which may hold `/`: read it
  // off `run.start`, never off a step's path.
  let run = "";
  for (const e of events) {
    if (e.type === "run.start") run = e.path ?? run;
    const final = e.type === "run.end";
    if (!final && e.type !== "step.end") continue;
    const list = declared(e);
    if (!list) continue;
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const id = str(raw["id"]);
      const title = str(raw["title"]);
      if (!id || !title) continue;
      const prev = byId.get(id);
      // Nothing after the run's own output changes what it said.
      if (prev?.final && !final) continue;
      // Who made it: the first step to declare it — not a pass-through, and
      // not the run's output, which only hands on what its steps made.
      const maker = prev ? { step: prev.step, stepType: prev.stepType } : !final && !PASS_THROUGH.has(e.stepType ?? "") ? { step: e.path ?? "", stepType: e.stepType } : { step: run || (e.path ?? "") };
      const first = prev?.at ?? e.ts;
      const text = JSON.stringify(raw);
      const changed = said.get(id) !== text;
      said.set(id, text);
      const p: WorkProduct = {
        id,
        kind: productKind(raw),
        title,
        from: refs(raw["from"]),
        step: maker.step,
        ...(maker.stepType ? { stepType: maker.stepType } : {}),
        ...(first ? { at: first } : {}),
        ...((changed ? e.ts : prev?.updatedAt) ? { updatedAt: changed ? e.ts : prev?.updatedAt } : {}),
        versions: (prev?.versions ?? 0) + (changed ? 1 : 0),
        final,
      };
      for (const k of ["label", "summary", "path", "url", "render", "app", "version", "peer", "via", "job"] as const) {
        const v = str(raw[k]);
        if (v) p[k] = v;
      }
      if (raw["content"] !== undefined && raw["content"] !== null) p.content = raw["content"];
      byId.set(id, p); // a key already there keeps its place
    }
  }
  return [...byId.values()];
}

// ── What a product carries ────────────────────────────────────────────────

/** `content.sources` (or a file's own `sources`): an item → the ref_ids it
 *  came from — a sheet's or table's cell by its address (`C4`,
 *  `'Deal Terms'!C4`) or a row by its key (its first column's text), as
 *  SheetView reads them; a timeline's entry by index; a redline's change by
 *  its index among the render's `<ins>` / `<del>`. Empty when there is none. */
export function sourcesOf(value: unknown): Record<string, string[]> {
  const raw = isRecord(value) ? value["sources"] : undefined;
  const out: Record<string, string[]> = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const r = refs(v);
    if (r.length) out[k] = r;
  }
  return out;
}

export interface TimelineEntry {
  date: string;
  title: string;
  detail?: string;
  sources: string[];
  /** Its place in the list as given — what `sources` keys an entry by. */
  index: number;
}

/** A timeline's entries — `{ entries: [{ date, title, detail?, sources? }] }`
 *  or the bare array, as content or a file's JSON text — sorted by date
 *  when every date is ISO (`2026-03`, `2026-03-04`, a datetime), else as
 *  given. An entry's `sources` and the list's `sources[index]` both count.
 *  Null when it is not a timeline. */
export function parseTimeline(value: unknown): TimelineEntry[] | null {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  const list = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v["entries"]) ? v["entries"] : null;
  if (!list) return null;
  const keyed = sourcesOf(v);
  const entries: TimelineEntry[] = [];
  list.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const date = str(raw["date"]) ?? (typeof raw["date"] === "number" ? String(raw["date"]) : undefined);
    const title = str(raw["title"]);
    if (!date || !title) return;
    entries.push({
      date,
      title,
      ...(str(raw["detail"]) ? { detail: raw["detail"] as string } : {}),
      sources: [...new Set([...refs(raw["sources"]), ...(keyed[String(index)] ?? [])])],
      index,
    });
  });
  const time = (d: string) => (/^\d{4}-\d{2}(-\d{2})?/.test(d) ? Date.parse(d.length === 7 ? `${d}-01` : d) : NaN);
  const times = entries.map((e) => time(e.date));
  if (times.some(Number.isNaN)) return entries;
  return entries.map((e, i) => ({ e, i, t: times[i]! })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
}

/** How a product opens: the document it reads as, the file a viewer plays,
 *  a dated list, a spreadsheet, or a link out. */
export type ProductView =
  | { view: "document"; path: string; as: "html" | "markdown" | "text" }
  | { view: "inline"; text: string; as: "markdown" | "text" }
  | { view: "file"; path: string }
  | { view: "timeline" }
  /** A spreadsheet: a Google sheet read live, a table file of the run's, or rows (the content). */
  | { view: "sheet"; spreadsheet?: string; path?: string; rows?: unknown }
  | { view: "link"; url: string }
  | { view: "none" };

const ext = (p: string) => (p.split("?")[0]!.split("/").pop() ?? "").split(".").pop()!.toLowerCase();
const isTableFile = (p: string) => /^(csv|tsv|json)$/.test(ext(p));
/** A Google Sheets link: the live sheet a `sheet` product's `url` names. */
export const isGoogleSheet = (url: string | undefined): url is string => !!url && /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(url);
/** Content that is the table itself (CSV text, rows, records, `{ columns, rows }`), not just its `sources`. */
const isRows = (c: unknown) => typeof c === "string" || Array.isArray(c) || (isRecord(c) && (Array.isArray(c["rows"]) || Array.isArray(c["tabs"])));
const docAs = (p: string): "html" | "markdown" | "text" => (/^html?$/.test(ext(p)) ? "html" : /^(md|markdown)$/.test(ext(p)) ? "markdown" : "text");

/** The view a product opens in by default (a page may plug its own in per
 *  kind — the shelf's `renderers`). */
export function productView(p: WorkProduct): ProductView {
  const file = p.path;
  const link = p.url && /^https?:\/\//.test(p.url) ? p.url : undefined;
  const local = file ?? (p.url?.startsWith("/") ? p.url : undefined);
  switch (p.kind) {
    case "docx":
    case "redline":
      if (p.render) return { view: "document", path: p.render, as: docAs(p.render) };
      break;
    case "timeline":
      if (p.content !== undefined || local) return { view: "timeline" };
      break;
    case "table":
    case "sheet": {
      // The live sheet first — the sheet filling in is the point — then the
      // table file a page draws, then rows inline.
      if (p.kind === "sheet" && isGoogleSheet(p.url)) return { view: "sheet", spreadsheet: p.url };
      const t = p.render ?? local;
      if (t && isTableFile(t)) return { view: "sheet", path: t };
      if (isRows(p.content)) return { view: "sheet", rows: p.content };
      break;
    }
    case "markdown":
    case "html":
    case "log":
    case "code":
    case "json":
    case "diff":
      if (local) return { view: "document", path: local, as: docAs(local) };
      if (typeof p.content === "string") return { view: "inline", text: p.content, as: p.kind === "markdown" ? "markdown" : "text" };
      if (p.content !== undefined) return { view: "inline", text: JSON.stringify(p.content, null, 2), as: "text" };
      break;
    case "image":
    case "video":
    case "audio":
    case "pdf":
    case "walkthrough":
      if (local) return { view: "file", path: local };
      break;
  }
  if (link) return { view: "link", url: link };
  if (local) return { view: "file", path: local };
  return { view: "none" };
}
