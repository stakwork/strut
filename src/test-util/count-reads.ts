/**
 * The files a piece of code reads: `readFile` from `node:fs/promises`
 * wrapped while `fn` runs, the builtin's ESM bindings synced so a module's
 * own `import { readFile }` goes through it. For the tests that hold a read
 * to what it returns (or what changed since a mark), never every record on
 * file: a server holds 100k+ of them after months.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises") as { readFile: (...args: unknown[]) => Promise<unknown> };

/** `fn`'s value, and each file under `dir` it read, in order (a file read twice is listed twice). */
export async function countReads<T>(dir: string, fn: () => Promise<T>): Promise<{ value: T; reads: string[] }> {
  const reads: string[] = [];
  const readFile = fsp.readFile;
  fsp.readFile = (file: unknown, ...rest: unknown[]) => {
    if (typeof file === "string" && file.startsWith(dir)) reads.push(file);
    return readFile(file, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return { value: await fn(), reads };
  } finally {
    fsp.readFile = readFile;
    syncBuiltinESMExports();
  }
}
