// What a run of the `dream` workflow returns (its `result` pack), and how the
// page reads it. Pure: no React, so the tests read it too.

export type Outcome = "missing" | "not_opened" | "not_followed" | "contradicted" | "followed";

/** One thing somebody said that bears on a claim. */
export interface SaidRow {
  source: string;
  session: string;
  turn: number;
  said_by?: string;
  excerpt: string;
  why?: string;
  /** They said the claim itself is wrong. */
  denies: boolean;
  /** What the assistant did there. */
  outcome?: Outcome;
  at: string;
  /** The dream run that found it. */
  dream?: string;
}

/** A page of the tree, as `dream/tree` lists it. */
export interface TreePage {
  ref_id: string;
  name: string;
  description?: string;
  docs?: string;
  /** The ref_id of the page it hangs under; absent on the root. */
  parent?: string;
  depth: number;
}

/** A claim about a Concept page, as `dream/claims` lists it. */
export interface Claim {
  id: string;
  title: string;
  text: string;
  /** The page it belongs on. */
  about: string;
  concept: string;
  parent?: string;
  /** The claims under it, when it is a group. */
  children?: string[];
  corrected: number;
  kept: number;
  evidence: SaidRow[];
}

export interface DreamOutput {
  text?: string;
  /** The tree the dream tended: its root Concept's name. */
  root?: string;
  claims?: Claim[];
  /** The tree after the dream, and before it worked (absent when it read nothing). */
  tree?: TreePage[];
  before?: TreePage[];
  turns?: number;
  more?: boolean;
  cost?: number;
}

/** What the assistant did, in the page's words. */
export const OUTCOME_TEXT: Record<Outcome, string> = {
  missing: "no page had it",
  not_opened: "the page was not opened",
  not_followed: "the page was opened, not followed",
  contradicted: "a page said the opposite",
  followed: "followed",
};

/** The claims as the page lists them: each group with its claims under it, then the claims in no group, in the order given. */
export function nest(claims: readonly Claim[]): Array<{ claim: Claim; children: Claim[] }> {
  const by = new Map(claims.map((c) => [c.id, c]));
  return claims
    .filter((c) => !c.parent || !by.has(c.parent))
    .map((claim) => ({ claim, children: (claim.children ?? []).map((id) => by.get(id)).filter((c): c is Claim => !!c) }));
}

/** The report's sections, in the order the workflow's prompt asks for them. */
const TITLES: Record<string, string> = { CLAIMS: "Claims", FACTS: "Facts changed", PAGES: "Pages changed", "LEFT ALONE": "Left alone" };
const HEAD = /^\**(CLAIMS|FACTS|PAGES|LEFT ALONE)\**:\**\s*(.*)$/;
const none = (l: string) => /^\(?none\.?\)?$/i.test(l);

/** The report split into its sections, each line an item; null when it is not shaped that way. */
export function sectionsOf(text: string): Array<{ title: string; lines: string[] }> | null {
  const out: Array<{ title: string; lines: string[] }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const head = HEAD.exec(line);
    if (head) {
      out.push({ title: TITLES[head[1]!]!, lines: [] });
      if (head[2] && !none(head[2])) out[out.length - 1]!.lines.push(head[2]);
      continue;
    }
    const item = line.replace(/^[-*•]\s+/, "");
    if (!item || none(item)) continue;
    if (!out.length) return null;
    out[out.length - 1]!.lines.push(item);
  }
  return out.length ? out : null;
}

export function costText(cost: unknown): string {
  const n = Number(cost);
  if (!Number.isFinite(n) || n <= 0) return "no model cost";
  return n < 0.01 ? "under $0.01" : `$${n.toFixed(2)}`;
}

