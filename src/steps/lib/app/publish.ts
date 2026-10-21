import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireApps, resolveAppPath } from "./_shared.js";

export default defineStep({
  type: "app/publish",
  description:
    "Publish an app directory to the workspace as `name` (plans/apps.md §1.2): builds first — a failing build publishes nothing and returns its errors — then records the version " +
    "(the same tree re-activates the version it already is; anything else is the next vN, made active) and copies the directory into place. " +
    "Stamped publisher `ai`. Under the meta surface's rules: grants.steps may not name llm, agent or exec (put them in a workflow and grant that), nor a sealed step, and grants.workflows no sealed workflow — a person may, through POST /apps. " +
    "`job` publishes from another job's directory. Returns { ok, name, version, changed, hash, bytes, warnings } or { ok: false, errors }.",
  input: z.object({
    name: z.string().describe("The app's workspace name — workflow-style (`hvac-invoices`), or under a package prefix (`acme/hvac/invoices`)."),
    path: z.string().describe("The app directory, relative to the job's (or run's) directory."),
    job: z.string().optional().describe("Another job whose directory `path` is relative to (a builder job publishing a code job's prototype)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const dir = await resolveAppPath(ctx, cfg.path, cfg.job);
    return requireApps(ctx.services).publish(dir, cfg.name, {
      surface: "ai",
      source: "agent",
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    });
  },
});
