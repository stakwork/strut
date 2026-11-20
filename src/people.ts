/**
 * PEOPLE (plans/people-and-hosts.md §1, §2): one small record per person,
 * in `<dataDir>/people.db` on `node:sqlite`: their name, and the ACCOUNTS
 * they hold on other media. Whoever learns a name writes it: a host on the
 * sign-in ticket (`host`), a person at their own sign-in (`self`). Every
 * reader goes through `names` (`nameOf` for one): `GET /people`, the
 * `people/names` step and so the kit's `useNames`.
 *
 * An account is a key on a medium, `<kind>:<key>`: `sphinx:<66 hex>`, the
 * pubkey as the Sphinx daemon and an address spell it, is the one spelling
 * of a Sphinx account. A person links one through Peel (§2.1): their own
 * page shows a link challenge naming them (`account/link`), and Peel signs
 * it with the key (`POST /people/link`). `actorOf` is who an account is: the
 * person it is linked to; else, for a Sphinx key, the key's own actor
 * (`secp:<x-only>`, what a signed sign-in with that key gives), unlinked;
 * else nobody.
 *
 * A PLACE (plans/jamie-in-tribes.md §5.4) is where a person asks a host to
 * answer, as them: a spot on the host's medium (a tribe), a link the host
 * joins it by, and the LINKER's account. Strut keeps the list, and the host
 * joins and leaves to match it. To strut a place is opaque. A place goes with
 * its account: unlinking the account deletes the places it linked. Each
 * change to a host's places calls `onPlaces(host)`, which nudges the host.
 * A host says who and where it is (`hostOf`): its own account on its medium,
 * and the hook the nudge goes to.
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
import { linkChallenge } from "./auth.js";
import { qrSvg } from "./move/link.js";

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
  /** The person's name, else the name on an account that is theirs, or undefined. */
  nameOf(actor: string): Promise<string | undefined>;
  /** Keeps `raw` (cleaned) as `actor`'s name, said by `by`. False when
   *  nothing was kept: no name left after cleaning, or a person's own name
   *  under one a host gave. */
  setName(actor: string, raw: unknown, by: NameBy): Promise<boolean>;
  /** Who `account` is (§2). Undefined: nobody (`not_linked`). */
  actorOf(account: Account): Promise<AccountActor | undefined>;
  /** The link `account` has, or undefined. */
  linkOf(account: Account): Promise<AccountLink | undefined>;
  /** The accounts `actor` linked, the newest first. */
  accountsOf(actor: string): Promise<AccountLink[]>;
  /** Keeps `raw` (cleaned) as the name `account`'s holder goes by, as a
   *  host passed on what they wrote (`x-strut-account-name`, §1): on the
   *  account when it is linked (read beneath the person's own name), else as
   *  the name of the key's own actor (a Sphinx key's `secp:`), said by
   *  `self`. False when nothing changed. */
  setAccountName(account: Account, raw: unknown): Promise<boolean>;
  /** Links `account` to `actor`, replacing any link it had: whoever holds
   *  the key says whose it is. */
  link(account: Account, actor: string, extra?: { host?: string; name?: unknown; address?: unknown }): Promise<AccountLink>;
  /** Removes `actor`'s link of `account`, and the places it linked. False
   *  when they had none. */
  unlink(account: Account, actor: string): Promise<boolean>;
  /** Host `host`'s places, every linker's, each with the linker's name. */
  hostPlaces(host: string): Promise<Place[]>;
  /** The places linked by `actor`'s accounts, the newest first. */
  placesOf(actor: string): Promise<Place[]>;
  /** Links a place as `account`, whose person is `actor`. The same person
   *  again refreshes `link` and `name` (and the account); another person's
   *  place is `{ taken }`, unchanged. */
  linkPlace(place: PlaceInput, account: Account, actor: string): Promise<{ place: Place } | { taken: Place }>;
  /** Removes a place: any, for its host; `actor`'s own, for a person. False
   *  when there was none to remove. */
  unlinkPlace(host: string, key: string, actor?: string): Promise<boolean>;
  /** What host `name` said of itself, or undefined. */
  hostOf(name: string): Promise<HostSelf | undefined>;
  /** Keeps what host `name` says of itself. */
  setHost(name: string, account: Account, hook: string): Promise<HostSelf>;
  /** Folds the WAL into the file. */
  close(): Promise<void>;
}

