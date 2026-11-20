/**
 * A package's TORRENT (plans/marketplace.md §13, "BitTorrent, after the
 * record"; plans/torrents.md §8): a single-file BitTorrent v1 torrent of its
 * PLAIN TAR (./archive.ts `packTar`), built one fixed way, so its infohash
 * follows from the tar, which follows from the digest. Every strut that
 * holds a package computes the same magnet and can seed it, with nothing
 * kept from the publisher.
 *
 * The info dictionary holds exactly four keys — `length`, `name` (the
 * digest's hex + `.tar`), `piece length` (`TORRENT_PIECE_LENGTH`) and
 * `pieces` — and nothing else: no `private`, no `source`. What sits outside
 * it (`url-list`, the web seeds) never changes the infohash. Pure: no
 * client, no network. Seeding is plans/torrents.md's.
 */
import { createHash } from "node:crypto";
import { PACKAGE_DIGEST } from "./format.js";

/** The piece length every package torrent uses: 256 KiB. Part of the
 *  contract — another length is another infohash. */
export const TORRENT_PIECE_LENGTH = 256 * 1024;

type Bencodable = number | string | Buffer | Bencodable[] | { [key: string]: Bencodable };

/** Bencode (BEP 3): integers, byte strings, lists, and dictionaries with
 *  their keys sorted as raw bytes. A string is written as UTF-8. */
export function bencode(value: Bencodable): Buffer {
  const out: Buffer[] = [];
  const put = (v: Bencodable): void => {
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new Error(`bencode: ${v} is not a whole number`);
      out.push(Buffer.from(`i${v}e`));
    } else if (typeof v === "string" || Buffer.isBuffer(v)) {
      const bytes = typeof v === "string" ? Buffer.from(v, "utf8") : v;
      out.push(Buffer.from(`${bytes.length}:`), bytes);
    } else if (Array.isArray(v)) {
      out.push(Buffer.from("l"));
      for (const item of v) put(item);
      out.push(Buffer.from("e"));
    } else {
      out.push(Buffer.from("d"));
      const keys = Object.keys(v).map((k) => Buffer.from(k, "utf8")).sort(Buffer.compare);
      for (const key of keys) {
        put(key);
        put(v[key.toString("utf8")]!);
      }
      out.push(Buffer.from("e"));
    }
  };
  put(value);
  return Buffer.concat(out);
}

export interface PackageTorrent {
  /** The torrent's v1 infohash: SHA-1 of the bencoded info dictionary, hex. */
  infohash: string;
  /** The plain tar's sha256, hex: what a catalog names beside the digest. */
  sha256: string;
  /** The torrent's file name: the digest's hex + `.tar`. */
  name: string;
  /** The tar's size in bytes. */
  length: number;
  /** The `.torrent` file: the info dictionary, and `url-list` when given web seeds. */
  torrent: Buffer;
  /** `magnet:?xt=urn:btih:<infohash>&dn=<name>&xl=<length>`, a `ws=` per web seed. */
  magnet: string;
}

/**
 * The torrent of a package's plain tar. `webSeeds` (BEP 19: URLs that serve
 * the tar's exact bytes — a strut's archive route with `format=tar`) go in
 * the `.torrent`'s `url-list` and the magnet's `ws`, never in the info
 * dictionary, so the infohash is the same whoever lists which.
 */
export function packageTorrent(digest: string, tar: Buffer, opts: { webSeeds?: string[] } = {}): PackageTorrent {
  if (!PACKAGE_DIGEST.test(digest)) throw new Error(`package_torrent: ${JSON.stringify(digest)} is not a digest (sha256:<64 hex>)`);
  if (!tar.length) throw new Error("package_torrent: the tar is empty");
  const pieces: Buffer[] = [];
  for (let at = 0; at < tar.length; at += TORRENT_PIECE_LENGTH) {
    pieces.push(createHash("sha1").update(tar.subarray(at, at + TORRENT_PIECE_LENGTH)).digest());
  }
  const name = `${digest.slice("sha256:".length)}.tar`;
  const info = { length: tar.length, name, "piece length": TORRENT_PIECE_LENGTH, pieces: Buffer.concat(pieces) };
  const infohash = createHash("sha1").update(bencode(info)).digest("hex");
  const seeds = opts.webSeeds ?? [];
  const torrent = bencode(seeds.length ? { info, "url-list": seeds } : { info });
  const magnet = [`magnet:?xt=urn:btih:${infohash}`, `dn=${encodeURIComponent(name)}`, `xl=${tar.length}`, ...seeds.map((s) => `ws=${encodeURIComponent(s)}`)].join("&");
  return { infohash, sha256: createHash("sha256").update(tar).digest("hex"), name, length: tar.length, torrent, magnet };
}
