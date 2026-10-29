/**
 * The package INDEX (plans/marketplace.md §7, step 7): an index strut lists
 * a publisher by prefix — its PUBLIC key and where its public catalog is
 * served — seals the rows into an index card anyone may read, follows the
 * publisher's public catalog (on the row, on the publisher's ping, on the
 * poll) and serves search and package pages over it. Two struts over real
 * HTTP, both behind an API key: the index's reads are what opens.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { INDEX_DOMAIN, readCard, type IndexCatalog } from "./card.js";
import type { IndexHit, IndexInfo, IndexPackage } from "./index.js";

const KEY = "index-api-key";
const PEER_KEY = "index-peer-key";
const auth = { authorization: `Bearer ${KEY}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const STEP = (type: string, out: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(out)}; } });\n`;
const FLOW = (name: string, step: string) => `name: ${name}\nsteps:\n  - { id: s, type: ${step} }\n`;
const boot = (ws: WorkspaceManager, extra: Record<string, unknown> = {}) =>
  createStrut({
    workspace: ws,
    store: new MemoryRunStore(),
    serveUi: false,
    scheduler: false,
    enableChat: false,
    systemWorkflows: false,
    browserWorkflows: false,
    privacyWorkflows: false,
    job: false,
    orchestrator: false,
    builder: false,
    views: false,
    concepts: false,
    stt: false,
    subscriptionPoll: false,
    ...extra,
  });
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY", "STRUT_INDEX"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_PEER_KEY"] = PEER_KEY;
  process.env["STRUT_SECRET_KEY"] = "index-secret";
  delete process.env["STRUT_INDEX"];
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the package index", () => {
  let root: string;
  let publisher: Strut;
  let index: Strut;
  let publisherWs: WorkspaceManager;
  let indexUrl: string;
  let catalogUrl: string;

  const publish = async (pkg: string, version: string, workflows: string[], body: Record<string, unknown> = {}) => {
    const res = await publisher.app.request("/packages/publish", json({ package: pkg, version, workflows, ...body }));
    const out = (await res.json()) as { digest: string; catalog: { key: string }; error?: string };
    assert.equal(res.status, 201, JSON.stringify(out));
    return out;
  };
  const makePublic = async (pkg: string, digest: string) => {
    const res = await publisher.app.request("/packages/channels/public", json({ package: pkg, digest, public: true }, "PUT"));
    assert.equal(res.status, 200, await res.clone().text());
  };
  const publicKey = async () => ((await (await publisher.app.request("/publisher", { headers: auth })).json()) as { public?: string }).public!;
  const info = async (): Promise<IndexInfo> => (await (await index.app.request("/index", { headers: auth })).json()) as IndexInfo;
  const search = async (q = "") => ((await (await fetch(`${indexUrl}/index/packages?q=${encodeURIComponent(q)}`)).json()) as { packages: IndexHit[] }).packages;
  /** The crawl is detached on a ping: wait for the index to hold `seq`. */
  const reached = async (prefix: string, pred: (s: IndexInfo["crawled"][number]) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const s = (await info()).crawled.find((c) => c.prefix === prefix);
      if (s && pred(s)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`the index never reached the state asked for: ${JSON.stringify((await info()).crawled)}`);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-index-"));
    publisherWs = new WorkspaceManager(join(root, "publisher"));
    index = await boot(new WorkspaceManager(join(root, "index")), { index: { urls: ["https://index.example/index/catalog"] } });
    indexUrl = `http://127.0.0.1:${await index.listen(0, "127.0.0.1")}`;
    // The publisher knows the index as a peer, so its publish pings it.
    publisher = await boot(publisherWs, { peers: [{ id: "index", baseUrl: indexUrl, token: PEER_KEY }] });
    const publisherUrl = `http://127.0.0.1:${await publisher.listen(0, "127.0.0.1")}`;
    catalogUrl = `${publisherUrl}/packages/catalog?public=1`;
    await publisherWs.publishStep("acme/linear/fetch", STEP("acme/linear/fetch", "issues"));
    await publisherWs.publishWorkflow("acme/linear/sync", "v1", FLOW("acme/linear/sync", "acme/linear/fetch"));
    await publisherWs.publishStep("acme/notion/fetch", STEP("acme/notion/fetch", "pages"));
    await publisherWs.publishWorkflow("acme/notion/sync", "v1", FLOW("acme/notion/sync", "acme/notion/fetch"));
  });
  afterEach(async () => {
    await publisher.close();
    await index.close();
    await rm(root, { recursive: true, force: true });
  });

  it("is off unless asked for", async () => {
    const plain = await boot(new WorkspaceManager(join(root, "plain")));
    try {
      assert.equal(plain.index, null);
      assert.equal((await plain.app.request("/index/catalog")).status, 401, "no such route: the gate answers");
      assert.equal((await plain.app.request("/index", { headers: auth })).status, 404);
    } finally {
      await plain.close();
    }
  });

  it("lists a publisher, seals the rows into a card anyone reads, and follows the public catalog into search and package pages", async () => {
    const linear = await publish("acme/linear", "1.0.0", ["acme/linear/sync"], { description: "Linear issues", license: "MIT" });
    const notion = await publish("acme/notion", "0.1.0", ["acme/notion/sync"], { description: "Notion pages" });
    await makePublic("acme/linear", linear.digest);
    const pub = await publicKey();

    // Nothing is listed yet: the card is a 404, the search is empty, the key is not minted.
    assert.equal((await index.app.request("/index", { headers: auth })).status, 404);
    assert.equal((await fetch(`${indexUrl}/index/catalog`)).status, 404);
    assert.deepEqual(await search(), []);

    // A row: the public key and the catalog's URL. The key is minted, the card sealed, the publisher read.
    const bad = await index.app.request("/index/acme", json({ key: linear.catalog.key, urls: [catalogUrl] }, "PUT"));
    assert.equal(bad.status, 200, "the fleet key is a key too; the crawl says it is not this catalog's");
    assert.match(((await bad.json()) as IndexInfo).crawled[0]!.error!, /catalog_key/);
    const put = await index.app.request("/index/acme", json({ key: pub, urls: [catalogUrl], description: "Acme's tools", url: "https://acme.example" }, "PUT"));
    assert.equal(put.status, 200, await put.clone().text());
    const listed = (await put.json()) as IndexInfo;
    assert.match(listed.key, /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/);
    assert.notEqual(listed.key, pub);
    assert.deepEqual(listed.publishers, { acme: { key: pub, urls: [catalogUrl], description: "Acme's tools", url: "https://acme.example" } });
    assert.deepEqual(listed.urls, ["https://index.example/index/catalog"]);
    assert.equal(listed.crawled[0]!.error, undefined, JSON.stringify(listed.crawled));
    assert.equal(listed.crawled[0]!.packages, 1, "only what is public");

    // The card: anyone reads it, as an INDEX card against the index key; a catalog reader refuses it.
    const res = await fetch(`${indexUrl}/index/catalog`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, no-cache");
    const text = await res.text();
    const card = readCard(text, { key: listed.key, kind: "index" });
    assert.deepEqual(card.card.publishers, listed.publishers);
    assert.deepEqual(card.card.urls, ["https://index.example/index/catalog"]);
    assert.throws(() => readCard(text, { key: listed.key }), /catalog_seal/, "sealed under the index domain, not the catalog's");
    assert.ok(INDEX_DOMAIN.startsWith("strut-index"));
    assert.equal((await fetch(`${indexUrl}/index/catalog?digest=${card.digest}`)).status, 200);
    assert.equal((await fetch(`${indexUrl}/index`)).status, 401, "the rows with their crawl state are the operator's");
    assert.equal((await fetch(`${indexUrl}/index/acme`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: pub, urls: [catalogUrl] }) })).status, 401);

    // Search and the package page: the public release, where to get it, and nothing of the private one.
    let hits = await search();
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], { package: "acme/linear", publisher: "acme", key: pub, urls: [catalogUrl], version: "1.0.0", digest: linear.digest, description: "Linear issues", license: "MIT" });
    assert.equal((await search("notion")).length, 0);
    assert.equal((await search("linear acme")).length, 1, "every word, in the name or the publisher");
    assert.equal((await fetch(`${indexUrl}/index/packages/acme/notion`)).status, 404);
    const page = (await (await fetch(`${indexUrl}/index/packages/acme/linear`)).json()) as IndexPackage;
    assert.equal(page.package, "acme/linear");
    assert.deepEqual(page.releases.map((r) => r.version), ["1.0.0"]);
    assert.deepEqual(page.channels, { public: linear.digest });

    // Make public pings the index (the publisher's peer) with the PUBLIC key: the next release shows up by itself.
    await makePublic("acme/notion", notion.digest);
    await reached("acme", (s) => s.packages === 2);
    hits = await search("pages");
    assert.deepEqual(hits.map((h) => h.package), ["acme/notion"]);

    // The key outlives the process; a removed row takes its crawl with it.
    await index.close();
    index = await boot(new WorkspaceManager(join(root, "index")), { index: true });
    indexUrl = `http://127.0.0.1:${await index.listen(0, "127.0.0.1")}`;
    const again = await info();
    assert.equal(again.key, listed.key);
    assert.equal(again.crawled[0]!.packages, 2);
    assert.equal((await index.app.request("/index/acme", { method: "DELETE", headers: auth })).status, 200);
    assert.deepEqual((await info()).publishers, {});
    assert.deepEqual(await search(), []);
    const emptied = readCard(await (await fetch(`${indexUrl}/index/catalog`)).text(), { key: listed.key, kind: "index", last: { seq: card.card.seq, digest: card.digest } });
    assert.deepEqual(emptied.card.publishers, {});
    assert.equal((await index.app.request("/index/acme", { method: "DELETE", headers: auth })).status, 404);
  });

  it("refuses a row that is not one, and a peer may ping but never list", async () => {
    const put = (body: unknown) => index.app.request("/index/acme", json(body, "PUT"));
    assert.equal((await put({ key: "nope", urls: [catalogUrl] })).status, 400);
    assert.equal((await put({ key: "y".repeat(52), urls: [] })).status, 400);
    assert.equal((await put({ key: "y".repeat(52), urls: ["ftp://x"] })).status, 400);
    assert.equal((await index.app.request("/index/Not%20A%20Prefix", json({ key: "y".repeat(52), urls: [catalogUrl] }, "PUT"))).status, 400);
    const asPeer = { authorization: `Bearer ${PEER_KEY}`, "content-type": "application/json" };
    assert.equal((await index.app.request("/index/acme", { method: "PUT", headers: asPeer, body: JSON.stringify({ key: "y".repeat(52), urls: [catalogUrl] }) })).status, 403);
    assert.equal((await index.app.request("/packages/subscriptions/sync", { method: "POST", headers: asPeer, body: JSON.stringify({ key: "y".repeat(52) }) })).status, 202);
    assert.equal((await index.app.request("/index/crawl", { method: "POST", headers: asPeer, body: "{}" })).status, 403);
    assert.equal((await index.app.request("/index/crawl", { method: "POST", ...{ headers: { ...auth, "content-type": "application/json" } }, body: "{}" })).status, 200);
  });
});
