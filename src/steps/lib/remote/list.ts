import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { remoteOf } from "./_shared.js";

/**
 * What another strut server SELLS (plans/paid-runs.md §10 "Another strut"):
 * its public door's `runnable` list — every workflow and tool anyone may
 * run there, with its price — and the credit this strut holds there. No
 * peer record: any strut server's URL. A read; nothing is spent.
 */
export default defineStep({
  type: "remote/list",
  effect: "read",
  description:
    "Read what another strut server SELLS to run — through its public door, with no peer record — and the credit this strut server holds there. " +
    "Returns { seller, runnable, credit }: `runnable` each { kind: workflow | step, name, description?, base, markup, capUsd, reserve, input, recent } — " +
    "a run is charged base + markup × what it cost there (dollars), needs `reserve` of free credit to start, and `recent` says what its runs were charged in the last 30 days; " +
    "`input` is what to send. `credit` is { held, remaining_usd?, expires?, buying? }. Run one with remote/run-workflow (a workflow) or remote/call (a step). " +
    "A free item needs no credit; a priced one is paid from credit an admin bought with remote/buy-credit.",
  input: z.object({
    url: z.string().describe("The seller: a strut server's base URL, https (e.g. https://cve.example, or https://swarm.example:3355/lab)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return remoteOf(ctx, "remote/list").list(cfg.url);
  },
});
