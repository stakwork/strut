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