// ── Places (plans/jamie-in-tribes.md §5.4) ───────────────────────────────

/** Where a person asks a host to answer, as them. */
export interface Place {
  /** The host's name: "sphinx". */
  host: string;
  /** The place on the host's medium: a tribe's pubkey. */
  key: string;
  /** How the host joins it: the tribe's link. */
  link: string;
  /** What the person saw it called. */
  name?: string;
  /** The linker: `<kind>:<key>`, the account their person token names. */
  account: string;
  /** The linker's name, as strut shows it (`hostPlaces` alone). */
  linkerName?: string;
  at: number;
}

/** What a person sends to link a place. */
export interface PlaceInput {
  host: string;
  key: string;
  link: string;
  name?: string;
}

/** What a host said of itself (`PUT /hosts/me`). */
export interface HostSelf {
  name: string;
  /** Its own account on its medium: `<kind>:<key>`. */
  account: string;
  /** Where strut nudges it when its places change. */
  hook: string;
  at: number;
}

/** A place's key and link, as kept: up to 200 and 2,000 printable
 *  characters, no space in the key. Strut checks no more: the host refuses
 *  a place it can't join. */
export function placeInput(raw: unknown): PlaceInput | string {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const host = typeof o["host"] === "string" ? o["host"].trim() : "";
  if (!KIND_PATTERN.test(host)) return 'host is the host\'s name: "sphinx"';
  const key = typeof o["key"] === "string" ? o["key"].trim() : "";
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) return "key is the place on the host's medium (a tribe's pubkey): 1 to 200 characters, no space";
  const link = typeof o["link"] === "string" ? o["link"].trim() : "";
  if (!link || link.length > 2_000 || /[\u0000-\u001f\u007f]/.test(link)) return "link is how the host joins the place (a tribe's link): 1 to 2,000 characters on one line";
  if (o["name"] != null && typeof o["name"] !== "string") return "name must be a string: what the place is called";
  const name = cleanName(o["name"]);
  return { host, key, link, ...(name ? { name } : {}) };
}

interface PlaceRow {
  host: string;
  key: string;
  link: string;
  name: string | null;
  account: string;
  at: number;
}

function placeOfRow(r: PlaceRow): Place {
  return { host: r.host, key: r.key, link: r.link, ...(r.name ? { name: r.name } : {}), account: r.account, at: r.at };
}

// ── Accounts (§2) ────────────────────────────────────────────────────────

/** A key on a medium. Spelled `<kind>:<key>` (`accountText`). */
export interface Account {
  kind: string;
  key: string;
}

/** Who an account is: the person it is linked to (`linked`), or a Sphinx
 *  key's own actor, which nobody linked. */
export interface AccountActor {
  actor: string;
  linked: boolean;
}

/** One account a person linked. */
export interface AccountLink {
  /** `<kind>:<key>`. */
  account: string;
  kind: string;
  key: string;
  actor: string;
  /** Where the account is reached (a Sphinx address: `<key>_<lsp>_<scid>`). */
  address?: string;
  /** The account's own name, as its holder wrote it (an alias). */
  name?: string;
  /** The host that vouched for the key, when one did (a link Peel made
   *  has none: the key signed for itself). */
  host?: string;
  at: number;
}

/** The header a host names the speaker by: `<kind>:<key>`. */
export const ACCOUNT_HEADER = "x-strut-account";
/** Beside it, the name the speaker goes by there, percent-encoded (§1). */
export const ACCOUNT_NAME_HEADER = "x-strut-account-name";
/** A kind of account, and so a host's name (`STRUT_HOST_KEYS`). */
export const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SPHINX_KEY = /^0[23][0-9a-f]{64}$/;

/** `key` on `kind` as kept, or undefined when it is not one: a Sphinx key
 *  is the 66-hex compressed pubkey, lowercase; any other kind's is up to 200
 *  printable characters with no space. */
export function accountKey(kind: string, key: unknown): string | undefined {
  if (typeof key !== "string" || !KIND_PATTERN.test(kind)) return undefined;
  const k = key.trim();
  if (kind === "sphinx") return SPHINX_KEY.test(k.toLowerCase()) ? k.toLowerCase() : undefined;
  return /^[\x21-\x7e]{1,200}$/.test(k) ? k : undefined;
}

