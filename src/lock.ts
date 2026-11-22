/** One writer per key within this process (moved out of jobs.ts so low-level modules can use it without its imports). */

const locks = new Map<string, Promise<void>>();

/** Serialize work on one key within this process — a git cache (two runs
 *  of the same repository fetch and add worktrees one after the other), a
 *  job record. */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
