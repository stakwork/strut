/**
 * Where the dream left off (plans/dream.md): per conversation, the last turn
 * it has read. Bookkeeping, so a file under the data directory
 * (`<dataDir>/dream/state.json`) and never the graph: memory is for what the
 * person said.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DreamState {
  /** Conversation id → the last turn number read. */
  marks: Record<string, number>;
  /** When a dream last finished. */
  at?: string;
}

const fileOf = (dataDir: string) => join(dataDir, "dream", "state.json");

/** The state, or null when no dream has finished here yet. */
export async function readState(dataDir: string): Promise<DreamState | null> {
  try {
    const s = JSON.parse(await readFile(fileOf(dataDir), "utf-8")) as Partial<DreamState>;
    return { marks: s.marks && typeof s.marks === "object" ? s.marks : {}, ...(typeof s.at === "string" ? { at: s.at } : {}) };
  } catch {
    return null;
  }
}

/** Move each mark forward to `cursor`'s, never back. */
export async function advanceState(dataDir: string, cursor: Record<string, number>, now: Date): Promise<DreamState> {
  const marks = { ...((await readState(dataDir))?.marks ?? {}) };
  for (const [id, turn] of Object.entries(cursor)) if (Number.isInteger(turn) && turn > (marks[id] ?? -1)) marks[id] = turn;
  const state = { marks, at: now.toISOString() };
  await mkdir(dirname(fileOf(dataDir)), { recursive: true });
  await writeFile(fileOf(dataDir), JSON.stringify(state, null, 2), "utf-8");
  return state;
}

export function dataDirOf(ctx: { services?: unknown } | undefined, step: string): string {
  const dir = (ctx?.services as { dataDir?: string } | undefined)?.dataDir;
  if (!dir) throw new Error(`${step} needs a strut server with a data directory (ctx.services.dataDir)`);
  return dir;
}
