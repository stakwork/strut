import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { APP_CALL_LOG } from "../../../apps/monitor.js";
import { requireApps } from "./_shared.js";

/**
 * What a person's OPEN app did (plans/app-calls.md): the calls its page made
 * through `step_run`, in whatever host it is open, off the monitor's log —
 * the run's own person's alone, so a person's runs read their own pages and
 * nobody else's.
 */
export default defineStep({
  type: "app/calls",
  description:
    "What YOUR open app did: the calls its page made (step_run, in any host: strut's UI, Hive, Peel), yours alone — the viewer is this run's person. " +
    "Oldest first, each { at (the step's start), t (ms since the first listed), version, type, status (ok | refused | error | invalid), ms (the step), doorMs (strut's time before the step: the gate, the door), bytes, error?, config? (cut) }; `more` counts earlier ones `limit` left out. " +
    "The page's own errors are its app/report-error calls, in place. Kept in memory for an hour, the last 1000 calls; a restart loses them. " +
    "It cannot see time outside strut: the host's relay, the document's load, the page's render. Fast calls with a long gap between them mean the time went there. " +
    "Use it when a person says an app is slow or failing, before guessing from a pasted console.",
  input: z.object({
    name: z.string().describe("The app's name (app/list)."),
    since: z.string().optional().describe("An ISO time: only the calls that started at or after it."),
    limit: z.number().int().positive().max(APP_CALL_LOG.perViewer).optional().describe(`How many of the newest calls (default ${APP_CALL_LOG.limit}).`),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (cfg.since && Number.isNaN(Date.parse(cfg.since))) throw new Error(`app/calls: since "${cfg.since}" is not a time — an ISO time, such as 2026-11-21T10:02:00Z`);
    const log = await requireApps(ctx.services).calls(cfg.name, ctx.actor, {
      ...(cfg.since ? { since: cfg.since } : {}),
      ...(cfg.limit ? { limit: cfg.limit } : {}),
    });
    if (!log) throw new Error(`App "${cfg.name}" not found`);
    return log;
  },
});
