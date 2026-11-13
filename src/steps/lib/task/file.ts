import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { RUN_FILE_MAX_BYTES } from "../../../runs.js";
import { workerCall } from "./_shared.js";

/**
 * One file the task a worker leases names (plans/human-steps.md §5.5): only
 * a path on the task's `files`, only through the caller's own live lease —
 * a path off the list is refused whether or not the file exists, since a
 * task shows what its `human` step named and never the rest of its run.
 * Answered as `run/files` answers one.
 */
export default defineStep({
  type: "task/file",
  effect: "read",
  worker: true,
  description:
    "A WORKER's page reads one file of the task it leases (the kit's useTaskFile): `path` must be one of the task's `files`. " +
    `{ path, mediaType, bytes, text } for a text file, { …, base64 } for anything else, cut at ${RUN_FILE_MAX_BYTES} bytes (truncated: true). Only an app page's own call, as its viewer.`,
  input: z.object({
    lease: z.string().min(1).describe("The lease task/next handed out."),
    path: z.string().min(1).describe("One of the task's files, as task/next listed it."),
  }),
  output: z.any(),
  async run(cfg, ctx?: StepContext) {
    const { tasks, actor, app } = workerCall("task/file", ctx);
    return tasks.file(actor, { lease: cfg.lease, path: cfg.path, app });
  },
});
