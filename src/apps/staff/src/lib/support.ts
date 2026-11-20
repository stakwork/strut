// Support's reads and writes (plans/people-and-hosts.md §5): SQL on this
// app's own tables (db/001-support.sql), through the kit's `useSql` and
// `useSqlMutation`. `:actor` is strut's: the admin viewing the page, which
// is how "Take it" and "Mine" know who "me" is. What touches the daemon —
// a reply, a deletion, a file, the picture — is a `support/*` tool.
import type { SupportConversation, SupportFilter, SupportMessage, SupportSettings } from "./types";

/** The app's channel: a message there means "read again". */
export const SUPPORT_CHANNEL = "support";
/** How often Support reads again besides: a channel keeps nothing. */
export const SUPPORT_REFETCH_MS = 30_000;
/** The thread's page, and what Show earlier adds. */
export const THREAD_PAGE = 200;

/** A worker's messages no admin marked seen. */
const UNREAD = "m.from_me = 0 AND m.kind != 'contact' AND m.deleted = 0 AND m.key > c.seen_key";

/** The tab's count, and whether Support has anyone yet. */
export const COUNTS_SQL = `SELECT (SELECT count(*) FROM conversations) AS conversations,
  (SELECT count(*) FROM messages m JOIN conversations c ON c.pubkey = m.pubkey WHERE ${UNREAD}) AS unread`;

/** A conversation's columns, its last message's beside them. */
const CONVERSATION = `c.pubkey, c.actor, c.seen_at, c.status, c.welcomed_at,
  CASE WHEN c.assignee IS NULL THEN NULL WHEN c.assignee = :actor THEN 'me' ELSE 'other' END AS assigned,
  (SELECT count(*) FROM messages m WHERE m.pubkey = c.pubkey AND ${UNREAD}) AS unread,
  l.key AS last_key, l.from_me AS last_from_me, l.kind AS last_kind, l.text AS last_text, l.deleted AS last_deleted,
  l.media_type AS last_media_type, l.file_name AS last_file_name, l.sats AS last_sats, l.at AS last_at
FROM conversations c LEFT JOIN messages l ON l.key = (SELECT max(key) FROM messages WHERE pubkey = c.pubkey)`;

/** The list: by status and who took it (`:filter`), unread first, then the newest. */
export const LIST_SQL = `SELECT ${CONVERSATION}
WHERE :filter = 'all' OR (:filter = 'done' AND c.status = 'done')
  OR (:filter != 'done' AND c.status = 'open' AND (:filter = 'open' OR (:filter = 'mine' AND c.assignee = :actor) OR (:filter = 'unassigned' AND c.assignee IS NULL)))
ORDER BY unread > 0 DESC, last_key DESC NULLS LAST LIMIT 500`;

/** The conversations whose messages say `:like` (names and notes are matched in the page). */
export const TEXT_MATCH_SQL = "SELECT DISTINCT pubkey FROM messages WHERE deleted = 0 AND text LIKE :like ESCAPE '\\'";

/** One worker's conversation. */
export const CONVERSATION_SQL = `SELECT ${CONVERSATION} WHERE c.actor = :worker`;

/** The thread's newest `:limit` (one more says there are earlier). */
export const THREAD_SQL = `SELECT key, id, from_me, kind, text, reply_to, sats, deleted, by, status, error, media_type, file_name, file_size, file_state, at
FROM messages WHERE pubkey = :pubkey ORDER BY key DESC LIMIT :limit`;

export const SETTINGS_SQL = "SELECT welcome, welcome_since, welcome_saved_at, payout_lines, photo, photo_type, photo_url FROM settings WHERE id = 1";

/** Seen up to its newest message, for every admin. */
export const SEEN_SQL = "UPDATE conversations SET seen_key = coalesce((SELECT max(key) FROM messages WHERE pubkey = :pubkey), 0), seen_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE pubkey = :pubkey";
export const STATUS_SQL = "UPDATE conversations SET status = :status WHERE pubkey = :pubkey";
export const TAKE_SQL = "UPDATE conversations SET assignee = :actor WHERE pubkey = :pubkey";
export const LET_GO_SQL = "UPDATE conversations SET assignee = NULL WHERE pubkey = :pubkey";
/** The schema's trigger keeps when it was turned on (ruling 8). */
export const WELCOME_SQL = "UPDATE settings SET welcome = :welcome WHERE id = 1";
export const PAYOUT_LINES_SQL = "UPDATE settings SET payout_lines = :on WHERE id = 1";

