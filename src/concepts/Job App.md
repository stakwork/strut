---
description: "Hand over an interactive app as a deliverable — when the ask is for a tracker, dashboard or tool over this job's own results that the person will use, not just read. An app to publish in a workspace, or on another strut, is a Workflow Build."
parent: Job
---
Hand over an interactive APP as a deliverable — when the person wants
something to USE, not just read: a tracker over a spreadsheet they gave
you, a dashboard over a workflow's runs, a small form.

- Build it in YOUR directory, by convention `apps/<name>/`: `app/init {
  path }` starts one, then edit its files.
- Run `app/build { path }` and fix every error BEFORE you hand it over, as
  you verify before you say done. The person sees the page the last build
  wrote: a stale `dist/` is what a stale screenshot is. The result also
  carries `clientErrors`, what the page reported since; `app/get { path }`
  reads the app back (`stale` when its files moved since the build).
- List it in the reply's `artifacts` as `{ id, kind: "app", title, path:
  "apps/<name>" }`. The same `id` on a later turn is a newer version of
  it, and the person's view reloads when you build it again.
- What it sees: THIS job's runs and files — `run/list { job }`, any run of
  the job, `run/files { job, path }`, `job/get`, `job/read` — with no
  grant, and nothing of another job. Every one of these names the job: in
  the page, `useApp()` from `@strut/kit` is `{ job, path }` — pass that
  `job` (`useRuns(null, { job })`). Beyond that, the workflows and steps
  its `app.yaml` grants, under the usual rules: never `llm`, `agent`,
  `exec` or anything sealed (the build refuses them).
- You never publish it. Promoting it to the workspace is the person's
  "Publish as an app" click, or a builder job on request.

For HOW to build one — the layout, the kit and its hooks, the grants,
routines — open the `App` page.
