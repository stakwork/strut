/**
 * The run cap a package ships (`maxRunCostUsd:` in strut.yaml). `readPackage`
 * resolves it over the package's OWN workflows (src/packages/format.ts); the
 * install records it on each workflow version it writes
 * (`upstream.maxRunCostUsd`, src/packages/install.ts); and a run's cap is an
 * admin's own, else the package's, else the deployment's (`workflowRunCap`,
 * src/run-cap.ts). So an install sets it, a release follows it, an admin's
 * own cap stays through a release, and an uninstall takes it with the
 * workflow. The run test's `llm` steps reach a stand-in gateway through the
 * Mothership: it counts each run's spend and refuses a call once the run has
 * spent the cap its run link carries, as the real gateway does.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { bytesToHex, ecdsaPublicKey, verify, type Policy } from "gatekey";
import { createStrut, type Strut } from "../createStrut.js";
import { createMothership } from "../mothership.js";
import { workflowRunCap } from "../run-cap.js";
import { MemorySecretStore } from "../secret-store.js";
import { MemoryRunStore } from "../store.js";
import { mintDelegation } from "../test-util/mint-delegation.js";
import { WorkspaceManager } from "../workspace.js";
import { derivePackageDetail } from "./detail.js";
import { readPackage } from "./format.js";

const KEY = "run-cap-api-key";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const PKG = "acme/mail";
const REPLY = `${PKG}/reply`;
const DIGEST = `${PKG}/digest`;
const ACTOR = "alice-1";

// The gateway's org key, and what it verifies a run link with.
const orgPriv = randomBytes(32);
orgPriv[0] = 1;
const policy: Policy = { type: "single", key: { alg: "ecdsa-secp256k1-sha256", key: bytesToHex(ecdsaPublicKey(orgPriv)) } };

/** Each call costs this much at the stand-in gateway. */
const CALL_USD = 0.4;
/** What the stand-in gateway has counted, by run id. */
const spent = new Map<string, number>();

/** A stand-in for the Mothership's gateway: it verifies the run link, keeps
 *  one counter per run, and refuses a call once the run has spent the cap
 *  its run block carries (`max_cost_usd`). Each call it lets through costs
 *  `CALL_USD`. */
