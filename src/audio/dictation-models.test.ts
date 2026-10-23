import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DictationModels } from "./dictation-models.js";
import { createInstaller, type DownloadProgress, type Installer, type ModelAsset } from "./download.js";
import { DICTATION_MODELS, FIXER_MODELS, STT_MODELS, findModel } from "./models.js";

describe("dictation catalog", () => {
  it("lists Kroko and Parakeet as speech, the two Qwen3 fixers, each verifiable", () => {
    assert.deepEqual(
      DICTATION_MODELS.map((m) => [m.id, m.kind, m.runtime]),
      [
        ["zipformer-en-kroko", "speech", "sherpa-online"],
        ["parakeet-tdt-en-0.6b-v2", "speech", "sherpa-offline"],
        ["qwen3-0.6b-q4", "fixer", "llama.cpp"],
        ["qwen3-1.7b-q4", "fixer", "llama.cpp"],
      ],
    );
    for (const m of DICTATION_MODELS) {
      assert.match(m.url, /^https:\/\//, m.id);
      assert.match(m.sha256, /^[0-9a-f]{64}$/, m.id);
      assert.ok(Number.isInteger(m.bytes) && m.bytes > 1e6, m.id);
      assert.ok(m.description.length > 20, m.id);
    }
    assert.equal(new Set([...STT_MODELS, ...FIXER_MODELS].map((m) => m.id)).size, STT_MODELS.length + FIXER_MODELS.length);
    // A speech entry is its STT_MODELS entry: one download for both.
    const parakeet = findModel("parakeet-tdt-en-0.6b-v2")!;
    assert.equal(parakeet.offline, true);
    assert.equal(parakeet.archiveDir, basename(parakeet.url, ".tar.bz2"));
    for (const f of FIXER_MODELS) assert.equal(f.file, basename(f.url), f.id);
  });
});

describe("dictation model picks", () => {
  let root: string;
  let dataDir: string;
  let modelDir: string;
  /** A fake installer: each download waits for `finish(id)` (or `fail(id)`), reports half-way, then marks the model installed. */
  let gates: Map<string, { resolve: () => void; reject: (e: Error) => void }>;
  let installs: string[];
  const install: Installer = async (asset, dir, onProgress) => {
    installs.push(asset.id);
    onProgress?.({ phase: "download", received: asset.bytes / 2, total: asset.bytes });
    await new Promise<void>((resolve, reject) => gates.set(asset.id, { resolve, reject }));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".ok"), "x");
  };
  const finish = (id: string) => gates.get(id)!.resolve();
  const picker = (o: Partial<ConstructorParameters<typeof DictationModels>[0]> = {}) =>
    new DictationModels({ dataDir, modelDir, install, defaultSpeech: "zipformer-en-kroko", log: () => {}, ...o });
  const summary = async (p: DictationModels) =>
    Object.fromEntries((await p.list()).map((m) => [m.id, [m.state, m.selected, m.progress ?? null, m.error ?? null]]));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-dictation-models-"));
    dataDir = join(root, "data");
    modelDir = join(root, "models");
    gates = new Map();
    installs = [];
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("defaults to Kroko and no fixer, nothing installed, nothing stored", async () => {
    const p = picker();
    assert.deepEqual(await summary(p), {
      "zipformer-en-kroko": ["available", true, null, null],
      "parakeet-tdt-en-0.6b-v2": ["available", false, null, null],
      "qwen3-0.6b-q4": ["available", false, null, null],
      "qwen3-1.7b-q4": ["available", false, null, null],
    });
    assert.deepEqual(await p.picks(), { speech: "zipformer-en-kroko", fixer: null });
    assert.equal(await p.speechModel(), null);
    assert.equal(await p.fixerModel(), null);
    const entry = (await p.list())[0]!;
    assert.deepEqual(Object.keys(entry).sort(), ["bytes", "description", "id", "kind", "selected", "state"]);
  });

  it("a pick that is not installed downloads in the background and is used once installed", async () => {
    const p = picker();
    const listed = await p.use({ speech: "parakeet-tdt-en-0.6b-v2", fixer: "qwen3-0.6b-q4" });
    assert.deepEqual(
      listed.filter((m) => m.selected).map((m) => [m.id, m.state, m.progress]),
      [["parakeet-tdt-en-0.6b-v2", "downloading", 0.5], ["qwen3-0.6b-q4", "downloading", 0.5]],
    );
    assert.equal(await p.speechModel(), null, "not used until installed");
    // Picking again while it downloads starts nothing new.
    await p.use({ speech: "parakeet-tdt-en-0.6b-v2" });
    assert.deepEqual(installs, ["parakeet-tdt-en-0.6b-v2", "qwen3-0.6b-q4"]);
    finish("parakeet-tdt-en-0.6b-v2");
    finish("qwen3-0.6b-q4");
    await p.idle();
    assert.equal(await p.speechModel(), "parakeet-tdt-en-0.6b-v2");
    assert.deepEqual(await p.fixerModel(), { id: "qwen3-0.6b-q4", path: join(modelDir, "fixer", "qwen3-0.6b-q4", "Qwen3-0.6B-Q4_K_M.gguf") });
    assert.deepEqual((await summary(p))["parakeet-tdt-en-0.6b-v2"], ["installed", true, null, null]);
    // An installed pick downloads nothing.
    await p.use({ speech: "zipformer-en-kroko" });
    finish("zipformer-en-kroko");
    await p.idle();
    await p.use({ speech: "parakeet-tdt-en-0.6b-v2" });
    assert.deepEqual(installs, ["parakeet-tdt-en-0.6b-v2", "qwen3-0.6b-q4", "zipformer-en-kroko"]);
  });

  it("picks persist in the data dir; fixer null is none; speech alone keeps the fixer", async () => {
    finishAll();
    await picker().use({ speech: "parakeet-tdt-en-0.6b-v2", fixer: "qwen3-1.7b-q4" });
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, "audio", "dictation.json"), "utf8")), { speech: "parakeet-tdt-en-0.6b-v2", fixer: "qwen3-1.7b-q4" });
    const again = picker();
    assert.deepEqual(await again.picks(), { speech: "parakeet-tdt-en-0.6b-v2", fixer: "qwen3-1.7b-q4" });
    await again.use({ speech: "zipformer-en-kroko" });
    assert.deepEqual(await picker().picks(), { speech: "zipformer-en-kroko", fixer: "qwen3-1.7b-q4" });
    await again.use({ fixer: null });
    assert.deepEqual(await picker().picks(), { speech: "zipformer-en-kroko", fixer: null });
  });

  it("rejects unknown ids and a model of the other kind", async () => {
    const p = picker();
    await assert.rejects(() => p.use({ speech: "qwen3-0.6b-q4" }), /unknown speech model "qwen3-0.6b-q4"/);
    await assert.rejects(() => p.use({ fixer: "zipformer-en-kroko" }), /unknown fixer model/);
    await assert.rejects(() => p.use({ speech: "nemo-fast-conformer-en-80ms" }), /known: zipformer-en-kroko, parakeet-tdt-en-0.6b-v2/);
    await assert.rejects(() => p.remove("nope"), /unknown dictation model/);
    assert.deepEqual(installs, []);
  });

  it("a speech model is not downloaded where it cannot run", async () => {
    const p = picker({ requireSpeechEngine: async () => { throw new Error("stt not available"); } });
    await assert.rejects(() => p.use({ speech: "parakeet-tdt-en-0.6b-v2" }), /stt not available/);
    assert.deepEqual(await p.picks(), { speech: "zipformer-en-kroko", fixer: null });
    finishAll();
    await p.use({ fixer: "qwen3-0.6b-q4" }); // a fixer needs no sherpa
    assert.deepEqual(installs, ["qwen3-0.6b-q4"]);
  });

  it("a failed download goes back to available, saying why", async () => {
    const p = picker();
    await p.use({ fixer: "qwen3-0.6b-q4" });
    gates.get("qwen3-0.6b-q4")!.reject(new Error("sha256 mismatch for qwen3-0.6b-q4"));
    await p.idle();
    assert.deepEqual((await summary(p))["qwen3-0.6b-q4"], ["available", true, null, "sha256 mismatch for qwen3-0.6b-q4"]);
    assert.equal(await p.fixerModel(), null);
  });

  it("remove deletes the files; a removed pick goes back to the default or none; not while downloading", async () => {
    const p = picker();
    await p.use({ speech: "parakeet-tdt-en-0.6b-v2", fixer: "qwen3-0.6b-q4" });
    await assert.rejects(() => p.remove("qwen3-0.6b-q4"), /is downloading/);
    finish("parakeet-tdt-en-0.6b-v2");
    finish("qwen3-0.6b-q4");
    await p.idle();
    let listed = await p.remove("qwen3-0.6b-q4");
    assert.deepEqual(listed.find((m) => m.id === "qwen3-0.6b-q4")!.state, "available");
    assert.deepEqual(await p.picks(), { speech: "parakeet-tdt-en-0.6b-v2", fixer: null });
    listed = await p.remove("parakeet-tdt-en-0.6b-v2");
    assert.deepEqual(listed.filter((m) => m.selected).map((m) => m.id), ["zipformer-en-kroko"]);
    assert.deepEqual(await readdir(join(modelDir, "stt")), []);
    assert.equal(await p.speechModel(), null, "Kroko is the pick again, and not on disk");
  });

  /** Let every download through as soon as it starts. */
  function finishAll() {
    const set = gates.set.bind(gates);
    gates.set = (id, g) => (g.resolve(), set(id, g));
  }
});

