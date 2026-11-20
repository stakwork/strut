import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { listedFileSchema, loadListedFiles } from "../../../ai/attachments.js";
import { GROUP_MAX, SHOW_MAX_BYTES } from "../../../tasks/tasks.js";
import { TEST_FILE_MAX_BYTES } from "../../../tasks/test-files.js";

/**
 * A run tells the workers who answered its task what came of it: the mirror
 * of the `human` step's `show`, read after the answer — a JSON object and
 * files of this run (what an `image` step drew from their photo). They read
 * it in their app (`task/history`'s `reply`, its files through `task/file`
 * with the lease they answered by); staff read it on the task.
 *
 * Only a step of the run that asked, on a task it asked: the store reads the
 * calling run off its control, never this input, so an app page, another run
 * or a forged id is refused. Never an agent's tool: a run decides what its
 * workers are told. Only on a task settled by an answer; a later reply
 * replaces the one before. A workflow that never calls it shows the worker
 * nothing more than before.
 *
 * `group` names the deliverable the task is part of — a book its pages, a
 * batch its ballots — which the run knows once the answer is in: staff read
 * and review a group together (Workers' Answers, by group), and the worker's
 * app lists their groups and each one's verdicts (`task/history`).
 */
export default defineStep({
  type: "task/reply",
  effect: "write",
  description:
    "Tell the worker(s) who answered a task what came of it, after their answer: `task` is the `human` step's `task` output (a task THIS run asked, settled by an answer), `show` a JSON object they see (at most 256 KB), `files` files of this run they can open " +
    "(paths under the run's artifacts, or `{ path, name?, mediaType? }` as an `attachments` output lists them; at most 10, each at most 3.8 MB — what a page can read). " +
    "Their worker app shows it with the task (task/history's reply); staff see it on the task. A second reply replaces the first. " +
    "`group` names the deliverable the task is part of (a book its pages, a batch its photos; at most 200 characters): staff review a group together, and the worker's app lists theirs (task/history { groups, group }); a reply with only a group leaves what was told as it was. Not as an agent's tool. Answers { task, at }.\n\n" +
    `- id: tell
  type: task/reply
  config:
    task: "{{ shot.task }}"
    show: { note: "Here it is" }
    files: ["{{ remix.path }}"]
    group: "{{ input.book }}"`,
  input: z.object({
    task: z.string().min(1).describe("The task: the human step's `task` output."),
    show: z.record(z.string(), z.unknown()).optional().describe(`What the worker sees: a JSON object, at most ${SHOW_MAX_BYTES} bytes.`),
    files: z.array(listedFileSchema).optional().describe(`Files of this run the worker can open: paths under the run's artifacts, or entries { path, name?, mediaType? }; at most 10, each at most ${TEST_FILE_MAX_BYTES} bytes.`),
    group: z.string().min(1).max(GROUP_MAX).optional().describe("The deliverable the task is part of (a book, a batch): kept until another is named."),
  }),
  output: z.object({ task: z.string(), at: z.number() }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    if (ctx?.agentTool) throw new Error("task/reply: a run's step, never an agent's tool — a run decides what its workers are told");
    const tasks = ctx?.services?.tasks;
    if (!tasks?.reply) throw new Error("task/reply: this server's task store takes no replies (ctx.services.tasks.reply)");
    let files: Array<{ name: string; mediaType: string; size: number; path: string }> | undefined;
    if (cfg.files?.length) {
      const artifacts = ctx!.services.artifacts;
      if (!artifacts) throw new Error("task/reply: this server keeps no run artifacts, so a reply has no files");
      files = (await loadListedFiles(artifacts, ctx!.runId, cfg.files)).map((f) => ({ name: f.name, mediaType: f.mediaType, size: f.bytes.length, path: f.path }));
    }
    return tasks.reply({ task: cfg.task, ...(cfg.show ? { show: cfg.show } : {}), ...(files ? { files } : {}), ...(cfg.group ? { group: cfg.group } : {}) }, { ...(ctx!.control ? { control: ctx!.control } : {}) });
  },
});
