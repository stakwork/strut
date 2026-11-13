import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineStep, withMedia, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { browserOf, LOOK_VERBS, shotSinkOf } from "../browser/_shared.js";
import { SCREENSHOT_MAX_BYTES, screenshotPathProblem } from "../../../apps/manifest.js";
import { requireApps, resolveAppPath } from "./_shared.js";

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
 * With `path`, the app DIRECTORY you are working on, built and hosted as a
 * PREVIEW (`apps.preview`): no version is recorded, so the builder's
 * fix-and-look loop publishes once, at the end, instead of leaving a
 * version (or, on a held app, a draft) behind each round.
 *
 * With `input`, the app opens where a deep link carrying it takes a person
 * (`?app=…&input=…`); with `steps`, a person's clicks and typing then run
 * in the app's frame, through the verbs `browser/capture` runs. So a page
 * past the first one, or a tab of it, is looked at the way it is reached.
 * Keys reach the app's frame (a key verb focuses it), and `keydown` /
 * `keyup` hold one, as a game is played.
 *
 * What the page cannot say in its text — a canvas, a game's state — it
 * puts on `window.__debug` (a JSON value, or a function returning one),
 * the one debug convention every app shares: the look returns it as
 * `debug`, and `{ do: "debug" }` reads it mid-list into `debugReads`.
 *
 * With `path` and `saveAs`, the shot is also written into the app
 * directory at `saveAs` (a `.png` inside it), for app.yaml's `screenshots`
 * — what the package store shows. A look that drew nothing, could not host
 * the app or stopped on a step saves nothing and says why.
 *
 * Under `app/*`, so the builders, which hold that grant, have it with no
 * browser grant of their own. The chat builder's tools run under no run:
 * the look then takes a browser session and an artifact directory of its
 * own, let go when it is done.
 */
