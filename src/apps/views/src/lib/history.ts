// What ConceptDiff and ConceptHistory read (plans/concept-history.md §4, §8
// item 4): `history/read` — the workspace as a package directory in git —
// and, for a pending proposal, `proposal/get` and the nodes it names. Every
// read is a step on the importing app's grants. What a change MEANS is the
// kit's fold (`@strut/kit` concept-diff); this file only asks.
import type { StrutClient } from "@strut/kit";
import {
  historyEntries, pageOf, proposalEntry, proposalRefs, proposalTarget, conceptPagePath,
  type ConceptEntry, type ConceptPage, type ConceptProposal, type HistoryDiffEntry,
} from "@strut/kit/folds";
import { getNodes } from "./graph-steps";

/** The step the history is read through: one grant, `effect: "read"`. */
export const HISTORY_STEP = "history/read";
export const PROPOSAL_GET_STEP = "proposal/get";

/** One commit as `history/read log` gives it, newest first. */
export interface HistoryCommit {
  id: string;
  time: string;
  author: string;
  subject: string;
  /** The runs that wrote (the `Run:` trailers). */
  runs: string[];
  changes: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; from?: string }>;
}

/** A strut with no history answers so, and a view says it. */
export class NoHistoryError extends Error {
  readonly noHistory = true;
}

function answered<T>(r: unknown): T {
  if (r && typeof r === "object" && (r as { history?: unknown }).history === false) {
    throw new NoHistoryError(String((r as { message?: unknown }).message ?? "There is no history on this strut server."));
  }
  if (typeof r === "string") throw new Error(r);
  return r as T;
}

/** A path's commits, newest first, with one more than `limit` read: the
 *  commit before the oldest shown, so its change can be drawn too. */
export async function readLog(client: StrutClient, opts: { path?: string; limit?: number; from?: string; to?: string }): Promise<{ commits: HistoryCommit[]; more: boolean }> {
  const limit = opts.limit ?? 20;
  const r = answered<{ commits: HistoryCommit[]; more?: boolean }>(
    await client.run(HISTORY_STEP, { action: "log", limit: limit + 1, ...(opts.path ? { path: opts.path } : {}), ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) }),
  );
  return { commits: r.commits ?? [], more: !!r.more };
}

/** A page at a commit or time, parsed; undefined when it is not there. */
export async function readPage(client: StrutClient, path: string, at: string): Promise<ConceptPage | undefined> {
  try {
    const r = answered<{ parsed?: unknown; kind?: string }>(await client.run(HISTORY_STEP, { action: "show", path, at }));
    return pageOf(r as { parsed?: ConceptPage });
  } catch (err) {
    if (err instanceof NoHistoryError) throw err;
    // `show` throws for a path that is not there then: no page.
    if (/no .* at |no commit at or before/.test(err instanceof Error ? err.message : String(err))) return undefined;
    throw err;
  }
}

/** The Concept pages that differ between two commits or times (`path`: the folder, `concepts` by default). */
export async function readDiff(client: StrutClient, opts: { from: string; to: string; path?: string; limit?: number }): Promise<{ entries: ConceptEntry[]; more: boolean; from: string | null; to: string }> {
  const r = answered<{ entries: HistoryDiffEntry[]; more?: boolean; from: string | null; to: string }>(
    await client.run(HISTORY_STEP, { action: "diff", from: opts.from, to: opts.to, path: opts.path ?? "concepts", limit: opts.limit ?? 500 }),
  );
  return { entries: historyEntries(r.entries ?? []), more: !!r.more, from: r.from, to: r.to };
}

/** A commit's change to one page in a log of that page (newest first): the
 *  path it has there, and where it had before (a rename), and so which
 *  `show`s draw it — the page after this commit, and after the one before. */
export function commitReads(commits: readonly HistoryCommit[], i: number): { after?: { path: string; at: string }; before?: { path: string; at: string } } {
  const c = commits[i];
  if (!c) return {};
  const change = c.changes[0];
  if (!change) return {};
  const older = commits[i + 1];
  return {
    ...(change.status !== "deleted" ? { after: { path: change.path, at: c.id } } : {}),
    ...(change.status !== "added" && older ? { before: { path: change.from ?? change.path, at: older.id } } : {}),
  };
}

/** Two commits of one page's log compared: the page after the older, and after the newer. */
export function compareReads(commits: readonly HistoryCommit[], a: number, b: number): { before?: { path: string; at: string }; after?: { path: string; at: string } } {
  const [newer, older] = a < b ? [commits[a], commits[b]] : [commits[b], commits[a]];
  const at = (c: HistoryCommit | undefined) => {
    const ch = c?.changes[0];
    return c && ch && ch.status !== "deleted" ? { path: ch.path, at: c.id } : undefined;
  };
  const before = at(older);
  const after = at(newer);
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** The entry those reads give. */
export async function readEntry(client: StrutClient, reads: { before?: { path: string; at: string }; after?: { path: string; at: string } }): Promise<ConceptEntry | null> {
  const [before, after] = await Promise.all([
    reads.before ? readPage(client, reads.before.path, reads.before.at) : undefined,
    reads.after ? readPage(client, reads.after.path, reads.after.at) : undefined,
  ]);
  if (!before && !after) return null;
  const path = reads.after?.path ?? reads.before!.path;
  const from = reads.before && reads.before.path !== path ? reads.before.path : undefined;
  return { path, ...(from ? { from } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** A proposal as `proposal/get` answers it. */
export interface ProposalRecord extends ConceptProposal {
  id: string;
  title?: string;
  status?: string;
  rationale?: string;
}

/**
 * A PENDING PROPOSAL as an entry: `proposal/get`, the nodes it names (their
 * names, `graph/graph-get-batched`), and the page it changes as it is now
 * (`history/read show { at: "main" }`), the proposal's input laid over it.
 * Null when it changes no Concept page.
 */
export async function readProposalEntry(client: StrutClient, id: string): Promise<{ proposal: ProposalRecord; entry: ConceptEntry | null }> {
  const proposal = answered<ProposalRecord>(await client.run(PROPOSAL_GET_STEP, { id }));
  const refs = proposalRefs(proposal);
  const nodes = refs.length ? await getNodes(client, refs) : new Map();
  const nameOf = (ref: string) => {
    const n = nodes.get(ref);
    return n && !("error" in n) ? n.name : undefined;
  };
  const target = proposalTarget(proposal);
  let current: { path: string; page: ConceptPage } | null = null;
  if (target) {
    const n = nodes.get(target);
    if (n && !("error" in n) && n.node_type.toLowerCase() === "concept" && n.name) {
      const path = await conceptPagePath(n.name);
      const page = path ? await readPage(client, path, "main") : undefined;
      if (path && page) current = { path, page };
    }
  }
  return { proposal, entry: proposalEntry(proposal, current, nameOf) };
}
