/** The visitor hook (plans/app-repos.md §5): who is playing. On a public
 *  app's page a visitor may sign in — the host draws the sheet, signs
 *  strut's challenge with the key they pick, and holds the session; the app
 *  never sees a key. Signed in, the page's calls are that visitor's: its
 *  own `useAppState`, its channels, its rows. A page whose host offers no
 *  sign-in sees `available: false`. */
import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStrutClient, useStrutVisitor } from "./provider.js";
import { reloadAppState } from "./hooks.js";
import type { VisitorMethod } from "./visitor/protocol.js";

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
   *  set it again once signed in to keep it). */
  signIn(): Promise<string | undefined>;
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
  const signIn = useCallback(async () => {
    const signed = await visitor.signIn();
    if (signed) refresh();
    return signed;
  }, [visitor, refresh]);
  const signOut = useCallback(async () => {
    await visitor.signOut();
    refresh();
  }, [visitor, refresh]);
  return { available: visitor.available(), methods: visitor.methods(), ...(actor ? { actor } : {}), signIn, signOut };
}
