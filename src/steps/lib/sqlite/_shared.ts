import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { AppsCapability } from "../../../apps/apps.js";
import { stripSql, type BatchStatement, type SqlParams } from "../../../apps/data.js";

/**
 * The `sqlite/*` steps (plans/apps.md §4.4) run SQL on an APP's own database
 * (src/apps/data.ts, `ctx.services.appDb`). WHICH one: `ctx.app`'s — a
 * page's `step_run`, a host's call of the app's tools, a run the app
 * launched — and then naming one (`app`) is refused, so a page never
 * reaches another app's file. With no `ctx.app` (a workflow of its own, an
 * agent granted `sqlite/*`), `app` names an app that exists.
 */
export async function appDatabase(ctx: StepContext<StrutCapabilities> | undefined, app: string | undefined, type: string): Promise<DatabaseSync> {
  const services = ctx?.services as (Partial<StrutCapabilities> & { apps?: AppsCapability }) | undefined;
  const dbs = services?.appDb;
  if (!dbs) throw new Error(`${type} needs the apps' databases (ctx.services.appDb): the standard strut server provides them`);
  if (ctx?.app) {
    if (app !== undefined) {
      throw new Error(`${type}: \`app\` names a database, and this call runs for the app ${ctx.app.name}, which reaches its own alone — drop \`app\` (plans/apps.md §4.4)`);
    }
    return dbs.open(ctx.app.name);
  }
  if (!app) throw new Error(`${type} needs \`app\`, the app whose database it runs on (from an app's page or a run it launched, that app's own)`);
  if (services?.apps && !(await services.apps.manifestOf(app).catch(() => null))) throw new Error(`${type}: no app "${app}" on this strut server`);
  return dbs.open(app);
}

export const paramsSchema = z
  .union([z.array(z.any()), z.record(z.string(), z.any())])
  .optional()
  .describe("Values the statement names: a list for `?`, an object for `:name` / `@name` / `$name`. A boolean is 1 or 0, `{ base64 }` a blob, any other object or list its JSON text. `:actor` is strut's: the caller's own actor (a page's viewer).");

export const appSchema = z
  .string()
  .min(1)
  .optional()
  .describe("The app whose database this is — only where the call is not for an app already (a workflow of its own, an agent): an app's page and the runs it launched reach their own, and naming one is refused there.");

/** A statement naming `:actor` (`@actor`, `$actor`) gets the CALLER's own
 *  actor there, bound by strut: a page's viewer, the person a host's call is
 *  for, a run's actor; NULL with none. So a page writes and reads "mine"
 *  (`assignee = :actor`) without being told who its viewer is. A value the
 *  caller names `actor` is replaced; its other values go by name too. */
export function withActor(sql: string, params: SqlParams | undefined, actor: string | undefined): SqlParams | undefined {
  if (!/[:@$]actor\b/.test(stripSql(sql))) return params;
  if (Array.isArray(params)) throw new Error("a statement that names :actor takes its other values by name too (:name, in an object), not as a list");
  return { ...(params ?? {}), actor: actor ?? null };
}

/** A batch's statements, each with `:actor` bound (`withActor`). */
export function batchWithActor(statements: readonly BatchStatement[], actor: string | undefined): BatchStatement[] {
  return statements.map((s) => {
    const sql = typeof s === "string" ? s : s.sql;
    const params = withActor(sql, typeof s === "string" ? undefined : s.params, actor);
    return params === undefined ? sql : { sql, params };
  });
}
