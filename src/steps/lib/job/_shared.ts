import { basename } from "node:path";
import { z } from "zod";
import type { JobIndex } from "../../../job-index.js";
import type { RunEvent, StepContext } from "../../../core.js";
import type { ArtifactsCapability } from "../../../capabilities.js";
import type { JobLaunch, JobsCapability } from "../../../jobs.js";
import { loadRunAttachments, type Attachment } from "../../../ai/attachments.js";

/**
 * The `job/list` / `job/get` / `job/read` steps are thin over the job
 * INDEX (`src/job-index.ts`) that `createStrut` builds into
 * `ctx.services.jobs` — the same reads `GET /jobs[/:id]` serves. A bare
 * bag (`standardServices` with no stores) keeps the record's writer only;
 * its index methods are absent, and the steps say so.
 */
export function requireJobIndex(services: unknown): JobIndex {
  const jobs = (services as { jobs?: JobsCapability } | undefined)?.jobs;
  if (!jobs?.list || !jobs.get || !jobs.read) {
    throw new Error(
      "job/* steps need the job index (ctx.services.jobs with list/get/read). " +
        "The standard strut server provides it; embedders build one with createJobIndex (import from 'strut').",
    );
  }
  return jobs as JobIndex;
}

/** `job/start` / `job/continue` launch through `ctx.services.jobs.launch`,
 *  which `createStrut` sets: a detached run needs the server's launcher. */
export function requireJobLaunch(services: unknown): NonNullable<JobsCapability["launch"]> {
  const launch = (services as { jobs?: JobsCapability } | undefined)?.jobs?.launch;
  if (!launch) {
    throw new Error(
      "job/start and job/continue need a server to launch the job on (ctx.services.jobs.launch). " +
        "The standard strut server provides it.",
    );
  }
  return launch;
}

/** job/start's and job/continue's `attachments`: the files of this run to
 *  hand the job, by name. */
export const attachmentsField = z
  .array(z.string())
  .optional()
  .describe(
    "Files the person attached to this message to hand the job, by name as the message shows them ([attachment] <name> …). The job does not see this conversation: a file it needs goes with it — it gets the file as you see it, and saved on disk.",
  );

/**
 * The files of THIS run (`ctx.attachments`, `POST …/run { attachments }`)
 * the model named, read back from the run's artifacts for the job's launch
 * — a name as the message showed it, or the saved file's (`image-2.png`,
 * when two had one name). A name the run was not launched with is refused
 * with the ones it was.
 */
export async function handedOn(ctx: StepContext, names: string[] | undefined): Promise<Attachment[] | undefined> {
  if (!names?.length) return undefined;
  const all = ctx.attachments ?? [];
  const picked = all.filter((a) => names.includes(a.name) || names.includes(basename(a.path)));
  const unknown = names.filter((n) => !all.some((a) => a.name === n || basename(a.path) === n));
  if (unknown.length) {
    const have = all.map((a) => a.name);
    throw new Error(
      `attachments: no file named ${unknown.map((n) => `"${n}"`).join(", ")} on this message — ${have.length ? `it has ${have.map((n) => `"${n}"`).join(", ")}` : "it has none"}`,
    );
  }
  const artifacts = (ctx.services as { artifacts?: ArtifactsCapability } | undefined)?.artifacts;
  if (!artifacts) throw new Error("attachments: no artifacts capability to read this run's files from");
  return (await loadRunAttachments(artifacts, ctx.runId, picked)).map(({ name, mediaType, bytes }) => ({ name, mediaType, bytes }));
}

/** What a launch journals: the job and run it started. */
interface LaunchRecord {
  job: string;
  runId: string;
  callback: boolean;
}

/**
 * Launch once, even across a resume. The handle is journaled as a synthetic
 * `step.end` (no stepType) right after the launch, as strut/run-workflow
 * does: at `<path>#launch` for a DAG step, and for an agent's tool call at
 * `<agent path>#<call>` — the slice of the journal the agent step is handed
 * and its tool calls share. A resumed turn that makes the same call again
 * gets the job already running, not a second one. `job` narrows a record to
 * that job (job/continue); job/start takes whatever it started.
 */
export async function launchOnce(
  ctx: StepContext,
  launch: NonNullable<JobsCapability["launch"]>,
  opts: Omit<JobLaunch, "from" | "actor" | "principal" | "mcp">,
  match?: string,
): Promise<LaunchRecord> {
  const key = journalKey(ctx, "launch");
  const prior = key ? (ctx.journal?.[key] as Partial<LaunchRecord> | undefined) : undefined;
  if (prior && typeof prior.job === "string" && typeof prior.runId === "string" && (!match || prior.job === match)) {
    return { job: prior.job, runId: prior.runId, callback: !!prior.callback };
  }
  const { runId, callback } = await launch({
    ...opts,
    from: ctx.runId,
    ...(ctx.actor ? { actor: ctx.actor } : {}),
    ...(ctx.principal ? { principal: ctx.principal } : {}),
    // The caller this turn can reach, the job can reach — unless the agent
    // that called this has `mcp: false` (its tools' ctx has none).
    ...(ctx.mcp?.length ? { mcp: ctx.mcp } : {}),
  });
  const record: LaunchRecord = { job: opts.job, runId, callback };
  await journal(ctx, key, record);
  return record;
}

/**
 * Where a step journals what it did, so a resumed run that makes the same
 * call again finds it rather than doing it twice: a synthetic `step.end`
 * (no stepType) at `<path>#<suffix>` for a DAG step, and for an agent's
 * tool call at `<agent path>#<call>` — the slice of the journal the agent
 * step is handed and its tool calls share (`ctx.journal`). Undefined
 * outside a run.
 */
export function journalKey(ctx: StepContext, suffix: string): string | undefined {
  const cut = ctx.path.lastIndexOf("/");
  return !ctx.path ? undefined : ctx.agentTool && cut > 0 ? `${ctx.path.slice(0, cut)}#${ctx.path.slice(cut + 1)}` : `${ctx.path}#${suffix}`;
}

/** Journal `record` at `key` (`journalKey`). */
export async function journal(ctx: StepContext, key: string | undefined, record: unknown): Promise<void> {
  if (!key || !ctx.emit) return;
  // The runner stamps ts/runId (strut/run-workflow's cast).
  await (ctx.emit as unknown as (e: Partial<RunEvent> & { type: RunEvent["type"] }) => Promise<void>)({ type: "step.end", path: key, output: record });
}
