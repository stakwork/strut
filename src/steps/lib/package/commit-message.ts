import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { PACKAGE_NAME } from "../../../packages/format.js";

/**
 * The COMMIT MESSAGE for a package this strut works on as a git repo
 * (src/packages/repos.ts), saved by the agent that edited it: the one who
 * made the change says what it was, and the person's Commit (Packages →
 * Repos) starts from it. One message covers every edit not yet committed,
 * so a call replaces it whole; with no `message` the call reads it. A note
 * on the repo's record, nothing pushed: no approval, unlike package/commit.
 */

const input = z.object({
  package: z.string().regex(PACKAGE_NAME, "a package is named publisher/name").describe("The package, `publisher/name`, opened here as a repo."),
  message: z
    .string()
    .optional()
    .describe("The whole message, for every edit not yet committed: a title line, then a blank line and what else the person should know. It replaces the saved one; empty clears it. Leave it out to read the saved one."),
});

export default defineStep({
  type: "package/commit-message",
  effect: "write",
  description:
    "The commit message for edits to a package this strut server works on as a git repository: what the person's Commit starts from. " +
    "After you change its workflows, steps, apps or Concept pages, save what changed, in the person's terms. " +
    "It covers every edit not yet committed and a call replaces it, so read it first (leave `message` out; the answer also lists what changed here) and keep what is still true. " +
    "Nothing is pushed.",
  input,
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const packages = ctx.services?.packages;
    if (!packages?.repo || !packages.saveMessage) throw new Error("package/commit-message needs strut's package door (ctx.services.packages); the standard strut server provides it.");
    const repo = await packages.repo(cfg.package);
    if (!repo) throw new Error(`${cfg.package} is not opened here as a repo: only a package opened from Packages → Repos is committed from here`);
    const changed = repo.forked.map((i) => i.name);
    if (cfg.message === undefined) return { package: cfg.package, message: repo.message ?? null, changed };
    await packages.saveMessage(cfg.package, cfg.message);
    return { package: cfg.package, message: cfg.message.trim() || null, changed };
  },
});
