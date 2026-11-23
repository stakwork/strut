/**
 * SUBSCRIPTIONS (plans/marketplace.md §12.1): this strut following another
 * strut's catalog — a fleet's central strut, its operator's — and applying
 * each release through the distro's door, with no ask: the publish there
 * was the accept.
 *
 * A subscription names the publisher's KEY, the strut that serves its
 * catalog (`url`, its base), a channel (or none: each package's newest
 * release not yanked) and a read token. The key is the trust: a catalog is
 * accepted only sealed by it, with a `seq` no lower than the last one
 * accepted (`readCard`, card.ts), so the connection carries no authority
 * and a stale or hostile server can serve nothing installable. The record
 * is the operator's to write (a full-scope `PUT`), kept in an encrypted
 * file beside `peers.json` since the token is a credential; what the sync
 * learned is kept beside the package cache.
 *
 * A SYNC fetches the catalog (`If-None-Match` on the one accepted), checks
 * it, fetches the archive of every release the channel holds — and of
 * every package one requires that the catalog lists — into the cache by
 * digest, and installs the whole set as one install through the distro's
 * door (§4's table, item by item). A package this subscription installed
 * that the channel no longer holds is uninstalled through the same door:
 * forks kept. One sync per subscription at a time; pings that arrive while
 * one runs are answered by one more run after it. What it could not apply
 * leaves the strut on the release it last applied, and says why.
 *
 * A subscription may follow a git BRANCH instead (plans/followed-repos.md
 * §1): `{ ref }`, a `git+https://host/org/repo[@<branch>][#<folder>]`
 * ref, read as serve mode reads one, with the token for its host (the
 * secret that serves it, src/git-hosts.ts) — the branch fetched into
 * git/checkout's bare cache, the package at its commit read into the cache,
 * skipped while the commit is the one applied. The branch is the channel:
 * a commit whose package has the digest applied installs nothing, any other
 * goes in through the same door — an older one too, so a branch moved back
 * is a rollback. A tag or a commit has nothing to follow: a full sha is
 * refused at the `PUT`, a tag at the first sync. No publisher pings one, so
 * the publisher's ping leaves it alone (`syncAll({ git: false })`); the poll
 * and `POST /packages/subscriptions/:id/sync` read it.
 *
 * THE SECRETS GATE (plans/followed-repos.md §2): every sync, of either kind,
 * checks each package's `requires.secrets` against the deployment's secrets
 * (the capability, which falls back to strut's environment, as an install's
 * `missing` does). A package that lacks one WAITS: nothing of it is
 * installed, one this subscription installed earlier is uninstalled through
 * the distro's door (edits kept), and the subscription says `waiting: {
 * secrets }`. So does a package of the set that requires a waiting one. The
 * gate runs even when nothing moved, so a secret set (or removed) since the
 * last sync is acted on with no new release. A person's install is not
 * gated: its `missing` reports, and the person decides.
 *
 * A subscription a PERSON made is theirs (stadeum plans/software.md §5,
 * item 15): the `PUT`'s actor is recorded on it, never a field of its body.
 * Every release it applies installs as that person's own install would —
 * they own the workflows it adds, so its package's schedules run as them
 * (`runsAs`, workspace.ts) — a `git+` branch is read with their OWN secret
 * alone (`deps.own`; a deployment's token is never used for it), and the
 * gate reads what their runs would (theirs, then the deployment's, then
 * env). One nobody made (the operator's key, a boot or a distro
 * subscription) installs what nobody owns, reads the deployment's token,
 * and its schedules launch nothing until an admin gives their workflows an
 * owner. A later `PUT` by another person hands the subscription to them.
 *
 * A BUNDLE (stadeum plans/software.md §3.3; `bundle:` in strut.yaml,
 * ./format.ts) is one subscription that follows several packages. A `git+`
 * subscription whose branch holds a bundle follows each package it lists as
 * a PART: a `git+` subscription of its own in all but its record — id
 * `<id>/<repo name>-<8 hex>` (`partIdOf`, the same for the same repository
 * folder at any branch), the bundle's person, its own state file — synced
 * by the bundle's sync, one after another, each exactly as a subscription
 * to its ref alone would be: its own branch, its own secrets gate, its own
 * error, installed as `subscription:<part id>`. So a part moves when its
 * branch does, with no release of the bundle, and one that waits or fails
 * holds back no other. A release of the bundle that drops a part stops it as
 * `DELETE ?uninstall=1` stops a subscription: what it installed goes through
 * the distro's door, forks kept. A release that adds one starts it. Stopping
 * the bundle stops every part, by the one rule: with `uninstall`, everything
 * it brought goes (forks kept); without, it stays as it is, and nothing
 * follows it. The `GET` lists a bundle with its `parts`, each reported as a
 * subscription is, and its `packages`, `waiting` and `held` are its parts'.
 * A bundle never lists a bundle: such a part fails, saying so.
 *
 * ONE PACKAGE, ONE SUBSCRIPTION. A package another subscription here holds
 * (`subscription:<id>` on it, a part's included) is left to it: this one
 * neither installs nor removes it, and says `held: [{ package, by }]` until
 * that one lets go — it is deleted, or drops the package — and takes it at
 * its next sync. One nobody follows — installed by hand, at boot, or by a
 * subscription since deleted — a subscription takes, as it always has: it
 * updates it through the distro's door from then on.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeBaseUrl, peerIdProblem } from "../peers.js";
import type { ShellCapability } from "../capabilities.js";
import type { SecretStore } from "../secret-store.js";
import { archiveUrl, fetchArchive } from "./archive.js";
import { resolvePackage, type PackageCache, type ResolvedPackage } from "./cache.js";
import { branchRefProblem, parseGitRef, refSource, TOKEN_SECRET_GONE } from "./git-source.js";
import { strutGitSecret, type GitSecretOf } from "../git-hosts.js";
import { readCard, releaseFor, z32Decode, type Catalog, type CatalogRelease } from "./card.js";
import type { PackageManifest } from "./format.js";
import type { InstallResult, PackageDoor } from "./install.js";
import { hasValue, type InstalledPackage } from "./installed.js";
import { CHANNEL_NAME } from "./publisher.js";

/** The encrypted file subscriptions are kept in, beside `secrets.json`. */
export const SUBSCRIPTIONS_FILE = "subscriptions.json";
const PREFIX = "S_";
const keyFor = (id: string) => `${PREFIX}${Buffer.from(id, "utf8").toString("hex").toUpperCase()}`;
const idOf = (name: string) => Buffer.from(name.slice(PREFIX.length), "hex").toString("utf8");

