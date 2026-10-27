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
  process.env["STRUT_SECRET_KEY"] = "publisher-test-secret";
  ws = new WorkspaceManager(join(root, "workspace"));
  strut = await boot();
  await ws.publishStep("acme/linear/fetch", STEP("acme/linear/fetch", "one"));
  await ws.publishWorkflow("acme/linear/sync", "v1", FLOW("Sync the issues"));
});
afterEach(async () => {
  await strut.close?.();
  if (savedKey === undefined) delete process.env["STRUT_SECRET_KEY"];
  else process.env["STRUT_SECRET_KEY"] = savedKey;
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

  it("refuses to mint a key or publish while the secret store runs on the dev default key", async () => {
    delete process.env["STRUT_SECRET_KEY"];
    const mint = await req("/publisher", { method: "POST" });
    assert.equal(mint.status, 409);
    assert.match(((await mint.json()) as { error: string }).error, /^publisher_unsafe_key: STRUT_SECRET_KEY is not set/);
    const r = await publish({ version: "1.0.0" });
    assert.equal(r.status, 409);
    assert.equal((await req("/publisher")).status, 404);
    assert.equal((await catalog()).res.status, 404, "nothing published");
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
