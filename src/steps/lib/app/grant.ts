import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

/**
 * A person's grant of a SEALED workflow to one app (src/apps/grants.ts) —
 * the assistant (`orchestrator`) for an app with a chat of its own. Only as
 * a proposal a person accepted (`ctx.proposal`), as `meta/set-automation`:
 * a direct tool call, a DAG step, `meta/run-step` or a subflow is refused,
 * so a model can ask for it and never give it. The orchestrator's template
 * grants it and lists it in `approve:`; Hive's Jamie chat and Peel's DM
 * show the card, and strut runs this on the person's yes, with them as
 * `ctx.actor`. The grant is on the app's name: the app's builder publishes
 * after it, and every later version keeps it.
 */
export default defineStep({
  type: "app/grant",
  description:
    "Let an app's pages talk to a protected workflow — the assistant, `orchestrator` — as whoever opens the app. " +
    "Only on a person's yes: the call becomes a proposal the person approves, and the grant is made then. Ask for it when a build reports that an app needs it " +
    "(its publish was refused for naming a sealed workflow); once approved, continue the build so it publishes again. Returns { app, workflow, by, at }.",
  input: z.object({
    name: z.string().min(1).describe("The app's name, as the build named it."),
    workflow: z.string().min(1).default("orchestrator").describe("The protected workflow the app's pages may run: `orchestrator`, the assistant."),
  }),
  output: z.any(),
  async describe(cfg) {
    const what = cfg.workflow === "orchestrator" ? "talk to the assistant" : `run ${cfg.workflow}`;
    return {
      title: `Let app ${cfg.name} ${what} as whoever opens it`,
      fields: [
        { label: "app", value: cfg.name, kind: "ref", danger: true },
        { label: "workflow", value: cfg.workflow, kind: "ref", danger: true },
      ],
      actions: { accept: "Grant", reject: "Don't grant" },
    };
  },
  async run(cfg, ctx) {
    if (!ctx.proposal) {
      throw new Error(
        "app/grant runs only as a proposal a person accepted: a person makes this grant, never a tool call. A build says in its reply that the app needs it; " +
          "the assistant, which holds app/grant behind the person's approval, asks for it.",
      );
    }
    const grant = await requireApps(ctx.services).grant(cfg.name, cfg.workflow, {
      ...(ctx.actor ? { by: ctx.actor } : {}),
      proposal: ctx.proposal.id,
    });
    return { app: cfg.name, ...grant };
  },
});
