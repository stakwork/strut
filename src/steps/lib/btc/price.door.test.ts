/** A signed-in public visitor calls `btc/price` through POST /public/mcp when the app grants it. */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../../../createStrut.js";
import { WorkspaceManager } from "../../../workspace.js";
import { createRegistry } from "../../registry.js";
import { kitForTests } from "../../../test-util/app-kit.js";
import { keySignIn, publicAppToken, setEnv, stepCall } from "../../../test-util/public-door.js";

const KEY = "btc-price-key";
const MEMPOOL = { time: 1_760_000_000, USD: 100000, EUR: 90000, GBP: 80000, CAD: 140000, CHF: 85000, AUD: 150000, JPY: 15000000 };

describe("btc/price at the visitor's door", () => {
  let root: string;
  let restore: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let requests = 0;
  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://prices.test${path}`, init);

  before(async () => {
    restore = setEnv({ STRUT_API_KEY: KEY });
    root = await mkdtemp(join(tmpdir(), "strut-btc-price-"));
    const http = (async () => {
      requests++;
      return { ok: true, status: 200, body: MEMPOOL, headers: {} };
    }) as never;
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")), kit: await kitForTests(), registry: await createRegistry([]),
      services: { http },
      scheduler: false, serveUi: false, autoResume: false, wakeDelayMs: 0,
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    } as never);
    for (const [name, steps] of [["priced", "[btc/price]"], ["plain", "[]"]]) {
      const dir = join(root, "apps", name!);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "app.yaml"), `title: ${name}\ngrants:\n  steps: ${steps}\n`);
      await writeFile(join(dir, "src", "App.tsx"), `export default function App() { return <p>${name}</p>; }\n`);
      const r = await strut.apps.publish(dir, name!, { surface: "person" });
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    }
    const view = await req("/public-view", {
      method: "PUT",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ apps: [{ name: "priced", reads: ["btc/price"] }, { name: "plain", reads: ["btc/price"] }], visitors: { signIn: ["key"] } }),
    });
    assert.equal(view.status, 200, await view.clone().text());
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await rm(root, { recursive: true, force: true });
    restore?.();
  });

  it("a signed-in visitor gets the price, and an app that does not grant it is refused", async () => {
    const me = await keySignIn(req);
    const headers = { authorization: `Bearer ${me.token}` };
    const call = async (app: string, config: Record<string, unknown>) => stepCall(req, "/public/mcp", "btc/price", config, headers, await publicAppToken(req, app));
    const got = await call("priced", { currency: "eur", sats: 1_000_000 });
    assert.ok("result" in got, JSON.stringify(got));
    assert.deepEqual({ ...got.result, at: undefined }, { currency: "EUR", perBtc: 90000, at: undefined, source: "mempool.space", cached: false, fiat: 900 });
    assert.equal(requests, 1);
    assert.equal(((await call("priced", { currency: "EUR" })) as { result: { cached: boolean } }).result.cached, true);
    assert.equal(requests, 1);
    assert.ok("error" in (await call("plain", { currency: "EUR" })));
  });
});
