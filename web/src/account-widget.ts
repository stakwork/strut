// ── The account widget's pure logic ────────────────────────────────────────
// Strut draws a small account widget over a visitor's app, outside its frame
// (components/AccountWidget.tsx). Where it sits comes from `app.yaml`'s
// `account:` (build.json / `GET /public/apps/:name`), and the app may move or
// collapse it at run time (`strut/account/placement`, ./app-host). This module
// is what decides: it validates an app's request, rate-limits it, and holds
// the one state the widget draws. That state is only a corner and a
// `collapsed` flag — there is no value in it that hides the widget, so no
// message can; a collapsed widget is a handle that stays visible.
import { formats, type FiatRate, type Formats } from "@strut/kit/folds";
import { ACCOUNT_CORNERS, type AccountCorner, type AccountPlacement } from "@strut/kit/visitor";
import { defaultMaxFeeMsat } from "../../src/payments/fee.js";
import { HOST_WORDS, type HostWords } from "./words";

export interface AccountState {
  corner: AccountCorner;
  collapsed: boolean;
}

/** What `app.yaml`'s `account:` came to (manifest defaults applied). */
export interface AccountDefault {
  corner?: string;
  style?: string;
}

/** At most one applied change per this many ms. */
export const PLACEMENT_INTERVAL_MS = 500;

const isCorner = (c: unknown): c is AccountCorner => typeof c === "string" && (ACCOUNT_CORNERS as readonly string[]).includes(c);

/** The state before the app says anything: its declared corner (top-right)
 *  and style (`handle` starts collapsed; `pill`, the default, does not). A
 *  value this host does not know falls back to the default. */
export function initialState(declared?: AccountDefault | null): AccountState {
  return { corner: isCorner(declared?.corner) ? declared.corner : "top-right", collapsed: declared?.style === "handle" };
}

/** An app's `strut/account/placement` params: `{ corner?, collapsed? }`
 *  and nothing else. */
export function parsePlacement(params: unknown): { ok: true; placement: AccountPlacement } | { ok: false; error: string } {
  if (params === undefined || params === null) return { ok: true, placement: {} };
  if (typeof params !== "object" || Array.isArray(params)) return { ok: false, error: "placement: params must be an object { corner?, collapsed? }" };
  const p = params as Record<string, unknown>;
  for (const k of Object.keys(p)) if (k !== "corner" && k !== "collapsed") return { ok: false, error: `placement: unknown field "${k}" (only corner and collapsed)` };
  const placement: AccountPlacement = {};
  if (p["corner"] !== undefined) {
    if (!isCorner(p["corner"])) return { ok: false, error: `placement: unknown corner ${JSON.stringify(p["corner"])} (one of ${ACCOUNT_CORNERS.join(", ")})` };
    placement.corner = p["corner"];
  }
  if (p["collapsed"] !== undefined) {
    if (typeof p["collapsed"] !== "boolean") return { ok: false, error: "placement: collapsed must be true or false" };
    placement.collapsed = p["collapsed"];
  }
  return { ok: true, placement };
}

