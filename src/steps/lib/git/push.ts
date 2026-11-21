import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { ShellCapability, StrutCapabilities } from "../../../capabilities.js";
import { jobRoot } from "../../../jobs.js";
import { cancelSignal, dataDirOf, git, gitAccess, gitAuth, gitOk, parseSymref, shellOf, withLock, worktreeRoot, type GitCtx } from "./_shared.js";

const EXAMPLE = `- id: push
  type: git/push
  config:
    path: "{{ checkout.path }}"
    branch: "{{ input.branch }}"
    message: "{{ input.title }}"`;

/** What GitHub says about the token's owner. */
interface GithubUser {
  login: string;
  id: number;
}

const AUTH_FAIL_RE = /\b(401|403)\b|authentication failed|permission .*denied|could not read username|invalid username or (password|token)|not permitted/i;

/** `dir`, its symlinks resolved; undefined when it is not there. */
const real = (dir: string): Promise<string | undefined> => realpath(dir).catch(() => undefined);
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * Why `path` is not a working copy this push may push from, or undefined:
 * one `git/checkout` made for this run or its job — under the run's own
 * directory (an accepted proposal's: the run that proposed it) or the
 * job's, `<dataDir>/jobs/<job>` — whose repository is one of checkout's
 * caches, `<dataDir>/repos/`. Read as git reads it, every symlink resolved:
 * a path that climbs out with `..` or a link, another job's checkout, a
 * repository made in the job's directory by hand, or one elsewhere on the
 * server's disk is refused. Not isolation: the agent's bash reaches the
 * disk; this holds what a caller hands the step.
 */
async function notOwnWorkingCopy(path: string, ctx: GitCtx, shell: ShellCapability, o: { cwd: string; signal: AbortSignal; timeoutMs: number }): Promise<string | undefined> {
  if (!isAbsolute(path)) return `"${path}" is not an absolute path — pass the \`path\` git/checkout returned`;
  if (!(await real(path))) return `there is no ${path}`;
  const dataDir = dataDirOf(ctx);
  const runId = ctx.proposal?.by.runId ?? ctx.runId;
  const artifacts = (ctx.services as Partial<StrutCapabilities> | undefined)?.artifacts;
  const roots = [
    ...(ctx.job ? [jobRoot(dataDir, ctx.job)] : []),
    ...(runId ? [artifacts ? await artifacts.dir(runId) : worktreeRoot(dataDir, runId)] : []),
  ];
  const where = await git(shell, ["rev-parse", "--show-toplevel", "--git-common-dir"], o);
  if (where.code !== 0) return `${path} is not a git working copy`;
  const [top, common] = where.stdout.trim().split("\n");
  const [realTop, realCommon, caches] = await Promise.all([real(top ?? ""), real(resolve(path, common ?? "")), real(join(dataDir, "repos"))]);
  const own = (await Promise.all(roots.map(real))).filter((r): r is string => !!r);
  if (!realTop || !own.some((r) => within(realTop, r))) {
    return `${path} is not in this ${ctx.job ? "job's" : "run's"} own directory — git/push pushes a working copy git/checkout made for this ${ctx.job ? "job" : "run"}`;
  }
  if (!realCommon || !caches || !within(realCommon, caches)) return `${path} is not a working copy git/checkout made — git/push pushes one of those alone`;
  return undefined;
}

/**
 * Commit the index as the token's GitHub identity and push HEAD to a new
 * branch (plans/code-change.md §6). The token is the run's for origin's
 * host (`secrets.git`, src/git-hosts.ts — the person's own first). When it
 * is GitHub's own token (the one `https://github.com` gets), it names the
 * author: `GET /user` → `login <id>+<login>@users.noreply.github.com`, so
 * the commit and the PR opened on it are the user's; a token for another
 * host is never sent to GitHub, and the author is then "strut". It reaches
 * git the way `git/checkout` hands it over: the child env and an inline
 * credential helper for that host alone, never an argument, URL or output.
 *
 * The working copy is a `git/checkout` worktree, removed when the run ends
 * — afterwards the branch exists only on the remote, by design. Two holds,
 * for every caller (a model hands it its input once a package grants it to
 * the job agent; stadeum plans/software.md §5, item 16): it pushes only a
 * working copy git/checkout made for this run or its job
 * (`notOwnWorkingCopy`), and never to origin's default branch, asked of the
 * remote at the push. It cannot force: the refspec is `HEAD:refs/heads/<branch>`,
 * so a push that is not a fast-forward is `push_rejected:`.
 */
export default defineStep({
  type: "git/push",
  effect: "write",
  description:
    `Commit everything staged in a working copy (git/apply stages) as the token's GitHub identity and push HEAD to a new branch on origin — never --force. ` +
    `Auth: the run's token for origin's host (GITHUB_TOKEN for github.com; a package's provides.git for another host); when it is GitHub's, its owner (GET /user) is the commit author, so the change is the user's. Otherwise the author is "strut", and without a token only a remote that needs no credential (a local repository) accepts the push. ` +
    `Only from a working copy git/checkout made for this run or its job: path is the absolute \`path\` it returned (another job's checkout, a path out through .. or a link, or any other repository is refused). ` +
    `Never to origin's default branch: that is "push_rejected: …", as is a push the remote refuses (non-fast-forward, protected branch, remote error); "no_push_permission: …" on 401/403 from git or GitHub; nothing staged is a plain error. ` +
    `The working copy is removed at run end (git/checkout), so afterwards the branch lives only on the remote. ` +
    `Output: { branch, sha, login }.\n\n${EXAMPLE}`,
  input: z.object({
    path: z.string().min(1).describe("the working copy — the absolute `path` a git/checkout of this run or its job returned, with the change staged (git/apply)"),
    branch: z.string().min(1).describe("the branch to create (or fast-forward) on origin, e.g. jamie/abc12345-000123 — never origin's default branch"),
    message: z.string().min(1).describe("the commit message (first line = title)"),
    timeoutMs: z.number().int().positive().default(300_000).describe("per git command (default 5 min)"),
  }),
  output: z.object({
    branch: z.string(),
    sha: z.string(),
    login: z.string(),
  }),
  async run(cfg, ctx: GitCtx) {
    const services = ctx.services as Partial<StrutCapabilities> | undefined;
    const shell = shellOf(ctx);
    const message = cfg.message.trim();
    if (!message) throw new Error("git/push: the commit message is empty");

    const cancel = cancelSignal(ctx);
    try {
      const o = { cwd: cfg.path, signal: cancel.signal, timeoutMs: cfg.timeoutMs };
      // Only a working copy git/checkout made for this run or its job.
      const notOwn = await notOwnWorkingCopy(cfg.path, ctx, shell, o);
      if (notOwn) throw new Error(`git/push: ${notOwn}`);
      const check = await git(shell, ["check-ref-format", "--branch", cfg.branch], o);
      if (check.code !== 0) throw new Error(`git/push: "${cfg.branch}" is not a valid branch name`);

      // Nothing staged → nothing to commit; the caller forgot git/apply.
      const staged = await git(shell, ["diff", "--cached", "--quiet"], o);
      if (staged.code === 0) throw new Error("git/push: nothing is staged in the working copy — git/apply (or git add) stages the change to commit");
      if (staged.code !== 1) throw new Error(`git diff --cached failed: ${(staged.stderr || staged.stdout).trim().slice(-2000)}`);

      // The token for where the push goes: origin's host, and only there.
      const origin = (await gitOk(shell, ["remote", "get-url", "--push", "origin"], o)).trim();
      const access = await gitAccess(services?.secrets, origin);
      const { auth } = access;
      // Never the remote's default branch: a change lands as a branch of its
      // own and a pull request. Asked of the remote now, as git/remote-head
      // asks, with the same token for its host alone.
      const ls = await git(shell, ["ls-remote", "--symref", "origin", "HEAD"], { ...o, ...access });
      if (ls.code !== 0) {
        const detail = (ls.stderr || ls.stdout).trim().slice(-2000);
        const why = ls.timedOut ? "timed out" : detail || `exit ${ls.code ?? ls.signal}`;
        if (AUTH_FAIL_RE.test(detail)) throw new Error(`no_push_permission: origin refused to say its default branch — ${why}`);
        throw new Error(`push_rejected: origin did not say its default branch — ${why}`);
      }
      const base = parseSymref(ls.stdout).branch;
      if (base && base.toLowerCase() === cfg.branch.toLowerCase()) {
        throw new Error(`push_rejected: ${cfg.branch} is origin's default branch — git/push pushes a branch of its own, for a pull request, never the default one`);
      }
      // GitHub's own token, which alone may ask GitHub who it is.
      const github = auth && auth.token === (await gitAuth(services?.secrets, "https://github.com"))?.token ? auth.token : undefined;

      // The author: the token's GitHub identity. Through the http capability,
      // so the call is cassette-recordable and the token scrubbed from it.
      let login = "strut";
      let email = "strut@users.noreply.github.com";
      if (github) {
        const http = auth?.http ?? services?.http;
        if (!http) throw new Error("git/push: no http capability to resolve the token's identity");
        const res = await http("https://api.github.com/user", {
          headers: { authorization: `Bearer ${github}`, accept: "application/vnd.github+json", "user-agent": "strut" },
          timeout: 30_000,
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error(`no_push_permission: GitHub rejected the run's token for github.com (HTTP ${res.status})`);
        }
        const user = res.body as Partial<GithubUser> | undefined;
        if (!res.ok || typeof user?.login !== "string" || typeof user.id !== "number") {
          throw new Error(`git/push: could not resolve the token's GitHub identity (HTTP ${res.status})`);
        }
        login = user.login;
        email = `${user.id}+${user.login}@users.noreply.github.com`;
      }
      await ctx.control?.checkpoint();

      // `-c user.*` sets author and committer alike; gpgsign is a machine
      // setting (HOME's gitconfig) that must not block a server-side commit.
      // The message comes on stdin — a title starting with "-" is not a flag.
      const commit = await shell({
        cmd: "git",
        args: ["-c", `user.name=${login}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "--quiet", "-F", "-"],
        cwd: cfg.path,
        stdin: `${message}\n`,
        signal: cancel.signal,
        timeoutMs: cfg.timeoutMs,
      });
      if (commit.code !== 0) throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim().slice(-2000)}`);
      const sha = (await gitOk(shell, ["rev-parse", "HEAD"], o)).trim();

      // The worktree shares the bare cache's refs (a push updates the cache's
      // copy of the branch), so hold the cache's lock like checkout does.
      const common = resolve(cfg.path, (await gitOk(shell, ["rev-parse", "--git-common-dir"], o)).trim());
      await withLock(common, async () => {
        const push = await git(shell, ["push", "--quiet", "origin", `HEAD:refs/heads/${cfg.branch}`], { ...o, ...access });
        if (push.code !== 0) {
          const detail = (push.stderr || push.stdout).trim().slice(-2000);
          const why = push.timedOut ? "timed out" : detail || `exit ${push.code ?? push.signal}`;
          if (AUTH_FAIL_RE.test(detail)) throw new Error(`no_push_permission: the push to origin was refused — ${why}`);
          throw new Error(`push_rejected: the push to origin failed — ${why}`);
        }
      });
      return { branch: cfg.branch, sha, login };
    } finally {
      cancel.stop();
    }
  },
});
