import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireApps, resolveAppPath } from "./_shared.js";

export default defineStep({
  type: "app/checkout",
  description:
    "Copy a workspace app's version (the active one by default) into a directory to edit — the files as published, dist/ included. " +
    "The path is relative to the job's directory (or the run's) and must be new or empty. Edit, app/build, then app/publish { name, path } makes the next version.",
  input: z.object({
    name: z.string().describe("The app's name (app/list)."),
    version: z.string().optional().describe("A version label; the active version when omitted."),
    path: z.string().describe("Where to write the directory, relative to the job's (or run's) directory."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const dir = await resolveAppPath(ctx, cfg.path);
    return requireApps(ctx.services).checkout(cfg.name, dir, cfg.version);
  },
});
