import { z } from "zod";
import { defineStep } from "../../../core.js";
import { readState } from "./_state.js";

export default defineStep({
  type: "home/state",
  description:
    "Where this strut's read copy of its home's memory stands (home/sync): `since`, what the last push covered up to, " +
    "`hash`, the content_hash of the copy held, and `at`, when the last sync finished. Empty before the first sync.",
  effect: "read",
  input: z.object({}),
  output: z.object({ since: z.string().optional(), hash: z.string().optional(), at: z.string().optional() }),
  async run(_cfg, ctx) {
    return readState(ctx);
  },
});
