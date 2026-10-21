import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Content hash for a workflow or step version, used purely as an internal
 * **dedup key**: identical content yields the same hash, so re-seeding
 * unchanged templates is a no-op and edited templates are detected. The hash
 * is stored in version metadata — it is NOT the user-facing version id.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 12);
}

/**
 * Allocate the next sequential, user-facing version label (`v1`, `v2`, …)
 * given the set of existing version ids. Non-`vN` ids are ignored for
 * numbering (but still counted as existing, so labels never collide).
 */
export function nextVersionLabel(existing: string[]): string {
  let max = 0;
  for (const v of existing) {
    const m = /^v(\d+)$/.exec(v);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return `v${max + 1}`;
}

// ── Tree hash ───────────────────────────────────────────────────────────────

/** What a tree hash and an app build leave out (plans/apps.md §1.1, §1.3):
 *  the derived document (`dist/`) and the app's own data (`data.db`) at the
 *  top, dotfiles and `node_modules/` at any depth. */
export function treeExcluded(relPath: string, name: string): boolean {
  if (name.startsWith(".") || name === "node_modules") return true;
  return relPath === "dist" || relPath === "data.db";
}

/** Every file under `dir` the tree hash covers, as sorted `/`-joined
 *  relative paths. `[]` for a directory that does not exist. */
export async function treeFiles(dir: string, excluded: (relPath: string, name: string) => boolean = treeExcluded): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(rel ? join(dir, rel) : dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT" && !rel) return;
      throw err;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (excluded(relPath, e.name)) continue;
      if (e.isDirectory()) await walk(relPath);
      else if (e.isFile()) out.push(relPath);
    }
  };
  await walk("");
  return out.sort();
}

/**
 * The TREE HASH of a directory (plans/apps.md §1.3, `marketplace.md` §1):
 * sha256 over `<path>\0<sha256 of the bytes>\n` for every file `treeFiles`
 * lists, sorted by path — an app version's identity, and a package's
 * digest, one function. The kit an app was built against is not in it: the
 * built document under `dist/` is derived, and `data.db` is the app's data.
 */
export async function treeHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  for (const rel of await treeFiles(dir)) {
    const file = createHash("sha256").update(await readFile(join(dir, rel))).digest("hex");
    h.update(`${rel}\0${file}\n`);
  }
  return h.digest("hex");
}
