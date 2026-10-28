/**
 * The PUBLISHER (plans/marketplace.md §13, §12.1): this strut's Ed25519 key
 * and the catalog it seals with it — the packages it published, each with
 * its releases, and its channels. The byte host is `self`: the catalog is
 * served by `GET /packages/catalog` and each release's archive by the
 * archive route beside it, so a release lists no `urls`. No Pkarr record
 * yet: a subscriber reads the catalog at the strut's URL and checks it
 * against the key it subscribed to (§12.1), which is the whole check.
 *
 * The key lives in an encrypted file of its own beside `peers.json`
 * (`publisher.json`), never on the services bag: a step signs nothing.
 * Minting is refused while that file would only be obfuscated — a file
 * store on the dev default key (`STRUT_SECRET_KEY` unset).
 *
 * The catalogs live under `<dataDir>/packages/catalogs/`: each sealed one
 * as `sha256-<hex>.json`, written once, and `current`, the digest of the
 * newest. Every publish reads the current one, adds to it, moves `seq`
 * forward and seals it again.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretStore } from "../secret-store.js";
import { CARD_VERSION, cardBytes, cardDigest, keyFromSeed, sealCard, type Catalog, type CatalogRelease, type UnsignedCatalog } from "./card.js";
import { PACKAGE_DIGEST, type PackageManifest } from "./format.js";

/** The encrypted file the publisher key is kept in, beside `secrets.json`. */
export const PUBLISHER_FILE = "publisher.json";
const KEY_NAME = "PUBLISHER";

/** A channel's name: what a subscription follows (`stable`, `canary`). */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The publisher's NAME: `[a-z][a-z0-9-]*`, the first segment of every
 *  package built here. */
export const PUBLISHER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export interface PublisherInfo {
  /** The public key, z-base-32: the publisher's identity between struts. */
  key: string;
  /** The prefix segment every package this strut builds is named under
   *  (`stakwork` in `stakwork/tools`), set once by `PUT /publisher { name }`
   *  and never typed by a person again (plans/packages-ux.md §2): the UI
   *  composes package names from it, and `POST /packages/publish` refuses a
   *  package under another one. The human name the index lists the key
   *  under (plans/marketplace.md §7, §13). Unset: any prefix, as before. */
  name?: string;
  /** Where its bytes are served: this strut's own routes. */
  host: "self";
  createdAt: string;
}

interface PublisherRecord extends PublisherInfo {
  /** The 32-byte Ed25519 seed, hex. */
  seed: string;
}

export interface Publisher {
  get(): Promise<PublisherInfo | undefined>;
  /** The key, minted on first call; `minted` says whether this call made it. */
  ensure(): Promise<{ info: PublisherInfo; minted: boolean }>;
  /** Set the publisher's name (the key minted first when there is none). */
  setName(name: string): Promise<PublisherInfo>;
  /** Seal a catalog with the key (minted first when there is none). */
  seal(card: Omit<UnsignedCatalog, "key">): Promise<Catalog>;
}

/** `unsafe` says why this strut may not mint (its secret store is only
 *  obfuscated), or nothing. */
export function publisherStore(secrets: SecretStore, opts: { unsafe?: () => string | undefined } = {}): Publisher {
  const read = async (): Promise<PublisherRecord | undefined> => {
    const raw = await secrets.get(KEY_NAME);
    return raw ? (JSON.parse(raw) as PublisherRecord) : undefined;
  };
  const info = ({ seed: _seed, ...rest }: PublisherRecord): PublisherInfo => rest;
  let minting: Promise<PublisherRecord> | undefined;
  const ensure = async (): Promise<{ record: PublisherRecord; minted: boolean }> => {
    const have = await read();
    if (have) return { record: have, minted: false };
    const why = opts.unsafe?.();
    if (why) throw new Error(`publisher_unsafe_key: ${why}`);
    // Two publishes at once mint one key.
    minting ??= (async () => {
      const seed = randomBytes(32);
      const record: PublisherRecord = { key: keyFromSeed(seed).key, host: "self", createdAt: new Date().toISOString(), seed: seed.toString("hex") };
      await secrets.set(KEY_NAME, JSON.stringify(record));
      return record;
    })().finally(() => {
      minting = undefined;
    });
    return { record: await minting, minted: true };
  };
  return {
    async get() {
      const r = await read();
      return r ? info(r) : undefined;
    },
    async ensure() {
      const { record, minted } = await ensure();
      return { info: info(record), minted };
    },
    async setName(name) {
      if (!PUBLISHER_NAME.test(name)) throw new Error(`publisher_name: ${JSON.stringify(name)} is not a publisher name ([a-z][a-z0-9-]*, at most 64 characters)`);
      const { record } = await ensure();
      const next: PublisherRecord = { ...record, name };
      await secrets.set(KEY_NAME, JSON.stringify(next));
      return info(next);
    },
    async seal(card) {
      const { record } = await ensure();
      const { privateKey, key } = keyFromSeed(Buffer.from(record.seed, "hex"));
      return sealCard({ ...card, key } as UnsignedCatalog, privateKey);
    },
  };
}

export interface CatalogFile {
  card: Catalog;
  bytes: Buffer;
  digest: string;
}

/** The sealed catalogs under `<dataDir>/packages/catalogs/`. */
export class CatalogStore {
  constructor(readonly root: string) {}

