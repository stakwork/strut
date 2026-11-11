/**
 * Where the dream left off (`dream/turns`, `dream/done`): per tree, and per conversation,
 * the last turn it has read. Each tree has its own marks, as each is tended
 * by its own dream over what may be the same conversations. Bookkeeping, so a
 * file under the data directory (`<dataDir>/dream/<tree>.json`) and never
 * the graph: memory is for what the person said.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DreamState {
  /** Conversation id → the last turn number read. */
  marks: Record<string, number>;
  /** When a dream last finished. */
  at?: string;
}

/** A tree's file: its root's name, made safe for a file name. */
const fileOf = (dataDir: string, tree: string) => join(dataDir, "dream", `${tree.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "tree"}.json`);

/** The state, or null when no dream has finished here yet. */
export async function readState(dataDir: string, tree: string): Promise<DreamState | null> {
  try {
    const s = JSON.parse(await readFile(fileOf(dataDir, tree), "utf-8")) as Partial<DreamState>;
    return { marks: s.marks && typeof s.marks === "object" ? s.marks : {}, ...(typeof s.at === "string" ? { at: s.at } : {}) };
  } catch {
    return null;
  }
}

/** Move each mark forward to `cursor`'s, never back. */
export async function advanceState(dataDir: string, tree: string, cursor: Record<string, number>, now: Date): Promise<DreamState> {
  const marks = { ...((await readState(dataDir, tree))?.marks ?? {}) };
  for (const [id, turn] of Object.entries(cursor)) if (Number.isInteger(turn) && turn > (marks[id] ?? -1)) marks[id] = turn;
  const state = { marks, at: now.toISOString() };
  await mkdir(dirname(fileOf(dataDir, tree)), { recursive: true });
  await writeFile(fileOf(dataDir, tree), JSON.stringify(state, null, 2), "utf-8");
  return state;
}

export function dataDirOf(ctx: { services?: unknown } | undefined, step: string): string {
  const dir = (ctx?.services as { dataDir?: string } | undefined)?.dataDir;
  if (!dir) throw new Error(`${step} needs a strut server with a data directory (ctx.services.dataDir)`);
  return dir;
}
