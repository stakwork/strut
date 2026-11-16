/**
 * MERGE a Concept branch into main (plans/concept-evals.md item e; src/
 * branches.ts holds the lock and the drop). What the branch changed since
 * its fork — `base..<branch>` under `concepts/` in the history (src/
 * history.ts): pages edited, added or removed, and their `PARENT_OF` links,
 * which a page's file holds as its `parents` — is applied to main:
 *
 *   - CONFLICT: a page main ALSO changed since the fork (`base..main`) to
 *     anything but what the branch has refuses the whole merge, naming those
 *     pages: re-run the trial on a fresh branch. A page only main changed
 *     stays as it is.
 *   - ORDINARY pages land on main at once, one commit in the history
 *     (`merge <branch>`). A page the branch ADDS is ordinary, even under a
 *     page from git.
 *   - A page whose text comes FROM GIT (main's node carries a seed or a
 *     package stamp, src/concept-sources.ts) is never changed here: its
 *     change goes into ONE proposal per writable checkout, and is skipped,
 *     and listed, where there is none.
 *
 * The branch's evidence stays on the branch: main's new page versions start
 * unmeasured (claims are about main's node, and its status counts main's
 * works only). The merge reads the history, so it needs it on.
 */
import { posix } from "node:path";
import { declaredAttributes, findConcepts, parseConceptFile, type ConceptFile } from "./concept-seed.js";
import type { ConceptSources, PageSource, ProposedCheckout, SkippedPage } from "./concept-sources.js";
import type { GraphBackend } from "./graph/backend.js";
import type { History } from "./history.js";
import type { Proposal } from "./proposals.js";

const CONCEPT = "Concept";
const PARENT_OF = "PARENT_OF";

export type PageChange = "added" | "edited" | "removed";

/** One page the branch changed. */
export interface MergePage {
  name: string;
  /** Its file in the history, `concepts/<key>.md`. */
  path: string;
  change: PageChange;
}

/** What a merge does, or did. */
export interface MergeResult {
  branch: string;
  /** The fork point (main's commit when the branch was made), the branch's
   *  last commit, and main's commit the merge read. */
  base: string;
  head: string;
  main: string;
  /** Ordinary pages, on main at once. */
  landed: MergePage[];
  /** Pages from git, one proposal per checkout. */
  proposed: ProposedCheckout[];
  /** Pages from git with no checkout here: not changed. */
  skipped: SkippedPage[];
  /** What a link the merge could not write is (a parent main no longer has). */
  notes?: string[];
  /** Main's commit after the merge, when it made one. */
  commit?: string;
  /** A dry run: what would happen, nothing written. */
  dryRun?: true;
}

/** Pages main changed too, by name: the merge is refused. */
export class MergeConflict extends Error {
  readonly status = 409 as const;
  constructor(
    readonly branch: string,
    readonly pages: string[],
  ) {
    super(
      `merge_conflict: main changed ${pages.join(", ")} since branch "${branch}" forked, and the branch changed ${pages.length === 1 ? "it" : "them"} too — ` +
        `nothing was merged; run the trial again on a fresh branch made from main now`,
    );
    this.name = "MergeConflict";
  }
}

/** A merge refused for another reason (no history, an empty branch). */
export class MergeRefused extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "MergeRefused";
  }
}

export interface MergeDeps {
  graph: GraphBackend;
  history?: Pick<History, "settle" | "sync" | "git" | "touch">;
  sources?: ConceptSources;
}

/** What the plan read: each page the branch changed, with its two sides. */
interface Planned extends MergePage {
  before?: ConceptFile;
  after?: ConceptFile;
  /** The branch's file, as the history holds it. */
  text?: string;
  source?: PageSource;
}

/** `git … -z` output → its fields. */
const fields = (out: string) => out.split("\0").filter(Boolean);

/**
 * Read what the branch changed since its fork and sort it: conflicts
 * (thrown), ordinary pages, pages from git. Nothing is written.
 */
