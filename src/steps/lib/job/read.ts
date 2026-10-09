import { basename } from "node:path";
import { z } from "zod";
import { defineStep, withMedia } from "../../../core.js";
import { JOB_READ_MAX_CHARS } from "../../../job-index.js";
import { requireJobIndex } from "./_shared.js";

/**
 * One file of a job's directory, for the agent's door (plans/job-index.md
 * §5): text as text, an image SHOWN to the model — `withMedia`, the
 * `browser/screenshot` pattern, so a turn can look at a screenshot an
 * earlier job took. The path never leaves the job's directory
 * (`jobFilePath`); a text over the cap comes back head + tail, the
 * shell's rule.
 */
export default defineStep({
  type: "job/read",
  description:
    `Read ONE file of a job's directory (job/get lists its files, and each artifact's \`path\`). ` +
    `A text file comes back as \`text\` — cut to maxChars (default ${JOB_READ_MAX_CHARS}) keeping its head and tail, \`truncated: true\` when cut. ` +
    `An image (png, jpg, gif, webp) is SHOWN to you beside { kind: "image", mediaType, bytes }. ` +
    `Other binary kinds (pdf, video, audio) are not read; the result names the link to open instead. Paths never leave the job's directory.`,
  input: z.object({
    job: z.string().describe("The job id, from job/list."),
    path: z.string().describe("Relative to the job's directory, as job/get lists it."),
    maxChars: z.number().int().positive().optional().describe(`Cap on a text file's content (default ${JOB_READ_MAX_CHARS}).`),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const file = await requireJobIndex(ctx.services).read(cfg.job, cfg.path, { maxChars: cfg.maxChars });
    if (!file) throw new Error(`No file "${cfg.path}" in job "${cfg.job}"`);
    if (!file.image) return file;
    const { image, ...rest } = file;
    return withMedia({ ...rest, mediaType: image.mediaType, bytes: image.data.byteLength }, [
      { mediaType: image.mediaType, data: image.data, filename: basename(cfg.path) },
    ]);
  },
});
