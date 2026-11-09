// Home sync (peel docs/always-on.md, "two normal struts"). The box's side:
// what a home box serves a strut that keeps a read copy of its memory (a
// Mac's). Two routes, on only where the host asks (`createStrut({ homeSync:
// "box" })`, STRUT_HOME_SYNC=box), for a person's credential only:
//
//   POST /home/pull { hash? }       { content_hash, memory }: the memory part
//                                   of the workspace graph (home/_memory.ts),
//                                   or { unchanged, content_hash } when the
//                                   caller's copy is still current
//   POST /home/push { dictation? }  what the copy changed, replayed here
//                                   (dictation/apply-changes); one key per kind
//
// The copy's side (STRUT_HOME_SYNC=copy) is the `home-sync` workflow, one
// step, home/sync, which calls these two through its peer record.
//
// Routes, not workflows: a run's input and output are kept in the run store,
// which every peer scope may read, so the whole memory there would
// outlive the pull and reach other credentials. A route answers its caller
// and keeps nothing.
import { readFile } from "node:fs/promises";
import type { Context, Hono } from "hono";
import type { Scope } from "./auth.js";
import type { StepContext } from "./core.js";
import type { WorkspaceStore } from "./workspace.js";
import applyChanges from "./steps/lib/dictation/apply-changes.js";
import { dictationGraph, exclusive } from "./steps/lib/dictation/_graph.js";
import { readMemory } from "./steps/lib/home/_memory.js";

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
  // `peer:person` alone: not the peer key, not the deployment key, and not a
  // request with no credential, which a strut with no STRUT_API_KEY lets
  // through its gate as `full`.
  const refuse = async (c: Context) =>
    (await deps.scopeOf(c)) === "peer:person" ? null : c.json({ error: "forbidden: home sync takes a person's credential (a person token)" }, 403);
  const noStore = (c: Context) => c.header("cache-control", "no-store");

  app.post("/home/pull", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const body = await c.req.json<{ hash?: unknown }>().catch(() => ({}) as { hash?: unknown });
    if (body.hash !== undefined && typeof body.hash !== "string") return c.json({ error: "hash must be a string" }, 400);
    try {
      // Read in dictation's writes' queue, as its changes are: no dictation write is half in it.
      const b = await dictationGraph(ctx);
      const { memory, content_hash } = await exclusive(b, () => readMemory(b));
      noStore(c);
      return c.json(body.hash === content_hash ? { unchanged: true, content_hash } : { content_hash, memory });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
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

/** The workflow the copy runs. */
export const HOME_SYNC_WORKFLOW = "home-sync";

/** The copy's side (STRUT_HOME_SYNC=copy): the `home-sync` workflow, seeded
 *  by content hash like strut's other shipped workflows. */
export async function seedHomeSyncWorkflow(workspace: WorkspaceStore): Promise<{ version: string; changed: boolean }> {
  const text = await readFile(new URL("./workflows/home-sync.yaml", import.meta.url), "utf-8");
  return workspace.publishWorkflowByContent(
    HOME_SYNC_WORKFLOW,
    text,
    "Syncs this strut server's read copy of its home's memory with the home (a peer, default \"home\"): pushes dictation's changes, " +
      "pulls the memory when it changed and puts it in place of this one's, keeping what dictation changes meanwhile. Input { peer? }.",
    "home",
    undefined,
    { source: "seed" },
  );
}