async function gateway(): Promise<{ root: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const claims = verify(String(req.headers["x-macaroon"]), policy, new Date());
      const cap = claims.chain[2]!.max_cost_usd;
      const so = spent.get(claims.run_id) ?? 0;
      if (so >= cap) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `run ${claims.run_id} has spent its $${cap} cap`, type: "budget_exceeded" } }));
        return;
      }
      spent.set(claims.run_id, so + CALL_USD);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "x", object: "chat.completion", created: 0, model: JSON.parse(body).model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { root: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

/** Four model calls: $1.60 at the stand-in gateway. */
const REPLY_YAML = (note = "") =>
  `name: ${REPLY}\ndescription: Replies${note}\nsteps:\n${["a", "b", "c", "d"].map((id) => `  - { id: ${id}, type: llm, config: { model: maple/gemma4-31b, prompt: hi } }\n`).join("")}`;

/** The fixture package: `reply`, `digest`, and the strut.yaml tail given. */
const MAIL = (tail: string, version = "0.1.0", reply = REPLY_YAML()): Record<string, string> => ({
  "strut.yaml": `package: ${PKG}\nversion: ${version}\n${tail}`,
  "workflows/reply.yaml": reply,
  "workflows/digest.yaml": `name: ${DIGEST}\nsteps:\n  - { id: say, type: log, config: { message: digest } }\n`,
});
const capped = (usd: number) => `maxRunCostUsd:\n  reply: ${usd}\n`;

let root: string;
async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = join(root, "src", crypto.randomUUID());
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const ENV = ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES", "STRUT_RUN_MAX_COST_USD", "STRUT_MOTHERSHIP_REQUIRED"];
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_SECRET_KEY"] = "run-cap-secret";
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-run-cap-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("strut.yaml's maxRunCostUsd: key (readPackage)", () => {
  it("names a workflow of the package by its name inside it, in dollars; the store's detail says it", async () => {
    const dir = await writeTree(MAIL(capped(1)));
    const info = await readPackage(dir);
    assert.deepEqual(info.maxRunCostUsd, { [REPLY]: 1 });
    const d = await derivePackageDetail({ ...info, dir });
    assert.deepEqual(d.workflows.map((w) => [w.name, w.maxRunCostUsd]), [["digest", undefined], ["reply", 1]]);
    assert.equal((await readPackage(await writeTree(MAIL("")))).maxRunCostUsd, undefined, "none: the deployment's");
  });

  it("refuses a workflow the package does not carry, a cap that is not a positive number, and a bundle that carries one", async () => {
    const refused = async (tail: string, pattern: RegExp) => assert.rejects(readPackage(await writeTree(MAIL(tail))), pattern);
    await refused("maxRunCostUsd:\n  send: 1\n", /^Error: bad_package: strut\.yaml: maxRunCostUsd\.send: "send" is not a workflow of the package/);
    await refused(`maxRunCostUsd:\n  ${REPLY}: 1\n`, /maxRunCostUsd\.acme\/mail\/reply: "acme\/mail\/reply" is not a workflow of the package/);
    await refused("maxRunCostUsd:\n  reply: 0\n", /maxRunCostUsd\.reply: a run's cap is a positive number of dollars/);
    await refused("maxRunCostUsd:\n  reply: -1\n", /maxRunCostUsd\.reply: a run's cap is a positive number of dollars/);
    await refused("maxRunCostUsd:\n  reply: '1'\n", /maxRunCostUsd\.reply/);
    await refused("maxRunCostUsd: 1\n", /maxRunCostUsd/);
    const bundle = await writeTree({ "strut.yaml": `package: ${PKG}\nversion: 0.1.0\nbundle:\n  - git+https://github.com/acme/mail@main\nmaxRunCostUsd:\n  reply: 1\n` });
    await assert.rejects(readPackage(bundle), /maxRunCostUsd: a bundle lists packages and has no maxRunCostUsd of its own/);
  });
});

describe("a package's run cap", () => {
  let ws: WorkspaceManager;
  let store: MemoryRunStore;
  let strut: Strut;
  let gw: { root: string; server: Server };
  before(async () => {
    gw = await gateway();
  });
  after(() => {
    gw.server.closeAllConnections();
    gw.server.close();
  });
  beforeEach(async () => {
    ws = new WorkspaceManager(join(root, "box"));
    store = new MemoryRunStore();
    const ms = createMothership({ dataDir: "/nonexistent", store: new MemorySecretStore() });
    const d = mintDelegation({ actor: ACTOR, orgPriv, userPriv: randomBytes(32) });
    await ms.delegations.put(ACTOR, { macaroon: d.macaroon, delegationId: d.delegationId, apiKey: "vk", baseUrl: gw.root, exp: d.exp });
    strut = await createStrut({
      workspace: ws,
      store,
      dataDir: join(root, "data"),
      llmAuth: ms.llmAuth,
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      orchestrator: false,
      builder: false,
      views: false,
      concepts: false,
      stt: false,
      subscriptionPoll: false,
    });
    ms.mount({ app: new Hono(), workspace: strut.workspace });
  });
  afterEach(async () => {
    await strut.close();
  });

  const call_ = async (method: string, path: string, body?: unknown) => {
    const res = await strut.app.request(path, { method, headers: auth, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as any };
  };
  /** A release through the distro's door, which follows each release; the
   *  installer owns the workflows, so their runs bill them. */
  const release = async (files: Record<string, string>) => {
    const r = await strut.packages.install(`file:${await writeTree(files)}`, { actor: ACTOR, door: "distro" });
    return r.packages[0]!.items.find((i) => i.name === REPLY)?.status;
  };
  const capOf = async (name = REPLY) => workflowRunCap(await ws.getWorkflowMetadata(name));
  const listed = async (name = REPLY) => {
    const w = (await call_("GET", "/workflows")).json.find((e: { name: string }) => e.name === name);
    return [w.maxRunCostUsd, w.packageMaxRunCostUsd];
  };
  const setCap = async (usd: number | null) => assert.equal((await call_("PUT", `/workflows/${encodeURIComponent(REPLY)}/run-cap`, { maxRunCostUsd: usd })).status, 200);
  const run = async () => {
    const res = await call_("POST", `/workflows/${encodeURIComponent(REPLY)}/run`, { input: {} });
    assert.equal(res.status, 202, JSON.stringify(res.json));
    for (let i = 0; i < 400; i++) {
      const s = await store.getRunSummary(REPLY, res.json.runId);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the run never finished");
  };

  it("an install records it on the workflow's version; the workflow list says it; a workflow it does not name has none", async () => {
    assert.equal(await release(MAIL(capped(1))), "installed");
    const meta = (await ws.getWorkflowMetadata(REPLY))!;
    assert.equal(meta.maxRunCostUsd, undefined, "not an admin's");
    assert.equal(meta.versions[meta.active]!.upstream!.maxRunCostUsd, 1);
    assert.equal(await capOf(), 1);
    assert.deepEqual(await listed(), [undefined, 1]);
    assert.equal(await capOf(DIGEST), undefined);
    assert.deepEqual(await listed(DIGEST), [undefined, undefined]);
  });

  it("a release follows it: one that changes only strut.yaml, one that changes the workflow too, and one that drops it", async () => {
    await release(MAIL(capped(1)));
    assert.equal(await release(MAIL(capped(2), "0.2.0")), "stamped");
    assert.equal(await capOf(), 2);
    assert.equal(await release(MAIL(capped(3), "0.3.0", REPLY_YAML(" to mail"))), "updated");
    assert.equal(await capOf(), 3);
    await release(MAIL("", "0.4.0", REPLY_YAML(" to mail")));
    assert.equal(await capOf(), undefined, "the deployment's again");
    assert.deepEqual(await listed(), [undefined, undefined]);
  });

  it("an admin's own cap wins over it and stays through a release; cleared, the package's is the cap again", async () => {
    await release(MAIL(capped(1)));
    await setCap(5);
    assert.equal(await capOf(), 5);
    assert.deepEqual(await listed(), [5, 1]);
    await release(MAIL(capped(2), "0.2.0"));
    assert.equal((await ws.getWorkflowMetadata(REPLY))!.maxRunCostUsd, 5, "a release never writes the admin's cap");
    assert.equal(await capOf(), 5);
    assert.deepEqual(await listed(), [5, 2]);
    await setCap(null);
    assert.equal(await capOf(), 2);
  });

  it("an uninstall leaves nothing behind: a workflow later made under the name has no cap; a fork it keeps keeps its versions, the cap with them", async () => {
    await release(MAIL(capped(1)));
    await setCap(5);
    await strut.packages.uninstall(PKG, { door: "distro" });
    assert.equal(await ws.getWorkflowMetadata(REPLY), null);
    await ws.createWorkflow(REPLY, REPLY_YAML());
    assert.equal(await capOf(), undefined);
    assert.deepEqual(await listed(), [undefined, undefined]);
    await ws.deleteWorkflow(REPLY);

    await release(MAIL(capped(1)));
    await ws.publishWorkflow(REPLY, "mine", REPLY_YAML(" my way"));
    const out = await strut.packages.uninstall(PKG, { door: "distro" });
    assert.deepEqual(out.kept.map((k) => k.name), [REPLY]);
    assert.equal(await capOf(), 1, "the fork is the admin's, its versions as they were");
  });

  it("a run stops at the cap the package shipped, not the deployment's; an admin's own cap lets it go on", async () => {
    await release(MAIL(capped(1)));
    const stopped = await run();
    assert.equal(stopped.status, "error");
    assert.match(JSON.stringify(stopped.error), /has spent its \$1 cap/);
    assert.equal(spent.get(stopped.runId)!.toFixed(2), "1.20", "three calls started under $1; the fourth was refused");

    await setCap(5);
    const done = await run();
    assert.equal(done.status, "success", done.error);
    assert.equal(spent.get(done.runId)!.toFixed(2), "1.60");
  });
});
