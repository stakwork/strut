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
 * A send is kept before it goes (`POST /dm { id, to, text, reply?, file? }`),
 * so a failure shows with Retry, which resends the same `id`: the daemon
 * sends one id once.
 *
 * Item 2 (plans/support-chat.md §3, §6): a staff file (strut keeps its copy
 * under `<dataDir>/support/files/`, then sends it), Support's picture (the
 * daemon's `PUT /dm/photo`; strut keeps its copy at `<dataDir>/support/
 * photo` to show), Delete for both sides (`POST /dm/:id/delete`), a line
 * from Support when a payout settles (`paidOut`), a conversation's status
 * and who took it, and the HEADS-UP: when a worker's message has waited
 * unread `HEADS_UP_AFTER_MS`, Support DMs each admin it knows (`admins`) the
 * count, at most once an hour each.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open as openFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCapped } from "../packages/archive.js";
import {
  fileNameOf,
  FILTERS,
  KINDS,
  type ConversationStatus,
  type Dm,
  type OwnFile,
  type SendStatus,
  type SupportAuto,
  type SupportConversation,
  type SupportFilter,
  type SupportKind,
  type SupportMessage,
  type SupportPhoto,
  type SupportStore,
  type WelcomeSettings,
} from "./store.js";

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
/** The largest file staff send (§3): the page's call is capped at 4 MB,
 *  base64 included. The page shrinks a photo to 1,600 px first. */
export const SUPPORT_SEND_FILE_MAX_BYTES = 2.5 * 1024 * 1024;
/** Support's picture, as the page sends it (shrunk to 512 px). */
export const SUPPORT_PHOTO_MAX_BYTES = 1024 * 1024;
/** A worker's message unread this long sends the heads-up (§6)… */
export const HEADS_UP_AFTER_MS = 5 * 60_000;
/** …at most this often to each admin. */
export const HEADS_UP_EVERY_MS = 60 * 60_000;
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

/** Support's settings as the routes answer them: the welcome (§5), payout
 *  lines (§6), Support's picture (its bytes, to show; the page cannot load
 *  the memes URL, §3). */
export type SupportSettings = WelcomeSettings & { payoutLines: boolean; photo?: SupportPhoto & { base64?: string } };

/** A file a page sends: base64, its type and name. */
export interface SendFile {
  base64: string;
  type: string;
  name: string;
}

export interface SupportDeps {
  /** The daemon and its message token now, or null: no Support. */
  daemon: () => Promise<SupportDaemon | null>;
  /** The store, opened on first use (the task store's file). */
  open: () => Promise<SupportStore>;
  /** Where workers' files, and the staff's, are kept. */
  filesDir: string;
  /** Where Support's picture is kept. */
  photoFile: string;
  fetch?: typeof fetch;
  now?: () => number;
  pollMs?: number;
}

export interface Support {
  /** `me`: the asker, whom `assigned` and `mine` are told relative to. */
  conversations(q?: string, o?: { filter?: SupportFilter; me?: string }): Promise<{ conversations: SupportConversation[] }>;
  unread(): Promise<{ unread: number; conversations: number }>;
  thread(worker: string, o?: { before?: number; limit?: number; me?: string }): Promise<{ conversation: SupportConversation; messages: SupportMessage[]; more: boolean }>;
  /** A message from Support (`text`, `replyTo`, `file`), or a failed one sent again (`retry`, its key). */
  send(worker: string, body: { text?: string; replyTo?: string; file?: SendFile; retry?: number }, by: string | undefined): Promise<{ message: SupportMessage }>;
  /** One of Support's messages deleted for both sides (item 2). */
  remove(worker: string, key: number): Promise<{ message: SupportMessage }>;
  /** A conversation marked `done` or `open`, taken (`assignee: "me"`) or let go (`null`). */
  update(worker: string, body: { status?: unknown; assignee?: unknown }, me: string | undefined): Promise<{ conversation: SupportConversation }>;
  seen(worker: string, by: string | undefined): Promise<{ conversation: SupportConversation }>;
  /** A worker's file, `SUPPORT_FILE_PIECE_BYTES` of it from `offset`;
   *  `next` is where the next piece starts, absent at the last. */
  file(worker: string, id: string, offset?: number): Promise<{ id: string; name?: string; mediaType: string; bytes: number; offset: number; base64: string; next?: number }>;
  settings(): Promise<{ settings: SupportSettings }>;
  saveSettings(body: { welcome?: unknown; payoutLines?: unknown }, by: string | undefined): Promise<{ settings: SupportSettings }>;
  /** Support's picture set through the daemon (`photo`), or cleared (`null`). */
  savePhoto(photo: { base64?: unknown; type?: unknown } | null, by: string | undefined): Promise<{ settings: SupportSettings }>;
  /** A payout settled (plans/human-steps.md §8.2): its line from Support
   *  to the worker, when they are a contact and payout lines are on. Once
   *  per payout; never throws. */
  paidOut(p: { key: string; worker: string; msat: number }): Promise<void>;
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

  const conversationOf = (s: SupportStore, worker: string, me?: string): SupportConversation => {
    const c = s.conversation(worker, me);
    if (!c) throw new SupportError("no_conversation", `${worker} has no conversation with Support: Support writes only to a worker who added it as a contact (an invite does), plans/support-chat.md ruling 15`);
    return c;
  };

  /** `POST /dm` for a message kept as sending; its answer kept unless the
   *  feed spoke first. A file goes as its bytes, read from strut's copy. */
  const deliver = async (d: SupportDaemon, s: SupportStore, key: number, o: { clientId: string; pubkey: string; text?: string; replyTo?: string; file?: OwnFile }): Promise<SupportMessage> => {
    try {
      const file = o.file ? { data: (await readFile(o.file.path)).toString("base64"), type: o.file.mediaType, name: o.file.name } : undefined;
      // The daemon answers with the send as its feed shows it, once the LSP
      // has spoken or about 10 s have passed (then `sending`).
      const res = await call(d, "POST", "/dm", { id: o.clientId, to: o.pubkey, ...(o.text ? { text: o.text } : {}), ...(o.replyTo ? { reply: o.replyTo } : {}), ...(file ? { file } : {}) }, SEND_TIMEOUT_MS);
      if (!res.ok) {
        const r = await refusal(res);
        s.answered(key, "failed", r.code ? `${r.code}: ${r.error.replace(/^[a-z_]+: /, "")}` : r.error);
      } else {
        const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const status = statusOf(b["status"]);
        const id = typeof b["id"] === "string" && b["id"] ? b["id"] : undefined;
        s.answered(key, status === "sending" ? undefined : status, typeof b["error"] === "string" ? b["error"] : undefined, id);
      }
    } catch (err) {
      s.answered(key, "failed", `the daemon did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    return s.message(key)!;
  };

  /** A message from Support to `pubkey`, kept, then sent; a file kept
   *  first under the send's id. `clientId` given: once (a payout's line). */
  const sendNew = async (d: SupportDaemon, s: SupportStore, o: { pubkey: string; text?: string; replyTo?: string; by?: string; file?: { bytes: Buffer; mediaType: string; name: string } }, clientId = randomBytes(32).toString("hex")) => {
    let file: OwnFile | undefined;
    if (o.file) {
      const path = join(deps.filesDir, fileNameOf(clientId));
      await keep(path, o.file.bytes);
      file = { path, mediaType: o.file.mediaType, name: o.file.name, size: o.file.bytes.byteLength };
    }
    const { file: _bytes, ...rest } = o;
    let m: SupportMessage;
    try {
      m = s.addOwn({ ...rest, ...(file ? { file } : {}), clientId, at: now() });
    } catch (err) {
      if (file) await rm(file.path, { force: true });
      throw err;
    }
    return deliver(d, s, m.key, { clientId, pubkey: o.pubkey, ...(o.text ? { text: o.text } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(file ? { file } : {}) });
  };

  /** Bytes written whole or not at all, owner-only. */
  const keep = async (path: string, bytes: Buffer) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  };

  const settingsOf = async (s: SupportStore): Promise<SupportSettings> => {
    const photo = s.photo();
    const base64 = photo ? await readFile(deps.photoFile).then((b) => b.toString("base64"), () => undefined) : undefined;
    return { ...s.welcome(), payoutLines: s.payoutLines(), ...(photo ? { photo: { ...photo, ...(base64 ? { base64 } : {}) } } : {}) };
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
        const path = join(deps.filesDir, fileNameOf(f.id));
        await keep(path, bytes);
        const type = res.headers.get("content-type")?.split(";")[0]?.trim();
        // The feed names a file by its type (a Sphinx file message carries no
        // name); the sender's own name comes with the bytes.
        s.fileKept(f.key, path, bytes.byteLength, type && type !== "application/octet-stream" ? type : undefined, fileNameIn(res.headers.get("content-disposition")));
      } catch (err) {
        s.fileFailed(f.key, f.tries + 1 >= FILE_TRIES ? "failed" : "fetching", err instanceof Error ? err.message : String(err));
      }
    }
  };

  /** §6: a worker's message unread `HEADS_UP_AFTER_MS` — each admin Support
   *  knows gets the count, no content, at most once an hour. */
  const headsUps = async (d: SupportDaemon, s: SupportStore) => {
    const w = s.waiting();
    if (!w.unread || w.oldest === undefined || now() - w.oldest < HEADS_UP_AFTER_MS) return;
    for (const a of s.admins()) {
      if (!s.claimHeadsUp(a.actor, now(), HEADS_UP_EVERY_MS)) continue;
      await sendNew(d, s, { pubkey: a.pubkey, text: `${w.unread} message${w.unread === 1 ? "" : "s"} waiting in Support`, by: "heads-up" satisfies SupportAuto });
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
        await headsUps(d, s);
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
    async conversations(q, o = {}) {
      const { s } = await ready();
      if (o.filter !== undefined && !FILTERS.includes(o.filter)) throw new SupportError("bad_request", `filter is one of ${FILTERS.join(", ")}`);
      if (o.filter === "mine" && !o.me) throw new SupportError("bad_request", "mine needs a signed-in admin's name");
      return { conversations: s.conversations(q ?? "", { ...(o.filter ? { filter: o.filter } : {}), ...(o.me ? { me: o.me } : {}) }) };
    },

    async unread() {
      const { s } = await ready();
      return s.unread();
    },

    async thread(worker, o = {}) {
      const { s } = await ready();
      const conversation = conversationOf(s, worker, o.me);
      const limit = Math.min(Math.max(1, o.limit ?? THREAD_PAGE), 500);
      return { conversation, ...s.messages(conversation.pubkey, { ...(o.before !== undefined ? { before: o.before } : {}), limit }) };
    },

    async send(worker, body, by) {
      const { d, s } = await ready();
      const c = conversationOf(s, worker);
      if (body.retry !== undefined) {
        const own = s.own(c.pubkey, body.retry);
        if (!own || own.deleted) throw new SupportError("unknown_message", `no message ${body.retry} of Support's in ${worker}'s conversation`);
        // Only a failed one goes again, once however many ask, under the id
        // it first went with.
        if (!s.claimRetry(own.message.key)) return { message: own.message };
        return {
          message: await deliver(d, s, own.message.key, {
            clientId: own.clientId,
            pubkey: c.pubkey,
            ...(own.text ? { text: own.text } : {}),
            ...(own.message.replyTo ? { replyTo: own.message.replyTo } : {}),
            ...(own.file ? { file: own.file } : {}),
          }),
        };
      }
      const text = typeof body.text === "string" && body.text.trim() ? body.text : undefined;
      const file = body.file === undefined ? undefined : fileOf(body.file);
      if (!text && !file) throw new SupportError("bad_request", "text is the message: a non-empty string (or a file's caption)");
      // The daemon's own measure, refused here before anything is kept.
      const size = Buffer.byteLength(JSON.stringify({ content: text ?? "", ...(body.replyTo ? { replyUuid: body.replyTo } : {}) }), "utf8");
      if (size > SUPPORT_SEND_MAX_BYTES) throw new SupportError("bad_request", `too long: ${size} bytes as a message, at most ${SUPPORT_SEND_MAX_BYTES}`);
      return { message: await sendNew(d, s, { pubkey: c.pubkey, ...(text ? { text } : {}), ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(by ? { by } : {}), ...(file ? { file } : {}) }) };
    },

    async remove(worker, key) {
      const { d, s } = await ready();
      const c = conversationOf(s, worker);
      const own = s.own(c.pubkey, key);
      if (!own) throw new SupportError("unknown_message", `no message ${key} of Support's in ${worker}'s conversation: Support deletes only its own`);
      if (own.deleted) return { message: own.message };
      const id = own.message.id;
      if (!id) {
        // Nothing went out: strut's copy alone.
        if (own.message.status !== "failed") throw new SupportError("bad_request", "still sending: delete it once the daemon has answered");
        s.markDeleted(key);
        return { message: s.message(key)! };
      }
      const res = await call(d, "POST", `/dm/${encodeURIComponent(id)}/delete`);
      if (!res.ok) {
        const r = await refusal(res);
        throw new SupportError("daemon_error", `the daemon did not delete it: ${r.code ? `${r.code}: ` : ""}${r.error}`);
      }
      s.markDeleted(key);
      return { message: s.message(key)! };
    },

    async update(worker, body, me) {
      const { s } = await ready();
      const c = conversationOf(s, worker);
      if (body.status !== undefined && body.status !== "open" && body.status !== "done") throw new SupportError("bad_request", 'status is "open" or "done"');
      if (body.assignee !== undefined && body.assignee !== null && body.assignee !== "me") throw new SupportError("bad_request", 'assignee is "me" (take it) or null (let it go)');
      if (body.status === undefined && body.assignee === undefined) throw new SupportError("bad_request", "the body is { status?, assignee? }");
      if (body.assignee === "me" && !me) throw new SupportError("bad_request", "taking a conversation needs a signed-in admin's name");
      s.setConversation(c.pubkey, {
        ...(body.status !== undefined ? { status: body.status as ConversationStatus } : {}),
        ...(body.assignee !== undefined ? { assignee: body.assignee === "me" ? me! : null } : {}),
      });
      return { conversation: conversationOf(s, worker, me) };
    },

    async seen(worker, by) {
      const { s } = await ready();
      const c = conversationOf(s, worker);
      s.seen(c.pubkey, by, now());
      return { conversation: conversationOf(s, worker, by) };
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
      return { settings: await settingsOf(s) };
    },

    async saveSettings(body, by) {
      const { s } = await ready();
      if (body.welcome === undefined && body.payoutLines === undefined) throw new SupportError("bad_request", "the settings are welcome and payoutLines");
      if (body.welcome !== undefined && typeof body.welcome !== "string") throw new SupportError("bad_request", 'welcome is the text, "" to send none');
      if (typeof body.welcome === "string" && body.welcome.length > WELCOME_MAX) throw new SupportError("bad_request", `the welcome is at most ${WELCOME_MAX} characters`);
      if (body.payoutLines !== undefined && typeof body.payoutLines !== "boolean") throw new SupportError("bad_request", "payoutLines is true or false");
      if (typeof body.welcome === "string") s.saveWelcome(body.welcome, by, now());
      if (typeof body.payoutLines === "boolean") s.setPayoutLines(body.payoutLines);
      return { settings: await settingsOf(s) };
    },

    async savePhoto(photo, by) {
      const { d, s } = await ready();
      if (photo === null) {
        const res = await call(d, "DELETE", "/dm/photo");
        if (!res.ok) {
          const r = await refusal(res);
          throw new SupportError("daemon_error", `the daemon did not clear the picture: ${r.code ? `${r.code}: ` : ""}${r.error}`);
        }
        s.setPhoto(undefined);
        await rm(deps.photoFile, { force: true });
        return { settings: await settingsOf(s) };
      }
      const type = typeof photo.type === "string" ? photo.type.toLowerCase() : "";
      if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new SupportError("bad_request", "type is the picture's: image/jpeg, image/png, image/webp or image/gif");
      const bytes = bytesOf(photo.base64, SUPPORT_PHOTO_MAX_BYTES, "the picture");
      const res = await call(d, "PUT", "/dm/photo", { data: bytes.toString("base64"), type }, SEND_TIMEOUT_MS);
      const b = res.ok ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : {};
      if (!res.ok || typeof b["url"] !== "string" || !b["url"]) {
        const r = res.ok ? { error: "it answered no url" } : await refusal(res);
        throw new SupportError("daemon_error", `the daemon did not take the picture: ${"code" in r && r.code ? `${r.code}: ` : ""}${r.error}`);
      }
      await keep(deps.photoFile, bytes);
      s.setPhoto({ url: b["url"], mediaType: type, savedAt: now(), ...(by ? { savedBy: by } : {}) });
      return { settings: await settingsOf(s) };
    },

    async paidOut(p) {
      try {
        const d = await deps.daemon();
        if (!d) return;
        const s = await store();
        const c = s.conversation(p.worker);
        if (!c || !s.payoutLines()) return;
        const sats = Math.round(p.msat / 1000);
        // Its id made from the payout's: a second call keeps nothing new.
        const clientId = createHash("sha256").update(`payout ${p.key}`).digest("hex");
        if (s.hasClientId(clientId)) return;
        await sendNew(d, s, { pubkey: c.pubkey, text: `Paid you ${sats.toLocaleString("en-US")} sat${sats === 1 ? "" : "s"}`, by: "payout" satisfies SupportAuto }, clientId);
      } catch (err) {
        console.warn(`[support] the payout's line could not be sent: ${err instanceof Error ? err.message : String(err)}`);
      }
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

/** Bytes a page sent as base64, at most `max`, not empty. */
function bytesOf(v: unknown, max: number, what: string): Buffer {
  if (typeof v !== "string" || !v || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new SupportError("bad_request", `${what} is base64`);
  const bytes = Buffer.from(v, "base64");
  if (!bytes.byteLength) throw new SupportError("bad_request", `${what} is empty`);
  if (bytes.byteLength > max) throw new SupportError("bad_request", `${what} is ${bytes.byteLength} bytes, at most ${max}`);
  return bytes;
}

/** A staff file (§3): its bytes, at most `SUPPORT_SEND_FILE_MAX_BYTES`; a
 *  type such as `image/jpeg`; a name with no path in it. */
function fileOf(v: unknown): { bytes: Buffer; mediaType: string; name: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SupportError("bad_request", "file is { base64, type, name }");
  const f = v as Record<string, unknown>;
  const type = typeof f["type"] === "string" ? f["type"].trim().toLowerCase() : "";
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) throw new SupportError("bad_request", "file.type is its media type, such as image/jpeg or application/pdf");
  const name = typeof f["name"] === "string" ? f["name"].replace(/[\\/\x00-\x1f\x7f]/g, "_").trim().slice(0, 200) : "";
  return { bytes: bytesOf(f["base64"], SUPPORT_SEND_FILE_MAX_BYTES, "the file"), mediaType: type, name: name || "file" };
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
