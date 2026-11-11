import { z } from "zod";
import type { CardField } from "../../../core.js";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { PACKAGE_NAME } from "../../../packages/format.js";

/**
 * An AGENT asks to commit a package this strut works on as a git repo; a
 * PERSON says yes (plans/app-repos.md §3.3). A commit pushes this
 * workspace's edits of the package — workflows, steps, apps, Concept pages
 * — to a remote with a person's credential: an outward act like
 * `package/install`. So the step runs ONLY as a proposal a person accepted
 * (`ctx.proposal`): a direct tool call, a DAG step, `meta/run-step` or a
 * subflow is refused, and the door behind it (`ctx.services.packages.commit`,
 * createStrut) checks the accepted record on disk for this very package and
 * message, so a forged context opens nothing. The seeds that grant
 * `package/install` grant this beside it and list it in `approve:`.
 *
 * The yes is an ADMIN's (`approver: "admin"`, plans/member-rights.md), as
 * the HTTP door (`POST /packages/repos/:publisher/:name/commit`) is full
 * scope: the push may go out with the deployment's token when the person
 * has none of their own, which a member must not reach.
 *
 * The CARD (`describe`) says where it goes — the repository, the branch or
 * a new branch with a pull request — and which items the workspace changed
 * since the commit last installed.
 */

const input = z.object({
  package: z.string().regex(PACKAGE_NAME, "a package is named publisher/name").describe("The package, `publisher/name`, opened here as a repo (Packages → Repos)."),
  message: z.string().min(1).describe("The commit message: what changed, in the person's terms. Its first line is the title (and the pull request's)."),
  branch: z
    .string()
    .min(1)
    .optional()
    .describe("The branch to push to. Leave it out for a new branch with a pull request; name the repo's followed branch only when the person said to push straight to it."),
  pr: z.boolean().optional().describe("Open a pull request for the branch (default: yes, unless `branch` is the followed branch). GitHub only."),
});

export default defineStep({
  type: "package/commit",
  effect: "write",
  description:
    "Commit a package this strut server works on as a git repository: write this workspace's edits of its workflows, steps, apps and Concept pages into the repository's " +
    "working copy and push them — a new branch with a pull request by default, or straight to the followed branch when the person says so. " +
    "The call becomes a proposal the person approves on a card that says where it goes and what changed; strut commits it when they accept and tells you the result on a later turn. " +
    "Put what changed in `message` and why in `rationale`, in the person's terms. Never pushes on its own: a direct call is refused. " +
    "Only an ADMIN of this strut server accepts it: when the person is not one, the call is refused (admin_required:) — tell them an admin commits from Packages.",
  input,
  output: z.any(),
  approver: "admin",
  async describe(cfg, ctx: StepContext<StrutCapabilities>) {
    const title = `Commit ${cfg.package} to its repository`;
    const repo = await ctx.services?.packages?.repo?.(cfg.package).catch(() => undefined);
    if (!repo) return { title, summary: `${cfg.package} is not opened here as a repo, so there is nothing to commit it to: an admin opens it from Packages → Repos.` };
    const straight = cfg.branch === repo.branch;
    const where = straight ? `straight to ${repo.branch}` : `to ${cfg.branch ? `the branch ${cfg.branch}` : "a new branch"}${cfg.pr === false ? "" : ` with a pull request into ${repo.branch}`}`;
    const changed = repo.forked;
    const lines = [
      `Pushes ${where} on ${repo.url}${repo.path ? ` (the package in ${repo.path}/)` : ""}, as the person who accepts.`,
      changed.length ? `Changed here since the commit installed (${repo.commit.slice(0, 7)}): ${changed.map((i) => i.name).join(", ")}.` : `Nothing changed here since the commit installed (${repo.commit.slice(0, 7)}).`,
      `Message: ${cfg.message.split("\n")[0]}`,
    ];
    const fields: CardField[] = [
      { label: "Repository", value: `${repo.url}${repo.path ? `#${repo.path}` : ""}`, kind: "ref" },
      { label: "Pushes", value: where, ...(straight ? { danger: true } : {}) },
      { label: "Changed", value: changed.length ? changed.map((i) => i.name).join(", ") : "nothing" },
    ];
    return { title, summary: lines.join(" "), fields, actions: { accept: "Commit and push", reject: "Don't commit" }, full: true };
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.proposal) {
      throw new Error(
        "package/commit runs only as a proposal a person accepted: a commit pushes this workspace to a remote with a person's credential, and a person decides that, never a tool call. " +
          "Ask for it as a tool call the person approves (the agent's approve: list names it); a workflow step, meta/run-step or a subflow cannot reach it.",
      );
    }
    const door = ctx.services?.packages?.commit;
    if (!door) throw new Error("package/commit needs strut's package door (ctx.services.packages.commit); the standard strut server provides it.");
    return door(cfg.package, {
      proposal: ctx.proposal.id,
      message: cfg.message,
      ...(cfg.branch ? { branch: cfg.branch } : {}),
      ...(cfg.pr !== undefined ? { pr: cfg.pr } : {}),
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    });
  },
});
