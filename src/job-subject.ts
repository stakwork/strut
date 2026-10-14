/**
 * What a JOB check reads (plans/job-claims.md §3) — the job's STATE at
 * verify time, built from the index's view (`job-index.ts`, `get`) rather
 * than from an event log: a job's product is whatever its last turn left,
 * so the subject is its directory, its current deliverables, its holds with
 * their addresses, and the turn the evidence will be about.
 *
 * The subject IS the check step's run input, as a step's `RunCheckSubject`
 * is (`graph/claims.ts`): a check's config says `url: "{{ input.urls.pod
 * }}/settings"` and survives a dropped and re-claimed pod without an edit,
 * `cwd: "{{ input.dir }}"` runs a script over the job's files, and
 * `{{ input.artifacts }}` names the page the claim is about. Built once per
 * pass and handed to every job check — the `artifactsDir` of a step
 * subject's twin.
 *
 * NOTHING CALLS THIS YET. The verify pass will, once the job subject kind —
 * `SubjectRef { kind: "job" }`, `StrutJob` as its node and `StrutRun` as its
 * version — lands in `src/graph/claims.ts` with the graph layer's rewrite.
 * Pure: no store, no graph, no I/O.
 */
import type { JobArtifact, JobView } from "./job-index.js";
import type { JobHold } from "./jobs.js";

export interface JobCheckSubject {
  job: string;
  /** The turn this evidence will be ABOUT. */
  runId: string;
  /** `<dataDir>/jobs/<id>/` — an exec check's cwd. */
  dir: string;
  /** Checked out into it, relative. */
  repos: string[];
  /** The fold: current deliverables with url + path. */
  artifacts: JobArtifact[];
  /** id, kind, note, since, url? */
  holds: JobHold[];
  /** The first hold of each kind that has a url: `{ pod: "https://…" }`. */
  urls: Record<string, string>;
  /** The turn's output as packed. */
  output?: unknown;
  /** The job's latest reply (the view's). */
  text?: string;
}

/** The subject for one verify of `view`'s job, about the turn `at.runId`
 *  that ran in `at.dir`. */
export function buildJobSubject(view: JobView, at: { runId: string; dir: string; output?: unknown }): JobCheckSubject {
  return {
    job: view.job,
    runId: at.runId,
    dir: at.dir,
    repos: view.repos,
    artifacts: view.artifacts,
    holds: view.holds,
    urls: view.urls,
    ...(at.output !== undefined ? { output: at.output } : {}),
    ...(view.text !== undefined ? { text: view.text } : {}),
  };
}
