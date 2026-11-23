import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { forgeStepsOf, tokenHost } from "../../../git-hosts.js";
import { boxHostsOf, callForgeStep, pullRequestOutput } from "./_forge.js";

const EXAMPLE = `- id: pr
  type: git/pull-request
  config:
    url: "{{ input.repo }}"
    head: "{{ push.branch }}"
    base: "{{ checkout.branch }}"
    title: "{{ input.title }}"
    body: "{{ input.body }}"`;

/**
 * Open a pull request on whatever forge holds the repository
 * (plans/package-seams.md §4; stadeum plans/software.md §5, item 17): the
 * `pull_request` step the URL's host names on its `provides.git` entry —
 * strut's `github/create-pr` for github.com — called as the run's person.
 */
export default defineStep({
  type: "git/pull-request",
  effect: "write",
  description:
    `Open a pull request from head to base on the repository at url, whichever forge holds it: the pull_request step its host names on its package's provides.git entry is called with { url, head, base, title, body } (github.com: strut's github/create-pr), as the run's person — so a caller names no forge. ` +
    `The step answers, and this returns, { url, number?, created? }: the pull request's page, its number, and whether this call opened it (false: the open one for head already existed). ` +
    `Fails with "pr_bad_url: …" for a URL that is not https (or http to this machine), "pr_no_provider: …" when no package names a pull_request step for the URL's host, and with the step's own error.\n\n${EXAMPLE}`,
  input: z.object({
    url: z.string().min(1).describe("the repository's URL, https://<host>/<owner>/<repo>"),
    head: z.string().min(1).describe("the branch with the change (a git/push step's `branch`)"),
    base: z.string().min(1).describe("the branch to merge into"),
    title: z.string().min(1).describe("pull request title"),
    body: z.string().optional().describe("pull request description (markdown)"),
  }),
  output: pullRequestOutput,
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const host = tokenHost(cfg.url);
    if (!host) throw new Error(`pr_bad_url: ${cfg.url} is not a repository on a git host — https://<host>/<owner>/<repo>`);
    const step = forgeStepsOf(boxHostsOf(ctx), host).pull_request;
    if (!step) throw new Error(`pr_no_provider: nothing here opens a pull request on ${host} — a package that serves it names a pull_request step on its provides.git entry`);
    return pullRequestOutput.parse(await callForgeStep(ctx, step, { url: cfg.url, head: cfg.head, base: cfg.base, title: cfg.title, ...(cfg.body !== undefined ? { body: cfg.body } : {}) }));
  },
});