/** `<kind>:<key>` as an account, or undefined. */
export function parseAccount(raw: unknown): Account | undefined {
  if (typeof raw !== "string") return undefined;
  const at = raw.indexOf(":");
  if (at < 1) return undefined;
  const kind = raw.slice(0, at).trim();
  const key = accountKey(kind, raw.slice(at + 1));
  return key ? { kind, key } : undefined;
}

/** The one spelling of an account: `<kind>:<key>`. */
export function accountText(a: Account): string {
  return `${a.kind}:${a.key}`;
}

/** Where `a` is reached, as kept, or undefined: a Sphinx address names the
 *  account's own key (`<key>_<lsp key>_<scid>`); another kind's is up to 300
 *  printable characters with no space. */
export function accountAddress(a: Account, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const address = raw.trim();
  if (a.kind !== "sphinx") return /^[\x21-\x7e]{1,300}$/.test(address) ? address : undefined;
  const m = /^(0[23][0-9a-f]{64})_0[23][0-9a-f]{64}_\d+$/.exec(address.toLowerCase());
  return m && m[1] === a.key ? address.toLowerCase() : undefined;
}

/** The actor a key nobody linked is, or undefined: a Sphinx key's own
 *  (`secp:<x-only>`, what a signed sign-in with that key gives — the
 *  compressed key without its parity byte). */
function ownActor(account: Account): string | undefined {
  return account.kind === "sphinx" ? `secp:${account.key.slice(2)}` : undefined;
}

interface AccountRow {
  kind: string;
  key: string;
  actor: string;
  address: string | null;
  name: string | null;
  host: string | null;
  at: number;
}

