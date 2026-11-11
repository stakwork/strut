/** The app's VISITOR CLIENT (plans/app-repos.md §5.2): an app page's side,
 *  over the MCP Apps `App` it already runs. `useVisitor` is over it. No
 *  React, no dependency. */
import {
  VISITOR_PASS_THROUGH, VISITOR_SIGN_IN_METHOD, VISITOR_SIGN_OUT_METHOD, visitorCapabilityOf, type VisitorMethod,
} from "./protocol.js";

/** A sign-in waits for the person: a QR code takes a phone. */
export const VISITOR_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface VisitorClient {
  /** The host can sign a visitor in here. */
  available(): boolean;
  methods(): VisitorMethod[];
  /** Who is signed in, if anyone. */
  actor(): string | undefined;
  /** The host's sheet: the actor once signed in, undefined when the visitor
   *  closed it. Rejects when the host cannot sign in at all. */
  signIn(): Promise<string | undefined>;
  signOut(): Promise<void>;
  /** Called when `actor()` changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** What the client needs of ext-apps' `App`. */
export interface VisitorBridgeApp {
  getHostCapabilities(): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(request: { method: string; params?: Record<string, unknown> }, resultSchema: any, options?: { timeout?: number }): Promise<unknown>;
}

const NO_HOST = "this page's host offers no sign-in";

/** A client over the page's bridge; the capability is read once the host
 *  has answered `ui/initialize`. */
export function createBridgeVisitor(app: VisitorBridgeApp): VisitorClient {
  const listeners = new Set<() => void>();
  /** The actor since this page signed in or out: the capability's before. */
  let changed: { actor?: string } | undefined;
  const cap = () => visitorCapabilityOf(app.getHostCapabilities());
  const set = (actor: string | undefined) => {
    changed = actor ? { actor } : {};
    for (const l of [...listeners]) l();
  };
  return {
    available: () => !!cap()?.methods.length,
    methods: () => cap()?.methods ?? [],
    actor: () => (changed ? changed.actor : cap()?.actor),
    async signIn() {
      if (!cap()) throw new Error(NO_HOST);
      const r = (await app.request({ method: VISITOR_SIGN_IN_METHOD, params: {} }, VISITOR_PASS_THROUGH, { timeout: VISITOR_SIGN_IN_TIMEOUT_MS })) as { actor?: unknown } | undefined;
      const actor = typeof r?.actor === "string" && r.actor ? r.actor : undefined;
      if (actor) set(actor);
      return actor;
    },
    async signOut() {
      if (!cap()) throw new Error(NO_HOST);
      await app.request({ method: VISITOR_SIGN_OUT_METHOD, params: {} }, VISITOR_PASS_THROUGH);
      set(undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The client of a page whose host offers no sign-in. */
export const NO_VISITOR: VisitorClient = {
  available: () => false,
  methods: () => [],
  actor: () => undefined,
  signIn: async () => {
    throw new Error(NO_HOST);
  },
  signOut: async () => {
    throw new Error(NO_HOST);
  },
  subscribe: () => () => {},
};