  private fileOf(digest: string): string {
    if (!PACKAGE_DIGEST.test(digest)) throw new Error(`${JSON.stringify(digest)} is not a digest (sha256:<64 hex>)`);
    return join(this.root, `${digest.replace(":", "-")}.json`);
  }

  async get(digest: string): Promise<CatalogFile | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.fileOf(digest));
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
    if (cardDigest(bytes) !== digest) throw new Error(`catalog_corrupt: ${this.fileOf(digest)} no longer hashes to its name`);
    return { card: JSON.parse(bytes.toString("utf8")) as Catalog, bytes, digest };
  }

  async current(): Promise<CatalogFile | undefined> {
    let digest: string;
    try {
      digest = (await readFile(join(this.root, "current"), "utf8")).trim();
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
    return this.get(digest);
  }

  /** Keep a sealed catalog and make it the current one. */
  async put(card: Catalog): Promise<CatalogFile> {
    const bytes = cardBytes(card);
    const digest = cardDigest(bytes);
    await mkdir(this.root, { recursive: true });
    const tmp = (name: string) => join(this.root, `.${name}.${randomBytes(6).toString("hex")}`);
    const file = tmp("card");
    await writeFile(file, bytes, { mode: 0o644 });
    await rename(file, this.fileOf(digest));
    const pointer = tmp("current");
    await writeFile(pointer, `${digest}\n`);
    await rename(pointer, join(this.root, "current"));
    return { card, bytes, digest };
  }
}

export function catalogStore(dataDir: string): CatalogStore {
  return new CatalogStore(join(dataDir, "packages", "catalogs"));
}

export interface CatalogDeps {
  publisher: Publisher;
  catalogs: CatalogStore;
  /** Now, in milliseconds (tests fix it). */
  now?: () => number;
}

/** The current catalog to build the next one on, or an empty one. */
async function base(deps: CatalogDeps): Promise<Omit<UnsignedCatalog, "key">> {
  const cur = await deps.catalogs.current();
  if (!cur) return { v: CARD_VERSION, seq: 0, packages: {} };
  const { sig: _sig, key: _key, ...rest } = structuredClone(cur.card);
  return rest;
}

/** Seal the next catalog (`seq` moved forward) and keep it as the current one. */
async function next(deps: CatalogDeps, card: Omit<UnsignedCatalog, "key">): Promise<CatalogFile> {
  const now = Math.floor((deps.now?.() ?? Date.now()) * 1000);
  const sealed = await deps.publisher.seal({ ...card, v: CARD_VERSION, seq: Math.max(now, card.seq + 1) });
  return deps.catalogs.put(sealed);
}

/** A package built here, published: its release added to the catalog
 *  (newest first; the same digest again is not added twice) and, when a
 *  channel is named, that channel moved to it. */
export async function publishRelease(
  deps: CatalogDeps,
  rel: { manifest: PackageManifest; digest: string; channel?: string },
): Promise<CatalogFile> {
  if (rel.channel !== undefined && !CHANNEL_NAME.test(rel.channel)) throw new Error(`catalog_channel: ${JSON.stringify(rel.channel)} is not a channel name ([a-z0-9][a-z0-9._-]*)`);
  const card = await base(deps);
  const pkg = rel.manifest.package;
  const entry = (card.packages[pkg] ??= { releases: [] });
  if (rel.manifest.description !== undefined) entry.description = rel.manifest.description;
  else delete entry.description;
  if (!entry.releases.some((r) => r.digest === rel.digest)) {
    const release: CatalogRelease = {
      version: rel.manifest.version,
      digest: rel.digest,
      ...(rel.manifest.license ? { license: rel.manifest.license } : {}),
      ...(rel.manifest.requires ? { requires: rel.manifest.requires } : {}),
    };
    entry.releases.unshift(release);
  }
  if (rel.channel !== undefined) (card.channels ??= {})[rel.channel] = { ...(card.channels?.[rel.channel] ?? {}), [pkg]: rel.digest };
  return next(deps, card);
}

/** Point a channel at one of a package's releases — a rollback is moving it
 *  back — or, with `digest: null`, take the package out of the channel. */
export async function moveChannel(deps: CatalogDeps, move: { channel: string; package: string; digest: string | null }): Promise<CatalogFile> {
  if (!CHANNEL_NAME.test(move.channel)) throw new Error(`catalog_channel: ${JSON.stringify(move.channel)} is not a channel name ([a-z0-9][a-z0-9._-]*)`);
  const card = await base(deps);
  const releases = card.packages[move.package]?.releases;
  if (!releases) throw new Error(`catalog_no_release: ${move.package} is not in this strut's catalog`);
  const held = { ...(card.channels?.[move.channel] ?? {}) };
  if (move.digest === null) {
    if (!(move.package in held)) throw new Error(`catalog_no_release: the channel ${move.channel} does not hold ${move.package}`);
    delete held[move.package];
  } else {
    if (!releases.some((r) => r.digest === move.digest)) throw new Error(`catalog_no_release: ${move.package} has no release at ${move.digest} in this strut's catalog`);
    held[move.package] = move.digest;
  }
  const channels = { ...(card.channels ?? {}), [move.channel]: held };
  if (Object.keys(held).length === 0) delete channels[move.channel];
  if (Object.keys(channels).length) card.channels = channels;
  else delete card.channels;
  return next(deps, card);
}
