/**
 * The Automations flyout's HTTP door (plans/automations.md §7). A thin layer:
 * every rule — validation, defaults, the schedule refresh — lives in
 * `scheduler.ts`, shared with the chat tools. Mutations and `fire` sit
 * behind `requireApiKey` (permissive in dev): an automation launches
 * unattended runs with the deployment's secrets.
 */
import type { Context, Hono } from "hono";
import { requireApiKey } from "./auth.js";
import type { Automations } from "./scheduler.js";

export interface AutomationsRoutesOptions {
  /** Scheduling is an edit: an ownerless workflow is adopted by the actor
   *  who schedules it, since its scheduled runs are billed to the owner
   *  (plans/mothership-cost-control.md §2). Called before create / update. */
  adopt?: (workflow: string, c: Context) => Promise<void>;
}

export function automationsRoutes(app: Hono, automations: Automations, opts: AutomationsRoutesOptions = {}): void {
  const body = (c: Context) => c.req.json().catch(() => null) as Promise<unknown>;
  /** Policy results are `{ ok, … } | { error }` — an error is the caller's to fix. */
  const reply = (c: Context, result: object, okStatus: 200 | 201 | 202 = 200) =>
    c.json(result, "error" in result ? (/not found/.test(String(result.error)) ? 404 : 400) : okStatus);
  const wf = (c: Context) => c.req.param("name") ?? "";
  const id = (c: Context) => c.req.param("id") ?? "";

  // Every automation, or one workflow's (`?workflow=`) — what the flyout reads.
  app.get("/automations", async (c) => c.json({ automations: await automations.list(c.req.query("workflow") || undefined) }));

  // The form's live preview: one implementation of the calendar math, here.
  app.post("/automations/preview", async (c) => {
    const b = (await body(c)) as { trigger?: unknown } | null;
    return reply(c, automations.preview(b?.trigger));
  });

  app.post("/workflows/:name/automations", requireApiKey, async (c) => {
    await opts.adopt?.(wf(c), c);
    return reply(c, await automations.create(wf(c), await body(c)), 201);
  });
  app.patch("/workflows/:name/automations/:id", requireApiKey, async (c) => {
    await opts.adopt?.(wf(c), c);
    return reply(c, await automations.update(wf(c), id(c), await body(c)));
  });
  app.delete("/workflows/:name/automations/:id", requireApiKey, async (c) => reply(c, await automations.remove(wf(c), id(c))));

  // Run now. A skip (previous run still in flight) is a 409, not a bad request.
  app.post("/workflows/:name/automations/:id/fire", requireApiKey, async (c) => {
    const result = await automations.fire(wf(c), id(c));
    if ("error" in result && result.error.startsWith("skipped:")) return c.json(result, 409);
    return reply(c, result, 202);
  });
}
