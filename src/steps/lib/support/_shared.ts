/**
 * What the `support/*` tools share (plans/people-and-hosts.md §5): Support's
 * tables in the app's own SQLite (`strut/staff`'s `db/001-support.sql`), the
 * daemon's DM records as Support keeps them, and a message from Support kept
 * before it goes.
 *
 * Every write here is synchronous and whole: a transaction of its own on the
 * app's one connection (src/apps/data.ts), never held across an `await`.
 * A send is kept as `sending` first, then sent through the `sphinx`
 * capability (src/payments/sphinx-dm.ts), then kept as the daemon answered,
 * unless the daemon's own record of it came first (`support/receive`).
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { AppDatabases } from "../../../apps/data.js";
import type { SphinxCapability } from "../../../payments/sphinx-dm.js";

/** The app's channel a page listens on: a message there means "read again". */
export const SUPPORT_CHANNEL = "support";
/** The workflow that sends the welcomes due (`support/send-due`). */
export const OUTBOX_WORKFLOW = "support-outbox";
/** The app Support is a tab of: the payout line's (the engine's own hook). */
export const SUPPORT_APP = "strut/staff";
/** The largest file kept from a worker (plans/support-chat.md ruling 10). */
export const RECEIVE_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** A file goes to a page in pieces this size (a multiple of 3, so the
 *  pieces' base64 joins as one): a step's result is capped at 5 MB. */
export const FILE_PIECE_BYTES = 3 * 1024 * 1024;
/** The largest file staff send from the page. */
export const SEND_FILE_MAX_BYTES = 2.5 * 1024 * 1024;
/** Support's picture, as the page sends it (shrunk to 512 px). */
export const PHOTO_MAX_BYTES = 1024 * 1024;
/** The daemon's limit on a message: its content and quoted id as JSON. */
export const SEND_MAX_BYTES = 32 * 1024;
/** What the daemon counts for a file's own fields in that limit. */
const FILE_FIELDS_BYTES = 1024;
/** A send still `sending` this long with no word may be sent again: the
 *  daemon answers in about 10 s, and sends one id once. */
export const SEND_STALE_MS = 60_000;
/** Records one `support/receive` takes. */
export const RECEIVE_MAX_RECORDS = 100;

/** Who Support's own messages are `by` when no admin sent them. */
export const AUTO_BY = ["welcome", "payout"] as const;

const PUBKEY = /^0[23][0-9a-f]{64}$/;
const KINDS = ["message", "file", "payment", "contact"] as const;
type Kind = (typeof KINDS)[number];
type SendStatus = "sending" | "sent" | "failed";

/** The actor a Sphinx key signs in to a worker app as (src/visitors.ts):
 *  `secp:` and the key without its first byte. */
export function actorOfPubkey(pubkey: string): string {
  return `secp:${pubkey.slice(2).toLowerCase()}`;
}

/** The app's database, for a step that runs for it (`ctx.app`). */
export async function supportDb(ctx: StepContext<StrutCapabilities> | undefined, type: string): Promise<DatabaseSync> {
  const app = ctx?.app;
  if (!app) throw new Error(`${type} runs for an app (ctx.app): strut/staff's page, the Sphinx daemon's call of its tools, or a run it launched`);
  const dbs = (ctx?.services as { appDb?: AppDatabases } | undefined)?.appDb;
  if (!dbs) throw new Error(`${type} needs the apps' databases (ctx.services.appDb)`);
  return dbs.open(app.name);
}

/** The `sphinx` capability, or why this call cannot send. */
export function sphinxOf(ctx: StepContext<StrutCapabilities> | undefined, type: string): SphinxCapability {
  const sphinx = (ctx?.services as Partial<StrutCapabilities> | undefined)?.sphinx;
  if (!sphinx) throw new Error(`${type} sends as Support, which only strut's own admin page (and the runs it launches) may do: this call's bag has no sphinx capability (plans/people-and-hosts.md §4)`);
  return sphinx;
}

/** One `BEGIN IMMEDIATE` … `COMMIT`, synchronous: never across an `await`. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite rolled it back itself.
    }
    throw err;
  }
}

type Row = Record<string, SQLInputValue>;
const one = (db: DatabaseSync, sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as Row | undefined;
const now = () => Date.now();

// ── the daemon's records ─────────────────────────────────────────────────────

/** One DM record as Support keeps it. */
export interface Dm {
  seq?: number;
  /** The Sphinx id: absent only on a send of Support's that failed before anything went out. */
  id?: string;
  clientId?: string;
  at: number;
  /** The record named no time: never a contact newer than the welcome's save. */
  untimed?: true;
  fromMe: boolean;
  pubkey: string;
  kind: Kind;
  text?: string;
  replyTo?: string;
  sats?: number;
  deleted?: boolean;
  mediaType?: string;
  fileName?: string;
  status?: SendStatus;
  error?: string;
  /** A worker's file, as the daemon handed it over. */
  file?: { bytes: Buffer; name?: string } | { error: string };
}

const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" && o[k] ? (o[k] as string) : undefined);

/**
 * One record of the daemon's DM feed (specs/LIGHTNING.md, "Support's DMs"),
 * or why it is not kept. As `GET /dms` gives it — `seq`, `id`, `clientId`,
 * `time`, `fromMe`, `peer { pubkey, alias }`, `kind`, `text`, `replyTo`,
 * `sats`, `deleted`, `mediaType`, `fileName`, `status`, `error` — and, on a
 * worker's file, its bytes: `file: { data: <base64>, name? }`, or
 * `fileError` when the daemon could not get them (`too_large` over 25 MiB).
 * Lenient on the time: unix seconds, ms or ISO.
 */
export function dmOf(v: unknown, at: number): Dm | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "a record is an object";
  const o = v as Record<string, unknown>;
  const peer = (o["peer"] && typeof o["peer"] === "object" ? o["peer"] : {}) as Record<string, unknown>;
  const pubkey = typeof peer["pubkey"] === "string" ? peer["pubkey"].toLowerCase() : "";
  if (!PUBKEY.test(pubkey)) return "peer.pubkey is a Sphinx key, 66 hex";
  const kind = o["kind"];
  if (!KINDS.includes(kind as Kind)) return `kind is one of ${KINDS.join(", ")}`;
  const id = str(o, "id");
  const clientId = str(o, "clientId");
  if (!id && !clientId) return "a record has an id, or a clientId (Support's own send)";
  const t = o["time"];
  const timed = typeof t === "number" && Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : typeof t === "string" && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : undefined;
  const fromMe = o["fromMe"] === true;
  const status = fromMe ? statusOf(o["status"]) : undefined;
  const sats = kind === "payment" && typeof o["sats"] === "number" && Number.isFinite(o["sats"]) ? Math.round(o["sats"]) : undefined;
  let file: Dm["file"];
  if (kind === "file" && !fromMe) {
    const f = o["file"] && typeof o["file"] === "object" ? (o["file"] as Record<string, unknown>) : undefined;
    const data = f && typeof f["data"] === "string" ? f["data"] : undefined;
    if (data !== undefined) {
      const bytes = Buffer.from(data, "base64");
      file = bytes.byteLength > RECEIVE_FILE_MAX_BYTES ? { error: "too_large" } : { bytes, ...(str(f!, "name") ? { name: str(f!, "name")! } : {}) };
    } else {
      file = { error: str(o, "fileError") ?? "the daemon handed over no bytes" };
    }
  }
  const seq = o["seq"];
  return {
    ...(typeof seq === "number" && Number.isSafeInteger(seq) ? { seq } : {}),
    ...(id ? { id } : {}),
    ...(clientId ? { clientId } : {}),
    at: Math.round(timed ?? at),
    ...(timed === undefined ? { untimed: true as const } : {}),
    fromMe,
    pubkey,
    kind: kind as Kind,
    ...(typeof o["text"] === "string" ? { text: o["text"] } : {}),
    ...(str(o, "replyTo") ? { replyTo: str(o, "replyTo")! } : {}),
    ...(sats !== undefined ? { sats } : {}),
    ...(o["deleted"] === true ? { deleted: true } : {}),
    ...(str(o, "mediaType") ? { mediaType: str(o, "mediaType")! } : {}),
    ...(str(o, "fileName") ? { fileName: str(o, "fileName")! } : {}),
    ...(status ? { status } : {}),
    ...(str(o, "error") ? { error: str(o, "error")! } : {}),
    ...(file ? { file } : {}),
  };
}

