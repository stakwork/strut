-- SUPPORT (plans/people-and-hosts.md §5): the staff's chat with workers over
-- the treasury's Sphinx DMs, in strut/staff's own SQLite. The daemon hands
-- each DM record to `support/receive` (the host's call); the page reads these
-- tables with SQL and writes its own columns (seen, done, taken, settings);
-- the `support/*` tools send, delete, read a file and set the picture.
-- Times are ms since 1970. Nothing here was copied from Support as it was
-- built before (ruling 7).

-- One per worker who has Support as a contact: keyed by their Sphinx key.
CREATE TABLE conversations (
  pubkey TEXT PRIMARY KEY,                -- 66 hex, as the daemon spells it
  actor TEXT NOT NULL UNIQUE,             -- secp:<the key without its first byte>: the worker
  first_at INTEGER NOT NULL,
  seen_key INTEGER NOT NULL DEFAULT 0,    -- their messages past this key are unread, for every admin
  seen_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),  -- a worker writing again reopens it
  assignee TEXT,                          -- the admin who took it (never shown by name)
  welcome_due INTEGER NOT NULL DEFAULT 0, -- a new contact after the welcome's save (ruling 8)
  welcomed_at INTEGER                     -- each worker at most once
) STRICT;

-- The thread. `key` is strut's own: the order a message reached it.
CREATE TABLE messages (
  key INTEGER PRIMARY KEY AUTOINCREMENT,
  pubkey TEXT NOT NULL,                   -- the conversation
  id TEXT UNIQUE,                         -- the Sphinx id, once there is one
  client_id TEXT UNIQUE,                  -- Support's own sends: the id strut gave the daemon
  from_me INTEGER NOT NULL,               -- 1: Support's
  kind TEXT NOT NULL CHECK (kind IN ('message', 'file', 'payment', 'contact')),
  text TEXT,                              -- a file's caption
  reply_to TEXT,                          -- the Sphinx id quoted
  sats INTEGER,                           -- a payment's
  deleted INTEGER NOT NULL DEFAULT 0,     -- shown as "Message deleted", kept (ruling 12)
  by TEXT,                                -- Support's: the admin who sent it, or welcome / payout; never shown
  status TEXT CHECK (status IN ('sending', 'sent', 'failed')),  -- Support's
  error TEXT,                             -- why a send failed, or why a file is not kept
  media_type TEXT,
  file_name TEXT,
  file_size INTEGER,
  file_state TEXT CHECK (file_state IN ('kept', 'too_large', 'failed')),
  seq INTEGER,                            -- the daemon's number for what was last kept of it: an older record never undoes a newer one
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_thread ON messages (pubkey, key);

-- A file's bytes, apart from its message so a read of the thread never
-- carries them: `support/file` hands them over in pieces.
CREATE TABLE files (
  key INTEGER PRIMARY KEY,                -- the message's
  bytes BLOB NOT NULL
) STRICT;

-- One row.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  welcome TEXT NOT NULL DEFAULT '',       -- '': no welcome goes (ruling 7)
  welcome_since INTEGER,                  -- set by the trigger below (ruling 8)
  welcome_saved_at INTEGER,
  payout_lines INTEGER NOT NULL DEFAULT 1,
  photo BLOB,                             -- Support's picture, to show in settings
  photo_type TEXT,
  photo_url TEXT,                         -- what Peel loads, from the daemon
  photo_at INTEGER
) STRICT;
INSERT INTO settings (id) VALUES (1);

-- Ruling 8: a new contact is welcomed only when it is newer than the save
-- that turned the welcome on. Saving the text again keeps that time;
-- clearing it drops it, and the next save starts again from then.
CREATE TRIGGER welcome_saved AFTER UPDATE OF welcome ON settings
BEGIN
  UPDATE settings SET
    welcome_since = CASE
      WHEN trim(new.welcome) = '' THEN NULL
      WHEN trim(old.welcome) = '' OR old.welcome_since IS NULL THEN CAST(unixepoch('subsec') * 1000 AS INTEGER)
      ELSE old.welcome_since
    END,
    welcome_saved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id = new.id;
END;
