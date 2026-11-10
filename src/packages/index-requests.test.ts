/**
 * The index's REQUESTS DESK (plans/index-listing.md §1–§8) —
 * src/packages/index-requests.ts — over a real index (./index.ts) and a
 * stubbed network: each publisher is a host serving its public catalog at
 * `<base>/packages/catalog?public=1`, sealed by its own key.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore } from "../secret-store.js";
import { PackageCache } from "./cache.js";
import { canonicalJson, keyFromSeed, sealCard, type UnsignedCatalog } from "./card.js";
import { createPackageIndex, type PackageIndex } from "./index.js";
import { createRequestsDesk, type ListingAnswer, type RequestsDesk } from "./index-requests.js";
import { catalogUrlOf, sealListing, type UnsignedListing } from "./listing.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
type Signer = ReturnType<typeof keyFromSeed>;
let seedByte = 10;
const newSigner = (): Signer => keyFromSeed(Buffer.alloc(32, seedByte++));

describe("the index's requests desk", () => {
  let root: string;
  let clock: number;
  let seq: number;
  let served: Map<string, string>;
  let fetched: string[];
  let crawls: Array<{ key?: string; prefix?: string }>;
  let index: PackageIndex;
  let desk: RequestsDesk;
  let indexKey: string;

  const stubFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const body = served.get(url);
    return body ? new Response(body, { headers: { "content-type": "application/json" } }) : new Response("not here", { status: 404 });
  }) as typeof fetch;

  /** A publisher: its key, serving a public catalog with `packages` at `base`. */
  const serve = (signer: Signer, base: string, packages: string[] = []) => {
    const card = sealCard(
      { v: 1, key: signer.key, seq: Math.floor(clock * 1000) + seq++, packages: Object.fromEntries(packages.map((p) => [p, { releases: [{ version: "1.0.0", digest: DIGEST }] }])) } as UnsignedCatalog,
      signer.privateKey,
    );
    served.set(catalogUrlOf(base), canonicalJson(card));
  };
  /** A request's bytes, sealed by `signer`. */
  const ask = (signer: Signer, fields: Partial<UnsignedListing> & { prefix: string }) =>
    canonicalJson(sealListing({ v: 1, index: indexKey, key: signer.key, seq: Math.floor(clock * 1000) + seq++, ...fields }, signer.privateKey));
  const submit = (signer: Signer, fields: Partial<UnsignedListing> & { prefix: string }) => desk.submit(ask(signer, fields));
  const rows = async () => (await index.info())!.publishers;

  const boot = (opts: { autoHosts?: string[] } = {}) => {
    desk?.close();
    desk = createRequestsDesk({
      index: { ...index, crawl: async (f) => (crawls.push(f ?? {}), []) },
      dir: join(root, "index", "requests"),
      cache: new PackageCache(join(root, "cache")),
      autoHosts: opts.autoHosts ?? ["*.sphinx.chat:3355"],
      reserved: ["acme-corp"],
      fetch: stubFetch,
      now: () => clock,
    });
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-requests-"));
    clock = Date.parse("2026-11-09T12:00:00Z");
    seq = 0;
    served = new Map();
    fetched = [];
    crawls = [];
    index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), fetch: stubFetch, now: () => clock });
    boot();
  });
  afterEach(async () => {
    desk.close();
    await rm(root, { recursive: true, force: true });
  });

  /** The index's first row is its operator's, which mints its key. */
  const mint = async () => {
    const info = await index.setRow("seed", { key: newSigner().key, urls: ["https://elsewhere.example/packages/catalog?public=1"] }, { crawl: false });
    indexKey = info.key;
  };

  it("answers 'no key yet' before the operator's first row", async () => {
    indexKey = newSigner().key;
    const acme = newSigner();
    await assert.rejects(submit(acme, { prefix: "acme", base: "https://a.sphinx.chat:3355/lab" }), /^Error: index_no_key:/);
  });

  it("lists a free name from an auto host at once, one name per swarm; everything else waits with its reason", async () => {
    await mint();
    const acme = newSigner();
    serve(acme, "https://acme1.sphinx.chat:3355/lab", ["acme/linear"]);
    const listed = await submit(acme, { prefix: "acme", base: "https://acme1.sphinx.chat:3355/lab/", description: "Acme's tools", url: "https://acme.example" });
    assert.deepEqual(listed, { status: "listed", prefix: "acme", row: { key: acme.key, urls: ["https://acme1.sphinx.chat:3355/lab/packages/catalog?public=1"], description: "Acme's tools", url: "https://acme.example" } });
    assert.deepEqual((await rows())["acme"], listed.status === "listed" ? listed.row : undefined);
    assert.deepEqual(crawls, [{ prefix: "acme" }], "the publisher is read once listed, detached");

    // The same key, a second name: waits.
    serve(acme, "https://acme1.sphinx.chat:3355/lab", ["acme/linear", "acme2/x"]);
    assert.equal(((await submit(acme, { prefix: "acme2", base: "https://acme1.sphinx.chat:3355/lab" })) as { reason: string }).reason, "second name");
    // Another key on a host that holds a row: waits.
    const other = newSigner();
    serve(other, "https://acme1.sphinx.chat:3355", ["other/y"]);
    assert.equal(((await submit(other, { prefix: "other", base: "https://acme1.sphinx.chat:3355" })) as { reason: string }).reason, "same host");
    // A host not on the auto list: waits.
    const box = newSigner();
    serve(box, "https://strut.box.example", ["box/z"]);
    const waiting = (await submit(box, { prefix: "box", base: "https://strut.box.example" })) as ListingAnswer & { status: "pending" };
    assert.equal(waiting.status, "pending");
    assert.equal(waiting.reason, "host");
    assert.deepEqual(Object.keys(await rows()).sort(), ["acme", "seed"], "nothing else was listed");

    const { pending } = await desk.list();
    assert.deepEqual(pending.map((p) => [p.prefix, p.reason]).sort(), [["acme2", "second name"], ["box", "host"], ["other", "same host"]]);
    const boxed = pending.find((p) => p.prefix === "box")!;
    assert.deepEqual(boxed.catalog.packages, ["box/z"]);
    assert.equal(boxed.host, "strut.box.example");

    // The operator approves the box: listed; refuses the second name: answered for 30 days, with no fetch.
    const approved = await desk.approve(boxed.id, "operator");
    assert.equal(approved.status, "listed");
    assert.equal((await rows())["box"]!.key, box.key);
    const second = (await desk.list()).pending.find((p) => p.prefix === "acme2")!;
    await desk.refuse(second.id, "one name per publisher", "operator");
    const before = fetched.length;
    await assert.rejects(submit(acme, { prefix: "acme2", base: "https://acme1.sphinx.chat:3355/lab" }), /^Error: listing_refused: one name per publisher/);
    assert.equal(fetched.length, before, "a refusal is answered without a fetch");
    assert.deepEqual((await desk.list()).refused.map((r) => [r.prefix, r.reason, r.by]), [["acme2", "one name per publisher", "operator"]]);
    clock += 31 * 86_400_000;
    assert.deepEqual((await desk.list()).refused, [], "a refusal lasts 30 days");

    // The log holds every outcome.
    const log = (await readFile(join(root, "index", "requests", "log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { prefix: string; outcome: string });
    assert.deepEqual(log.map((l) => `${l.prefix} ${l.outcome}`), ["acme listed", "acme2 waiting", "other waiting", "box waiting", "box approved", "acme2 refused"]);
  });

  it("checks the request before it fetches anything, and the catalog before it decides", async () => {
    await mint();
    const acme = newSigner();
    const base = "https://acme1.sphinx.chat:3355/lab";
    serve(acme, base, ["acme/linear"]);
    const cheap = async (bytes: string, code: RegExp) => {
      const before = fetched.length;
      await assert.rejects(desk.submit(bytes), code);
      assert.equal(fetched.length, before, `no fetch for ${code}`);
    };
    // Another index's key.
    await cheap(canonicalJson(sealListing({ v: 1, index: newSigner().key, prefix: "acme", key: acme.key, base, seq: clock * 1000 }, acme.privateKey)), /listing_invalid: this request is for the index/);
    // A bad seal: signed by a key other than the one it names.
    const thief = newSigner();
    await cheap(canonicalJson(sealListing({ v: 1, index: indexKey, prefix: "acme", key: acme.key, base, seq: clock * 1000 }, thief.privateKey)), /listing_invalid: the seal is not/);
    // Stale, and replayed.
    await cheap(ask(acme, { prefix: "acme", base, seq: (clock - 11 * 60_000) * 1000 }), /listing_rollback: the request was signed at/);
    const once = ask(acme, { prefix: "acme", base });
    assert.equal((await desk.submit(once)).status, "listed");
    await cheap(once, /listing_rollback: a request from this key at seq/);
    // A reserved name, built in or the operator's.
    await cheap(ask(newSigner(), { prefix: "stakwork", base: "https://x.sphinx.chat:3355" }), /listing_reserved: stakwork/);
    await cheap(ask(newSigner(), { prefix: "acme-corp", base: "https://y.sphinx.chat:3355" }), /listing_reserved: acme-corp/);
    // A base that is a file, or carries a query: never a request.
    await cheap(ask(newSigner(), { prefix: "q", base: "https://z.sphinx.chat:3355/jobs/x/files" }), /listing_invalid: base is the server's root or its mount/);
    await cheap(ask(newSigner(), { prefix: "q", base: "https://z.sphinx.chat:3355/lab?t=abc" }), /listing_invalid: base has no query/);

    // A catalog served as a job file with a token on a trusted host never lists: the index reads only <base>/packages/catalog?public=1.
    const squatter = newSigner();
    const fileUrl = "https://z.sphinx.chat:3355/jobs/files?t=abc";
    served.set(fileUrl, served.get(catalogUrlOf(base))!.replace(acme.key, squatter.key));
    await assert.rejects(submit(squatter, { prefix: "q", base: "https://z.sphinx.chat:3355/jobs" }), /listing_no_catalog: https:\/\/z\.sphinx\.chat:3355\/jobs\/packages\/catalog\?public=1: package_fetch_failed/);
    // A catalog sealed by another key, and one with nothing under the name.
    const imposter = newSigner();
    await assert.rejects(submit(imposter, { prefix: "imp", base }), /listing_no_catalog: .*catalog_key/);
    const empty = newSigner();
    serve(empty, "https://empty.sphinx.chat:3355", ["someone/else"]);
    await assert.rejects(submit(empty, { prefix: "empty", base: "https://empty.sphinx.chat:3355" }), /listing_no_catalog: .*lists no package under empty\//);
    assert.ok(!(await rows())["empty"]);
  });

  it("lets the row's key edit and remove its row; a move or another key waits for the operator", async () => {
    await mint();
    const acme = newSigner();
    const base = "https://acme1.sphinx.chat:3355/lab";
    serve(acme, base, ["acme/linear"]);
    await submit(acme, { prefix: "acme", base, description: "first" });

    // An edit on the same host: at once.
    assert.equal((await submit(acme, { prefix: "acme", base, description: "second", live: true })).status, "listed");
    assert.equal((await rows())["acme"]!.description, "second");
    assert.deepEqual((await index.info())!.live["acme"], { url: base, description: "second" }, "a live row rides on the request, at the base");
    assert.equal((await submit(acme, { prefix: "acme", base, description: "second", live: false })).status, "listed");
    assert.deepEqual((await index.info())!.live, {});

    // A move to another host: waits, marked; the row stays where it was.
    const moved = "https://acme2.sphinx.chat:3355/lab";
    serve(acme, moved, ["acme/linear"]);
    const move = (await submit(acme, { prefix: "acme", base: moved })) as ListingAnswer & { status: "pending" };
    assert.equal(move.reason, "move");
    assert.equal((await desk.list()).pending[0]!.from, "acme1.sphinx.chat:3355");
    assert.deepEqual((await rows())["acme"]!.urls, [catalogUrlOf(base)]);

    // Another key for the held name: a takeover, marked; approving it replaces the key.
    const heir = newSigner();
    serve(heir, "https://acme3.sphinx.chat:3355", ["acme/linear"]);
    const takeover = (await submit(heir, { prefix: "acme", base: "https://acme3.sphinx.chat:3355" })) as ListingAnswer & { status: "pending" };
    assert.equal(takeover.reason, "takeover");
    const pending = (await desk.list()).pending.find((p) => p.reason === "takeover")!;
    assert.equal(pending.heldBy, acme.key);
    await desk.approve(pending.id);
    assert.equal((await rows())["acme"]!.key, heir.key);

    // Removal by a key that neither holds the row nor waits for it: refused.
    await assert.rejects(submit(newSigner(), { prefix: "acme", remove: true }), /listing_not_listed/);
    // The old key's waiting move: withdrawn from the queue; the row is the heir's still.
    assert.deepEqual(await submit(acme, { prefix: "acme", remove: true }), { status: "removed", prefix: "acme" });
    assert.deepEqual((await desk.list()).pending, []);
    assert.equal((await rows())["acme"]!.key, heir.key);
    // By the holder: gone, with no fetch.
    const before = fetched.length;
    assert.deepEqual(await submit(heir, { prefix: "acme", remove: true }), { status: "removed", prefix: "acme" });
    assert.equal(fetched.length, before);
    assert.ok(!(await rows())["acme"]);
  });

  it("keeps the queue bounded, one request per name and key", async () => {
    await mint();
    boot({ autoHosts: [] });
    const host = "https://strut.busy.example";
    const keys = [newSigner(), newSigner(), newSigner(), newSigner()];
    for (const [i, k] of keys.entries()) serve(k, `${host}/m${i}`, [`p${i}/x`]);
    for (let i = 0; i < 3; i++) assert.equal((await submit(keys[i]!, { prefix: `p${i}`, base: `${host}/m${i}` })).status, "pending");
    await assert.rejects(submit(keys[3]!, { prefix: "p3", base: `${host}/m3` }), /^Error: listing_busy: 3 requests from strut\.busy\.example/);
    // A new ask from a waiting key replaces its own.
    assert.equal((await submit(keys[0]!, { prefix: "p0", base: `${host}/m0`, description: "again" })).status, "pending");
    const { pending } = await desk.list();
    assert.equal(pending.length, 3);
    assert.equal(pending.find((p) => p.prefix === "p0")!.description, "again");
    // A request waits at most 30 days.
    clock += 31 * 86_400_000;
    assert.deepEqual((await desk.list()).pending, []);
  });

  it("reads a pinged publisher at most once a minute", async () => {
    await mint();
    const acme = newSigner();
    serve(acme, "https://acme1.sphinx.chat:3355", ["acme/linear"]);
    await submit(acme, { prefix: "acme", base: "https://acme1.sphinx.chat:3355" });
    crawls.length = 0;
    assert.deepEqual(await desk.ping(acme.key), { rows: 1 });
    assert.deepEqual(await desk.ping(acme.key), { rows: 1 });
    assert.deepEqual(crawls, [{ prefix: "acme" }], "the second ping folds into one read at the minute's end");
    clock += 61_000;
    await desk.ping(acme.key);
    assert.equal(crawls.length, 2);
    assert.deepEqual(await desk.ping(newSigner().key), { rows: 0 }, "a key no row names reads nothing");
  });
});
