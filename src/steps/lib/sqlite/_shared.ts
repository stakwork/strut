import { z } from "zod";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { AppDatabase } from "../../../apps/sqlite.js";
import { requireApps } from "../app/_shared.js";

/**
 * The `sqlite/*` steps are thin over an app's own SQLite file
 * (`src/apps/sqlite.ts`, plans/apps.md §4.4), reached through the apps
 * capability. WHICH file is `ctx.app`'s: a page's call through `step_run`,
 * and every step of a run the app launched. A step with no `ctx.app` — an
 * agent granted `sqlite/*`, a workflow outside the app — names it with
 * `app`, which is REFUSED when `ctx.app` is set, so a page never names
 * another app's file.
 */
export const appField = z
  .string()
  .optional()
  .describe("The app whose database to use, by name (app/list) — only outside the app: a page, and a run the app launched, use the app's own and may not name one.");

export const paramsField = z
  .union([z.array(z.any()), z.record(z.string(), z.any())])
  .optional()
  .describe("Values for the statement's ? (a list) or :name (an object). A boolean binds as 1 / 0, { base64 } as bytes, any other object or list as JSON text.");

export async function appDatabase(ctx: StepContext<StrutCapabilities>, step: string, app: string | undefined): Promise<AppDatabase> {
  const own = ctx.app?.name;
  if (own && app !== undefined && app !== own) {
    throw new Error(`${step}: \`app\` is refused here — this call works for the app ${own}, and an app uses only its own database`);
  }
  const name = own ?? app;
  if (!name) throw new Error(`${step}: name the app whose database to use (\`app\`) — only an app's own page or runs use theirs without naming it`);
  return requireApps(ctx.services).database(name);
}
