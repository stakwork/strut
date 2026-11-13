/**
 * A test's files (plans/human-steps.md §7.1): `<dataDir>/tasks/tests/<test
 * id>/<path>`, owner-only, or memory where the task store is. An instance's
 * `task/file` reads here, under the same path a real task's file has, and
 * a test made from a real task copies that task's files here: the run's may
 * be removed later, and a missing file would be a tell.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** The most one test file may be: what `task/file` can hand a page through
 *  an app's `step_run` (5 MB of JSON, base64 inside it: about 3.7 MB of
 *  binary, §5.5), so a test never fails where a real task would not. */
export const TEST_FILE_MAX_BYTES = 3_800_000;

export interface TestFiles {
  put(test: string, path: string, bytes: Uint8Array): Promise<void>;
  /** Null when it is not there. */
  read(test: string, path: string): Promise<Uint8Array | null>;
  has(test: string, path: string): Promise<boolean>;
}

/** `<dataDir>/tasks/tests`. */
export function testFilesRoot(dataDir: string): string {
  return join(dataDir, "tasks", "tests");
}

const TEST_ID_RE = /^[0-9a-f]{32}$/;

/** Under `root`, one folder per test, each path kept inside its folder. */
export function dirTestFiles(root: string): TestFiles {
  const where = (test: string, path: string) => {
    if (!TEST_ID_RE.test(test)) throw new Error(`not a test id: ${JSON.stringify(test)}`);
    const dir = resolve(root, test);
    const file = resolve(dir, path);
    if (!file.startsWith(dir + sep)) throw new Error(`not a path under the test's files: ${JSON.stringify(path)}`);
    return file;
  };
  return {
    async put(test, path, bytes) {
      const file = where(test, path);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { mode: 0o600 });
    },
    async read(test, path) {
      try {
        return new Uint8Array(await readFile(where(test, path)));
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "EISDIR") return null;
        throw err;
      }
    },
    async has(test, path) {
      try {
        return (await stat(where(test, path))).isFile();
      } catch (err: any) {
        if (err?.code === "ENOENT") return false;
        throw err;
      }
    },
  };
}

export function memoryTestFiles(): TestFiles {
  const files = new Map<string, Uint8Array>();
  const key = (test: string, path: string) => `${test}\0${path}`;
  return {
    async put(test, path, bytes) {
      files.set(key(test, path), new Uint8Array(bytes));
    },
    async read(test, path) {
      const b = files.get(key(test, path));
      return b ? new Uint8Array(b) : null;
    },
    async has(test, path) {
      return files.has(key(test, path));
    },
  };
}
