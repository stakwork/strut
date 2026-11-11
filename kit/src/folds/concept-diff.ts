/**
 * A CONCEPT DIFF (plans/concept-history.md §8 item 4, rulings 7 and 12):
 * two states of the Concept tree's pages → what a view draws. The tree with
 * each page marked `added`, `edited`, `moved` (its parents changed),
 * `renamed` (its name changed), `removed`, or unchanged, and per page what
 * changed — and the docs line by line.
 *
 * A page is what `history/read` parses out of `concepts/<key>.md`:
 * `{ name, attributes, parents, docs? }`, parents by NAME. Three sources make
 * the same entries (`ConceptEntry`, history/read's `diff` shape):
 *
 *   - two commits or two times: `historyEntries(diff.entries)`;
 *   - a PENDING PROPOSAL laid over the page as it is now (`show { at: "main" }`):
 *     `proposalEntry(proposal, current, nameOf)`;
 *   - a person's unsaved edit: `editEntry(path, shown, edited)`.
 *
 * The sources never meet in storage; they meet here. Pure: no React, no DOM.
 */

/** A Concept page as the package reader parses it. */
export interface ConceptPage {
  name: string;
  /** Every attribute but `name` and `docs` (`description`, `repo`, `alt_names`, …). */
  attributes: Record<string, unknown>;
  /** The names of its parents, sorted. */
  parents: string[];
  docs?: string;
}

/** One page on two sides, as `history/read`'s `diff` gives it: either side
 *  missing is a page added or removed. `from` is where it was before, when
 *  the file moved (a rename: the file is named by the page's key). */
export interface ConceptEntry {
  path: string;
  from?: string;
  before?: ConceptPage;
  after?: ConceptPage;
}

export type ConceptMark = "renamed" | "moved" | "edited";
export type ConceptStatus = "added" | "removed" | ConceptMark | "unchanged";

export interface AttributeChange {
  name: string;
  before?: unknown;
  after?: unknown;
}

/** One page's change. */
export interface ConceptChange {
  /** The page's path now (after), or as it was (removed). */
  path: string;
  /** Its path before, when that differs. */
  from?: string;
  /** The name it is shown by: the new one, or the last it had. */
  name: string;
  /** The first of `marks`, `added`, `removed`, or `unchanged`. */
  status: ConceptStatus;
  /** Everything that changed on a page present on both sides, in this order. */
  marks: ConceptMark[];
  /** Paired by the fold, not by git: removed + added, the same parents and like text. */
  paired?: true;
  before?: ConceptPage;
  after?: ConceptPage;
  nameBefore?: string;
  parentsBefore?: string[];
  parentsAfter?: string[];
  attributes: AttributeChange[];
  docs: boolean;
}

/** A row of the tree a view draws. A CONTEXT row is a parent named by a
 *  changed page that is not itself in the diff. */
export interface ConceptDiffNode {
  /** Unique in the tree: the names from the root, joined. */
  key: string;
  name: string;
  status: ConceptStatus;
  change?: ConceptChange;
  context?: true;
  children: ConceptDiffNode[];
}

export interface ConceptDiff {
  /** Every page that changed (and every unchanged one the entries held), by name. */
  pages: ConceptChange[];
  tree: ConceptDiffNode[];
  counts: Record<ConceptStatus, number>;
}

export interface FoldConceptDiffOptions {
  /** The parents of a page that is not in the diff, by name — the live
   *  tree's — so a context row climbs to its root. Without it a context
   *  row is a root. */
  parentsOf?: (name: string) => readonly string[] | undefined;
  /** Leave unchanged pages out of `pages` and the tree. Default false. */
  hideUnchanged?: boolean;
}

/** A path in the history that is a Concept page: `concepts/<key>.md`, or
 *  another namespace's `namespaces/<ns>/concepts/<key>.md`. */
export function isConceptPagePath(path: string): boolean {
  return /^(?:namespaces\/[^/]+\/)?concepts\/[^/]+\.md$/.test(path);
}

const sanitize = (v: string) => v.trim().replace(/ /g, "").toLowerCase().replace(/[^a-zA-Z0-9\s]/g, "");
/** The node writer's longest key; past it the key is the type and a hash. */
const MAX_KEY = 200;
const HASH_CHARS = 32;

