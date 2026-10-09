import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { jobRoot } from "../../../jobs.js";
import { requireJobIndex } from "./_shared.js";

/**
 * One job read back (plans/job-index.md §5): `GET /jobs/:id`'s view plus
 * `dir`, the job's directory on this host — every artifact `path` and
 * every entry of `files` is relative to it, so a turn can open one with
 * the tools it has (`job/read`, or `cat`). Reading another job's files is
 * the API key's trust domain, as `GET /jobs/:id/files` is; writing into
 * another job's directory stays impossible — `job/dir` hands out this
 * run's only.
 */
export default defineStep({
  type: "job/get",
  description:
    `One job, read back: its runs ({ workflow, runId, status, at, parentRunId?, durationMs?, error? }, newest first — a run with a parentRunId is one a turn launched, not a turn), ` +
    `its threads (sessions: [{ id, turns, updatedAt, busy? }] — a thread's id is what an agent step's \`session\` takes to CONTINUE it; busy = mid-turn now), ` +
    `its holds, repos and files, \`dir\` (its directory on this host; files and artifact paths are relative to it), ` +
    `\`artifacts\`: the job's CURRENT deliverables, the latest version of each — { id, kind, title, summary?, url, path?, runId } (\`path\` is what job/read takes) — and \`text\`, the job's latest reply. ` +
    `A run of a sealed workflow shows its status and nothing more.`,
  input: z.object({ job: z.string().describe("The job id, from job/list.") }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const view = await requireJobIndex(ctx.services).get(cfg.job);
    if (!view) throw new Error(`No job "${cfg.job}"`);
    const dataDir = (ctx.services as Partial<StrutCapabilities> | undefined)?.dataDir ?? join(tmpdir(), "strut");
    return { ...view, dir: jobRoot(dataDir, cfg.job) };
  },
});
