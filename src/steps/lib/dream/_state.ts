/**
 * Where the dream left off (`dream/turns`, `dream/done`): per tree, and per conversation,
 * the last turn it has read. Each tree has its own marks, as each is tended
 * by its own dream over what may be the same conversations. Bookkeeping, so a
 * file under the data directory (`<dataDir>/dream/<tree>.json`) and never
 * the graph: memory is for what the person said.
 *
 * A dream run on a Concept BRANCH (plans/concept-evals.md item d) keeps
 * marks of its own, `<dataDir>/dream/branch-<name>/<tree>.json`, so trying a
 * dream on a branch never moves main's: its first read starts where main's
 * dream is then, and a branch made again under a dropped one's name starts
 * so too (the file names the branch it was written for, by when it was made).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DreamState {
  /** Conversation id → the last turn number read. */
  marks: Record<string, number>;
  /** Where the next read starts: only the conversations written at or after
   *  this time can hold a turn past the marks (`conversations.changed`). A
   *  state from before it has none: that dream reads every conversation. */
  since?: string;
  /** When a dream last finished. */
  at?: string;
  /** A branch's file: the branch it was written for. */
  branch?: DreamBranch;
}

/** The Concept branch a dream runs on: its name, and when it was made. */
export interface DreamBranch {
  name: string;
  createdAt?: string;
}

/** A tree's file: its root's name, made safe for a file name; a branch's in a folder of its own. */
const fileOf = (dataDir: string, tree: string, branch?: string) =>
  join(dataDir, "dream", ...(branch ? [`branch-${branch}`] : []), `${tree.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "tree"}.json`);

async function readAt(file: string): Promise<DreamState | null> {
  try {
    const s = JSON.parse(await readFile(file, "utf-8")) as Partial<DreamState>;
    return {
      marks: s.marks && typeof s.marks === "object" ? s.marks : {},
      ...(typeof s.since === "string" ? { since: s.since } : {}),
      ...(typeof s.at === "string" ? { at: s.at } : {}),
      ...(s.branch && typeof s.branch.name === "string" ? { branch: s.branch } : {}),
    };
  } catch {
    return null;
  }
}

/** The state, or null when no dream has finished here yet. On a branch,
 *  its own once its dream finished there, else main's: where it starts. */
export async function readState(dataDir: string, tree: string, branch?: DreamBranch): Promise<DreamState | null> {
  if (branch) {
    const own = await readAt(fileOf(dataDir, tree, branch.name));
    if (own && own.branch?.createdAt === branch.createdAt) return own;
  }
  const main = await readAt(fileOf(dataDir, tree));
  return main && branch ? { marks: main.marks, ...(main.since ? { since: main.since } : {}), ...(main.at ? { at: main.at } : {}) } : main;
}

/** Move each mark forward to `cursor`'s, never back, and the next read's
 *  start to `since` (dream/turns gave both); main's, or the branch's own. */
export async function advanceState(dataDir: string, tree: string, cursor: Record<string, number>, now: Date, branch?: DreamBranch, since?: string): Promise<DreamState> {
  const prev = await readState(dataDir, tree, branch);
  const marks = { ...(prev?.marks ?? {}) };
  for (const [id, turn] of Object.entries(cursor)) if (Number.isInteger(turn) && turn > (marks[id] ?? -1)) marks[id] = turn;
  const start = since ?? prev?.since;
  const state: DreamState = { marks, ...(start ? { since: start } : {}), at: now.toISOString(), ...(branch ? { branch } : {}) };
  const file = fileOf(dataDir, tree, branch?.name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf-8");
  return state;
}

/** The branch a dream's step runs on (`ctx.branch`), with when it was made
 *  (`ctx.services.branches`); undefined on main. */
export async function branchOfDream(ctx: { branch?: string; services?: unknown } | undefined): Promise<DreamBranch | undefined> {
  const name = ctx?.branch;
  if (!name) return undefined;
  const branches = (ctx?.services as { branches?: { get(name: string): Promise<{ createdAt: string } | null> } } | undefined)?.branches;
  const made = await branches?.get(name).catch(() => null);
  return { name, ...(made?.createdAt ? { createdAt: made.createdAt } : {}) };
}

export function dataDirOf(ctx: { services?: unknown } | undefined, step: string): string {
  const dir = (ctx?.services as { dataDir?: string } | undefined)?.dataDir;
  if (!dir) throw new Error(`${step} needs a strut server with a data directory (ctx.services.dataDir)`);
  return dir;
}
