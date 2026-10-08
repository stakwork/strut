import { existsSync } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { idProblem } from "../../../session-store.js";
import { holdJob, jobRoot, jobTtlMs, readJobRecord, releaseWith, sweepJobs, touchJob } from "../../../jobs.js";
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
 * detached worktree per run INSIDE THE RUN'S OWN DIRECTORY — its artifact
 * dir, `<artifacts>/<runId>/<repo>`, the directory `job/dir` hands a run
 * that has no job, so `cwd: "{{ dir.path }}"` holds the repositories either
 * way (plans/jobs.md §2: a run has one directory, the job's or its own) —
 * removed when the run ends (`ctx.onRunEnd`): success, error or cancel. A
 * bare bag with no `artifacts` capability falls back to
 * `<dataDir>/worktrees/<runId>/`.
 *
 * The token (the `tokenSecret` secret — the run's principal's when the
 * deployment has actor secrets) reaches git through the child env and an
 * inline credential helper only; the checkout stores no credential, so the
 * agent's bash cannot push from it. See `_shared.ts`.
 *
 * With `workdir` the working copy is KEPT, inside a JOB's directory
 * (plans/jobs.md §2; jobs.ts): `<dataDir>/jobs/<name>/<repo>`, the same
 * path on every run that names it, left as the last run left it, held by
 * one run at a time, and removed once the job is idle for
 * `STRUT_WORKDIR_TTL_DAYS` — the job's other files stay. What an agent
 * `session` works in; `workdir: "{{ $job }}"` on a run launched with a job.
 */
export default defineStep({
  type: "git/checkout",
  description:
    `Check out a git repository into a fresh, isolated working copy for this run and return its path — the cwd for an agent or exec step. ` +
    `Clones once into a credential-free cache and fetches on later runs; the working copy lives inside the run's own directory (the one job/dir returns on a run without a job: <artifacts>/<runId>/<repo>) and is removed when the run ends. ` +
    `ref: a branch, tag or commit sha (default: the remote's default branch). ` +
    `workdir: the JOB whose directory keeps the working copy (usually "{{ $job }}") — the next run naming it finds the same path with every edit, untracked and ignored file in place (reused: true), which is how the files follow an agent's \`session\`. ` +
    `Auth: the tokenSecret secret (default GITHUB_TOKEN), needed for private repos — the value only ever reaches git's child env, never the log or the checkout. ` +
    `Output: { path, sha, ref, branch, repo, host, url, reused? } — branch is the remote's default branch.\n\n${EXAMPLE}`,
  input: z.object({
    repo: z.string().min(1).describe("repository URL, e.g. https://github.com/owner/repo — no credentials in the URL"),
    ref: z.string().min(1).optional().describe("branch, tag or commit sha to check out; omit for the remote's default branch"),
    tokenSecret: z
      .string()
      .default("GITHUB_TOKEN")
      .describe("NAME of the secret holding the token for clone/fetch (never a value). Private repos need it; public repos work without one"),
    workdir: z
      .string()
      .optional()
      .describe(
        'KEEP the working copy in this JOB\'s directory (<dataDir>/jobs/<name>/<repo>; usually "{{ $job }}", the job the run was launched with): it is not removed when the run ends, and the next run that names it gets the same path exactly as it was left (output `reused: true`; `ref` only applies when the copy is created, `sha` is its current HEAD). One run at a time per job (a second fails with `job_busy:`). Names are GLOBAL, like session ids; letters, digits and ". _ -" in `/`-separated segments. A job idle for STRUT_WORKDIR_TTL_DAYS (default 7) loses its repositories, not its other files — the next run starts from a fresh copy (`reused: false`). Omit for a fresh copy per run.',
      ),
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
    reused: z.boolean().optional(),
  }),
  async run(cfg, ctx: GitCtx) {
    const shell = shellOf(ctx);
    const dataDir = dataDirOf(ctx);
    const r = parseRepo(cfg.repo);
    const secrets = (ctx.services as Partial<StrutCapabilities> | undefined)?.secrets;
    const token = await secrets?.get(cfg.tokenSecret);
    const cacheDir = cachePath(dataDir, r);
    const kept = cfg.workdir;
    if (kept !== undefined) {
      const problem = idProblem(kept);
      if (problem) throw new Error(`git/checkout: workdir "${kept}" ${problem}`);
    }
    // A run has one directory: the job's (kept, `workdir`), or its own — the
    // artifact dir, where `job/dir` points a run with no job, so a workflow's
    // `cwd: "{{ dir.path }}"` holds the repositories in both cases.
    const artifacts = (ctx.services as Partial<StrutCapabilities> | undefined)?.artifacts;
    const ownRoot = kept === undefined ? await artifacts?.dir(ctx.runId) : undefined;
    const wtRoot = kept !== undefined ? jobRoot(dataDir, kept) : (ownRoot ?? worktreeRoot(dataDir, ctx.runId));
    const wtDir = join(wtRoot, r.name);

    if (kept !== undefined) {
      holdJob(ctx, wtRoot, kept);
      // Used now — so the sweep, which runs before this checkout takes its
      // cache's lock (it takes others'), leaves this one alone.
      await touchJob(wtRoot, kept);
      await sweepJobs(shell, dataDir, jobTtlMs(), { release: releaseWith(ctx.registry, ctx.services) });
    } else {
      // Cleanup is registered BEFORE anything is created, so a checkout that
      // fails halfway (or is cancelled mid-clone) still leaves no worktree.
      ctx.onRunEnd?.(async () => {
        await withLock(cacheDir, async () => {
          if (existsSync(join(cacheDir, "HEAD"))) {
            await git(shell, ["worktree", "remove", "--force", "--force", wtDir], { cwd: cacheDir, timeoutMs: 60_000 });
            await git(shell, ["worktree", "prune"], { cwd: cacheDir, timeoutMs: 60_000 });
          }
          await rm(wtDir, { recursive: true, force: true });
          // The fallback root is this step's own; the artifact dir is the run's.
          if (ownRoot === undefined) await rmdir(wtRoot).catch(() => {}); // only when this was the run's last working copy
        });
      });
    }

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
        const where = { branch, repo: `${r.owner}/${r.name}`, host: r.host, url: r.url };

        // A kept working copy is left exactly as the last run left it.
        if (kept !== undefined && existsSync(join(wtDir, ".git"))) {
          const head = (await gitOk(shell, ["rev-parse", "HEAD"], { cwd: wtDir, ...o })).trim();
          const was = (await readJobRecord(wtRoot))?.repos[wtDir]?.ref ?? cfg.ref ?? branch;
          return { path: wtDir, sha: head, ref: was, ...where, reused: true };
        }

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

        if (kept === undefined) return { path: wtDir, sha, ref, ...where };
        await touchJob(wtRoot, kept, { dir: wtDir, cache: cacheDir, ref });
        return { path: wtDir, sha, ref, ...where, reused: false };
      });
    } finally {
      cancel.stop();
    }
  },
});
