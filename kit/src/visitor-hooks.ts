/** The visitor hook (plans/app-repos.md §5): who is playing. On a public
 *  app's page a visitor may sign in — the host draws the sheet, signs
 *  strut's challenge with the key they pick, and holds the session; the app
 *  never sees a key. Signed in, the page's calls are that visitor's: its
 *  own `useAppState`, its channels, its rows. A page whose host offers no
 *  sign-in sees `available: false`. */
import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStrutAccount, useStrutClient, useStrutVisitor } from "./provider.js";
import { reloadAppState } from "./hooks.js";
import type { AccountPlacement, SignInOptions, VisitorMethod } from "./visitor/protocol.js";

export interface UseVisitor {
  /** The host can sign a visitor in here (the public view names a method). */
  available: boolean;
  /** What its sheet offers. */
  methods: VisitorMethod[];
  /** Who is signed in — `p256:…`, `secp:…`, or the name a host gave — or
   *  undefined: anonymous. */
  actor?: string;
  /** The host's sign-in sheet: the actor once signed in, undefined when the
   *  visitor closed it. The page's reads are read again as the new viewer's
   *  (`useAppState` included: what was set before and not kept is dropped —
   *  set it again once signed in to keep it). `{ silent: true }`: no
   *  sheet — signed in only when the host's wallet does it without asking
   *  (Peel holding a grant for this page), else undefined; what a page
   *  tries as it loads, keeping its own button for the rest. */
  signIn(opts?: SignInOptions): Promise<string | undefined>;
  signOut(): Promise<void>;
}

export function useVisitor(): UseVisitor {
  const visitor = useStrutVisitor();
  const client = useStrutClient();
  const queries = useQueryClient();
  const actor = useSyncExternalStore(visitor.subscribe, visitor.actor, visitor.actor);
  const refresh = useCallback(() => {
    reloadAppState(client);
    void queries.invalidateQueries();
  }, [client, queries]);
  const signIn = useCallback(async (opts?: SignInOptions) => {
    const signed = await visitor.signIn(opts);
    if (signed) refresh();
    return signed;
  }, [visitor, refresh]);
  const signOut = useCallback(async () => {
    await visitor.signOut();
    refresh();
  }, [visitor, refresh]);
  return { available: visitor.available(), methods: visitor.methods(), ...(actor ? { actor } : {}), signIn, signOut };
}

export interface UseAccountWidget {
  /** The host draws an account widget over this page. */
  available: boolean;
  /** Move the widget to a corner and/or collapse or expand it (a game
   *  collapses it during play, expands it in menus). The host rate-limits
   *  (about one change per 500 ms; the latest wins) and never lets it be
   *  hidden. Rejects an unknown corner. */
  setPlacement(placement: AccountPlacement): Promise<void>;
}

export function useAccountWidget(): UseAccountWidget {
  const account = useStrutAccount();
  return { available: account.available(), setPlacement: account.setPlacement };
}
