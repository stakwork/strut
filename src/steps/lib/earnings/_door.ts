/**
 * The ADMIN DOOR the `earnings/*` steps go through (plans/paid-runs.md §8–§10,
 * specs/API.md §14.14): `GET /earnings/wallet`, Add sats, Withdraw, the
 * sends still out, the credit bought at other struts — the routes as they
 * are, as an in-process request in the viewer's own name (createStrut's
 * `earningsAdminDoor`, auth.ts `inProcessRequest`), so a payment the app
 * makes is the one the route makes, checked and booked the same way.
 *
 * The door is never on the shared services bag: the app door hands it to
 * the bag of ONE call, a first-party page's shown to an ADMIN (src/apps/tools.ts
 * `adminServices`). So these steps run for strut's own Earnings app
 * (`strut/earnings`) in front of an admin, and nowhere else — not a
 * workflow, an agent's tool, a model-written page or a member's.
 */
import { isFirstParty, type StepContext } from "../../../core.js";

export interface DoorAnswer {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export interface EarningsAdminDoor {
  /** One request to an `/earnings…` or `/remote/credit`, `/remote/purchases` route. */
  call(method: string, path: string, body?: unknown, actor?: string): Promise<DoorAnswer>;
}

/** The door, or why this call may not use it. */
export function adminDoor(ctx: StepContext | undefined, type: string): EarningsAdminDoor {
  const app = ctx?.app;
  if (!app || !isFirstParty(app) || app.admin !== true) {
    throw new Error(`${type} is an admin's: only strut's own Earnings page, shown to an admin of this server, may call it (specs/API.md §14.14)`);
  }
  const door = (ctx?.services as { earningsAdmin?: EarningsAdminDoor } | undefined)?.earningsAdmin;
  if (!door) throw new Error(`${type}: strut's earnings door is not on this call (only strut's own app door hands it to an admin's page)`);
  return door;
}

/** A route's answer, or its refusal as an error (its `code` first). */
export function bodyOrThrow(a: DoorAnswer): Record<string, unknown> {
  if (a.ok) return a.body;
  const code = typeof a.body["code"] === "string" ? `${a.body["code"]}: ` : "";
  throw new Error(`${code}${String(a.body["error"] ?? `HTTP ${a.status}`).replace(/^[a-z_]+: /, "")}`);
}

/** A payment's answer as the Withdraw dialog reads it: `{ ok: true, … }`, or
 *  the refusal with its codes, never thrown — what was refused is the
 *  dialog's to say (kit `withdrawRefusal`). */
export function paymentAnswer(a: DoorAnswer): Record<string, unknown> {
  if (a.ok) return { ok: true, ...a.body };
  return {
    ok: false,
    status: a.status,
    error: String(a.body["error"] ?? `HTTP ${a.status}`),
    ...(a.body["code"] ? { code: String(a.body["code"]) } : {}),
    ...(a.body["walletCode"] ? { walletCode: String(a.body["walletCode"]) } : {}),
  };
}

export const PAYMENT_HASH = /^[0-9a-fA-F]{64}$/;
