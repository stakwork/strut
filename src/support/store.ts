/**
 * Support's tables (plans/support-chat.md §4), in the task store's file
 * (`<dataDir>/tasks/tasks.db`, src/tasks/db.ts) beside the workers, on a
 * connection of Support's own: the CONVERSATIONS, keyed by the worker's
 * Sphinx pubkey; their MESSAGES, keyed by the Sphinx id and, for strut's own
 * sends, by the `clientId` strut gave the daemon; and Support's STATE (the
 * follower's cursor, when it first followed, the welcome). Made by
 * `openTaskDb` (src/tasks/tasks.ts) with the task store's own tables, so any
 * connection to the file finds them all. Every write is one transaction.
 *
 * A message's `key` is strut's own: the order it reached strut in, which is
 * the order a thread is drawn in and what "seen" counts up to.
 */
import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
// Types alone: this file is imported at boot, and db.ts loads `node:sqlite`.
import type { Row, TaskDb } from "../tasks/db.js";

const SCHEMA = `
create table if not exists support_conversations (
  pubkey text primary key,
  actor text not null unique,
  alias text,
  seen_key integer not null default 0,
  seen_at integer,
  seen_by text,
  welcomed_at integer,
  first_at integer not null
) strict;

create table if not exists support_messages (
  key integer primary key autoincrement,
  pubkey text not null,
  id text unique,
  client_id text unique,
  from_me integer not null,
  kind text not null check (kind in ('message', 'file', 'payment', 'contact')),
  text text,
  by text,
  reply_to text,
  sats integer,
  deleted integer not null default 0,
  media_type text,
  file_name text,
  file_size integer,
  file_path text,
  file_state text check (file_state in ('fetching', 'kept', 'too_large', 'failed')),
  file_tries integer not null default 0,
  status text check (status in ('sending', 'sent', 'failed')),
  error text,
  at integer not null,
  earlier integer not null default 0
) strict;
create index if not exists support_messages_thread on support_messages(pubkey, key);
create index if not exists support_messages_fetching on support_messages(file_state) where file_state = 'fetching';

create table if not exists support_state (
  key text primary key,
  value text not null
) strict, without rowid;
`;

/** Support's tables, inside the file's one migration transaction
 *  (`TaskDb.migrate`). Safe to run again. */
export function supportSchema(db: TaskDb): void {
  db.exec(SCHEMA);
}

export const KINDS = ["message", "file", "payment", "contact"] as const;
export type SupportKind = (typeof KINDS)[number];
export type SendStatus = "sending" | "sent" | "failed";
export type FileState = "fetching" | "kept" | "too_large" | "failed";

/** Who the automatic welcome is `by` (plans/support-chat.md §5): not an admin. */
export const WELCOME_BY = "welcome";

/** One record of the daemon's `GET /dms` as strut keeps it (§7). */
export interface Dm {
  seq: number;
  id: string;
  clientId?: string;
  /** ms. */
  at: number;
  fromMe: boolean;
  pubkey: string;
  alias?: string;
  kind: SupportKind;
  text?: string;
  replyTo?: string;
  sats?: number;
  deleted?: boolean;
  mediaType?: string;
  fileName?: string;
  status?: SendStatus;
  error?: string;
}

/** A message as the routes show it: a deleted one without its text or file
 *  (ruling 12), never who sent it (ruling 4). */
export interface SupportMessage {
  key: number;
  /** The Sphinx id, once the daemon has given one. */
  id?: string;
  fromMe: boolean;
  kind: SupportKind;
  text?: string;
  replyTo?: string;
  sats?: number;
  deleted?: true;
  file?: { name?: string; mediaType?: string; size?: number; state: FileState; error?: string };
  /** Strut's own sends. */
  status?: SendStatus;
  error?: string;
  at: number;
  /** Before Support first followed the daemon (§6, the backlog). */
  earlier?: true;
  /** The automatic welcome (§5). */
  welcome?: true;
}

export interface SupportConversation {
  /** The worker's actor: `secp:` and the pubkey without its first byte. */
  worker: string;
  pubkey: string;
  alias?: string;
  unread: number;
  last?: SupportMessage;
  /** When a person last marked it seen (shared by the staff). */
  seenAt?: number;
  welcomedAt?: number;
}

export interface WelcomeSettings {
  /** The welcome's text; "" is none: no welcome goes (ruling 7). */
  welcome: string;
  /** Since when a new contact is welcomed (ruling 8): the save that turned
   *  it on. Saving again keeps it; clearing the text drops it. */
  since?: number;
  savedAt?: number;
  savedBy?: string;
}