function linkOfRow(r: AccountRow): AccountLink {
  return {
    account: `${r.kind}:${r.key}`,
    kind: r.kind,
    key: r.key,
    actor: r.actor,
    ...(r.address ? { address: r.address } : {}),
    ...(r.name ? { name: r.name } : {}),
    ...(r.host ? { host: r.host } : {}),
    at: r.at,
  };
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
  // One person per account; a person may hold several.
  db.exec(
    `CREATE TABLE IF NOT EXISTS accounts (
       kind TEXT NOT NULL,
       key TEXT NOT NULL,
       actor TEXT NOT NULL,
       address TEXT,
       name TEXT,
       host TEXT,
       at INTEGER NOT NULL,
       PRIMARY KEY (kind, key)
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS accounts_actor ON accounts (actor)");
  // One linker per place; `account` is theirs, `<kind>:<key>`.
  db.exec(
    `CREATE TABLE IF NOT EXISTS places (
       host TEXT NOT NULL,
       key TEXT NOT NULL,
       link TEXT NOT NULL,
       name TEXT,
       account TEXT NOT NULL,
       at INTEGER NOT NULL,
       PRIMARY KEY (host, key)
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS places_account ON places (account)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS hosts (
       name TEXT PRIMARY KEY,
       account TEXT NOT NULL,
       hook TEXT NOT NULL,
       at INTEGER NOT NULL
     )`,
  );
  return db;
}

export interface PeopleOptions {
  /** Called after each change to host `host`'s places. */
  onPlaces?: (host: string) => void;
}

/** The store on `file` (`peoplePath`, or `PEOPLE_IN_MEMORY`), opened on the
 *  first write, or on a read once the file is there. */
export function createPeople(file: string, opts: PeopleOptions = {}): People {
  const changed = (hosts: Iterable<string>) => {
    for (const host of new Set(hosts)) {
      try {
        opts.onPlaces?.(host);
      } catch (err) {
        console.error(`[people] ${host}'s places changed, but nothing was told:`, err);
      }
    }
  };
  let db: Promise<DatabaseSync> | undefined;
  const open = (): Promise<DatabaseSync> => {
    db ??= openDb(file);
    db.catch(() => {
      db = undefined;
    });
    return db;
  };
  /** Is there anything to read? A read never makes the file. */
  const kept = () => !!db || file === PEOPLE_IN_MEMORY || existsSync(file);
  const people: People = {
    async names(actors) {
      const asked = [...new Set(actors)];
      const out = blank(asked);
      if (!asked.length || !kept()) return out;
      const conn = await open();
      const marks = (list: readonly string[]) => list.map(() => "?").join(", ");
      const rows = conn.prepare(`SELECT actor, name FROM people WHERE actor IN (${marks(asked)})`).all(...asked) as Array<{ actor: string; name: string }>;
      for (const r of rows) out[r.actor] = { name: r.name };
      // Else the name on an account that is theirs: the newest link's.
      const rest = asked.filter((a) => !out[a]!.name);
      if (!rest.length) return out;
      const linked = conn.prepare(`SELECT actor, name FROM accounts WHERE name IS NOT NULL AND actor IN (${marks(rest)}) ORDER BY at`).all(...rest) as Array<{ actor: string; name: string }>;
      for (const r of linked) out[r.actor] = { name: r.name };
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
    async actorOf(account) {
      const link = await people.linkOf(account);
      if (link) return { actor: link.actor, linked: true };
      // A Sphinx key nobody linked is its own person.
      const own = ownActor(account);
      return own ? { actor: own, linked: false } : undefined;
    },
    async setAccountName(account, raw) {
      const name = cleanName(raw);
      if (!name) return false;
      const link = await people.linkOf(account);
      if (link) {
        if (link.name === name) return false;
        (await open()).prepare("UPDATE accounts SET name = ? WHERE kind = ? AND key = ?").run(name, account.kind, account.key);
        return true;
      }
      const own = ownActor(account);
      if (!own || (await people.nameOf(own)) === name) return false;
      return people.setName(own, name, "self");
    },
    async linkOf(account) {
      if (!kept()) return undefined;
      const r = (await open()).prepare("SELECT * FROM accounts WHERE kind = ? AND key = ?").get(account.kind, account.key) as AccountRow | undefined;
      return r ? linkOfRow(r) : undefined;
    },
    async accountsOf(actor) {
      if (!kept()) return [];
      return ((await open()).prepare("SELECT * FROM accounts WHERE actor = ? ORDER BY at DESC").all(actor) as unknown as AccountRow[]).map(linkOfRow);
    },
    async link(account, actor, extra = {}) {
      const name = cleanName(extra.name);
      const address = accountAddress(account, extra.address);
      const at = Date.now();
      (await open())
        .prepare(
          `INSERT INTO accounts (kind, key, actor, address, name, host, at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, key) DO UPDATE SET actor = excluded.actor, address = excluded.address, name = excluded.name, host = excluded.host, at = excluded.at`,
        )
        .run(account.kind, account.key, actor, address ?? null, name ?? null, extra.host ?? null, at);
      return linkOfRow({ kind: account.kind, key: account.key, actor, address: address ?? null, name: name ?? null, host: extra.host ?? null, at });
    },
    async unlink(account, actor) {
      if (!kept()) return false;
      const conn = await open();
      if (Number(conn.prepare("DELETE FROM accounts WHERE kind = ? AND key = ? AND actor = ?").run(account.kind, account.key, actor).changes) === 0) return false;
      // A place goes with its account (§5.4).
      const gone = conn.prepare("DELETE FROM places WHERE account = ? RETURNING host").all(accountText(account)) as Array<{ host: string }>;
      changed(gone.map((r) => r.host));
      return true;
    },
    async hostPlaces(host) {
      if (!kept()) return [];
      const places = ((await open()).prepare("SELECT * FROM places WHERE host = ? ORDER BY at").all(host) as unknown as PlaceRow[]).map(placeOfRow);
      // The linker's name: their own, else their account's (`names`).
      const actors = new Map<string, string>();
      for (const p of places) {
        const link = await people.linkOf(parseAccount(p.account)!);
        if (link) actors.set(p.account, link.actor);
      }
      const names: Names = {};
      const unique = [...new Set(actors.values())];
      for (let i = 0; i < unique.length; i += PEOPLE_READ_MAX) Object.assign(names, await people.names(unique.slice(i, i + PEOPLE_READ_MAX)));
      return places.map((p) => {
        const linkerName = names[actors.get(p.account) ?? ""]?.name;
        return linkerName ? { ...p, linkerName } : p;
      });
    },
    async placesOf(actor) {
      if (!kept()) return [];
      const rows = (await open())
        .prepare("SELECT p.* FROM places p JOIN accounts a ON p.account = a.kind || ':' || a.key WHERE a.actor = ? ORDER BY p.at DESC")
        .all(actor) as unknown as PlaceRow[];
      return rows.map(placeOfRow);
    },
    async linkPlace(input, account, actor) {
      const conn = await open();
      const text = accountText(account);
      // Read and write with no await between: one person per place.
      const was = conn.prepare("SELECT * FROM places WHERE host = ? AND key = ?").get(input.host, input.key) as PlaceRow | undefined;
      if (was && was.account !== text) {
        const holder = conn.prepare("SELECT actor FROM accounts WHERE kind || ':' || key = ?").get(was.account) as { actor: string } | undefined;
        if (holder?.actor !== actor) return { taken: placeOfRow(was) };
      }
      const at = was?.at ?? Date.now();
      conn
        .prepare(
          `INSERT INTO places (host, key, link, name, account, at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (host, key) DO UPDATE SET link = excluded.link, name = excluded.name, account = excluded.account`,
        )
        .run(input.host, input.key, input.link, input.name ?? null, text, at);
      const place = placeOfRow({ host: input.host, key: input.key, link: input.link, name: input.name ?? null, account: text, at });
      if (!was || was.link !== place.link || was.account !== text) changed([input.host]);
      return { place };
    },
    async unlinkPlace(host, key, actor) {
      if (!kept()) return false;
      const conn = await open();
      const r =
        actor === undefined
          ? conn.prepare("DELETE FROM places WHERE host = ? AND key = ?").run(host, key)
          : conn.prepare("DELETE FROM places WHERE host = ? AND key = ? AND account IN (SELECT kind || ':' || key FROM accounts WHERE actor = ?)").run(host, key, actor);
      if (Number(r.changes) === 0) return false;
      changed([host]);
      return true;
    },
    async hostOf(name) {
      if (!kept()) return undefined;
      return ((await open()).prepare("SELECT * FROM hosts WHERE name = ?").get(name) as HostSelf | undefined) ?? undefined;
    },
    async setHost(name, account, hook) {
      const self: HostSelf = { name, account: accountText(account), hook, at: Date.now() };
      (await open())
        .prepare("INSERT INTO hosts (name, account, hook, at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET account = excluded.account, hook = excluded.hook, at = excluded.at")
        .run(self.name, self.account, self.hook, self.at);
      return self;
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

/** Peel's own link (§2.1): `peel://strut/link?url=<strut's base>&challenge=<…>`.
 *  The scheme is Peel's. */
export const PEEL_LINK = "peel://strut/link";

/** A link challenge as strut's own app shows it (`account/link`). */
export interface LinkOffer {
  challenge: string;
  exp: number;
  /** Open in Peel: `PEEL_LINK` with this strut's base and the challenge. */
  link: string;
  /** The link as a QR code, an SVG data URI, for Peel to scan. */
  qr: string;
}

/** What the `account/*` steps reach (`ctx.services.accounts`,
 *  plans/people-and-hosts.md §2.1): a person's own links, and a challenge
 *  that links one. Strut's own app's page alone calls them (the steps check). */
export interface AccountsCapability {
  /** A link challenge naming `actor`, for Peel to sign. */
  challenge(actor: string): Promise<LinkOffer>;
  links(actor: string): Promise<AccountLink[]>;
  /** False when `actor` had no link of `account` (`<kind>:<key>`). */
  unlink(actor: string, account: string): Promise<boolean>;
}

/** The capability for a page reached at `box`: `base`, where Peel posts
 *  (strut's address as the request reached it, mount path included), and
 *  `host`, the box's host name a challenge is bound to. None: the challenge
 *  is refused (a run strut started itself has no address to hand Peel). */
export function accountsCapability(people: People, box?: { base: string; host: string }): AccountsCapability {
  return Object.freeze({
    async challenge(actor: string): Promise<LinkOffer> {
      if (!box) throw new Error("a link challenge names this strut server's address: it is made for a page a person opened here (or set STRUT_PUBLIC_URL)");
      const name = await people.nameOf(actor);
      const minted = linkChallenge({ host: box.host, actor, ...(name ? { name } : {}) });
      if (!minted) throw new Error("a link challenge is signed with STRUT_API_KEY or STRUT_SECRET_KEY: set one");
      const link = `${PEEL_LINK}?url=${encodeURIComponent(box.base)}&challenge=${encodeURIComponent(minted.challenge)}`;
      return { ...minted, link, qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(link)).toString("base64")}` };
    },
    links: (actor: string) => people.accountsOf(actor),
    async unlink(actor: string, raw: string) {
      const account = parseAccount(raw);
      if (!account) throw new Error(`"${raw}" is not an account: <kind>:<key>, such as sphinx:<66 hex>`);
      return people.unlink(account, actor);
    },
  });
}
