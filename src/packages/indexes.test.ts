/**
 * Following an INDEX (plans/marketplace.md §7, step 7's client half): a
 * strut follows an index by its key and the URL its card is served at; a
 * bare name (`acme/linear`) installs through the index's SIGNED card — the
 * row names the publisher's key and where its public catalog is — and
 * search reads the index strut's derived pages and the peers' installs.
 * Three struts over real HTTP, all behind an API key: a publisher, an
 * index, and a client.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import searchStep from "../steps/lib/package/search.js";
import type { IndexInfo } from "./index.js";
import { indexBaseOf, parseIndexesEnv, type IndexSubscriptionInfo, type PackageSearch } from "./indexes.js";

const KEY = "indexes-api-key";
const PEER_KEY = "indexes-peer-key";
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
  for (const k of ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY", "STRUT_INDEX", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_PEER_KEY"] = PEER_KEY;
  process.env["STRUT_SECRET_KEY"] = "indexes-secret";
  delete process.env["STRUT_INDEX"];
  delete process.env["STRUT_PACKAGE_INDEXES"];
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("following a package index", () => {
  let root: string;
  let publisher: Strut;
  let index: Strut;
  let client: Strut;
  let publisherWs: WorkspaceManager;
  let indexUrl: string;
  let publisherUrl: string;
  let catalogUrl: string;
  let indexKey: string;
  let publicKey: string;
  let linearDigest: string;

  const publish = async (pkg: string, version: string, workflows: string[], body: Record<string, unknown> = {}) => {
    const res = await publisher.app.request("/packages/publish", json({ package: pkg, version, workflows, ...body }));
    const out = (await res.json()) as { digest: string; error?: string };
    assert.equal(res.status, 201, JSON.stringify(out));
    return out;
  };
  const install = (c: Strut, body: Record<string, unknown>) => c.app.request("/packages/install", json(body));
  const search = async (c: Strut, q: string) => (await (await c.app.request(`/packages/search?q=${encodeURIComponent(q)}`, { headers: auth })).json()) as PackageSearch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-indexes-"));
    index = await boot(new WorkspaceManager(join(root, "index")), { index: true });
    indexUrl = `http://127.0.0.1:${await index.listen(0, "127.0.0.1")}`;
    publisherWs = new WorkspaceManager(join(root, "publisher"));
    publisher = await boot(publisherWs, { peers: [{ id: "index", baseUrl: indexUrl, token: PEER_KEY }] });
    publisherUrl = `http://127.0.0.1:${await publisher.listen(0, "127.0.0.1")}`;
    catalogUrl = `${publisherUrl}/packages/catalog?public=1`;
    await publisherWs.publishStep("acme/linear/fetch", STEP("acme/linear/fetch", "issues"));
    await publisherWs.publishWorkflow("acme/linear/sync", "v1", FLOW("acme/linear/sync", "acme/linear/fetch"));
    await publisherWs.publishStep("acme/notion/fetch", STEP("acme/notion/fetch", "pages"));
    await publisherWs.publishWorkflow("acme/notion/sync", "v1", FLOW("acme/notion/sync", "acme/notion/fetch"));
    linearDigest = (await publish("acme/linear", "1.0.0", ["acme/linear/sync"], { description: "Linear issues" })).digest;
    await publish("acme/notion", "0.1.0", ["acme/notion/sync"], { description: "Notion pages" });
    const pub = await publisher.app.request("/packages/channels/public", json({ package: "acme/linear", digest: linearDigest, public: true }, "PUT"));
    assert.equal(pub.status, 200, await pub.clone().text());
    publicKey = ((await (await publisher.app.request("/publisher", { headers: auth })).json()) as { public: string }).public;
    const row = await index.app.request("/index/acme", json({ key: publicKey, urls: [catalogUrl], description: "Acme's tools" }, "PUT"));
    assert.equal(row.status, 200, await row.clone().text());
    indexKey = ((await row.json()) as IndexInfo).key;
    client = await boot(new WorkspaceManager(join(root, "client")), {
      packageIndexes: [{ id: "public", key: indexKey, urls: [`${indexUrl}/index/catalog`] }],
    });
  });
  afterEach(async () => {
    await client.close();
    await publisher.close();
    await index.close();
    await rm(root, { recursive: true, force: true });
  });

  it("installs a bare name through the index's signed card, pinning the key the row named", async () => {
    const listed = (await (await client.app.request("/packages/indexes", { headers: auth })).json()) as { indexes: IndexSubscriptionInfo[] };
    assert.deepEqual(listed.indexes.map((s) => s.id), ["public"]);

    const res = await install(client, { ref: "acme/linear" });
    const out = (await res.json()) as { package: string; digest: string; packages: Array<{ source: { ref: string; url?: string } }> };
    assert.equal(res.status, 201, JSON.stringify(out));
    assert.equal(out.package, "acme/linear");
    assert.equal(out.digest, linearDigest);
    assert.deepEqual(out.packages.at(-1)!.source, { ref: `pk:${publicKey}/acme/linear`, url: catalogUrl }, "the install goes on as pk: with the row's key and URL");
    const meta = await client.workspace.getWorkflowMetadata("acme/linear/sync");
    assert.equal(meta!.versions[meta!.active]!.upstream!.key, publicKey, "the key the card named is pinned");

    // The card was read and is on the record.
    const after = (await (await client.app.request("/packages/indexes", { headers: auth })).json()) as { indexes: IndexSubscriptionInfo[] };
    assert.equal(after.indexes[0]!.read?.publishers, 1);
    assert.equal(after.indexes[0]!.error, undefined);
  });

  it("says what is wrong with a name it cannot install", async () => {
    // A publisher no index lists.
    let res = await install(client, { ref: "zeta/thing" });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /^package_not_listed: .*zeta.*\(public\)/);
    // A package the publisher keeps private: the public catalog does not list it.
    res = await install(client, { ref: "acme/notion" });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /^package_not_published/);
    // A name with a url, and an index this strut does not follow.
    assert.equal((await install(client, { ref: "acme/linear", url: catalogUrl })).status, 400);
    res = await install(client, { ref: "acme/linear", index: "nope" });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /^package_index_unknown/);

    // An index whose card cannot be read: 502, and the record says why.
    assert.equal((await client.app.request("/packages/indexes/public", { method: "DELETE", headers: auth })).status, 200);
    const put = await client.app.request("/packages/indexes/down", json({ key: indexKey, urls: [`${publisherUrl}/index/catalog`] }, "PUT"));
    assert.equal(put.status, 200);
    assert.match(((await put.json()) as IndexSubscriptionInfo).error!, /package_fetch_failed/);
    res = await install(client, { ref: "acme/linear" });
    assert.equal(res.status, 502);
    // A card sealed by another key is not this index's.
    await client.app.request("/packages/indexes/down", { method: "DELETE", headers: auth });
    await client.app.request("/packages/indexes/forged", json({ key: publicKey, urls: [`${indexUrl}/index/catalog`] }, "PUT"));
    res = await install(client, { ref: "acme/linear" });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /catalog_key/);

    // Following none: a name is not a ref.
    await client.app.request("/packages/indexes/forged", { method: "DELETE", headers: auth });
    res = await install(client, { ref: "acme/linear" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /follows no index/);
  });

  it("searches the indexes and the peers' installs, and the step reads the same", async () => {
    let found = await search(client, "linear");
    assert.deepEqual(found.packages.map((h) => [h.package, h.index, h.version]), [["acme/linear", "public", "1.0.0"]]);
    assert.deepEqual(found.errors, []);
    assert.deepEqual((await search(client, "pages")).packages, [], "the private package is not in the index");

    // The publisher follows no index but knows the client as a peer: it sees what the client installed.
    assert.equal((await install(client, { ref: "acme/linear" })).status, 201);
    const clientUrl = `http://127.0.0.1:${await client.listen(0, "127.0.0.1")}`;
    assert.equal((await publisher.app.request("/peers/client", json({ baseUrl: clientUrl, token: PEER_KEY }, "PUT"))).status, 200);
    found = await search(publisher, "linear");
    assert.deepEqual(found.packages, []);
    const peerHits = found.peers.filter((p) => p.peer === "client");
    assert.deepEqual(peerHits.map((p) => [p.package, p.digest]), [["acme/linear", linearDigest]]);
    assert.ok(found.errors.every((e) => e.peer !== "client"), JSON.stringify(found.errors));

    // A peer asking gets the indexes' answer alone.
    const asPeer = (await (await client.app.request("/packages/search?q=linear", { headers: { authorization: `Bearer ${PEER_KEY}` } })).json()) as PackageSearch;
    assert.deepEqual(asPeer.peers, []);

    const viaStep = (await searchStep.run({ query: "linear", limit: 30 }, { runId: "", path: "s", scope: {}, input: undefined, emit: async () => {}, services: client.services } as never)) as PackageSearch;
    assert.deepEqual(viaStep.packages.map((h) => h.package), ["acme/linear"]);
  });
});

describe("index subscriptions as configured", () => {
  it("reads STRUT_PACKAGE_INDEXES, and refuses one that is not a list of indexes", () => {
    assert.deepEqual(parseIndexesEnv(undefined), [], "no default index until Stakwork's is deployed");
    assert.deepEqual(parseIndexesEnv("[]"), []);
    const key = "y".repeat(52);
    assert.deepEqual(parseIndexesEnv(JSON.stringify([{ id: "a", key, urls: ["https://i.example/index/catalog"], extra: 1 }])), [{ id: "a", key, urls: ["https://i.example/index/catalog"] }]);
    assert.throws(() => parseIndexesEnv("{"), /not JSON/);
    assert.throws(() => parseIndexesEnv(JSON.stringify([{ id: "a", key: "short", urls: ["https://x"] }])), /\[0\]: key/);
    assert.throws(() => parseIndexesEnv(JSON.stringify({ id: "a" })), /a JSON list/);
  });

  it("finds an index strut's search beside its card, and none beside a static file", () => {
    assert.equal(indexBaseOf("https://idx.example/lab/index/catalog"), "https://idx.example/lab");
    assert.equal(indexBaseOf("https://cdn.example/stakwork-index.json"), undefined);
  });
});
