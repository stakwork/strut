/**
 * The `pk:` source (plans/marketplace.md §5, §13, HTTP-first): a strut
 * installs a package by the PUBLISHER's key from its public catalog at a
 * URL — two struts over real HTTP, the publisher behind an API key, so the
 * public reads are what opens it. The key is the trust: a catalog not its
 * is refused, a release the catalog does not list is refused, an older
 * catalog served after a newer one is refused, and what the package
 * requires comes from the same catalog.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { parsePkRef, releaseUrls } from "./pk.js";
import type { InstalledPackage } from "./installed.js";

const KEY = "pk-api-key";
const auth = { authorization: `Bearer ${KEY}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const STEP = (type: string, out: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(out)}; } });\n`;
const FLOW = (name: string, step: string, extra = "") => `name: ${name}\nsteps:\n  - { id: s, type: ${step} }\n${extra}`;
const boot = (ws: WorkspaceManager) =>
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
  });
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_SECRET_KEY"] = "pk-secret";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the pk: ref", () => {
  it("parses a key, a package and an optional digest, and names what is wrong", () => {
    const key = "47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy";
    assert.deepEqual(parsePkRef(`pk:${key}/acme/linear`), { key, package: "acme/linear" });
    assert.deepEqual(parsePkRef(`pk:${key}/acme/linear@sha256:${"a".repeat(64)}`), { key, package: "acme/linear", digest: `sha256:${"a".repeat(64)}` });
    assert.match(parsePkRef("pk:not-a-key/acme/linear") as string, /not a publisher key/);
    assert.match(parsePkRef(`pk:${key}/Acme`) as string, /not a package name/);
    assert.match(parsePkRef(`pk:${key}/acme/linear@v1`) as string, /not a digest/);
    assert.match(parsePkRef("file:/x") as string, /is not pk:/);
  });

  it("derives a release's archive URLs: the route beside a strut's catalog with its query, then the release's own", () => {
    const d = `sha256:${"b".repeat(64)}`;
    assert.deepEqual(releaseUrls("https://x.example/lab/packages/catalog?public=1", "acme/linear", { version: "1.0.0", digest: d }), [
      `https://x.example/lab/packages/acme/linear/archive?digest=${encodeURIComponent(d)}&public=1`,
    ]);
    assert.deepEqual(releaseUrls("https://github.com/o/r/releases/latest/download/catalog.json", "acme/linear", { version: "1.0.0", digest: d, urls: ["https://h/a.tar.gz"] }), ["https://h/a.tar.gz"]);
  });
});

describe("installing by a publisher's key", () => {
  let root: string;
  let publisher: Strut;
  let installer: Strut;
  let publisherWs: WorkspaceManager;
  let installerWs: WorkspaceManager;
  let catalogUrl: string;
  let publisherUrl: string;

  const publish = async (pkg: string, version: string, workflows: string[], body: Record<string, unknown> = {}) => {
    const res = await publisher.app.request("/packages/publish", json({ package: pkg, version, workflows, ...body }));
    const out = (await res.json()) as { digest: string; catalog: { key: string; seq: number }; error?: string };
    assert.equal(res.status, 201, JSON.stringify(out));
    return out;
  };
  const makePublic = async (pkg: string, digest: string) => {
    const res = await publisher.app.request("/packages/channels/public", json({ package: pkg, digest, public: true }, "PUT"));
    assert.equal(res.status, 200, await res.clone().text());
  };
  const publicKey = async () => ((await (await publisher.app.request("/publisher", { headers: auth })).json()) as { public?: string }).public!;
  const install = async (body: Record<string, unknown>) => {
    const res = await installer.app.request("/packages/install", json(body));
    return { status: res.status, body: (await res.json()) as { package?: string; digest?: string; packages?: Array<{ package: string; status: string }>; error?: string } };
  };
  const installed = async (): Promise<InstalledPackage[]> => ((await (await installer.app.request("/packages", { headers: auth })).json()) as { packages: InstalledPackage[] }).packages;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-pk-"));
    publisherWs = new WorkspaceManager(join(root, "publisher"));
    installerWs = new WorkspaceManager(join(root, "installer"));
    publisher = await boot(publisherWs);
    installer = await boot(installerWs);
    publisherUrl = `http://127.0.0.1:${await publisher.listen(0, "127.0.0.1")}`;
    catalogUrl = `${publisherUrl}/packages/catalog?public=1`;
    await publisherWs.publishStep("acme/linear/fetch", STEP("acme/linear/fetch", "issues"));
    await publisherWs.publishWorkflow("acme/linear/sync", "v1", FLOW("acme/linear/sync", "acme/linear/fetch"));
  });
  afterEach(async () => {
    await installer.close();
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  });

  it("installs a public release by key and URL with no credential for the publisher, pinning the key and the URL", async () => {
    const v1 = await publish("acme/linear", "1.0.0", ["acme/linear/sync"]);
    await publisherWs.publishStep("acme/linear/fetch", STEP("acme/linear/fetch", "issues, faster"));
    const v2 = await publish("acme/linear", "1.1.0", ["acme/linear/sync"], { channel: "stable" });
    // Nothing is public: the key's catalog is not reachable without a credential.
    const key = v2.catalog.key;
    const before = await install({ ref: `pk:${key}/acme/linear`, url: catalogUrl });
    assert.equal(before.status, 400, JSON.stringify(before.body));
    assert.match(before.body.error!, /^package_fetch_failed: .* answered 404 for the catalog/);

    await makePublic("acme/linear", v1.digest);
    const pub = await publicKey();
    // The fleet key is not the public catalog's key.
    const wrongKey = await install({ ref: `pk:${key}/acme/linear`, url: catalogUrl });
    assert.equal(wrongKey.status, 409);
    assert.match(wrongKey.body.error!, /^catalog_key: /);
    // A URL is needed.
    const noUrl = await install({ ref: `pk:${pub}/acme/linear` });
    assert.equal(noUrl.status, 400);
    assert.match(noUrl.body.error!, /a pk: ref needs url/);
    // 1.1.0 is not public: a pin to it is refused; the floating ref takes 1.0.0.
    const notPublic = await install({ ref: `pk:${pub}/acme/linear@${v2.digest}`, url: catalogUrl });
    assert.equal(notPublic.status, 404, JSON.stringify(notPublic.body));
    assert.match(notPublic.body.error!, /^package_not_published: .* lists no release of acme\/linear at /);
    const ok = await install({ ref: `pk:${pub}/acme/linear`, url: catalogUrl });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.digest, v1.digest);
    assert.equal((await installer.run("acme/linear/sync", {})).output, "issues");
    const [p] = await installed();
    assert.equal(p!.package, "acme/linear");
    assert.equal(p!.digest, v1.digest);
    assert.deepEqual(p!.source, { ref: `pk:${pub}/acme/linear`, url: catalogUrl });
    const meta = await installerWs.getWorkflowMetadata("acme/linear/sync");
    const up = meta!.versions[meta!.active]!.upstream!;
    assert.equal(up.key, pub, "the key is pinned on the version");
    assert.equal(up.source.url, catalogUrl);
    // The last catalog accepted from the key is kept beside the cache.
    const state = JSON.parse(await readFile(join(root, "installer", "packages", "index", `${pub}.json`), "utf8")) as { seq: number };
    assert.equal(typeof state.seq, "number");
    // Made public too, 1.1.0 is what the floating ref takes now — and the same digest again is present.
    await makePublic("acme/linear", v2.digest);
    const again = await install({ ref: `pk:${pub}/acme/linear@${v1.digest}`, url: catalogUrl });
    assert.equal(again.status, 201);
    assert.equal(again.body.packages![0]!.status, "present");
  });

  it("fetches what the package requires from the same catalog, and refuses an older catalog served after a newer", async () => {
    await publisherWs.publishStep("acme/util/fetch", STEP("acme/util/fetch", "util"));
    await publisherWs.publishWorkflow("acme/util/sync", "v1", FLOW("acme/util/sync", "acme/util/fetch"));
    const util = await publish("acme/util", "1.0.0", ["acme/util/sync"]);
    await publisherWs.publishWorkflow("acme/linear/sync", "v2", FLOW("acme/linear/sync", "acme/linear/fetch", "  - { id: u, type: subflow, config: { workflow: acme/util/sync } }\n"));
    const linear = await publish("acme/linear", "2.0.0", ["acme/linear/sync"], { requires: { packages: [{ package: "acme/util", digest: util.digest }] } });
    await makePublic("acme/util", util.digest);
    await makePublic("acme/linear", linear.digest);
    const pub = await publicKey();
    const oldCatalog = Buffer.from(await (await fetch(catalogUrl)).arrayBuffer());

    const ok = await install({ ref: `pk:${pub}/acme/linear`, url: catalogUrl });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.packages!.map((p) => p.package), ["acme/util", "acme/linear"], "the requirement first, from the catalog");
    assert.equal((await installer.run("acme/linear/sync", {})).output, "util");

    // A newer public catalog moves the key's seq; a host serving the old one is refused.
    await publisherWs.publishStep("acme/util/fetch", STEP("acme/util/fetch", "util 2"));
    const util2 = await publish("acme/util", "1.1.0", ["acme/util/sync"]);
    await makePublic("acme/util", util2.digest);
    const stale: Server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(oldCatalog);
    });
    await new Promise<void>((r) => stale.listen(0, "127.0.0.1", r));
    try {
      // An update through a person's door is not built; the newer release installs once the old one is gone.
      assert.equal((await installer.app.request("/packages/acme/linear", { method: "DELETE", headers: auth })).status, 200);
      assert.equal((await installer.app.request("/packages/acme/util", { method: "DELETE", headers: auth })).status, 200);
      const fresh = await install({ ref: `pk:${pub}/acme/util`, url: catalogUrl });
      assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
      assert.equal(fresh.body.digest, util2.digest);
      const staleUrl = `http://127.0.0.1:${(stale.address() as AddressInfo).port}/packages/catalog?public=1`;
      const rolled = await install({ ref: `pk:${pub}/acme/util`, url: staleUrl });
      assert.equal(rolled.status, 409, JSON.stringify(rolled.body));
      assert.match(rolled.body.error!, /^catalog_rollback: /);
    } finally {
      await new Promise<void>((r) => stale.close(() => r()));
    }
  });
});
