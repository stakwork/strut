/**
 * INSTALL COUNTS on an index (the store's "installs", as npm shows
 * downloads): a box that installs or updates a package the index lists
 * says so with one small ping, `POST /index/installs` (./install-pings.ts
 * is the box's side), and the index keeps it here. The box keeps
 * installing from where it always did — the publisher's catalog, or the
 * package's git repository — so the index is never in an install's path.
 *
 * One row per box per package per release (`digest`): a box that takes a
 * release counts once, however often it says so, and every release it
 * takes after that counts again — npm's downloads, across releases.
 * Nothing is ever deleted: every total and every window is read from the
 * rows. A ping names a random id the box made once, never its address or
 * key, so the rows say how many boxes, not which.
 *
 * A count is a box's word, not a proof: anyone can mint ids and ping. It
 * is a popularity signal, budgeted per address at the route, and never
 * what money is paid on.
 *
 * One file, `<indexDir>/installs.db`, on `node:sqlite`, opened on first use.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PACKAGE_DIGEST, PACKAGE_NAME } from "./format.js";

/** The window the store shows beside the total, in days (today included). */
export const INSTALL_RECENT_DAYS = 30;

/** A box's id: 32 hex, made once (./install-pings.ts `boxIdOf`). */
export const BOX_ID = /^[0-9a-f]{32}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SOURCE_MAX = 600;

/** What a box sends after it installs or updates a package. */
export interface InstallPing {
  package: string;
  /** The box's random id. */
  box: string;
  /** The release it installed. */
  digest: string;
  /** Where it installed it from: `pk:<key>/<name>` or `git+https://…`. */
  source: string;
  /** The commit a `git+` source was read at. */
  commit?: string;
}

/** A package's installs: all of them, and the last `INSTALL_RECENT_DAYS`. */
export interface InstallStats {
  /** Every install, all time: each box counted once per release it took. */
  total: number;
  /** Every box that ever installed it. */
  boxes: number;
  recent: {
    days: number;
    installs: number;
    boxes: number;
    /** Installs per UTC day, oldest first; the last is today. */
    daily: number[];
  };
}

/** What a search hit carries: the two numbers a card shows. */
export interface InstallSummary {
  total: number;
  recent: number;
}

/** A ping as received, checked, or why it is not one. */
export function installPingProblem(body: unknown): string | undefined {
  const p = body as Partial<InstallPing> | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "a ping is { package, box, digest, source, commit? }";
  const extra = Object.keys(p).find((k) => !["package", "box", "digest", "source", "commit"].includes(k));
  if (extra) return `${JSON.stringify(extra)} is not a member of a ping`;
  if (typeof p.package !== "string" || !PACKAGE_NAME.test(p.package)) return "package is publisher/name";
  if (typeof p.box !== "string" || !BOX_ID.test(p.box)) return "box is the box's id, 32 hex";
  if (typeof p.digest !== "string" || !PACKAGE_DIGEST.test(p.digest)) return "digest is sha256:<64 hex>";
  if (typeof p.source !== "string" || !p.source || p.source.length > SOURCE_MAX || !/^(pk:|git\+)/.test(p.source)) return `source is the pk: or git+ ref it was installed from, at most ${SOURCE_MAX} characters`;
  if (p.commit !== undefined && (typeof p.commit !== "string" || !COMMIT.test(p.commit))) return "commit is 40 hex";
  return undefined;
}

/** `YYYY-MM-DD`, UTC. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The `days` UTC days ending today, oldest first. */
function window(now: number, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(now - i * 86_400_000));
  return out;
}

const SCHEMA = `
create table if not exists installs (
  package text not null,
  box text not null,
  digest text not null,
  source text not null,
  commit_sha text,
  day text not null,
  at integer not null,
  primary key (package, box, digest)
) without rowid;
create index if not exists installs_by_day on installs (package, day);
`;

type Row = Record<string, unknown>;

export class InstallCounts {
  private constructor(private readonly db: DatabaseSync) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec(SCHEMA);
  }

  static open(file: string): InstallCounts {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fresh = !existsSync(file);
    const counts = new InstallCounts(new DatabaseSync(file));
    if (fresh) chmodSync(file, 0o600);
    return counts;
  }

  /** Keep a ping: true when it is a new install, false when this box
   *  already said it took this release. */
  add(ping: InstallPing, now = Date.now()): boolean {
    const r = this.db
      .prepare("insert or ignore into installs (package, box, digest, source, commit_sha, day, at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(ping.package, ping.box, ping.digest, ping.source, ping.commit ?? null, dayOf(now), now);
    return Number(r.changes) > 0;
  }

  /** One package's installs, all time and over the window ending today. */
  stats(pkg: string, now = Date.now(), days = INSTALL_RECENT_DAYS): InstallStats {
    const all = this.db.prepare("select count(*) as n, count(distinct box) as boxes from installs where package = ?").get(pkg) as Row;
    const days_ = window(now, days);
    const from = days_[0]!;
    const recent = this.db.prepare("select count(*) as n, count(distinct box) as boxes from installs where package = ? and day >= ?").get(pkg, from) as Row;
    const byDay = new Map((this.db.prepare("select day, count(*) as n from installs where package = ? and day >= ? group by day").all(pkg, from) as Row[]).map((r) => [r["day"] as string, Number(r["n"])]));
    return {
      total: Number(all["n"]),
      boxes: Number(all["boxes"]),
      recent: { days, installs: Number(recent["n"]), boxes: Number(recent["boxes"]), daily: days_.map((d) => byDay.get(d) ?? 0) },
    };
  }

  /** Every package's total and window count, for a list of hits. */
  summaries(now = Date.now(), days = INSTALL_RECENT_DAYS): Map<string, InstallSummary> {
    const from = window(now, days)[0]!;
    const rows = this.db.prepare("select package, count(*) as n, sum(case when day >= ? then 1 else 0 end) as recent from installs group by package").all(from) as Row[];
    return new Map(rows.map((r) => [r["package"] as string, { total: Number(r["n"]), recent: Number(r["recent"]) }]));
  }

  close(): void {
    this.db.close();
  }
}

/** `POST /index/installs`'s budget per address a minute: a bundle's parts
 *  and their updates, from one box or a few behind one address. */
export const INSTALL_PINGS_PER_MINUTE = 60;
