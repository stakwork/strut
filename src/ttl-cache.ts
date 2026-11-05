/**
 * A tiny TTL cache for computed responses, keyed per route key. Concurrent
 * `get`s for one key share ONE computation (the in-flight promise); only a
 * successful result is kept — a rejection is never cached. Every hit is a
 * `structuredClone`, so a caller can't mutate the cached object. `clear` /
 * `delete` also orphan a computation still in flight, so a result computed
 * before an invalidation is never stored after it. The clock is injectable
 * for tests.
 */
interface Entry<T> {
  expires: number;
  promise: Promise<T>;
  settled: boolean;
}

export class TtlCache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && (!hit.settled || hit.expires > this.now())) return structuredClone(await hit.promise);
    const entry: Entry<T> = { expires: 0, settled: false, promise: undefined as unknown as Promise<T> };
    entry.promise = compute().then(
      (value) => {
        entry.settled = true;
        entry.expires = this.now() + this.ttlMs;
        return value;
      },
      (err) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw err;
      },
    );
    this.entries.set(key, entry);
    return structuredClone(await entry.promise);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
