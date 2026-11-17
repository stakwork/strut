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
import { mkdir, open as openFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCapped } from "../packages/archive.js";
import { fileNameOf, KINDS, type Dm, type SendStatus, type SupportConversation, type SupportKind, type SupportMessage, type SupportStore, type WelcomeSettings } from "./store.js";

/** How often the follower reads the daemon (ruling 16). */
export const SUPPORT_POLL_MS = 3_000;
/** Records asked for per read; a full page is followed by the next at once. */
export const DMS_PAGE = 100;
/** Pages read per tick at most (a backlog is read over several ticks). */
const PAGES_PER_TICK = 20;
/** The largest file kept from a worker (ruling 10). */
export const SUPPORT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** A file is handed to a page in pieces this size (a multiple of 3, so the
 *  pieces' base64 joins as one): a step's result is capped at 5 MB
 *  (src/apps/tools.ts `STEP_RUN_RESULT_MAX_CHARS`). */
export const SUPPORT_FILE_PIECE_BYTES = 3 * 1024 * 1024;
/** Tries for a file before it is given up. */
const FILE_TRIES = 5;
/** Files fetched per tick. */
const FILES_PER_TICK = 5;
/** How long one call to the daemon may take; a send, which waits about
 *  10 s for the LSP's word, longer; a file, which the daemon downloads from
 *  the memes server within 180 s, longer still. */
const DAEMON_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;
const FILE_TIMEOUT_MS = 200_000;
/** The daemon's limit on a message (sphinx-chat's `MAX_SEND_BYTES`): its
 *  content and the quoted id as the message's JSON, in bytes. */
export const SUPPORT_SEND_MAX_BYTES = 32 * 1024;
/** A file refusal that never changes (stakwork/sphinx#435): not tried again. */
const FILE_REFUSED_FOR_GOOD = new Set(["not_found", "deleted", "host_not_allowed", "unreadable"]);
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
  conversations(q?: string): Promise<{ conversations: SupportConversation[] }>;
  unread(): Promise<{ unread: number; conversations: number }>;
  thread(worker: string, o?: { before?: number; limit?: number }): Promise<{ conversation: SupportConversation; messages: SupportMessage[]; more: boolean }>;
  /** A message from Support (`text`, `replyTo`), or a failed one sent again (`retry`, its key). */
  send(worker: string, body: { text?: string; replyTo?: string; retry?: number }, by: string | undefined): Promise<{ message: SupportMessage }>;
  seen(worker: string, by: string | undefined): Promise<{ conversation: SupportConversation }>;
  /** A worker's file, `SUPPORT_FILE_PIECE_BYTES` of it from `offset`;
   *  `next` is where the next piece starts, absent at the last. */
  file(worker: string, id: string, offset?: number): Promise<{ id: string; name?: string; mediaType: string; bytes: number; offset: number; base64: string; next?: number }>;
  settings(): Promise<{ settings: WelcomeSettings }>;
  saveSettings(body: { welcome: string }, by: string | undefined): Promise<{ settings: WelcomeSettings }>;
  /** One read of the daemon: the feed and the welcomes due; the files
   *  that came are fetched beside it, never holding the next read. */
  tick(): Promise<void>;
  /** The tick and the file fetches in flight, done (a test's). */
  settled(): Promise<void>;
  start(): void;
  stop(): void;
  /** Stops, waits for a tick in flight. The store's connection closes with it. */
  close(): Promise<void>;
}

const PUBKEY = /^0[23][0-9a-f]{64}$/;

/** One `GET /dms` record as strut keeps it, or null for one it does not
 *  (an unknown kind, a pubkey that is not one, neither an id nor a
 *  `clientId`). Its `id` is null only on a send of strut's that failed
 *  before anything went out. Lenient on the time: unix seconds, ms or ISO. */
