/**
 * SUPPORT (plans/support-chat.md): a chat between workers and the staff
 * over the treasury's Sphinx DMs. Workers write to the daemon's account,
 * "Support", from Peel; the staff answer from the Support tab of
 * `strut/staff` through the `/support` routes (./routes.ts).
 *
 * The daemon is reached with its MESSAGE token (§7, `messageToken` on a
 * `sphinx` wallet in `payments.json`, src/payments/settings.ts): never on
 * the services bag, held only here. With no token, or an NWC wallet (ruling
 * 11), every call answers `not_available`.
 *
 * The FOLLOWER polls `GET /dms?after=<seq>` every few seconds (ruling 16)
 * and keeps what it reads in the task store's file (./store.ts), the cursor
 * with it. A worker's file is fetched when it arrives, since its media token
 * expires (§1), up to 25 MB (ruling 10), into `<dataDir>/support/files/`. A
 * new contact's key exchange newer than the welcome's save gets the welcome
 * (§5), once.
 *
 * A send is kept before it goes (`POST /dm { id, to, text, reply? }`), so a
 * failure shows with Retry, which resends the same `id`: the daemon sends
 * one id once.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileNameOf, KINDS, WELCOME_BY, type Dm, type SendStatus, type SupportConversation, type SupportKind, type SupportMessage, type SupportStore, type WelcomeSettings } from "./store.js";

/** How often the follower reads the daemon (ruling 16). */
export const SUPPORT_POLL_MS = 3_000;
/** Records asked for per read; a full page is followed by the next at once. */
export const DMS_PAGE = 100;
/** Pages read per tick at most (a backlog is read over several ticks). */
const PAGES_PER_TICK = 20;
/** The largest file kept from a worker (ruling 10). */
export const SUPPORT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Tries for a file before it is given up. */
const FILE_TRIES = 5;
/** Files fetched per tick. */
const FILES_PER_TICK = 5;
/** How long one call to the daemon may take; a file, longer. */
const DAEMON_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 60_000;
/** The longest message staff may send, in characters. */
export const SUPPORT_TEXT_MAX = 10_000;
/** The welcome's longest text. */
export const WELCOME_MAX = 2_000;
/** The thread's page. */
export const THREAD_PAGE = 200;

export type SupportErrorCode = "not_available" | "bad_request" | "no_conversation" | "unknown_message" | "no_file" | "daemon_error";

const STATUS: Record<SupportErrorCode, 400 | 404 | 409 | 501 | 502> = {
  not_available: 501,
  bad_request: 400,
  no_conversation: 404,
  unknown_message: 404,
  no_file: 404,
  daemon_error: 502,
};

/** A refusal the caller can act on, its `code` first in the message. */
export class SupportError extends Error {
  constructor(
    readonly code: SupportErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SupportError";
  }
  get status(): 400 | 404 | 409 | 501 | 502 {
    return STATUS[this.code];
  }
}

/** The daemon as Support reaches it: its URL and the message token. */
export interface SupportDaemon {
  url: string;
  token: string;
}

export interface SupportDeps {
  /** The daemon and its message token now, or null: no Support. */
  daemon: () => Promise<SupportDaemon | null>;
  /** The store, opened on first use (the task store's file). */
  open: () => Promise<SupportStore>;
  /** Where workers' files are kept. */
  filesDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  pollMs?: number;
}

export interface Support {
  /** Whether Support answers here (a message token on a Sphinx wallet). */
  available(): Promise<boolean>;
  conversations(q?: string): Promise<{ conversations: SupportConversation[] }>;
  unread(): Promise<{ unread: number; conversations: number }>;
  thread(worker: string, o?: { before?: number; limit?: number }): Promise<{ conversation: SupportConversation; messages: SupportMessage[]; more: boolean }>;
  /** A message from Support (`text`, `replyTo`), or a failed one sent again (`retry`, its key). */
  send(worker: string, body: { text?: string; replyTo?: string; retry?: number }, by: string | undefined): Promise<{ message: SupportMessage }>;
  seen(worker: string, by: string | undefined): Promise<{ conversation: SupportConversation }>;
  file(worker: string, id: string): Promise<{ id: string; name?: string; mediaType: string; bytes: number; base64: string }>;
  settings(): Promise<{ settings: WelcomeSettings }>;
  saveSettings(body: { welcome: string }, by: string | undefined): Promise<{ settings: WelcomeSettings }>;
  /** One read of the daemon: the feed, the welcome, the files. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  /** Stops, waits for a tick in flight. The store's connection closes with it. */
  close(): Promise<void>;
}

