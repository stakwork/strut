/**
 * The STAFF's door (plans/human-steps.md §9.3): the `/tasks…` routes as
 * an in-process request in the admin's own name, for the `staff/*` steps
 * strut's own staff app (`strut/staff`) calls. The check and the door are
 * `../_admin-door.ts`'s, shared with `earnings/*`: only a first-party page
 * shown to an admin of this server, never a workflow, an agent's tool, a
 * model-written page or a member's. A route's refusal is the step's error,
 * its `code` first.
 *
 * A test's expected answer and a grader's note pass through here and no
 * further: the steps that carry one are reads (never kept as a run) or
 * list `expected` in `redact`, and the app door keeps none of them
 * (`keptFromApp`, src/apps/tools.ts).
 */
import type { StepContext } from "../../../core.js";
import { adminDoorOf, bodyOrThrow } from "../_admin-door.js";

/** One `/tasks…` route through the door: its answer, or its refusal thrown. */
export async function staffCall(ctx: StepContext | undefined, type: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const door = adminDoorOf(ctx, type, "staffAdmin", "staff");
  return bodyOrThrow(await door.call(method, path, body, ctx?.actor));
}

/** A name as one path segment (a type `acme/pet-match` is `acme%2Fpet-match`). */
export const seg = (s: string): string => encodeURIComponent(s);

/** A query string of the values given, `?` first; "" for none. */
export function query(q: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** A file's path as the routes take it: each segment encoded. */
export const pathSegs = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
