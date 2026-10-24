import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A preset agent's command line run with the host's `PATH`, quoted as
 *  `acp/prompt`'s `parseAgent` reads it (double quotes group). */
export function withPath(path: string, command: string[]): string {
  return ["/usr/bin/env", `PATH=${path}`, ...command].map((p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, "")}"` : p)).join(" ");
}

/**
 * Where a local coding agent's job works in the host's folder `root`
 * (job/start { agent, folder }): a git worktree of it, under the job's own
 * directory, on a branch of its own (`strut/<job>`), so the agent never
 * edits the checkout the person has open. Made once; a later turn of the
 * job finds it. A folder that is not a git repository is worked in place.
 */
export async function jobWorktree(root: string, jobDir: string, job: string): Promise<string> {
  const inside = await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]).then(
    (r) => r.stdout.trim() === "true",
    () => false,
  );
  if (!inside) return root;
  const path = join(jobDir, "worktree");
  const made = await stat(join(path, ".git")).then(() => true, () => false);
  if (!made) await run("git", ["-C", root, "worktree", "add", "-b", `strut/${job}`, path, "HEAD"]);
  return path;
}
