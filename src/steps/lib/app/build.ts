import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { jobFileUrl } from "../../../artifact-refs.js";
import { DOCUMENT_FILE } from "../../../apps/build.js";
import { jobAppOf, requireApps, resolveAppPath } from "./_shared.js";

/**
 * Build an app directory in place. In a JOB's directory (plans/apps.md §6)
 * the directory is a job's app: nothing publishes it, so its grants are
 * checked under the meta surface's rules here, the result carries the
 * page's latest client errors (`clientErrors`), and the job's host hears
 * `job.update { kind: "app" }` — the document's link, its build hash — and
 * reloads its frame.
 */
export default defineStep({
  type: "app/build",
  description:
    "Build an app directory in place (plans/apps.md §2): writes dist/index.html — one self-contained document, the kit's bootstrap and the app's bundle, Tailwind compiled — and dist/build.json. " +
    "Returns { ok: true, hash, bytes, warnings } or { ok: false, errors, warnings }: the errors name the file and line — an import outside the kit and the installed apps, one that leaves the directory, " +
    "dangerouslySetInnerHTML / eval / new Function, a bad app.yaml, a grant naming a workflow that does not exist; a global fetch is a warning naming the hook to use (useStep, useLaunch). " +
    "Fix and build again; nothing is published. In a job's directory the app is a JOB's app — the person sees it once you list { kind: \"app\", path } in your artifacts: its grants may not name llm, agent, exec or anything sealed, " +
    "and the result's `clientErrors` are what its page reported since (read them after the person says it broke).",
  input: z.object({
    path: z.string().describe("The app directory, relative to the job's (or run's) directory."),
    name: z.string().optional().describe("The app's workspace name, when it has one — an imported kit that imports it back is then a cycle the build names."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const dir = await resolveAppPath(ctx, cfg.path);
    const apps = requireApps(ctx.services);
    const app = jobAppOf(ctx, dir);
    const built = await apps.build(dir, { ...(cfg.name ? { name: cfg.name } : {}), ...(app ? { surface: "ai" as const } : {}) });
    if (!app) return built;
    ctx.services?.jobs?.notify?.(app.job, {
      kind: "app",
      id: app.path,
      url: jobFileUrl(app.job, `${app.path}/${DOCUMENT_FILE}`),
      state: built.ok ? "built" : "failed",
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(built.ok ? { title: built.manifest.title } : {}),
      detail: built.ok ? { path: app.path, hash: built.hash, bytes: built.bytes } : { path: app.path, errors: built.errors.length },
    });
    return { ...built, clientErrors: await apps.errorsOf(app) };
  },
});
