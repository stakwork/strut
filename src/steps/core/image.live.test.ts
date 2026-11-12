/**
 * LIVE image test: one real image per provider whose key is in the
 * environment (XAI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY), through the
 * `image` step, called directly (no gateway). Each costs a few cents: xAI
 * $0.02, gpt-image-1-mini at low quality ~$0.002, FLUX.2 klein through
 * OpenRouter $0.014. Opt in with STRUT_TEST_IMAGE=1 (`npm run test:image`),
 * with the keys in the environment, e.g.
 *
 *   STRUT_TEST_IMAGE=1 npx tsx --env-file=.env --test src/steps/core/image.live.test.ts
 *
 * Prices OpenAI from bifrost's datasheet, fetched live. Logs each call's
 * time, file and cost.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileArtifactsCapability } from "../../capabilities.js";
import { loadModelCatalog } from "../../aieo/index.js";
import image from "./image.js";

const enabled = process.env["STRUT_TEST_IMAGE"] === "1";

const CASES: Array<{ model: string; key: string; config?: Record<string, unknown> }> = [
  { model: "xai/grok-imagine-image", key: "XAI_API_KEY" },
  { model: "openai/gpt-image-1-mini", key: "OPENAI_API_KEY", config: { size: "1024x1024", providerOptions: { openai: { quality: "low" } } } },
  { model: "openrouter/black-forest-labs/flux.2-klein-4b", key: "OPENROUTER_API_KEY" },
];

describe("image live (STRUT_TEST_IMAGE=1)", { skip: !enabled }, () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-image-live-"));
    await loadModelCatalog({ refreshMs: 0 });
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const secrets = {
    async get(name: string) {
      return process.env[name];
    },
    async list() {
      return [];
    },
  };

  for (const c of CASES) {
    it(c.model, { skip: !process.env[c.key] && `no ${c.key}` }, async () => {
      const artifacts = fileArtifactsCapability(join(dir, "artifacts"));
      const name = c.model.replace(/\W+/g, "-");
      const t = Date.now();
      const out = await image.run(
        { prompt: "A small red fox sitting in fresh snow, simple flat illustration", model: c.model, name, ...c.config },
        { runId: "live", path: `live/${name}`, workflow: "live", services: { artifacts, secrets, dataDir: dir } } as any,
      );
      const file = join(await artifacts.dir("live"), out.path);
      assert.ok((await stat(file)).size > 1000, "an image was written");
      assert.ok(out.cost > 0 && out.cost < 0.5, `a real cost: ${out.cost}`);
      console.log(`[image live] ${c.model}: ${Date.now() - t} ms, ${out.mediaType} ${out.bytes} bytes, $${out.cost}`);
    });
  }
});
