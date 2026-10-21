import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireApps, resolveAppPath } from "./_shared.js";

export default defineStep({
  type: "app/init",
  description:
    "Scaffold a starter app directory to edit (plans/apps.md §8): app.yaml, src/App.tsx (a shadcn sidebar layout with react-router), src/styles.css and an empty db/. " +
    "`template` is one of strut's (default: `default`) or the name of an installed app (app/list), copied under the new path with no upstream — a copy, not a fork. " +
    "The path is relative to the job's directory (or the run's), and must be new or empty. Then edit the files, app/build, app/publish.",
  input: z.object({
    path: z.string().describe("Where to write the directory, relative to the job's (or run's) directory — `apps/<name>`."),
    template: z.string().optional().describe("A strut template name, or an installed app's name. Default: `default`."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const dir = await resolveAppPath(ctx, cfg.path);
    return requireApps(ctx.services).init(dir, cfg.template);
  },
});
