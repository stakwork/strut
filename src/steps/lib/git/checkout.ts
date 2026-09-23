import { existsSync } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import {
  cachePath,
  cancelSignal,
  dataDirOf,
  git,
  gitOk,
  parseRepo,
  shellOf,
  withLock,
  worktreeRoot,
  type GitCtx,
} from "./_shared.js";

const EXAMPLE = `- id: checkout
  type: git/checkout
  config:
    repo: "https://github.com/{{ input.owner }}/{{ input.repo }}"
- id: change
  type: agent
  config:
    cwd: "{{ checkout.path }}"
    prompt: "{{ input.prompt }}"`;

/**
 * A fresh, isolated working copy of a repository at a ref — what an `agent`
 * or `exec` step works in (`cwd`). Internally a credential-free bare cache
 * per remote under `<dataDir>/repos/` (cloned once, fetched after) plus a
 * detached worktree per run under `<dataDir>/worktrees/<runId>/`, removed
 * when the run ends (`ctx.onRunEnd`) — success, error or cancel.
 *
 * The token (the `tokenSecret` secret — the run's principal's when the
 * deployment has actor secrets) reaches git through the child env and an
 * inline credential helper only; the checkout stores no credential, so the
 * agent's bash cannot push from it. See `_shared.ts`.
 */
export default defineStep({
  type: "git/checkout",
  description:
    `Check out a git repository into a fresh, isolated working copy for this run and return its path — the cwd for an agent or exec step. ` +
    `Clones once into a credential-free cache and fetches on later runs; the working copy is removed when the run ends. ` +
    `ref: a branch, tag or commit sha (default: the remote's default branch). ` +
    `Auth: the tokenSecret secret (default GITHUB_TOKEN), needed for private repos — the value only ever reaches git's child env, never the log or the checkout. ` +
    `Output: { path, sha, ref, branch, repo, host, url } — branch is the remote's default branch.\n\n${EXAMPLE}`,
  input: z.object({
    repo: z.string().min(1).describe("repository URL, e.g. https://github.com/owner/repo — no credentials in the URL"),
    ref: z.string().min(1).optional().describe("branch, tag or commit sha to check out; omit for the remote's default branch"),
    tokenSecret: z
      .string()
      .default("GITHUB_TOKEN")
      .describe("NAME of the secret holding the token for clone/fetch (never a value). Private repos need it; public repos work without one"),
    timeoutMs: z.number().int().positive().default(600_000).describe("per git command (default 10 min)"),
  }),
  output: z.object({
    path: z.string(),
    sha: z.string(),
    ref: z.string(),
    branch: z.string(),
    repo: z.string(),
    host: z.string(),
    url: z.string(),
  }),
  async run(cfg, ctx: GitCtx) {
    const shell = shellOf(ctx);
    const dataDir = dataDirOf(ctx);
    const r = parseRepo(cfg.repo);
    const secrets = (ctx.services as Partial<StrutCapabilities> | undefined)?.secrets;
    const token = await secrets?.get(cfg.tokenSecret);
    const cacheDir = cachePath(dataDir, r);
    const wtRoot = worktreeRoot(dataDir, ctx.runId);
    const wtDir = join(wtRoot, r.name);

    // Cleanup is registered BEFORE anything is created, so a checkout that
    // fails halfway (or is cancelled mid-clone) still leaves no worktree.
    ctx.onRunEnd?.(async () => {
      await withLock(cacheDir, async () => {
        if (existsSync(join(cacheDir, "HEAD"))) {
          await git(shell, ["worktree", "remove", "--force", "--force", wtDir], { cwd: cacheDir, timeoutMs: 60_000 });
          await git(shell, ["worktree", "prune"], { cwd: cacheDir, timeoutMs: 60_000 });
        }
        await rm(wtDir, { recursive: true, force: true });
        await rmdir(wtRoot).catch(() => {}); // only when this was the run's last working copy
      });
    });

    const cancel = cancelSignal(ctx);
    try {
      return await withLock(cacheDir, async () => {
        const o = { token, timeoutMs: cfg.timeoutMs, signal: cancel.signal };
        await mkdir(dirname(cacheDir), { recursive: true });
        if (!existsSync(join(cacheDir, "HEAD"))) {
          await rm(cacheDir, { recursive: true, force: true }); // a half-finished clone
          await gitOk(shell, ["clone", "--bare", "--quiet", r.url, cacheDir], { cwd: dirname(cacheDir), ...o });
        } else {
          await gitOk(
            shell,
            ["fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
            { cwd: cacheDir, ...o },
          );
        }
        await ctx.control?.checkpoint();

        // The remote's default branch — asked of the remote, so a change on
        // GitHub is seen; the clone-time HEAD is the fallback.
        const symref = await gitOk(shell, ["ls-remote", "--symref", "origin", "HEAD"], { cwd: cacheDir, ...o });
        let branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref)?.[1];
        if (!branch) {
          const head = await git(shell, ["symbolic-ref", "--short", "HEAD"], { cwd: cacheDir, ...o });
          branch = head.code === 0 ? head.stdout.trim() : "";
        }
        if (!branch) throw new Error(`git/checkout: could not determine the default branch of ${r.url}`);

        const ref = cfg.ref ?? branch;
        const revParse = async (): Promise<string> => {
          const rp = await git(shell, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: cacheDir, ...o });
          return rp.code === 0 ? rp.stdout.trim() : "";
        };
        let sha = await revParse();
        if (!sha && /^[0-9a-f]{7,40}$/i.test(ref)) {
          // A commit not on any branch or tag: GitHub serves reachable shas.
          await git(shell, ["fetch", "--quiet", "origin", ref], { cwd: cacheDir, ...o });
          sha = await revParse();
        }
        if (!sha) throw new Error(`git/checkout: ref "${ref}" not found in ${r.url}`);

        // A retry of this step in the same run starts over.
        await rm(wtDir, { recursive: true, force: true });
        await git(shell, ["worktree", "prune"], { cwd: cacheDir, ...o });
        await mkdir(wtRoot, { recursive: true });
        await gitOk(shell, ["worktree", "add", "--detach", "--quiet", wtDir, sha], { cwd: cacheDir, ...o });

        return { path: wtDir, sha, ref, branch, repo: `${r.owner}/${r.name}`, host: r.host, url: r.url };
      });
    } finally {
      cancel.stop();
    }
  },
});
