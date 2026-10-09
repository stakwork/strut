import type { JobIndex } from "../../../job-index.js";
import type { JobsCapability } from "../../../jobs.js";

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