/** What `source.ref` an installed package records when a subscription installed it. */
export const subscriptionRef = (id: string): string => `subscription:${id}`;
const SUBSCRIPTION_REF = "subscription:";
/** The subscription, or bundle part, that installed a package: what its `source.ref` names. */
const holderOf = (p: InstalledPackage): string | undefined => (p.source?.ref.startsWith(SUBSCRIPTION_REF) ? p.source.ref.slice(SUBSCRIPTION_REF.length) : undefined);

/** A bundle's part's id: `<bundle id>/<repo name>-<8 hex of the repository
 *  folder>` — the same at any branch, so a release that moves a part to
 *  another branch follows the same part. A `/` no subscription's own id has. */
export function partIdOf(bundle: string, ref: string): string {
  const parsed = parseGitRef(ref);
  if (typeof parsed === "string") throw new Error(`subscription_invalid: ${parsed}`);
  const name = parsed.repo.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `${bundle}/${name}-${createHash("sha256").update(refSource(parsed)).digest("hex").slice(0, 8)}`;
}

/** A publisher's catalog (`key`, `url`, `channel?`, `token?`), or a git
 *  branch (`ref`): one or the other. */
export interface Subscription {
  /** The operator's name for what it follows (hive: the org's slug). */
  id: string;
  /** The publisher's key, z-base-32: the only catalog this one accepts. */
  key?: string;
  /** The base URL of the strut that serves the catalog. */
  url?: string;
  /** A channel the catalog names (`stable`); none: each package's newest release not yanked. */
  channel?: string;
  /** The read token (`POST /publisher/tokens` there), sent as `?t=` to `url` alone. */
  token?: string;
  /** A git branch's package: `git+https://host/org/repo[@<branch>][#<folder>]`
   *  (no `@`: the remote's default branch). */
  ref?: string;
  /** The person who made it: the `PUT`'s actor, never a field of its body.
   *  What it installs is theirs, as their own install is; a `git+` branch
   *  is read with their own token alone. None: nobody's. */
  actor?: string;
}

export interface SubscriptionState {
  /** The last catalog accepted (§13's order: never back). */
  accepted?: { seq: number; digest: string; at: string };
  /** The release last applied here: a catalog's `seq` and digest, or for a
   *  `git+` ref the ref, the commit last read and its package's digest;
   *  `packages`, what of it went in (not what waits). A bundle's release
   *  installs nothing itself (`packages: []`): `bundle` is its name, its
   *  version and the refs it lists, each followed as a part. */
  applied?: {
    seq?: number;
    ref?: string;
    commit?: string;
    digest: string;
    at: string;
    packages: Array<{ package: string; version: string; digest: string }>;
    bundle?: { package: string; version: string; refs: string[] };
  };
  /** The last sync: when, and what stopped it. */
  checkedAt?: string;
  error?: string;
  /** The secrets a package of the release requires and this deployment has
   *  not set (for its person, theirs or the deployment's): it is not
   *  installed until the next sync after they are. */
  waiting?: { secrets: string[] };
  /** The packages of the release another subscription here holds
   *  (`by`: `subscription:<its id>`): left to it, never installed twice. */
  held?: Array<{ package: string; by: string }>;
  /** What the last apply said without failing (a removal it could not make, a claim that did not record). */
  warnings?: string[];
}

