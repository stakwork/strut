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
  welcome_due integer,
  first_at integer not null,
  status text not null default 'open' check (status in ('open', 'done')),
  assignee text
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
 *  (`TaskDb.migrate`). Safe to run again. A file item 1 made gets item 2's
 *  columns (plans/support-chat.md §4: a conversation's `status` and
 *  `assignee`). */
export function supportSchema(db: TaskDb): void {
  db.exec(SCHEMA);
  const has = new Set((db.prepare("pragma table_info(support_conversations)").all() as Row[]).map((r) => r.name));
  if (!has.has("status")) db.exec("alter table support_conversations add column status text not null default 'open' check (status in ('open', 'done'))");
  if (!has.has("assignee")) db.exec("alter table support_conversations add column assignee text");
}

export const KINDS = ["message", "file", "payment", "contact"] as const;
export type SupportKind = (typeof KINDS)[number];
export type SendStatus = "sending" | "sent" | "failed";
export type FileState = "fetching" | "kept" | "too_large" | "failed";

/** Who Support's automatic messages are `by`, never an admin's actor: the
 *  welcome (§5), a payout's line and the staff's heads-up (§6). */
export const AUTO = ["welcome", "payout", "heads-up"] as const;
export type SupportAuto = (typeof AUTO)[number];
export const WELCOME_BY: SupportAuto = "welcome";

/** One record of the daemon's `GET /dms` as strut keeps it (§7). */
export interface Dm {
  seq: number;
  /** The Sphinx id: absent only on a send of strut's that failed before
   *  anything went out. */
  id?: string;
  clientId?: string;
  /** ms. */
  at: number;
  /** The record named no time: `at` is when strut read it, which says
   *  nothing about the welcome's save (ruling 8). */
  untimed?: true;
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
  /** Sent by strut on its own: the welcome (§5), a payout's line or the
   *  staff's heads-up (§6). */
  auto?: SupportAuto;
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
  /** `done` until a worker writes again. */
  status: ConversationStatus;
  /** Who took it, as the asker sees it (ruling 4: no names): `me`, or
   *  `other` for another admin. */
  assigned?: "me" | "other";
}

export type ConversationStatus = "open" | "done";
/** The conversations a list shows: `open` ones, the asker's (`mine`, open),
 *  `unassigned` (open), `done`, or `all`. */
export const FILTERS = ["all", "open", "mine", "unassigned", "done"] as const;
export type SupportFilter = (typeof FILTERS)[number];

export interface WelcomeSettings {
  /** The welcome's text; "" is none: no welcome goes (ruling 7). */
  welcome: string;
  /** Since when a new contact is welcomed (ruling 8): the save that turned
   *  it on. Saving again keeps it; clearing the text drops it. */
  since?: number;
  savedAt?: number;
  savedBy?: string;
}

/** Support's picture as kept (the daemon's memes `/public` URL, sent as
 *  `img` on every message), its bytes in `<dataDir>/support/photo`. */
export interface SupportPhoto {
  url: string;
  mediaType: string;
  savedAt: number;
  savedBy?: string;
}

/** A file of strut's own sends: its copy, under `<dataDir>/support/files/`. */
export interface OwnFile {
  path: string;
  mediaType: string;
  name: string;
  size: number;
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
/** The admins Support knows (§6): who marked a conversation seen, replied or
 *  took one. Their actors; with a conversation of their own, a contact. */
const ADMIN_ACTORS = `select seen_by from support_conversations where seen_by is not null
  union select by from support_messages where by is not null
  union select assignee from support_conversations where assignee is not null`;

export class SupportStore {
  private readonly s: Record<string, StatementSync>;