export async function planMerge(deps: MergeDeps, branch: { name: string; createdAt: string; from: string }, actor?: string): Promise<{ base: string; head: string; main: string; pages: Planned[] }> {
  const history = deps.history;
  if (!history) throw new MergeRefused(409, `merge_needs_history: a merge reads what branch "${branch.name}" changed since its fork from the history, which is off on this strut server (STRUT_HISTORY=0, or no git)`);
  if (branch.from === "empty") {
    throw new MergeRefused(409, `merge_refused: branch "${branch.name}" was made empty, not from main: against its fork it removes every page main has, so it is not merged — make the trial from main`);
  }
  // Main's commit is the live tree (a raw write it had not heard), the branch's what its runs wrote.
  await history.settle();
  await history.sync(actor);
  const rev = async (ref: string) => (await history.git(["rev-parse", "-q", "--verify", `${ref}^{commit}`]).catch(() => "")).trim();
  const main = await rev("refs/heads/main");
  const head = await rev(`refs/heads/${branch.name}`);
  if (!main || !head) throw new MergeRefused(409, `merge_needs_history: branch "${branch.name}" has no git branch in the history to read what it changed`);
  const base = (await history.git(["merge-base", main, head])).trim();
  // A git branch made after the branch (the history was off then) starts
  // at a later main: its fork point would not be the branch's.
  const forkAt = Number((await history.git(["show", "-s", "--format=%ct", base])).trim());
  if (forkAt * 1000 > Date.parse(branch.createdAt) + 2_000) {
    throw new MergeRefused(409, `merge_needs_history: branch "${branch.name}"'s git branch was made after it (the history was off then), so what it changed since its fork is not known — run the trial again on a fresh branch`);
  }
  const show = async (rev: string, path: string) => history.git(["show", `${rev}:${path}`]).catch(() => undefined);
  const parse = (path: string, text: string | undefined) => (text === undefined ? undefined : parseConceptFile(posix.basename(path), text, ""));

  const theirs = fields(await history.git(["diff", "--name-status", "--no-renames", "-z", base, head, "--", "concepts/"]));
  const ours = new Set(fields(await history.git(["diff", "--name-only", "--no-renames", "-z", base, main, "--", "concepts/"])));
  const pages: Planned[] = [];
  const conflicts: string[] = [];
  for (let i = 0; i + 1 < theirs.length; i += 2) {
    const status = theirs[i]!;
    const path = theirs[i + 1]!;
    const change: PageChange = status === "A" ? "added" : status === "D" ? "removed" : "edited";
    const text = change === "removed" ? undefined : await show(head, path);
    const before = change === "added" ? undefined : parse(path, await show(base, path));
    const after = parse(path, text);
    const name = (after ?? before)?.name ?? posix.basename(path, ".md");
    if (ours.has(path)) {
      // Main changed it too: a conflict, unless both ended the same.
      if ((await show(main, path)) !== text) conflicts.push(name);
      continue;
    }
    pages.push({ name, path, change, ...(before ? { before } : {}), ...(after ? { after } : {}), ...(text !== undefined ? { text } : {}) });
  }
  if (conflicts.length) throw new MergeConflict(branch.name, [...new Set(conflicts)].sort());
  // A page main holds from git (edited or removed on the branch; an added
  // one is ordinary) is never changed here.
  const git = deps.sources ? await deps.sources.fromGit(pages.filter((p) => p.change !== "added").map((p) => p.before!.name)) : new Map<string, PageSource>();
  for (const p of pages) {
    const source = p.change !== "added" ? git.get(p.before!.name) : undefined;
    if (source) p.source = source;
  }
  return { base, head, main, pages };
}

