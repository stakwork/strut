/**
 * The ADMIN DOORS strut's own admin apps go through (specs/API.md §14.14):
 * `earnings/*` for `strut/earnings`, `staff/*` for `strut/staff`
 * (plans/human-steps.md §9.3). Each door is one request to its own routes,
 * in process and in the viewer's own name (createStrut's admin doors, auth.ts
 * `inProcessRequest`), so what the app does is what the route does, checked
 * and recorded the same way (a grant's `by`, a type's `changedBy`, a
 * withdrawal's actor).
 *
 * A door is never on the shared services bag: the app door hands it to the
 * bag of ONE call, a first-party page's shown to an ADMIN (src/apps/tools.ts
 * `adminServices`). So these steps run for strut's own admin pages in front
 * of an admin, and nowhere else — not a workflow, an agent's tool, a
 * model-written page or a member's.
 */
import { isFirstParty, type StepContext } from "../../core.js";

export interface DoorAnswer {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export interface AdminDoor {
  /** One request to one of the door's routes. A `Uint8Array` body is sent
   *  as the raw bytes, anything else as JSON. */
  call(method: string, path: string, body?: unknown, actor?: string): Promise<DoorAnswer>;
}

/** The door `key` on this call's bag, or why this call may not use it:
 *  only strut's own page (`page`) shown to an admin of this server. */
export function adminDoorOf(ctx: StepContext | undefined, type: string, key: string, page: string): AdminDoor {
  const app = ctx?.app;
  if (!app || !isFirstParty(app) || app.admin !== true) {
    throw new Error(`${type} is an admin's: only strut's own ${page} page, shown to an admin of this server, may call it (specs/API.md §14.14)`);
  }
  const door = (ctx?.services as Record<string, AdminDoor | undefined> | undefined)?.[key];
  if (!door) throw new Error(`${type}: strut's ${page.toLowerCase()} door is not on this call (only strut's own app door hands it to an admin's page)`);
  return door;
}

/** A door that reaches the routes `reaches` matches and no other path: one
 *  request each, sent in process through `send` in the viewer's name
 *  (createStrut: `app.fetch(inProcessRequest(req, actor))`). A `Uint8Array`
 *  body goes as the raw bytes (a test's file), anything else as JSON. */
export function inProcessDoor(send: (req: Request, actor?: string) => Promise<Response>, reaches: RegExp, what: string): AdminDoor {
  return Object.freeze({
    call: async (method: string, path: string, body?: unknown, actor?: string) => {
      if (!reaches.test(path)) throw new Error(`the ${what} door reaches its own routes alone, not ${path}`);
      const raw = body instanceof Uint8Array;
      const req = new Request(`http://strut.invalid${path}`, {
        method,
        headers: { "content-type": raw ? "application/octet-stream" : "application/json", "x-strut-ui": "1" },
        ...(body === undefined ? {} : { body: raw ? new Uint8Array(body as Uint8Array) : JSON.stringify(body) }),
      });
      const res = await send(req, actor);
      return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
  });
}

/** What the `staff/*` door reaches (plans/human-steps.md §9.3): `/tasks…` alone. */
export const STAFF_ROUTES = /^\/tasks(\/|\?|$)/;
/** What the `earnings/*` door reaches: `/earnings…`, `/remote/credit`, `/remote/purchases`. */
export const EARNINGS_ROUTES = /^\/(earnings|remote\/credit|remote\/purchases)(\/|\?|$)/;

/** A route's answer, or its refusal as an error (its `code` first). */
export function bodyOrThrow(a: DoorAnswer): Record<string, unknown> {
  if (a.ok) return a.body;
  const code = typeof a.body["code"] === "string" ? `${a.body["code"]}: ` : "";
  throw new Error(`${code}${String(a.body["error"] ?? `HTTP ${a.status}`).replace(/^[a-z_]+: /, "")}`);
}
