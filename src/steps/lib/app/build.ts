import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireApps, resolveAppPath } from "./_shared.js";

/** Build an app directory in place: what the builder runs before
 *  `app/publish` to read the errors, nothing published. */
export default defineStep({
  type: "app/build",
  description:
    "Build an app directory in place (plans/apps.md §2): writes dist/index.html — one self-contained document, the kit's bootstrap and the app's bundle, Tailwind compiled — and dist/build.json. " +
    "Returns { ok: true, hash, bytes, warnings } or { ok: false, errors, warnings }: the errors name the file and line — an import outside the kit and the installed apps, one that leaves the directory, " +
    "dangerouslySetInnerHTML / eval / new Function, a bad app.yaml, a grant naming a workflow that does not exist; a global fetch is a warning naming the hook to use (useStep, useLaunch). " +
    "Fix and build again; nothing is published (app/publish does that).",
  input: z.object({
    path: z.string().describe("The app directory, relative to the job's (or run's) directory."),
    name: z.string().optional().describe("The app's workspace name, when it has one — an imported kit that imports it back is then a cycle the build names."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const dir = await resolveAppPath(ctx, cfg.path);
    return requireApps(ctx.services).build(dir, cfg.name ? { name: cfg.name } : undefined);
  },
});