export default defineStep({
  type: "app/look",
  description:
    "LOOK at an app as a person opening it sees it: the strut server's own UI hosts it in a browser, as you, and its page makes its calls through the real host under the app's grants. " +
    "With `path`: the app DIRECTORY you are working on — built (a failing build returns { ok: false, errors } and nothing opens) and looked at WITHOUT publishing anything, so look, fix and look again from the directory, and app/publish once it shows what was asked for. " +
    "With `version` (or neither): a published version — the active one by default; name a held app's draft to see it. " +
    "It opens on the app's first page; `input` opens it where a deep link carrying that input takes a person (the app's own keys, what its useToolInput() reads: { view: \"/runs\" } in the starter template, { run: \"12\" } where the app reads a run). " +
    "`steps` then does what a person would, in the app, in order: { do: click | fill | type | press | keydown | keyup | select | hover | scroll | wait | debug, ...that browser/* step's input }, each target a `selector`, e.g. { do: \"click\", selector: \"text=Agents\" }, { do: \"wait\", text: \"drafter\" }. " +
    "Keys go to the APP: a key step puts focus in the app's frame first (an input you filled or an element you clicked keeps it). `press` taps a key; to HOLD one (a game's run, a jump while running), { do: \"keydown\", key: \"ArrowRight\" }, { do: \"wait\", ms: 500 }, { do: \"keyup\", key: \"ArrowRight\" } — one key a step, no auto-repeat, and a key still held when the list ends or a step fails is let go of. " +
    "A page whose state is not in its text (a canvas, a game) puts what a look should see on `window.__debug` — a JSON value, or a function returning one; { do: \"debug\" } reads it at that point of the list. " +
    "Returns { name, version, rendered, hostError?, stopped?, text, debug?, debugReads?, errors, appErrors, path, url, width, height } — `version` a `preview-…` label for a directory; `rendered`: the page drew something; `hostError`: why the host shows no app; " +
    "`stopped`: the step that failed ({ step, verb, args, message }) — the shot and the text are of where the page got to; `text`: the page's visible text (capped); " +
    "`debug`: `window.__debug` read just after the shot (left out when the page sets none); `debugReads`: each debug step's read, in order, as { step, value } or { step, error } (step = its number in the list); a read is capped at 8,000 chars of JSON, ending in a note when cut, and 2 s; " +
    "`errors`: console errors, page errors, failed or 4xx/5xx requests, and `debug: …` when the last read failed; `appErrors`: what the app's error boundary reported during the look — and, when you are an agent, you SEE the screenshot. " +
    "It runs the page: its reads and writes are real calls, as when a person opens it. " +
    "With `path`, `saveAs` (e.g. \"public/screenshots/home.png\") also writes the shot into the app directory, returned as `saved`; list it under `screenshots:` in app.yaml (a path, or { file, caption }) and the package store shows it. A look that drew nothing, could not host the app or stopped saves nothing (`saveError` says why).",
  input: z.object({
    name: z.string().describe("The app's workspace name."),
    version: z.string().optional().describe("A published version to look at (v1, v2, …). The active (live) version when omitted. Not with `path`."),
    path: z.string().optional().describe("The app directory you are working on, relative to the job's (or run's) directory: built and looked at as `name` without publishing a version."),
    job: z.string().optional().describe("With `path`: another job whose directory it is relative to."),
    input: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("What a deep link to the app carries, e.g. { run: \"12\" }: the app opens where that link takes a person. Its values reach the page as strings."),
    steps: z
      .array(z.looseObject({ do: z.enum(LOOK_VERBS) }))
      .optional()
      .describe("What a person does on the app's page before the shot, in order: each the input of the browser/* step it names plus `do`, a target by `selector`; { do: \"debug\" } reads window.__debug there."),
    wait: z.number().int().min(0).max(30_000).optional().describe("Extra ms to let the page settle before the shot (a chart animating in, a slow first read)."),
    fullPage: z.boolean().optional().describe("The whole scrollable page, not just the 1280×800 viewport."),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .optional()
      .describe("Viewport in CSS pixels, e.g. { width: 390, height: 844 } for a phone; default 1280×800."),
    saveAs: z
      .string()
      .optional()
      .describe("With `path`: also write the shot into the app directory here, a .png inside it (\"public/screenshots/home.png\"), for app.yaml's `screenshots`. Replaces a file already there."),
  })
    .refine((q) => !(q.path && q.version), { message: "app/look takes `path` (a directory, unpublished) or `version` (a published one), not both" })
    .refine((q) => !q.saveAs || q.path, { message: "`saveAs` writes into the app directory you are working on: it needs `path`" })
    .refine((q) => !q.saveAs || !saveAsProblem(q.saveAs), { message: "`saveAs` is a .png path inside the app directory, relative, with no . or .. (\"public/screenshots/home.png\")" }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const apps = requireApps(ctx.services);
    let app: { name: string; version: string };
    let dir: string | undefined;
    if (cfg.path) {
      dir = await resolveAppPath(ctx, cfg.path, cfg.job);
      const preview = await apps.preview(dir, cfg.name, { surface: "ai" });
      if (!preview.ok) return preview;
      app = preview;
    } else {
      const found = await apps.get(cfg.name, cfg.version);
      if (!found) throw new Error(cfg.version ? `App "${cfg.name}" has no version ${cfg.version}` : `App "${cfg.name}" not found`);
      app = found;
    }
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
          ...(cfg.input ? { link: Object.fromEntries(Object.entries(cfg.input).map(([k, v]) => [k, String(v)])) } : {}),
          ...(cfg.steps?.length ? { steps: cfg.steps } : {}),
          ...(cfg.wait !== undefined ? { wait: cfg.wait } : {}),
          ...(cfg.fullPage ? { fullPage: true } : {}),
          ...(cfg.viewport ? { viewport: cfg.viewport } : {}),
        },
        shotSinkOf({ ...ctx, runId }),
      );
      // What the app's error boundary reported while the look had it open.
      const reported = await apps.errorsOf(app.name);
      const appErrors = reported
        .filter((e) => e.version === app.version && e.at >= since)
        .map((e) => ({ message: e.message, ...(e.stack ? { stack: e.stack } : {}), ...(e.componentStack ? { componentStack: e.componentStack } : {}) }));
      const out: Record<string, unknown> = { name: app.name, version: app.version, ...looked, appErrors };
      if (cfg.saveAs && dir) Object.assign(out, await saveShot(join(looked.dir, looked.path), dir, cfg.saveAs, looked));
      return withMedia(out, [{ mediaType: "image/png", data: small, filename: looked.path }]);
    } finally {
      if (!ctx.runId) await browser.dispose(runId);
    }
  },
});

/** Why `saveAs` is not a screenshot path in the app, or nothing. */
function saveAsProblem(file: string): string | undefined {
  return screenshotPathProblem(file) ?? (/\.png$/i.test(file) ? undefined : "the shot is a PNG");
}

/** Why a look's shot is not worth keeping as a screenshot, or nothing. */
export function shotProblem(looked: { rendered: boolean; hostError?: string; stopped?: { message: string } }): string | undefined {
  return looked.hostError
    ? `the host could not show the app (${looked.hostError})`
    : looked.stopped
      ? `the look stopped on a step (${looked.stopped.message})`
      : !looked.rendered
        ? "the page drew nothing"
        : undefined;
}

/** The shot into the app directory, unless the look shows nothing worth keeping. */
export async function saveShot(
  from: string,
  dir: string,
  saveAs: string,
  looked: { rendered: boolean; hostError?: string; stopped?: { message: string } },
): Promise<{ saved: string; warning?: string } | { saveError: string }> {
  const why = shotProblem(looked);
  if (why) return { saveError: `not saved: ${why}` };
  const to = join(dir, saveAs);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  const size = (await stat(to)).size;
  return size > SCREENSHOT_MAX_BYTES
    ? { saved: saveAs, warning: `${(size / 1e6).toFixed(1)} MB: a screenshot app.yaml lists is at most ${SCREENSHOT_MAX_BYTES / 1024 / 1024} MB — look again without fullPage, or at a smaller viewport` }
    : { saved: saveAs };
}