  /** On a file `supportSchema` made. */
  constructor(private readonly db: TaskDb) {
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      state: p("select value from support_state where key = ?"),
      setState: p("insert into support_state (key, value) values (?, ?) on conflict (key) do update set value = excluded.value"),
      addConversation: p("insert into support_conversations (pubkey, actor, alias, first_at) values (?, ?, ?, ?) on conflict do nothing"),
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
      // Strut's own message kept before it goes: a text, or a file it keeps a copy of.
      insertOwn: p(
        `insert into support_messages (pubkey, client_id, from_me, kind, text, by, reply_to, media_type, file_name, file_size, file_path, file_state, status, at)
         values (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?)`,
      ),
      // What the daemon answered a POST /dm, while nothing newer has; its id whenever it gives one.
      answered: p("update support_messages set status = ?, error = ? where key = ? and status = 'sending'"),
      answeredId: p("update support_messages set id = ? where key = ? and id is null and not exists (select 1 from support_messages where id = ?)"),
      retry: p("update support_messages set status = 'sending', error = null where key = ? and status = 'failed' and deleted = 0"),
      deleted: p("update support_messages set deleted = 1 where key = ?"),
      reopen: p("update support_conversations set status = 'open' where pubkey = ? and status = 'done'"),
      setStatus: p("update support_conversations set status = ? where pubkey = ?"),
      setAssignee: p("update support_conversations set assignee = ? where pubkey = ?"),
      // The admins Support knows (§6): who marked a conversation seen, replied
      // or took one, whose own key is one of Support's contacts.
      admins: p(`select actor, pubkey from support_conversations where actor in (${ADMIN_ACTORS}) order by actor`),
      // What waits for the heads-up: workers' unread messages, an admin's own
      // to Support left out (their answer to a heads-up is not news to them).
      waiting: p(`select count(*) n, min(m.at) oldest from support_messages m join support_conversations c on c.pubkey = m.pubkey where ${UNREAD} and c.actor not in (${ADMIN_ACTORS})`),
      thread: p("select * from support_messages where pubkey = ? and key < ? order by key desc limit ?"),
      seen: p("update support_conversations set seen_key = coalesce((select max(key) from support_messages where pubkey = ?1), 0), seen_at = ?2, seen_by = ?3 where pubkey = ?1"),
      due: p("update support_conversations set welcome_due = 1 where pubkey = ? and welcomed_at is null"),
      dueList: p("select pubkey from support_conversations where welcome_due = 1 and welcomed_at is null order by first_at"),
      welcomed: p("update support_conversations set welcomed_at = ?, welcome_due = null where pubkey = ? and welcomed_at is null"),
      undue: p("update support_conversations set welcome_due = null where pubkey = ?"),
      abandoned: p("update support_messages set status = 'failed', error = ? where from_me = 1 and status = 'sending' and id is null"),
      byKeys: p("select * from support_messages where key in (select value from json_each(?))"),
      unread: p(`select count(*) n, count(distinct m.pubkey) c from support_messages m join support_conversations c on c.pubkey = m.pubkey where ${UNREAD}`),
      list: p(
        `with conv as (
           select c.*,
             (select max(key) from support_messages m where m.pubkey = c.pubkey) last_key,
             (select count(*) from support_messages m where m.pubkey = c.pubkey and ${UNREAD}) unread
           from support_conversations c left join workers w on w.actor = c.actor
           where (?1 = '%%' or c.alias like ?1 escape '\\' or c.actor like ?1 escape '\\' or w.note like ?1 escape '\\'
             or exists (select 1 from support_messages m where m.pubkey = c.pubkey and m.deleted = 0 and m.text like ?1 escape '\\'))
             and (?3 = 'all' or (?3 = 'done' and c.status = 'done')
               or (?3 != 'done' and c.status = 'open' and (?3 = 'open' or (?3 = 'mine' and c.assignee = ?4) or (?3 = 'unassigned' and c.assignee is null))))
         )
         select * from conv order by (unread > 0) desc, last_key desc nulls last limit ?2`,
      ),
      fetching: p("select * from support_messages where file_state = 'fetching' and deleted = 0 order by key limit ?"),
      fileKept: p("update support_messages set file_state = 'kept', file_path = ?, file_size = ?, media_type = coalesce(media_type, ?), file_name = coalesce(?, file_name), error = null where key = ?"),
      fileFailed: p("update support_messages set file_state = ?, file_tries = file_tries + 1, error = ? where key = ?"),
    };
  }

