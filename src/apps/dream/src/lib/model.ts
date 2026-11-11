// Every dream's output read together (plans/dream.md): the causes as they
// stand now, each with everything said for it and every change made for it,
// and the dreams, each with what it found and changed. One run's output
// keeps only a few pieces of evidence per claim; older runs kept older
// ones, so they are added up. Pure: no React, so the tests read it too.
import { changesOf, foundBy, nest, type Claim, type ConceptChange, type DreamOutput, type Outcome, type SaidRow, type TreeConcept } from "./report";

/** One run of the dream workflow, as the app reads it. */
export interface Run {
  runId: string;
  startedAt: string;
  status: string;
  output: DreamOutput;
  error?: string;
}

/** One Concept a dream changed, with the words behind it. */
export interface Change {
  key: string;
  run: Run;
  change: ConceptChange;
  causes: Array<{ claim: Claim; said: SaidRow }>;
}

/** none: no Concept was changed for it. untested: changed, nothing said since. held: followed since. back: corrected again since. */
export type FixState = "none" | "untested" | "held" | "back";

export interface Cause {
  claim: Claim;
  group?: Claim;
  children: Cause[];
  /** Everything said for it that any run's output carried, newest first. */
  said: SaidRow[];
  /** The changes made for it, oldest first. */
  fixes: Change[];
  fix: FixState;
  /** Corrections after the latest change. */
  back: number;
  /** First heard by the newest dream. */
  fresh: boolean;
  lastAt: string;
}

export interface Model {
  /** Newest first. */
  runs: Run[];
  causes: Cause[];
  byId: Map<string, Cause>;
  /** Newest first. */
  changes: Change[];
  tree: TreeConcept[];
}

export const isCorrection = (o: Outcome | undefined): boolean => !!o && o !== "followed";
const saidKey = (e: SaidRow) => `${e.session}|${e.turn}|${e.excerpt}`;
const sameLine = (a: string, b: string) => a.trim() === b.trim();

export function buildModel(runs: readonly Run[]): Model {
  const desc = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const asc = [...desc].reverse();
  const startOf = new Map(asc.map((r) => [r.runId, r.startedAt]));
  const snapshot = desc.find((r) => Array.isArray(r.output.claims) && r.output.claims.length);
  const claims = snapshot?.output.claims ?? [];
  const tree = desc.find((r) => Array.isArray(r.output.tree) && r.output.tree.length)?.output.tree ?? [];

  const said = new Map<string, Map<string, SaidRow>>();
  for (const r of desc) {
    for (const c of r.output.claims ?? []) {
      const m = said.get(c.id) ?? new Map<string, SaidRow>();
      for (const e of c.evidence ?? []) if (!m.has(saidKey(e))) m.set(saidKey(e), e);
      said.set(c.id, m);
    }
  }

  const changes: Change[] = [];
  for (const r of asc) {
    const found = foundBy(r.output.claims, r.runId);
    changesOf(r.output).forEach((change, i) => {
      // A staged dream says which claim each edit was for; an older run's is tied to what it found on that Concept.
      const own = change.claim ? (r.output.claims ?? []).find((c) => c.id === change.claim) : undefined;
      const ids = new Set(change.claim ? [change.claim, ...(own?.children ?? [])] : []);
      changes.push({ key: `${r.runId}:${i}`, run: r, change, causes: found.filter((f) => (change.claim ? ids.has(f.claim.id) : f.claim.about === change.ref_id)) });
    });
  }

  const leaf = (claim: Claim, group?: Claim): Cause => {
    const rows = [...(said.get(claim.id)?.values() ?? [])].sort((a, b) => b.at.localeCompare(a.at) || b.turn - a.turn);
    const fixes = changes.filter((c) => (c.change.claim ? c.change.claim === claim.id || c.change.claim === group?.id : c.causes.some((x) => x.claim.id === claim.id)));
    const last = fixes[fixes.length - 1];
    const after = last ? rows.filter((e) => (startOf.get(e.dream ?? "") ?? "") > last.run.startedAt) : [];
    const back = after.filter((e) => isCorrection(e.outcome)).length;
    // A staged dream puts the fixes and the corrections since the newest one on the claim itself: exact, no guess.
    // A claim fixed through its group carries no fix of its own: its standing is then read off the group's change.
    const own = Array.isArray(claim.fixes) && typeof claim.open === "number" && (claim.fixes.length > 0 || !fixes.length) ? { fixes: claim.fixes, open: claim.open } : undefined;
    const followed = after.some((e) => e.outcome === "followed");
    return {
      claim, ...(group ? { group } : {}), children: [], said: rows, fixes,
      fix: own
        ? !own.fixes.length ? "none" : own.open > 0 ? "back" : followed || claim.evidence[0]?.outcome === "followed" ? "held" : "untested"
        : !last ? "none" : back ? "back" : followed ? "held" : "untested",
      back: own ? (own.fixes.length ? own.open : 0) : back,
      fresh: rows.length > 0 && rows.every((e) => e.dream === snapshot?.runId),
      lastAt: rows[0]?.at ?? "",
    };
  };

  const causes: Cause[] = nest(claims).map(({ claim, children }) => {
    if (!children.length) return leaf(claim);
    const kids = children.map((c) => leaf(c, claim)).sort((a, b) => b.claim.corrected - a.claim.corrected);
    const fixes = [...new Set([...kids.flatMap((k) => k.fixes), ...changes.filter((c) => c.change.claim === claim.id)])].sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
    return {
      claim, children: kids,
      said: kids.flatMap((k) => k.said).sort((a, b) => b.at.localeCompare(a.at)),
      fixes,
      fix: kids.some((k) => k.fix === "back") ? "back" : kids.some((k) => k.fix === "untested") || (fixes.length && !kids.some((k) => k.fix === "held")) ? "untested" : kids.some((k) => k.fix === "held") ? "held" : "none",
      back: kids.reduce((n, k) => n + k.back, 0),
      fresh: kids.every((k) => k.fresh),
      lastAt: kids.map((k) => k.lastAt).sort().pop() ?? "",
    };
  });
  causes.sort((a, b) => b.claim.corrected - a.claim.corrected || b.lastAt.localeCompare(a.lastAt));

  const byId = new Map<string, Cause>();
  for (const c of causes) {
    byId.set(c.claim.id, c);
    for (const k of c.children) byId.set(k.claim.id, k);
  }
  return { runs: desc, causes, byId, changes: changes.reverse(), tree };
}

