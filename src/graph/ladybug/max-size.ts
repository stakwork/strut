// How much address space a Ladybug `Database` reserves on open (the addon's
// `maxDBSize`): the workspace graph (db.ts) and the memory graph
// (steps/lib/memory/_db.ts) both open with it. It is also the largest the
// file may grow to, but it is not kept in the file: a graph made under one
// size opens under any other power of two at least as big as the file
// (Ladybug says "Reopen the database with a larger max_db_size" when it is
// not), so a graph moved from a Mac opens on a Pi.
//
// Reserved, never used up front, and `close()` never returns it: a process
// that opens a graph N times holds N of them. 64 GiB, where it was 1 TiB:
// an arm64 kernel with 39-bit addresses (Raspberry Pi OS) gives a process
// 512 GiB in all, and 1 TiB failed every open there ("Mmap for size
// 1099511627776 failed"). Two graphs, a reopen or two and node itself fit
// under that, and no personal graph comes near 64 GiB.
import { bootEnv } from "../../env.js";

export const DEFAULT_MAX_DB_SIZE = 2 ** 36;
const MIN = 2 ** 23; // Ladybug's floor

const UNITS: Record<string, number> = { "": 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 };

/** `STRUT_LADYBUG_MAX_DB_SIZE` — bytes, or with a binary unit (`64G`,
 *  `512MiB`) — a power of two of at least 8 MiB; else the default. A value
 *  Ladybug would refuse fails here, naming the setting. */
export function ladybugMaxDbSize(env: NodeJS.ProcessEnv = bootEnv()): number {
  const raw = env["STRUT_LADYBUG_MAX_DB_SIZE"]?.trim();
  if (!raw) return DEFAULT_MAX_DB_SIZE;
  const m = /^(\d+)\s*([kmgt]?)(?:i?b)?$/i.exec(raw);
  const size = m ? Number(m[1]) * UNITS[m[2]!.toLowerCase()]! : NaN;
  if (!Number.isSafeInteger(size) || size < MIN || !isPowerOfTwo(size)) {
    throw new Error(`STRUT_LADYBUG_MAX_DB_SIZE=${raw}: must be a power of two of at least 8 MiB, in bytes or with a unit (64G)`);
  }
  return size;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && Math.log2(n) % 1 === 0;
}
