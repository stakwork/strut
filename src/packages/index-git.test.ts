/**
 * Packages an index lists FROM GIT (`IndexRow.repos`, ./index.ts): the row
 * names a package and the `git+` branch it is kept on; the index reads the
 * repository as anyone would and derives its store page; a box installs the
 * name from that repository; the box's ping is counted only from the row's
 * repository (./index-installs.ts). And the requests desk: a publisher that
 * keeps its packages in git lists them by naming them.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStrut, type Strut } from "../createStrut.js";
import { MemorySecretStore } from "../secret-store.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { PackageCache } from "./cache.js";
import { canonicalJson, keyFromSeed, sealCard, type UnsignedCatalog } from "./card.js";
import { createPackageIndex, type IndexHit, type IndexInfo, type IndexPackage, type PackageIndex } from "./index.js";
import { createRequestsDesk, type ListingAnswer } from "./index-requests.js";
import { catalogUrlOf, sealListing, type UnsignedListing } from "./listing.js";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const FLOW = (name: string) => `name: ${name}\ndescription: Land it\nsteps:\n  - id: say\n    type: log\n    config: { message: "down" }\n`;
const BOX = "ab".repeat(16);

let root: string;
/** A repository holding `pkg` at its root on `main`. */
async function repo(pkg: string, version = "1.0.0"): Promise<{ dir: string; url: string; commit: () => string }> {
  const dir = join(root, `repo-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(join(dir, "workflows"), { recursive: true });
  git(dir, "-c", "init.defaultBranch=main", "init", "--quiet");
  await writeFile(join(dir, "strut.yaml"), `package: ${pkg}\nversion: ${version}\ndescription: Moon lander\n`);
  await writeFile(join(dir, "README.md"), "# Moon lander\n");
  await writeFile(join(dir, "workflows", "land.yaml"), FLOW(`${pkg}/land`));
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", version);
  return { dir, url: pathToFileURL(dir).href, commit: () => git(dir, "rev-parse", "HEAD") };
}

describe("packages an index lists from git", () => {
  let index: PackageIndex;
  const key = keyFromSeed(Buffer.alloc(32, 7)).key;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-index-git-"));
    index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), dataDir: root });
  });
  afterEach(async () => {
    index.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reads each listed branch into a page, lists only what holds its name, and counts installs from the row's repository alone", async () => {
    const lander = await repo("acme/lander");
    const ref = `git+${lander.url}@main`;
    // `urls` may be empty: every package of this publisher is in git.
    const info = await index.setRow("acme", { key, urls: [], repos: { "acme/lander": ref, "acme/other": ref } });
    assert.deepEqual(info.publishers["acme"]!.repos, { "acme/lander": ref, "acme/other": ref }, "sealed onto the card");
    assert.deepEqual(info.crawled[0]!.repos, { listed: 2, read: 1 }, "acme/other's branch holds acme/lander");

    const hits = await index.search("");
    assert.deepEqual(hits.map((h) => h.package), ["acme/lander"]);
    const hit = hits[0] as IndexHit;
    assert.equal(hit.source, ref);
    assert.equal(hit.commit, lander.commit());
    assert.equal(hit.version, "1.0.0");
    assert.equal(hit.description, "Moon lander");
    assert.equal(hit.detail?.workflows, 1);
    assert.deepEqual(hit.installs, { total: 0, recent: 0 });

    const page = (await index.package("acme/lander")) as IndexPackage;
    assert.deepEqual(page.releases, [{ version: "1.0.0", digest: hit.digest }]);
    assert.equal(page.source, ref);
    assert.equal(page.detail?.readme, "# Moon lander\n");
    assert.equal(page.installs?.total, 0);
    assert.equal(await index.package("acme/other"), undefined, "a branch holding another package has no page");

    // A new commit on the branch: the next crawl reads it.
    await writeFile(join(lander.dir, "strut.yaml"), "package: acme/lander\nversion: 1.1.0\ndescription: Moon lander, again\n");
    git(lander.dir, "commit", "--quiet", "-am", "1.1.0");
    await index.crawl({ prefix: "acme" });
    const next = (await index.package("acme/lander"))!;
    assert.equal(next.releases[0]!.version, "1.1.0");
    assert.equal(next.commit, lander.commit());
    assert.notEqual(next.releases[0]!.digest, hit.digest);

    // Installs: counted from the row's repository, whatever the branch; once per box and release.
    const ping = { package: "acme/lander", box: BOX, digest: next.releases[0]!.digest, source: `git+${lander.url}@feature`, commit: lander.commit() };
    assert.deepEqual(await index.countInstall(ping), { counted: true });
    assert.deepEqual(await index.countInstall(ping), { counted: false }, "the same box and release again");
    assert.equal((await index.countInstall({ ...ping, source: `git+${pathToFileURL(join(root, "fork")).href}@main` })).counted, false, "a fork claiming the name");
    assert.equal((await index.countInstall({ ...ping, source: `pk:${key}/acme/lander` })).counted, false, "listed from git, not a catalog");
    assert.match((await index.countInstall({ ...ping, package: "nobody/x" })).reason!, /no publisher nobody/);
    await assert.rejects(index.countInstall({ ...ping, box: "me" }), /^Error: index_install_invalid: box/);
    const stats = index.installs("acme/lander");
    assert.equal(stats.total, 1);
    assert.equal(stats.recent.installs, 1);
    assert.equal(stats.recent.daily.at(-1), 1);
    assert.deepEqual((await index.search("lander"))[0]!.installs, { total: 1, recent: 1 });
    assert.equal((await index.package("acme/lander"))!.installs!.total, 1);

    // A name the row drops loses its page; a dropped row, every page.
    await index.setRow("acme", { key, urls: [], repos: { "acme/lander": ref } });
    assert.deepEqual(await readdir(join(root, "index", "crawl", "repos", "acme")), ["lander.json"]);
    await index.removeRow("acme");
    assert.deepEqual(await index.search(""), []);
    assert.equal(index.installs("acme/lander").total, 1, "the counts outlive the row: nothing is dropped");
  });
});

describe("the requests desk with packages kept in git", () => {
  const DIGEST = `sha256:${"ab".repeat(32)}`;
  let clock: number;
  let seq: number;
  let served: Map<string, string>;
  let index: PackageIndex;
  let indexKey: string;
  const stubFetch = (async (input: RequestInfo | URL) => {
    const body = served.get(String(input));
    return body ? new Response(body, { headers: { "content-type": "application/json" } }) : new Response("not here", { status: 404 });
  }) as typeof fetch;
  type Signer = ReturnType<typeof keyFromSeed>;
  const serve = (signer: Signer, base: string, packages: string[] = []) => {
    const card = sealCard({ v: 1, key: signer.key, seq: Math.floor(clock * 1000) + seq++, packages: Object.fromEntries(packages.map((p) => [p, { releases: [{ version: "1.0.0", digest: DIGEST }] }])) } as UnsignedCatalog, signer.privateKey);
    served.set(catalogUrlOf(base), canonicalJson(card));
  };
  const desk = (allowHttp: boolean) =>
    createRequestsDesk({ index: { ...index, crawl: async () => [] }, dir: join(root, "index", "requests"), cache: new PackageCache(join(root, "cache")), autoHosts: ["*"], fetch: stubFetch, ...(allowHttp ? { allowHttp: true } : {}), now: () => clock });
  const ask = (signer: Signer, fields: Partial<UnsignedListing> & { prefix: string }) =>
    canonicalJson(sealListing({ v: 1, index: indexKey, key: signer.key, seq: Math.floor(clock * 1000) + seq++, ...fields }, signer.privateKey));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-desk-git-"));
    clock = Date.now();
    seq = 0;
    served = new Map();
    index = createPackageIndex({ secrets: new MemorySecretStore(), dir: join(root, "index"), cache: new PackageCache(join(root, "cache")), dataDir: root, fetch: stubFetch, now: () => clock });
    indexKey = (await index.setRow("seed", { key: keyFromSeed(Buffer.alloc(32, 1)).key, urls: ["https://elsewhere.example/packages/catalog?public=1"] }, { crawl: false })).key;
  });
  afterEach(async () => {
    index.close();
    await rm(root, { recursive: true, force: true });
  });

  it("lists a publisher with nothing in its catalog by the packages it names in git, each read and holding its name", async () => {
    const d = desk(true);
    try {
      const pub = keyFromSeed(Buffer.alloc(32, 2));
      const base = "https://pub.example";
      serve(pub, base);
      const lander = await repo("pub/lander");
      const ref = `git+${lander.url}@main`;
      // A branch holding another package refuses the request, naming it.
      const wrong = await repo("pub/rover");
      await assert.rejects(d.submit(ask(pub, { prefix: "pub", base, repos: { "pub/lander": `git+${wrong.url}@main` } })), /^Error: listing_repo_invalid: .*holds the package pub\/rover/);
      const listed = (await d.submit(ask(pub, { prefix: "pub", base, repos: { "pub/lander": ref } }))) as ListingAnswer & { status: "listed" };
      assert.equal(listed.status, "listed");
      assert.deepEqual(listed.row.repos, { "pub/lander": ref });
      // A later request that names no repos keeps the row's.
      const edited = (await d.submit(ask(pub, { prefix: "pub", base, description: "Rovers and landers" }))) as ListingAnswer & { status: "listed" };
      assert.deepEqual(edited.row.repos, { "pub/lander": ref });
      assert.equal(edited.row.description, "Rovers and landers");
      // `{}` drops them.
      serve(pub, base, ["pub/kept"]);
      const dropped = (await d.submit(ask(pub, { prefix: "pub", base, repos: {} }))) as ListingAnswer & { status: "listed" };
      assert.equal(dropped.row.repos, undefined);
    } finally {
      d.close();
    }
  });

  it("reads only https repositories at public names for a stranger", async () => {
    const d = desk(false);
    try {
      const pub = keyFromSeed(Buffer.alloc(32, 3));
      const lander = await repo("pub/lander");
      await assert.rejects(d.submit(ask(pub, { prefix: "pub", base: "https://pub.example", repos: { "pub/lander": `git+${lander.url}@main` } })), /^Error: listing_invalid: repos: pub\/lander: .* is not an https repository at a public name/);
      await assert.rejects(d.submit(ask(pub, { prefix: "pub", base: "https://pub.example", repos: { "other/lander": "git+https://github.com/pub/lander@main" } })), /^Error: listing_invalid: repos: "other\/lander" is not a package name under pub\//);
    } finally {
      d.close();
    }
  });
});

describe("a box installs a git-listed name and the index counts it", () => {
  const KEY = "git-index-api-key";
  const auth = { authorization: `Bearer ${KEY}` };
  const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const boot = (ws: WorkspaceManager, extra: Record<string, unknown> = {}) =>
    createStrut({ workspace: ws, store: new MemoryRunStore(), serveUi: false, scheduler: false, enableChat: false, systemWorkflows: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false, job: false, orchestrator: false, builder: false, views: false, concepts: false, stt: false, subscriptionPoll: false, ...extra });
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_INDEX", "STRUT_INDEX_PINGS"]) saved[k] = process.env[k];
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_SECRET_KEY"] = "git-index-secret";
    delete process.env["STRUT_INDEX"];
    delete process.env["STRUT_INDEX_PINGS"];
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  let indexStrut: Strut;
  let box: Strut;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-box-git-"));
  });
  afterEach(async () => {
    await box?.close();
    await indexStrut?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("installs from the repository the card names, pings the index, and refuses a branch holding another package", async () => {
    indexStrut = await boot(new WorkspaceManager(join(root, "index-ws")), { index: { urls: ["https://index.example/index/catalog"] } });
    const indexUrl = `http://127.0.0.1:${await indexStrut.listen(0, "127.0.0.1")}`;
    const lander = await repo("acme/lander");
    const ref = `git+${lander.url}@main`;
    const row = await indexStrut.app.request("/index/acme", json({ key: keyFromSeed(Buffer.alloc(32, 9)).key, urls: [], repos: { "acme/lander": ref, "acme/other": ref } }, "PUT"));
    assert.equal(row.status, 200, await row.clone().text());
    const indexKey = ((await row.json()) as IndexInfo).key;

    box = await boot(new WorkspaceManager(join(root, "box-ws")), { packageIndexes: [{ id: "test", key: indexKey, urls: [`${indexUrl}/index/catalog`] }] });
    const res = await box.app.request("/packages/install", json({ ref: "acme/lander", index: "test" }));
    const out = (await res.json()) as { package?: string; packages?: Array<{ source: { ref: string }; commit?: string }>; error?: string };
    assert.equal(res.status, 201, JSON.stringify(out));
    assert.equal(out.package, "acme/lander");
    assert.equal(out.packages![0]!.source.ref, ref, "installed from the repository, not a catalog");
    assert.equal(out.packages![0]!.commit, lander.commit());

    // The box's ping is detached: the index counts it within a moment.
    const page = async () => (await (await fetch(`${indexUrl}/index/packages/acme/lander`)).json()) as IndexPackage;
    let installs = 0;
    for (let i = 0; i < 100 && !installs; i++) {
      installs = (await page()).installs?.total ?? 0;
      if (!installs) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(installs, 1, "the box told the index");

    // The route is open, and checks what it is sent.
    assert.equal((await fetch(`${indexUrl}/index/installs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package: "acme/lander" }) })).status, 400);
    const other = await fetch(`${indexUrl}/index/installs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package: "acme/lander", box: "cd".repeat(16), digest: (await page()).releases[0]!.digest, source: ref }) });
    assert.equal(other.status, 202);
    assert.deepEqual(await other.json(), { counted: true });
    const hits = ((await (await fetch(`${indexUrl}/index/packages`)).json()) as { packages: IndexHit[] }).packages;
    assert.deepEqual(hits.find((h) => h.package === "acme/lander")!.installs, { total: 2, recent: 2 });

    // The card names acme/other at a branch that holds acme/lander: the install refuses it.
    const wrong = await box.app.request("/packages/install", json({ ref: "acme/other", index: "test" }));
    assert.notEqual(wrong.status, 200);
    assert.match(((await wrong.json()) as { error: string }).error, /^package_name_mismatch: the index lists acme\/other at .* which holds the package acme\/lander/);
  });

  it("counts a bundle's part a subscription installed, by the branch the part follows", async () => {
    indexStrut = await boot(new WorkspaceManager(join(root, "index-ws")), { index: { urls: ["https://index.example/index/catalog"] } });
    const indexUrl = `http://127.0.0.1:${await indexStrut.listen(0, "127.0.0.1")}`;
    const lander = await repo("acme/lander");
    const landerRef = `git+${lander.url}@main`;
    // Software's shape: a bundle on a branch of its own, listing the part by its branch.
    const bundle = join(root, "bundle");
    await mkdir(bundle, { recursive: true });
    git(bundle, "-c", "init.defaultBranch=main", "init", "--quiet");
    await writeFile(join(bundle, "strut.yaml"), `package: acme/software\nversion: 0.1.0\nbundle:\n  - ${landerRef}\n`);
    git(bundle, "add", ".");
    git(bundle, "commit", "--quiet", "-m", "0.1.0");
    const bundleRef = `git+${pathToFileURL(bundle).href}@main`;
    const row = await indexStrut.app.request("/index/acme", json({ key: keyFromSeed(Buffer.alloc(32, 9)).key, urls: [], repos: { "acme/lander": landerRef, "acme/software": bundleRef } }, "PUT"));
    assert.equal(row.status, 200, await row.clone().text());
    const indexKey = ((await row.json()) as IndexInfo).key;

    box = await boot(new WorkspaceManager(join(root, "box-ws")), { packageIndexes: [{ id: "test", key: indexKey, urls: [`${indexUrl}/index/catalog`] }] });
    const sub = await box.app.request("/packages/subscriptions/software", json({ ref: bundleRef }, "PUT"));
    assert.equal(sub.status, 200, await sub.clone().text());
    const synced = await box.app.request("/packages/subscriptions/software/sync", json({}));
    assert.equal(synced.status, 200, await synced.clone().text());
    assert.ok(((await (await box.app.request("/packages", { headers: auth })).json()) as { packages: Array<{ package: string }> }).packages.some((p) => p.package === "acme/lander"), "the part is in");

    // Installed as `subscription:software/<part>`; pinged as the part's branch, which the row lists.
    const installs = async () => ((await (await fetch(`${indexUrl}/index/packages/acme/lander`)).json()) as IndexPackage).installs?.total ?? 0;
    let n = 0;
    for (let i = 0; i < 100 && !n; i++) {
      n = await installs();
      if (!n) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(n, 1);
  });
});

