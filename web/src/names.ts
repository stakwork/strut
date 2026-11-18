// ── People's names in the UI (plans/people-and-hosts.md §1) ───────────────
//
// What shows for an actor: their name, from `GET /people`, else what showed
// before (`displayActor`). The whole actor stays in the tooltip
// (components/Who.tsx). A page asks for each actor once: the actors wanted
// in one tick go in one request, 200 at most. A read the server refuses
// stops the asking for the page (a member's session: names are an admin's
// read), and every actor shows as before.

import { displayActor } from "./actor";

/** One read: each actor asked, with `name` when one is kept; null when the
 *  server would not answer. */
export type FetchNames = (actors: string[]) => Promise<Record<string, { name?: string }> | null>;

/** The most actors one read asks for: the server's most. */
export const NAMES_PER_READ = 200;

/** What shows for an actor: their name, else the text before its first `-`. */
export function actorLabel(actor: string, name: string | undefined): string {
  return name ?? displayActor(actor);
}

export interface NameCache {
  /** The actor's name, when one has come back. */
  nameOf(actor: string): string | undefined;
  /** Ask for these actors' names, unless asked already. */
  want(actors: Iterable<string | undefined>): void;
  /** Called after each read; returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

export function createNameCache(fetchNames: FetchNames, wait: (fn: () => void) => void = (fn) => void setTimeout(fn, 0)): NameCache {
  /** Every actor asked: its name, or null for none. */
  const known = new Map<string, string | null>();
  let wanted = new Set<string>();
  let queued = false;
  let off = false;
  const listeners = new Set<() => void>();

  const read = async () => {
    queued = false;
    const batch = [...wanted];
    wanted = new Set();
    for (const a of batch) known.set(a, null);
    for (let i = 0; i < batch.length && !off; i += NAMES_PER_READ) {
      const got = await fetchNames(batch.slice(i, i + NAMES_PER_READ)).catch(() => null);
      if (!got) {
        off = true;
        break;
      }
      for (const [actor, p] of Object.entries(got)) if (p?.name) known.set(actor, p.name);
    }
    for (const fn of listeners) fn();
  };

  return {
    nameOf: (actor) => known.get(actor) ?? undefined,
    want(actors) {
      if (off) return;
      for (const a of actors) if (a && !known.has(a)) wanted.add(a);
      if (!wanted.size || queued) return;
      queued = true;
      wait(() => void read());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
