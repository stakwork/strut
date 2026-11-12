// The learning loop as the page shows it — pure, no React (tested in
// src/apps/knowledge.test.ts). A Concept's CLAIMS (`knowledge/page`: what its
// readers are held to, and whether that holds) and the CHANGES to it waiting
// on a person: the dream's proposals (`proposal/list { workflow: "dream" }`),
// each tied to the Concept it changes.
import type { ConceptTree } from "./tree";

/** The workflow whose proposals the page shows: the one that tends the tree. */
export const DREAM = "dream";

export type ClaimStatus = "supported" | "refuted" | "stale" | "unknown";

/** A claim as `knowledge/page` and `knowledge/claims` answer it. */
export interface PageClaim {
  id: string;
  text: string;
  status: ClaimStatus;
  speaker?: string;
  latest?: { content?: string; mode?: string; by?: string };
}

/** What each status reads as, and what it means. */
export const CLAIM_STATUS: Record<ClaimStatus, { label: string; means: string }> = {
  supported: { label: "Supported", means: "The latest evidence says this holds." },
  refuted: { label: "Refuted", means: "The latest evidence says this does not hold." },
  stale: { label: "Stale", means: "The page changed since this was last checked." },
  unknown: { label: "Unknown", means: "Nothing has checked this yet." },
};

/** Worst first: what needs a look leads. */
const ORDER: Record<ClaimStatus, number> = { refuted: 0, stale: 1, unknown: 2, supported: 3 };
export const byStatus = (a: PageClaim, b: PageClaim) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);

/** The latest evidence in a line: what a person said and who, or what a check observed. */
export function evidenceLine(latest: PageClaim["latest"]): string | null {
  const content = latest?.content?.trim();
  if (!content) return null;
  if (latest!.mode === "asserted") return `${latest!.by && latest!.by !== "person" ? latest!.by : "A person"} said: “${content}”`;
  return `Checked: ${content}${latest!.by ? ` (${latest!.by})` : ""}`;
}

/** Why the claims are not shown, as one line, from the step's refusal. */
export function claimsUnavailable(message: string): string {
  if (/may not read/.test(message)) return "Claims aren't shown here: this page may not read where the tree is kept.";
  if (/claims layer/.test(message)) return "This server keeps no claims.";
  return `Couldn't read the claims: ${message}`;
}

/** A proposal as `proposal/list { input: true }` answers it. */
export interface PendingChange {
  id: string;
  step: string;
  title: string;
  status: string;
  rationale?: string;
  createdAt: string;
  input?: unknown;
}

/** The steps a change to a Concept is proposed with, and which input names the page it changes. */
const CHANGES: Record<string, string> = {
  "graph/edit-node": "ref_id",
  "graph/move-node": "ref_id",
  "graph/delete-node": "ref_id",
  // A page added under another: the parent's.
  "graph/create-triplet": "source_ref_id",
};

/** The Concept a proposal changes (a new page: the one it goes under), or null. */
export function conceptOfChange(p: Pick<PendingChange, "step" | "input">): string | null {
  const field = CHANGES[p.step];
  const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>;
  if (!field || typeof input[field] !== "string") return null;
  if (p.step === "graph/create-triplet") {
    const target = String(input["target_type"] ?? "").toLowerCase();
    if (String(input["edge_type"] ?? "").toUpperCase() !== "PARENT_OF" || target !== "concept") return null;
  }
  return input[field] as string;
}

/** What still waits on a person: pending, or accepted and failed (it may be accepted again). */
const WAITS = new Set(["pending", "failed"]);

/** The changes waiting, by the Concept they change, oldest first; only Concepts in the tree when one is given. */
export function changesByConcept(list: readonly PendingChange[], tree?: ConceptTree): Map<string, PendingChange[]> {
  const out = new Map<string, PendingChange[]>();
  for (const p of [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!WAITS.has(p.status)) continue;
    const ref = conceptOfChange(p);
    if (!ref || (tree && !tree.nodes[ref])) continue;
    const at = out.get(ref);
    if (at) at.push(p);
    else out.set(ref, [p]);
  }
  return out;
}

/** A Concept that carries claims, as `knowledge/claims` answers it. */
export interface ClaimedConcept {
  concept: string;
  ref_id: string;
  claims: PageClaim[];
}

/** One line of what is waiting across the tree. */
export interface Waiting {
  id: string;
  name: string;
  changes: number;
  refuted: number;
}

/** The Concepts with a change waiting or a claim refuted: changes first, then refuted claims, then by name. */
export function waitingAcross(tree: ConceptTree, changes: ReadonlyMap<string, readonly PendingChange[]>, claimed: readonly ClaimedConcept[]): Waiting[] {
  const rows = new Map<string, Waiting>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, name: tree.nodes[id]!.name, changes: 0, refuted: 0 }));
    return r;
  };
  for (const [id, list] of changes) if (tree.nodes[id]) row(id).changes += list.length;
  for (const c of claimed) {
    const refuted = c.claims.filter((x) => x.status === "refuted").length;
    if (refuted && tree.nodes[c.ref_id]) row(c.ref_id).refuted += refuted;
  }
  return [...rows.values()].sort((a, b) => b.changes - a.changes || b.refuted - a.refuted || a.name.localeCompare(b.name));
}

/** "2 changes · 1 refuted". */
export function waitingWords(w: Pick<Waiting, "changes" | "refuted">): string {
  const parts: string[] = [];
  if (w.changes) parts.push(`${w.changes} change${w.changes === 1 ? "" : "s"}`);
  if (w.refuted) parts.push(`${w.refuted} refuted`);
  return parts.join(" · ");
}
