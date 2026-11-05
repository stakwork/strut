/**
 * The PROPOSAL FEED (plans/live-feeds.md §4): what happened to proposals
 * after a cursor, for a reader that cannot be called (an app's page) and
 * would otherwise poll `proposal/list`. The twin of the graph change feed:
 * a `LiveFeed` (bounded, cursor, `wait`), one entry per EVENT — events are
 * never folded into each other, so a reader sees created → decided →
 * applied in order.
 *
 * An event carries the envelope only — id, status, kind, a short title and
 * summary, the actor, the time — never the tool's input, the model's
 * rationale, the card or the result: a reader that wants more reads the
 * proposal by id, through the reads it already has.
 *
 * proposals.ts calls `emitProposal` and knows nothing else of this file.
 * The feed is per proposals directory (`proposalFeedFor`), so the record's
 * writer and the server that serves the feed meet without a handle passed
 * through every function.
 */
import { LiveFeed, type FeedRead } from "./live-feed.js";
import { visibleTo, type Proposal } from "./proposals.js";
import type { Scope } from "./auth.js";

export type ProposalEventName = "created" | "decided" | "applied" | "failed";

export interface ProposalEvent {
  event: ProposalEventName;
  id: string;
  status: Proposal["status"];
  /** `tool` for an MCP server's tool (`mcp/<server>/<tool>`), else `step`. */
  kind: "tool" | "step";
  title: string;
  summary?: string;
  /** Who made it happen: the proposer on `created`, the decider after. */
  actor?: string;
  /** ISO time. */
  at: string;
}

export interface ProposalChangesRead {
  cursor: string;
  reset?: true;
  more?: true;
  events: ProposalEvent[];
}

/** The events the feed keeps. */
export const PROPOSAL_FEED_MAX = 1_000;
/** The most a read answers. */
export const PROPOSAL_FEED_READ_MAX = 200;
/** Title and summary are cut to this. */
const TEXT_MAX = 200;

/** What `visibleTo` reads of the proposal, kept beside the event, never served. */
type Seen = Pick<Proposal, "by">;
interface Entry {
  ev: ProposalEvent;
  seen: Seen;
}

export interface ProposalFeed {
  push(event: ProposalEventName, p: Proposal): void;
  /** The events after `cursor`, in order. `scope` + `actor` limit them as
   *  `GET /proposals` limits the list (`visibleTo`). */
  read(o: { scope: Scope; actor?: string | undefined; cursor?: string | undefined; wait?: number | undefined; limit?: number | undefined; signal?: AbortSignal | undefined }): Promise<ProposalChangesRead>;
  close(): void;
}

const cut = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

export function proposalEventOf(event: ProposalEventName, p: Proposal): ProposalEvent {
  const actor = event === "created" ? p.by.actor : (p.decision?.by ?? p.by.actor);
  return {
    event,
    id: p.id,
    status: p.status,
    kind: p.step.startsWith("mcp/") ? "tool" : "step",
    title: cut(p.title),
    ...(p.summary ? { summary: cut(p.summary) } : {}),
    ...(actor ? { actor } : {}),
    at: new Date().toISOString(),
  };
}

export function createProposalFeed(opts: { max?: number; gatherMs?: number } = {}): ProposalFeed {
  let n = 0;
  const feed = new LiveFeed<Entry>({ max: opts.max ?? PROPOSAL_FEED_MAX, keyOf: () => String(++n), ...(opts.gatherMs !== undefined ? { gatherMs: opts.gatherMs } : {}) });
  return {
    push(event, p) {
      feed.push({ ev: proposalEventOf(event, p), seen: { by: { ...p.by } } });
    },
    async read(o) {
      const filter = (e: Entry) => visibleTo(o.scope, o.actor, e.seen as Proposal);
      const limit = Math.min(PROPOSAL_FEED_READ_MAX, o.limit && o.limit > 0 ? o.limit : PROPOSAL_FEED_READ_MAX);
      const read: FeedRead<Entry> = await feed.read({ since: o.cursor, wait: o.wait, limit, filter, signal: o.signal });
      const { items, ...rest } = read;
      return { ...rest, events: items.map((e) => e.ev) };
    },
    close() {
      feed.wakeAll();
    },
  };
}

const feeds = new Map<string, ProposalFeed>();

/** The feed of one proposals directory, made on first use. */
export function proposalFeedFor(root: string): ProposalFeed {
  let f = feeds.get(root);
  if (!f) feeds.set(root, (f = createProposalFeed()));
  return f;
}

/** proposals.ts's one call: a proposal was created, decided, applied or failed. Never throws. */
export function emitProposal(root: string, event: ProposalEventName, p: Proposal): void {
  try {
    proposalFeedFor(root).push(event, p);
  } catch {
    /* a notification, never the record */
  }
}
