import { tmpdir } from "node:os";
import { z } from "zod";
import { defineStep } from "../../../core.js";
import { cancelSignal, git, gitAuthOf, parseRepo, parseSymref, shellOf, type GitCtx } from "./_shared.js";

const EXAMPLE = `- id: head
  type: git/remote-head
  config:
    repo: "{{ input.url }}"`;

/** git's stderr when a remote wants a credential it did not get, or refused one. */
const DENIED_RE = /terminal prompts disabled|could not read (username|password)|authentication failed|access denied|invalid username or (password|token)|returned error: 40[13]|\b40[13]\b/i;
const NOT_FOUND_RE = /repository .*not found|not found|returned error: 404|\b404\b|does not appear to be a git repository|does not exist/i;

/**
 * Ask a remote for its default branch and the commit it points at, the way
 * `git ls-remote --symref <url> HEAD` does: one request, no clone, no
 * cache, nothing written. What a list of repositories checks on a schedule
 * (stadeum/code's `check`, every 15 minutes for each repository).
 *
 * The token is the run's for the URL's host (`secrets.git`, src/git-hosts.ts
 * — its person's), handed to git as `git/checkout` hands it: the child env
 * and an inline credential helper that answers for that host alone. A host
 * no secret serves is asked with none, so a public repository anywhere
 * works. Neither the output nor an error ever holds the token.
 */
export default defineStep({
  type: "git/remote-head",
  effect: "read",
  description:
    `Ask a git remote for its default branch and the commit at its head, as \`git ls-remote --symref <url> HEAD\` does: no clone, nothing written, one request. ` +
    `Auth: the run's token for the URL's host — the secret that serves it (GITHUB_TOKEN for github.com; a package's provides.git for another host), the person's own first — handed to git for that host alone; a host no secret serves is asked with none, so any public repository works. ` +
    `Fails with "remote_denied: …" when the remote wants a credential (private, or no repository there) or refuses the token, "remote_not_found: …", "remote_unreachable: …", and "remote_empty: …" when it has no commit yet. ` +
    `Output: { branch, head } — head is the full commit id.\n\n${EXAMPLE}`,
  input: z.object({
    repo: z.string().min(1).describe("repository URL, e.g. https://github.com/owner/repo — no credentials in the URL"),
    timeoutMs: z.number().int().positive().default(30_000).describe("for the one git command (default 30 s)"),
  }),
  output: z.object({
    branch: z.string(),
    head: z.string(),
  }),
  async run(cfg, ctx: GitCtx) {
    const r = parseRepo(cfg.repo);
    const auth = await gitAuthOf(ctx, r.url);
    const cancel = cancelSignal(ctx);
    try {
      const res = await git(shellOf(ctx), ["ls-remote", "--symref", r.url, "HEAD"], {
        cwd: tmpdir(),
        timeoutMs: cfg.timeoutMs,
        signal: cancel.signal,
        ...(auth ? { auth } : {}),
      });
      const masked = (s: string) => (auth ? s.split(auth.token).join("***") : s);
      if (res.code !== 0) {
        const detail = masked((res.stderr || res.stdout).trim()).slice(-500);
        if (res.timedOut) throw new Error(`remote_unreachable: ${r.url} did not answer in ${Math.round(cfg.timeoutMs / 1000)} s`);
        if (DENIED_RE.test(detail)) {
          throw new Error(
            auth
              ? `remote_denied: ${r.url} refused the run's token for ${auth.host}: it cannot read this repository, or there is none there`
              : `remote_denied: ${r.url} asks for a credential — it is private, or there is no repository there — and this run has no token for its host`,
          );
        }
        if (NOT_FOUND_RE.test(detail)) throw new Error(`remote_not_found: no repository at ${r.url}`);
        throw new Error(`remote_unreachable: ${r.url}: ${detail || `git ls-remote exit ${res.code ?? res.signal}`}`);
      }
      const { branch, head } = parseSymref(res.stdout);
      if (!head) throw new Error(`remote_empty: ${r.url} has no commits yet: its remote names no head`);
      if (!branch) throw new Error(`remote_empty: ${r.url} does not say which branch is its default`);
      return { branch, head };
    } finally {
      cancel.stop();
    }
  },
});