/**
 * Where a page lies in the history: `concepts/<key>.md`, the key composed as
 * the node writer composes a Concept's (`concept-` and the name's letters
 * and digits, lowercase; past 200 characters `concept-` and a hash of them).
 * `ns` names another namespace than the backend's own. Async for the hash:
 * WebCrypto, in a browser and in Node alike; null where there is none.
 */
export async function conceptPagePath(name: string, ns?: string): Promise<string | null> {
  const token = sanitize(name);
  if (!token) return null;
  let key = `concept-${token}`;
  if (key.length > MAX_KEY) {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (!subtle) return null;
    const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(token)));
    key = `concept-${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, HASH_CHARS)}`;
  }
  return ns ? `namespaces/${ns}/concepts/${key}.md` : `concepts/${key}.md`;
}

// ── sources ─────────────────────────────────────────────────────────────

/** What `history/read`'s `diff` answers per path (and a `show`'s file). */
export interface HistoryFile {
  text?: string;
  parsed?: ConceptPage | Record<string, unknown>;
  parseError?: string;
}
export interface HistoryDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  from?: string;
  before?: HistoryFile;
  after?: HistoryFile;
}

/** A parsed page out of a history file, or undefined (another kind, or one that would not parse). */
export function pageOf(file: HistoryFile | null | undefined): ConceptPage | undefined {
  const p = file?.parsed as Partial<ConceptPage> | undefined;
  if (!p || typeof p.name !== "string") return undefined;
  return {
    name: p.name,
    attributes: p.attributes && typeof p.attributes === "object" ? { ...p.attributes } : {},
    parents: Array.isArray(p.parents) ? [...p.parents].map(String).sort() : [],
    ...(typeof p.docs === "string" ? { docs: p.docs } : {}),
  };
}

/** SOURCE ONE: a `history/read` diff → entries, its Concept pages alone
 *  (a type, a workflow, a step changed in the same commits is left out). */
export function historyEntries(entries: readonly HistoryDiffEntry[]): ConceptEntry[] {
  const out: ConceptEntry[] = [];
  for (const e of entries) {
    if (!isConceptPagePath(e.path)) continue;
    const before = e.status === "added" ? undefined : pageOf(e.before);
    const after = e.status === "deleted" ? undefined : pageOf(e.after);
    if (!before && !after) continue;
    out.push({ path: e.path, ...(e.from ? { from: e.from } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}) });
  }
  return out;
}

/** A proposal as `proposal/get` returns it: the step and the input it runs with on accept. */
export interface ConceptProposal {
  step: string;
  input: Record<string, unknown>;
  /** A person's edits merged over the input (decision.input). */
  decision?: { input?: Record<string, unknown> };
}

/** The node a proposal names: `ref_id` (edit, move, delete). */
export function proposalTarget(p: ConceptProposal): string | undefined {
  const input = { ...p.input, ...(p.decision?.input ?? {}) };
  return typeof input["ref_id"] === "string" ? input["ref_id"] : undefined;
}

/** The nodes whose NAMES a proposal's entry needs: its target, a move's ends, a new page's parent. */
export function proposalRefs(p: ConceptProposal): string[] {
  const input = { ...p.input, ...(p.decision?.input ?? {}) };
  return ["ref_id", "from_ref_id", "to_ref_id", "source_ref_id"].map((k) => input[k]).filter((v): v is string => typeof v === "string");
}

/** The steps a proposal can change a Concept page with. */
export const CONCEPT_PROPOSAL_STEPS = ["graph/edit-node", "graph/move-node", "graph/create-node", "graph/delete-node", "graph/create-triplet"] as const;

/**
 * SOURCE TWO: a pending proposal laid over the page as it is now (`current`,
 * from `history/read show { path, at: "main" }`; null for a create). `nameOf`
 * names a node a move points at. Null when the proposal changes no page:
 * another step, another type, a move along another edge than the tree's.
 *
 *   graph/edit-node    node_data over the page (its name, its docs, its
 *                      attributes), properties_to_be_deleted taken out
 *   graph/move-node    PARENT_OF, reverse: the page's parent `from` → `to`
 *   graph/create-node  a Concept: an added page, no parents yet
 *   graph/delete-node  a removed page
 *   graph/create-triplet  a new Concept under an existing one (PARENT_OF,
 *                      source_ref_id → target_data): an added page, its parent named
 */
