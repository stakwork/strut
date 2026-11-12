/**
 * The package INDEX (plans/marketplace.md §7, step 7): an index strut lists
 * a publisher by prefix — its PUBLIC key and where its public catalog is
 * served — seals the rows into an index card anyone may read, follows the
 * publisher's public catalog (on the row, on the publisher's ping, on the
 * poll) and serves search and package pages over it. Two struts over real
 * HTTP, both behind an API key: the index's reads are what opens — and its
 * MCP door, `POST /index/mcp` (./index-tools.ts), the same three reads for
 * an agent with no credential.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createStrut, type Strut } from "../createStrut.js";
import { toolsetServer } from "../ai/mcp.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { INDEX_DOMAIN, readCard, type IndexCatalog } from "./card.js";
import { buildIndexTools, indexInstructions, llmsTxt } from "./index-tools.js";
import { createPackageIndex, withoutConceptDocs, type IndexConcept, type IndexConceptPage, type IndexHit, type IndexInfo, type IndexPackage } from "./index.js";
import { packArchive } from "./archive.js";
import { PackageCache } from "./cache.js";
import { canonicalJson, keyFromSeed, sealCard, type Catalog } from "./card.js";
import { MemorySecretStore } from "../secret-store.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const KEY = "index-api-key";
const PEER_KEY = "index-peer-key";
const auth = { authorization: `Bearer ${KEY}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const STEP = (type: string, out: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, description: "Fetch ${out}", effect: "read", secrets: ["LINEAR_API_KEY"], input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(out)}; } });\n`;
const FLOW = (name: string, step: string) => `name: ${name}\ndescription: Sync them\ninput:\n  team: { type: string }\nsteps:\n  - { id: s, type: ${step} }\n`;
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
const mcpJson = (r: { content: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
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
  let publisherUrl: string;

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
    publisherUrl = `http://127.0.0.1:${await publisher.listen(0, "127.0.0.1")}`;
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

  it("lists a publisher server's PUBLIC VIEW live: a row with no key, read from the server, beside the package rows", async () => {
    await publisher.rebuildRegistry();
    const put = await publisher.app.request("/public-view", json({ workflows: [{ name: "acme/linear/sync", runs: true }], steps: ["acme/linear/fetch"] }, "PUT"));
    assert.equal(put.status, 200, await put.clone().text());
    // A person's act on the index: no key, no catalog — where the view is served.
    assert.equal((await index.app.request("/index/live/acme", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: publisherUrl }) })).status, 401);
    assert.equal((await index.app.request("/index/live/acme", json({ url: `${publisherUrl}/?x=1` }, "PUT"))).status, 400);
    const res = await index.app.request("/index/live/acme", json({ url: `${publisherUrl}/`, description: "Acme's server" }, "PUT"));
    assert.equal(res.status, 200, await res.clone().text());
    const got = (await res.json()) as IndexInfo;
    assert.deepEqual(got.live, { acme: { url: publisherUrl, description: "Acme's server" } });
    assert.equal(got.liveCrawled[0]!.error, undefined, JSON.stringify(got.liveCrawled));
    assert.equal(got.liveCrawled[0]!.workflows, 1);
    assert.deepEqual(got.publishers, {}, "a live row is no package row");

    // The card carries it under the seal, and a reader that knows only `publishers` reads it as before.
    const { card } = readCard(Buffer.from(await (await fetch(`${indexUrl}/index/catalog`)).arrayBuffer()), { key: got.key, kind: "index" });
    assert.equal(card.live?.["acme"]?.url, publisherUrl);

    // Anyone lists the items; the store reads each from the publisher's /public.
    const items = ((await (await fetch(`${indexUrl}/index/live`)).json()) as { items: Array<{ kind: string; name: string; publisher: string; url: string; runs?: boolean }> }).items;
    assert.deepEqual(items.map((i) => [i.kind, i.name, i.publisher, i.url, i.runs ?? null]), [
      ["workflow", "acme/linear/sync", "acme", publisherUrl, true],
      ["step", "acme/linear/fetch", "acme", publisherUrl, null],
    ]);
    assert.deepEqual(((await (await fetch(`${indexUrl}/index/live?q=notion`)).json()) as { items: unknown[] }).items, []);
    const flow = await fetch(`${items[0]!.url}/public/workflows/${encodeURIComponent(items[0]!.name)}/flow`);
    assert.equal(flow.status, 200, "the item reads from its publisher, with no credential");
    assert.equal(flow.headers.get("access-control-allow-origin"), "*");

    // Taken out of the publisher's view, gone at the next read.
    await publisher.app.request("/public-view", json({}, "PUT"));
    await index.app.request("/index/crawl", { method: "POST", headers: auth });
    assert.deepEqual(((await (await fetch(`${indexUrl}/index/live`)).json()) as { items: unknown[] }).items, []);
    assert.equal((await index.app.request("/index/live/acme", { method: "DELETE", headers: auth })).status, 200);
    assert.deepEqual((await info()).live, {});
  });

  it("is off unless asked for", async () => {
    const plain = await boot(new WorkspaceManager(join(root, "plain")));
    try {
      assert.equal(plain.index, null);
      assert.equal((await plain.app.request("/index/catalog")).status, 401, "no such route: the gate answers");
      assert.equal((await plain.app.request("/index", { headers: auth })).status, 404);
      // The MCP door is the role's too: without it the gate answers, and with the key there is no route.
      assert.equal((await plain.app.request("/index/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
      assert.equal((await plain.app.request("/index/mcp", { method: "POST", headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status, 404);
      // llms.txt is the role's page, or the public view's (plans/paid-runs.md
      // §10): open to anyone, and with neither there is nothing to read.
      assert.equal((await plain.app.request("/llms.txt")).status, 404);
      assert.equal((await plain.app.request("/llms.txt", { headers: auth })).status, 404);
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
    assert.deepEqual(hits[0], {
      package: "acme/linear", publisher: "acme", key: pub, urls: [catalogUrl], version: "1.0.0", digest: linear.digest, description: "Linear issues", license: "MIT", requires: { secrets: ["LINEAR_API_KEY"] },
      // The archive was fetched from the route beside the catalog and read (./detail.ts): the store's face of the package.
      detail: { apps: [], workflows: 1, steps: 1, concepts: 0, secrets: ["LINEAR_API_KEY"], can: { spends: false, acts: false, code: true }, readme: false },
    });
    assert.equal(listed.crawled[0]!.derived, 1);
    assert.equal((await search("notion")).length, 0);
    assert.equal((await search("linear acme")).length, 1, "every word, in the name or the publisher");
    assert.equal((await fetch(`${indexUrl}/index/packages/acme/notion`)).status, 404);
    const page = (await (await fetch(`${indexUrl}/index/packages/acme/linear`)).json()) as IndexPackage;
    assert.deepEqual(await (await fetch(`${indexUrl}/index/packages/acme/linear?docs=0`)).json(), page, "docs=0 leaves out only Concept pages' text, and this package has none");
    assert.equal(page.package, "acme/linear");
    assert.deepEqual(page.releases.map((r) => r.version), ["1.0.0"]);
    assert.deepEqual(page.channels, { public: linear.digest });
    assert.equal(page.detailError, undefined);
    assert.equal(page.detail!.digest, linear.digest);
    assert.deepEqual(page.detail!.workflows.map((w) => [w.name, w.description, w.inputs.map((i) => i.name), w.steps, w.secrets]), [["sync", "Sync them", ["team"], ["fetch"], ["LINEAR_API_KEY"]]]);
    assert.deepEqual(page.detail!.steps.map((st) => [st.name, st.effect, st.secrets, st.lint, st.description]), [["fetch", "read", ["LINEAR_API_KEY"], [], "Fetch issues"]]);
    // The Concept pages across the packages: none here; the reads are open all the same.
    assert.deepEqual(await (await fetch(`${indexUrl}/index/concepts`)).json(), { concepts: [] });
    assert.equal((await fetch(`${indexUrl}/index/concepts/Nope`)).status, 404);

    // The same reads over MCP for an agent with NO credential (./index-tools.ts): three tools, none that installs.
    const agent = new Client({ name: "any-agent", version: "0" });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${indexUrl}/index/mcp`)));
    try {
      const { tools } = await agent.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["get_concept", "get_package", "search_live", "search_packages"]);
      for (const t of tools) assert.match(t.description!, t.name === "search_live" ? /A live item is NOT a package: nothing installs and nothing runs here/ : /Installing is a PERSON's decision/, t.name);
      const instructions = agent.getInstructions()!;
      for (const said of ["PACKAGE INDEX", "DERIVED", "re-verifies the package against its publisher", "Packages tab"]) assert.ok(instructions.includes(said), said);
      assert.ok(!instructions.includes("?store=1"), "no UI served here, so no store link");
      const found = mcpJson(await agent.callTool({ name: "search_packages", arguments: {} }));
      assert.deepEqual(found.packages.map((h: IndexHit) => h.package), ["acme/linear"]);
      assert.equal(found.packages[0].detail.workflows, 1);
      assert.match(found.install, /^Installing is a PERSON's decision/);
      const viaMcp = mcpJson(await agent.callTool({ name: "get_package", arguments: { package: "acme/linear" } }));
      assert.deepEqual(viaMcp.detail.workflows.map((w: { name: string }) => w.name), ["sync"]);
      assert.equal(viaMcp.store, undefined);
      assert.ok((await agent.callTool({ name: "get_package", arguments: { package: "acme/notion" } })).isError, "the private package: not here");
      assert.deepEqual(mcpJson(await agent.callTool({ name: "get_concept", arguments: {} })), { concepts: [], total: 0 });
      assert.ok((await agent.callTool({ name: "get_concept", arguments: { name: "Nope" } })).isError);
      assert.deepEqual(mcpJson(await agent.callTool({ name: "search_live", arguments: {} })).items, [], "no live row here");
    } finally {
      await agent.close().catch(() => {});
    }
    assert.equal((await fetch(`${indexUrl}/index/mcp`)).status, 405, "POST alone, like /mcp");
    assert.equal((await fetch(`${indexUrl}/index/mcp`, { method: "DELETE" })).status, 401, "the gate opens the POST and the reads, nothing else");

    // And for an agent that fetches URLs: llms.txt at the root (llmstxt.org), the store as one markdown page, open like the reads.
    const txt = await fetch(`${indexUrl}/llms.txt`);
    assert.equal(txt.status, 200);
    assert.match(txt.headers.get("content-type")!, /^text\/markdown/);
    const md = await txt.text();
    assert.match(md, /^# strut package index at 127\.0\.0\.1:\d+\n\n> The store of PACKAGES/);
    for (const said of [
      `claude mcp add --transport http strut-store ${indexUrl}/index/mcp`,
      `- [Search](${indexUrl}/index/packages?q=)`,
      `- [The index card](${indexUrl}/index/catalog)`,
      `key ${listed.key}`,
      "## Packages",
      `- [acme/linear](${indexUrl}/index/packages/acme/linear): Linear issues — 1.0.0; 1 workflow, 1 step; needs LINEAR_API_KEY`,
      "DERIVED",
      "re-verifies the package against its publisher",
      "Installing is a PERSON's decision",
      "## Concepts",
      "No listed package carries a Concept page yet.",
      "## Live",
      "No server's public view is listed yet.",
      `- [What the servers show live](${indexUrl}/index/live?q=)`,
      "search_packages, get_package, get_concept and search_live",
    ])
      assert.ok(md.includes(said), said);
    assert.ok(!md.includes("acme/notion"), "the private package is not on the page");
    assert.ok(!md.includes("?store=1"), "no UI served here, so no store page");

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

  it("lists only the names under the row's prefix: the key may sign others, the row binds one prefix", async () => {
    const linear = await publish("acme/linear", "1.0.0", ["acme/linear/sync"]);
    await makePublic("acme/linear", linear.digest);
    // The same key signs a package under a prefix this row does not cover.
    await publisherWs.publishStep("other/thing/fetch", STEP("other/thing/fetch", "things"));
    await publisherWs.publishWorkflow("other/thing/sync", "v1", FLOW("other/thing/sync", "other/thing/fetch"));
    const other = await publish("other/thing", "1.0.0", ["other/thing/sync"]);
    await makePublic("other/thing", other.digest);

    const put = await index.app.request("/index/acme", json({ key: await publicKey(), urls: [catalogUrl] }, "PUT"));
    assert.equal(put.status, 200, await put.clone().text());
    assert.equal(((await put.json()) as IndexInfo).crawled[0]!.packages, 1, "the catalog lists two; one is under acme");
    assert.deepEqual((await search()).map((h) => [h.package, h.publisher]), [["acme/linear", "acme"]]);
    assert.deepEqual(await search("thing"), []);
    assert.equal((await fetch(`${indexUrl}/index/packages/other/thing`)).status, 404);

    // A prefix every object answers to is no row.
    assert.equal((await index.app.request("/index/constructor", { method: "DELETE", headers: auth })).status, 404);
    assert.equal((await fetch(`${indexUrl}/index/packages/constructor/thing`)).status, 404);
  });

  it("lands a visitor with no credential on the store front, and the operator on the shell", async () => {
    const dist = join(root, "dist");
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<html>the strut ui</html>");
    const ui = await boot(new WorkspaceManager(join(root, "ui-index")), { index: true, serveUi: true, webDist: dist });
    const plain = await boot(new WorkspaceManager(join(root, "ui-plain")), { serveUi: true, webDist: dist });
    try {
      const home = await ui.app.request("/");
      assert.equal(home.status, 302);
      assert.equal(home.headers.get("location"), "./?store=1");
      const kept = await ui.app.request("/?wf=job");
      assert.equal(kept.headers.get("location"), "./?wf=job&store=1", "what else the URL carried rides along");
      assert.equal((await ui.app.request("/?store=1")).status, 200, "the store page itself");
      assert.equal((await ui.app.request("/?app=bench&solo=1&public=1")).status, 200, "a visitor's public app is served as asked: the store frames it");
      assert.equal((await ui.app.request("/", { headers: auth })).status, 200, "the operator's shell, with the key");
      assert.equal((await ui.app.request("/?key=" + KEY)).status, 200);
      assert.equal((await plain.app.request("/")).status, 200, "a strut without the role serves its shell as before");
      // llms.txt links the store page when the UI is served; a strut without the role has no such page.
      const txt = await ui.app.request("/llms.txt");
      assert.equal(txt.status, 200);
      assert.ok((await txt.text()).includes("- [The store page](http://localhost/?store=1)"), "the store page, for a person");
      assert.equal((await plain.app.request("/llms.txt")).status, 404, "nothing public there: no page");
    } finally {
      await ui.close();
      await plain.close();
    }
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


describe("a live row's Concept trees, and a read that fails", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-index-live-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("folds a live view's tree into the index's, keeping the view it read when the next read fails", async () => {
    let up = true;
    const served: Record<string, unknown> = {
      "https://pub.example/lab/public": { workflows: [], steps: [], types: [], apps: [{ name: "bench", version: "v2", title: "Bench" }], concepts: [{ name: "Law", pages: 2 }] },
      "https://pub.example/lab/public/concepts": { concepts: [{ ref_id: "1", name: "Law", description: "The root", root: "Law" }, { ref_id: "2", name: "Civil procedure", parent: "Law", root: "Law" }] },
    };
    const fakeFetch = (async (input: string | URL | Request) => {
      const body = up ? served[String(input)] : undefined;
      return body === undefined ? new Response("down", { status: 503 }) : new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), fetch: fakeFetch });
    const info = await index.setLive("openlaw", { url: "https://pub.example/lab" });
    assert.deepEqual(info.liveCrawled.map((s) => [s.prefix, s.apps, s.concepts, s.error ?? null]), [["openlaw", 1, 2, null]]);
    const tree = await index.concepts();
    assert.deepEqual(tree.map((c) => [c.name, c.parents ?? null, c.packages.length, c.live?.map((l) => l.publisher)]), [["Civil procedure", ["Law"], 0, ["openlaw"]], ["Law", null, 0, ["openlaw"]]]);
    const page = (await index.concept("Civil procedure"))!;
    assert.deepEqual(page.parents.map((p) => p.name), ["Law"]);
    assert.equal(page.docs, undefined, "a live page's docs are read from its publisher");
    assert.deepEqual((await index.live("bench")).map((i) => [i.kind, i.name, i.title, i.version]), [["app", "bench", "Bench", "v2"]]);

    up = false;
    const [again] = await Promise.all([index.crawl(), Promise.resolve()]);
    assert.deepEqual(again, [], "no package rows to report");
    const kept = (await index.info())!.liveCrawled[0]!;
    assert.match(kept.error!, /503/);
    assert.equal(kept.apps, 1, "the view read before is kept");
    assert.equal((await index.live()).length, 2);
  });

  it("carries what anyone may RUN there with its price (plans/paid-runs.md §10): beside a public item, an item of its own when only runnable, a stranger's fields checked", async () => {
    const served: Record<string, unknown> = {
      "https://pub.example/public": {
        workflows: [{ name: "cve/scan", description: "Scan a package", runs: true }],
        steps: [],
        types: [],
        apps: [],
        concepts: [],
        runnable: [
          { kind: "workflow", name: "cve/scan", base: 0, markup: 0, capUsd: null, reserve: 0, results: "output", input: { pkg: { type: "string" } }, recent: { days: 30, runs: 12, average: 0 } },
          { kind: "workflow", name: "voxel/character", description: "A rigged character", base: 0.1, markup: 1.5, capUsd: 5, reserve: 7.6, results: "run", recent: { days: 30, runs: 3, average: 2.25 } },
          { kind: "step", name: "cve/lookup", base: 0.02, markup: 0, capUsd: null, reserve: 0.02, results: "output" },
          // A stranger's answer: what the index cannot show is left out.
          { kind: "workflow", name: "bad", base: "free", markup: 0, reserve: 0 },
          { kind: "workflow", name: "negative", base: -1, markup: 0, reserve: 0 },
          { kind: "app", name: "not-runnable", base: 0, markup: 0, reserve: 0 },
          "not an item",
        ],
      },
    };
    const fakeFetch = (async (input: string | URL | Request) => {
      const body = served[String(input)];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), fetch: fakeFetch });
    const info = await index.setLive("acme", { url: "https://pub.example" });
    assert.equal(info.liveCrawled[0]!.error, undefined);
    assert.equal(info.liveCrawled[0]!.runnable, 3);
    const items = await index.live();
    const byName = Object.fromEntries(items.map((i) => [`${i.kind}:${i.name}`, i]));
    assert.deepEqual(Object.keys(byName).sort(), ["step:cve/lookup", "workflow:cve/scan", "workflow:voxel/character"]);
    // Public AND runnable: one item, its price beside it.
    assert.deepEqual(byName["workflow:cve/scan"]!.run, { base: 0, markup: 0, capUsd: null, reserve: 0, results: "output", recent: { days: 30, runs: 12, average: 0 } });
    assert.equal(byName["workflow:cve/scan"]!.definition, undefined);
    assert.equal(byName["workflow:cve/scan"]!.runs, true);
    // Runnable alone: an item of its own, its definition not public, no input kept (the store reads it from the publisher).
    const voxel = byName["workflow:voxel/character"]!;
    assert.equal(voxel.definition, false);
    assert.equal(voxel.description, "A rigged character");
    assert.deepEqual(voxel.run, { base: 0.1, markup: 1.5, capUsd: 5, reserve: 7.6, results: "run", recent: { days: 30, runs: 3, average: 2.25 } });
    assert.equal((voxel.run as Record<string, unknown>)["input"], undefined);
    assert.deepEqual(byName["step:cve/lookup"]!.run, { base: 0.02, markup: 0, capUsd: null, reserve: 0.02, results: "output" });
    // Searchable by its words like any live item.
    assert.deepEqual((await index.live("rigged")).map((i) => i.name), ["voxel/character"]);
  });

  it("tells an agent what the live servers show and what anyone may run there (plans/public-view-listing.md, work item 2): ## Live in llms.txt, and search_live", async () => {
    const served: Record<string, unknown> = {
      "https://swarm1.example:3355/lab/public": {
        workflows: [{ name: "public-echo", description: "Echoes what you send", runs: false }],
        steps: [],
        types: [],
        apps: [{ name: "bench", version: "v2", title: "Bench" }],
        concepts: [],
        runnable: [
          { kind: "workflow", name: "public-echo", base: 0, markup: 0, capUsd: null, reserve: 0, results: "output", recent: { days: 30, runs: 4, average: 0 } },
          { kind: "workflow", name: "voxel/character", description: "A rigged character", base: 0.1, markup: 1.5, capUsd: 5, reserve: 7.6, results: "run" },
          { kind: "step", name: "cve/lookup", base: 0.02, markup: 0, capUsd: null, reserve: 0.02, results: "output" },
        ],
      },
    };
    const fakeFetch = (async (input: string | URL | Request) => {
      const body = served[String(input)];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), fetch: fakeFetch });
    await index.setLive("openlaw", { url: "https://swarm1.example:3355/lab/", description: "Legal research, live" });
    await index.setLive("down", { url: "https://down.example" });

    const md = await llmsTxt(index, { publicUrl: "https://index.example" });
    const live = md.slice(md.indexOf("## Live"), md.indexOf("## Optional"));
    for (const said of [
      "runs ON that server, with no account",
      "- [openlaw](https://swarm1.example:3355/lab/llms.txt): Legal research, live — served at https://swarm1.example:3355/lab — shows 1 app, 1 workflow, 3 things anyone may run — MCP at https://swarm1.example:3355/lab/public/mcp",
      "- [public-echo](https://swarm1.example:3355/lab/public/workflows/public-echo/run): Echoes what you send — a workflow to run on openlaw — free; 4 in the last 30 days, $0.00 charged on average",
      "- [voxel/character](https://swarm1.example:3355/lab/public/workflows/voxel%2Fcharacter/run): A rigged character — a workflow to run on openlaw — $0.10 + 1.5× what a run costs, at most $5.00 of cost; needs $7.60 of credit to start — its definition is not public",
      "- [cve/lookup](https://swarm1.example:3355/lab/public/steps/cve/lookup/run): a step to call on openlaw — $0.02 a call; needs $0.02 of credit to start — its definition is not public",
      "- [down](https://down.example/llms.txt): served at https://down.example — not read: /public: 404 — MCP at https://down.example/public/mcp",
    ])
      assert.ok(live.includes(said), `${said}\n---\n${live}`);
    assert.ok(!live.includes("[bench]"), "an app is the server's to describe, in its own llms.txt");

    const server = await toolsetServer({ tools: buildIndexTools(index, {}), instructions: indexInstructions({ publicUrl: "https://index.example" }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientSide);
    try {
      assert.match(mcp.getInstructions()!, /search_live finds what the listed servers show LIVE/);
      const all = mcpJson(await mcp.callTool({ name: "search_live", arguments: {} }));
      assert.equal(all.total, 4);
      assert.match(all.how, /runs ON its server with no account/);
      const echo = all.items.find((i: { name: string }) => i.name === "public-echo");
      assert.deepEqual(
        { url: echo.url, llms: echo.llms, mcp: echo.mcp, run_at: echo.run_at, price: echo.price },
        { url: "https://swarm1.example:3355/lab", llms: "https://swarm1.example:3355/lab/llms.txt", mcp: "https://swarm1.example:3355/lab/public/mcp", run_at: "https://swarm1.example:3355/lab/public/workflows/public-echo/run", price: "free; 4 in the last 30 days, $0.00 charged on average" },
      );
      const bench = all.items.find((i: { name: string }) => i.name === "bench");
      assert.equal(bench.run_at, undefined);
      assert.equal(bench.price, undefined);
      const runnable = mcpJson(await mcp.callTool({ name: "search_live", arguments: { runnable: true } }));
      assert.deepEqual(runnable.items.map((i: { name: string }) => i.name).sort(), ["cve/lookup", "public-echo", "voxel/character"]);
      assert.deepEqual(mcpJson(await mcp.callTool({ name: "search_live", arguments: { query: "rigged" } })).items.map((i: { name: string }) => i.name), ["voxel/character"]);
    } finally {
      await mcp.close().catch(() => {});
    }
  });
});

describe("the concept tree across the crawled packages", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-index-concepts-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A package directory → its archive bytes and digest. */
  const archive = async (name: string, files: Record<string, string>): Promise<{ gz: Buffer; digest: string }> => {
    const dir = join(root, "pkgs", ...name.split("/"));
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    const info = await new PackageCache(join(root, "scratch-cache")).putDir(dir);
    return { gz: await packArchive(dir, info.files), digest: info.digest };
  };

  it("serves an app's screenshots from the cache: only a path the derived page lists, at its current release", async () => {
    const { privateKey, key } = keyFromSeed(Buffer.alloc(32, 9));
    const desk = await archive("openlaw/desk", {
      "strut.yaml": "package: openlaw/desk\nversion: 1.0.0\n",
      "apps/desk/app.yaml": "title: Legal Desk\nscreenshots:\n  - { file: public/board.png, caption: The board }\n  - public/missing.png\n  - public/thread.jpg\n",
      "apps/desk/src/App.tsx": "export default () => null;\n",
      "apps/desk/public/board.png": "PNG board",
      "apps/desk/public/thread.jpg": "JPG thread",
    });
    const card = sealCard(
      { v: 1, key, seq: 1, packages: { "openlaw/desk": { releases: [{ version: "1.0.0", digest: desk.digest }] } }, channels: { public: { "openlaw/desk": desk.digest } } },
      privateKey,
    ) as Catalog;
    const served: Record<string, Buffer | string> = {
      "https://pub.example/packages/catalog": canonicalJson(card),
      "https://pub.example/packages/openlaw/desk/archive": desk.gz,
    };
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = served[url] ?? served[url.split("?")[0]!];
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body, { status: 200 });
    }) as typeof fetch;
    const index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), fetch: fakeFetch });
    const info = await index.setRow("openlaw", { key, urls: ["https://pub.example/packages/catalog?public=1"] });
    assert.equal(info.crawled[0]!.derived, 1, JSON.stringify(info.crawled));

    // The derived page and the search hit list the files the archive holds, in the manifest's order.
    const shots = [{ path: "apps/desk/public/board.png", caption: "The board" }, { path: "apps/desk/public/thread.jpg" }];
    assert.deepEqual((await index.package("openlaw/desk"))!.detail!.apps[0]!.screenshots, shots);
    assert.deepEqual((await index.search(""))[0]!.detail!.apps[0]!.screenshots, shots, "the Browse card's square is the first");

    const board = (await index.screenshot("openlaw/desk", "apps/desk/public/board.png"))!;
    assert.equal(board.bytes.toString(), "PNG board");
    assert.equal(board.type, "image/png");
    assert.equal(board.digest, desk.digest);
    assert.equal((await index.screenshot("openlaw/desk", "apps/desk/public/thread.jpg", desk.digest))!.type, "image/jpeg");
    // Nothing the page does not list: another file of the package, a listed one not in the archive, another release.
    assert.equal(await index.screenshot("openlaw/desk", "apps/desk/app.yaml"), undefined);
    assert.equal(await index.screenshot("openlaw/desk", "apps/desk/public/missing.png"), undefined);
    assert.equal(await index.screenshot("openlaw/desk", "apps/desk/public/board.png", `sha256:${"0".repeat(64)}`), undefined);
    assert.equal(await index.screenshot("openlaw/nope", "apps/desk/public/board.png"), undefined);
  });

  it("folds every package's Concept pages into one tree, with the docs, children and parents of each", async () => {
    const seed = Buffer.alloc(32, 7);
    const { privateKey, key } = keyFromSeed(seed);
    const law = await archive("openlaw/civil", {
      "strut.yaml": "package: openlaw/civil\nversion: '12'\n",
      "concepts/Law.md": "---\ndescription: The root\n---\n\nAll of it.\n",
      "concepts/Civil procedure.md": "---\ndescription: How a civil case moves\nparent: Law\n---\n\nPleadings, discovery, trial.\n",
      "concepts/Statute of limitations.md": "---\nparent: Civil procedure\n---\n\nHow long you have.\n",
    });
    const forked = await archive("openlaw/limits", {
      "strut.yaml": "package: openlaw/limits\nversion: 0.3.0\n",
      "concepts/Statute of limitations.md": "---\ndescription: A fork's page\nparent: Civil procedure\n---\n\nAnother reading.\n",
      "concepts/Tolling.md": "---\nparent: Statute of limitations\n---\n\nWhen the clock stops.\n",
      // The new page form: named by `name` whatever its file, every parent.
      "concepts/equitable.md": "---\nname: Tolling/Equitable\ndescription: When fairness pauses it\nparents:\n  - Law\n  - Tolling\n---\n\nA court's discretion.\n",
    });
    const card = sealCard(
      {
        v: 1, key, seq: 1_000_000,
        packages: { "openlaw/civil": { description: "Civil procedure", releases: [{ version: "12", digest: law.digest }] }, "openlaw/limits": { releases: [{ version: "0.3.0", digest: forked.digest }] } },
        channels: { public: { "openlaw/civil": law.digest, "openlaw/limits": forked.digest } },
      },
      privateKey,
    ) as Catalog;
    const served: Record<string, Buffer | string> = {
      "https://pub.example/packages/catalog": canonicalJson(card),
      [`https://pub.example/packages/openlaw/civil/archive?digest=${encodeURIComponent(law.digest)}&public=1`]: law.gz,
      [`https://pub.example/packages/openlaw/limits/archive?digest=${encodeURIComponent(forked.digest)}&public=1`]: forked.gz,
    };
    const fetched: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      const body = served[url] ?? served[url.split("?")[0]!];
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body, { status: 200 });
    }) as typeof fetch;
    const index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), fetch: fakeFetch });
    const info = await index.setRow("openlaw", { key, urls: ["https://pub.example/packages/catalog?public=1"] });
    assert.equal(info.crawled[0]!.error, undefined, JSON.stringify(info.crawled));
    assert.equal(info.crawled[0]!.packages, 2);
    assert.equal(info.crawled[0]!.derived, 2);

    // llms.txt lists every page under ## Concepts, each a link to its JSON page, with its parent and the packages that carry it.
    const md = await llmsTxt(index, { publicUrl: "https://index.example/" });
    assert.ok(md.includes("- [Law](https://index.example/index/concepts/Law): "), md);
    assert.ok(/- \[Law\]\([^)]+\): .*a root — in openlaw\/civil\n/.test(md), md);
    assert.ok(md.includes("- [Statute of limitations](https://index.example/index/concepts/Statute%20of%20limitations): "), md);
    assert.ok(/\[Statute of limitations\]\([^)]+\): .*under Civil procedure — in openlaw\/civil, openlaw\/limits\n/.test(md), md);
    assert.ok(md.includes("- [openlaw/civil](https://index.example/index/packages/openlaw/civil): Civil procedure — 12; "), md);

    const all = await index.concepts();
    assert.deepEqual(all.map((c: IndexConcept) => [c.name, c.parents, c.packages.map((p) => p.package)]), [
      ["Civil procedure", ["Law"], ["openlaw/civil"]],
      ["Law", undefined, ["openlaw/civil"]],
      ["Statute of limitations", ["Civil procedure"], ["openlaw/civil", "openlaw/limits"]],
      ["Tolling", ["Statute of limitations"], ["openlaw/limits"]],
      ["Tolling/Equitable", ["Law", "Tolling"], ["openlaw/limits"]],
    ]);
    // A page with two parents is a child of each; its ancestors run through its first.
    assert.deepEqual((await index.concept("Law"))!.children.map((c) => c.name), ["Civil procedure", "Tolling/Equitable"]);
    assert.deepEqual((await index.concept("Tolling"))!.children, [{ name: "Tolling/Equitable", description: "When fairness pauses it" }]);
    assert.deepEqual((await index.concept("Tolling/Equitable"))!.parents, [{ name: "Law", description: "The root" }]);
    assert.ok(/\[Tolling\/Equitable\]\(https:\/\/index\.example\/index\/concepts\/Tolling%2FEquitable\): When fairness pauses it — under Law, Tolling — in openlaw\/limits\n/.test(md), md);
    assert.equal(all.find((c) => c.name === "Statute of limitations")!.description, "A fork's page", "a field the first package's page leaves blank is the next one's");
    assert.deepEqual((await index.concepts("clock")).map((c) => c.name), [], "the search is over names and descriptions, never the docs");
    assert.deepEqual((await index.concepts("civil")).map((c) => c.name), ["Civil procedure"]);

    const page = (await index.concept("Statute of limitations")) as IndexConceptPage;
    assert.match(page.docs!, /How long you have/, "the first package's docs");
    assert.deepEqual(page.children, [{ name: "Tolling" }]);
    assert.deepEqual(page.parents, [{ name: "Civil procedure", description: "How a civil case moves" }, { name: "Law", description: "The root" }]);
    assert.deepEqual((await index.concept("Law"))!.parents, []);
    assert.equal(await index.concept("Nope"), undefined);

    // A page derived before the new page form kept one `parent`: read as its parents.
    const stored = join(root, "index", "crawl", "pages", "openlaw", "civil.json");
    const before = await readFile(stored, "utf8");
    assert.ok(before.includes('"parents":["Law"]'), before);
    await writeFile(stored, before.replace('"parents":["Law"]', '"parent":"Law"'));
    assert.deepEqual((await index.concepts("civil")).map((c) => [c.name, c.parents]), [["Civil procedure", ["Law"]]]);
    assert.deepEqual((await index.package("openlaw/civil"))!.detail!.concepts.find((c) => c.name === "Civil procedure")!.parents, ["Law"]);

    // The store's read of a package (`?docs=0`): the tree's names and parents, no page's text.
    const whole = (await index.package("openlaw/civil"))!;
    assert.match(whole.detail!.concepts.find((c) => c.name === "Statute of limitations")!.docs!, /How long you have/);
    const slim = withoutConceptDocs(whole);
    assert.deepEqual(slim.detail!.concepts.map((c) => [c.name, c.parents, "docs" in c]), whole.detail!.concepts.map((c) => [c.name, c.parents, false]));
    assert.deepEqual({ ...slim, detail: undefined }, { ...whole, detail: undefined }, "nothing else of the page changes");

    // The index's tools (./index-tools.ts) over the same functions: the page a model reads (Concept docs left out), the tree, one page — each linking its store page when a store is served.
    const server = await toolsetServer({ tools: buildIndexTools(index, { store: "https://store.example" }), instructions: indexInstructions({ publicUrl: "https://store.example", store: "https://store.example" }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientSide);
    try {
      assert.ok(mcp.getInstructions()!.includes("https://store.example/?store=1&pkg=<publisher/name>"), "where a person installs from");
      const civil = mcpJson(await mcp.callTool({ name: "get_package", arguments: { package: "openlaw/civil" } }));
      assert.equal(civil.store, "https://store.example/?store=1&pkg=openlaw%2Fcivil");
      assert.deepEqual(civil.detail.concepts.map((c: { name: string }) => [c.name, "docs" in c]), [["Civil procedure", false], ["Law", false], ["Statute of limitations", false]]);
      const sol = mcpJson(await mcp.callTool({ name: "get_concept", arguments: { name: "Statute of limitations" } }));
      assert.match(sol.docs, /How long you have/);
      assert.deepEqual(sol.children, [{ name: "Tolling" }]);
      assert.equal(sol.store, "https://store.example/?store=1&concept=Statute%20of%20limitations");
      assert.deepEqual(mcpJson(await mcp.callTool({ name: "get_concept", arguments: { query: "civil" } })).concepts.map((c: IndexConcept) => c.name), ["Civil procedure"]);
      const hits = mcpJson(await mcp.callTool({ name: "search_packages", arguments: { query: "civil" } }));
      assert.equal(hits.packages[0].detail.concepts, 3);
      assert.equal(hits.store, "https://store.example/?store=1&q=civil");
    } finally {
      await mcp.close().catch(() => {});
    }

    // A second crawl reads the catalog and no archive again: the pages are kept by digest.
    fetched.length = 0;
    await index.crawl();
    assert.deepEqual(fetched, ["https://pub.example/packages/catalog?public=1"]);
    const hit = (await index.search("civil"))[0]!;
    assert.equal(hit.detail?.concepts, 3);
    // The row gone, the pages go with it.
    assert.equal(await index.removeRow("openlaw"), true);
    assert.deepEqual(await index.concepts(), []);
  });
});

