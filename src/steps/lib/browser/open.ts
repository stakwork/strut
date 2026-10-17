import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Ctx, browserOf, keptOf, navigated, session, timeoutMs, viewport } from "./_shared.js";

export default defineStep({
  type: "browser/open",
  description:
    "Start the run's browser page — the FIRST call in every browser workflow. Idempotent: a second call returns the page the run already has (viewport and session apply only the first time). Give `url` to navigate straight away; otherwise call browser/goto next. `storageStateSecret` names a secret whose value is a Playwright storage state (cookies + localStorage JSON, see browser/state) for a logged-in session — the value never enters the model. " +
    "`session` opens a page the JOB keeps instead (one browser/keep kept, or a new one): it outlives this run, so a later run of the job finds it where this one left it. On a kept page that was already open `url` is NOT opened — the page stays where it is. Returns { url, title, status, resumed } — resumed: the page was already open.",
  input: z.object({
    url: z.string().optional().describe("navigate here after opening (http/https); with `session`, only on a new page"),
    viewport,
    storageStateSecret: z.string().optional().describe("NAME of a secret holding a Playwright storageState JSON"),
    session: session.optional(),
    timeoutMs,
  }),
  output: navigated.extend({ resumed: z.boolean().describe("the page was already open") }),
  async run(cfg, ctx: Ctx) {
    const browser = browserOf(ctx);
    let storageState: unknown;
    if (cfg.storageStateSecret) {
      const raw = await ctx.services.secrets?.get(cfg.storageStateSecret);
      if (!raw) throw new Error(`browser/open: secret ${cfg.storageStateSecret} is not set`);
      try {
        storageState = JSON.parse(raw);
      } catch {
        throw new Error(`browser/open: secret ${cfg.storageStateSecret} is not JSON (expected a Playwright storageState)`);
      }
    }
    if (!cfg.session) return browser.open(ctx.runId, { url: cfg.url, viewport: cfg.viewport, storageState, timeoutMs: cfg.timeoutMs });
    // The hold is taken once the page is the job's, before it navigates: a
    // URL that fails to open still leaves a page the job holds.
    const kept = keptOf(ctx, cfg.session, "open");
    const opened = await browser.open(ctx.runId, { viewport: cfg.viewport, storageState, session: kept.session });
    if (opened.resumed) return opened;
    await kept.hold();
    if (!cfg.url) return opened;
    return { ...(await browser.goto(ctx.runId, { url: cfg.url, timeoutMs: cfg.timeoutMs })), resumed: false };
  },
});