describe("model installer", () => {
  let root: string;
  beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "strut-install-"))));
  afterEach(() => rm(root, { recursive: true, force: true }));

  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const serve = (bytes: Uint8Array, count: { n: number }) =>
    (async () => (count.n++, new Response(bytes, { headers: { "content-length": String(bytes.length) } }))) as unknown as typeof fetch;

  it("a single file: verified, saved under its name, marked installed; one download for concurrent calls", async () => {
    const bytes = new TextEncoder().encode("GGUF fake weights");
    const asset: ModelAsset = { id: "f", url: "https://x/f.gguf", sha256: sha(bytes), bytes: bytes.length, file: "f.gguf" };
    const count = { n: 0 };
    const install = createInstaller({ fetchImpl: serve(bytes, count) });
    const dir = join(root, "fixer", "f");
    const seen: DownloadProgress[] = [];
    await Promise.all([install(asset, dir, (p) => seen.push(p)), install(asset, dir)]);
    assert.equal(count.n, 1);
    assert.deepEqual((await readdir(dir)).sort(), [".ok", "f.gguf"]);
    assert.equal(await readFile(join(dir, "f.gguf"), "utf8"), "GGUF fake weights");
    assert.deepEqual(seen.at(-1), { phase: "done" });
    await install(asset, dir);
    assert.equal(count.n, 1, "an installed model is not fetched again");
  });

  it("a .tar.bz2: verified and its top directory extracted as the model dir", async () => {
    const src = join(root, "src", "model-1");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "tokens.txt"), "a 0\n");
    const archive = join(root, "m.tar.bz2");
    execFileSync("tar", ["cjf", archive, "-C", join(root, "src"), "model-1"]);
    const bytes = new Uint8Array(await readFile(archive));
    const install = createInstaller({ fetchImpl: serve(bytes, { n: 0 }) });
    const dir = join(root, "stt", "m");
    await install({ id: "m", url: "https://x/m.tar.bz2", sha256: sha(bytes), bytes: bytes.length, archiveDir: "model-1" }, dir);
    assert.deepEqual((await readdir(dir)).sort(), [".ok", "tokens.txt"]);
    assert.deepEqual((await readdir(join(root, "stt"))).sort(), ["m"], "no part or scratch files left");
  });

  it("a wrong sha256 installs nothing and leaves no part file", async () => {
    const bytes = new TextEncoder().encode("tampered");
    const install = createInstaller({ fetchImpl: serve(bytes, { n: 0 }) });
    const dir = join(root, "fixer", "f");
    await assert.rejects(() => install({ id: "f", url: "https://x/f", sha256: "0".repeat(64), bytes: 8, file: "f.gguf" }, dir), /sha256 mismatch for f/);
    assert.deepEqual(await readdir(join(root, "fixer")), []);
  });
});
