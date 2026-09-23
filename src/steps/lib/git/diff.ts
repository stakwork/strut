import { z } from "zod";
import { defineStep } from "../../../core.js";
import { cancelSignal, git, gitOk, sha256, shellOf, type GitCtx } from "./_shared.js";
import type { ShellResult } from "../../../capabilities.js";

const EXAMPLE = `- id: diff
  type: git/diff
  config:
    path: "{{ checkout.path }}"`;

/** One gitleaks finding, as its JSON report lists it. Only the location and
 *  the rule are ever surfaced — never `Match` or `Secret`. */
interface Leak {
  RuleID?: string;
  File?: string;
  StartLine?: number;
}

/**
 * What a working copy changed, as one unified diff. Everything is staged
 * first (`git add -A`, honouring .gitignore) so new files are in it — the
 * working copy is throwaway, so staging has no cost. Caps and a secret scan
 * (gitleaks, when on PATH) fail the step rather than pass a change on that
 * no one should land.
 */
export default defineStep({
  type: "git/diff",
  description:
    `Capture what a working copy changed (after an agent or exec step edited it) as one unified diff: stages everything, so new files are included. ` +
    `Fails when the change exceeds maxFiles / maxBytes, or when gitleaks (if installed) finds a secret in it — the message names the rule and file, never the value. ` +
    `Output: { diff, files, filesChanged, sha256, scanned } — diff is "" and filesChanged 0 when nothing changed; scanned says whether gitleaks ran.\n\n${EXAMPLE}`,
  input: z.object({
    path: z.string().min(1).describe("the working copy — a git/checkout step's `path`"),
    maxFiles: z.number().int().positive().default(200).describe("fail when more files changed"),
    maxBytes: z.number().int().positive().default(2_000_000).describe("fail when the diff is larger (bytes)"),
    scan: z.boolean().default(true).describe("scan the staged change with gitleaks when it is on PATH; a finding fails the step"),
  }),
  output: z.object({
    diff: z.string(),
    files: z.array(z.string()),
    filesChanged: z.number(),
    sha256: z.string(),
    scanned: z.boolean(),
  }),
  async run(cfg, ctx: GitCtx) {
    const shell = shellOf(ctx);
    const cwd = cfg.path;
    const cancel = cancelSignal(ctx);
    try {
      const o = { cwd, signal: cancel.signal, timeoutMs: 120_000 };
      await gitOk(shell, ["add", "-A"], o);
      const files = (await gitOk(shell, ["diff", "--cached", "--name-only", "-z"], o))
        .split("\0")
        .filter(Boolean)
        .sort();
      if (files.length === 0) return { diff: "", files, filesChanged: 0, sha256: sha256(""), scanned: false };
      if (files.length > cfg.maxFiles) {
        throw new Error(`git/diff: the change touches ${files.length} files (max ${cfg.maxFiles})`);
      }

      // One char over the cap is enough to know it is too large; the shell
      // keeps head + tail past `maxOutputChars`, and flags it.
      const res = await git(shell, ["diff", "--cached", "--no-color"], { ...o, maxOutputChars: cfg.maxBytes + 1 });
      if (res.code !== 0) throw new Error(`git diff failed: ${(res.stderr || res.stdout).trim().slice(-2000)}`);
      if (res.truncated || Buffer.byteLength(res.stdout, "utf8") > cfg.maxBytes) {
        throw new Error(`git/diff: the change is larger than ${cfg.maxBytes} bytes`);
      }
      const diff = res.stdout;

      let scanned = false;
      if (cfg.scan) {
        let r: ShellResult | undefined;
        try {
          r = await shell({
            cmd: "gitleaks",
            args: ["git", "--staged", "--no-banner", "--no-color", "--log-level=fatal", "--report-format=json", "--report-path=-"],
            cwd,
            timeoutMs: 120_000,
            signal: cancel.signal,
          });
        } catch (err) {
          // Not installed: the deployment decides whether that is acceptable
          // (hive re-scans on receipt); the output says it did not run.
          if (!/command not found/.test(err instanceof Error ? err.message : String(err))) throw err;
        }
        if (r) {
          if (r.code === 1) {
            let leaks: Leak[] = [];
            try {
              leaks = JSON.parse(r.stdout) as Leak[];
            } catch {
              /* a finding with an unreadable report is still a finding */
            }
            const where = leaks
              .slice(0, 5)
              .map((l) => `${l.RuleID ?? "secret"} in ${l.File ?? "?"}${l.StartLine ? `:${l.StartLine}` : ""}`)
              .join(", ");
            throw new Error(`git/diff: the change contains a secret (${where || "see gitleaks"}) — it cannot be proposed`);
          }
          if (r.code !== 0) {
            throw new Error(`git/diff: gitleaks failed (${r.code ?? r.signal}): ${(r.stderr || r.stdout).trim().slice(-500)}`);
          }
          scanned = true;
        }
      }
      return { diff, files, filesChanged: files.length, sha256: sha256(diff), scanned };
    } finally {
      cancel.stop();
    }
  },
});
