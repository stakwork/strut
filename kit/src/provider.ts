import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StrutClient } from "./client.js";
import { createStaticHost, type StrutHost } from "./host.js";

const ClientContext = createContext<StrutClient | null>(null);
const HostContext = createContext<StrutHost | null>(null);

/** The query defaults every hook runs under: a step result is deterministic
 *  (no retry), an iframe gets focus events it should not refetch on, and a
 *  read stays fresh for a few seconds so two components asking for the same
 *  runs make one call. */
export function createKitQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
      mutations: { retry: false },
    },
  });
}

export interface StrutProviderProps {
  /** The one call every hook makes (plans/apps.md §3.2). */
  client: StrutClient;
  /** The host behind the page; a page with no bridge gets a static one. */
  host?: StrutHost;
  queryClient?: QueryClient;
  children?: ReactNode;
}

/** What an app is mounted under (§2.4): the client, the host and a
 *  react-query client. A host's own page wraps kit components in it with its
 *  own client. */
export function StrutProvider({ client, host, queryClient, children }: StrutProviderProps) {
  const qc = useMemo(() => queryClient ?? createKitQueryClient(), [queryClient]);
  const h = useMemo(() => host ?? createStaticHost(), [host]);
  return createElement(
    ClientContext.Provider,
    { value: client },
    createElement(HostContext.Provider, { value: h }, createElement(QueryClientProvider, { client: qc }, children)),
  );
}

/** The client of the nearest `StrutProvider` — for a component that calls a
 *  step the hooks do not name. */
export function useStrutClient(): StrutClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useStrutClient: no <StrutProvider> above this component");
  return client;
}

export function useStrutHost(): StrutHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("useStrutHost: no <StrutProvider> above this component");
  return host;
}
