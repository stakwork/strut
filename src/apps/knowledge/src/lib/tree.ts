// The Concept tree as the page draws it — pure, no React (tested in
// src/apps/knowledge.test.ts). Ported from Hive's graph workbench model
// (`src/components/graph-workbench/model.ts`): Concepts along
// `(parent)-[:PARENT_OF]->(child)`; a ROOT has children and no parent (the
// graph stores no root flag); a Concept with neither is in no tree.

export const TREE_TYPE = "Concept";
export const TREE_EDGE = "PARENT_OF";

export interface Concept {
  id: string;
  name: string;
  description: string | null;
  docs: string | null;
  repo: string | null;
  file: string | null;
}

export interface ConceptTree {
  nodes: Record<string, Concept>;
  /** Parent ids by child, child ids by parent, each sorted by name. */
  parents: Record<string, string[]>;
  children: Record<string, string[]>;
  /** Roots, biggest tree first, then by name. */
  roots: string[];
  /** In no tree: no parent and no children, by name. */
  unplaced: string[];
}

/** Docs this short tell a reader nothing (Hive's `MIN_DOCS`). */
const MIN_DOCS = 20;
export const hasDocs = (c: Concept) => (c.docs?.trim().length ?? 0) >= MIN_DOCS;

const push = (map: Record<string, string[]>, key: string, value: string) => {
  const list = (map[key] ??= []);
  if (!list.includes(value)) list.push(value);
};

/** Build the tree from the Concepts and the edges among them (any type: only `TREE_EDGE` counts). */
export function buildTree(concepts: Concept[], edges: Array<{ source: string; target: string; edge_type: string }>): ConceptTree {
  const nodes: Record<string, Concept> = {};
  for (const c of concepts) nodes[c.id] = c;
  const parents: Record<string, string[]> = {};
  const children: Record<string, string[]> = {};
  for (const e of edges) {
    if (e.edge_type !== TREE_EDGE || e.source === e.target || !nodes[e.source] || !nodes[e.target]) continue;
    push(children, e.source, e.target);
    push(parents, e.target, e.source);
  }
  const byName = (a: string, b: string) => nodes[a]!.name.localeCompare(nodes[b]!.name) || a.localeCompare(b);
  for (const list of [...Object.values(children), ...Object.values(parents)]) list.sort(byName);
  const tree: ConceptTree = { nodes, parents, children, roots: [], unplaced: [] };
  const ids = Object.keys(nodes).sort(byName);
  const size = new Map(ids.map((id) => [id, reach(tree, id).size]));
  tree.roots = ids.filter((id) => !parents[id]?.length && !!children[id]?.length).sort((a, b) => size.get(b)! - size.get(a)! || byName(a, b));
  tree.unplaced = ids.filter((id) => !parents[id]?.length && !children[id]?.length);
  return tree;
}

/** Everything below `id`. Cycle-safe. */
export function reach(tree: ConceptTree, id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    for (const n of tree.children[queue.pop()!] ?? []) {
      if (!out.has(n)) {
        out.add(n);
        queue.push(n);
      }
    }
  }
  return out;
}

/** One path from a root down to `id`, root first, through each node's first parent that leads to one. Cycle-safe; null when `id` is unknown. */
export function pathToRoot(tree: ConceptTree, id: string, seen = new Set<string>()): string[] | null {
  if (!tree.nodes[id] || seen.has(id)) return null;
  const ps = tree.parents[id] ?? [];
  if (!ps.length) return [id];
  seen.add(id);
  for (const p of ps) {
    const path = pathToRoot(tree, p, seen);
    if (path) return [...path, id];
  }
  // Only cycles above: the node heads its own path.
  return [id];
}

/** A row of the outline as drawn: where it sits (the ids above it, root first) and the node. */
export interface Row {
  /** The row's key: its path, `a/b/c` — a Concept with two parents is two rows. */
  key: string;
  id: string;
  depth: number;
  /** Children it has (drawn or not). */
  childCount: number;
  open: boolean;
}

export const rowKey = (path: readonly string[]) => path.join("/");

/** The rows the outline shows: each root, and under every OPEN row its children, depth first. A cycle stops at the node met again. */
export function visibleRows(tree: ConceptTree, open: ReadonlySet<string>, tops: readonly string[] = tree.roots): Row[] {
  const out: Row[] = [];
  const walk = (id: string, path: string[]) => {
    const key = rowKey(path);
    const kids = tree.children[id] ?? [];
    const isOpen = open.has(key) && kids.length > 0;
    out.push({ key, id, depth: path.length - 1, childCount: kids.length, open: isOpen });
    if (!isOpen) return;
    for (const k of kids) if (!path.includes(k)) walk(k, [...path, k]);
  };
  for (const t of tops) walk(t, [t]);
  return out;
}

/** The row keys to open so `path`'s last node shows: every row above it. */
export function opening(path: readonly string[]): string[] {
  return path.slice(0, -1).map((_, i) => rowKey(path.slice(0, i + 1)));
}

/** Concept fields from a node's properties; a missing or blank text is null. */
export function conceptOf(n: { ref_id: string; name?: string; properties?: Record<string, unknown> }): Concept {
  const p = n.properties ?? {};
  const text = (k: string) => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string) : null);
  return {
    id: n.ref_id,
    name: n.name || text("name") || n.ref_id.slice(0, 8),
    description: text("description"),
    docs: text("docs"),
    repo: text("repo"),
    file: text("file"),
  };
}

/** Each Concept's parents by NAME, as a diff names its pages: so a parent the diff lacks climbs to its root. */
export function parentsByName(tree?: ConceptTree): (name: string) => readonly string[] | undefined {
  const m = new Map<string, string[]>();
  if (tree) for (const [id, c] of Object.entries(tree.nodes)) m.set(c.name, (tree.parents[id] ?? []).map((p) => tree.nodes[p]?.name ?? p));
  return (name) => m.get(name);
}
