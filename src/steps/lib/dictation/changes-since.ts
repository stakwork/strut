import { z } from "zod";
import { defineStep } from "../../../core.js";
import { Change } from "./_shared.js";
import { graphChanges } from "./_graph.js";

/** A time as epoch ms: an ISO string, a number of ms, or nothing (the start). */
function ms(at: string | number | undefined): number {
  if (at === undefined || at === "") return 0;
  const n = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(n)) throw new Error(`dictation/changes-since: since is not a time: ${JSON.stringify(at)}`);
  return n;
}

// What dictation changed in this strut's memory, read from the graph itself:
// no outbox. A learn is a Mishearing record (or, for a term, a Lingo word
// with none) written with created_by "dictation"; an undo is one deleted
// with reason "undone". A learn later forgotten for another
// reason (dictation/remove), or expired, is left out: replayed, it would
// come back.
//
// Read in the writes' queue, over [since, until): a write stamps its time
// when it starts and commits later, so a read beside one would miss it for
// good. In the queue every stamp before `until` is committed, and every
// write after it stamps `until` or later, which the next read starts from.
export default defineStep({
  type: "dictation/changes-since",
  description:
    "What dictation learned or undid in this strut server's memory from `since` up to now, for another strut server to replay with " +
    "dictation/apply-changes (a Mac's strut server pushing to its home box). Each change is keyed by its pair (heard, written, and " +
    "the entity's name when written is another form of it), never a ref_id. Pass the reply's `until` as the next `since`: " +
    "nothing falls between two reads.",
  input: z.object({
    since: z.union([z.string(), z.number()]).optional().describe("The last read's `until` (ISO or epoch ms); absent: everything."),
  }),
  output: z.object({ kind: z.literal("dictation"), since: z.string(), until: z.string(), changes: z.array(Change) }),
  async run(cfg, ctx) {
    return graphChanges(ctx, ms(cfg.since));
  },
});
