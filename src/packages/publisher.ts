/**
 * The PUBLISHER (plans/marketplace.md §13, §12.1): this strut's Ed25519 keys
 * and the catalogs it seals with them — the packages it published, each with
 * its releases, and its channels. The byte host is `self`: the catalog is
 * served by `GET /packages/catalog` and each release's archive by the
 * archive route beside it, so a release lists no `urls`. No Pkarr record
 * yet: a subscriber reads the catalog at the strut's URL and checks it
 * against the key it subscribed to (§12.1), which is the whole check.
 *
 * ONE PUBLISHER, TWO KEYS (§13): a card's `seq` rule is per key, so one key
 * cannot seal a catalog a fleet reads and another the world reads. The
 * FLEET key — the one minted first, today's — seals the fleet catalog, the
 * whole picture: every release and every channel. The PUBLIC key, minted the
 * first time a channel is made public, seals the public catalog: the public
 * channels, and every release a public channel holds or has held (what was
 * published stays published). A channel is private unless the publisher
 * marks it public, and a channel goes private → public only. The fleet card
 * names the public key (`public`); the public card never names the fleet
 * key, which is the only one a Pkarr record or an index row will carry.
 *
 * The keys live in an encrypted file of their own beside `peers.json`
 * (`publisher.json`), never on the services bag: a step signs nothing.
 * Minting is refused while that file would only be obfuscated — a file
 * store on the dev default key (`STRUT_SECRET_KEY` unset).
 *
 * The catalogs live under `<dataDir>/packages/catalogs/` (the fleet's) and
 * `catalogs/public/` (the public one): each sealed one as
 * `sha256-<hex>.json`, written once, and `current`, the digest of the
 * newest. Every publish reads the current one, adds to it, moves `seq`
 * forward and seals it again.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretStore } from "../secret-store.js";
import { CARD_VERSION, canonicalJson, cardBytes, cardDigest, keyFromSeed, sealCard, type Catalog, type CatalogPackage, type CatalogRelease, type UnsignedCatalog } from "./card.js";
import { PACKAGE_DIGEST, type PackageManifest } from "./format.js";

/** The encrypted file the publisher keys are kept in, beside `secrets.json`. */
export const PUBLISHER_FILE = "publisher.json";
const KEY_NAME = "PUBLISHER";

/** A channel's name: what a subscription follows (`stable`, `canary`). */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The channel **Make public** puts a release on. */
export const PUBLIC_CHANNEL = "public";

/** The publisher's NAME: `[a-z][a-z0-9-]*`, the first segment of every
 *  package built here. */
export const PUBLISHER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export interface PublisherInfo {
  /** The FLEET key, z-base-32: what a subscribing strut follows (§12.1). */
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
  /** The PUBLIC key, z-base-32, once a channel was made public: the
   *  publisher's identity to the world, the only key a record or an index
   *  row carries. */
  public?: string;
  /** The channels marked public: in the public catalog, sealed by the
   *  public key. Every other channel is in the fleet catalog alone. */
  publicChannels: string[];
}

interface PublisherRecord extends Omit<PublisherInfo, "publicChannels"> {
  /** The fleet key's 32-byte Ed25519 seed, hex. */
  seed: string;
  /** The public key's seed, hex, minted with `public`. */
  publicSeed?: string;
  /** Absent on a record from before the public key: no channel is public. */
  publicChannels?: string[];
}

export interface Publisher {
  get(): Promise<PublisherInfo | undefined>;
  /** The fleet key, minted on first call; `minted` says whether this call made it. */
  ensure(): Promise<{ info: PublisherInfo; minted: boolean }>;
  /** Set the publisher's name (the key minted first when there is none). */
  setName(name: string): Promise<PublisherInfo>;
  /** Mark a channel public — the public key minted first when there is
   *  none — and keep it so: a channel goes private → public only. */
  makePublic(channel: string): Promise<PublisherInfo>;
  /** Seal a fleet catalog with the fleet key (minted first when there is
   *  none); it names the public key when there is one. */
  seal(card: Omit<UnsignedCatalog, "key" | "public">): Promise<Catalog>;
  /** Seal a public catalog with the public key; refused before one is minted. */
  sealPublic(card: Omit<UnsignedCatalog, "key" | "public">): Promise<Catalog>;
}

/** `unsafe` says why this strut may not mint (its secret store is only
 *  obfuscated), or nothing. */
