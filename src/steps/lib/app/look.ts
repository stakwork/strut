import { z } from "zod";
import { defineStep, withMedia, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { browserOf, shotSinkOf } from "../browser/_shared.js";
import { requireApps } from "./_shared.js";

/**
 * Look at a published app the way a person opening it would: strut's own UI
 * hosting the version alone, in the run's browser, every request answered
 * by strut in this process as the run's person (BrowserService
 * `lookAtApp`). So the page's calls go through the real host and
 * `step_run`, under the app's grants, and what comes back is what the
 * person will see: the shot (shown to a model), the page's text, the
 * console and network errors, and the errors the app's own error boundary
 * reported while it was open.
 *
 * Under `app/*`, so the builders, which hold that grant, have it with no
 * browser grant of their own. The chat builder's tools run under no run:
 * the look then takes a browser session and an artifact directory of its
 * own, let go when it is done.
 */
export default defineStep({
  type: "app/look",
  description:
    "LOOK at a published app as a person opening it sees it: strut's own UI hosts the version in a browser, as you, and its page makes its calls through the real host under the app's grants. " +
    "Returns { name, version, rendered, hostError?, text, errors, appErrors, path, url, width, height } — `rendered`: the page drew something; `hostError`: why the host shows no app; `text`: the page's visible text (capped); " +
    "`errors`: console errors, page errors, failed or 4xx/5xx requests; `appErrors`: what the app's error boundary reported during the look — and, when you are an agent, you SEE the screenshot. " +
    "Use it after every app/publish, on the version it returned (a held app's new version is a draft: name it, or you see the live one), and fix what it shows before handing the app over. " +
    "It runs the page: its reads are real calls, as when a person opens it. An unpublished directory cannot be looked at — publish first.",
  input: z.object({
    name: z.string().describe("The app's workspace name."),
    version: z.string().optional().describe("The version to look at (v1, v2, …) — the one app/publish returned. The active (live) version when omitted."),
    wait: z.number().int().min(0).max(30_000).optional().describe("Extra ms to let the page settle before the shot (a chart animating in, a slow first read)."),
    fullPage: z.boolean().optional().describe("The whole scrollable page, not just the 1280×800 viewport."),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .optional()
      .describe("Viewport in CSS pixels, e.g. { width: 390, height: 844 } for a phone; default 1280×800."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const apps = requireApps(ctx.services);
    const app = await apps.get(cfg.name, cfg.version);
    if (!app) throw new Error(cfg.version ? `App "${cfg.name}" has no version ${cfg.version}` : `App "${cfg.name}" not found`);
    const browser = browserOf(ctx);
    // No run (the chat builder's tools): a browser session and a shot
    // directory of the look's own, under an id like a run's.
    const runId = ctx.runId || `look-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const since = new Date().toISOString();
    try {
      const { small, ...looked } = await browser.lookAtApp(
        runId,
        {
          name: app.name,
          version: app.version,
          ...(ctx.principal ?? ctx.actor ? { actor: ctx.principal ?? ctx.actor } : {}),
          ...(cfg.wait !== undefined ? { wait: cfg.wait } : {}),
          ...(cfg.fullPage ? { fullPage: true } : {}),
          ...(cfg.viewport ? { viewport: cfg.viewport } : {}),
        },
        shotSinkOf({ ...ctx, runId }),
      );
      // What the app's error boundary reported while the look had it open.
      const reported = (await apps.get(app.name, app.version))?.errors ?? [];
      const appErrors = reported
        .filter((e) => e.version === app.version && e.at >= since)
        .map((e) => ({ message: e.message, ...(e.stack ? { stack: e.stack } : {}), ...(e.componentStack ? { componentStack: e.componentStack } : {}) }));
      const out = { name: app.name, version: app.version, ...looked, appErrors };
      return withMedia(out, [{ mediaType: "image/png", data: small, filename: looked.path }]);
    } finally {
      if (!ctx.runId) await browser.dispose(runId);
    }
  },
});