  // ── state ─────────────────────────────────────────────────────────────────

  private state(key: string): string | undefined {
    const v = (this.s.state.get(key) as Row | undefined)?.value;
    return typeof v === "string" ? v : undefined;
  }

  /** The follower's cursor on the daemon at `url`: the newest `seq` read
   *  there (0 before the first). Kept per daemon, so another daemon's feed
   *  is read from its start; a record read again changes nothing. */
  cursor(url: string): number {
    return Number(this.state(`cursor ${url}`) ?? 0);
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

  /** Payout lines (§6): on until an admin turns them off. */
  payoutLines(): boolean {
    return this.state("payout lines") !== "off";
  }

  setPayoutLines(on: boolean): void {
    this.s.setState.run("payout lines", on ? "on" : "off");
  }

  /** Support's picture, or undefined for none. */
  photo(): SupportPhoto | undefined {
    const raw = this.state("photo");
    if (!raw) return undefined;
    try {
      const p = JSON.parse(raw) as SupportPhoto;
      return p && typeof p.url === "string" && p.url ? p : undefined;
    } catch {
      return undefined;
    }
  }

  setPhoto(p: SupportPhoto | undefined): void {
    this.s.setState.run("photo", p ? JSON.stringify(p) : "");
  }

  /** A heads-up to `actor` is due (§6): none went to them in the last `everyMs`. */
  headsUpDue(actor: string, now: number, everyMs: number): boolean {
    const last = Number(this.state(`heads-up ${actor}`) ?? 0);
    return !last || now - last >= everyMs;
  }

  /** A heads-up went to `actor`: the next is an hour on. */
  headsUpSent(actor: string, now: number): void {
    this.s.setState.run(`heads-up ${actor}`, String(now));
  }

  /** The admins Support knows, each with their key as Support's contact
   *  (§6): who marked a conversation seen, replied or took one, and whose
   *  actor is a conversation's — so `POST /dm` reaches them (ruling 15). */
  admins(): Array<{ actor: string; pubkey: string }> {
    return (this.s.admins.all() as Row[]).map((r) => ({ actor: r.actor as string, pubkey: r.pubkey as string }));
  }

  // ── the follower ─────────────────────────────────────────────────────────

  /**
   * One page of the daemon's feed in one transaction, the cursor with it:
   * each record's conversation made (its alias kept when it has one), its
   * message added — or, for one strut has (the same id, or strut's own send
   * by its `clientId`), changed. A new contact's key exchange newer than the
   * welcome's save marks its conversation's welcome DUE (§5), in the same
   * transaction, so a restart before it goes loses nothing (`dueWelcomes`).
   * A record that cannot be kept is skipped, never the page: one bad record
   * would hold the cursor, and every DM after it, forever. Returns how many
   * were skipped, with the first one's error.
   */
  ingest(dms: Dm[], url: string, cursor: number, since: number): { skipped: number; error?: string } {
    return this.db.tx(() => {
      const w = this.welcome();
      let skipped = 0;
      let error: string | undefined;
      for (const d of dms) {
        this.db.exec("savepoint dm");
        try {
          this.one(d, since, w);
          this.db.exec("release dm");
        } catch (err) {
          this.db.exec("rollback to dm");
          this.db.exec("release dm");
          skipped++;
          error ??= `${d.id ?? d.clientId}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      this.s.setState.run(`cursor ${url}`, String(cursor));
      return { skipped, ...(error ? { error } : {}) };
    });
  }

  private one(d: Dm, since: number, w: WelcomeSettings): void {
    this.s.addConversation.run(d.pubkey, actorOfPubkey(d.pubkey), d.alias ?? null, d.at);
    if (d.alias) this.s.setAlias.run(d.alias, d.pubkey, d.alias);
    // Strut's own send by the id it gave; everything else by its Sphinx id.
    const had = ((d.clientId ? this.s.byClientId.get(d.clientId) : undefined) ?? (d.id ? this.s.byId.get(d.id) : undefined)) as Row | undefined;
    if (had) {
      this.s.update.run(d.id ?? null, d.deleted ? 1 : 0, d.status ?? null, d.status === "failed" ? (d.error ?? "the daemon could not send it") : null, had.key as number);
      return;
    }
    // A worker writing again reopens a conversation marked done (§3).
    if (!d.fromMe && d.kind !== "contact" && !d.deleted) this.s.reopen.run(d.pubkey);
    this.s.insert.run(
      d.pubkey,
      d.id ?? null,
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
    // §5, ruling 8: only a contact newer than the save that turned the
    // welcome on; a record with no time of its own is never one.
    if (d.kind === "contact" && !d.fromMe && !d.untimed && w.welcome && w.since !== undefined && d.at >= w.since) this.s.due.run(d.pubkey);
  }

  /** The conversations whose welcome is due (§5). */
  dueWelcomes(): string[] {
    return (this.s.dueList.all() as Row[]).map((r) => r.pubkey as string);
  }

  /** A due welcome claimed and kept as Support's message, `sending`, in one
   *  transaction: at most once per worker. Undefined when it was claimed
   *  already, or the welcome was cleared since (then it is due no more). */
  startWelcome(pubkey: string, clientId: string, now: number): SupportMessage | undefined {
    return this.db.tx(() => {
      const text = this.welcome().welcome;
      if (!text) {
        this.s.undue.run(pubkey);
        return undefined;
      }
      if (Number(this.s.welcomed.run(now, pubkey).changes) === 0) return undefined;
      return this.addOwn({ pubkey, clientId, text, by: WELCOME_BY, at: now });
    });
  }

  /** Support's sends a past process left `sending` with no word from the
   *  daemon: failed, so Retry shows (it resends the same id, which the daemon
   *  sends once). Called when the store opens, before anything is sent. */
  abandonSends(): void {
    this.s.abandoned.run("strut restarted before the daemon answered: Retry sends it (once, whatever happened)");
  }

  // ── sends ─────────────────────────────────────────────────────────────────

  /** Strut's own message, kept before it is sent (§3: Retry resends it):
   *  a text, or a file strut keeps a copy of at `file.path` (item 2), its
   *  text then a caption. Throws for a `clientId` it has (a payout's line
   *  twice). */
  addOwn(o: { pubkey: string; clientId: string; text?: string; by?: string; replyTo?: string; file?: OwnFile; at: number }): SupportMessage {
    const f = o.file;
    const key = Number(
      this.s.insertOwn.run(o.pubkey, o.clientId, f ? "file" : "message", o.text ?? null, o.by ?? null, o.replyTo ?? null, f?.mediaType ?? null, f?.name ?? null, f?.size ?? null, f?.path ?? null, f ? "kept" : null, o.at).lastInsertRowid,
    );
    return this.message(key)!;
  }

  /** What the daemon answered a send, unless the feed already said; the
   *  Sphinx id it gave, at once (what a reply quotes and Delete names). */
  answered(key: number, status: "sent" | "failed" | undefined, error?: string, id?: string): void {
    this.db.tx(() => {
      if (status) this.s.answered.run(status, status === "failed" ? (error ?? "the daemon could not send it") : null, key);
      if (id) this.s.answeredId.run(id, key, id);
    });
  }

  /** A failed send made `sending` again: true for the one call that did. */
  claimRetry(key: number): boolean {
    return Number(this.s.retry.run(key).changes) > 0;
  }

  /** One of strut's own sends in `pubkey`'s thread, with the id it went
   *  under (a resend's), its text and its file. */
  own(pubkey: string, key: number): { message: SupportMessage; clientId: string; text?: string; file?: OwnFile; deleted: boolean } | undefined {
    const r = this.s.message.get(key) as Row | undefined;
    if (!r || r.pubkey !== pubkey || r.from_me !== 1 || !r.client_id || (r.text === null && !r.file_path)) return undefined;
    return {
      message: messageOf(r),
      clientId: r.client_id as string,
      ...(r.text !== null ? { text: r.text as string } : {}),
      ...(r.file_path ? { file: { path: r.file_path as string, mediaType: (r.media_type as string) ?? "application/octet-stream", name: (r.file_name as string) ?? "file", size: Number(r.file_size ?? 0) } } : {}),
      deleted: r.deleted === 1,
    };
  }

  /** A send of strut's own under this id is kept already. */
  hasClientId(clientId: string): boolean {
    return this.s.byClientId.get(clientId) !== undefined;
  }

  /** A message deleted, for strut's copy (the daemon's said, or one that
   *  never went). */
  markDeleted(key: number): void {
    this.s.deleted.run(key);
  }

  /** A conversation marked open or done, taken by an admin or let go. */
  setConversation(pubkey: string, o: { status?: ConversationStatus; assignee?: string | null }): void {
    this.db.tx(() => {
      if (o.status) this.s.setStatus.run(o.status, pubkey);
      if (o.assignee !== undefined) this.s.setAssignee.run(o.assignee, pubkey);
    });
  }

  /** Folds the file's WAL into it (this connection's). */
  close(): void {
    this.db.close();
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** `me`: the asker, whom `assigned` is told relative to. */
  conversation(actor: string, me?: string): SupportConversation | undefined {
    const row = this.s.conversation.get(actor) as Row | undefined;
    return row ? this.conversationOf(row, me) : undefined;
  }

  /** Unread first, then the newest; `q` over names, actors and text;
   *  `filter` by status and who took it (`me` is the asker). Their last
   *  messages in one read. */
  conversations(q = "", o: { filter?: SupportFilter; me?: string; limit?: number } = {}): SupportConversation[] {
    const rows = this.s.list.all(like(q.trim()), o.limit ?? 500, o.filter ?? "all", o.me ?? null) as Row[];
    const keys = rows.map((r) => r.last_key).filter((k) => k !== null && k !== undefined);
    const last = new Map((this.s.byKeys.all(JSON.stringify(keys)) as Row[]).map((m) => [m.key as number, messageOf(m)]));
    return rows.map((r) => this.conversationOf(r, o.me, last));
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

  /** Workers' unread messages and when the oldest was written: the
   *  heads-up's (§6), an admin's own left out. */
  waiting(): { unread: number; oldest?: number } {
    const r = this.s.waiting.get() as Row;
    return { unread: Number(r.n), ...(r.oldest !== null && r.oldest !== undefined ? { oldest: Number(r.oldest) } : {}) };
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

  /** A file kept: its place and size, and the type and sender's name it
   *  came with (the feed's name is only made from its type). */
  fileKept(key: number, path: string, size: number, mediaType: string | undefined, name?: string): void {
    this.s.fileKept.run(path, size, mediaType ?? null, name ?? null, key);
  }

  /** A file not kept: `too_large` for good, `fetching` to try again, `failed` for good. */
  fileFailed(key: number, state: "fetching" | "too_large" | "failed", error: string): void {
    this.s.fileFailed.run(state, error, key);
  }

  private conversationOf(r: Row, me: string | undefined, lasts?: Map<number, SupportMessage>): SupportConversation {
    const key = r.last_key === null || r.last_key === undefined ? undefined : Number(r.last_key);
    const last = key === undefined ? undefined : lasts ? lasts.get(key) : this.message(key);
    return {
      worker: r.actor as string,
      pubkey: r.pubkey as string,
      ...(r.alias ? { alias: r.alias as string } : {}),
      unread: Number(r.unread ?? 0),
      ...(last ? { last } : {}),
      ...(r.seen_at !== null && r.seen_at !== undefined ? { seenAt: Number(r.seen_at) } : {}),
      ...(r.welcomed_at !== null && r.welcomed_at !== undefined ? { welcomedAt: Number(r.welcomed_at) } : {}),
      status: r.status === "done" ? "done" : "open",
      ...(r.assignee ? { assigned: me !== undefined && r.assignee === me ? ("me" as const) : ("other" as const) } : {}),
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
    ...(AUTO.includes(r.by as SupportAuto) ? { auto: r.by as SupportAuto } : {}),
  };
}
