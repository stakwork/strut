/**
 * A LIVE FEED (plans/live-feeds.md): the newest state of each thing, in the
 * order things last changed, for a reader that asks "what changed since my
 * cursor?" and may wait for the answer. Two feeds use it: a job's updates
 * (`jobs.ts`, `job/updates`) and the graph writes made through strut
 * (`graph-writes.ts`, `graph/changes`).
 *
 * In memory: a feed is a notification, never the record — what changed is
 * read again from where it lives. A restart starts every feed empty, and
 * its cursors say so (`reset`).
 *
 * A cursor is `<epoch>.<seq>`, the epoch being this process's start. A
 * cursor from another epoch, one the feed has dropped things past, or one
 * that does not parse reads from the start with `reset: true`: the reader
 * has missed something and reads what it shows again. `"now"` is the feed's
 * current position: a reader that only wants what changes from here asks
 * with it.
 *
 * A read with `wait` and nothing new holds until something lands, then
 * GATHERS for a second before answering, so a reader that asks again on
 * every answer makes at most one call a second however fast things change.
 * A read that finds something already waiting answers at once.
 */

/** This process's epoch: the first half of every cursor. */
export const FEED_EPOCH = Date.now().toString(36);
/** The longest a read may wait: `run/get { wait }`'s, under a client's request timeout. */
export const FEED_MAX_WAIT_MS = 55_000;
/** How long a woken read gathers before it answers. */
export const FEED_GATHER_MS = 1_000;

export interface FeedRead<T> {
  /** Where the reader is now: hand it back as `since`. */
  cursor: string;
  /** The reader's cursor could not be honored (another process's, or the
   *  feed dropped things past it): `items` is everything kept, and the
   *  reader reads what it shows again. */
  reset?: true;
  /** More than `limit` changed: read again from `cursor`. */
  more?: true;
  items: T[];
}

export interface FeedReadOptions<T> {
  since?: string;
  /** Hold up to this many ms (at most `FEED_MAX_WAIT_MS`) while nothing new. */
  wait?: number;
  limit?: number;
  /** Only these count: items left out neither answer nor wake the read. */
  filter?: (item: T) => boolean;
  /** Stop waiting (a client that went away). */
  signal?: AbortSignal;
}

export interface LiveFeedOptions<T> {
  /** The most things kept; the oldest change goes first. */
  max: number;
  /** What a thing is: a newer item with the same key replaces the older. */
  keyOf: (item: T) => string;
  /** Tests shorten it. */
  gatherMs?: number;
}

/** A read waiting: `wake` on each new item, `done` to answer now. */
interface Waiter<T> {
  wake(item: T): void;
  done(): void;
}

export class LiveFeed<T> {
  private seq = 0;
  /** The newest seq the feed has dropped: a cursor before it missed something. */
  private dropped = 0;
  /** Key → the thing's newest state. Map order is change order (delete, then set). */
  private readonly items = new Map<string, { seq: number; item: T }>();
  private readonly waiters = new Set<Waiter<T>>();
  /** When something last landed (or the feed was made). */
  touchedAt = Date.now();

  constructor(private readonly opts: LiveFeedOptions<T>) {}

  push(item: T): void {
    const key = this.opts.keyOf(item);
    this.items.delete(key);
    this.items.set(key, { seq: ++this.seq, item });
    while (this.items.size > this.opts.max) {
      const [oldest, kept] = this.items.entries().next().value!;
      this.items.delete(oldest);
      this.dropped = Math.max(this.dropped, kept.seq);
    }
    this.touchedAt = Date.now();
    for (const w of [...this.waiters]) w.wake(item);
  }

  /** The feed's position: what `since: "now"` reads from. */
  cursor(): string {
    return `${FEED_EPOCH}.${this.seq}`;
  }

  async read(o: FeedReadOptions<T> = {}): Promise<FeedRead<T>> {
    const { from, reset } = this.from(o.since);
    const first = this.collect(from, reset, o);
    const wait = Math.min(FEED_MAX_WAIT_MS, Math.max(0, o.wait ?? 0));
    if (first.items.length > 0 || reset || wait === 0 || o.signal?.aborted) return first;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let woken = false;
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        o.signal?.removeEventListener("abort", done);
        resolve();
      };
      const waiter: Waiter<T> = {
        wake: (item) => {
          if (woken || (o.filter && !o.filter(item))) return;
          woken = true;
          clearTimeout(timer);
          timer = setTimeout(done, this.opts.gatherMs ?? FEED_GATHER_MS);
        },
        done,
      };
      timer = setTimeout(done, wait);
      this.waiters.add(waiter);
      o.signal?.addEventListener("abort", done);
    });
    return this.collect(from, false, o);
  }

  /** Let every waiting read answer now (a server closing). */
  wakeAll(): void {
    for (const w of [...this.waiters]) w.done();
  }

  private from(since: string | undefined): { from: number; reset: boolean } {
    if (since === undefined || since === "") return { from: 0, reset: false };
    if (since === "now") return { from: this.seq, reset: false };
    const dot = since.lastIndexOf(".");
    const n = Number(since.slice(dot + 1));
    if (dot < 0 || since.slice(0, dot) !== FEED_EPOCH || !Number.isInteger(n) || n < 0 || n > this.seq) return { from: 0, reset: true };
    if (n < this.dropped) return { from: 0, reset: true };
    return { from: n, reset: false };
  }

  private collect(from: number, reset: boolean, o: FeedReadOptions<T>): FeedRead<T> {
    const limit = o.limit && o.limit > 0 ? o.limit : Infinity;
    const items: T[] = [];
    let last = this.seq;
    let more = false;
    for (const { seq, item } of this.items.values()) {
      if (seq <= from || (o.filter && !o.filter(item))) continue;
      if (items.length >= limit) {
        more = true;
        break;
      }
      items.push(item);
      last = seq;
    }
    return { cursor: `${FEED_EPOCH}.${more ? last : this.seq}`, ...(reset ? { reset: true as const } : {}), ...(more ? { more: true as const } : {}), items };
  }
}
