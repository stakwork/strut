import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { readAppState, updateAppState } from "../../../apps/state.js";

/**
 * The page's storage (src/apps/state.ts): what one viewer's page remembers
 * — a tab, a filter, a draft — since a framed page has no browser storage.
 * Keyed by the app the call is for (`ctx.app`, which only the app door sets)
 * and the viewer (`ctx.actor`), so a page reads and writes its own viewer's
 * state and nobody else's. The kit's `useAppState` is over it. Always
 * granted to an app, never kept as a run.
 */
export default defineStep({
  type: "app/state",
  description:
    "An APP page's per-viewer state (the kit's useAppState calls this): `{}` reads it, `{ set: { key: value } }` sets keys (null removes one); both return { state }, the viewer's whole state. " +
    "Only from an app's page (step_run): keyed by the app and the viewer. Small (256 KB a viewer) — a tab, a filter, a draft; data others or an agent should see goes in the graph.",
  input: z.object({
    set: z.record(z.string(), z.any()).optional().describe("Keys to set; a null value removes the key."),
  }),
  output: z.object({ state: z.record(z.string(), z.any()) }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.app) throw new Error("app/state is an app page's storage: it runs only from an app's page (step_run), for that app and its viewer");
    const dataDir = (ctx.services as Partial<StrutCapabilities> | undefined)?.dataDir;
    if (!dataDir) throw new Error("app/state needs the server's dataDir (ctx.services.dataDir)");
    const state = cfg.set && Object.keys(cfg.set).length
      ? await updateAppState(dataDir, ctx.app.name, ctx.actor, cfg.set)
      : await readAppState(dataDir, ctx.app.name, ctx.actor);
    return { state };
  },
});