const PUBKEY = /^0[23][0-9a-f]{64}$/;

/** One `GET /dms` record as strut keeps it, or null for one it does not
 *  (an unknown kind, a pubkey that is not one). Lenient on the time: unix
 *  seconds, ms or an ISO string. */
export function dmOf(v: unknown, now: number): Dm | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const peer = (o["peer"] && typeof o["peer"] === "object" ? o["peer"] : {}) as Record<string, unknown>;
  const pubkey = typeof peer["pubkey"] === "string" ? peer["pubkey"].toLowerCase() : "";
  const seq = o["seq"];
  const id = o["id"];
  const kind = o["kind"];
  if (!PUBKEY.test(pubkey) || typeof seq !== "number" || !Number.isSafeInteger(seq) || typeof id !== "string" || !id || !KINDS.includes(kind as SupportKind)) return null;
  const str = (k: string) => (typeof o[k] === "string" && o[k] ? (o[k] as string) : undefined);
  const t = o["time"];
  const at = typeof t === "number" && Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : typeof t === "string" && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : now;
  const status = o["fromMe"] === true ? statusOf(o["status"]) : undefined;
  const sats = typeof o["sats"] === "number" && Number.isFinite(o["sats"]) ? Math.round(o["sats"]) : undefined;
  const alias = typeof peer["alias"] === "string" && peer["alias"].trim() ? peer["alias"].trim() : undefined;
  return {
    seq,
    id,
    ...(str("clientId") ? { clientId: str("clientId")! } : {}),
    at: Math.round(at),
    fromMe: o["fromMe"] === true,
    pubkey,
    ...(alias ? { alias } : {}),
    kind: kind as SupportKind,
    ...(typeof o["text"] === "string" ? { text: o["text"] } : {}),
    ...(str("replyTo") ? { replyTo: str("replyTo")! } : {}),
    ...(sats !== undefined ? { sats } : {}),
    ...(o["deleted"] === true ? { deleted: true } : {}),
    ...(str("mediaType") ? { mediaType: str("mediaType")! } : {}),
    ...(str("fileName") ? { fileName: str("fileName")! } : {}),
    ...(status ? { status } : {}),
    ...(str("error") ? { error: str("error")! } : {}),
  };
}

/** A send's status as the daemon says it: `pending` (or `sending`) is still
 *  going, `failed` failed, anything else went. */
function statusOf(v: unknown): SendStatus | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "pending" || v === "sending") return "sending";
  if (v === "failed") return "failed";
  return "sent";
}

