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
import { setModelCatalog } from "./aieo/index.js";

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
