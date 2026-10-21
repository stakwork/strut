import { z } from "zod";
import { defineStep } from "../../../core.js";

/**
 * The page's door for its failures (plans/apps.md §8): the kit's error
 * boundary and `window.onerror` call it through `step_run`, which KEEPS the
 * run under `step:app/report-error` with the actor, the time and `app` on
 * its summary — so there is no error file of the app's own, and `app/get`
 * reads the app's last 50 from the run store — off the kept run's OUTPUT,
 * which carries the report back (a summary keeps the run's input, never a
 * step's config). The step itself does nothing but answer: the kept run IS
 * the record. Always granted to an app.
 */
export default defineStep({
  type: "app/report-error",
  description:
    "Report a client-side failure of an APP's page (the kit's error boundary and window.onerror call this): { message, stack?, componentStack? }. " +
    "The call is kept as a run under step:app/report-error with the app and the actor on it; app/get lists the app's latest. Returns { ok: true, at, message, stack?, componentStack? }.",
  input: z.object({
    message: z.string().describe("The error's message."),
    stack: z.string().optional().describe("Its stack, when there is one."),
    componentStack: z.string().optional().describe("React's component stack, for a render failure."),
  }),
  output: z.object({ ok: z.literal(true), at: z.string(), message: z.string(), stack: z.string().optional(), componentStack: z.string().optional() }),
  async run(cfg) {
    return { ok: true as const, at: new Date().toISOString(), ...cfg };
  },
});
