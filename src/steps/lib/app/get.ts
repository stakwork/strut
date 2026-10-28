import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireApps, resolveAppPath } from "./_shared.js";

export default defineStep({
  type: "app/get",
  description:
    "One workspace app at a version (the active one by default): its manifest (title, grants, data, csp), hash, versions, publisher, owner, upstream, the version's directory (`dir`) and files, " +
    "its build (`build`: the kit, builtAt, the hash it built from, the imported apps) and `stale` — true when the document is older than the sources or an imported kit moved, so a build is due — " +
    "`inertGrants`, granted workflows that no longer exist, and `errors`, the page's latest client-side errors. " +
    "With `path` instead of `name`: an app DIRECTORY you are working on (in your job's directory; `job` names another job's) — read back the same way: manifest, files, build, `stale`.",
  input: z.object({
    name: z.string().optional().describe("A workspace app's name (app/list)."),
    version: z.string().optional().describe("With `name`: a version label (v1, v2, …); the active version when omitted."),
    path: z.string().optional().describe("Instead of `name`: an app directory, relative to the job's (or run's) directory."),
    job: z.string().optional().describe("With `path`: another job whose directory it is relative to."),
  }).refine((q) => !!q.name !== !!q.path, { message: "app/get takes `name` (a workspace app) or `path` (an app directory), one of them" }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const apps = requireApps(ctx.services);
    if (cfg.path) {
      const dir = await resolveAppPath(ctx, cfg.path, cfg.job, { root: true });
      const view = await apps.getDir(dir);
      if (view.missing) throw new Error(`No directory "${cfg.path}"`);
      return view;
    }
    const view = await apps.get(cfg.name!, cfg.version);
    if (!view) throw new Error(cfg.version ? `App "${cfg.name}" has no version ${cfg.version}` : `App "${cfg.name}" not found`);
    return view;
  },
});
