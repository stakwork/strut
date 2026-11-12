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
 *  the visitor closed it. */
export const VISITOR_SIGN_IN_METHOD = "strut/visitor/sign-in";
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
