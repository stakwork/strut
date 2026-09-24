import { z } from "zod";
import { defineStep } from "../../../core.js";
import { cancelSignal, gitOk, sha256, shellOf, type GitCtx } from "./_shared.js";

const EXAMPLE = `- id: apply
  type: git/apply
  config:
    path: "{{ checkout.path }}"
    diff: "{{ input.diff }}"
    sha256: "{{ input.diffSha256 }}"`;

/**
 * Apply a unified diff to a working copy — exactly the bytes given, no model
 * in between (plans/code-change.md §6). The diff reaches git on stdin, never
 * as an argument. `--index` stages what it applies, so a `git/push` step
 * commits precisely this change and nothing else.
 *
 * Refusals BEFORE the tree is touched are caller bugs and carry a plain
 * message; a diff that no longer applies on this head is the one honest
 * runtime failure and is reported as `patch_conflict: …` — the code a
 * caller (hive's approval) classifies on.
 */
export default defineStep({
  type: "git/apply",
  description:
    `Apply a unified diff (as git/diff produces it) to a working copy, exactly the bytes given, and stage the result so git/push commits it. ` +
    `Fails before touching the tree on an empty diff, a sha256 that does not match the diff, or a binary patch; fails with "patch_conflict: …" when the diff does not apply on the working copy's head. ` +
    `Output: { files, filesChanged, sha256 } — sha256 is the hash of the diff as given, for the caller to compare against what it sent.\n\n${EXAMPLE}`,
  input: z.object({
    path: z.string().min(1).describe("the working copy — a git/checkout step's `path`"),
    diff: z.string().describe("the unified diff to apply (git/diff's `diff`)"),
    sha256: z
      .string()
      .optional()
      .describe("expected sha256 of `diff`; when given, a mismatch refuses the step before anything is applied"),
    timeoutMs: z.number().int().positive().default(120_000).describe("per git command (default 2 min)"),
  }),
  output: z.object({
    files: z.array(z.string()),
    filesChanged: z.number(),
    sha256: z.string(),
  }),
  async run(cfg, ctx: GitCtx) {
    const diff = cfg.diff;
    if (diff.trim() === "") throw new Error("git/apply: the diff is empty — nothing to apply");
    const hash = sha256(diff);
    if (cfg.sha256 && cfg.sha256.toLowerCase() !== hash) {
      throw new Error(`git/apply: sha256 mismatch — the diff hashes to ${hash}, expected ${cfg.sha256}; nothing was applied`);
    }
    if (/^GIT binary patch$/m.test(diff)) {
      throw new Error("git/apply: the diff contains a binary patch, which cannot be re-applied faithfully (git/diff never produces one)");
    }
    // A trimmed diff (a caller stored it without its final newline) is the
    // same change; git wants the last hunk line terminated.
    const patch = diff.endsWith("\n") ? diff : `${diff}\n`;

    const shell = shellOf(ctx);
    const cancel = cancelSignal(ctx);
    try {
      const o = { cwd: cfg.path, signal: cancel.signal, timeoutMs: cfg.timeoutMs };
      // `git apply` reads the patch from stdin when no file is named: never an
      // argument, and no temp file to clean up. Check first, then apply.
      for (const args of [["apply", "--index", "--check"], ["apply", "--index"]]) {
        const r = await shell({ cmd: "git", args, cwd: o.cwd, stdin: patch, signal: o.signal, timeoutMs: o.timeoutMs });
        if (r.code !== 0) {
          const detail = (r.stderr || r.stdout).trim().slice(-2000);
          throw new Error(`patch_conflict: the diff does not apply on this head${detail ? ` — ${detail}` : ""}`);
        }
      }
      const files = (await gitOk(shell, ["diff", "--cached", "--name-only", "-z"], o)).split("\0").filter(Boolean).sort();
      return { files, filesChanged: files.length, sha256: hash };
    } finally {
      cancel.stop();
    }
  },
});

