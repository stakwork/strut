/** The VISITOR contract between an app page and its host
 *  (plans/app-repos.md §5): signing a visitor in to a public app. The page
 *  never sees a key — it asks its host to sign the visitor in, and the host
 *  draws the sheet, signs strut's challenge with the key the visitor picks,
 *  and holds the session. No React, no DOM, no dependency. */

/** What a host puts in `ui/initialize`'s `hostCapabilities.experimental`
 *  when its page may sign a visitor in: the methods offered, and the actor
 *  signed in now, if any. */
export const VISITOR_CAPABILITY = "strut/visitor";
/** Page → host: draw the sign-in sheet; answers `{ actor }`, or `{}` when
 *  the visitor closed it. Params `{ silent: true }` (`SignInOptions`): sign
 *  in only if it takes nothing of the person — the wallet the host runs in
 *  already lets this page sign them in (Peel: a grant it holds) — and else
 *  answer `{}` with no sheet. A host that does not know `silent` draws the
 *  sheet as before. */
export const VISITOR_SIGN_IN_METHOD = "strut/visitor/sign-in";

/** How a page asks to sign the visitor in. */
export interface SignInOptions {
  /** Nothing drawn, nothing asked: signed in only when nobody has to say
   *  yes now. What a page does as it loads; its own button asks plainly. */
  silent?: boolean;
}
/** Page → host: sign the visitor out; answers `{}`. */
export const VISITOR_SIGN_OUT_METHOD = "strut/visitor/sign-out";

/** The sign-ins strut knows (src/visitors.ts): a browser key, a host that
 *  vouches, LNURL-auth by QR, a Nostr extension, the person's Sphinx
 *  account through the wallet that holds it. */
export type VisitorMethod = "key" | "ticket" | "lnurl" | "nostr" | "sphinx";

export interface VisitorCapability {
  v: 1;
  /** Who is signed in when the page starts. */
  actor?: string;
  /** What the host's sheet offers. */
  methods: VisitorMethod[];
}

/** The visitor capability a host offers, or undefined: none here. */
export function visitorCapabilityOf(hostCapabilities: unknown): VisitorCapability | undefined {
  const c = (hostCapabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental?.[VISITOR_CAPABILITY];
  if (typeof c !== "object" || c === null || (c as { v?: unknown }).v !== 1) return undefined;
  const methods = (c as { methods?: unknown }).methods;
  const actor = (c as { actor?: unknown }).actor;
  return {
    v: 1,
    methods: Array.isArray(methods) ? (methods.filter((m) => typeof m === "string") as VisitorMethod[]) : [],
    ...(typeof actor === "string" && actor ? { actor } : {}),
  };
}

/** A request's params and answers pass as they are (the shapes above). */
export const VISITOR_PASS_THROUGH = {
  "~standard": { version: 1 as const, vendor: "strut", validate: (value: unknown) => ({ value }) },
};

// ── The account widget (plans: the strut-drawn account widget) ───────────
// Strut draws the visitor's account widget over a public app, outside its
// frame. The app may MOVE or COLLAPSE it, never hide it: a collapsed widget
// is a small handle that stays visible and clickable.

/** What a host puts in `ui/initialize`'s `hostCapabilities.experimental`
 *  when it draws the widget: `{ v: 1 }`. */
export const ACCOUNT_CAPABILITY = "strut/account";
/** Page → host: move or collapse/expand the widget. `{ corner?, collapsed? }`;
 *  answers `{ corner, collapsed }` as applied (the host rate-limits: a
 *  change inside the window is held and applied later, the latest one). */
export const ACCOUNT_PLACEMENT_METHOD = "strut/account/placement";
/** The corners the widget may sit in, and how `app.yaml`'s `account.style`
 *  starts it (`handle`: collapsed). Copied in src/apps/manifest.ts. */
export const ACCOUNT_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export const ACCOUNT_STYLES = ["pill", "handle"] as const;
export type AccountCorner = (typeof ACCOUNT_CORNERS)[number];
export type AccountStyle = (typeof ACCOUNT_STYLES)[number];

export interface AccountPlacement {
  corner?: AccountCorner;
  collapsed?: boolean;
}

/** Whether the host draws an account widget for this page. */
export function accountCapabilityOf(hostCapabilities: unknown): boolean {
  const c = (hostCapabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental?.[ACCOUNT_CAPABILITY];
  return typeof c === "object" && c !== null && (c as { v?: unknown }).v === 1;
}