export interface PlacementController {
  /** What the widget draws now. */
  state(): AccountState;
  /** The app's request (already parsed). Applied at once when the last
   *  applied change is older than the interval; otherwise held, merged with
   *  any held one so the latest wins, and applied when the interval is up.
   *  Returns the state it will show. */
  request(placement: AccountPlacement): AccountState;
  /** The visitor's own click: applied at once, and any held app change is dropped. */
  user(collapsed: boolean): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface ControllerOptions {
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export function createPlacementController(initial: AccountState, o: ControllerOptions = {}): PlacementController {
  const interval = o.intervalMs ?? PLACEMENT_INTERVAL_MS;
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let shown: AccountState = { ...initial };
  let pending: AccountState | null = null;
  let timer: unknown;
  let last = -Infinity;
  const same = (a: AccountState, b: AccountState) => a.corner === b.corner && a.collapsed === b.collapsed;
  const drop = () => {
    pending = null;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const apply = (s: AccountState) => {
    if (same(s, shown)) return;
    shown = { ...s };
    last = now();
    for (const l of [...listeners]) l();
  };
  return {
    state: () => shown,
    request(placement) {
      const base = pending ?? shown;
      const target: AccountState = { corner: placement.corner ?? base.corner, collapsed: placement.collapsed ?? base.collapsed };
      if (same(target, shown)) {
        drop();
        return shown;
      }
      const wait = last + interval - now();
      if (wait <= 0) {
        drop();
        apply(target);
        return shown;
      }
      pending = target;
      timer ??= setTimer(() => {
        timer = undefined;
        const t = pending;
        pending = null;
        if (t) apply(t);
      }, wait);
      return target;
    },
    user(collapsed) {
      drop();
      apply({ ...shown, collapsed });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      drop();
      listeners.clear();
    },
  };
}

// ── What the panel shows ───────────────────────────────────────────────────

/** The app's identity in its served document (`<meta name="strut-app-token">`),
 *  which `step_run`'s `app` argument is: how the host calls a step as the
 *  app's viewer. */
export function appIdentityOf(html: string): string | undefined {
  return metaOf(html, "strut-app-token");
}

/** The strut server's name the document was served with (its brand's
 *  `name`, `<meta name="strut-name">`, src/apps/build.ts): who a visitor
 *  signs in to and pays — the employer — whichever app of it they opened. */
export function serverNameOf(html: string): string | undefined {
  return metaOf(html, "strut-name")?.trim() || undefined;
}

function metaOf(html: string, name: string): string | undefined {
  const m = new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html);
  return m ? m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&") : undefined;
}

/** What `GET /public/credit` answers, when it is credit. */
export interface CreditView {
  usd: number;
  sats: number;
}
export function creditOf(status: number, body: unknown): CreditView | null {
  const b = body as { remaining_usd?: unknown; remaining_sats?: unknown } | null;
  if (status !== 200 || !b || typeof b.remaining_usd !== "number") return null;
  return { usd: b.remaining_usd, sats: typeof b.remaining_sats === "number" ? b.remaining_sats : 0 };
}

/** What `task/me` says of a worker, as the panel shows it; null when the
 *  answer is not a worker's (the section stays hidden). */
export interface WorkerView {
  heldMsat: number;
  withdrawableMsat: number;
  /** The most one withdrawal may ask now (0: none). */
  maxMsat: number;
  canWithdraw: boolean;
  /** The exchange rate `task/me` carries, to show fiat beside sats; absent when none can be read. */
  rate?: FiatRate;
  /** Why there is no Withdraw while something is withdrawable or on its
   *  way, said for the worker; absent when they may withdraw or have
   *  nothing to. */
  blocked?: string;
}
type PayoutRead = { on?: unknown; why?: unknown; minMsat?: unknown; dayLeftMsat?: unknown; maxMsat?: unknown; out?: { msat?: unknown } };
export function workerOf(me: unknown, w: HostWords = HOST_WORDS.en, f: Formats = formats("en-US")): WorkerView | null {
  const m = me as { balance?: { heldMsat?: unknown; withdrawableMsat?: unknown }; payout?: PayoutRead; rate?: { perBtc?: unknown } } | null;
  const held = m?.balance?.heldMsat;
  const free = m?.balance?.withdrawableMsat;
  if (typeof held !== "number" || typeof free !== "number") return null;
  const max = typeof m?.payout?.maxMsat === "number" ? m.payout.maxMsat : 0;
  const canWithdraw = m?.payout?.on === true && max > 0;
  const blocked = canWithdraw ? undefined : withdrawBlocked(free, m?.payout, w, f);
  const perBtc = m?.rate?.perBtc;
  const rate = perBtc && typeof perBtc === "object" ? { perBtc: perBtc as Record<string, number> } : undefined;
  return { heldMsat: held, withdrawableMsat: free, maxMsat: max, canWithdraw, ...(rate ? { rate } : {}), ...(blocked ? { blocked } : {}) };
}

/** Why `task/me`'s payout offers no withdrawal (src/payments/payouts.ts
 *  `view`): a payout out, its `why`, or — open, `maxMsat` 0 — the day's cap
 *  or the minimum. The minimum is said with the routing fee the worker pays
 *  on top (src/payments/fee.ts), as `payoutMaxMsat` counts it. */
function withdrawBlocked(freeMsat: number, p: PayoutRead | undefined, w: HostWords, f: Formats): string | undefined {
  if (!p) return undefined;
  const out = typeof p.out?.msat === "number" ? p.out.msat : undefined;
  if (out !== undefined) return w.onTheWay(f.sats(out));
  if (freeMsat <= 0) return undefined;
  switch (p.why) {
    case "no_address": return w.noAddress;
    case "off": return w.payoutsOff;
    case "no_wallet":
    case "no_keysend": return w.cannotPay;
    case "not_here": return w.noPayouts;
  }
  if (p.on !== true) return undefined;
  const minMsat = typeof p.minMsat === "number" ? p.minMsat : 0;
  if (typeof p.dayLeftMsat === "number" && p.dayLeftMsat < minMsat) return w.dayLimit;
  const feeMsat = defaultMaxFeeMsat(minMsat);
  if (freeMsat < minMsat + feeMsat) return w.belowMin(f.sats(minMsat), f.sats(feeMsat));
  return w.paused;
}
