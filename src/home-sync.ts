// Home sync, the box's side (peel docs/always-on.md, "two normal struts"):
// what a home box serves a strut that keeps a read copy of its memory (a
// Mac's). Two routes, on only where the host asks (`createStrut({ homeSync:
// "box" })`, STRUT_HOME_SYNC=box), for a person's credential only:
//
//   POST /home/pull { hash? }       the whole memory (memory/export, inline),
//                                   or { unchanged, content_hash } when the
//                                   caller's copy is still current
//   POST /home/push { dictation? }  what the copy changed, replayed here
//                                   (dictation/apply-changes); one key per kind
//
// Routes, not workflows: a run's input and output are kept in the run store,
// which every peer scope may read, so a whole-memory export there would
// outlive the pull and reach other credentials. A route answers its caller
// and keeps nothing.
import type { Context, Hono } from "hono";
import type { Scope } from "./auth.js";
import type { StepContext } from "./core.js";
import exportStep from "./steps/lib/memory/export.js";
import applyChanges from "./steps/lib/dictation/apply-changes.js";

export type HomeSyncRole = "box" | "copy";

/** STRUT_HOME_SYNC: `box` serves the routes below; `copy` runs home-sync. */
export function homeSyncRole(value: string | undefined): HomeSyncRole | undefined {
  return value === "box" || value === "copy" ? value : undefined;
}

/** The POSTs a person's credential may make here (createStrut's gate). */
export const HOME_POSTS = new Set(["/home/pull", "/home/push"]);

/** The most changes one push carries: a long time away is still far less. */
const MAX_CHANGES = 10_000;

export function homeSyncRoutes(app: Hono, deps: { services: unknown; scopeOf: (c: Context) => Promise<Scope> }): void {
  const ctx = { services: deps.services } as unknown as StepContext;
  const refuse = async (c: Context) =>
    (await deps.scopeOf(c)) === "peer" ? c.json({ error: "forbidden: home sync takes a person's credential (a person token), not a strut's peer key" }, 403) : null;
  const noStore = (c: Context) => c.header("cache-control", "no-store");

  app.post("/home/pull", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const body = await c.req.json<{ hash?: unknown }>().catch(() => ({}) as { hash?: unknown });
    if (body.hash !== undefined && typeof body.hash !== "string") return c.json({ error: "hash must be a string" }, 400);
    const out = await exportStep.run({ inline: true, ...(body.hash ? { if_changed: body.hash } : {}) }, ctx);
    noStore(c);
    return c.json(out, out?.error ? 500 : 200);
  });

  app.post("/home/push", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const body = await c.req.json<{ dictation?: unknown }>().catch(() => ({}) as { dictation?: unknown });
    if (Array.isArray(body.dictation) && body.dictation.length > MAX_CHANGES) return c.json({ error: `dictation: at most ${MAX_CHANGES} changes a push` }, 400);
    const parsed = applyChanges.input.safeParse({ changes: body.dictation ?? [] });
    if (!parsed.success) return c.json({ error: `dictation: ${parsed.error.issues[0]?.message}` }, 400);
    try {
      const dictation = await applyChanges.run(parsed.data, ctx);
      noStore(c);
      return c.json({ dictation });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
