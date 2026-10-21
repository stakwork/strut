import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

export default defineStep({
  type: "app/get",
  description:
    "One workspace app at a version (the active one by default): its manifest (title, grants, data, csp), hash, versions, publisher, owner, upstream, the version's directory (`dir`) and files, " +
    "its build (`build`: the kit, builtAt, the hash it built from, the imported apps) and `stale` — true when the document is older than the sources or an imported kit moved, so a build is due — " +
    "and `inertGrants`, granted workflows that no longer exist.",
  input: z.object({
    name: z.string().describe("The app's name (app/list)."),
    version: z.string().optional().describe("A version label (v1, v2, …); the active version when omitted."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const view = await requireApps(ctx.services).get(cfg.name, cfg.version);
    if (!view) throw new Error(cfg.version ? `App "${cfg.name}" has no version ${cfg.version}` : `App "${cfg.name}" not found`);
    return view;
  },
});