export interface SubscriptionInfo extends Omit<Subscription, "token">, SubscriptionState {
  /** A catalog's: whether it has a read token. */
  token?: boolean;
  /** A branch's: the secret that serves its host, which it is read with
   *  (src/git-hosts.ts). Absent when none serves it: read with no token. */
  tokenSecret?: string;
  /** Each package it installed, as the workspace has it now, and the items
   *  edited here. A bundle's: every part's. */
  packages: Array<{ package: string; version?: string; digest?: string; diverged: string[] }>;
  /** A bundle's: each package it lists, in its order, reported as a
   *  subscription to that ref alone is (its own `applied`, `waiting`,
   *  `held`, `error`, `packages`). Its `waiting` and `held` are theirs too. */
  parts?: SubscriptionInfo[];
}

export interface SyncOutcome {
  id: string;
  /** `applied`: a new release is in; `current`: nothing new; `waiting`: a
   *  package lacks a secret and is not here (the rest of the set may have
   *  gone in: `result`); `held`: a package another subscription holds is
   *  left to it; `error`: see `error`. A bundle's is the most pressing of
   *  its own and its parts' (error, waiting, held, applied, current). */
  status: "applied" | "current" | "waiting" | "held" | "error";
  seq?: number;
  /** A `git+` ref's: the commit applied before, and the one the branch is at
   *  (absent when the read failed). */
  from?: string;
  to?: string;
  /** What stopped it (a bundle's: its own read, never a part's). */
  error?: string;
  /** With `waiting`: the secrets to set. */
  waiting?: { secrets: string[] };
  held?: Array<{ package: string; by: string }>;
  result?: InstallResult;
  /** A bundle's: each part's outcome, in the bundle's order. */
  parts?: SyncOutcome[];
}

const STATUS_ORDER: Array<SyncOutcome["status"]> = ["current", "applied", "held", "waiting", "error"];
/** The most pressing of several outcomes' statuses. */
const pressing = (all: Array<SyncOutcome["status"]>): SyncOutcome["status"] => all.reduce((a, b) => (STATUS_ORDER.indexOf(b) > STATUS_ORDER.indexOf(a) ? b : a), "current");
/** What a gate left out, as a state or an outcome carries it. */
const leftOut = (w?: { secrets: string[] }, h?: Array<{ package: string; by: string }>) => ({ ...(w?.secrets.length ? { waiting: w } : {}), ...(h?.length ? { held: h } : {}) });

export interface SubscriptionsDeps {
  secrets: SecretStore;
  /** `<dataDir>/packages/subscriptions/`: each subscription's state and the catalog it accepted. */
  dir: string;
  cache: PackageCache;
  /** One install of the whole set, through the distro's door: `commit`, a
   *  `git+` ref's, goes on each version's upstream. */
  install(refs: Array<{ ref: string; digest: string; commit?: string }>, opts: { door: PackageDoor; actor?: string }): Promise<InstallResult>;
  uninstall(pkg: string, opts: { door: PackageDoor }): Promise<unknown>;
  installed(): Promise<InstalledPackage[]>;
  fetch?: typeof fetch;
  /** A `git+` ref's: where `repos/` (the bare caches) lives (default the
   *  cache's parent), and git's shell. */
  dataDir?: string;
  /** A secret by NAME as a run as `actor` reads it (theirs, then the
   *  deployment's, then strut's environment), or the deployment's with no
   *  actor: the gate's `requires.secrets`, and the token of a `git+` ref
   *  nobody subscribed to. Without it, every required secret is unset. */
  secret?(name: string, actor?: string): Promise<string | undefined>;
  /** A person's OWN secret by NAME, never the deployment's: the token a
   *  `git+` subscription they made is read with. Without it, none. */
  own?(actor: string, name: string): Promise<string | undefined>;
  /** Which secret serves a `git+` ref's host (src/git-hosts.ts): the box's
   *  map; default strut's own. */
  gitSecret?: GitSecretOf;
  /** A person's own machine (`STRUT_GIT_LOCAL`): with no token for the
   *  repository's host, git keeps this machine's own credentials. */
  gitLocal?: boolean;
  shell?: ShellCapability;
}