/** The actor a Sphinx contact key signs in as (src/visitors.ts): `secp:`
 *  and the key's x coordinate, the pubkey without its first byte. */
export function actorOfPubkey(pubkey: string): string {
  return `secp:${pubkey.slice(2).toLowerCase()}`;
}

/** Where a kept file goes: its id hashed, so any id names one file. */
export function fileNameOf(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}

/** `%`, `_` and `\` taken literally in a LIKE. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const UNREAD = `m.from_me = 0 and m.kind != 'contact' and m.deleted = 0 and m.key > c.seen_key`;

export class SupportStore {
  private readonly s: Record<string, StatementSync>;

  /** On a file `supportSchema` made. */
  constructor(private readonly db: TaskDb) {
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      state: p("select value from support_state where key = ?"),
      setState: p("insert into support_state (key, value) values (?, ?) on conflict (key) do update set value = excluded.value"),
      addConversation: p("insert into support_conversations (pubkey, actor, alias, first_at) values (?, ?, ?, ?) on conflict (pubkey) do nothing"),
      setAlias: p("update support_conversations set alias = ? where pubkey = ? and (alias is null or alias != ?)"),
      conversation: p(
        `select c.*, (select max(key) from support_messages m where m.pubkey = c.pubkey) last_key,
           (select count(*) from support_messages m where m.pubkey = c.pubkey and ${UNREAD}) unread
         from support_conversations c where c.actor = ?`,
      ),
      byId: p("select * from support_messages where id = ?"),
      byClientId: p("select * from support_messages where client_id = ?"),
      message: p("select * from support_messages where key = ?"),
      insert: p(
        `insert into support_messages (pubkey, id, client_id, from_me, kind, text, by, reply_to, sats, deleted, media_type, file_name, file_state, status, error, at, earlier)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      // A record that changed (§7: under a new seq, the same id): the
      // daemon's id once it gives one, deleted for good, a send's status.
      update: p(
        `update support_messages set id = coalesce(id, ?1), deleted = max(deleted, ?2), status = coalesce(?3, status),
           error = case when ?3 is null then error when ?3 = 'failed' then ?4 else null end where key = ?5`,
      ),
      // What the daemon answered a POST /dm, while nothing newer has.
      answered: p("update support_messages set status = ?, error = ? where key = ? and status = 'sending'"),
      retry: p("update support_messages set status = 'sending', error = null where key = ? and status = 'failed'"),
      thread: p("select * from support_messages where pubkey = ? and key < ? order by key desc limit ?"),
      seen: p("update support_conversations set seen_key = coalesce((select max(key) from support_messages where pubkey = ?1), 0), seen_at = ?2, seen_by = ?3 where pubkey = ?1"),
      welcomed: p("update support_conversations set welcomed_at = ? where pubkey = ? and welcomed_at is null"),
      unread: p(`select count(*) n, count(distinct m.pubkey) c from support_messages m join support_conversations c on c.pubkey = m.pubkey where ${UNREAD}`),
      list: p(
        `with conv as (
           select c.*,
             (select max(key) from support_messages m where m.pubkey = c.pubkey) last_key,
             (select count(*) from support_messages m where m.pubkey = c.pubkey and ${UNREAD}) unread
           from support_conversations c left join workers w on w.actor = c.actor
           where ?1 = '%%' or c.alias like ?1 escape '\\' or c.actor like ?1 escape '\\' or w.note like ?1 escape '\\'
             or exists (select 1 from support_messages m where m.pubkey = c.pubkey and m.deleted = 0 and m.text like ?1 escape '\\')
         )
         select * from conv order by (unread > 0) desc, last_key desc nulls last limit ?2`,
      ),
      fetching: p("select * from support_messages where file_state = 'fetching' and deleted = 0 order by key limit ?"),
      fileKept: p("update support_messages set file_state = 'kept', file_path = ?, file_size = ?, media_type = coalesce(media_type, ?), error = null where key = ?"),
      fileFailed: p("update support_messages set file_state = ?, file_tries = file_tries + 1, error = ? where key = ?"),
    };
  }

  // ── state ─────────────────────────────────────────────────────────────────

  private state(key: string): string | undefined {
    const v = (this.s.state.get(key) as Row | undefined)?.value;
    return typeof v === "string" ? v : undefined;
  }

  /** The follower's cursor: the newest `seq` read (0 before the first). */
  cursor(): number {
    return Number(this.state("cursor") ?? 0);
  }

  /** When Support first followed the daemon (ms), set once: what came
   *  before is the backlog (§6). */
  since(now: number): number {
    const had = this.state("since");
    if (had !== undefined) return Number(had);
    this.s.setState.run("since", String(now));
    return now;
  }

  welcome(): WelcomeSettings {
    const raw = this.state("welcome");
    if (!raw) return { welcome: "" };
    try {
      return JSON.parse(raw) as WelcomeSettings;
    } catch {
      return { welcome: "" };
    }
  }

  /** The welcome saved (ruling 8): turned on, its `since` is now; saved
   *  again, kept; cleared, dropped. */
  saveWelcome(text: string, by: string | undefined, now: number): WelcomeSettings {
    return this.db.tx(() => {
      const before = this.welcome();
      const welcome = text.trim() ? text : "";
      const since = welcome ? (before.welcome && before.since !== undefined ? before.since : now) : undefined;
      const next: WelcomeSettings = { welcome, ...(since !== undefined ? { since } : {}), savedAt: now, ...(by ? { savedBy: by } : {}) };
      this.s.setState.run("welcome", JSON.stringify(next));
      return next;
    });
  }

  // ── the follower ─────────────────────────────────────────────────────────

  /**
   * One page of the daemon's feed in one transaction, the cursor with it:
   * each record's conversation made (its alias kept when it has one), its
   * message added — or, for one strut has (the same id, or strut's own send
   * by its `clientId`), changed. Returns the `contact` records new here: the
   * welcome's to decide (§5).
   */
  ingest(dms: Dm[], cursor: number, since: number): Array<{ pubkey: string; at: number }> {
    return this.db.tx(() => {
      const contacts: Array<{ pubkey: string; at: number }> = [];
      for (const d of dms) {
        this.s.addConversation.run(d.pubkey, actorOfPubkey(d.pubkey), d.alias ?? null, d.at);
        if (d.alias) this.s.setAlias.run(d.alias, d.pubkey, d.alias);
        const had = (this.s.byId.get(d.id) ?? (d.clientId ? this.s.byClientId.get(d.clientId) : undefined)) as Row | undefined;
        if (had) {
          this.s.update.run(d.id, d.deleted ? 1 : 0, d.status ?? null, d.status === "failed" ? (d.error ?? "the daemon could not send it") : null, had.key as number);
          continue;
        }
        this.s.insert.run(
          d.pubkey,
          d.id,
          d.clientId ?? null,
          d.fromMe ? 1 : 0,
          d.kind,
          d.text ?? null,
          null,
          d.replyTo ?? null,
          d.sats ?? null,
          d.deleted ? 1 : 0,
          d.mediaType ?? null,
          d.fileName ?? null,
          d.kind === "file" && !d.fromMe ? "fetching" : null,
          d.fromMe ? (d.status ?? "sent") : null,
          d.status === "failed" ? (d.error ?? "the daemon could not send it") : null,
          d.at,
          d.at < since ? 1 : 0,
        );
        if (d.kind === "contact" && !d.fromMe) contacts.push({ pubkey: d.pubkey, at: d.at });
      }
      this.s.setState.run("cursor", String(cursor));
      return contacts;
    });
  }

  /** Marks the conversation welcomed: true for the one call that did (at
   *  most once per worker, §5). */
  claimWelcome(pubkey: string, now: number): boolean {
    return Number(this.s.welcomed.run(now, pubkey).changes) > 0;
  }

  // ── sends ─────────────────────────────────────────────────────────────────

  /** Strut's own message, kept before it is sent (§3: Retry resends it). */
  addOwn(o: { pubkey: string; clientId: string; text: string; by?: string; replyTo?: string; at: number }): SupportMessage {
    const key = Number(this.s.insert.run(o.pubkey, null, o.clientId, 1, "message", o.text, o.by ?? null, o.replyTo ?? null, null, 0, null, null, null, "sending", null, o.at, 0).lastInsertRowid);
    return this.message(key)!;
  }

  /** What the daemon answered a send, unless the feed already said. */
  answered(key: number, status: "sent" | "failed", error?: string): void {
    this.s.answered.run(status, status === "failed" ? (error ?? "the daemon could not send it") : null, key);
  }

  /** A failed send made `sending` again: true for the one call that did. */
  claimRetry(key: number): boolean {
    return Number(this.s.retry.run(key).changes) > 0;
  }

  /** One of strut's own sends in `pubkey`'s thread, with the id it went
   *  under (a resend's). */
  own(pubkey: string, key: number): { message: SupportMessage; clientId: string; text: string } | undefined {
    const r = this.s.message.get(key) as Row | undefined;
    if (!r || r.pubkey !== pubkey || r.from_me !== 1 || !r.client_id || r.text === null) return undefined;
    return { message: messageOf(r), clientId: r.client_id as string, text: r.text as string };
  }

  /** Folds the file's WAL into it (this connection's). */
  close(): void {
    this.db.close();
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  conversation(actor: string): SupportConversation | undefined {
    const row = this.s.conversation.get(actor) as Row | undefined;
    return row ? this.conversationOf(row) : undefined;
  }

  /** Unread first, then the newest; `q` over names, actors and text. */
  conversations(q = "", limit = 500): SupportConversation[] {
    return (this.s.list.all(like(q.trim()), limit) as Row[]).map((r) => this.conversationOf(r));
  }

  /** The thread's newest `limit` before `before` (a key), oldest first. */
  messages(pubkey: string, o: { before?: number; limit: number }): { messages: SupportMessage[]; more: boolean } {
    const rows = this.s.thread.all(pubkey, o.before ?? Number.MAX_SAFE_INTEGER, o.limit + 1) as Row[];
    const more = rows.length > o.limit;
    return { messages: rows.slice(0, o.limit).reverse().map(messageOf), more };
  }

  message(key: number): SupportMessage | undefined {
    const row = this.s.message.get(key) as Row | undefined;
    return row ? messageOf(row) : undefined;
  }

  /** A message by its Sphinx id, with its file's place: the file route's. */
  fileOf(pubkey: string, id: string): { message: SupportMessage; path?: string } | undefined {
    const row = this.s.byId.get(id) as Row | undefined;
    if (!row || row.pubkey !== pubkey) return undefined;
    return { message: messageOf(row), ...(row.file_path ? { path: row.file_path as string } : {}) };
  }

  /** Unread messages, and the conversations they are in. */
  unread(): { unread: number; conversations: number } {
    const r = this.s.unread.get() as Row;
    return { unread: Number(r.n), conversations: Number(r.c) };
  }

  /** Marked seen by `by`, up to its newest message. */
  seen(pubkey: string, by: string | undefined, now: number): void {
    this.s.seen.run(pubkey, now, by ?? null);
  }

  // ── files ─────────────────────────────────────────────────────────────────

  /** Files from workers not yet kept, oldest first. */
  fetching(limit: number): Array<{ key: number; id: string; tries: number }> {
    return (this.s.fetching.all(limit) as Row[]).map((r) => ({ key: r.key as number, id: r.id as string, tries: r.file_tries as number }));
  }

  fileKept(key: number, path: string, size: number, mediaType: string | undefined): void {
    this.s.fileKept.run(path, size, mediaType ?? null, key);
  }

  /** A file not kept: `too_large` for good, `fetching` to try again, `failed` for good. */
  fileFailed(key: number, state: "fetching" | "too_large" | "failed", error: string): void {
    this.s.fileFailed.run(state, error, key);
  }

  private conversationOf(r: Row): SupportConversation {
    const last = r.last_key === null || r.last_key === undefined ? undefined : this.message(Number(r.last_key));
    return {
      worker: r.actor as string,
      pubkey: r.pubkey as string,
      ...(r.alias ? { alias: r.alias as string } : {}),
      unread: Number(r.unread ?? 0),
      ...(last ? { last } : {}),
      ...(r.seen_at !== null && r.seen_at !== undefined ? { seenAt: Number(r.seen_at) } : {}),
      ...(r.welcomed_at !== null && r.welcomed_at !== undefined ? { welcomedAt: Number(r.welcomed_at) } : {}),
    };
  }
}

function messageOf(r: Row): SupportMessage {
  const deleted = r.deleted === 1;
  const fromMe = r.from_me === 1;
  const file =
    !deleted && r.kind === "file"
      ? {
          ...(r.file_name ? { name: r.file_name as string } : {}),
          ...(r.media_type ? { mediaType: r.media_type as string } : {}),
          ...(r.file_size !== null ? { size: Number(r.file_size) } : {}),
          state: (r.file_state ?? "failed") as FileState,
          ...(r.file_state !== "kept" && r.error ? { error: r.error as string } : {}),
        }
      : undefined;
  return {
    key: r.key as number,
    ...(r.id ? { id: r.id as string } : {}),
    fromMe,
    kind: r.kind as SupportKind,
    ...(!deleted && r.text !== null ? { text: r.text as string } : {}),
    ...(r.reply_to ? { replyTo: r.reply_to as string } : {}),
    ...(r.sats !== null ? { sats: Number(r.sats) } : {}),
    ...(deleted ? { deleted: true as const } : {}),
    ...(file ? { file } : {}),
    ...(r.status ? { status: r.status as SendStatus } : {}),
    ...(r.status === "failed" && r.error ? { error: r.error as string } : {}),
    at: Number(r.at),
    ...(r.earlier === 1 ? { earlier: true as const } : {}),
    ...(r.by === WELCOME_BY ? { welcome: true as const } : {}),
  };
}
