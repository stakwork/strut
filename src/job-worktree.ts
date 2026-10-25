import { stat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./shell.js";

/**
 * Where a local coding agent's job works in the host's folder `root`
 * (job/start { agent, folder }): a git worktree of it, under the job's own
 * directory, on a branch of its own (`strut/<job>`), so the agent never
 * edits the checkout the person has open. A folder inside a repository is
 * the same subfolder of the worktree. Made once; a later turn of the job
 * finds it. A folder that is not in a git repository is worked in place.
 */
export async function jobWorktree(root: string, jobDir: string, job: string): Promise<string> {
  if (!(await stat(root).then((s) => s.isDirectory(), () => false))) {
    throw new Error(`folder_missing: ${root} is not a folder on this machine`);
  }
  const git = (...args: string[]) => runProcess({ cmd: "git", args, cwd: root, timeoutMs: 60_000 });
  const where = await git("rev-parse", "--is-inside-work-tree", "--show-prefix");
  const [inside, prefix = ""] = where.stdout.split("\n");
  if (where.code !== 0 || inside !== "true") return root;
  const path = join(jobDir, "worktree");
  if (!(await stat(join(path, ".git")).then(() => true, () => false))) {
    const made = await git("worktree", "add", "-b", `strut/${job}`, path, "HEAD");
    if (made.code !== 0) throw new Error(`worktree: could not make a worktree of ${root}: ${made.stderr.trim()}`);
  }
  return join(path, prefix.replace(/\/$/, ""));
}
