import { isAbsolute, resolve, sep } from "node:path";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { AppsCapability } from "../../../apps/apps.js";
import { jobRoot } from "../../../jobs.js";
import { idProblem } from "../../../session-store.js";

/**
 * The `app/*` steps are thin over the apps capability (`src/apps/apps.ts`)
 * that `createStrut` builds into `ctx.services.apps` — the same reads and
 * writes the `/apps` routes serve. One implementation, three doors: these
 * steps as an agent's tools (`agentTools: ["app/*"]`, the builder's grant),
 * `run_step`, and HTTP.
 */
export interface AppsServices {
  apps?: AppsCapability;
}

export function requireApps(services: unknown): AppsCapability {
  const apps = (services as AppsServices | undefined)?.apps;
  if (!apps) {
    throw new Error(
      "app/* steps need the apps capability (ctx.services.apps). " +
        "The standard strut server provides it; embedders build one with createApps (import from 'strut').",
    );
  }
  return apps;
}

/**
 * Where an app directory a step names lives: relative to the JOB's directory
 * when the run has one (or `job` names another's — a builder job publishing
 * a code job's prototype), else the run's own artifact directory — and
 * never outside it (the job file routes' guard). With neither — the CHAT
 * builder, whose tools run under no run — relative to the server's data
 * directory (its scratch, where its editor and bash work), and with no
 * data directory either, an absolute path as given.
 */
export async function resolveAppPath(ctx: StepContext<StrutCapabilities>, path: string, job?: string): Promise<string> {
  const services = ctx.services as Partial<StrutCapabilities> | undefined;
  const jobId = job ?? ctx.job;
  let base: string | undefined;
  if (jobId) {
    const problem = idProblem(jobId);
    if (problem) throw new Error(`job id "${jobId}" ${problem}`);
    if (!services?.dataDir) throw new Error("a job's directory needs the server's dataDir (ctx.services.dataDir)");
    base = jobRoot(services.dataDir, jobId);
  } else if (services?.artifacts && ctx.runId) {
    base = await services.artifacts.dir(ctx.runId);
  } else if (services?.dataDir) {
    base = services.dataDir;
  }
  if (!base) {
    if (!isAbsolute(path)) throw new Error(`"${path}": with no job and no run directory to resolve against, an app path must be absolute`);
    return resolve(path);
  }
  const abs = resolve(base, path);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`"${path}" leaves the ${jobId ? "job's" : ctx.runId ? "run's" : "data"} directory (${base})`);
  return abs;
}
