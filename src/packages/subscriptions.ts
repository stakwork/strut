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
 * §1): `{ ref, tokenSecret? }`, a `git+https://host/org/repo[@<branch>]
 * [#<folder>]` ref, read as serve mode reads one — the branch fetched into
 * git/checkout's bare cache, the package at its commit read into the cache,
 * skipped while the commit is the one applied. The branch is the channel:
 * a commit whose package has the digest applied installs nothing, any other
 * goes in through the same door — an older one too, so a branch moved back
 * is a rollback. A tag or a commit has nothing to follow: a full sha is
 * refused at the `PUT`, a tag at the first sync. No publisher pings one, so
 * the publisher's ping leaves it alone (`syncAll({ git: false })`); the poll
 * and `POST /packages/subscriptions/:id/sync` read it.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeBaseUrl, peerIdProblem } from "../peers.js";
import type { ShellCapability } from "../capabilities.js";
import { isValidSecretName, type SecretStore } from "../secret-store.js";
import { archiveUrl, fetchArchive } from "./archive.js";
import { resolvePackage, type PackageCache } from "./cache.js";
import { DEFAULT_TOKEN_SECRET, parseGitRef } from "./git-source.js";
import { readCard, releaseFor, z32Decode, type Catalog, type CatalogRelease } from "./card.js";
import type { InstallResult, PackageDoor } from "./install.js";
import type { InstalledPackage } from "./installed.js";
import { CHANNEL_NAME } from "./publisher.js";

/** The encrypted file subscriptions are kept in, beside `secrets.json`. */
export const SUBSCRIPTIONS_FILE = "subscriptions.json";
const PREFIX = "S_";
const keyFor = (id: string) => `${PREFIX}${Buffer.from(id, "utf8").toString("hex").toUpperCase()}`;
const idOf = (name: string) => Buffer.from(name.slice(PREFIX.length), "hex").toString("utf8");

/** What `source.ref` an installed package records when a subscription installed it. */
export const subscriptionRef = (id: string): string => `subscription:${id}`;

/** A publisher's catalog (`key`, `url`, `channel?`, `token?`), or a git
 *  branch (`ref`, `tokenSecret?`): one or the other. */
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
  /** The NAME of the secret `ref` is read with (default GITHUB_TOKEN). A public repo needs none. */
  tokenSecret?: string;
}

export interface SubscriptionState {
  /** The last catalog accepted (§13's order: never back). */
  accepted?: { seq: number; digest: string; at: string };
  /** The release last applied here: a catalog's `seq` and digest, or for a
   *  `git+` ref the ref, the commit last read and its package's digest. */
  applied?: { seq?: number; ref?: string; commit?: string; digest: string; at: string; packages: Array<{ package: string; version: string; digest: string }> };
  /** The last sync: when, and what stopped it. */
  checkedAt?: string;
  error?: string;
  /** What the last apply said without failing (a removal it could not make, a claim that did not record). */
  warnings?: string[];
}

export interface SubscriptionInfo extends Omit<Subscription, "token">, SubscriptionState {
  /** A catalog's: whether it has a read token. */
  token?: boolean;
  /** Each package it installed, as the workspace has it now, and the items edited here. */
  packages: Array<{ package: string; version?: string; digest?: string; diverged: string[] }>;
}

export interface SyncOutcome {
  id: string;
  /** `applied`: a new release is in; `current`: nothing new; `error`: see `error`. */
  status: "applied" | "current" | "error";
  seq?: number;
  /** A `git+` ref's: the commit applied before, and the one the branch is at
   *  (absent when the read failed). */
  from?: string;
  to?: string;
  error?: string;
  result?: InstallResult;
}

