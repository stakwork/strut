import { z } from "zod";
import { defineStep } from "../../../core.js";
import { readWithdrawInvoice } from "../../../payments/withdraw-reading.js";

/** A BOLT11 invoice read for a withdrawal, before anything is sent: the
 *  amount it asks, the fee cap, its expiry, whether it is more than can go
 *  (src/payments/withdraw-reading.ts, what strut's own Withdraw dialog reads
 *  it with). Pure: it reads, it pays nothing. */
export default defineStep({
  type: "earnings/read-invoice",
  effect: "read",
  description:
    "Read a BOLT11 invoice for a withdrawal, paying nothing: { ok: true, msat, maxFeeMsat, expiresIn (s), usd?, overBalance, network?, invoice: { description?, … } } or { ok: false, error }. Give the wallet's balance, provider and the rate to judge it against.",
  input: z.object({
    invoice: z.string(),
    balanceMsat: z.number().nonnegative().optional(),
    usdPerBtc: z.number().positive().optional(),
    provider: z.string().nullable().optional(),
  }),
  output: z.any(),
  async run(cfg) {
    return readWithdrawInvoice(cfg.invoice, {
      ...(cfg.balanceMsat !== undefined ? { balanceMsat: cfg.balanceMsat } : {}),
      ...(cfg.usdPerBtc !== undefined ? { usdPerBtc: cfg.usdPerBtc } : {}),
      ...(cfg.provider !== undefined ? { provider: cfg.provider } : {}),
    });
  },
});