export function proposalEntry(
  p: ConceptProposal,
  current: { path: string; page: ConceptPage } | null,
  nameOf: (refId: string) => string | undefined = () => undefined,
): ConceptEntry | null {
  const input = { ...p.input, ...(p.decision?.input ?? {}) };
  const data = (input["node_data"] && typeof input["node_data"] === "object" ? input["node_data"] : {}) as Record<string, unknown>;
  switch (p.step) {
    case "graph/create-node": {
      if (String(input["node_type"] ?? "").toLowerCase() !== "concept" || typeof data["name"] !== "string") return null;
      const page = pageFromData(data);
      return { path: keylessPath(page.name), after: page };
    }
    case "graph/delete-node":
      return current ? { path: current.path, before: current.page } : null;
    case "graph/create-triplet": {
      const target = (input["target_data"] && typeof input["target_data"] === "object" ? input["target_data"] : {}) as Record<string, unknown>;
      if (String(input["edge_type"] ?? "").toUpperCase() !== "PARENT_OF" || String(input["target_type"] ?? "").toLowerCase() !== "concept" || typeof target["name"] !== "string") return null;
      const parent = typeof input["source_ref_id"] === "string" ? nameOf(input["source_ref_id"]) : undefined;
      const page = pageFromData(target);
      return { path: keylessPath(page.name), after: { ...page, parents: parent ? [parent] : [] } };
    }
    case "graph/edit-node": {
      if (!current || input["node_type"] !== undefined) return null;
      const before = current.page;
      const attributes = { ...before.attributes };
      let name = before.name;
      let docs = before.docs;
      for (const [k, v] of Object.entries(data)) {
        if (k === "name") name = typeof v === "string" && v.trim() ? v : name;
        else if (k === "docs") docs = typeof v === "string" && v.trim() ? v.trim() : undefined;
        else if (v === null || v === undefined || v === "") delete attributes[k];
        else attributes[k] = v;
      }
      for (const k of (input["properties_to_be_deleted"] as unknown[] | undefined) ?? []) {
        if (k === "docs") docs = undefined;
        else if (typeof k === "string" && k !== "name") delete attributes[k];
      }
      const after: ConceptPage = { name, attributes, parents: [...before.parents], ...(docs !== undefined ? { docs } : {}) };
      const path = name === before.name ? current.path : keylessPath(name, current.path);
      return { path, ...(path !== current.path ? { from: current.path } : {}), before, after };
    }
    case "graph/move-node": {
      if (!current || String(input["edge_type"] ?? "").toUpperCase() !== "PARENT_OF" || input["direction"] !== "reverse") return null;
      const to = nameOf(String(input["to_ref_id"] ?? ""));
      if (!to) return null;
      const before = current.page;
      const fromRef = typeof input["from_ref_id"] === "string" ? input["from_ref_id"] : undefined;
      const from = fromRef ? nameOf(fromRef) : before.parents.length === 1 ? before.parents[0] : undefined;
      const parents = [...new Set([...before.parents.filter((x) => x !== from), to])].sort();
      return { path: current.path, before, after: { ...before, attributes: { ...before.attributes }, parents } };
    }
    default:
      return null;
  }
}

/** A page built from a create's (or an edit's) node data. */
function pageFromData(data: Record<string, unknown>): ConceptPage {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (k !== "name" && k !== "docs" && v !== null && v !== undefined && v !== "") attributes[k] = v;
  const docs = typeof data["docs"] === "string" && data["docs"].trim() ? data["docs"].trim() : undefined;
  return { name: String(data["name"]), attributes, parents: [], ...(docs ? { docs } : {}) };
}

/** A path for a page that is not in the history yet: its key's, unless the key is hashed (then `fallback`). */
function keylessPath(name: string, fallback?: string): string {
  const token = sanitize(name);
  const key = `concept-${token}`;
  return token && key.length <= MAX_KEY ? `concepts/${key}.md` : (fallback ?? `concepts/${name}.md`);
}

/** SOURCE THREE: a person's unsaved edit — the page as edited against the page as shown. */
export function editEntry(path: string, shown: ConceptPage, edited: ConceptPage): ConceptEntry {
  return { path, before: shown, after: edited };
}

// ── the fold ────────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameList = (a: readonly string[], b: readonly string[]) => same([...a].sort(), [...b].sort());

