// The app's reads and writes, each one step through the kit's client: the
// conversation index (`conversation/*`), a conversation followed live
// (`conversation/get { wait, since }`), the model catalog (`llm/models`),
// the Concepts a "/" offers (`graph/find`), and a turn sent
// (`run/launch` of `orchestrator`) or stopped (`run/cancel`); a tribe's
// conversation forked (`conversation/fork`); the viewer's linked accounts
// (`account/*`). An admin's Everyone (plans/jamie-app.md §2.3) is the same
// list, read and fork with `everyone`.
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileData, useAppState, useStrutClient } from "@strut/kit";
import { modelParams, sentModel } from "./lib/chat";
import type { AccountLink, ConversationList, ConversationListItem, ConversationTurn, ConversationView, LinkOffer, ModelCatalog } from "./lib/types";

export const ASSISTANT = "orchestrator";
/** How long one `conversation/get` is held: under the kit's feeds' 25 s, so a
 *  host that times a tool call out never sees one this long. */
export const WAIT_MS = 25_000;
/** How often the list is read again. */
const LIST_INTERVAL_MS = 5_000;
export const PAGE = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const listKey = (archived: boolean, q: string, limit: number, everyone = false) => ["assistant", "list", archived, q, limit, everyone] as const;

/** The viewer's conversations: the open ones, or the archived ones; for an
 *  admin, `everyone`'s. */
export function useConversationList(opts: { archived?: boolean; q?: string; limit?: number; enabled?: boolean; everyone?: boolean }) {
  const client = useStrutClient();
  const archived = !!opts.archived;
  const everyone = !!opts.everyone;
  const q = opts.q?.trim() ?? "";
  const limit = opts.limit ?? PAGE;
  return useQuery({
    queryKey: listKey(archived, q, limit, everyone),
    queryFn: () =>
      client.run<ConversationList>("conversation/list", { limit, ...(archived ? { archived: true } : {}), ...(q ? { q } : {}), ...(everyone ? { everyone: true } : {}) }),
    refetchInterval: LIST_INTERVAL_MS,
    enabled: opts.enabled !== false,
    placeholderData: (prev) => prev,
  });
}

/** A conversation's flags: a rename, archive or restore, seen. The list is
 *  read again after, so every row says what the server now says. */
export function useUpdateConversation() {
  const client = useStrutClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { session: string; title?: string; archived?: boolean; seen?: boolean; shared?: boolean }) => client.run<ConversationListItem>("conversation/update", v),
    onSettled: () => qc.invalidateQueries({ queryKey: ["assistant", "list"] }),
  });
}

/**
 * One conversation, followed: read once, then held (`wait`) until it
 * changes past the `rev` we have — a turn launched or settled — at most a
 * call a second, none while the page is hidden. `older` are the turns paged
 * in before the newest `PAGE` (settled, read once). `everyone`: an admin
 * reading it as a reader (plans/jamie-app.md §2.3).
 */
export function useConversation(session: string | null, everyone = false) {
  const client = useStrutClient();
  const [view, setView] = useState<ConversationView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [older, setOlder] = useState<{ turns: ConversationTurn[]; next?: number } | null>(null);
  const [nudge, setNudge] = useState(0);
  const rev = useRef<number | undefined>(undefined);

  useEffect(() => {
    setView(null);
    setError(null);
    setOlder(null);
    rev.current = undefined;
  }, [session, everyone]);

  useEffect(() => {
    if (!session) return;
    let stop = false;
    (async () => {
      let first = true;
      while (!stop) {
        const started = Date.now();
        try {
          const v = await client.run<ConversationView>("conversation/get", {
            session,
            limit: PAGE,
            ...(everyone ? { everyone: true } : {}),
            ...(first || rev.current === undefined ? {} : { wait: WAIT_MS, since: rev.current }),
          });
          if (stop) return;
          first = false;
          setError(null);
          if (v.rev !== rev.current || !rev.current) {
            rev.current = v.rev;
            setView(v);
          }
        } catch (err) {
          if (stop) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          await sleep(5_000);
        }
        const spent = Date.now() - started;
        if (spent < 1_000) await sleep(1_000 - spent);
        while (!stop && typeof document !== "undefined" && document.hidden) await sleep(1_000);
      }
    })();
    return () => {
      stop = true;
    };
  }, [client, session, everyone, nudge]);

  const loadOlder = useCallback(async () => {
    const before = older ? older.next : view?.next;
    if (!session || before === undefined) return;
    const v = await client.run<ConversationView>("conversation/get", { session, limit: PAGE, before, ...(everyone ? { everyone: true } : {}) });
    setOlder((o) => ({ turns: [...(o?.turns ?? []), ...v.turns], ...(v.next !== undefined ? { next: v.next } : {}) }));
  }, [client, session, everyone, older, view?.next]);

  return {
    view,
    error,
    /** Newest first: the followed page, then what was paged in. */
    turns: [...(view?.turns ?? []), ...(older?.turns ?? [])],
    hasOlder: older ? older.next !== undefined : view?.next !== undefined,
    loadOlder,
    /** Read again now (after a send). */
    refresh: () => setNudge((n) => n + 1),
  };
}

