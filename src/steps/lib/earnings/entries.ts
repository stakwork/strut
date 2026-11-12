import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { adminDoor, bodyOrThrow } from "./_door.js";

/** The ledger's entries, newest first: `GET /earnings/entries` (specs/API.md §19). */
export default defineStep({
  type: "earnings/entries",
  effect: "read",
  description:
    "The ledger's entries newest first — payments in, holds, charges, carries, expiries, withdrawals — of one `kind` or one run, dollars and msat. Only strut's own Earnings app, shown to an admin.",
  input: z.object({
    kind: z.enum(["payment", "hold", "charge", "carry", "expiry", "withdrawal"]).optional(),
    runId: z.string().optional(),
    before: z.number().int().positive().optional().describe("Entries before this sequence number (the next page)."),
    limit: z.number().int().positive().max(500).optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(cfg)) if (v !== undefined) q.set(k, String(v));
    return bodyOrThrow(await adminDoor(ctx, "earnings/entries").call("GET", `/earnings/entries?${q}`, undefined, ctx.actor));
  },
});
