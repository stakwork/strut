import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

export default defineStep({
  type: "app/pin",
  description:
    "Pin a published APP as a TAB, or unpin it (`pinned: false`): a host that lists this workspace's apps (a portal's sidebar for the workspace this strut belongs to) shows a pinned app as a tab of its own, at its active version. " +
    "The app's record, not a version: a later publish keeps the tab. Only when the person asks for it. Returns { name, pinned }.",
  input: z.object({
    name: z.string().describe("The app's name, as app/list gives it"),
    pinned: z.boolean().default(true).describe("false unpins it"),
  }),
  output: z.object({ name: z.string(), pinned: z.boolean() }),
  async run(cfg, ctx) {
    await requireApps(ctx.services).pin(cfg.name, cfg.pinned);
    return { name: cfg.name, pinned: cfg.pinned };
  },
});
