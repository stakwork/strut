/**
 * The PROPOSAL FEED (plans/live-feeds.md, "Proposal feed"): what happened to proposals
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
 * proposals.ts knows nothing of it: createStrut makes one feed and pushes
 * every record its proposals' `changed` hook is told of (created, and each
 * decision and apply), the hook the graph projection rides. The event is
 * the record's status: pending → created, accepted or rejected → decided,
 * then applied or failed.
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
  /** A record was written: created, decided, applied or failed. */
  push(p: Proposal): void;
  /** The events after `cursor`, in order. `scope` + `actor` limit them as
   *  `GET /proposals` limits the list (`visibleTo`). */
  read(o: { scope: Scope; actor?: string | undefined; cursor?: string | undefined; wait?: number | undefined; limit?: number | undefined; signal?: AbortSignal | undefined }): Promise<ProposalChangesRead>;
  close(): void;
}

const cut = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

const EVENT_OF: Record<Proposal["status"], ProposalEventName> = {
  pending: "created",
  accepted: "decided",
  rejected: "decided",
  applied: "applied",
  failed: "failed",
};

export function proposalEventOf(p: Proposal): ProposalEvent {
  const event = EVENT_OF[p.status];
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
    push(p) {
      feed.push({ ev: proposalEventOf(p), seen: { by: { ...p.by } } });
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