function attributeChanges(before: ConceptPage | undefined, after: ConceptPage | undefined): AttributeChange[] {
  const a = before?.attributes ?? {};
  const b = after?.attributes ?? {};
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => (x === "description" ? -1 : y === "description" ? 1 : x.localeCompare(y)));
  return names
    .filter((n) => !same(a[n], b[n]))
    .map((n) => ({ name: n, ...(a[n] !== undefined ? { before: a[n] } : {}), ...(b[n] !== undefined ? { after: b[n] } : {}) }));
}

function changeOf(e: ConceptEntry, paired = false): ConceptChange {
  const { before, after } = e;
  const attributes = before && after ? attributeChanges(before, after) : [];
  const docs = !!before && !!after && (before.docs ?? "") !== (after.docs ?? "");
  const marks: ConceptMark[] = [];
  if (before && after) {
    if (before.name !== after.name) marks.push("renamed");
    if (!sameList(before.parents, after.parents)) marks.push("moved");
    if (attributes.length || docs) marks.push("edited");
  }
  const status: ConceptStatus = !before ? "added" : !after ? "removed" : (marks[0] ?? "unchanged");
  const from = e.from && e.from !== e.path ? e.from : undefined;
  return {
    path: e.path,
    ...(from ? { from } : {}),
    name: (after ?? before)!.name,
    status,
    marks,
    ...(paired ? { paired: true as const } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(marks.includes("renamed") ? { nameBefore: before!.name } : {}),
    ...(marks.includes("moved") ? { parentsBefore: before!.parents, parentsAfter: after!.parents } : {}),
    attributes,
    docs,
  };
}

/** A page's prose, for pairing: its description and its docs. */
const prose = (p: ConceptPage) => [typeof p.attributes["description"] === "string" ? p.attributes["description"] : "", p.docs ?? ""].join("\n");

/** How alike two texts are, by their words: Dice over the word multisets, 0 to 1. */
export function textSimilarity(a: string, b: string): number {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (wa.length + wb.length);
}

/** How alike a removed and an added page must be to be one page renamed. */
export const PAIR_SIMILARITY = 0.5;

/**
 * Pair a removed page with an added one when git did not: a page renamed is
 * a new file (the key follows the name), and git pairs files only past 50%
 * alike, so a short page renamed AND rewritten arrives as a delete and an
 * add. Paired here when their parents are the same and their prose alike by
 * words; each removed page to its best match, the best pairs first.
 */
function pairRenames(entries: ConceptEntry[]): Array<{ entry: ConceptEntry; paired: boolean }> {
  const removed = entries.filter((e) => e.before && !e.after);
  const added = entries.filter((e) => e.after && !e.before);
  const candidates: Array<{ r: ConceptEntry; a: ConceptEntry; score: number }> = [];
  for (const r of removed) {
    for (const a of added) {
      if (!sameList(r.before!.parents, a.after!.parents)) continue;
      const score = textSimilarity(prose(r.before!), prose(a.after!));
      if (score >= PAIR_SIMILARITY) candidates.push({ r, a, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const used = new Set<ConceptEntry>();
  const merged = new Map<ConceptEntry, ConceptEntry>();
  for (const c of candidates) {
    if (used.has(c.r) || used.has(c.a)) continue;
    used.add(c.r);
    used.add(c.a);
    merged.set(c.a, { path: c.a.path, from: c.r.path, before: c.r.before!, after: c.a.after! });
  }
  return entries.filter((e) => !(used.has(e) && !merged.has(e))).map((e) => ({ entry: merged.get(e) ?? e, paired: merged.has(e) }));
}

const ORDER: ConceptStatus[] = ["added", "removed", "renamed", "moved", "edited", "unchanged"];

/**
 * The entries → every page's change and the TREE: each page under each of
 * its parents (its new ones; a removed page under the ones it had), a parent
 * the diff does not hold drawn as a context row (climbing through
 * `parentsOf` when given), children by name, cycle-safe.
 */
export function foldConceptDiff(entries: readonly ConceptEntry[], opts: FoldConceptDiffOptions = {}): ConceptDiff {
  const pages = pairRenames([...entries])
    .map(({ entry, paired }) => changeOf(entry, paired))
    .filter((c) => !(opts.hideUnchanged && c.status === "unchanged"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<ConceptStatus, number>;
  for (const p of pages) counts[p.status]++;

  // A page by any name it had: a removed child still names its parent's old name.
  const byName = new Map<string, ConceptChange>();
  for (const p of pages) {
    if (p.before && !byName.has(p.before.name)) byName.set(p.before.name, p);
    if (p.after) byName.set(p.after.name, p);
  }
  const parentsOfChange = (c: ConceptChange) => (c.after ?? c.before)!.parents;
  // Every name in the tree, and its parents: a page's, else the context's.
  const parentsOf = (name: string): readonly string[] => {
    const c = byName.get(name);
    return c ? parentsOfChange(c) : (opts.parentsOf?.(name) ?? []);
  };
  const shown = (name: string) => byName.get(name)?.name ?? name;

  const children = new Map<string, Set<string>>();
  const names = new Set<string>();
  const visit = (name: string, seen: Set<string>) => {
    const n = shown(name);
    if (names.has(n) || seen.has(n)) return;
    names.add(n);
    for (const parent of parentsOf(n)) {
      const pn = shown(parent);
      if (!children.has(pn)) children.set(pn, new Set());
      children.get(pn)!.add(n);
      visit(pn, new Set([...seen, n]));
    }
  };
  for (const p of pages) visit(p.name, new Set());

  const build = (name: string, trail: string[]): ConceptDiffNode => {
    const c = byName.get(name);
    const key = [...trail, name].join(" › ");
    const kids = [...(children.get(name) ?? [])]
      .filter((k) => !trail.includes(k) && k !== name)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => build(k, [...trail, name]));
    return { key, name, status: c?.status ?? "unchanged", ...(c ? { change: c } : { context: true as const }), children: kids };
  };
  const isRoot = (n: string) => parentsOf(n).every((p) => !names.has(shown(p)));
  const roots = [...names].filter(isRoot);
  // A cycle with no way in: start it at its first name.
  const reached = new Set<string>();
  const mark = (n: ConceptDiffNode) => {
    reached.add(n.name);
    n.children.forEach(mark);
  };
  const tree = roots.sort((a, b) => a.localeCompare(b)).map((r) => build(r, []));
  tree.forEach(mark);
  for (const n of [...names].sort()) {
    if (reached.has(n)) continue;
    const node = build(n, []);
    mark(node);
    tree.push(node);
  }
  return { pages, tree, counts };
}

// ── the docs, line by line ──────────────────────────────────────────────

export interface DiffLine {
  op: "same" | "add" | "del";
  text: string;
  /** Line numbers, from 1: in the old text (same, del) and the new (same, add). */
  a?: number;
  b?: number;
}

/** Past this many cells (lines × lines) the middle is all deleted and added: no LCS table that size. */
const LCS_MAX_CELLS = 4_000_000;

/**
 * Two texts, line by line: the lines both keep (a longest common
 * subsequence), the lines deleted, the lines added, in reading order —
 * deletions before additions where they meet.
 */
export function lineDiff(before: string | undefined, after: string | undefined): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ op: "same", text: a[i]!, a: i + 1, b: i + 1 });
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > LCS_MAX_CELLS) {
    ma.forEach((t, i) => out.push({ op: "del", text: t, a: start + i + 1 }));
    mb.forEach((t, j) => out.push({ op: "add", text: t, b: start + j + 1 }));
  } else {
    // lcs[i][j]: the longest common subsequence of ma[i..] and mb[j..].
    const n = ma.length;
    const m = mb.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = ma[i] === mb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        out.push({ op: "same", text: ma[i]!, a: start + i + 1, b: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
        out.push({ op: "del", text: ma[i]!, a: start + i + 1 });
        i++;
      } else {
        out.push({ op: "add", text: mb[j]!, b: start + j + 1 });
        j++;
      }
    }
  }
  const shift = endA - start - (endB - start);
  for (let i = endA; i < a.length; i++) out.push({ op: "same", text: a[i]!, a: i + 1, b: i + 1 - shift });
  return out;
}

/** A diff's lines with the unchanged runs folded: `context` lines kept each side of a change, the rest one gap. */
export type DiffHunkLine = DiffLine | { op: "gap"; count: number };

export function foldDiffLines(lines: readonly DiffLine[], context = 3): DiffHunkLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffHunkLine[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ op: "gap", count: gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ op: "gap", count: gap });
  return out;
}

/** A value as one line, for an attribute's before and after. */
export function attributeText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