export interface Subscriptions {
  list(): Promise<SubscriptionInfo[]>;
  get(id: string): Promise<SubscriptionInfo | undefined>;
  /** Write (or replace) a subscription; the next sync uses it. */
  set(sub: Subscription): Promise<SubscriptionInfo>;
  /** Stop following, a bundle's parts with it; with `uninstall`, every
   *  package it brought goes through the distro's door (forks kept). */
  delete(id: string, opts?: { uninstall?: boolean }): Promise<{ removed: boolean; uninstalled: string[] }>;
  sync(id: string): Promise<SyncOutcome>;
  /** Every subscription — to one publisher key, when named; `git: false`
   *  leaves the `git+` ones out (a publisher's ping: they have none). */
  syncAll(filter?: { key?: string; git?: boolean }): Promise<SyncOutcome[]>;
}

/** Why a subscription is not one, or nothing. */
export function subscriptionProblem(sub: Partial<Subscription>): string | undefined {
  const idProblem = peerIdProblem(sub.id);
  if (idProblem) return `id ${idProblem}`;
  if (sub.id === "sync") return 'id "sync" is the sync route\'s';
  if ((sub as Record<string, unknown>)["tokenSecret"] !== undefined) return TOKEN_SECRET_GONE;
  if (sub.ref !== undefined) {
    if (sub.key !== undefined || sub.url !== undefined || sub.channel !== undefined || sub.token !== undefined) {
      return "a subscription is { key, url, channel?, token? } (a catalog) or { ref } (a git branch), not both";
    }
    return branchRefProblem(sub.ref);
  }
  try {
    z32Decode(String(sub.key ?? ""));
  } catch {
    return "key is the publisher's key in z-base-32 (its GET /publisher)";
  }
  try {
    normalizeBaseUrl(sub.url);
  } catch {
    return "url is the http(s) base URL of the strut that serves the catalog";
  }
  if (sub.channel !== undefined && (typeof sub.channel !== "string" || !CHANNEL_NAME.test(sub.channel))) return "channel is a channel's name ([a-z0-9][a-z0-9._-]*)";
  if (sub.token !== undefined && (typeof sub.token !== "string" || !sub.token)) return "token is the read token the publisher minted";
  return undefined;
}