export interface SubscriptionsDeps {
  secrets: SecretStore;
  /** `<dataDir>/packages/subscriptions/`: each subscription's state and the catalog it accepted. */
  dir: string;
  cache: PackageCache;
  /** One install of the whole set, through the distro's door: `commit`, a
   *  `git+` ref's, goes on each version's upstream. */
  install(refs: Array<{ ref: string; digest: string; commit?: string }>, opts: { door: PackageDoor }): Promise<InstallResult>;
  uninstall(pkg: string, opts: { door: PackageDoor }): Promise<unknown>;
  installed(): Promise<InstalledPackage[]>;
  fetch?: typeof fetch;
  /** A `git+` ref's: where `repos/` (the bare caches) lives (default the
   *  cache's parent), its token read by secret NAME, and git's shell. */
  dataDir?: string;
  secret?(name: string): Promise<string | undefined>;
  shell?: ShellCapability;
}

export interface Subscriptions {
  list(): Promise<SubscriptionInfo[]>;
  get(id: string): Promise<SubscriptionInfo | undefined>;
  /** Write (or replace) a subscription; the next sync uses it. */
  set(sub: Subscription): Promise<SubscriptionInfo>;
  /** Stop following; with `uninstall`, its packages go through the distro's door (forks kept). */
  delete(id: string, opts?: { uninstall?: boolean }): Promise<{ removed: boolean; uninstalled: string[] }>;
  sync(id: string): Promise<SyncOutcome>;
  /** Every subscription — to one publisher key, when named; `git: false`
   *  leaves the `git+` ones out (a publisher's ping: they have none). */
  syncAll(filter?: { key?: string; git?: boolean }): Promise<SyncOutcome[]>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** Why a subscription is not one, or nothing. */
export function subscriptionProblem(sub: Partial<Subscription>): string | undefined {
  const idProblem = peerIdProblem(sub.id);
  if (idProblem) return `id ${idProblem}`;
  if (sub.id === "sync") return 'id "sync" is the sync route\'s';
  if (sub.ref !== undefined || sub.tokenSecret !== undefined) {
    if (sub.key !== undefined || sub.url !== undefined || sub.channel !== undefined || sub.token !== undefined) {
      return "a subscription is { key, url, channel?, token? } (a catalog) or { ref, tokenSecret? } (a git branch), not both";
    }
    if (typeof sub.ref !== "string") return "ref is git+https://host/org/repo[@<branch>][#<folder>]";
    const parsed = parseGitRef(sub.ref);
    if (typeof parsed === "string") return `ref ${parsed}`;
    if (parsed.rev && FULL_SHA.test(parsed.rev)) return `ref ${sub.ref}: names a commit, which does not move — a subscription follows a branch`;
    if (sub.tokenSecret !== undefined && (typeof sub.tokenSecret !== "string" || !isValidSecretName(sub.tokenSecret))) return "tokenSecret is the NAME of a secret (letters, digits, underscore), never the token";
    return undefined;
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

  const info = async (sub: Subscription, installed?: InstalledPackage[]): Promise<SubscriptionInfo> => {
    const { token, ...rest } = sub;
    const mine = (installed ?? (await deps.installed())).filter((p) => p.source?.ref === subscriptionRef(sub.id));
    return {
      ...rest,
      // A branch shows the secret it is read with; a catalog, whether it has a token.
      ...(sub.ref ? { tokenSecret: sub.tokenSecret ?? DEFAULT_TOKEN_SECRET } : { token: !!token }),
      ...(await readState(sub.id)),
      packages: mine.map((p) => ({
        package: p.package,
        ...(p.version ? { version: p.version } : {}),
        ...(p.digest ? { digest: p.digest } : {}),
        diverged: p.items.filter((i) => i.modified).map((i) => i.name),
      })),
    };
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

  /** What this subscription installed and no longer holds goes out
   *  through the distro's door; what could not, said as warnings. */
  const dropOthers = async (id: string, holds: Set<string>, warnings: string[], by: "channel" | "branch") => {
    for (const p of await deps.installed()) {
      if (p.source?.ref !== subscriptionRef(id) || holds.has(p.package)) continue;
      try {
        await deps.uninstall(p.package, { door: "distro" });
      } catch (err) {
        warnings.push(`${p.package}, which the ${by} no longer holds, was not uninstalled: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  /** A `git+` ref: the branch read as serve mode reads it, its package
   *  installed when its digest moved. */
  const syncGit = async (sub: Subscription & { ref: string }, state: SubscriptionState, at: string): Promise<SyncOutcome> => {
    const { id, ref } = sub;
    const last = state.applied?.ref === ref ? state.applied : undefined;
    const from = last?.commit;
    let to: string | undefined;
    try {
      const info = await resolvePackage(ref, {
        cache: deps.cache,
        branch: true,
        ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
        ...(sub.tokenSecret ? { tokenSecret: sub.tokenSecret } : {}),
        ...(deps.secret ? { secret: deps.secret } : {}),
        ...(deps.shell ? { shell: deps.shell } : {}),
        // The branch still at the commit applied: nothing read out of git.
        ...(last?.commit ? { known: { commit: last.commit, digest: last.digest } } : {}),
      });
      to = info.commit!;
      const { error: _error, ...kept } = state;
      if (last?.digest === info.digest) {
        // The branch moved and the package did not: the commit is recorded.
        await writeState(id, { ...kept, applied: { ...last, commit: to }, checkedAt: at });
        return { id, status: "current", ...(from ? { from } : {}), to };
      }
      const result = await deps.install([{ ref: subscriptionRef(id), digest: info.digest, commit: to }], { door: "distro" });
      const warnings = [...result.warnings];
      await dropOthers(id, new Set([info.manifest.package]), warnings, "branch");
      await writeState(id, {
        ...kept,
        applied: { ref, commit: to, digest: info.digest, at, packages: [{ package: info.manifest.package, version: info.manifest.version, digest: info.digest }] },
        checkedAt: at,
        warnings,
      });
      return { id, status: "applied", ...(from ? { from } : {}), to, result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await writeState(id, { ...state, checkedAt: at, error }).catch(() => undefined);
      return { id, status: "error", ...(from ? { from } : {}), ...(to ? { to } : {}), error };
    }
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
      if (state.applied?.digest === digest && !state.error) {
        await writeState(id, { ...state, checkedAt: at });
        return { id, status: "current", seq: card.seq };
      }
      const targets = targetsOf(sub, card);
      const warnings: string[] = [];
      let result: InstallResult | undefined;
      if (targets.length) {
        await fetchAll(sub, card, targets);
        result = await deps.install(
          targets.map((t) => ({ ref: subscriptionRef(id), digest: t.release.digest })),
          { door: "distro" },
        );
        warnings.push(...result.warnings);
      }
      // What it installed that the channel no longer holds goes the same way.
      await dropOthers(id, new Set(targets.map((t) => t.package)), warnings, "channel");
      const { error: _error, ...kept } = state;
      await writeState(id, {
        ...kept,
        applied: { seq: card.seq, digest, at, packages: targets.map((t) => ({ package: t.package, version: t.release.version, digest: t.release.digest })) },
        checkedAt: at,
        ...(warnings.length ? { warnings } : { warnings: [] }),
      });
      return { id, status: "applied", seq: card.seq, ...(result ? { result } : {}) };
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
      const { id, ...rest } = sub.ref !== undefined ? { id: sub.id, ref: sub.ref, ...(sub.tokenSecret ? { tokenSecret: sub.tokenSecret } : {}) } : { ...sub, url: normalizeBaseUrl(sub.url!) };
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
      const uninstalled: string[] = [];
      if (opts.uninstall) {
        for (const p of await deps.installed()) {
          if (p.source?.ref !== subscriptionRef(id)) continue;
          await deps.uninstall(p.package, { door: "distro" });
          uninstalled.push(p.package);
        }
      }
      await deps.secrets.delete(keyFor(id));
      await rm(fileOf(id, "json"), { force: true });
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
