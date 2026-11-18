import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaOf, usageOf } from "../../core.js";
import { fileArtifactsCapability, type ArtifactsCapability } from "../../capabilities.js";
import { jobRoot } from "../../jobs.js";
import { mediaFileName } from "../../media.js";
import { parseModelCatalog, setModelCatalog, getImagePrice, computeImageCost } from "../../aieo/index.js";
import { SPENDING_STEPS } from "../../packages/detail.js";
import { PAID_OR_SHELL } from "../../apps/tools.js";
import { PAID_OR_SHELL_STEPS } from "../../apps/apps.js";
import { stepRunnableProblem } from "../../public-runnable.js";
import { flowFromYaml } from "../../workspace.js";
import { runWorkflow } from "../../runner.js";
import { MemoryRunStore } from "../../store.js";
import { createRegistry } from "../registry.js";
import type { LlmAuth } from "../../llm.js";
import image from "./image.js";

// The `image` step, OFFLINE: a stand-in `fetch` plays each provider (and a
// gateway), so what a call SENDS and how its cost is read are asserted on
// the wire. aieo's clients call the global fetch at request time.

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Answer every request with `reply(url)`'s JSON; record what was sent. */
function stubFetch(reply: (url: string) => unknown): { sent: Sent[]; restore: () => void } {
  const real = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({ url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    return new Response(JSON.stringify(reply(url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

const secrets = {
  async get(name: string) {
    return name.endsWith("_API_KEY") ? `key-for-${name}` : undefined;
  },
  async list() {
    return [];
  },
};

/** The datasheet rows the tests price from (bifrost's, 2026-11-12). */
const CATALOG = JSON.stringify({
  "gpt-image-1-mini": {
    mode: "image_generation",
    input_cost_per_token: 0.000002,
    input_cost_per_image_token: 0.0000025,
    output_cost_per_image_token: 0.000008,
  },
  "gemini/imagen-3.0-generate-001": { mode: "image_generation", output_cost_per_image: 0.04 },
  "openrouter/google/gemini-2.5-flash-image": { mode: "chat", input_cost_per_token: 3e-7, output_cost_per_token: 0.0000025, output_cost_per_image: 3e-7 },
  "gemini/gemini-2.5-flash-image": { mode: "image_generation", input_cost_per_token: 3e-7, output_cost_per_image_token: 0.00003, output_cost_per_image: 0.039 },
  "claude-sonnet-5-5": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
});

describe("image step", () => {
  let dir = "";
  let artifacts: ArtifactsCapability;
  let stub: ReturnType<typeof stubFetch> | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strut-image-"));
    artifacts = fileArtifactsCapability(join(dir, "artifacts"));
    setModelCatalog(parseModelCatalog(CATALOG));
  });
  afterEach(() => {
    stub?.restore();
    stub = undefined;
    setModelCatalog(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = (extra: Record<string, any> = {}, services: Record<string, any> = {}): any => ({
    runId: "r1",
    path: "pics/hero",
    workflow: "pics",
    services: { artifacts, secrets, dataDir: dir, ...services },
    ...extra,
  });

  it("xAI direct: its reported cost (ticks), the file in the run's artifacts, a preview for a model", async () => {
    stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { cost_in_usd_ticks: 200_000_000 } }));
    const out = await image.run({ prompt: "a fox", model: "xai/grok-imagine-image" }, ctx());
    assert.equal(stub.sent.length, 1);
    assert.equal(stub.sent[0]!.url, "https://api.x.ai/v1/images/generations");
    assert.equal(stub.sent[0]!.body.model, "grok-imagine-image");
    assert.equal(stub.sent[0]!.headers["authorization"], "Bearer key-for-XAI_API_KEY");
    assert.equal(out.path, "images/hero.png");
    assert.equal(out.url, "/artifacts/r1/images/hero.png");
    assert.equal(out.mediaType, "image/png");
    assert.equal(out.model, "xai/grok-imagine-image");
    assert.equal(out.cost, 0.02);
    assert.deepEqual(Buffer.from(await artifacts.read("r1", "images/hero.png")), Buffer.from(PNG, "base64"));
    const spent = usageOf(out)!;
    assert.equal(spent.cost, 0.02);
    assert.equal(spent.modelCalls, 1);
    const media = mediaOf(out);
    assert.equal(media?.length, 1);
    assert.equal(media![0]!.mediaType, "image/png");
    assert.ok(!("_media" in JSON.parse(JSON.stringify(out))), "the media marker never serializes");
  });

  it("OpenAI direct: priced from the datasheet's image-token rates", async () => {
    stub = stubFetch(() => ({
      data: [{ b64_json: PNG }],
      usage: { input_tokens: 18, input_tokens_details: { text_tokens: 18, image_tokens: 0 }, output_tokens: 272, total_tokens: 290 },
    }));
    const out = await image.run({ prompt: "a fox", model: "openai/gpt-image-1-mini", size: "1024x1024", providerOptions: { openai: { quality: "low" } } }, ctx());
    const body = stub.sent[0]!.body;
    assert.equal(stub.sent[0]!.url, "https://api.openai.com/v1/images/generations");
    assert.equal(body.model, "gpt-image-1-mini");
    assert.equal(body.quality, "low");
    assert.equal(body.size, "1024x1024");
    assert.equal(body.response_format, undefined, "gpt-image models refuse response_format");
    // 18 text tokens at $2/M + 272 image tokens at $8/M.
    assert.ok(Math.abs(out.cost - 0.002212) < 1e-12, String(out.cost));
    assert.equal(out.usage.inputTokens, 18);
    assert.equal(out.usage.outputTokens, 272);
  });

  it("a model nobody can price is refused before anything is sent", async () => {
    setModelCatalog(undefined);
    stub = stubFetch(() => ({ data: [{ b64_json: PNG }] }));
    await assert.rejects(image.run({ prompt: "a fox", model: "openai/gpt-image-1-mini" }, ctx()), /image_unpriced: no price is known for openai\/gpt-image-1-mini/);
    assert.equal(stub.sent.length, 0);
  });

  it("a provider that makes no images says which do", async () => {
    stub = stubFetch(() => ({}));
    await assert.rejects(image.run({ prompt: "a fox", model: "anthropic/claude-sonnet-5-5" }, ctx()), /"anthropic" makes no image models here\. Providers that do: google, openai, openrouter, xai/);
    assert.equal(stub.sent.length, 0);
  });

  it("OpenRouter direct: its /images endpoint and its reported usage.cost (which the SDK drops)", async () => {
    stub = stubFetch(() => ({ data: [{ b64_json: PNG, media_type: "image/png" }], usage: { prompt_tokens: 12, completion_tokens: 1290, total_tokens: 1302, cost: 0.0387036 } }));
    const out = await image.run({ prompt: "a fox", model: "openrouter/google/gemini-2.5-flash-image" }, ctx());
    assert.equal(stub.sent[0]!.url, "https://openrouter.ai/api/v1/images");
    assert.equal(stub.sent[0]!.body.model, "google/gemini-2.5-flash-image");
    assert.equal(out.cost, 0.0387036, "OpenRouter's own cost, never the datasheet's wrong row");
    assert.equal(stub.sent[0]!.headers["x-aieo-cost-call"], undefined, "aieo's call tag never leaves the process");
  });

  describe("through a gateway grant", () => {
    const grant = (direct = false): LlmAuth => async () => ({
      apiKey: "vk-1",
      baseUrl: "https://gw.test",
      headers: { "x-macaroon": "mac-1" },
      direct,
    });

    it("xai rides the OpenAI-compatible route, named, and its usage.cost is the cost", async () => {
      stub = stubFetch(() => ({ model: "grok-imagine-image", data: [{ b64_json: PNG, index: 0 }], usage: { cost_in_usd_ticks: 200_000_000, cost: 0.02 } }));
      const out = await image.run({ prompt: "a fox", model: "xai/grok-imagine-image" }, ctx({ principal: "p" }, { llmAuth: grant() }));
      const s = stub.sent[0]!;
      assert.equal(s.url, "https://gw.test/openai/v1/images/generations");
      assert.equal(s.body.model, "xai/grok-imagine-image");
      assert.equal(s.headers["authorization"], "Bearer vk-1");
      assert.equal(s.headers["x-macaroon"], "mac-1");
      assert.equal(out.cost, 0.02);
    });

    it("openai keeps its bare id; google is named gemini/", async () => {
      stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { input_tokens: 18, output_tokens: 272 } }));
      await image.run({ prompt: "a fox", model: "openai/gpt-image-1-mini" }, ctx({}, { llmAuth: grant() }));
      assert.equal(stub.sent[0]!.body.model, "gpt-image-1-mini");
      const out = await image.run({ prompt: "a fox", model: "google/imagen-3.0-generate-001" }, ctx({ path: "pics/two" }, { llmAuth: grant() }));
      assert.equal(stub.sent[1]!.url, "https://gw.test/openai/v1/images/generations");
      assert.equal(stub.sent[1]!.body.model, "gemini/imagen-3.0-generate-001");
      assert.equal(out.cost, 0.04, "per image, from the datasheet");
    });

    it("OpenRouter rides the gateway's openrouter-images provider, whatever the grant allows, at its usage.cost", async () => {
      // What the gateway answers for an OpenAI-type custom provider on
      // OpenRouter's images API (stakwork/stakgraph#1859): the cost, no tokens.
      stub = stubFetch(() => ({ data: [{ b64_json: PNG, index: 0 }], usage: { cost: 0.014 } }));
      for (const direct of [false, true]) {
        const out = await image.run({ prompt: "a fox", model: "openrouter/black-forest-labs/flux.2-klein-4b" }, ctx({ path: `pics/or-${direct}` }, { llmAuth: grant(direct) }));
        const s = stub.sent.at(-1)!;
        assert.equal(s.url, "https://gw.test/openai/v1/images/generations");
        assert.equal(s.body.model, "openrouter-images/black-forest-labs/flux.2-klein-4b");
        assert.equal(s.headers["authorization"], "Bearer vk-1");
        assert.equal(s.headers["x-macaroon"], "mac-1");
        assert.equal(out.cost, 0.014);
      }
    });
  });

  describe("an edit: source images from the run's files", () => {
    /** The start of a JPEG: enough for the AI SDK to know it by its bytes. */
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    /** What a `human` step's `attachments` hands out. */
    const photo = { name: "photo.jpg", mediaType: "image/jpeg", size: JPEG.length, path: "tasks/t1/photo.jpg" };
    beforeEach(async () => {
      await artifacts.write("r1", photo.path, JPEG);
      await artifacts.write("r1", "sketch.png", Buffer.from(PNG, "base64"));
      await artifacts.write("r1", "notes.md", Buffer.from("# notes"));
    });
    const bytesOf = async (b: Blob) => Buffer.from(await b.arrayBuffer());

    it("OpenAI: the files reach /images/edits as the images, and the source's image tokens are priced at their own rate", async () => {
      stub = stubFetch(() => ({
        data: [{ b64_json: PNG }],
        usage: { input_tokens: 277, input_tokens_details: { text_tokens: 21, image_tokens: 256 }, output_tokens: 272, total_tokens: 549 },
      }));
      const out = await image.run(
        { prompt: "make it a watercolour", model: "openai/gpt-image-1-mini", images: [photo, "sketch.png"], providerOptions: { openai: { quality: "low" } } },
        ctx(),
      );
      const s = stub.sent[0]!;
      assert.equal(s.url, "https://api.openai.com/v1/images/edits");
      const form = s.body as FormData;
      assert.equal(form.get("model"), "gpt-image-1-mini");
      assert.equal(form.get("prompt"), "make it a watercolour");
      assert.equal(form.get("quality"), "low");
      const sent = form.getAll("image[]") as Blob[];
      assert.deepEqual(
        await Promise.all(sent.map(bytesOf)),
        [JPEG, Buffer.from(PNG, "base64")],
        "each file's bytes, in order",
      );
      assert.deepEqual(
        sent.map((b) => b.type),
        ["image/jpeg", "image/png"],
      );
      // 21 text tokens at $2/M + 256 image tokens at $2.5/M + 272 made at $8/M.
      assert.ok(Math.abs(out.cost - (21 * 2 + 256 * 2.5 + 272 * 8) / 1e6) < 1e-12, String(out.cost));
      assert.equal(usageOf(out)!.cost, out.cost);
      assert.equal(out.path, "images/hero.png");
    });

    it("xAI: a JSON edit with the image as a data URL, at its reported cost", async () => {
      stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { cost_in_usd_ticks: 220_000_000 } }));
      const out = await image.run({ prompt: "watercolour", model: "xai/grok-imagine-image", images: [photo] }, ctx());
      const s = stub.sent[0]!;
      assert.equal(s.url, "https://api.x.ai/v1/images/edits");
      assert.equal(s.body.prompt, "watercolour");
      assert.deepEqual(s.body.image, { url: `data:image/jpeg;base64,${JPEG.toString("base64")}`, type: "image_url" });
      assert.equal(out.cost, 0.022);
    });

    it("Google: the image is the prompt's inline data, and its input tokens are in the cost", async () => {
      stub = stubFetch(() => ({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1305, candidatesTokenCount: 1290, totalTokenCount: 2595 },
      }));
      const out = await image.run({ prompt: "watercolour", model: "google/gemini-2.5-flash-image", images: [photo] }, ctx());
      const s = stub.sent[0]!;
      assert.equal(s.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
      const parts = s.body.contents[0].parts;
      assert.deepEqual(parts[0], { text: "watercolour" });
      assert.deepEqual(parts[1], { inlineData: { mimeType: "image/jpeg", data: JPEG.toString("base64") } });
      // 1305 input tokens (the photo's among them) at $0.3/M + 1290 made at $30/M.
      assert.ok(Math.abs(out.cost - (1305 * 0.3 + 1290 * 30) / 1e6) < 1e-12, String(out.cost));
    });

    it("OpenRouter: the images are its /images input_references", async () => {
      stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { prompt_tokens: 1024, completion_tokens: 4096, total_tokens: 5120, cost: 0.015 } }));
      const out = await image.run({ prompt: "watercolour", model: "openrouter/black-forest-labs/flux.2-klein-4b", images: [photo] }, ctx());
      const s = stub.sent[0]!;
      assert.equal(s.url, "https://openrouter.ai/api/v1/images");
      assert.deepEqual(s.body.input_references, [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG.toString("base64")}` } }]);
      assert.equal(out.cost, 0.015);
    });

    it("an edit costs its source's input tokens more than the same call without one (the datasheet-priced providers)", async () => {
      // What OpenAI answered live for gpt-image-1-mini at low 1024x1024
      // (2026-11-17), direct and through the gateway alike: the edit's 256
      // input image tokens come split out in input_tokens_details.
      const openaiUsage = (imageTokens: number) => ({
        input_tokens: 21 + imageTokens,
        input_tokens_details: { text_tokens: 21, image_tokens: imageTokens },
        output_tokens: 272,
      });
      stub = stubFetch((url) => ({ data: [{ b64_json: PNG }], usage: openaiUsage(url.endsWith("/images/edits") ? 256 : 0) }));
      for (const [i, services] of [{}, { llmAuth: async () => ({ apiKey: "vk-1", baseUrl: "https://gw.test" }) }].entries()) {
        const run = (images?: any[]) =>
          image.run({ prompt: "watercolour", model: "openai/gpt-image-1-mini", ...(images ? { images } : {}) }, ctx({ path: `pics/o${i}` }, services));
        const plain = await run();
        const edit = await run([photo]);
        assert.ok(Math.abs(edit.cost - plain.cost - (256 * 2.5) / 1e6) < 1e-12, `${edit.cost} - ${plain.cost}: the 256 image tokens at $2.5/M`);
      }
      // Gemini does not split them: the photo's tokens are in its prompt
      // count, at the input rate (one rate for text and images).
      let calls = 0;
      stub.restore();
      stub = stubFetch(() => ({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: calls++ === 0 ? 15 : 15 + 1290, candidatesTokenCount: 1290 },
      }));
      const plain = await image.run({ prompt: "watercolour", model: "google/gemini-2.5-flash-image" }, ctx());
      const edit = await image.run({ prompt: "watercolour", model: "google/gemini-2.5-flash-image", images: [photo] }, ctx());
      assert.ok(Math.abs(edit.cost - plain.cost - (1290 * 0.3) / 1e6) < 1e-12, `${edit.cost} - ${plain.cost}: the 1290 image tokens at $0.3/M`);
    });

    it("no images (none listed, or a step that sent none) draws from the prompt alone", async () => {
      stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { cost_in_usd_ticks: 200_000_000 } }));
      await image.run({ prompt: "a fox", model: "xai/grok-imagine-image", images: [] }, ctx());
      assert.equal(stub.sent[0]!.url, "https://api.x.ai/v1/images/generations");
    });

    it("a file that is not the run's, or not an image, fails the step before anything is sent", async () => {
      stub = stubFetch(() => ({ data: [{ b64_json: PNG }] }));
      const run = (images: any[], c = ctx()) => image.run({ prompt: "x", model: "openai/gpt-image-1-mini", images }, c);
      await assert.rejects(run(["tasks/t1/missing.jpg"]), /image: images: "tasks\/t1\/missing\.jpg" is not a file of this run/);
      await assert.rejects(run(["../r2/secret.png"]), /image: images: "\.\.\/r2\/secret\.png" is not a file of this run/);
      await assert.rejects(run(["notes.md"]), /image: images: notes\.md is not an image \(text\/markdown\)/);
      await artifacts.write("r1", "big.png", Buffer.alloc(5 * 1024 * 1024 + 1));
      await assert.rejects(run(["big.png"]), /image: images: big\.png is 5\.0 MB; the limit is 5\.0 MB/);
      await assert.rejects(run([photo], ctx({}, { artifacts: undefined })), /image: images lists files of the run, and this run has no artifacts capability/);
      assert.equal(stub.sent.length, 0);
    });

    describe("through a gateway grant", () => {
      const grant = (direct = false): LlmAuth => async () => ({ apiKey: "vk-1", baseUrl: "https://gw.test", headers: { "x-macaroon": "mac-1" }, direct });

      it("openai and google edits ride the gateway's /images/edits", async () => {
        stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { input_tokens: 277, input_tokens_details: { image_tokens: 256 }, output_tokens: 272 } }));
        await image.run({ prompt: "x", model: "openai/gpt-image-1-mini", images: [photo] }, ctx({}, { llmAuth: grant() }));
        await image.run({ prompt: "x", model: "google/gemini-2.5-flash-image", images: [photo] }, ctx({ path: "pics/two" }, { llmAuth: grant() }));
        assert.deepEqual(
          stub.sent.map((s) => [s.url, (s.body as FormData).get("model"), s.headers["authorization"]]),
          [
            ["https://gw.test/openai/v1/images/edits", "gpt-image-1-mini", "Bearer vk-1"],
            ["https://gw.test/openai/v1/images/edits", "gemini/gemini-2.5-flash-image", "Bearer vk-1"],
          ],
        );
      });

      it("a model the gateway cannot edit with is refused before anything is sent, unless the grant allows a direct call", async () => {
        stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { cost_in_usd_ticks: 220_000_000 } }));
        for (const model of ["xai/grok-imagine-image", "openrouter/black-forest-labs/flux.2-klein-4b"]) {
          await assert.rejects(
            image.run({ prompt: "x", model, images: [photo] }, ctx({}, { llmAuth: grant() })),
            /image models cannot edit a source image through this deployment's LLM gateway .* Edits through the gateway: google, openai/,
          );
        }
        assert.equal(stub.sent.length, 0);
        // A grant that allows a direct call: the provider's own API, with the host's key.
        const out = await image.run({ prompt: "x", model: "xai/grok-imagine-image", images: [photo] }, ctx({}, { llmAuth: grant(true) }));
        assert.equal(stub.sent[0]!.url, "https://api.x.ai/v1/images/edits");
        assert.equal(stub.sent[0]!.headers["authorization"], "Bearer key-for-XAI_API_KEY");
        assert.equal(out.cost, 0.022);
      });
    });
  });

  it("on a job run the file is the job's, named by the run, and its host hears it land", async () => {
    stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { cost_in_usd_ticks: 200_000_000 } }));
    const heard: any[] = [];
    const jobs = { notify: (job: string, u: any) => heard.push({ job, ...u }) };
    const out = await image.run({ prompt: "a fox", model: "xai/grok-imagine-image" }, ctx({ job: "j1", runId: "r9" }, { jobs }));
    assert.equal(out.path, "images/r9-hero.png");
    assert.equal(out.url, "/jobs/j1/files/images/r9-hero.png");
    assert.ok(existsSync(join(jobRoot(dir, "j1"), "images", "r9-hero.png")));
    assert.deepEqual(heard, [{ job: "j1", runId: "r9", kind: "image", url: out.url, state: "done", title: "images/r9-hero.png" }]);
  });

  it("names a file by the author's name, else the step's place in the run", () => {
    const at = (path: string, extra: Record<string, any> = {}) => ({ runId: "r1", path, workflow: "pics", ...extra }) as any;
    assert.equal(mediaFileName(at("pics/hero"), undefined, "image"), "hero");
    assert.equal(mediaFileName(at("pics/each#3/pic"), undefined, "image"), "each-3-pic");
    assert.equal(mediaFileName(at("pics/hero"), "Cover art!", "image"), "Cover_art_");
    assert.equal(mediaFileName(at("pics/hero", { job: "j" }), undefined, "image"), "r1-hero");
    assert.equal(mediaFileName(undefined, undefined, "image"), "image");
  });

  it("the datasheet's image prices: token rates, per image, never OpenRouter's rows", () => {
    assert.deepEqual(getImagePrice("openai", "gpt-image-1-mini"), { inputTokenPrice: 2, inputImageTokenPrice: 2.5, outputImageTokenPrice: 8 });
    assert.deepEqual(getImagePrice("google", "imagen-3.0-generate-001"), { perImage: 0.04 });
    assert.equal(getImagePrice("openrouter", "google/gemini-2.5-flash-image"), undefined);
    assert.equal(getImagePrice("anthropic", "claude-sonnet-5-5"), undefined);
    // An edit's source image is priced at the image-token rate.
    const edit = computeImageCost("openai", "gpt-image-1-mini", { inputTokens: 1018, inputImageTokens: 1000, outputTokens: 272, images: 1 })!;
    assert.ok(Math.abs(edit - (18 * 2 + 1000 * 2.5 + 272 * 8) / 1e6) < 1e-12);
    assert.equal(computeImageCost("google", "imagen-3.0-generate-001", { images: 2 }), 0.08);
    assert.equal(computeImageCost("openai", "dall-e-3", { images: 1 }), undefined);
  });

  it("spends like llm and agent: every list that keeps paid steps out names it", () => {
    assert.ok(SPENDING_STEPS.has("image"));
    assert.ok(PAID_OR_SHELL.includes("image"));
    assert.ok(PAID_OR_SHELL_STEPS.includes("image"));
    assert.match(stepRunnableProblem("image", { image } as any) ?? "", /spends or runs a shell/);
  });

  it("the image-gen workflow returns the image as a deliverable", async () => {
    stub = stubFetch(() => ({ data: [{ b64_json: PNG }], usage: { cost_in_usd_ticks: 200_000_000 } }));
    const yaml = readFileSync(new URL("../../workflows/image-gen.yaml", import.meta.url), "utf-8");
    const flow = flowFromYaml("image-gen", "v1", yaml);
    const store = new MemoryRunStore();
    const r = await runWorkflow(flow, { prompt: "a fox" }, await createRegistry([]), { services: { artifacts, secrets, dataDir: dir }, store });
    assert.equal(r.status, "success", JSON.stringify(r.error));
    const out = r.output as any;
    assert.equal(out.model, "xai/grok-imagine-image");
    assert.equal(out.cost, 0.02);
    assert.equal(out.image, "images/image.png");
    assert.deepEqual(out.artifacts, [{ id: "image", kind: "image", title: "a fox", path: "images/image.png" }]);
    assert.ok(existsSync(join(dir, "artifacts", r.runId, "images", "image.png")));
    const end = (store.getEvents("image-gen", r.runId) as any[]).find((e) => e.type === "step.end" && e.path === "image-gen/image");
    assert.equal(end.cost, 0.02, "the run's spend is on the step's step.end");
    assert.equal(end.modelCalls, 1);
  });
});
