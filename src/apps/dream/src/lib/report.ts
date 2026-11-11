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
  /** They said it is to last. */
  lasting?: boolean;
  /** The fixes made for it, newest first. */
  fixes?: Array<{ at: string; page: string; line: string; dream?: string }>;
  /** Corrections since its newest fix. */
  open?: number;
}

/** A page edit a dream made for a claim (`dream/apply`). */
export interface AppliedChange {
  claim: string;
  title: string;
  page: { ref_id?: string; name: string };
  kind: "changed" | "added";
  removed: string[];
  added: string[];
  why?: string;
  /** The proposal that holds it, when it waits for a person. */
  proposed?: string;
}

export interface DreamOutput {
  text?: string;
  /** The tree the dream tended: its root Concept's name. */
  root?: string;
  claims?: Claim[];
  /** The tree after the dream. `before` is an older run's: the tree before it worked. */
  tree?: TreePage[];
  before?: TreePage[];
  /** What each stage did: the moments found, how each was sorted, the page edits made, and what was passed over. */
  moments?: number;
  records?: Array<{ i: number; claim: string; created: boolean; recorded: boolean; outcome: Outcome }>;
  unsorted?: Array<{ i?: number; why: string }>;
  changes?: AppliedChange[];
  unfixed?: Array<{ claim: string; why: string }>;
  /** How many claims were due a fix. */
  due?: number;
  /** What the facts stage said it changed in memory. */
  facts?: string;
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
  /** Its one-line description, when that changed: as it was and as it is. */
  description?: { was: string; is: string };
  /** The claim it was made for, why, and the proposal that holds it when it waits for a person (a staged dream's). */
  claim?: string;
  why?: string;
  proposed?: string;
}

/** The page edits of a run: a staged dream lists them itself; an older run's are read off its two trees. */
export function changesOf(out: DreamOutput): PageChange[] {
  if (!Array.isArray(out.changes)) return pageChanges(out.before, out.tree);
  return out.changes.map((c) => ({
    ref_id: c.page.ref_id ?? `new:${c.page.name}`, name: c.page.name, kind: c.kind, removed: c.removed ?? [], added: c.added ?? [],
    claim: c.claim, ...(c.why ? { why: c.why } : {}), ...(c.proposed ? { proposed: c.proposed } : {}),
  }));
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
    const described = (old.description ?? "").trim() !== (p.description ?? "").trim();
    if (!removed.length && !added.length && !moved && !described) continue;
    out.push({
      ref_id: p.ref_id, name: p.name, kind: removed.length || added.length || described ? "changed" : "moved", removed, added,
      ...(moved ? { from: nameIn(was, old.parent), to: nameIn(is, p.parent) } : {}),
      ...(described ? { description: { was: (old.description ?? "").trim(), is: (p.description ?? "").trim() } } : {}),
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

/** Where a claim stands. With its fixes on it (a staged dream's): corrected since its last fix (`back`), fixed
 *  and quiet since, due a fix (said to last, or corrected twice), or seen once. Without them, read off what was
 *  said: corrected again after an earlier correction, last confirmed, first seen in this run, or quiet. */
export function standingOf(claim: Claim, runId: string | undefined, now: number): { tone: ClaimTone; label: string } {
  const last = claim.evidence[0];
  if (claim.fixes && typeof claim.open === "number") {
    const fixed = claim.fixes[0];
    if (fixed && claim.open > 0) return { tone: "back", label: "Came back after fix" };
    if (fixed) {
      const days = Math.max(0, Math.floor((now - Date.parse(fixed.at)) / 86_400_000));
      return { tone: "quiet", label: days > 0 ? `Fixed, quiet ${days} day${days === 1 ? "" : "s"}` : "Fixed" };
    }
    if (last?.outcome === "followed") return { tone: "kept", label: "Kept" };
    if (claim.open > 0 && (claim.lasting || claim.corrected >= 2)) return { tone: "new", label: "Due a fix" };
    if (claim.open > 0) return { tone: "quiet", label: "Seen once" };
  }
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
  // Came back: corrected in this run after a fix already made for it (a staged dream's), else corrected before.
  const back = found.filter((f) => (f.claim.fixes ? f.claim.fixes.some((x) => x.at < f.said.at) : f.claim.corrected > 1));
  return {
    turns: typeof out.turns === "number" ? out.turns : 0,
    found: found.length,
    pages: changesOf(out).length,
    back: new Set(back.map((f) => f.claim.id)).size,
  };
}