/** Land the ordinary pages on main: nodes, then links, then removals. */
export async function landPages(graph: GraphBackend, pages: Planned[]): Promise<string[]> {
  const notes: string[] = [];
  if (!pages.length) return notes;
  const schema = await graph.schemas.schema(CONCEPT);
  if (!schema) throw new Error("this graph has no Concept type");
  const names = new Set<string>();
  for (const p of pages) for (const f of [p.before, p.after]) if (f) [f.name, ...f.parents].forEach((n) => names.add(n));
  const found = await findConcepts(graph, schema, names);
  const live = new Map([...found].filter(([, n]) => !n.deleted).map(([name, n]) => [name, n.ref_id]));

  for (const p of pages) {
    if (!p.after) continue;
    const { kept } = declaredAttributes(schema, p.after.attributes);
    const set: Record<string, unknown> = { ...kept, ...(p.after.docs ? { docs: p.after.docs } : {}) };
    const at = live.get(p.after.name);
    if (p.change === "edited" && at) {
      const was = p.before ? Object.keys(declaredAttributes(schema, p.before.attributes).kept) : [];
      const remove = [...was.filter((k) => !(k in set)), ...(p.before?.docs && !p.after.docs ? ["docs"] : [])];
      await graph.nodes.update(at, { set, remove });
    } else {
      live.set(p.after.name, (await graph.nodes.write({ type: CONCEPT, data: { name: p.after.name, ...set } }, "upsert")).ref_id);
    }
  }
  for (const p of pages) {
    if (!p.after) continue;
    const child = live.get(p.after.name)!;
    const was = p.change === "edited" ? (p.before?.parents ?? []) : [];
    for (const parent of p.after.parents.filter((x) => !was.includes(x))) {
      const from = live.get(parent);
      if (!from) notes.push(`${p.after.name} is under ${parent} on the branch, and main has no page ${parent}: not linked`);
      else await graph.edges.write({ edge: PARENT_OF, source_ref_id: from, target_ref_id: child });
    }
    const dropped = was.filter((x) => !p.after!.parents.includes(x)).map((x) => live.get(x)).filter((x): x is string => !!x);
    if (dropped.length) {
      const ups = await graph.tx((tx) => graph.edgeEngine.liveEdgesOf(tx, child, PARENT_OF, false));
      for (const e of ups?.edges ?? []) if (dropped.includes(e.other)) await graph.edges.delete({ ref_id: e.edge_ref_id, edge: PARENT_OF });
    }
  }
  for (const p of pages) {
    if (p.change !== "removed" || !p.before) continue;
    const at = live.get(p.before.name);
    if (at) await graph.nodes.deleteNode(at);
  }
  return notes;
}

/**
 * The merge, inside the branch's lock: plan, then (unless `dryRun`) land
 * the ordinary pages as one commit, propose the pages from git per
 * checkout. The caller drops the branch afterwards.
 */
export async function mergeBranch(
  deps: MergeDeps,
  branch: { name: string; createdAt: string; from: string },
  o: { actor?: string; run?: string; by?: Proposal["by"]; dryRun?: boolean } = {},
): Promise<MergeResult> {
  const plan = await planMerge(deps, branch, o.actor);
  const ordinary = plan.pages.filter((p) => !p.source);
  const fromGit = plan.pages.filter((p): p is Planned & { source: PageSource } => !!p.source);
  const brief = (p: Planned): MergePage => ({ name: p.name, path: p.path, change: p.change });
  const out: MergeResult = { branch: branch.name, base: plan.base, head: plan.head, main: plan.main, landed: ordinary.map(brief), proposed: [], skipped: [] };
  if (o.dryRun) {
    // What would be proposed: the checkouts, no record written.
    const groups = new Map<string, ProposedCheckout>();
    for (const p of fromGit) {
      const change = p.change === "removed" ? ("removed" as const) : ("edited" as const);
      if (!p.source.checkout) out.skipped.push({ name: p.name, change, source: `${p.source.set}${p.source.file}`, why: p.source.why ?? "there is no checkout to write it to" });
      else {
        const g = groups.get(p.source.checkout) ?? { checkout: p.source.checkout, proposal: "", url: "", pages: [] };
        g.pages.push({ name: p.name, change });
        groups.set(p.source.checkout, g);
      }
    }
    out.proposed = [...groups.values()];
    return { ...out, dryRun: true };
  }
  const history = deps.history!;
  let notes: string[] = [];
  try {
    notes = await landPages(deps.graph, ordinary);
  } finally {
    // What landed is one commit, whatever stopped it.
    if (ordinary.length) history.touch({ cause: `merge ${branch.name}`, ...(o.actor ? { actor: o.actor } : {}), ...(o.run ? { run: o.run } : {}) });
    await history.settle();
  }
  if (ordinary.length) {
    const now = (await history.git(["rev-parse", "refs/heads/main"]).catch(() => "")).trim();
    if (now && now !== plan.main) out.commit = now;
  }
  if (notes.length) out.notes = notes;
  if (fromGit.length && deps.sources) {
    const by = o.by ?? { workflow: "", runId: `merge-${branch.name}-${Date.now()}`, path: `branches/${branch.name}/merge`, ...(o.actor ? { actor: o.actor } : {}) };
    const made = await deps.sources.propose(
      fromGit.map((p) => ({ source: p.source, ...(p.text !== undefined ? { text: p.text } : {}) })),
      { by, cause: `the merge of Concept branch "${branch.name}"` },
    );
    out.proposed = made.proposed;
    out.skipped = made.skipped;
  }
  return out;
}
