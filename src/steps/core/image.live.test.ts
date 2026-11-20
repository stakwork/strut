/**
 * LIVE image test: one real image per provider whose key is in the
 * environment (XAI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
 * GOOGLE_GENERATIVE_AI_API_KEY), through the `image` step, called directly
 * (no gateway); then one EDIT per provider, of the image it made (`images`).
 * Each costs a few cents: xAI $0.02 (an edit $0.022), gpt-image-1-mini at
 * low quality ~$0.002–0.003, FLUX.2 klein through OpenRouter ~$0.015. Opt in
 * with STRUT_TEST_IMAGE=1 (`npm run test:image`), with the keys in the
 * environment, e.g.
 *
 *   STRUT_TEST_IMAGE=1 npx tsx --env-file=.env --test src/steps/core/image.live.test.ts
 *
 * Prices OpenAI and Google from bifrost's datasheet, fetched live. Logs each
 * call's time, file and cost; STRUT_TEST_IMAGE_KEEP=1 keeps the files, to
 * look at each edit beside its source.
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
  { model: "google/gemini-2.5-flash-image", key: "GOOGLE_GENERATIVE_AI_API_KEY" },
];

describe("image live (STRUT_TEST_IMAGE=1)", { skip: !enabled }, () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-image-live-"));
    await loadModelCatalog({ refreshMs: 0 });
  });
  after(async () => {
    if (process.env["STRUT_TEST_IMAGE_KEEP"] === "1") console.log(`[image live] kept ${dir}`);
    else await rm(dir, { recursive: true, force: true });
  });

  const secrets = {
    async get(name: string) {
      return process.env[name];
    },
    async list() {
      return [];
    },
  };

  /** One call of the step on the run "live"; logs the file it wrote. */
  const make = async (model: string, name: string, config: Record<string, unknown>) => {
    const artifacts = fileArtifactsCapability(join(dir, "artifacts"));
    const t = Date.now();
    const out = await image.run(
      { model, name, ...config } as any,
      { runId: "live", path: `live/${name}`, workflow: "live", services: { artifacts, secrets, dataDir: dir } } as any,
    );
    const file = join(await artifacts.dir("live"), out.path);
    assert.ok((await stat(file)).size > 1000, "an image was written");
    assert.ok(out.cost > 0 && out.cost < 0.5, `a real cost: ${out.cost}`);
    console.log(`[image live] ${name}: ${Date.now() - t} ms, ${file}, ${out.mediaType} ${out.bytes} bytes, $${out.cost}`);
    return out;
  };

  for (const c of CASES) {
    const skip = !process.env[c.key] && `no ${c.key}`;
    const name = c.model.replace(/\W+/g, "-");
    let made: { path: string } | undefined;
    it(c.model, { skip }, async () => {
      made = await make(c.model, name, { prompt: "A small red fox sitting in fresh snow, simple flat illustration", ...c.config });
    });
    // The edit's source is the image just made: look at the two side by side.
    it(`${c.model} edits`, { skip }, async () => {
      assert.ok(made, "the image to edit was made");
      await make(c.model, `${name}-edit`, { prompt: "Redraw this picture as an intricate brass clockwork sculpture of its subject, in the same pose", images: [made.path], ...c.config });
    });
  }
});
