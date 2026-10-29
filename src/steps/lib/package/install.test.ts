/**
 * `package/install` (plans/marketplace.md §8, ruled 2026-10-29): an AGENT
 * asks, a PERSON accepts. Three struts over real HTTP — a publisher with a
 * public package, an index that lists it, and the strut that installs,
 * following the index — and the agent's gated tool call on the last: the
 * call is a proposal whose card carries the index's reading of the
 * package; nothing installs until the person accepts; the door behind the
 * step opens to nothing but that accepted record.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { createStrut, type Strut } from "../../../createStrut.js";
import type { RunEvent, StepContext } from "../../../core.js";
import { MemoryRunStore } from "../../../store.js";
import { WorkspaceManager } from "../../../workspace.js";
import { buildRegistryTools } from "../../core/agent.js";
import type { Proposal } from "../../../proposals.js";
import type { IndexInfo } from "../../../packages/index.js";

const KEY = "install-api-key";
const PEER_KEY = "install-peer-key";
const auth = { authorization: `Bearer ${KEY}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const STEP = (type: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, description: "Fetch issues", effect: "read", secrets: ["LINEAR_API_KEY"], input: z.object({}), output: z.any(), async run(cfg, ctx) { return ctx.services.secrets.get("LINEAR_API_KEY"); } });\n`;
const FLOW = (name: string, step: string) => `name: ${name}\ndescription: Sync them\ninput:\n  team: { type: string }\nsteps:\n  - { id: s, type: ${step} }\n  - { id: say, type: llm, config: { prompt: 'summarize {{ s }}' } }\n`;
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
  process.env["STRUT_SECRET_KEY"] = "install-secret";
  delete process.env["STRUT_INDEX"];
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Tool = { description: string; inputSchema: z.ZodTypeAny; execute: (input: unknown, o?: { strutToolPath?: string }) => Promise<unknown> };

describe("package/install — an agent asks, a person accepts", () => {
  let root: string;
  let publisher: Strut;
  let index: Strut;
  let strut: Strut;
  let catalogUrl: string;
  let publicKey: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-pkg-install-"));
    // The publisher: one public package, one private.
    const pubWs = new WorkspaceManager(join(root, "publisher"));
    await pubWs.publishStep("acme/linear/fetch", STEP("acme/linear/fetch"));
    await pubWs.publishWorkflow("acme/linear/sync", "v1", FLOW("acme/linear/sync", "acme/linear/fetch"));
    await pubWs.publishStep("acme/notion/fetch", STEP("acme/notion/fetch"));
    await pubWs.publishWorkflow("acme/notion/sync", "v1", FLOW("acme/notion/sync", "acme/notion/fetch"));
    index = await boot(new WorkspaceManager(join(root, "index")), { index: true });
    const indexUrl = `http://127.0.0.1:${await index.listen(0, "127.0.0.1")}`;
    publisher = await boot(pubWs, { peers: [{ id: "index", baseUrl: indexUrl, token: PEER_KEY }] });
    const publisherUrl = `http://127.0.0.1:${await publisher.listen(0, "127.0.0.1")}`;
    catalogUrl = `${publisherUrl}/packages/catalog?public=1`;
    const published = (await (await publisher.app.request("/packages/publish", json({ package: "acme/linear", version: "1.4.0", workflows: ["acme/linear/sync"], license: "MIT", description: "Linear issues" }))).json()) as { digest: string };
    await publisher.app.request("/packages/publish", json({ package: "acme/notion", version: "0.1.0", workflows: ["acme/notion/sync"] }));
    assert.equal((await publisher.app.request("/packages/channels/public", json({ package: "acme/linear", digest: published.digest, public: true }, "PUT"))).status, 200);
    publicKey = ((await (await publisher.app.request("/publisher", { headers: auth })).json()) as { public: string }).public;
    // The index lists the publisher and reads its archive into a page.
    const listed = (await (await index.app.request("/index/acme", json({ key: publicKey, urls: [catalogUrl] }, "PUT"))).json()) as IndexInfo;
    assert.equal(listed.crawled[0]!.derived, 1, JSON.stringify(listed.crawled));
    // The installing strut follows the index.
    strut = await boot(new WorkspaceManager(join(root, "strut")));
    const followed = await strut.app.request("/packages/indexes/idx", json({ key: listed.key, urls: [`${indexUrl}/index/catalog`] }, "PUT"));
    assert.equal(followed.status, 200, await followed.clone().text());
  });
  afterEach(async () => {
    await strut.close();
    await publisher.close();
    await index.close();
    await rm(root, { recursive: true, force: true });
  });

  /** The agent's tool ctx on the installing strut. */
  const ctx = (events: RunEvent[] = []): StepContext => ({
    runId: "r1",
    path: "orchestrator/turn",
    scope: {},
    input: undefined,
    emit: async (e) => void events.push(e),
    services: strut.services,
    registry: strut.getRegistry(),
    job: "j1",
    actor: "ann",
    principal: "ann",
  });
  const gated = (c: StepContext) =>
    buildRegistryTools(["package/install"], strut.getRegistry(), c, (d: unknown) => d, { approve: new Set(["package/install"]), session: "s1" })["package_install"] as Tool;
  const record = async (id: string): Promise<Proposal> => (await (strut.services as { proposals: { get(id: string): Promise<Proposal | null> } }).proposals.get(id))!;
  const decide = async (id: string, action: "accept" | "reject") => {
    const res = await strut.app.request(`/proposals/${id}/decide`, json({ action }));
    const body = (await res.json()) as Proposal & { error?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  };
  const door = () => (strut.services as { packages: { install(ref: string, o: { proposal: string }): Promise<unknown> } }).packages;

  it("refuses to run as anything but an accepted proposal", async () => {
    const def = strut.getRegistry()["package/install"]!;
    await assert.rejects(def.run({ package: "acme/linear" }, ctx()), /runs only as a proposal a person accepted/);
    // The door behind it opens to no forged or pending record.
    await assert.rejects(door().install("acme/linear", { proposal: "nope" }), /package_install_needs_person/);
    assert.deepEqual((await (await strut.app.request("/packages", { headers: auth })).json()) as unknown, { packages: [] }, "nothing installed");
  });

  it("an agent's call is a proposal whose card reads the package off the index; the person's accept installs it, and the door closes behind it", async () => {
    const events: RunEvent[] = [];
    const out = (await gated(ctx(events)).execute({ package: "acme/linear", rationale: "You asked for Linear issues on the board." }, { strutToolPath: "orchestrator/turn/001-package_install" })) as Record<string, unknown>;
    assert.equal(out["status"], "pending");
    assert.equal(out["title"], "Install the package acme/linear");
    const id = out["proposal"] as string;
    const rec = await record(id);
    assert.equal(rec.step, "package/install");
    assert.deepEqual(rec.input, { package: "acme/linear" });
    assert.equal(rec.rationale, "You asked for Linear issues on the board.");
    // §8's ask, read off the index's page: who, what it brings, what it can, what it needs.
    assert.match(rec.summary!, /^acme\/linear 1\.4\.0 \(MIT\) from acme — key [a-z0-9]{8}…[a-z0-9]{6}, listed by the index idx; digest [0-9a-f]{12}\./);
    assert.match(rec.summary!, /It brings 1 workflow, 1 step — TypeScript that runs inside this strut\./);
    assert.match(rec.summary!, /It can spend \(a model is called\); run code/);
    assert.match(rec.summary!, /It needs the secret LINEAR_API_KEY\./);
    assert.match(rec.summary!, /re-verifies every file against the publisher's own catalog/);
    assert.deepEqual((await (await strut.app.request("/packages", { headers: auth })).json()) as unknown, { packages: [] }, "nothing installed before the yes");
    await assert.rejects(door().install("acme/linear", { proposal: id }), /package_install_needs_person: .*is pending/, "pending is not accepted");

    // The person says yes: the apply runs the install as the decider, through the door.
    const applied = await decide(id, "accept");
    assert.equal(applied.status, "applied", JSON.stringify(applied.result));
    const result = applied.result!.output as { package: string; digest: string; missing: { secrets: string[] } };
    assert.equal(result.package, "acme/linear");
    assert.deepEqual(result.missing.secrets, ["LINEAR_API_KEY"]);
    const installed = (await (await strut.app.request("/packages", { headers: auth })).json()) as { packages: Array<{ package: string; version?: string; door?: string }> };
    assert.deepEqual(installed.packages.map((p) => [p.package, p.version, p.door]), [["acme/linear", "1.4.0", "install"]]);
    assert.equal((await strut.app.request("/workflows/acme%2Flinear%2Fsync", { headers: auth })).status, 200);
    // The record is spent: the door opens to it no more.
    await assert.rejects(door().install("acme/linear", { proposal: id }), /package_install_needs_person: .*is applied/);
    // The session is told on its next turn, as for any proposal.
    assert.equal((await record(id)).reportedAt, undefined);
  });

  it("a package no followed index lists, or a ref that is not a name or a pk: ref, is proposed honestly and fails at the apply, never silently", async () => {
    const notListed = (await gated(ctx()).execute({ package: "acme/notion" }, { strutToolPath: "orchestrator/turn/002-package_install" })) as Record<string, unknown>;
    const rec = await record(notListed["proposal"] as string);
    assert.match(rec.summary!, /acme\/notion is not listed by an index this strut follows\./);
    const failed = await decide(rec.id, "accept");
    assert.equal(failed.status, "failed");
    assert.match(failed.result!.error!, /package_not_listed|package_not_published/);

    const file = (await gated(ctx()).execute({ package: "file:/somewhere/on/the/server" }, { strutToolPath: "orchestrator/turn/003-package_install" })) as Record<string, unknown>;
    const refused = await decide(file["proposal"] as string, "accept");
    assert.equal(refused.status, "failed");
    assert.match(refused.result!.error!, /package_source_invalid: .*neither a name .*nor a pk:/);

    // A rejection runs nothing.
    const again = (await gated(ctx()).execute({ package: "acme/linear" }, { strutToolPath: "orchestrator/turn/004-package_install" })) as Record<string, unknown>;
    assert.equal((await decide(again["proposal"] as string, "reject")).status, "rejected");
    assert.deepEqual((await (await strut.app.request("/packages", { headers: auth })).json()) as unknown, { packages: [] });
  });
});
