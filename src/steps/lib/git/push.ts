import { resolve } from "node:path";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { cancelSignal, git, gitOk, shellOf, withLock, type GitCtx } from "./_shared.js";

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

/**
 * Commit the index as the token's GitHub identity and push HEAD to a new
 * branch (plans/code-change.md §6). The token (the `tokenSecret` secret —
 * the run's principal's when the deployment has actor secrets) names the
 * author: `GET /user` → `login <id>+<login>@users.noreply.github.com`, so
 * the commit and the PR opened on it are the user's. It reaches git the
 * way `git/checkout` hands it over: the child env and an inline credential
 * helper, never an argument, URL or output.
 *
 * The working copy is a `git/checkout` worktree, removed when the run ends
 * — afterwards the branch exists only on the remote, by design.
 */
export default defineStep({
  type: "git/push",
  description:
    `Commit everything staged in a working copy (git/apply stages) as the token's GitHub identity and push HEAD to a new branch on origin — never --force. ` +
    `Auth: the tokenSecret secret (default GITHUB_TOKEN); its owner (GET /user) is the commit author, so the change is the user's. Without a token the author is "strut" and only a remote that needs no credential (a local repository) accepts the push. ` +
    `Fails with "push_rejected: …" when the remote refuses the push (non-fast-forward, protected branch, remote error) and "no_push_permission: …" on 401/403 from git or GitHub; nothing staged is a plain error. ` +
    `The working copy is removed at run end (git/checkout), so afterwards the branch lives only on the remote. ` +
    `Output: { branch, sha, login }.\n\n${EXAMPLE}`,
  input: z.object({
    path: z.string().min(1).describe("the working copy — a git/checkout step's `path`, with the change staged (git/apply)"),
    branch: z.string().min(1).describe("the branch to create on origin, e.g. jamie/abc12345-000123"),
    message: z.string().min(1).describe("the commit message (first line = title)"),
    tokenSecret: z
      .string()
      .default("GITHUB_TOKEN")
      .describe("NAME of the secret holding the token (never a value): the commit author and the push credential"),
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
    const token = await services?.secrets?.get(cfg.tokenSecret);
    const message = cfg.message.trim();
    if (!message) throw new Error("git/push: the commit message is empty");

    const cancel = cancelSignal(ctx);
    try {
      const o = { cwd: cfg.path, signal: cancel.signal, timeoutMs: cfg.timeoutMs };
      const check = await git(shell, ["check-ref-format", "--branch", cfg.branch], o);
      if (check.code !== 0) throw new Error(`git/push: "${cfg.branch}" is not a valid branch name`);

      // Nothing staged → nothing to commit; the caller forgot git/apply.
      const staged = await git(shell, ["diff", "--cached", "--quiet"], o);
      if (staged.code === 0) throw new Error("git/push: nothing is staged in the working copy — git/apply (or git add) stages the change to commit");
      if (staged.code !== 1) throw new Error(`git diff --cached failed: ${(staged.stderr || staged.stdout).trim().slice(-2000)}`);

      // The author: the token's GitHub identity. Through the http capability,
      // so the call is cassette-recordable and the token scrubbed from it.
      let login = "strut";
      let email = "strut@users.noreply.github.com";
      if (token) {
        const http = services?.http;
        if (!http) throw new Error("git/push: no http capability to resolve the token's identity");
        const res = await http("https://api.github.com/user", {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "strut" },
          timeout: 30_000,
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error(`no_push_permission: GitHub rejected the ${cfg.tokenSecret} token (HTTP ${res.status})`);
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
        const push = await git(shell, ["push", "--quiet", "origin", `HEAD:refs/heads/${cfg.branch}`], { ...o, token });
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