/** The models this strut can call (`llm/models`), read once. */
export function useModels() {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["assistant", "models"],
    queryFn: () => client.run<ModelCatalog>("llm/models", {}),
    staleTime: Infinity,
    retry: false,
  });
}

/** The viewer's model pick, remembered across their conversations
 *  (`useAppState`), and the model a turn sends with it now (`sentModel`).
 *  The composer's picker sets it; every turn the page launches — a message,
 *  and a job turn a card sends — runs on `sent`. */
export function useModelPick(): { pick: string; set: (v: string) => void; sent: string } {
  const [pick, set] = useAppState<string>("model", "");
  const models = useModels();
  return { pick, set, sent: sentModel(pick, models.data) };
}

export interface ConceptHit {
  ref_id: string;
  name: string;
  description?: string;
}

/** The Concepts whose name holds `query` (`graph/find` on `Concept`), for "/". */
export function useConcepts(query: string | null) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["assistant", "concepts", query],
    enabled: query !== null,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const r = await client.run<{ nodes: Array<{ ref_id: string; name?: string; properties: Record<string, unknown> }> }>("graph/find", {
        node_type: "Concept",
        ...(query ? { where: { name: { contains: query } } } : {}),
        orderBy: "name",
        limit: 8,
      });
      return r.nodes
        .filter((n) => !!n.name)
        .map((n) => ({ ref_id: n.ref_id, name: n.name!, ...(typeof n.properties["description"] === "string" ? { description: n.properties["description"] } : {}) }));
    },
  });
}

/** A turn: `run/launch` of the assistant on the conversation's session. */
export function useSend() {
  const client = useStrutClient();
  return useMutation({
    mutationFn: async (v: { session: string; prompt: string; context: Record<string, unknown>; model?: string; files?: readonly File[] }) => {
      const attachments = v.files?.length ? await Promise.all(v.files.map(fileData)) : undefined;
      return client.run<{ runId: string }>("run/launch", {
        workflow: ASSISTANT,
        input: { prompt: v.prompt, session: v.session, context: v.context },
        ...modelParams(v.model ?? ""),
        ...(attachments ? { attachments } : {}),
      });
    },
  });
}

/** Stop a turn that is running. */
export function useStop() {
  const client = useStrutClient();
  return useMutation({
    mutationFn: (v: { workflow: string; runId: string }) => client.run("run/cancel", v),
  });
}

/** A copy of a conversation the viewer continues here (`conversation/fork`):
 *  a tribe's, which its host alone continues, or one an admin read in
 *  Everyone (`everyone`). Answers its row. */
export function useFork() {
  const client = useStrutClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { session: string; everyone?: boolean }) => client.run<ConversationListItem>("conversation/fork", v),
    onSettled: () => qc.invalidateQueries({ queryKey: ["assistant", "list"] }),
  });
}

/** The viewer's linked accounts (`account/links`): every few seconds while
 *  a link challenge waits, so the link shows once Peel has signed it. */
export function useLinks(waiting: boolean) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["assistant", "links"],
    queryFn: () => client.run<{ links: AccountLink[] }>("account/links", {}),
    refetchInterval: waiting ? 3_000 : false,
  });
}

/** A new link challenge naming the viewer, for Peel to sign (`account/link`). */
export function useLinkOffer() {
  const client = useStrutClient();
  return useMutation({ mutationFn: () => client.run<LinkOffer>("account/link", {}) });
}

/** Removes one of the viewer's links (`account/unlink`). */
export function useUnlink() {
  const client = useStrutClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { account: string }) => client.run<{ removed: boolean }>("account/unlink", v),
    onSettled: () => qc.invalidateQueries({ queryKey: ["assistant", "links"] }),
  });
}