/** The Concept a change or claim names, as the tree has it: by ref, or by name for one a dream added (it had no ref yet). */
export function conceptOf(model: Model, ref: string, name?: string): TreeConcept | undefined {
  return model.tree.find((t) => t.ref_id === ref) ?? (ref.startsWith("new:") || !ref ? model.tree.find((t) => t.name === (name ?? ref.slice(4))) : undefined);
}

/** The lines written for a cause that its Concept still holds. */
export function inMemory(model: Model, cause: Cause): string[] {
  const out: string[] = [];
  for (const f of cause.fixes) {
    const docs = (conceptOf(model, f.change.ref_id, f.change.name)?.docs ?? "").split("\n");
    for (const l of f.change.added) if (docs.some((d) => sameLine(d, l)) && !out.some((o) => sameLine(o, l))) out.push(l);
  }
  return out;
}

/** A dream in numbers: the Concepts it changed, the corrections it found, and how many claims of those had a change made for them before. */
export function runSummary(model: Model, run: Run): { turns: number; changed: number; found: number; back: number } {
  const found = foundBy(run.output.claims, run.runId).filter((f) => isCorrection(f.said.outcome));
  const earlier = (id: string) => model.byId.get(id)?.fixes.some((f) => f.run.startedAt < run.startedAt) ?? false;
  return {
    turns: run.output.turns ?? 0,
    changed: model.changes.filter((c) => c.run.runId === run.runId).length,
    found: found.length,
    back: new Set(found.filter((f) => earlier(f.claim.id)).map((f) => f.claim.id)).size,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A dream in a line. */
export function headline(model: Model, run: Run): string {
  if (run.status === "running" || run.status === "paused") return "Dreaming";
  if (run.error) return "Did not finish";
  const s = runSummary(model, run);
  if (!s.turns) return "Nothing new to read";
  return [...(s.changed ? [plural(s.changed, "change")] : []), ...(s.found ? [plural(s.found, "correction")] : []), ...(s.back ? [`${s.back} came back`] : [])].join(" · ") || "Nothing found";
}

/** A changed line as one line: the words both have, the words only the old had (`gone`) and only the new has (`new`).
 *  null when the two share too little to read as one line: then they are shown apart. */
export function inlineDiff(a: string, b: string): Array<[string, "same" | "gone" | "new"]> | null {
  const x = a.trim().split(/(\s+)/), y = b.trim().split(/(\s+)/);
  const t = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: Array<[string, "same" | "gone" | "new"]> = [];
  const push = (w: string, kind: "same" | "gone" | "new") => {
    const last = out[out.length - 1];
    // Whitespace between two words of one kind joins them, so a changed phrase is one mark.
    if (last && last[1] === kind) last[0] += w;
    else if (!w.trim() && last) last[0] += w;
    else out.push([w, kind]);
  };
  let i = 0, j = 0, shared = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { if (x[i]!.trim()) shared += 1; push(x[i]!, "same"); i++; j++; }
    else if (t[i + 1]![j]! >= t[i]![j + 1]!) push(x[i++]!, "gone");
    else push(y[j++]!, "new");
  }
  while (i < x.length) push(x[i++]!, "gone");
  while (j < y.length) push(y[j++]!, "new");
  const words = (l: string[]) => l.filter((w) => w.trim()).length;
  return shared * 2 >= Math.max(words(x), words(y)) ? out : null;
}

/** How a staged dream got to what it did, a stage a line: what it counted at each. Empty for an older, one-agent run. */
export function stagesOf(out: DreamOutput): Array<{ stage: string; count: number; text: string }> {
  if (!Array.isArray(out.changes)) return [];
  const records = out.records ?? [];
  const recorded = records.filter((r) => r.recorded);
  const made = recorded.filter((r) => r.created).length;
  const groups = out.groups ?? [];
  const n = (count: number, one: string, many: string) => (count === 1 ? one : many);
  return [
    { stage: "Read", count: out.turns ?? 0, text: `${n(out.turns ?? 0, "turn", "turns")} of conversation since the last dream${out.more ? ", with more waiting for the next one" : ""}` },
    { stage: "Found", count: out.moments ?? 0, text: `${n(out.moments ?? 0, "moment", "moments")} where you corrected the assistant or said how you want things` },
    { stage: "Recorded", count: recorded.length, text: `as evidence on a cause: ${made} on a new cause, ${recorded.length - made} on one already known` },
    { stage: "Grouped", count: groups.length, text: `${n(groups.length, "group", "groups")} made of causes that are the same kind` },
    { stage: "Due", count: out.due ?? 0, text: `${n(out.due ?? 0, "cause", "causes")} due a memory change: said to last, or corrected twice` },
    { stage: "Changed", count: out.changes.length, text: `${n(out.changes.length, "change", "changes")} written to memory` },
  ];
}