describe("self-serve listing over HTTP (plans/index-listing.md)", () => {
  let root: string;
  let publisher: Strut;
  let index: Strut;
  let publisherWs: WorkspaceManager;
  let publisherUrl: string;
  let indexUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-listing-"));
    publisherWs = new WorkspaceManager(join(root, "publisher"));
    publisher = await boot(publisherWs);
    publisherUrl = `http://127.0.0.1:${await publisher.listen(0, "127.0.0.1")}`;
    // No auto hosts: every request waits for the operator. Plain http, for the test's loopback.
    index = await boot(new WorkspaceManager(join(root, "index")), { index: { allowHttp: true } });
    indexUrl = `http://127.0.0.1:${await index.listen(0, "127.0.0.1")}`;
    for (const [type, out] of [["acme/linear/fetch", "issues"], ["acme/notion/fetch", "pages"]] as const) {
      await publisherWs.publishStep(type, STEP(type, out));
      await publisherWs.publishWorkflow(type.replace("/fetch", "/sync"), "v1", FLOW(type.replace("/fetch", "/sync"), type));
    }
  });
  afterEach(async () => {
    await publisher.close();
    await index.close();
    await rm(root, { recursive: true, force: true });
  });

  const publishPublic = async (pkg: string, workflow: string) => {
    const res = await publisher.app.request("/packages/publish", json({ package: pkg, version: "1.0.0", workflows: [workflow], channel: "public", public: true }));
    assert.equal(res.status, 201, await res.clone().text());
  };
  const lines = async () => ((await (await publisher.app.request("/publisher/listings", { headers: auth })).json()) as { listings: Array<{ index: string; listed: boolean; requests?: string; asked?: { status: string; reason?: string } }> }).listings;

  it("a publisher asks, the operator approves, the store follows its releases on its ping, and it withdraws", async () => {
    assert.equal((await publisher.app.request("/publisher", json({ name: "acme" }, "PUT"))).status, 200);
    // Before Make public there is no key to sign with.
    const early = await publisher.app.request("/publisher/listings", json({ index: "nowhere", base: publisherUrl }));
    assert.equal(early.status, 404, await early.clone().text());

    // The index's operator lists its first row by hand: that mints the index key.
    const seeded = await index.app.request("/index/seed", json({ key: "y".repeat(52), urls: ["http://127.0.0.1:1/packages/catalog?public=1"] }, "PUT"));
    assert.equal(seeded.status, 200, await seeded.clone().text());
    const indexKey = ((await seeded.json()) as IndexInfo).key;
    assert.equal((await publisher.app.request("/packages/indexes/stakwork", json({ key: indexKey, urls: [`${indexUrl}/index/catalog`], label: "Stakwork" }, "PUT"))).status, 200);
    assert.equal((await publisher.app.request("/publisher/listings", json({ index: "stakwork", base: publisherUrl }))).status, 409, "no public key yet");

    await publishPublic("acme/linear", "acme/linear/sync");
    assert.deepEqual((await lines()).map((l) => [l.index, l.listed, l.requests]), [["stakwork", false, `${indexUrl}/index/requests`]]);

    // The ask: sealed by the PUBLIC key, sent to the index beside the card; it waits there.
    const asked = await publisher.app.request("/publisher/listings", json({ index: "stakwork", base: `${publisherUrl}/`, description: "Acme's tools" }));
    assert.equal(asked.status, 202, await asked.clone().text());
    const answer = (await asked.json()) as { status: string; reason: string; prefix: string; record: { status: string; reason: string } };
    assert.deepEqual([answer.status, answer.reason, answer.prefix, answer.record.status, answer.record.reason], ["pending", "host", "acme", "pending", "host"]);
    assert.equal((await lines())[0]!.asked!.status, "pending");

    // The operator's routes are behind the key; the open POSTs are not.
    assert.equal((await fetch(`${indexUrl}/index/requests`)).status, 401);
    assert.equal((await fetch(`${indexUrl}/index/requests`, { method: "POST", body: "{}" })).status, 400, "open: the request carries its own proof");
    assert.equal((await fetch(`${indexUrl}/index/ping`, { method: "POST", body: JSON.stringify({ key: "y".repeat(52) }) })).status, 202);
    const waiting = ((await (await index.app.request("/index/requests", { headers: auth })).json()) as { pending: Array<{ id: string; prefix: string; reason: string; catalog: { packages: string[] } }> }).pending;
    assert.deepEqual(waiting.map((p) => [p.prefix, p.reason, p.catalog.packages]), [["acme", "host", ["acme/linear"]]]);
    assert.equal((await fetch(`${indexUrl}/index/requests/${waiting[0]!.id}/approve`, { method: "POST" })).status, 401);
    const approved = await index.app.request(`/index/requests/${waiting[0]!.id}/approve`, json({}));
    assert.equal(approved.status, 200, await approved.clone().text());

    // Listed: read off the index's signed card, with the public key.
    assert.equal((await lines())[0]!.listed, true);
    const search = async (q: string) => ((await (await fetch(`${indexUrl}/index/packages?q=${q}`)).json()) as { packages: IndexHit[] }).packages.map((h) => h.package);
    for (let i = 0; i < 100 && !(await search("linear")).length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await search("linear"), ["acme/linear"]);

    // A release: the publisher pings the index it asked (no peer on file), and the store shows it.
    await publishPublic("acme/notion", "acme/notion/sync");
    for (let i = 0; i < 100 && !(await search("notion")).length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await search("notion"), ["acme/notion"]);

    // Withdrawn: the row goes, and the line says so.
    const gone = await publisher.app.request("/publisher/listings/stakwork", { method: "DELETE", headers: auth });
    assert.equal(gone.status, 200, await gone.clone().text());
    assert.ok(!((await (await index.app.request("/index", { headers: auth })).json()) as IndexInfo).publishers["acme"]);
    assert.equal((await lines())[0]!.listed, false);
    assert.equal((await fetch(`${publisherUrl}/publisher/listings`)).status, 401, "the publisher's routes are behind its key");
  });

  it("a server with no public package lists its public view: the ask mints the public key and an empty catalog, and a later package joins the same row (plans/public-view-listing.md)", async () => {
    assert.equal((await publisher.app.request("/publisher", json({ name: "acme" }, "PUT"))).status, 200);
    const seeded = await index.app.request("/index/seed", json({ key: "y".repeat(52), urls: ["http://127.0.0.1:1/packages/catalog?public=1"] }, "PUT"));
    const indexKey = ((await seeded.json()) as IndexInfo).key;
    assert.equal((await publisher.app.request("/packages/indexes/stakwork", json({ key: indexKey, urls: [`${indexUrl}/index/catalog`], label: "Stakwork" }, "PUT"))).status, 200);
    const publicKey = async () => ((await (await publisher.app.request("/publisher", { headers: auth })).json()) as { public?: string }).public;

    // Nothing public, and the view not asked for: refused here, and nothing is minted.
    const nothing = await publisher.app.request("/publisher/listings", json({ index: "stakwork", base: publisherUrl }));
    assert.equal(nothing.status, 409);
    assert.match(((await nothing.json()) as { error: string }).error, /^listing_nothing_public:/);
    assert.equal(await publicKey(), undefined);
    assert.equal((await fetch(`${publisherUrl}/packages/catalog?public=1`)).status, 404);

    // The view shows a workflow; the ask mints the public key and an empty public catalog sealed by it.
    assert.equal((await publisher.app.request("/public-view", json({ workflows: [{ name: "acme/linear/sync" }] }, "PUT"))).status, 200);
    const asked = await publisher.app.request("/publisher/listings", json({ index: "stakwork", base: publisherUrl, description: "Acme, live", live: true }));
    assert.equal(asked.status, 202, await asked.clone().text());
    const key = await publicKey();
    assert.ok(key, "the ask minted the public key");
    const empty = await fetch(`${publisherUrl}/packages/catalog?public=1`);
    assert.equal(empty.status, 200, "served to anyone");
    assert.deepEqual(readCard(Buffer.from(await empty.arrayBuffer()), { key: key! }).card.packages, {});

    // The operator sees a view-only request, and approves it.
    const waiting = ((await (await index.app.request("/index/requests", { headers: auth })).json()) as { pending: Array<{ id: string; reason: string; catalog: { packages: string[] }; view?: Record<string, number> }> }).pending;
    assert.deepEqual(waiting.map((p) => [p.reason, p.catalog.packages, p.view]), [["host", [], { apps: 0, workflows: 1, steps: 0, concepts: 0, runnable: 0 }]]);
    assert.equal((await index.app.request(`/index/requests/${waiting[0]!.id}/approve`, json({}))).status, 200);
    const card = (await (await index.app.request("/index", { headers: auth })).json()) as IndexInfo;
    assert.deepEqual([card.publishers["acme"]!.key, card.live["acme"]!.url], [key, publisherUrl], "a keyed row and the live row at the base");
    const line = (await (await publisher.app.request("/publisher/listings", { headers: auth })).json()) as { listings: Array<{ listed: boolean; live?: { url: string } }> };
    assert.deepEqual([line.listings[0]!.listed, line.listings[0]!.live?.url], [true, publisherUrl]);

    // The store shows the view; a change to it pings the index, which reads it again.
    const liveNames = async () => ((await (await fetch(`${indexUrl}/index/live`)).json()) as { items: Array<{ kind: string; name: string }> }).items.map((i) => `${i.kind} ${i.name}`).sort();
    for (let i = 0; i < 100 && !(await liveNames()).length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await liveNames(), ["workflow acme/linear/sync"]);
    assert.equal((await publisher.app.request("/public-view", json({ workflows: [{ name: "acme/linear/sync" }, { name: "acme/notion/sync" }] }, "PUT"))).status, 200);
    for (let i = 0; i < 100 && (await liveNames()).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await liveNames(), ["workflow acme/linear/sync", "workflow acme/notion/sync"]);

    // A package made public later: the same key, the same row — no second request. (Its
    // ping, inside the minute of the view's, is folded into one more read at the minute's
    // end; the operator's crawl reads it now.)
    await publishPublic("acme/linear", "acme/linear/sync");
    assert.equal(await publicKey(), key);
    assert.equal((await index.app.request("/index/crawl", json({}))).status, 200);
    const search = async (q: string) => ((await (await fetch(`${indexUrl}/index/packages?q=${q}`)).json()) as { packages: IndexHit[] }).packages.map((h) => h.package);
    assert.deepEqual(await search("linear"), ["acme/linear"]);
    assert.equal(((await (await index.app.request("/index/requests", { headers: auth })).json()) as { pending: unknown[] }).pending.length, 0);
  });
});