export function createSubscriptions(deps: SubscriptionsDeps): Subscriptions {
  const doFetch = deps.fetch ?? fetch;
  /** The secret that serves a `git+` ref's host, if one does. */
  const secretOfRef = (ref: string): string | undefined => {
    const parsed = parseGitRef(ref);
    return typeof parsed === "string" ? undefined : (deps.gitSecret ?? strutGitSecret)(parsed.repo.url);
  };
  const fileOf = (id: string, ext: string) => join(deps.dir, `${Buffer.from(id, "utf8").toString("hex")}.${ext}`);

  const read = async (id: string): Promise<Subscription | undefined> => {
    const raw = await deps.secrets.get(keyFor(id));
    return raw ? ({ id, ...(JSON.parse(raw) as Omit<Subscription, "id">) } as Subscription) : undefined;
  };
  const readState = async (id: string): Promise<SubscriptionState> => {
    try {
      return JSON.parse(await readFile(fileOf(id, "json"), "utf8")) as SubscriptionState;
    } catch (err: any) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  };
  const write = async (path: string, data: string | Buffer) => {
    await mkdir(deps.dir, { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  };
  const writeState = (id: string, state: SubscriptionState) => write(fileOf(id, "json"), JSON.stringify(state, null, 2));

  /** A bundle's part as a subscription of its own: the bundle's person. */
  const partOf = (bundle: Subscription, ref: string): Subscription & { ref: string } => ({ id: partIdOf(bundle.id, ref), ref, ...(bundle.actor ? { actor: bundle.actor } : {}) });

  const info = async (sub: Subscription, installed?: InstalledPackage[]): Promise<SubscriptionInfo> => {
    const { token, ...rest } = sub;
    const all = installed ?? (await deps.installed());
    const state = await readState(sub.id);
    const base = {
      ...rest,
      // A branch shows the secret it is read with; a catalog, whether it has a token.
      ...(sub.ref ? (secretOfRef(sub.ref) ? { tokenSecret: secretOfRef(sub.ref) } : {}) : { token: !!token }),
      ...state,
    };
    const refs = state.applied?.bundle?.refs;
    if (!refs) {
      const mine = all.filter((p) => holderOf(p) === sub.id);
      return {
        ...base,
        packages: mine.map((p) => ({
          package: p.package,
          ...(p.version ? { version: p.version } : {}),
          ...(p.digest ? { digest: p.digest } : {}),
          diverged: p.items.filter((i) => i.modified).map((i) => i.name),
        })),
      };
    }
    // A bundle: each part as its own subscription reports, and its parts' packages, waits and holds together.
    const parts = await Promise.all(refs.map((ref) => info(partOf(sub, ref), all)));
    const secrets = [...new Set(parts.flatMap((p) => p.waiting?.secrets ?? []))].sort();
    return { ...base, packages: parts.flatMap((p) => p.packages), ...leftOut({ secrets }, parts.flatMap((p) => p.held ?? [])), parts };
  };
  const ids = async () =>
    (await deps.secrets.list())
      .map((s) => s.name)
      .filter((n) => n.startsWith(PREFIX))
      .map(idOf)
      .sort();

  /** The catalog: fetched, or the one accepted when it has not changed. */
  const catalogOf = async (sub: Subscription, state: SubscriptionState): Promise<{ card: Catalog; digest: string; bytes: Buffer }> => {
    const base = normalizeBaseUrl(sub.url!);
    const url = `${base}/packages/catalog${sub.token ? `?t=${encodeURIComponent(sub.token)}` : ""}`;
    const kept = state.accepted ? await readFile(fileOf(sub.id, "catalog.json")).catch(() => undefined) : undefined;
    let res: Response;
    try {
      res = await doFetch(url, { headers: kept ? { "if-none-match": `"${state.accepted!.digest}"` } : {}, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new Error(`subscription_unreachable: ${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let bytes: Buffer;
    if (res.status === 304 && kept) bytes = kept;
    else if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
    else {
      const text = await res.text().catch(() => "");
      throw new Error(`subscription_refused: ${base} answered ${res.status} for its catalog${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const last = state.accepted ? { seq: state.accepted.seq, digest: state.accepted.digest } : undefined;
    const { card, digest } = readCard(bytes, { key: sub.key!, ...(last ? { last } : {}) });
    return { card, digest, bytes };
  };

  /** The releases to apply, requirements first, and every archive they need. */
  const targetsOf = (sub: Subscription, card: Catalog): Array<{ package: string; release: CatalogRelease }> => {
    const names = sub.channel !== undefined ? Object.keys(card.channels?.[sub.channel] ?? {}) : Object.keys(card.packages);
    const wanted = new Map<string, CatalogRelease>();
    for (const pkg of names.sort()) {
      const release = releaseFor(card, pkg, sub.channel);
      if (release) wanted.set(pkg, release);
    }
    // Requirements first: a package after the ones of the set it requires.
    const out: Array<{ package: string; release: CatalogRelease }> = [];
    const placed = new Set<string>();
    const place = (pkg: string, path: string[] = []) => {
      if (placed.has(pkg) || path.includes(pkg)) return;
      const release = wanted.get(pkg)!;
      for (const r of release.requires?.packages ?? []) if (wanted.has(r.package)) place(r.package, [...path, pkg]);
      placed.add(pkg);
      out.push({ package: pkg, release });
    };
    for (const pkg of wanted.keys()) place(pkg);
    return out;
  };

  const fetchAll = async (sub: Subscription, card: Catalog, targets: Array<{ package: string; release: CatalogRelease }>) => {
    const base = normalizeBaseUrl(sub.url!);
    const self = (pkg: string, digest: string) => `${archiveUrl(base, pkg, digest)}${sub.token ? `&t=${encodeURIComponent(sub.token)}` : ""}`;
    const queue = targets.map((t) => ({ package: t.package, digest: t.release.digest, urls: t.release.urls ?? [], tar: t.release.tar }));
    const done = new Set<string>();
    while (queue.length) {
      const next = queue.shift()!;
      if (done.has(next.digest)) continue;
      done.add(next.digest);
      const got = await fetchArchive({ urls: [self(next.package, next.digest), ...next.urls], digest: next.digest, cache: deps.cache, package: next.package, fetch: doFetch, ...(next.tar ? { tarSha256: next.tar.sha256 } : {}) });
      // What it requires and the catalog lists comes from the same place;
      // anything else resolves from its own source hint at install.
      for (const r of got.manifest.requires?.packages ?? []) {
        const listed = card.packages[r.package]?.releases.find((x) => x.digest === r.digest);
        if (listed) queue.push({ package: r.package, digest: r.digest, urls: listed.urls ?? [], tar: listed.tar });
      }
    }
  };

  /** What this subscription installed that is not going in (the release
   *  dropped it, it waits for a secret, or it is a part the bundle's
   *  release does not list — `parts`, the parts it does) goes out through
   *  the distro's door; what could not, said as warnings. The state of a
   *  part that went is dropped. */
  const dropOthers = async (id: string, release: Array<{ package: string }>, go: Array<{ package: string }>, warnings: string[], by: "channel" | "branch", parts = new Set<string>()) => {
    const holds = new Set(release.map((p) => p.package));
    const keep = new Set(go.map((p) => p.package));
    const stopped = new Set<string>();
    for (const p of await deps.installed()) {
      const holder = holderOf(p);
      const part = !!holder?.startsWith(`${id}/`);
      if (!(holder === id && !keep.has(p.package)) && !(part && !parts.has(holder!))) continue;
      if (part) stopped.add(holder!);
      try {
        await deps.uninstall(p.package, { door: "distro" });
      } catch (err) {
        const why = part ? "which the bundle no longer lists" : holds.has(p.package) ? "which waits for its secrets" : `which the ${by} no longer holds`;
        warnings.push(`${p.package}, ${why}, was not uninstalled: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const part of stopped) await rm(fileOf(part, "json"), { force: true });
  };

  /** Every subscription here, and every part of a bundle among them: who
   *  may hold a package. */
  const holders = async (): Promise<Set<string>> => {
    const out = new Set<string>();
    for (const id of await ids()) {
      out.add(id);
      for (const ref of (await readState(id)).applied?.bundle?.refs ?? []) out.add(partIdOf(id, ref));
    }
    return out;
  };

  /** The secrets gate (§2), over a set ordered requirements first: a
   *  package waits when its `requires.secrets` names one this deployment
   *  has not set, or when it requires a package of the set that waits. And
   *  one package, one subscription: a package another subscription here
   *  holds is left to it (`held`). `go` is what may go in; `waiting`, the
   *  secrets to set. */
  const gate = async <T extends { package: string; requires?: PackageManifest["requires"] }>(
    id: string,
    set: T[],
    actor: string | undefined,
  ): Promise<{ go: T[]; waiting?: { secrets: string[] }; held?: Array<{ package: string; by: string }> }> => {
    const others = [...(await holders())].filter((h) => h !== id);
    // Only another subscription can hold one: with none, nothing is read.
    const heldBy = new Map<string, string>();
    if (others.length) {
      for (const p of await deps.installed()) {
        const holder = holderOf(p);
        if (holder && others.includes(holder)) heldBy.set(p.package, holder);
      }
    }
    const out = new Set<string>();
    const secrets = new Set<string>();
    const held: Array<{ package: string; by: string }> = [];
    for (const t of set) {
      const by = heldBy.get(t.package);
      if (by) {
        held.push({ package: t.package, by: subscriptionRef(by) });
        continue;
      }
      for (const name of t.requires?.secrets ?? []) {
        // An empty value is none: compose hands strut an unset setting as "".
        if (hasValue(await deps.secret?.(name, actor).catch(() => undefined))) continue;
        secrets.add(name);
        out.add(t.package);
      }
      if (t.requires?.packages?.some((r) => out.has(r.package))) out.add(t.package);
    }
    return { go: set.filter((t) => !out.has(t.package) && !heldBy.has(t.package)), ...leftOut({ secrets: [...secrets].sort() }, held) };
  };
  /** The last sync put in exactly what may go in now. */
  const sameAs = (applied: SubscriptionState["applied"], go: Array<{ package: string }>) =>
    !!applied && applied.packages.map((p) => p.package).sort().join("\n") === go.map((p) => p.package).sort().join("\n");

  /** A `git+` ref: the branch read as serve mode reads it, its package
   *  installed when its digest moved. */
  const syncGit = async (sub: Subscription & { ref: string }, state: SubscriptionState, at: string): Promise<SyncOutcome> => {
    const { id, ref, actor } = sub;
    const last = state.applied?.ref === ref ? state.applied : undefined;
    const from = last?.commit;
    let to: string | undefined;
    // The token: a person's subscription reads its branch with their own
    // secret alone, never a deployment's that happens to be set; nobody's,
    // with the deployment's.
    let tokenless = false;
    const own = deps.own;
    const secret = actor
      ? async (name: string) => {
          const v = (await own?.(actor, name).catch(() => undefined)) || undefined;
          tokenless = !v;
          return v;
        }
      : deps.secret
        ? (name: string) => deps.secret!(name)
        : undefined;
    try {
      const info = await resolvePackage(ref, {
        cache: deps.cache,
        branch: true,
        ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
        ...(deps.gitSecret ? { gitSecret: deps.gitSecret } : {}),
        ...(deps.gitLocal ? { gitLocal: true } : {}),
        ...(secret ? { secret } : {}),
        ...(deps.shell ? { shell: deps.shell } : {}),
        // The branch still at the commit applied: nothing read out of git.
        ...(last?.commit ? { known: { commit: last.commit, digest: last.digest } } : {}),
      });
      to = info.commit!;
      if (info.manifest.bundle) {
        // A part is a package: a bundle lists packages, never bundles.
        if (id.includes("/")) throw new Error(`package_is_bundle: ${ref} holds the bundle ${info.manifest.package}, and a bundle lists packages, not bundles — list the packages it lists instead`);
        return await syncBundle(sub, state, at, info, from);
      }
      const { error: _error, waiting: _waiting, held: _held, ...kept } = state;
      const release = [{ package: info.manifest.package, version: info.manifest.version, digest: info.digest, requires: info.manifest.requires }];
      const { go, waiting, held } = await gate(id, release, actor);
      const out = leftOut(waiting, held);
      const status = (moved: boolean): SyncOutcome["status"] => (waiting ? "waiting" : held ? "held" : moved ? "applied" : "current");
      if (last?.digest === info.digest && sameAs(last, go)) {
        // The package did not move, and neither did the gate: the commit is recorded.
        await writeState(id, { ...kept, ...out, applied: { ...last, commit: to }, checkedAt: at });
        return { id, status: status(false), ...(from ? { from } : {}), to, ...out };
      }
      const result = go.length ? await deps.install([{ ref: subscriptionRef(id), digest: info.digest, commit: to }], { door: "distro", ...(actor ? { actor } : {}) }) : undefined;
      const warnings = [...(result?.warnings ?? [])];
      // What it installed under another name goes, and so does every part
      // of a bundle the branch held before.
      await dropOthers(id, release, go, warnings, "branch");
      await writeState(id, {
        ...kept,
        ...out,
        applied: { ref, commit: to, digest: info.digest, at, packages: go.map((p) => ({ package: p.package, version: p.version, digest: p.digest })) },
        checkedAt: at,
        warnings,
      });
      return { id, status: status(true), ...(from ? { from } : {}), to, ...out, ...(result ? { result } : {}) };
    } catch (err) {
      let error = err instanceof Error ? err.message : String(err);
      if (actor && tokenless && error.startsWith("package_repo_denied:")) {
        const name = secretOfRef(ref);
        // A part is made again with its bundle.
        const top = id.split("/")[0]!;
        error +=
          ` — this subscription is ${actor}'s, and is read with their own ${name} alone (never the deployment's), which they have not set: ` +
          `they set it (PUT /actors/${encodeURIComponent(actor)}/secrets/${name}), or a person who has one makes the subscription again (PUT /packages/subscriptions/${encodeURIComponent(top)}) and it is theirs`;
      }
      await writeState(id, { ...state, checkedAt: at, error }).catch(() => undefined);
      return { id, status: "error", ...(from ? { from } : {}), ...(to ? { to } : {}), error };
    }
  };

  /** A bundle's release: the parts it no longer lists stop (what each
   *  installed goes, forks kept), then every part it lists is synced as a
   *  subscription to its ref alone, one after another — each read on its
   *  own branch whether or not the bundle moved, so a part's release needs
   *  none of the bundle's. Nothing of the bundle itself is installed. */
  const syncBundle = async (sub: Subscription & { ref: string }, state: SubscriptionState, at: string, info: ResolvedPackage, from: string | undefined): Promise<SyncOutcome> => {
    const { id, ref } = sub;
    const to = info.commit!;
    const refs = info.manifest.bundle!;
    const last = state.applied?.ref === ref ? state.applied : undefined;
    const parts = refs.map((r) => partOf(sub, r));
    const listed = new Set(parts.map((p) => p.id));
    const warnings: string[] = [];
    // Its own name (a release that was a package) and the parts it dropped.
    await dropOthers(id, [], [], warnings, "branch", listed);
    for (const r of state.applied?.bundle?.refs ?? []) {
      const part = partIdOf(id, r);
      if (!listed.has(part)) await rm(fileOf(part, "json"), { force: true });
    }
    const moved = last?.digest !== info.digest;
    const { error: _error, waiting: _waiting, held: _held, ...kept } = state;
    // The list first: a part this release adds is a subscription here from
    // now on. `checkedAt` once every part is read: a page that waits for it
    // to move waits for the whole bundle.
    const next: SubscriptionState = {
      ...kept,
      applied: moved ? { ref, commit: to, digest: info.digest, at, packages: [], bundle: { package: info.manifest.package, version: info.manifest.version, refs } } : { ...last!, commit: to },
      ...(moved || warnings.length ? { warnings } : {}),
    };
    await writeState(id, next);
    const outcomes: SyncOutcome[] = [];
    for (const part of parts) outcomes.push(await syncGit(part, await readState(part.id), at));
    await writeState(id, { ...next, checkedAt: at });
    const secrets = [...new Set(outcomes.flatMap((o) => o.waiting?.secrets ?? []))].sort();
    return {
      id,
      status: pressing([moved ? "applied" : "current", ...outcomes.map((o) => o.status)]),
      ...(from ? { from } : {}),
      to,
      ...leftOut({ secrets }, outcomes.flatMap((o) => o.held ?? [])),
      parts: outcomes,
    };
  };

  const syncOnce = async (id: string): Promise<SyncOutcome> => {
    const sub = await read(id);
    if (!sub) return { id, status: "error", error: `subscription_unknown: no subscription "${id}"` };
    const state = await readState(id);
    const at = new Date().toISOString();
    if (sub.ref) return syncGit(sub as Subscription & { ref: string }, state, at);
    try {
      const { card, digest, bytes } = await catalogOf(sub, state);
      state.accepted = { seq: card.seq, digest, at };
      await write(fileOf(id, "catalog.json"), bytes);
      const targets = targetsOf(sub, card);
      // The catalog carries each release's `requires`, sealed with it: a
      // package that waits is never fetched.
      const { go, waiting, held } = await gate(id, targets.map((t) => ({ ...t, requires: t.release.requires })), sub.actor);
      const { error: _error, waiting: _waiting, held: _held, ...kept } = state;
      const wait = leftOut(waiting, held);
      const status = (moved: boolean): SyncOutcome["status"] => (waiting ? "waiting" : held ? "held" : moved ? "applied" : "current");
      if (state.applied?.digest === digest && !state.error && sameAs(state.applied, go)) {
        await writeState(id, { ...kept, ...wait, checkedAt: at });
        return { id, status: status(false), seq: card.seq, ...wait };
      }
      const warnings: string[] = [];
      let result: InstallResult | undefined;
      if (go.length) {
        await fetchAll(sub, card, go);
        result = await deps.install(
          go.map((t) => ({ ref: subscriptionRef(id), digest: t.release.digest })),
          { door: "distro", ...(sub.actor ? { actor: sub.actor } : {}) },
        );
        warnings.push(...result.warnings);
      }
      // What it installed that the channel no longer holds, or that waits, goes the same way.
      await dropOthers(id, targets, go, warnings, "channel");
      await writeState(id, {
        ...kept,
        ...wait,
        applied: { seq: card.seq, digest, at, packages: go.map((t) => ({ package: t.package, version: t.release.version, digest: t.release.digest })) },
        checkedAt: at,
        ...(warnings.length ? { warnings } : { warnings: [] }),
      });
      return { id, status: status(true), seq: card.seq, ...wait, ...(result ? { result } : {}) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await writeState(id, { ...state, checkedAt: at, error }).catch(() => undefined);
      return { id, status: "error", error };
    }
  };

  // One run per subscription at a time; a ping while one runs waits for
  // one more run after it, which every later ping joins until it starts.
  const queued = new Map<string, Promise<SyncOutcome>>();
  const tail = new Map<string, Promise<unknown>>();
  const sync = (id: string): Promise<SyncOutcome> => {
    const waiting = queued.get(id);
    if (waiting) return waiting;
    const run = (tail.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        queued.delete(id);
        return syncOnce(id);
      });
    queued.set(id, run);
    tail.set(id, run);
    return run;
  };

  return {
    async list() {
      const installed = await deps.installed();
      const out: SubscriptionInfo[] = [];
      for (const id of await ids()) {
        const sub = await read(id);
        if (sub) out.push(await info(sub, installed));
      }
      return out;
    },
    async get(id) {
      const sub = await read(id);
      return sub ? info(sub) : undefined;
    },
    async set(sub) {
      const problem = subscriptionProblem(sub);
      if (problem) throw new Error(`subscription_invalid: ${problem}`);
      const { id, ...rest } =
        sub.ref !== undefined
          ? { id: sub.id, ref: sub.ref, ...(sub.actor ? { actor: sub.actor } : {}) }
          : { ...sub, url: normalizeBaseUrl(sub.url!) };
      const before = await read(id);
      await deps.secrets.set(keyFor(id), JSON.stringify(rest));
      // Another publisher or ref under the same name starts over: its seq
      // (or its commit) is its own.
      if (before && (before.key !== sub.key || before.ref !== sub.ref)) {
        await rm(fileOf(id, "json"), { force: true });
        await rm(fileOf(id, "catalog.json"), { force: true });
      }
      return info({ id, ...rest });
    },
    async delete(id, opts = {}) {
      const sub = await read(id);
      if (!sub) return { removed: false, uninstalled: [] };
      // A sync under way ends first: nothing of it goes in after the stop.
      await tail.get(id)?.catch(() => undefined);
      const parts = ((await readState(id)).applied?.bundle?.refs ?? []).map((r) => partIdOf(id, r));
      const uninstalled: string[] = [];
      if (opts.uninstall) {
        // Everything it brought: under its own name, and under each part's.
        for (const p of await deps.installed()) {
          const holder = holderOf(p);
          if (holder !== id && !holder?.startsWith(`${id}/`)) continue;
          await deps.uninstall(p.package, { door: "distro" });
          uninstalled.push(p.package);
        }
      }
      await deps.secrets.delete(keyFor(id));
      for (const x of [id, ...parts]) await rm(fileOf(x, "json"), { force: true });
      await rm(fileOf(id, "catalog.json"), { force: true });
      return { removed: true, uninstalled };
    },
    sync,
    async syncAll(filter = {}) {
      const all = await ids();
      const subs = (await Promise.all(all.map(read))).filter((s): s is Subscription => !!s && (!filter.key || s.key === filter.key) && (filter.git !== false || !s.ref));
      return Promise.all(subs.map((s) => sync(s.id)));
    },
  };
}
