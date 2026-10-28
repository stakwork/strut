/**
 * Publishing (plans/marketplace.md §13, §12.1) — src/packages/publisher.ts
 * through the routes: the publisher key, `POST /packages/publish`, the
 * catalog it seals, `GET /packages/catalog` and the channels. A subscriber
 * reads the catalog as served and checks it against the key, so every
 * catalog here is read back with `readCard`.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { readCard, type Catalog } from "./card.js";
import { PUBLISHER_FILE } from "./publisher.js";

const STEP = (type: string, out: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(out)}; } });\n`;
const FLOW = (description: string) => `name: acme/linear/sync\ndescription: ${description}\nsteps:\n  - { id: s, type: acme/linear/fetch }\n`;

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let root: string;
let ws: WorkspaceManager;
let strut: Strut;
let savedKey: string | undefined;
let savedApiKey: string | undefined;

const boot = () =>
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
  });
const req = (path: string, init?: RequestInit) => strut.app.request(path, init);
const publish = async (body: Record<string, unknown>) => {
  const res = await req("/packages/publish", json({ package: "acme/linear", workflows: ["acme/linear/sync"], ...body }));
  return { status: res.status, body: (await res.json()) as { digest: string; channel?: string; catalog: { key: string; seq: number; digest: string }; error?: string } };
};
const catalog = async (query = "") => {
  const res = await req(`/packages/catalog${query}`);
  return { res, text: await res.text() };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-publish-"));
  savedKey = process.env["STRUT_SECRET_KEY"];
  savedApiKey = process.env["STRUT_API_KEY"];
  process.env["STRUT_SECRET_KEY"] = "publisher-test-secret";
  delete process.env["STRUT_API_KEY"];
  ws = new WorkspaceManager(join(root, "workspace"));
  strut = await boot();
  await ws.publishStep("acme/linear/fetch", STEP("acme/linear/fetch", "one"));
  await ws.publishWorkflow("acme/linear/sync", "v1", FLOW("Sync the issues"));
});
afterEach(async () => {
  await strut.close?.();
  if (savedKey === undefined) delete process.env["STRUT_SECRET_KEY"];
  else process.env["STRUT_SECRET_KEY"] = savedKey;
  if (savedApiKey === undefined) delete process.env["STRUT_API_KEY"];
  else process.env["STRUT_API_KEY"] = savedApiKey;
  await rm(root, { recursive: true, force: true });
});

describe("publishing packages from this strut", () => {
  it("mints a key, publishes a release to a channel, and serves the catalog its key seals", async () => {
    assert.equal((await req("/publisher")).status, 404);
    assert.equal((await catalog()).res.status, 404);

    const first = await publish({ version: "1.0.0", license: "MIT", channel: "stable" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const publisher = (await (await req("/publisher")).json()) as { key: string; host: string };
    assert.equal(publisher.host, "self");
    assert.match(publisher.key, /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/);
    assert.equal(first.body.catalog.key, publisher.key);
    assert.equal((await req("/publisher", { method: "POST" })).status, 200, "minted once");

    const { res, text } = await catalog();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("cache-control"), "private, no-cache");
    const read = readCard(text, { key: publisher.key });
    assert.equal(read.digest, first.body.catalog.digest);
    assert.deepEqual(read.card.packages, {
      "acme/linear": { releases: [{ version: "1.0.0", digest: first.body.digest, license: "MIT" }] },
    });
    assert.deepEqual(read.card.channels, { stable: { "acme/linear": first.body.digest } });
    assert.equal((await req("/packages/catalog", { headers: { "if-none-match": res.headers.get("etag")! } })).status, 304);

    // Each release's bytes are served beside the catalog, by digest.
    assert.equal((await req(`/packages/acme/linear/archive?digest=${first.body.digest}`)).status, 200);

    // The key is in its own encrypted file, never in plain text.
    const file = await readFile(join(root, "workspace", PUBLISHER_FILE), "utf8");
    assert.ok(!file.includes(publisher.key), "the record is encrypted");
  });

  it("adds each release newest first, moves a channel to one and back, and never serves an older catalog as newer", async () => {
    const first = await publish({ version: "1.0.0", channel: "stable" });
    await ws.publishWorkflow("acme/linear/sync", "v2", FLOW("Sync the issues, faster"));
    const second = await publish({ version: "1.1.0", channel: "canary" });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.digest, first.body.digest);
    assert.ok(second.body.catalog.seq > first.body.catalog.seq);

    const key = second.body.catalog.key;
    const after1 = readCard((await catalog()).text, { key, last: { seq: first.body.catalog.seq, digest: first.body.catalog.digest } });
    assert.deepEqual(after1.card.packages["acme/linear"]!.releases.map((r) => r.version), ["1.1.0", "1.0.0"]);
    assert.deepEqual(after1.card.channels, { canary: { "acme/linear": second.body.digest }, stable: { "acme/linear": first.body.digest } });

    // An earlier catalog is still served by its digest, and a reader that has the newer one refuses it.
    const old = await catalog(`?digest=${first.body.catalog.digest}`);
    assert.equal(old.res.status, 200);
    assert.equal(old.res.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.throws(() => readCard(old.text, { key, last: { seq: after1.card.seq, digest: after1.digest } }), /catalog_rollback/);

    // Promote, then roll back: each a new catalog.
    const move = async (channel: string, digest: string | null) => {
      const res = await req(`/packages/channels/${channel}`, json({ package: "acme/linear", digest }, "PUT"));
      return { status: res.status, body: (await res.json()) as { catalog: { seq: number }; error?: string } };
    };
    const promoted = await move("stable", second.body.digest);
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(readCard((await catalog()).text, { key }).card.channels?.["stable"]?.["acme/linear"], second.body.digest);
    const rolledBack = await move("stable", first.body.digest);
    assert.ok(rolledBack.body.catalog.seq > promoted.body.catalog.seq);
    assert.equal(readCard((await catalog()).text, { key }).card.channels?.["stable"]?.["acme/linear"], first.body.digest);

    const removed = await move("canary", null);
    assert.equal(removed.status, 200);
    assert.deepEqual(readCard((await catalog()).text, { key }).card.channels, { stable: { "acme/linear": first.body.digest } });

    const unknown = await move("stable", `sha256:${"0".repeat(64)}`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error!, /^catalog_no_release: acme\/linear has no release at/);
    assert.equal((await move("Not A Channel", first.body.digest)).status, 400);

    // The same build published again adds no release.
    const again = await publish({ version: "1.1.0" });
    assert.equal(again.body.digest, second.body.digest);
    assert.equal(readCard((await catalog()).text, { key }).card.packages["acme/linear"]!.releases.length, 2);
  });

  it("makes a release public: a second key seals a public catalog of the public channels alone, open to anyone", async () => {
    // Everything else on this strut needs the key; the public reads do not.
    process.env["STRUT_API_KEY"] = "publisher-test-api-key";
    const auth = { authorization: "Bearer publisher-test-api-key" };
    const withKey = (path: string, init?: RequestInit) => req(path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...auth } });
    const publishAs = async (body: Record<string, unknown>) => {
      const res = await withKey("/packages/publish", json({ package: "acme/linear", workflows: ["acme/linear/sync"], ...body }));
      return { status: res.status, body: (await res.json()) as { digest: string; catalog: { key: string; seq: number; digest: string }; error?: string } };
    };
    const move = async (channel: string, digest: string | null, pub?: boolean) => {
      const res = await withKey(`/packages/channels/${channel}`, json({ package: "acme/linear", digest, ...(pub !== undefined ? { public: pub } : {}) }, "PUT"));
      return { status: res.status, body: (await res.json()) as { public?: boolean; catalog: { key: string; seq: number; digest: string }; error?: string } };
    };
    const publicCatalog = async (query = "") => {
      const res = await req(`/packages/catalog?public=1${query}`); // no credential
      return { res, text: await res.text() };
    };

    const v1 = await publishAs({ version: "1.0.0", channel: "stable" });
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    await ws.publishWorkflow("acme/linear/sync", "v2", FLOW("Sync the issues, faster"));
    const v2 = await publishAs({ version: "1.1.0", channel: "stable" });
    const fleetKey = v2.body.catalog.key;
    // Nothing is public yet: the public reads find nothing, and leak nothing.
    assert.equal((await publicCatalog()).res.status, 404);
    assert.equal((await req(`/packages/acme/linear/archive?digest=${v1.body.digest}&public=1`)).status, 404);
    assert.equal((await req(`/packages/acme/linear/archive?digest=${v1.body.digest}`)).status, 401, "the plain read still needs the key");
    assert.equal((await req("/packages/catalog")).status, 401);
    const before = (await (await withKey("/publisher")).json()) as { key: string; public?: string; publicChannels: string[] };
    assert.equal(before.public, undefined);
    assert.deepEqual(before.publicChannels, []);

    // Make public: the channel `public` is marked and moved to 1.0.0 — the public key is minted then.
    const made = await move("public", v1.body.digest, true);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.public, true);
    const info = (await (await withKey("/publisher")).json()) as { key: string; public?: string; publicChannels: string[] };
    assert.equal(info.key, fleetKey, "the fleet key is the one minted first");
    assert.match(info.public!, /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/);
    assert.notEqual(info.public, fleetKey);
    assert.deepEqual(info.publicChannels, ["public"]);

    // The public catalog: sealed by the public key, the public channel and what it holds — never 1.1.0, never `stable`, never the fleet key.
    const pub1 = await publicCatalog();
    assert.equal(pub1.res.status, 200);
    const pubCard1 = readCard(pub1.text, { key: info.public! });
    assert.deepEqual(pubCard1.card.packages, { "acme/linear": { releases: [{ version: "1.0.0", digest: v1.body.digest }] } });
    assert.deepEqual(pubCard1.card.channels, { public: { "acme/linear": v1.body.digest } });
    assert.equal(pubCard1.card.public, undefined);
    assert.ok(!pub1.text.includes(fleetKey), "the public card never names the fleet key");
    assert.throws(() => readCard(pub1.text, { key: fleetKey }), /catalog_key/);
    // The fleet catalog is the whole picture, and names the public key.
    const fleet = readCard((await (await withKey("/packages/catalog")).text()), { key: fleetKey });
    assert.equal(fleet.card.public, info.public);
    assert.deepEqual(fleet.card.channels, { public: { "acme/linear": v1.body.digest }, stable: { "acme/linear": v2.body.digest } });
    assert.equal(fleet.card.packages["acme/linear"]!.releases.length, 2);
    // A public digest is served with no credential; a private one is not, even marked public.
    assert.equal((await req(`/packages/acme/linear/archive?digest=${v1.body.digest}&public=1`)).status, 200);
    assert.equal((await req(`/packages/acme/linear/archive?digest=${v2.body.digest}&public=1`)).status, 404);
    assert.equal((await req(`/packages/catalog?public=1&digest=${pubCard1.digest}`)).status, 200, "an earlier public catalog by digest");
    assert.equal((await req(`/packages/catalog?public=1&digest=${fleet.digest}`)).status, 404, "a fleet catalog is not served as public");

    // A publish onto a private channel changes the public catalog not at all; onto the public channel, it carries the earlier release forward.
    await ws.publishWorkflow("acme/linear/sync", "v3", FLOW("Sync the issues, fastest"));
    const v3 = await publishAs({ version: "1.2.0", channel: "canary" });
    assert.equal(v3.status, 201);
    assert.equal(readCard((await publicCatalog()).text, { key: info.public! }).digest, pubCard1.digest, "unchanged");
    const v3public = await publishAs({ version: "1.2.0", channel: "public" });
    assert.equal(v3public.status, 201);
    const pubCard2 = readCard((await publicCatalog()).text, { key: info.public!, last: { seq: pubCard1.card.seq, digest: pubCard1.digest } });
    assert.deepEqual(pubCard2.card.packages["acme/linear"]!.releases.map((r) => r.version), ["1.2.0", "1.0.0"], "what was published stays published; 1.1.0 was never public");
    assert.deepEqual(pubCard2.card.channels, { public: { "acme/linear": v3.body.digest } });

    // A public channel never goes private; another channel may go public by name.
    const back = await move("public", v1.body.digest, false);
    assert.equal(back.status, 409);
    assert.match(back.body.error!, /^catalog_channel_public: public is public/);
    const beta = await move("beta", v2.body.digest, true);
    assert.equal(beta.status, 200, JSON.stringify(beta.body));
    assert.deepEqual(((await (await withKey("/publisher")).json()) as { publicChannels: string[] }).publicChannels, ["beta", "public"]);
    assert.deepEqual(readCard((await publicCatalog()).text, { key: info.public! }).card.channels, { beta: { "acme/linear": v2.body.digest }, public: { "acme/linear": v3.body.digest } });
    // Taking the package out of the public channel leaves its releases public.
    const out = await move("public", null);
    assert.equal(out.status, 200);
    const pubCard3 = readCard((await publicCatalog()).text, { key: info.public! });
    assert.deepEqual(pubCard3.card.channels, { beta: { "acme/linear": v2.body.digest } });
    assert.equal(pubCard3.card.packages["acme/linear"]!.releases.length, 3);

    // The keys outlive the process, in the one encrypted record.
    await strut.close?.();
    strut = await boot();
    const again = (await (await withKey("/publisher")).json()) as { key: string; public?: string; publicChannels: string[] };
    assert.deepEqual(again, { ...again, key: fleetKey, public: info.public, publicChannels: ["beta", "public"] });
    assert.equal((await publicCatalog()).res.status, 200);
  });

  it("refuses a public release that requires a package no public channel holds", async () => {
    // acme/util, which acme/linear requires, is published privately.
    await ws.publishStep("acme/util/fetch", STEP("acme/util/fetch", "util"));
    await ws.publishWorkflow("acme/util/sync", "v1", "name: acme/util/sync\nsteps:\n  - { id: s, type: acme/util/fetch }\n");
    const util = await publish({ version: "1.0.0", package: "acme/util", workflows: ["acme/util/sync"], channel: "stable" });
    assert.equal(util.status, 201, JSON.stringify(util.body));
    await ws.publishWorkflow("acme/linear/sync", "v2", "name: acme/linear/sync\nsteps:\n  - { id: s, type: acme/linear/fetch }\n  - { id: u, type: subflow, config: { workflow: acme/util/sync } }\n");
    const requires = { packages: [{ package: "acme/util", digest: util.body.digest }] };
    const linear = await publish({ version: "2.0.0", channel: "stable", requires });
    assert.equal(linear.status, 201, JSON.stringify(linear.body));
    const move = async (pkg: string, digest: string) => {
      const res = await req("/packages/channels/public", json({ package: pkg, digest, public: true }, "PUT"));
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    const refused = await move("acme/linear", linear.body.digest);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error!, /^catalog_private_requirement: acme\/linear 2\.0\.0 requires acme\/util at sha256:/);
    // Nothing moved: the fleet catalog's `public` channel is empty, and no public catalog was written.
    const fleet = JSON.parse(await (await req("/packages/catalog")).text()) as Catalog;
    assert.equal(fleet.channels?.["public"], undefined);
    assert.equal((await req("/packages/catalog?public=1")).status, 404);
    // The required package first, then the one that requires it.
    assert.equal((await move("acme/util", util.body.digest)).status, 200);
    assert.equal((await move("acme/linear", linear.body.digest)).status, 200);
    const pub = JSON.parse(await (await req("/packages/catalog?public=1")).text()) as Catalog;
    assert.deepEqual(Object.keys(pub.packages).sort(), ["acme/linear", "acme/util"]);
    // A publish straight onto the public channel is held to the same rule.
    await ws.publishWorkflow("acme/util/sync", "v2", "name: acme/util/sync\ndescription: again\nsteps:\n  - { id: s, type: acme/util/fetch }\n");
    const util2 = await publish({ version: "1.1.0", package: "acme/util", workflows: ["acme/util/sync"], channel: "stable" });
    await ws.publishWorkflow("acme/linear/sync", "v3", "name: acme/linear/sync\ndescription: again\nsteps:\n  - { id: s, type: acme/linear/fetch }\n  - { id: u, type: subflow, config: { workflow: acme/util/sync } }\n");
    const linear2 = await publish({ version: "2.1.0", channel: "public", requires: { packages: [{ package: "acme/util", digest: util2.body.digest }] } });
    assert.equal(linear2.status, 409, JSON.stringify(linear2.body));
    assert.match(linear2.body.error!, /^catalog_private_requirement: acme\/linear 2\.1\.0 requires acme\/util/);
    assert.equal(util2.status, 201);
  });

  it("refuses to mint a key or publish while the secret store runs on the dev default key", async () => {
    delete process.env["STRUT_SECRET_KEY"];
    const mint = await req("/publisher", { method: "POST" });
    assert.equal(mint.status, 409);
    assert.match(((await mint.json()) as { error: string }).error, /^publisher_unsafe_key: STRUT_SECRET_KEY is not set/);
    const r = await publish({ version: "1.0.0" });
    assert.equal(r.status, 409);
    assert.equal((await req("/publisher", json({ name: "acme" }, "PUT"))).status, 409, "naming mints the key, so it is refused too");
    assert.equal((await req("/publisher")).status, 404);
    assert.equal((await catalog()).res.status, 404, "nothing published");
  });

  it("takes a publisher name once, keeps it with the key, and refuses a package under another prefix", async () => {
    const bad = await req("/publisher", json({ name: "Acme Inc" }, "PUT"));
    assert.equal(bad.status, 400);
    const set = await req("/publisher", json({ name: "acme" }, "PUT"));
    const info = (await set.json()) as { key: string; name?: string; error?: string };
    assert.equal(set.status, 200, info.error);
    assert.equal(info.name, "acme");
    assert.ok(info.key, "the key is minted with the name");
    // The name lives in the encrypted record, so it outlives the process.
    await strut.close?.();
    strut = await boot();
    const again = (await (await req("/publisher")).json()) as { key: string; name?: string };
    assert.equal(again.key, info.key);
    assert.equal(again.name, "acme");
    const ok = await publish({ version: "1.0.0", channel: "stable" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const other = await publish({ version: "1.0.0", package: "other/linear" });
    assert.equal(other.status, 400);
    assert.match(other.body.error!, /^package_build_refused: other\/linear is not under this strut's publisher acme/);
    const { text } = await catalog();
    assert.equal(Object.keys((JSON.parse(text) as Catalog).packages).join(), "acme/linear", "nothing was added for the refused one");
  });

  it("refuses a publish whose build is refused, and leaves the catalog as it was", async () => {
    const first = await publish({ version: "1.0.0" });
    const bad = await publish({ version: "1.0.1", workflows: ["acme/linear/nowhere"] });
    assert.equal(bad.status, 400);
    const { text } = await catalog();
    assert.equal(readCard(text, { key: first.body.catalog.key }).digest, first.body.catalog.digest);
    assert.equal(((JSON.parse(text) as Catalog).packages["acme/linear"]!.releases).length, 1);
  });
});
