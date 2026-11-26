import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

/** `place/list` (plans/place-posts.md §2): the places linked here that the
 *  run's person may post in — every place of each host whose kind of account
 *  they hold — by host, key and name, for a workflow to name one by its key.
 *  Never a place's link or its linker. A read: an agent may call it. */
export default defineStep({
  type: "place/list",
  effect: "read",
  description:
    "The places linked to this box that the run's person may post in with place/post (Sphinx tribes): { places: [{ host, key, name? }] }. " +
    "A workflow names a place by host and key; name is what the person who linked it saw it called.",
  input: z.object({}),
  output: z.object({ places: z.array(z.object({ host: z.string(), key: z.string(), name: z.string().optional() })) }),
  async run(_cfg, ctx?: StepContext<StrutCapabilities>) {
    const places = ctx?.services?.places;
    if (!places) throw new Error("place/list needs this server's places (ctx.services.places). The standard strut server provides them.");
    return { places: await places.list(ctx?.principal) };
  },
});
