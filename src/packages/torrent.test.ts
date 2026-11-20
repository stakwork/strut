import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fetchArchive, isGzip, packArchive, packTar } from "./archive.js";
import { packageCache } from "./cache.js";
import { readPackage } from "./format.js";
import { bencode, packageTorrent, TORRENT_PIECE_LENGTH } from "./torrent.js";

// The test vector of the plain tar and its torrent (plans/marketplace.md
// §13): a fixed package, its digest, its tar's sha256, its infohash. These
// numbers are the contract every strut holding the package meets, so two
// struts seed one torrent; a change to any of them is a new format.
const VECTOR: Record<string, string> = {
  "strut.yaml": "package: acme/vector\nversion: 1.0.0\n",
  "workflows/hello.yaml": "name: acme/vector/hello\nsteps:\n  - id: say\n    type: log\n    config: { message: hi }\n",
  "concepts/Vector.md": "---\nname: Vector\n---\nThe plain tar's test vector.\n",
  // A name ustar cannot hold: travels in a PAX header.
  [`concepts/${"a".repeat(120)}.md`]: "---\nname: Long\n---\nA long name.\n",
};
const VECTOR_DIGEST = "sha256:bb23eedecb6274e55cf0d95a6d6484e9b35a734f6cdf233b8aafb7f8adfed86b";
const VECTOR_TAR_SHA256 = "8593fb8625810b901c27db2fab7eda4343262f6d9062a51e4ede264cc37943fd";
const VECTOR_INFOHASH = "2c9020ec5d1395cda8bf9d8789af097f3d9e220e";

async function writeTree(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-torrent-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bencode", () => {
  it("writes BEP 3's forms, keys sorted as bytes", () => {
    assert.equal(bencode(42).toString(), "i42e");
    assert.equal(bencode(-3).toString(), "i-3e");
    assert.equal(bencode("spam").toString(), "4:spam");
    assert.equal(bencode(["spam", 42]).toString(), "l4:spami42ee");
    assert.equal(bencode({ spam: "eggs", cow: "moo" }).toString(), "d3:cow3:moo4:spam4:eggse");
    assert.equal(bencode({ b: 1, "piece length": 2, a: 3 }).toString(), "d1:ai3e1:bi1e12:piece lengthi2ee");
    assert.equal(bencode("é").toString("latin1"), "2:Ã©", "a string's length is its UTF-8 bytes");
    assert.throws(() => bencode(1.5), /not a whole number/);
  });
});

describe("the plain tar", () => {
  it("meets the test vector: digest, tar sha256, infohash", async () => {
    const info = await readPackage(await writeTree(join(root, "v"), VECTOR));
    assert.equal(info.digest, VECTOR_DIGEST);
    const tar = await packTar(join(root, "v"), info.files);
    const t = packageTorrent(info.digest, tar);
    assert.equal(t.sha256, VECTOR_TAR_SHA256);
    assert.equal(t.infohash, VECTOR_INFOHASH);
    assert.equal(t.name, `${VECTOR_DIGEST.slice(7)}.tar`);
    assert.equal(t.length, tar.length);
  });

  it("is the same bytes whatever order the files are listed in, and the same tree twice", async () => {
    const a = await readPackage(await writeTree(join(root, "a"), VECTOR));
    const b = await writeTree(join(root, "b"), Object.fromEntries(Object.entries(VECTOR).reverse()));
    const one = await packTar(join(root, "a"), a.files);
    const two = await packTar(b, [...a.files].reverse());
    assert.ok(one.equals(two));
  });

  it("is what the .tar.gz holds, so either reads back as the same tree", async () => {
    const dir = await writeTree(join(root, "g"), VECTOR);
    const info = await readPackage(dir);
    const plain = await packTar(dir, info.files);
    const gz = await packArchive(dir, info.files);
    assert.ok(isGzip(gz) && !isGzip(plain));
    assert.ok(gunzipSync(gz).equals(plain));
    const cache = packageCache(join(root, "data"));
    assert.equal((await cache.putArchive(plain, info.digest)).digest, info.digest);
    const other = packageCache(join(root, "data2"));
    assert.equal((await other.putArchive(gz, info.digest)).digest, info.digest);
  });
});

describe("packageTorrent", () => {
  it("keeps web seeds out of the info dictionary, so the infohash does not move", () => {
    const tar = Buffer.alloc(TORRENT_PIECE_LENGTH * 2 + 7, 1);
    const digest = `sha256:${"ab".repeat(32)}`;
    const bare = packageTorrent(digest, tar);
    const seeded = packageTorrent(digest, tar, { webSeeds: ["https://a.example/packages/acme/x/archive?digest=d&format=tar"] });
    assert.equal(seeded.infohash, bare.infohash);
    assert.ok(seeded.torrent.includes(Buffer.from("8:url-list")));
    assert.ok(!bare.torrent.includes(Buffer.from("url-list")));
    assert.match(seeded.magnet, new RegExp(`^magnet:\\?xt=urn:btih:${bare.infohash}&dn=${"ab".repeat(32)}\\.tar&xl=${tar.length}&ws=https%3A%2F%2F`));
    // Three pieces: two whole, one of 7 bytes.
    const info = bencode({ length: tar.length, name: `${"ab".repeat(32)}.tar`, "piece length": TORRENT_PIECE_LENGTH, pieces: Buffer.concat([0, 1, 2].map((i) => createHash("sha1").update(tar.subarray(i * TORRENT_PIECE_LENGTH, (i + 1) * TORRENT_PIECE_LENGTH)).digest())) });
    assert.equal(bare.infohash, createHash("sha1").update(info).digest("hex"));
  });

  it("refuses what is not a digest, and an empty tar", () => {
    assert.throws(() => packageTorrent("sha256:short", Buffer.from("x")), /not a digest/);
    assert.throws(() => packageTorrent(`sha256:${"0".repeat(64)}`, Buffer.alloc(0)), /empty/);
  });
});

describe("fetchArchive with the catalog's tar", () => {
  it("refuses a plain tar that is not the one the catalog names, before unpacking it", async () => {
    const dir = await writeTree(join(root, "f"), VECTOR);
    const info = await readPackage(dir);
    const plain = await packTar(dir, info.files);
    const sha = createHash("sha256").update(plain).digest("hex");
    const serve = (body: Buffer) => (async () => new Response(new Uint8Array(body))) as unknown as typeof fetch;
    await assert.rejects(
      fetchArchive({ urls: ["https://a.example/x"], digest: info.digest, cache: packageCache(join(root, "d1")), tarSha256: "0".repeat(64), fetch: serve(plain) }),
      /its tar is sha256 .* not the 0{64} the catalog names/,
    );
    const got = await fetchArchive({ urls: ["https://a.example/x"], digest: info.digest, cache: packageCache(join(root, "d2")), tarSha256: sha, fetch: serve(plain) });
    assert.equal(got.digest, info.digest);
    // An older strut's .tar.gz is checked by its tree alone.
    const old = await fetchArchive({ urls: ["https://a.example/x"], digest: info.digest, cache: packageCache(join(root, "d3")), tarSha256: sha, fetch: serve(await packArchive(dir, info.files)) });
    assert.equal(old.digest, info.digest);
  });
});