/** `%`, `_` and `\` taken literally in a LIKE. */
export const likeOf = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface ConversationRow {
  pubkey: string;
  actor: string;
  seen_at: number | null;
  status: "open" | "done";
  welcomed_at: number | null;
  assigned: "me" | "other" | null;
  unread: number;
  last_key: number | null;
  last_from_me: number | null;
  last_kind: SupportMessage["kind"] | null;
  last_text: string | null;
  last_deleted: number | null;
  last_media_type: string | null;
  last_file_name: string | null;
  last_sats: number | null;
  last_at: number | null;
}

export interface MessageRow {
  key: number;
  id: string | null;
  from_me: number;
  kind: SupportMessage["kind"];
  text: string | null;
  reply_to: string | null;
  sats: number | null;
  deleted: number;
  by: string | null;
  status: SupportMessage["status"] | null;
  error: string | null;
  media_type: string | null;
  file_name: string | null;
  file_size: number | null;
  file_state: "kept" | "too_large" | "failed" | null;
  at: number;
}

export interface SettingsRow {
  welcome: string;
  welcome_since: number | null;
  welcome_saved_at: number | null;
  payout_lines: number;
  photo: { base64: string } | null;
  photo_type: string | null;
  photo_url: string | null;
}

/** A message row as the thread draws it: a deleted one without its text or
 *  file (ruling 12), never who sent it (ruling 4) — only that strut did. */
export function messageOf(r: MessageRow): SupportMessage {
  const deleted = !!r.deleted;
  const file =
    !deleted && r.kind === "file"
      ? {
          ...(r.file_name ? { name: r.file_name } : {}),
          ...(r.media_type ? { mediaType: r.media_type } : {}),
          ...(r.file_size !== null ? { size: r.file_size } : {}),
          ...(r.file_state ? { state: r.file_state } : {}),
          ...(r.file_state && r.file_state !== "kept" && r.error ? { error: r.error } : {}),
        }
      : undefined;
  return {
    key: r.key,
    ...(r.id ? { id: r.id } : {}),
    fromMe: !!r.from_me,
    kind: r.kind,
    ...(!deleted && r.text !== null ? { text: r.text } : {}),
    ...(r.reply_to ? { replyTo: r.reply_to } : {}),
    ...(r.sats !== null ? { sats: r.sats } : {}),
    ...(deleted ? { deleted: true as const } : {}),
    ...(file ? { file } : {}),
    ...(r.status ? { status: r.status } : {}),
    ...(r.status === "failed" && r.error ? { error: r.error } : {}),
    at: r.at,
    ...(r.by === "welcome" || r.by === "payout" ? { auto: r.by } : {}),
  };
}

/** A conversation row as the list and the thread show it; `name` the worker's (`useNames`). */
export function conversationOf(r: ConversationRow, name?: string): SupportConversation {
  const last =
    r.last_key !== null && r.last_kind !== null && r.last_at !== null
      ? messageOf({
          key: r.last_key,
          id: null,
          from_me: r.last_from_me ?? 0,
          kind: r.last_kind,
          text: r.last_text,
          reply_to: null,
          sats: r.last_sats,
          deleted: r.last_deleted ?? 0,
          by: null,
          status: null,
          error: null,
          media_type: r.last_media_type,
          file_name: r.last_file_name,
          file_size: null,
          file_state: null,
          at: r.last_at,
        })
      : undefined;
  return {
    worker: r.actor,
    pubkey: r.pubkey,
    ...(name ? { alias: name } : {}),
    unread: Number(r.unread ?? 0),
    ...(last ? { last } : {}),
    ...(r.seen_at !== null ? { seenAt: r.seen_at } : {}),
    ...(r.welcomed_at !== null ? { welcomedAt: r.welcomed_at } : {}),
    status: r.status === "done" ? "done" : "open",
    ...(r.assigned ? { assigned: r.assigned } : {}),
  };
}

export function settingsOf(r: SettingsRow): SupportSettings {
  return {
    welcome: r.welcome ?? "",
    ...(r.welcome_since !== null ? { since: r.welcome_since } : {}),
    ...(r.welcome_saved_at !== null ? { savedAt: r.welcome_saved_at } : {}),
    payoutLines: r.payout_lines !== 0,
    ...(r.photo_url ? { photo: { url: r.photo_url, mediaType: r.photo_type ?? "image/jpeg", ...(r.photo?.base64 ? { base64: r.photo.base64 } : {}) } } : {}),
  };
}

/** Does a conversation show for this search? Its name (the staff's note
 *  first, then the worker's own), its actor, or a message that says it. */
export function searchHit(q: string, c: { worker: string; pubkey: string }, names: string[], textHits: ReadonlySet<string>): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return textHits.has(c.pubkey) || c.worker.toLowerCase().includes(needle) || names.some((n) => n.toLowerCase().includes(needle));
}

export type { SupportFilter };
