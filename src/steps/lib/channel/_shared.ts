/** What the `channel/*` steps share (plans/app-channels.md §5): a channel is
 *  an APP's, so they run only with `ctx.app` set — in a step the app's page
 *  called, or a workflow the app launched — and they stamp what they send
 *  with the code that sent it, never a name the caller picks. */
import { workflowOf, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { ChannelApp, Channels } from "../../../channels.js";
import { RUN_STEP_FLOW, runStepId } from "../../../run-step.js";

/** The app whose channels this step reaches, and the strut server's channels. */
export function channelDoor(type: string, ctx: StepContext<StrutCapabilities>): { app: ChannelApp; channels: Channels } {
  if (!ctx.app) {
    throw new Error(
      `${type}: a channel is an app's — this step runs in a step the app's page called or a workflow the app launched (ctx.app), never on its own`,
    );
  }
  const channels = (ctx.services as Partial<StrutCapabilities> | undefined)?.channels;
  if (!channels) throw new Error(`${type} needs the strut server's channels (ctx.services.channels)`);
  return { app: ctx.app, channels };
}

/** Who sends, as strut stamps it: the workflow's name, or — in a step a
 *  page called through `step_run` — that step's type (a step run's path is
 *  `__run_step__/<type with / as .>`, read back through the registry). So a
 *  referee step's states are its own, whichever player set it off, and no
 *  page can replace them. */
export function senderCode(ctx: StepContext<unknown>): string {
  const workflow = workflowOf(ctx);
  if (workflow !== RUN_STEP_FLOW) return workflow;
  const id = (ctx.path ?? "").split("/")[1] ?? "";
  return Object.keys(ctx.registry ?? {}).find((t) => runStepId(t) === id) ?? id;
}
