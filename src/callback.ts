/**
 * Host callbacks — how a caller that launched something DETACHED hears back
 * without holding a connection open: `POST /chat { callback }` (every turn
 * end; ai/turn-callback.ts) and `POST /workflows/:name/run { callback }`
 * (the run's result; createStrut's `postRunCallback`). One JSON POST to the
 * URL the caller gave, best-effort with a few retries, never awaited by the
 * work it reports on. The URL is the credential (the host signs it), so only
 * its origin is ever logged or recorded.
 *
 * A run's callbacks may name a ROOM instead (src/rooms.ts): `{ room: true }`
 * on the launch, the launching actor's room on this strut, kept as
 * `room:<actor>` wherever a URL is kept and delivered by `postCallback` to
 * the room's sockets. Only the server writes one: `parseCallback` never
 * accepts it as a URL.
 */

/** Where a room target starts (`room:<actor>`). */
const ROOM_PREFIX = "room:";

/** The target a room callback is kept as, in place of a URL. */
export function roomTarget(actor: string): string {
  return `${ROOM_PREFIX}${actor}`;
}

/** The actor a room target names; undefined for a URL. */
export function roomActorOf(target: string): string | undefined {
  return target.startsWith(ROOM_PREFIX) && target.length > ROOM_PREFIX.length ? target.slice(ROOM_PREFIX.length) : undefined;
}

/** Validate a run launch's callback: `{ url }` as `parseCallback` does, or
 *  `{ room: true }` — the launching actor's room, which the caller resolves. */
export function parseLaunchCallback(raw: unknown): { url: string } | { room: true } {
  const room = (raw as { room?: unknown } | null)?.room;
  if (room === undefined) return parseCallback(raw);
  if (room !== true || (raw as { url?: unknown }).url !== undefined) throw new Error("callback.room is `true`, with no url beside it");
  return { room: true };
}

/** Validate a `{ url }` callback: an http(s) URL, nothing else. */
export function parseCallback(raw: unknown): { url: string } {
  const url = (raw as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !url) throw new Error("callback.url (string) is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("callback.url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("callback.url must be http(s)");
  }
  return { url };
}

/** The part of a callback URL that is safe to log or return. */
export function callbackOrigin(url: string): string {
  if (roomActorOf(url) !== undefined) return "room";
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid url)";
  }
}

export interface PostCallbackOptions {
  /** Log prefix naming what is being posted (the origin is appended). */
  tag: string;
  fetch?: typeof fetch;
  /** Delays before each retry of a failed delivery (ms). */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  /** Where a room target goes (`Rooms.deliver`); without it one is dropped
   *  with a warning. */
  room?: (actor: string, payload: unknown) => void;
}

/** POST `payload` as JSON to `url`. A 4xx (other than 408/429) is the host
 *  refusing it — not retried; anything else retries on `retryDelaysMs`,
 *  then gives up with a warning. Never throws. A room target goes to the
 *  room instead, at once. */
export async function postCallback(url: string, payload: unknown, opts: PostCallbackOptions): Promise<void> {
  const actor = roomActorOf(url);
  if (actor !== undefined) {
    if (opts.room) opts.room(actor, payload);
    else console.warn(`${opts.tag} → room: no rooms here — dropped.`);
    return;
  }
  const doFetch = opts.fetch ?? fetch;
  const retryDelaysMs = opts.retryDelaysMs ?? [1_000, 5_000, 30_000];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const tag = `${opts.tag} → ${callbackOrigin(url)}`;
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return;
      failure = `HTTP ${res.status}`;
      // The host refused it — a retry would be refused the same way.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.warn(`${tag} rejected (${failure}) — not retrying.`);
        return;
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const delay = retryDelaysMs[attempt];
    if (delay === undefined) {
      console.warn(`${tag} failed (${failure}) — giving up after ${attempt + 1} attempts.`);
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}
