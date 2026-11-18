/**
 * PEOPLE (plans/people-and-hosts.md §1): one small record per person, their
 * name, in `<dataDir>/people.db` on `node:sqlite`. Whoever learns a name
 * writes it: a host on the sign-in ticket (`host`), a person at their own
 * sign-in (`self`). Every reader goes through `names` (`nameOf` for one):
 * `GET /people`, the `people/names` step and so the kit's `useNames`.
 *
 * A name is for showing. Nothing checks it, and two people may share one.
 * It is one line, at most 80 characters, trimmed (`cleanName`). A host's
 * name is never replaced by one a person gave themself; within each kind
 * the newest wins.
 *
 * `node:sqlite` is imported on first use, and a read opens no file that is
 * not there, so a strut nobody named makes no `people.db`. `:memory:`
 * (`PEOPLE_IN_MEMORY`) is the same store in memory: tests, and a strut whose
 * run store is in memory.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** A name's most characters (code points), after trimming. */
export const NAME_MAX = 80;
/** The most actors one read asks for. */
export const PEOPLE_READ_MAX = 200;
/** The store in memory, gone with the process. */
export const PEOPLE_IN_MEMORY = ":memory:";

/** Who said a name: a host signing the person in, or the person. */
export type NameBy = "host" | "self";

/** Each actor asked, with its name when one is kept. */
export type Names = Record<string, { name?: string }>;

/** What a step reads (`ctx.services.people`): names, never a write. */
export interface PeopleReader {
  /** Each actor asked (at most `PEOPLE_READ_MAX`), with its name when one is kept. */
  names(actors: readonly string[]): Promise<Names>;
}

export interface People extends PeopleReader {
  /** The person's name, or undefined. */
  nameOf(actor: string): Promise<string | undefined>;
  /** Keeps `raw` (cleaned) as `actor`'s name, said by `by`. False when
   *  nothing was kept: no name left after cleaning, or a person's own name
   *  under one a host gave. */
  setName(actor: string, raw: unknown, by: NameBy): Promise<boolean>;
  /** Folds the WAL into the file. */
  close(): Promise<void>;
}

/** `<dataDir>/people.db`. */
export function peoplePath(dataDir: string): string {
  return join(dataDir, "people.db");
}

/** A name as kept: whitespace and control characters folded to one space,
 *  trimmed, cut at `NAME_MAX` characters. Undefined for no string or none
 *  left. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return [...line].slice(0, NAME_MAX).join("").trim() || undefined;
}

/** Every actor asked, none named yet. */
function blank(actors: readonly string[]): Names {
  if (actors.length > PEOPLE_READ_MAX) throw new Error(`at most ${PEOPLE_READ_MAX} actors at a time, not ${actors.length}`);
  return Object.fromEntries(actors.map((a) => [a, {}]));
}

async function openDb(file: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  const memory = file === PEOPLE_IN_MEMORY;
  if (!memory) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fresh = !memory && !existsSync(file);
  const db = new DatabaseSync(file);
  if (fresh) chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(
    `CREATE TABLE IF NOT EXISTS people (
       actor TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       name_by TEXT NOT NULL CHECK (name_by IN ('host', 'self')),
       name_at INTEGER NOT NULL
     )`,
  );
  return db;
}

/** The store on `file` (`peoplePath`, or `PEOPLE_IN_MEMORY`), opened on the
 *  first write, or on a read once the file is there. */
export function createPeople(file: string): People {
  let db: Promise<DatabaseSync> | undefined;
  const open = (): Promise<DatabaseSync> => {
    db ??= openDb(file);
    db.catch(() => {
      db = undefined;
    });
    return db;
  };
  const people: People = {
    async names(actors) {
      const asked = [...new Set(actors)];
      const out = blank(asked);
      if (!asked.length || !(db || file === PEOPLE_IN_MEMORY || existsSync(file))) return out;
      const rows = (await open()).prepare(`SELECT actor, name FROM people WHERE actor IN (${asked.map(() => "?").join(", ")})`).all(...asked) as Array<{ actor: string; name: string }>;
      for (const r of rows) out[r.actor] = { name: r.name };
      return out;
    },
    async nameOf(actor) {
      return (await people.names([actor]))[actor]?.name;
    },
    async setName(actor, raw, by) {
      const name = cleanName(raw);
      if (!actor || !name) return false;
      // A host's name replaces any; a person's own only their own (or none).
      const r = (await open())
        .prepare(
          `INSERT INTO people (actor, name, name_by, name_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (actor) DO UPDATE SET name = excluded.name, name_by = excluded.name_by, name_at = excluded.name_at
           WHERE excluded.name_by = 'host' OR people.name_by = 'self'`,
        )
        .run(actor, name, by, Date.now());
      return Number(r.changes) > 0;
    },
    async close() {
      const conn = await db?.catch(() => undefined);
      db = undefined;
      if (!conn) return;
      conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      conn.close();
    },
  };
  return people;
}

/** The reader a step gets: names alone, no write, no close. */
export function peopleReader(people: PeopleReader): PeopleReader {
  return Object.freeze({ names: (actors: readonly string[]) => people.names(actors) });
}

/** A signed-in visitor's reader: their own name alone. Every other actor
 *  asked answers with none. */
export function ownName(people: PeopleReader, actor: string): PeopleReader {
  return Object.freeze({
    async names(actors: readonly string[]) {
      const out = blank([...new Set(actors)]);
      if (Object.hasOwn(out, actor)) out[actor] = (await people.names([actor]))[actor] ?? {};
      return out;
    },
  });
}