export function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const isCorrection = (o: Outcome | undefined): boolean => !!o && o !== "followed";
const linesOf = (docs: string | undefined): string[] => (docs ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** What a dream did to one page: read off the tree before and after it. */
export interface PageChange {
  ref_id: string;
  name: string;
  kind: "added" | "changed" | "moved" | "removed";
  /** The lines its text lost and gained, each as written. */
  removed: string[];
  added: string[];
  /** A moved page's old and new parent, by name. */
  from?: string;
  to?: string;
}

/** The pages a dream added, changed, moved or removed, in the tree's order (a removed one last). A page whose
 *  text and place are as they were is not listed. */
export function pageChanges(before: readonly TreePage[] | undefined, after: readonly TreePage[] | undefined): PageChange[] {
  if (!before || !after) return [];
  const was = new Map(before.map((p) => [p.ref_id, p]));
  const is = new Map(after.map((p) => [p.ref_id, p]));
  const nameIn = (pages: Map<string, TreePage>, ref: string | undefined) => (ref ? (pages.get(ref)?.name ?? "") : "");
  const out: PageChange[] = [];
  for (const p of after) {
    const old = was.get(p.ref_id);
    if (!old) {
      out.push({ ref_id: p.ref_id, name: p.name, kind: "added", removed: [], added: linesOf(p.docs), to: nameIn(is, p.parent) });
      continue;
    }
    const a = linesOf(old.docs);
    const b = linesOf(p.docs);
    const removed = a.filter((l) => !b.includes(l));
    const added = b.filter((l) => !a.includes(l));
    const moved = (old.parent ?? "") !== (p.parent ?? "");
    if (!removed.length && !added.length && !moved) continue;
    out.push({
      ref_id: p.ref_id, name: p.name, kind: removed.length || added.length ? "changed" : "moved", removed, added,
      ...(moved ? { from: nameIn(was, old.parent), to: nameIn(is, p.parent) } : {}),
    });
  }
  for (const p of before) if (!is.has(p.ref_id)) out.push({ ref_id: p.ref_id, name: p.name, kind: "removed", removed: linesOf(p.docs), added: [], from: nameIn(was, p.parent) });
  return out;
}

/** What this run found: each thing said that it recorded, with its claim, newest first. */
export function foundBy(claims: readonly Claim[] | undefined, runId: string): Array<{ claim: Claim; said: SaidRow }> {
  return (claims ?? [])
    .flatMap((claim) => claim.evidence.filter((e) => e.dream === runId).map((said) => ({ claim, said })))
    .sort((a, b) => b.said.at.localeCompare(a.said.at));
}

export type ClaimTone = "back" | "kept" | "quiet" | "new";

/** Where a claim stands, read off what was said for it: corrected again after an earlier correction (`back`),
 *  last confirmed or followed (`kept`), first seen in this run (`new`), or nothing since (`quiet`, with how long
 *  against `now`). A group's is its own counts alone: its children say the rest. */
export function standingOf(claim: Claim, runId: string | undefined, now: number): { tone: ClaimTone; label: string } {
  const last = claim.evidence[0];
  if (last && isCorrection(last.outcome) && runId && last.dream === runId) {
    return claim.corrected > 1 ? { tone: "back", label: "Came back" } : { tone: "new", label: "New" };
  }
  if (last?.outcome === "followed") return { tone: "kept", label: "Kept" };
  const days = last ? Math.max(0, Math.floor((now - Date.parse(last.at)) / 86_400_000)) : 0;
  return { tone: "quiet", label: days > 0 ? `Quiet ${days} day${days === 1 ? "" : "s"}` : "Quiet" };
}

/** The run in four numbers: turns read, corrections it found, pages it changed, claims that came back. */
export function summaryOf(out: DreamOutput, runId: string): { turns: number; found: number; pages: number; back: number } {
  const found = foundBy(out.claims, runId).filter((f) => isCorrection(f.said.outcome));
  return {
    turns: typeof out.turns === "number" ? out.turns : 0,
    found: found.length,
    pages: pageChanges(out.before, out.tree).length,
    back: new Set(found.filter((f) => f.claim.corrected > 1).map((f) => f.claim.id)).size,
  };
}