export function dmOf(v: unknown, now: number): Dm | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const peer = (o["peer"] && typeof o["peer"] === "object" ? o["peer"] : {}) as Record<string, unknown>;
  const pubkey = typeof peer["pubkey"] === "string" ? peer["pubkey"].toLowerCase() : "";
  const seq = o["seq"];
  const kind = o["kind"];
  const str = (k: string) => (typeof o[k] === "string" && o[k] ? (o[k] as string) : undefined);
  const id = str("id");
  if (!PUBKEY.test(pubkey) || typeof seq !== "number" || !Number.isSafeInteger(seq) || (!id && !str("clientId")) || !KINDS.includes(kind as SupportKind)) return null;
  const t = o["time"];
  const timed = typeof t === "number" && Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : typeof t === "string" && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : undefined;
  const at = timed ?? now;
  const status = o["fromMe"] === true ? statusOf(o["status"]) : undefined;
  // Every record names its sats; only a payment's are worth keeping.
  const sats = kind === "payment" && typeof o["sats"] === "number" && Number.isFinite(o["sats"]) ? Math.round(o["sats"]) : undefined;
  const alias = typeof peer["alias"] === "string" && peer["alias"].trim() ? peer["alias"].trim() : undefined;
  return {
    seq,
    ...(id ? { id } : {}),
    ...(str("clientId") ? { clientId: str("clientId")! } : {}),
    at: Math.round(at),
    ...(timed === undefined ? { untimed: true as const } : {}),
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

/** A send's status as the daemon says it: `sending` (or `pending`) is still
 *  going — the LSP has not answered, or a publish failed partway and the
 *  daemon asks the LSP — `failed` failed, anything else went. */
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
  let closed = false;
  const store = (): Promise<SupportStore> => {
    if (closed) return Promise.reject(new Error("Support is closed"));
    // Opened once a process: no send of this one is in flight yet.
    opening ??= deps.open().then((s) => {
      s.abandonSends();
      return s;
    });
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
      // The daemon answers with the send as its feed shows it, once the LSP
      // has spoken or about 10 s have passed (then `sending`).
      const res = await call(d, "POST", "/dm", { id: o.clientId, to: o.pubkey, text: o.text, ...(o.replyTo ? { reply: o.replyTo } : {}) }, SEND_TIMEOUT_MS);
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
      const cursor = s.cursor(d.url);
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
      const { skipped, error } = s.ingest(dms, d.url, next, since);
      if (skipped) console.warn(`[support] ${skipped} of the daemon's records could not be kept and were skipped (${error})`);
      if (raw.length < DMS_PAGE || next === cursor) return;
    }
  };

  /** §5: each welcome due, claimed and kept before it goes, once. */
  const welcomes = async (d: SupportDaemon, s: SupportStore) => {
    for (const pubkey of s.dueWelcomes()) {
      const clientId = randomBytes(32).toString("hex");
      const m = s.startWelcome(pubkey, clientId, now());
      if (m) await deliver(d, s, m.key, { clientId, pubkey, text: m.text! });
    }
  };

  /** Workers' files, kept when they arrive. */
  const fetchFiles = async (d: SupportDaemon, s: SupportStore) => {
    for (const f of s.fetching(FILES_PER_TICK)) {
      if (closed) return;
      try {
        const res = await call(d, "GET", `/dm/${encodeURIComponent(f.id)}/file`, undefined, FILE_TIMEOUT_MS);
        if (!res.ok) {
          const r = await refusal(res);
          if (res.status === 413 || r.code === "too_large") s.fileFailed(f.key, "too_large", "too large: over 25 MB");
          else s.fileFailed(f.key, FILE_REFUSED_FOR_GOOD.has(r.code ?? "") || f.tries + 1 >= FILE_TRIES ? "failed" : "fetching", r.code ? `${r.code}: ${r.error}` : r.error);
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = await readCapped(res, SUPPORT_FILE_MAX_BYTES, "file");
        } catch (err) {
          // readCapped's refusal past the cap, by its content-length or as it streams.
          if (/more than \d+/.test(err instanceof Error ? err.message : "")) {
            s.fileFailed(f.key, "too_large", "too large: over 25 MB");
            continue;
          }
          throw err;
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
        // The feed names a file by its type (a Sphinx file message carries no
        // name); the sender's own name comes with the bytes.
        s.fileKept(f.key, path, bytes.byteLength, type && type !== "application/octet-stream" ? type : undefined, fileNameIn(res.headers.get("content-disposition")));
      } catch (err) {
        s.fileFailed(f.key, f.tries + 1 >= FILE_TRIES ? "failed" : "fetching", err instanceof Error ? err.message : String(err));
      }
    }
  };

  let ticking: Promise<void> | null = null;
  let filing: Promise<void> | null = null;
  let warned = "";
  const tick = (): Promise<void> => {
    ticking ??= (async () => {
      try {
        const d = await deps.daemon();
        if (!d) return;
        const s = await store();
        await follow(d, s);
        await welcomes(d, s);
        // A file may take minutes to come: the next read never waits for it.
        filing ??= fetchFiles(d, s)
          .catch((err) => console.warn(`[support] the files could not be fetched: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            filing = null;
          });
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
      // The daemon's own measure, refused here before anything is kept.
      const size = Buffer.byteLength(JSON.stringify({ content: text, ...(body.replyTo ? { replyUuid: body.replyTo } : {}) }), "utf8");
      if (size > SUPPORT_SEND_MAX_BYTES) throw new SupportError("bad_request", `too long: ${size} bytes as a message, at most ${SUPPORT_SEND_MAX_BYTES}`);
      return { message: await sendNew(d, s, { pubkey: c.pubkey, text, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(by ? { by } : {}) }) };
    },

    async seen(worker, by) {
      const { s } = await ready();
      const c = conversationOf(s, worker);
      s.seen(c.pubkey, by, now());
      return { conversation: conversationOf(s, worker) };
    },

    async file(worker, id, offset = 0) {
      const { s } = await ready();
      const c = conversationOf(s, worker);
      const f = s.fileOf(c.pubkey, id);
      if (!f || f.message.kind !== "file") throw new SupportError("unknown_message", `no file ${id} in ${worker}'s conversation`);
      if (!f.path || f.message.deleted) {
        const state = f.message.deleted ? "deleted by the worker" : f.message.file?.state === "too_large" ? "too large: over 25 MB" : f.message.file?.state === "fetching" ? "still being fetched from the daemon" : `not kept: ${f.message.file?.error ?? "the daemon did not give it"}`;
        throw new SupportError("no_file", `the file is ${state}`);
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset % SUPPORT_FILE_PIECE_BYTES !== 0) throw new SupportError("bad_request", `offset is a multiple of ${SUPPORT_FILE_PIECE_BYTES}: where a piece starts`);
      let piece: Buffer;
      let size: number;
      try {
        const fh = await openFile(f.path, "r");
        try {
          size = (await fh.stat()).size;
          const buf = Buffer.alloc(Math.max(0, Math.min(SUPPORT_FILE_PIECE_BYTES, size - offset)));
          const { bytesRead } = await fh.read(buf, 0, buf.byteLength, offset);
          piece = buf.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
      } catch (err: any) {
        if (err?.code === "ENOENT") throw new SupportError("no_file", "the file is no longer on this server");
        throw err;
      }
      const next = offset + piece.byteLength;
      return {
        id,
        ...(f.message.file?.name ? { name: f.message.file.name } : {}),
        mediaType: f.message.file?.mediaType ?? "application/octet-stream",
        bytes: size,
        offset,
        base64: piece.toString("base64"),
        ...(next < size ? { next } : {}),
      };
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
    async settled() {
      await ticking;
      await filing;
    },
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
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await ticking;
      await filing;
      const open = opening;
      opening = undefined;
      if (open) (await open.catch(() => null))?.close();
    },
  };
}

/** The sender's name of a file, as `content-disposition` carries it
 *  (RFC 6266: `filename*=UTF-8''…` first, else `filename="…"`). */
export function fileNameIn(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      const name = decodeURIComponent(star[1]!.trim());
      if (name) return name;
    } catch {
      // not well encoded: the plain name below
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain?.[1]?.trim() || undefined;
}
