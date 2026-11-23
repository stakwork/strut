import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { ConversationsCapability } from "../../../conversations.js";
import { journal, journalKey } from "../job/_shared.js";

/**
 * Work a package starts for a person, as a chat with the assistant
 * (plans/package-seams.md §7): a NEW conversation of the run's person,
 * `<person>/<12 hex>`, whose first turn is the person's `message`, strut's
 * fixed reply ("On it.") and `job` already running — a turn of the
 * conversation workflow with no model (`$prepared`). When the job ends, its
 * wake reports in that chat, as for any job a chat started; what the person
 * types next goes to the assistant as usual.
 *
 * As the run's person: a page's call runs as its viewer, an `on:` run as the
 * person whose write fired it. None, and it refuses; inside a job's run too,
 * since that job's own chat is where its work shows. Not sealed, so a
 * package's workflow or an app's page may be granted it: it starts a new chat
 * with one job, and can neither continue a chat nor say more than strut's
 * fixed words. The chat keeps where it came from (`from`: the calling
 * workflow's or page's package) and the node it is about (`about`), which
 * `conversation/list { about }` finds.
 *
 * Launched once, even across a resume of the calling run: the chat and its
 * job are journaled, as job/start journals its launch.
 */
export default defineStep({
  type: "conversation/start",
  effect: "write",
  description:
    "Start work for the run's person as a NEW chat with the assistant: their `message`, the assistant's fixed reply \"On it.\" and `job` already running — no model decides it. " +
    "The job's end reports in that chat; the person answers there. Runs as the run's person (a page's viewer, an on: run's writer); refused with no person and inside a job's run. " +
    "Returns { session, job }: the chat's id (open it, or find it again with conversation/list { about }) and the job's.",
  input: z.object({
    message: z.string().min(1).describe("The person's message, the chat's first: what the work is, as they would say it, and anything they wrote for it (\"Set up stakwork\", then their note)."),
    job: z
      .object({
        title: z.string().min(1).describe("A short name for the job, as the person would say it: the chat's title and the job's card."),
        brief: z.string().min(1).describe("Everything the job needs: job/start's prompt. The job does not see the chat."),
        kind: z.string().optional().describe("The kind of work, by its page's name under the `Job` Concept (\"Pod Setup\"): the job starts every turn from that page."),
        repos: z.array(z.string()).optional().describe("Repository URLs the job works on, checked out before it starts."),
      })
      .strict()
      .describe("The job the chat starts: job/start's fields."),
    about: z.string().min(1).max(200).optional().describe("The graph node the chat is about (a ref_id): conversation/list { about } finds the chat by it."),
  }),
  output: z.object({ session: z.string(), job: z.string() }),
  async run(cfg, ctx: StepContext) {
    const person = ctx.actor;
    if (!person) throw new Error("conversation/start runs as a person — a page's viewer, the writer behind an on: run — and this run has none");
    if (ctx.job) throw new Error(`conversation/start: this run is job "${ctx.job}"'s, and a job's work shows in its own chat — report there instead of starting another`);
    if (ctx.trial) throw new Error("conversation/start: a trial starts nothing outside itself");
    const start = (ctx.services as { conversations?: ConversationsCapability } | undefined)?.conversations?.start;
    if (!start) throw new Error("conversation/start needs a strut server to hold the chat (ctx.services.conversations.start). The standard strut server provides it.");
    const key = journalKey(ctx, "start");
    const prior = key ? (ctx.journal?.[key] as { session?: unknown; job?: unknown } | undefined) : undefined;
    if (typeof prior?.session === "string" && typeof prior.job === "string") return { session: prior.session, job: prior.job };
    const from = ctx.package ?? ctx.app?.name;
    const out = await start({
      person,
      message: cfg.message,
      job: cfg.job,
      ...(cfg.about ? { about: cfg.about } : {}),
      ...(from ? { from } : {}),
      runId: ctx.runId,
    });
    await journal(ctx, key, out);
    return out;
  },
});