export function createSupport(deps: SupportDeps): Support {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  let opening: Promise<SupportStore> | undefined;
  const store = (): Promise<SupportStore> => {
    opening ??= deps.open();
    opening.catch(() => {
      opening = undefined;
    });
    return opening;
  };

  /** The daemon, or `not_available`. */
  const daemon = async (): Promise<SupportDaemon> => {
    const d = await deps.daemon();
    if (!d) throw new SupportError("not_available", "Support needs this server's wallet to be a Sphinx daemon with its message token (LIGHTNING_DAEMON_MESSAGE_TOKEN), plans/support-chat.md §8");
    return d;
  };
  /** The store, once the daemon answers for Support. */
  const ready = async (): Promise<{ d: SupportDaemon; s: SupportStore }> => {
    const d = await daemon();
    return { d, s: await store() };
  };

  const call = async (d: SupportDaemon, method: string, path: string, body?: unknown, timeout = DAEMON_TIMEOUT_MS): Promise<Response> =>
    fetchImpl(`${d.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${d.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
  /** The daemon's `{ error, code }`, in a line. */
  const refusal = async (res: Response): Promise<{ error: string; code?: string }> => {
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { error: typeof b["error"] === "string" ? b["error"] : `HTTP ${res.status}`, ...(typeof b["code"] === "string" ? { code: b["code"] } : {}) };
  };

  const conversationOf = (s: SupportStore, worker: string): SupportConversation => {
    const c = s.conversation(worker);
    if (!c) throw new SupportError("no_conversation", `${worker} has no conversation with Support: Support writes only to a worker who added it as a contact (an invite does), plans/support-chat.md ruling 15`);
    return c;
  };

  /** `POST /dm` for a message kept as sending; its answer kept unless the feed spoke first. */
  const deliver = async (d: SupportDaemon, s: SupportStore, key: number, o: { clientId: string; pubkey: string; text: string; replyTo?: string }): Promise<SupportMessage> => {
    try {
      const res = await call(d, "POST", "/dm", { id: o.clientId, to: o.pubkey, text: o.text, ...(o.replyTo ? { reply: o.replyTo } : {}) });
      if (!res.ok) {
        const r = await refusal(res);
        s.answered(key, "failed", r.code ? `${r.code}: ${r.error.replace(/^[a-z_]+: /, "")}` : r.error);
      } else {
        const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const status = statusOf(b["status"]);
        if (status === "failed") s.answered(key, "failed", typeof b["error"] === "string" ? b["error"] : undefined);
        else if (status === "sent") s.answered(key, "sent");
      }
    } catch (err) {
      s.answered(key, "failed", `the daemon did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    return s.message(key)!;
  };

  /** A message from Support to `pubkey`, kept, then sent. */
  const sendNew = (d: SupportDaemon, s: SupportStore, o: { pubkey: string; text: string; replyTo?: string; by?: string }) => {
    const clientId = randomBytes(32).toString("hex");
    const m = s.addOwn({ ...o, clientId, at: now() });
    return deliver(d, s, m.key, { clientId, ...o });
  };

  // ── the follower ─────────────────────────────────────────────────────────

  const follow = async (d: SupportDaemon, s: SupportStore) => {
    const since = s.since(now());
    for (let page = 0; page < PAGES_PER_TICK; page++) {
      const cursor = s.cursor();
      const res = await call(d, "GET", `/dms?after=${cursor}&limit=${DMS_PAGE}`);
      if (!res.ok) {
        const r = await refusal(res);
        throw new Error(`GET /dms answered ${res.status}: ${r.error}`);
      }
      const body = (await res.json()) as { dms?: unknown };
      const raw = Array.isArray(body?.dms) ? body.dms : [];
      if (!raw.length) return;
      const seqs = raw.map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>)["seq"] : undefined)).filter((q): q is number => typeof q === "number" && Number.isSafeInteger(q));
      const next = Math.max(cursor, ...seqs);
      const dms = raw.map((r) => dmOf(r, now())).filter((x): x is Dm => x !== null);
      const contacts = s.ingest(dms, next, since);
      for (const c of contacts) await welcome(d, s, c);
      if (raw.length < DMS_PAGE || next === cursor) return;
    }
  };

  /** §5: the welcome, to a contact newer than its save, once. */
  const welcome = async (d: SupportDaemon, s: SupportStore, c: { pubkey: string; at: number }) => {
    const w = s.welcome();
    if (!w.welcome || w.since === undefined || c.at < w.since) return;
    if (!s.claimWelcome(c.pubkey, now())) return;
    await sendNew(d, s, { pubkey: c.pubkey, text: w.welcome, by: WELCOME_BY });
  };

  /** Workers' files, kept when they arrive. */
  const fetchFiles = async (d: SupportDaemon, s: SupportStore) => {
    for (const f of s.fetching(FILES_PER_TICK)) {
      try {
        const res = await call(d, "GET", `/dm/${encodeURIComponent(f.id)}/file`, undefined, FILE_TIMEOUT_MS);
        if (!res.ok) {
          const r = await refusal(res);
          if (res.status === 413 || r.code === "too_large") s.fileFailed(f.key, "too_large", "too large: over 25 MB");
          else s.fileFailed(f.key, f.tries + 1 >= FILE_TRIES ? "failed" : "fetching", r.error);
          continue;
        }
        const bytes = await readCapped(res, SUPPORT_FILE_MAX_BYTES);
        if (!bytes) {
          s.fileFailed(f.key, "too_large", "too large: over 25 MB");
          continue;
        }
        await mkdir(deps.filesDir, { recursive: true, mode: 0o700 });
        const path = join(deps.filesDir, fileNameOf(f.id));
        const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(tmp, bytes, { mode: 0o600 });
          await rename(tmp, path);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
        const type = res.headers.get("content-type")?.split(";")[0]?.trim();
        s.fileKept(f.key, path, bytes.byteLength, type && type !== "application/octet-stream" ? type : undefined);
      } catch (err) {
        s.fileFailed(f.key, f.tries + 1 >= FILE_TRIES ? "failed" : "fetching", err instanceof Error ? err.message : String(err));
      }
    }
  };

  let ticking: Promise<void> | null = null;
  let warned = "";
  const tick = (): Promise<void> => {
    ticking ??= (async () => {
      try {
        const d = await deps.daemon();
        if (!d) return;
        const s = await store();
        await follow(d, s);
        await fetchFiles(d, s);
        warned = "";
      } catch (err) {
        // Said once until it changes: a daemon down for an hour is one line.
        const line = err instanceof Error ? err.message : String(err);
        if (line !== warned) console.warn(`[support] the daemon could not be read: ${line}`);
        warned = line;
      }
    })().finally(() => {
      ticking = null;
    });
    return ticking;
  };

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    async available() {
      return (await deps.daemon()) !== null;
    },

    async conversations(q) {
      const { s } = await ready();
      return { conversations: s.conversations(q ?? "") };
    },

    async unread() {
      const { s } = await ready();
      return s.unread();
    },

    async thread(worker, o = {}) {
      const { s } = await ready();
      const conversation = conversationOf(s, worker);
      const limit = Math.min(Math.max(1, o.limit ?? THREAD_PAGE), 500);
      return { conversation, ...s.messages(conversation.pubkey, { ...(o.before !== undefined ? { before: o.before } : {}), limit }) };
    },

    async send(worker, body, by) {
      const { d, s } = await ready();
      const c = conversationOf(s, worker);
      if (body.retry !== undefined) {
        const own = s.own(c.pubkey, body.retry);
        if (!own) throw new SupportError("unknown_message", `no message ${body.retry} of Support's in ${worker}'s conversation`);
        // Only a failed one goes again, once however many ask, under the id
        // it first went with.
        if (!s.claimRetry(own.message.key)) return { message: own.message };
        return { message: await deliver(d, s, own.message.key, { clientId: own.clientId, pubkey: c.pubkey, text: own.text, ...(own.message.replyTo ? { replyTo: own.message.replyTo } : {}) }) };
      }
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) throw new SupportError("bad_request", "text is the message: a non-empty string");
      if (text.length > SUPPORT_TEXT_MAX) throw new SupportError("bad_request", `a message is at most ${SUPPORT_TEXT_MAX} characters`);
      return { message: await sendNew(d, s, { pubkey: c.pubkey, text, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(by ? { by } : {}) }) };
    },

    async seen(worker, by) {
      const { s } = await ready();
      const c = conversationOf(s, worker);
      s.seen(c.pubkey, by, now());
      return { conversation: conversationOf(s, worker) };
    },

    async file(worker, id) {
      const { s } = await ready();
      const c = conversationOf(s, worker);
      const f = s.fileOf(c.pubkey, id);
      if (!f || f.message.kind !== "file") throw new SupportError("unknown_message", `no file ${id} in ${worker}'s conversation`);
      if (!f.path || f.message.deleted) {
        const state = f.message.deleted ? "deleted by the worker" : f.message.file?.state === "too_large" ? "too large: over 25 MB" : f.message.file?.state === "fetching" ? "still being fetched from the daemon" : `not kept: ${f.message.file?.error ?? "the daemon did not give it"}`;
        throw new SupportError("no_file", `the file is ${state}`);
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(f.path);
      } catch (err: any) {
        if (err?.code === "ENOENT") throw new SupportError("no_file", "the file is no longer on this server");
        throw err;
      }
      return { id, ...(f.message.file?.name ? { name: f.message.file.name } : {}), mediaType: f.message.file?.mediaType ?? "application/octet-stream", bytes: bytes.byteLength, base64: bytes.toString("base64") };
    },

    async settings() {
      const { s } = await ready();
      return { settings: s.welcome() };
    },

    async saveSettings(body, by) {
      const { s } = await ready();
      if (typeof body.welcome !== "string") throw new SupportError("bad_request", 'welcome is the text, "" to send none');
      if (body.welcome.length > WELCOME_MAX) throw new SupportError("bad_request", `the welcome is at most ${WELCOME_MAX} characters`);
      return { settings: s.saveWelcome(body.welcome, by, now()) };
    },

    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), deps.pollMs ?? SUPPORT_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await ticking;
      const open = opening;
      opening = undefined;
      if (open) (await open.catch(() => null))?.close();
    },
  };
}

/** A response's bytes, or null past `max`. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

