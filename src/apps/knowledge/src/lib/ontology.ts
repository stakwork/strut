// The ontology and a node's links as the page shows them — pure, no React
// (tested in src/apps/knowledge.test.ts). Which types a reader browses (the
// domain's, not strut's own bookkeeping), and how a link reads from the node
// it is on: `OWNS` forward is "Owns", backward "Owned by".

/** Graph plumbing and strut's own records: never listed, searched or drawn as knowledge. */
const SYSTEM = new Set(["Claim", "EdgeText", "Merge", "Mishearing", "Check", "Evidence", "Lingo", "Schema"]);
export const isSystemType = (type: string) => type.startsWith("Strut") || SYSTEM.has(type);

export interface OntologyType {
  type: string;
  /** What the type is for, when the schema says something a reader can use. */
  description: string;
  count: number;
}

/** A schema's description as a reader should see it: an attribute spec (`?string`) or a seeder's note is none. */
export function typeDescription(d: string | undefined): string {
  const t = (d ?? "").trim();
  return !t || t.startsWith("?") || t.startsWith("Declared by") ? "" : t;
}

/** The types to list: domain types holding a node, Concept first, then the biggest. */
export function orderTypes(types: OntologyType[]): OntologyType[] {
  return types
    .filter((t) => t.count > 0 && !isSystemType(t.type))
    .sort((a, b) => (a.type === "Concept" ? -1 : b.type === "Concept" ? 1 : b.count - a.count || a.type.localeCompare(b.type)));
}

/** A type as the sidebar names it: "Concepts", "People", "Documents". */
export function typePlural(type: string): string {
  if (type === "Person") return "People";
  if (/(s|x|ch|sh)$/.test(type)) return `${type}es`;
  if (/[^aeiou]y$/.test(type)) return `${type.slice(0, -1)}ies`;
  return `${type}s`;
}

const READS: Record<string, [forward: string, reverse: string]> = {
  PARENT_OF: ["Children", "Parents"],
  OWNS: ["Owns", "Owned by"],
  IMPLEMENTS: ["Implements", "Implemented by"],
  ABOUT: ["About", "Decisions"],
  DECIDED: ["Decided", "Decided by"],
  AUTHORED: ["Wrote", "Written by"],
  DESCRIBES: ["Describes", "Described in"],
  BUILT_BY: ["Built by", "Built"],
};
const words = (edge: string) => edge.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** How a link reads from the node it is on. An edge with no wording of its own reads as its name, "(from)" when it points here. */
export function linkLabel(edge: string, direction: "forward" | "reverse"): string {
  const r = READS[edge];
  if (r) return direction === "forward" ? r[0] : r[1];
  return direction === "forward" ? words(edge) : `${words(edge)} (from)`;
}

export interface Neighbor {
  ref_id: string;
  node_type: string;
  name: string;
  edge_type: string;
  direction: "forward" | "reverse";
}

export interface LinkGroup {
  key: string;
  label: string;
  edge: string;
  nodes: Neighbor[];
}

/** A node's neighbours grouped by how they are linked (strut's own nodes left out), the biggest group first. */
export function groupLinks(neighbors: Neighbor[]): LinkGroup[] {
  const groups = new Map<string, LinkGroup>();
  for (const n of neighbors) {
    if (isSystemType(n.node_type)) continue;
    const key = `${n.edge_type}:${n.direction}`;
    const g = groups.get(key) ?? { key, label: linkLabel(n.edge_type, n.direction), edge: n.edge_type, nodes: [] };
    if (!g.nodes.some((x) => x.ref_id === n.ref_id)) g.nodes.push(n);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.nodes.length - a.nodes.length || a.label.localeCompare(b.label));
}

/** What a reader wants from a node's properties: its text. */
export function textOf(p: Record<string, unknown> | undefined): { description: string | null; docs: string | null } {
  const s = (k: string) => (typeof p?.[k] === "string" && (p[k] as string).trim() ? (p[k] as string) : null);
  return { description: s("description") ?? s("summary"), docs: s("docs") ?? s("body") ?? s("content") };
}
