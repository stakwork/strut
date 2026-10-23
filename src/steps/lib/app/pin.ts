import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

export default defineStep({
  type: "app/pin",
  description:
    "Pin a published APP as a TAB, or unpin it (`pinned: false`): a host that lists this workspace's apps (a portal's sidebar for the workspace this strut belongs to) shows a pinned app as a tab of its own, at its live version. " +
    "Pinning also HOLDS an app that follows latest at the version it shows (plans/app-releases.md): from then on a publish is a DRAFT until a person makes it live. Unpinning leaves what is live alone. " +
    "The app's record, not a version: a later publish keeps the tab. Only when the person asks for it. Returns { name, pinned, live, release? } — `live` the live release's id or `latest`, `release` the one pinning made.",
  input: z.object({
    name: z.string().describe("The app's name, as app/list gives it"),
    pinned: z.boolean().default(true).describe("false unpins it"),
  }),
  output: z.object({ name: z.string(), pinned: z.boolean(), live: z.string(), release: z.string().optional() }),
  async run(cfg, ctx) {
    const apps = requireApps(ctx.services);
    const { release } = await apps.pin(cfg.name, cfg.pinned, ctx.actor ? { by: ctx.actor } : {});
    const live = (await apps.releases(cfg.name))?.live ?? "latest";
    return { name: cfg.name, pinned: cfg.pinned, live, ...(release ? { release: release.id } : {}) };
  },
});
