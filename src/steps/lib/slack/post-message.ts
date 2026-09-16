import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { slackToken, slackCall } from "./_shared.js";

const EXAMPLE = `- id: notify
  type: slack/post-message
  config:
    channel: "C0123ABCD"
    text: "Build {{ build.status }} for {{ input.repo }}"
    token: "{{ input.slackToken }}"`;

export default defineStep({
  type: "slack/post-message",
  description: `Post a message to a Slack channel or thread. Auth: token, else the SLACK_BOT_TOKEN secret; the bot needs the chat:write scope and must be a member of the channel. To thread replies, post once and pass the returned ts as a later step's thread_ts.\n\n${EXAMPLE}`,
  input: z.object({
    channel: z.string().min(1).describe("channel ID (e.g. C0123ABCD, recommended) or a #channel name"),
    text: z.string().optional().describe("message text (Slack mrkdwn); required unless blocks is set"),
    blocks: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Block Kit blocks for a rich layout; text then serves as the notification fallback"),
    thread_ts: z.string().optional().describe("ts of the parent message, to reply in its thread"),
    token: z.string().optional().describe("bot token (xoxb-…); omit to use the SLACK_BOT_TOKEN secret"),
  }),
  output: z.object({
    ts: z.string(),
    channel: z.string(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!cfg.text && !cfg.blocks) {
      throw new Error("slack/post-message needs `text` or `blocks`.");
    }
    const token = await slackToken(cfg.token, ctx);

    const data = await slackCall(ctx, "chat.postMessage", token, {
      body: {
        channel: cfg.channel,
        ...(cfg.text ? { text: cfg.text } : {}),
        ...(cfg.blocks ? { blocks: cfg.blocks } : {}),
        ...(cfg.thread_ts ? { thread_ts: cfg.thread_ts } : {}),
      },
    });

    return {
      ts: (data.ts as string) ?? "",
      channel: (data.channel as string) ?? cfg.channel,
    };
  },
});
