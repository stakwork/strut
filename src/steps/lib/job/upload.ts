import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { JOB_UPLOADS_DIR, jobRoot, saveJobUpload } from "../../../jobs.js";
import { idProblem } from "../../../session-store.js";
import { MAX_ATTACHMENT_BYTES, decodeAttachment, formatBytes } from "../../../ai/attachments.js";

/**
 * A file INTO a job (plans/apps.md §12): an app page's upload — a page
 * reaches strut only through `step_run`, so the upload is a step. The file
 * lands in the job's `uploads/`, where every run launched under the job
 * finds it (`job/dir`'s path) and an agent on `session: "{{ $job }}"` can
 * talk about it across turns. Never written over: a taken name is
 * numbered. Takes no hold, so a file may arrive while a run of the job is
 * working. Its input is the bytes, so the app door never keeps it as a run:
 * the file is the record.
 */
export default defineStep({
  type: "job/upload",
  description:
    `Save ONE file into a job's ${JOB_UPLOADS_DIR}/ folder: <dataDir>/jobs/<job>/${JOB_UPLOADS_DIR}/<name>, made with the job when there is none. ` +
    `Every run launched under the job (POST …/run { job }, run/launch { job }) sees it at the returned \`path\`, relative to the folder job/dir returns. ` +
    `A name already there is numbered (photo-2.jpg), never overwritten. At most ${formatBytes(MAX_ATTACHMENT_BYTES)}. ` +
    `Output: { job, path, name, mediaType, size }. job/delete-upload removes one.`,
  input: z.object({
    job: z.string().describe("The job id."),
    name: z.string().describe("The file's name (made safe; a taken one is numbered)."),
    mediaType: z.string().optional().describe("Its media type; from a data URL or the extension when omitted."),
    data: z.string().describe("The bytes: base64, or a data URL."),
  }),
  output: z.object({
    job: z.string(),
    path: z.string(),
    name: z.string(),
    mediaType: z.string(),
    size: z.number(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const problem = idProblem(cfg.job);
    if (problem) throw new Error(`job/upload: job "${cfg.job}" ${problem}`);
    const file = decodeAttachment(cfg, "job/upload");
    if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`job/upload: ${file.name} is ${formatBytes(file.bytes.length)}; the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
    }
    const dataDir = (ctx.services as Partial<StrutCapabilities> | undefined)?.dataDir ?? join(tmpdir(), "strut");
    const path = await saveJobUpload(jobRoot(dataDir, cfg.job), cfg.job, file);
    return { job: cfg.job, path, name: file.name, mediaType: file.mediaType, size: file.bytes.length };
  },
});