/** A send's status as the daemon says it: `sending` (or `pending`) is still
 *  going, `failed` failed, anything else went. */
function statusOf(v: unknown): SendStatus | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "pending" || v === "sending") return "sending";
  if (v === "failed") return "failed";
  return "sent";
}

/**
 * One record kept, inside the caller's transaction: its conversation made;
 * its message added — or, for one Support has (Support's own send by its
 * `clientId`, anything else by its Sphinx id), changed: its id once the
 * daemon gives one, deleted for good, a send's status. A worker writing
 * again reopens a conversation marked done. A new contact's key exchange
 * newer than the welcome's save marks its welcome DUE (plans/support-chat.md
 * §5, ruling 8). Returns whether a welcome became due.
 */
export function keepRecord(db: DatabaseSync, d: Dm, welcome: { text: string; since?: number }): boolean {
  db.prepare("INSERT INTO conversations (pubkey, actor, first_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(d.pubkey, actorOfPubkey(d.pubkey), d.at);
  const had = (d.clientId ? one(db, "SELECT key FROM messages WHERE client_id = ?", d.clientId) : undefined) ?? (d.id ? one(db, "SELECT key FROM messages WHERE id = ?", d.id) : undefined);
  if (had) {
    // The feed numbers every change: one older than what was kept (a push
    // that lost a race with a send's own answer, or with a Retry) changes nothing.
    db.prepare(
      `UPDATE messages SET id = coalesce(id, ?1), deleted = max(deleted, ?2), status = coalesce(?3, status),
         error = CASE WHEN ?3 IS NULL THEN error WHEN ?3 = 'failed' THEN ?4 ELSE NULL END, seq = coalesce(?6, seq)
       WHERE key = ?5 AND (?6 IS NULL OR seq IS NULL OR seq < ?6)`,
    ).run(d.id ?? null, d.deleted ? 1 : 0, d.status ?? null, d.status === "failed" ? (d.error ?? "the daemon could not send it") : null, had["key"] as number, d.seq ?? null);
    return false;
  }
  if (!d.fromMe && d.kind !== "contact" && !d.deleted) db.prepare("UPDATE conversations SET status = 'open' WHERE pubkey = ? AND status = 'done'").run(d.pubkey);
  const f = d.file;
  const kept = f && "bytes" in f ? f : undefined;
  const r = db
    .prepare(
      `INSERT INTO messages (pubkey, id, client_id, from_me, kind, text, reply_to, sats, deleted, status, error, media_type, file_name, file_size, file_state, seq, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.pubkey,
      d.id ?? null,
      d.clientId ?? null,
      d.fromMe ? 1 : 0,
      d.kind,
      d.text ?? null,
      d.replyTo ?? null,
      d.sats ?? null,
      d.deleted ? 1 : 0,
      d.fromMe ? (d.status ?? "sent") : null,
      d.status === "failed" ? (d.error ?? "the daemon could not send it") : f && "error" in f ? f.error : null,
      d.mediaType ?? null,
      kept?.name ?? d.fileName ?? null,
      kept ? kept.bytes.byteLength : null,
      f ? (kept ? "kept" : "error" in f && f.error === "too_large" ? "too_large" : "failed") : null,
      d.seq ?? null,
      d.at,
    );
  if (kept) db.prepare("INSERT INTO files (key, bytes) VALUES (?, ?)").run(Number(r.lastInsertRowid), kept.bytes);
  // Ruling 8: only a contact newer than the save that turned the welcome
  // on; a record with no time of its own is never one.
  if (d.kind === "contact" && !d.fromMe && !d.untimed && welcome.text.trim() && welcome.since !== undefined && d.at >= welcome.since) {
    return Number(db.prepare("UPDATE conversations SET welcome_due = 1 WHERE pubkey = ? AND welcomed_at IS NULL").run(d.pubkey).changes) > 0;
  }
  return false;
}

/** The welcome as saved. */
export function welcomeOf(db: DatabaseSync): { text: string; since?: number } {
  const r = one(db, "SELECT welcome, welcome_since FROM settings WHERE id = 1");
  const since = r?.["welcome_since"];
  return { text: typeof r?.["welcome"] === "string" ? r["welcome"] : "", ...(since !== null && since !== undefined ? { since: Number(since) } : {}) };
}

// ── Support's own messages ───────────────────────────────────────────────────

/** A message as the tools answer it: the thread's row, never a file's bytes. */
export function messageRow(db: DatabaseSync, key: number): Record<string, unknown> {
  const r = one(db, "SELECT key, pubkey, id, from_me, kind, text, reply_to, deleted, status, error, media_type, file_name, file_size, file_state, at FROM messages WHERE key = ?", key);
  if (!r) throw new Error(`no message ${key}`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
}

/** What Support sends: a text, a file (its text then a caption), a quote. */
export interface OwnMessage {
  pubkey: string;
  text?: string;
  replyTo?: string;
  /** The admin who sent it, or `welcome` / `payout`. */
  by?: string;
  file?: { bytes: Buffer; type: string; name: string };
}

/** Why a message is too long for the daemon, or undefined. */
export function tooLong(o: { text?: string; replyTo?: string; file?: unknown }): string | undefined {
  const size = Buffer.byteLength(JSON.stringify({ content: o.text ?? "", ...(o.replyTo ? { replyUuid: o.replyTo } : {}) }), "utf8") + (o.file ? FILE_FIELDS_BYTES : 0);
  return size > SEND_MAX_BYTES ? `too long: ${size} bytes as a message, at most ${SEND_MAX_BYTES}` : undefined;
}

/** Support's message kept as `sending`, a file's bytes with it, before it
 *  goes. Inside the caller's transaction. Its key. */
export function keepOwn(db: DatabaseSync, o: OwnMessage, clientId: string, at = now()): number {
  const f = o.file;
  const r = db
    .prepare(
      `INSERT INTO messages (pubkey, client_id, from_me, kind, text, reply_to, by, status, media_type, file_name, file_size, file_state, at)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'sending', ?, ?, ?, ?, ?)`,
    )
    .run(o.pubkey, clientId, f ? "file" : "message", o.text ?? null, o.replyTo ?? null, o.by ?? null, f?.type ?? null, f?.name ?? null, f ? f.bytes.byteLength : null, f ? "kept" : null, at);
  const key = Number(r.lastInsertRowid);
  if (f) db.prepare("INSERT INTO files (key, bytes) VALUES (?, ?)").run(key, f.bytes);
  return key;
}

/** A new id for a send: 64 hex. */
export const newClientId = (): string => randomBytes(32).toString("hex");

/** Sends a message kept as `sending` (`keepOwn`), its file from Support's own
 *  copy, and keeps what the daemon answered — unless its record came first.
 *  `address`: the worker's Sphinx address, for someone Support has not met
 *  (the daemon meets them there first, and keeps it for a Retry); else the
 *  conversation's pubkey. Never throws for the daemon: a refusal is the
 *  message's `failed`. */
export async function deliver(db: DatabaseSync, sphinx: SphinxCapability, key: number, address?: string): Promise<Record<string, unknown>> {
  const r = one(db, "SELECT pubkey, client_id, text, reply_to, kind, media_type, file_name FROM messages WHERE key = ?", key);
  if (!r || typeof r["client_id"] !== "string") throw new Error(`no message ${key} of Support's to send`);
  const bytes = r["kind"] === "file" ? (one(db, "SELECT bytes FROM files WHERE key = ?", key)?.["bytes"] as Uint8Array | undefined) : undefined;
  if (r["kind"] === "file" && !bytes) {
    answered(db, key, { status: "failed", error: "its file is no longer kept here" });
    return messageRow(db, key);
  }
  try {
    const answer = await sphinx.send({
      id: r["client_id"],
      to: address ?? (r["pubkey"] as string),
      ...(typeof r["text"] === "string" && r["text"] ? { text: r["text"] } : {}),
      ...(typeof r["reply_to"] === "string" ? { reply: r["reply_to"] } : {}),
      ...(bytes ? { file: { data: Buffer.from(bytes).toString("base64"), type: (r["media_type"] as string) ?? "application/octet-stream", ...(typeof r["file_name"] === "string" ? { name: r["file_name"] } : {}) } } : {}),
    });
    answered(db, key, answer);
  } catch (err) {
    answered(db, key, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  }
  return messageRow(db, key);
}

/** What the daemon answered a send, while nothing newer has (its record
 *  through `support/receive`, by its `seq`); its Sphinx id whenever it
 *  gives one. The same `seq` counts: a Retry made the row `sending` again,
 *  and the daemon may answer with the send as it already was. */
function answered(db: DatabaseSync, key: number, a: { id?: string; status: SendStatus; error?: string; seq?: number }): void {
  tx(db, () => {
    if (a.status !== "sending") {
      db.prepare("UPDATE messages SET status = ?1, error = ?2, seq = coalesce(?4, seq) WHERE key = ?3 AND status = 'sending' AND (?4 IS NULL OR seq IS NULL OR seq <= ?4)").run(
        a.status,
        a.status === "failed" ? (a.error ?? "the daemon could not send it") : null,
        key,
        a.seq ?? null,
      );
    }
    if (a.id) db.prepare("UPDATE messages SET id = ?1 WHERE key = ?2 AND id IS NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ?1)").run(a.id, key);
  });
}

/** Sends one message from Support: kept, then sent. `clientId` given: once
 *  (a payout's line), and undefined when it was kept before. */
export async function sendOwn(db: DatabaseSync, sphinx: SphinxCapability, o: OwnMessage, clientId = newClientId()): Promise<Record<string, unknown> | undefined> {
  const key = tx(db, () => (one(db, "SELECT key FROM messages WHERE client_id = ?", clientId) ? undefined : keepOwn(db, o, clientId)));
  return key === undefined ? undefined : deliver(db, sphinx, key);
}

/**
 * A payout settled (plans/human-steps.md §8.2): its line from Support —
 * "Paid you 1,200 sats" — to the worker, when they are a contact and payout
 * lines are on. Once per payout (its id made from the payout's key). The
 * engine's own: the withdrawals' `paid` hook calls it with the app's
 * database and the capability. Never throws.
 */
export async function payoutLine(db: DatabaseSync, sphinx: SphinxCapability, p: { key: string; worker: string; msat: number }): Promise<void> {
  try {
    const on = one(db, "SELECT payout_lines FROM settings WHERE id = 1")?.["payout_lines"];
    const c = one(db, "SELECT pubkey FROM conversations WHERE actor = ?", p.worker);
    if (!c || Number(on) !== 1) return;
    const sats = Math.round(p.msat / 1000);
    await sendOwn(db, sphinx, { pubkey: c["pubkey"] as string, text: `Paid you ${sats.toLocaleString("en-US")} sat${sats === 1 ? "" : "s"}`, by: "payout" }, createHash("sha256").update(`payout ${p.key}`).digest("hex"));
  } catch (err) {
    console.warn(`[support] the payout's line could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A worker's first time in Tasks (plans/support-chat.md §11): the welcome,
 * once an admin has saved one, to the Sphinx address their sign-in carried.
 * So someone who already had Peel — whose invite Peel ignored, or who came
 * by a Share link — has Support as a contact too: the daemon meets them at
 * the address first (3 sats). Never to anyone Support already has a
 * conversation with (ruling 8 leaves the backlog alone; an invite's new
 * account is welcomed by its key exchange, whichever comes first), and once
 * per worker (`welcomed_at`). The engine's own, as the payout line. Never
 * throws.
 */
export async function welcomeWorker(db: DatabaseSync, sphinx: SphinxCapability, w: { actor: string; address: string }): Promise<void> {
  try {
    const pubkey = /^(0[23][0-9a-f]{64})_0[23][0-9a-f]{64}_\d+$/.exec(w.address)?.[1];
    if (!pubkey || actorOfPubkey(pubkey) !== w.actor) return;
    const at = now();
    const key = tx(db, () => {
      const text = welcomeOf(db).text;
      if (!text.trim() || one(db, "SELECT 1 FROM conversations WHERE pubkey = ?", pubkey)) return undefined;
      db.prepare("INSERT INTO conversations (pubkey, actor, first_at, welcomed_at) VALUES (?, ?, ?, ?)").run(pubkey, w.actor, at, at);
      return keepOwn(db, { pubkey, text, by: "welcome" }, newClientId(), at);
    });
    if (key !== undefined) await deliver(db, sphinx, key, w.address);
  } catch (err) {
    console.warn(`[support] ${w.actor}'s welcome could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Bytes a page sent as base64, at most `max`, not empty. */
export function bytesOf(v: unknown, max: number, what: string): Buffer {
  if (typeof v !== "string" || !v || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new Error(`bad_request: ${what} is base64`);
  const bytes = Buffer.from(v, "base64");
  if (!bytes.byteLength) throw new Error(`bad_request: ${what} is empty`);
  if (bytes.byteLength > max) throw new Error(`bad_request: ${what} is ${bytes.byteLength} bytes, at most ${max}`);
  return bytes;
}
