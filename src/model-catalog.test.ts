// startModelCatalog (src/llm.ts): the default server's boot hook that loads
// bifrost's datasheet into aieo, kept under the data dir. A file of its own:
// the catalog is process-wide, and llm.test.ts asserts the list before one is
// loaded. The sheet is served from 127.0.0.1 through STRUT_MODEL_CATALOG.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModelOptions, startModelCatalog } from "./llm.js";
import { setModelCatalog, modelCatalogStatus, loadModelCatalog } from "./aieo/index.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";

const SHEET = JSON.stringify({
  "claude-sonnet-5-5": { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
});

describe("startModelCatalog", () => {
  let server: Server;
  let url: string;
  let hits = 0;
  before(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(SHEET);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/datasheet`;
  });
  after(async () => {
    delete process.env["STRUT_MODEL_CATALOG"];
    setModelCatalog(undefined);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("off: loads nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-catalog-"));
    process.env["STRUT_MODEL_CATALOG"] = "off";
    await startModelCatalog(dir);
    assert.equal(hits, 0);
    assert.equal(existsSync(join(dir, "models", "datasheet.json")), false);
  });

  it("loads the sheet, keeps it under the data dir, and /llm/models shows its prices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-catalog-"));
    const before = (await listModelOptions()).models.find((m) => m.name === "anthropic/claude-sonnet-5-5");
    assert.equal(before?.pricing, undefined, "no catalog: no price for Sonnet");
    process.env["STRUT_MODEL_CATALOG"] = url;
    await startModelCatalog(dir);
    assert.equal(hits, 1);
    assert.equal(readFileSync(join(dir, "models", "datasheet.json"), "utf8"), SHEET);
    const sonnet = (await listModelOptions()).models.find((m) => m.name === "anthropic/claude-sonnet-5-5");
    assert.deepEqual(sonnet?.pricing, { inputTokenPrice: 2, outputTokenPrice: 10 });
    assert.equal(sonnet?.contextLimit, 1_000_000);
  });
});

describe("the catalog for every host", () => {
  let server: Server;
  let url: string;
  let hits = 0;
  const saved = process.env["STRUT_MODEL_CATALOG"];
  before(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(SHEET);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/datasheet`;
  });
  after(async () => {
    if (saved === undefined) delete process.env["STRUT_MODEL_CATALOG"];
    else process.env["STRUT_MODEL_CATALOG"] = saved;
    setModelCatalog(undefined);
    await new Promise<void>((r) => server.close(() => r()));
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  const boot = (extra: object = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "strut-cs-"));
    return createStrut({ workspace: new WorkspaceManager(dir), store: new MemoryRunStore(), serveUi: false, enableChat: false, ...extra });
  };

  it("startModelCatalog is idempotent for one data dir and source", async () => {
    setModelCatalog(undefined);
    hits = 0;
    process.env["STRUT_MODEL_CATALOG"] = url;
    const dir = mkdtempSync(join(tmpdir(), "strut-catalog-"));
    await Promise.all([startModelCatalog(dir), startModelCatalog(dir)]);
    await startModelCatalog(dir);
    assert.equal(hits, 1);
  });

  it("createStrut starts it for its data dir, detached; STRUT_MODEL_CATALOG=off and modelCatalog:false skip it", async () => {
    setModelCatalog(undefined);
    hits = 0;
    process.env["STRUT_MODEL_CATALOG"] = url;
    const strut = await boot();
    await until(() => modelCatalogStatus().loaded);
    assert.equal(hits, 1);
    assert.equal(modelCatalogStatus().loaded, true);
    assert.equal(existsSync(join(strut.dataDir, "models", "datasheet.json")), true);
    await strut.close?.();

    setModelCatalog(undefined);
    hits = 0;
    const optedOut = await boot({ modelCatalog: false });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(hits, 0);
    await optedOut.close?.();

    process.env["STRUT_MODEL_CATALOG"] = "off";
    const off = await boot();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(hits, 0);
    assert.equal(modelCatalogStatus().loaded, false);
    await off.close?.();
  });

  it("modelCatalogStatus reports a failed first load, loudly, and /llm/models carries it", async () => {
    setModelCatalog(undefined);
    const errors: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    console.warn = () => {};
    try {
      const got = await loadModelCatalog({ url: "http://127.0.0.1:9/none", refreshMs: 0, fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
      assert.deepEqual(got, { models: 0, source: "none" });
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
    const st = modelCatalogStatus();
    assert.equal(st.loaded, false);
    assert.match(st.lastError ?? "", /ECONNREFUSED/);
    assert.ok(errors.some((e) => /NOT loaded.*http:\/\/127\.0\.0\.1:9\/none.*ECONNREFUSED.*unpriced/.test(e)), errors.join("|"));
    assert.deepEqual((await listModelOptions()).catalog, st);
  });
});