export function publisherStore(secrets: SecretStore, opts: { unsafe?: () => string | undefined } = {}): Publisher {
  const read = async (): Promise<PublisherRecord | undefined> => {
    const raw = await secrets.get(KEY_NAME);
    return raw ? (JSON.parse(raw) as PublisherRecord) : undefined;
  };
  const info = ({ seed: _seed, publicSeed: _publicSeed, publicChannels, ...rest }: PublisherRecord): PublisherInfo => ({ ...rest, publicChannels: publicChannels ?? [] });
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
    async makePublic(channel) {
      if (!CHANNEL_NAME.test(channel)) throw new Error(`catalog_channel: ${JSON.stringify(channel)} is not a channel name ([a-z0-9][a-z0-9._-]*)`);
      const { record } = await ensure();
      const channels = record.publicChannels ?? [];
      if (channels.includes(channel) && record.publicSeed) return info(record);
      const next: PublisherRecord = { ...record, publicChannels: [...new Set([...channels, channel])].sort() };
      if (!next.publicSeed) {
        const seed = randomBytes(32);
        next.publicSeed = seed.toString("hex");
        next.public = keyFromSeed(seed).key;
      }
      await secrets.set(KEY_NAME, JSON.stringify(next));
      return info(next);
    },
    async seal(card) {
      const { record } = await ensure();
      const { privateKey, key } = keyFromSeed(Buffer.from(record.seed, "hex"));
      return sealCard({ ...card, key, ...(record.public ? { public: record.public } : {}) } as UnsignedCatalog, privateKey);
    },
    async sealPublic(card) {
      const record = await read();
      if (!record?.publicSeed) throw new Error("publisher_not_public: this strut has no public key yet — make a channel public first");
      const { privateKey, key } = keyFromSeed(Buffer.from(record.publicSeed, "hex"));
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

/** The fleet catalogs. */
export function catalogStore(dataDir: string): CatalogStore {
  return new CatalogStore(join(dataDir, "packages", "catalogs"));
}

/** The public catalogs, beside the fleet's. */
export function publicCatalogStore(dataDir: string): CatalogStore {
  return new CatalogStore(join(dataDir, "packages", "catalogs", "public"));
}

export interface CatalogDeps {
  publisher: Publisher;
  /** The fleet catalogs. */
  catalogs: CatalogStore;
  /** The public catalogs. */
  publicCatalogs: CatalogStore;
  /** Now, in milliseconds (tests fix it). */
  now?: () => number;
}

type Draft = Omit<UnsignedCatalog, "key" | "public">;

/** The current catalog to build the next one on, or an empty one. */
async function base(store: CatalogStore): Promise<Draft> {
  const cur = await store.current();
  if (!cur) return { v: CARD_VERSION, seq: 0, packages: {} };
  const { sig: _sig, key: _key, public: _public, ...rest } = structuredClone(cur.card);
  return rest;
}

/** The next `seq`: now, or one past the previous. */
function seqAfter(deps: CatalogDeps, card: Draft): number {
  const now = Math.floor((deps.now?.() ?? Date.now()) * 1000);
  return Math.max(now, card.seq + 1);
}

/**
 * What the world may see of a fleet catalog: the public channels, and
 * every release a public channel holds or has held — `prev`, the public
 * catalog so far, is carried forward, since what was published stays
 * published — each release's fields as the fleet card has them now (a yank
 * reaches the public card too). Pure.
 */
export function projectPublic(fleet: Draft, prev: Draft | undefined, publicChannels: readonly string[]): Draft {
  const digests = new Map<string, Set<string>>();
  const note = (pkg: string, digest: string) => (digests.get(pkg) ?? digests.set(pkg, new Set()).get(pkg)!).add(digest);
  for (const [pkg, p] of Object.entries(prev?.packages ?? {})) for (const r of p.releases) note(pkg, r.digest);
  const channels: Record<string, Record<string, string>> = {};
  for (const ch of publicChannels) {
    const held = fleet.channels?.[ch];
    if (!held || Object.keys(held).length === 0) continue;
    channels[ch] = { ...held };
    for (const [pkg, digest] of Object.entries(held)) note(pkg, digest);
  }
  const packages: Record<string, CatalogPackage> = {};
  for (const pkg of [...digests.keys()].sort()) {
    const wanted = digests.get(pkg)!;
    const source = fleet.packages[pkg];
    // Fleet order, with the fields the fleet card has now; a release the
    // fleet card no longer lists (it never drops one) keeps its last form.
    const releases: CatalogRelease[] = source
      ? source.releases.filter((r) => wanted.has(r.digest)).map((r) => ({ ...r }))
      : (prev?.packages[pkg]?.releases ?? []).filter((r) => wanted.has(r.digest));
    const entry: CatalogPackage = { releases };
    const description = source?.description ?? prev?.packages[pkg]?.description;
    if (description !== undefined) entry.description = description;
    packages[pkg] = entry;
  }
  return { v: CARD_VERSION, seq: prev?.seq ?? 0, packages, ...(Object.keys(channels).length ? { channels } : {}) };
}

/** The required packages of a release that no public channel's catalog
 *  holds — what makes a public release refuse (§13): a public install must
 *  never stop at its first required package. */
function privateRequirements(pub: Draft, release: CatalogRelease | undefined): string[] {
  return (release?.requires?.packages ?? [])
    .filter((r) => !pub.packages[r.package]?.releases.some((x) => x.digest === r.digest))
    .map((r) => `${r.package} at ${r.digest}`);
}

/** Seal the next fleet catalog, and the next public catalog when the
 *  public picture changed; refuse a public release that requires a private
 *  package before either is written. */
async function commit(deps: CatalogDeps, fleet: Draft, touched?: { channel: string; package: string }): Promise<CatalogFile> {
  const info = await deps.publisher.get();
  const publicChannels = info?.publicChannels ?? [];
  const prevPublic = await base(deps.publicCatalogs);
  const nextPublic = info?.public ? projectPublic(fleet, prevPublic, publicChannels) : undefined;
  if (nextPublic && touched && publicChannels.includes(touched.channel)) {
    const digest = fleet.channels?.[touched.channel]?.[touched.package];
    const release = fleet.packages[touched.package]?.releases.find((r) => r.digest === digest);
    const missing = privateRequirements(nextPublic, release);
    if (missing.length) {
      throw new Error(`catalog_private_requirement: ${touched.package} ${release?.version ?? ""} requires ${missing.join(", ")}, which no public channel holds — make the required package public first, or a public install would stop at it`);
    }
  }
  const sealed = await deps.publisher.seal({ ...fleet, v: CARD_VERSION, seq: seqAfter(deps, fleet) });
  const file = await deps.catalogs.put(sealed);
  if (nextPublic) {
    const same = (a: Draft, b: Draft) => canonicalJson({ ...a, seq: 0 }) === canonicalJson({ ...b, seq: 0 });
    const cur = await deps.publicCatalogs.current();
    if (!cur || !same(nextPublic, prevPublic)) {
      await deps.publicCatalogs.put(await deps.publisher.sealPublic({ ...nextPublic, v: CARD_VERSION, seq: seqAfter(deps, prevPublic) }));
    }
  }
  return file;
}

/** A package built here, published: its release added to the catalog
 *  (newest first; the same digest again is not added twice) and, when a
 *  channel is named, that channel moved to it (marked public first with
 *  `public`). */
export async function publishRelease(
  deps: CatalogDeps,
  rel: { manifest: PackageManifest; digest: string; channel?: string; public?: boolean },
): Promise<CatalogFile> {
  if (rel.channel !== undefined && !CHANNEL_NAME.test(rel.channel)) throw new Error(`catalog_channel: ${JSON.stringify(rel.channel)} is not a channel name ([a-z0-9][a-z0-9._-]*)`);
  if (rel.channel !== undefined) await markChannel(deps, rel.channel, rel.public);
  const card = await base(deps.catalogs);
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
  return commit(deps, card, rel.channel !== undefined ? { channel: rel.channel, package: pkg } : undefined);
}

/** Point a channel at one of a package's releases — a rollback is moving it
 *  back — or, with `digest: null`, take the package out of the channel.
 *  `public: true` marks the channel public first; `false` on a public
 *  channel is refused, since what was published stays published. */
export async function moveChannel(
  deps: CatalogDeps,
  move: { channel: string; package: string; digest: string | null; public?: boolean },
): Promise<CatalogFile> {
  if (!CHANNEL_NAME.test(move.channel)) throw new Error(`catalog_channel: ${JSON.stringify(move.channel)} is not a channel name ([a-z0-9][a-z0-9._-]*)`);
  await markChannel(deps, move.channel, move.public);
  const card = await base(deps.catalogs);
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
  return commit(deps, card, move.digest === null ? undefined : { channel: move.channel, package: move.package });
}

/** The channel's audience: `true` marks it public (private → public, the
 *  one direction), `false` on a public one is refused, `undefined` leaves it. */
async function markChannel(deps: CatalogDeps, channel: string, pub: boolean | undefined): Promise<void> {
  if (pub === true) await deps.publisher.makePublic(channel);
  else if (pub === false && (await deps.publisher.get())?.publicChannels.includes(channel)) {
    throw new Error(`catalog_channel_public: ${channel} is public, and what was published stays published — take the release out of the channel instead`);
  }
}
