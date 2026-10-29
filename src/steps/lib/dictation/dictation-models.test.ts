import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createStrut } from "../../../createStrut.js";
import { NO_LADYBUG, memoryWorkspace, type MemoryWorkspace } from "../memory/_test-workspace.js";
import { MemoryRunStore } from "../../../store.js";
import { WorkspaceManager } from "../../../workspace.js";
import { createStt, type SttEngine, type TranscribeResult } from "../../../audio/stt.js";
import type { Installer } from "../../../audio/download.js";

// Picking dictation's models through strut's own doors: the dictation/*
// steps (POST /steps/<type>/run) and the next POST /audio/transcribe using
// the pick. A fake installer stands in for the network; a fake engine for
// sherpa, each recognizer saying which model it is.
// The fixer runs only on a vocabulary read from memory, which lives in a
// Ladybug workspace graph; without one (CI) the transcript goes out as heard,
// no fixer named.
const hasLadybug = !NO_LADYBUG;

const FAKE_FIXER = `data:text/javascript,${encodeURIComponent(`
export function make() {
  return {
    judge: async (qs) => qs.map(() => 0),
    score: async (ss) => ss.map(() => 0),
    retract: async () => [],
    ready: async () => {},
    dispose: async () => {},
  };
}`)}`;

describe("dictation models: steps and transcription", () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-dictation-models-"));
  const dataDir = join(dir, "data");
  const modelDir = join(dir, "models");
  const gates = new Map<string, () => void>();
  const install: Installer = async (asset, into, onProgress) => {
    onProgress?.({ phase: "download", received: asset.bytes / 4, total: asset.bytes });
    await new Promise<void>((r) => gates.set(asset.id, r));
    mkdirSync(into, { recursive: true });
    for (const f of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) writeFileSync(join(into, f), "");
    writeFileSync(join(into, ".ok"), "x");
  };
  const idOf = (config: Record<string, unknown>) => basename(join(String((config["modelConfig"] as { tokens: string }).tokens), ".."));
  const engine: SttEngine = {
    OnlineRecognizer: class {
      text: string;
      constructor(config: Record<string, unknown>) {
        this.text = `streamed by ${idOf(config)}`;
      }
      createStream() { return { acceptWaveform() {}, inputFinished() {} }; }
      isReady() { return false; }
      decode() {}
      isEndpoint() { return false; }
      reset() {}
      getResult() { return { text: this.text }; }
    } as unknown as SttEngine["OnlineRecognizer"],
    OfflineRecognizer: class {
      text: string;
      constructor(config: Record<string, unknown>) {
        this.text = `Decoded by ${idOf(config)}.`;
      }
      createStream() { return { acceptWaveform() {} }; }
      decode() {}
      getResult() { return { text: this.text }; }
    } as unknown as NonNullable<SttEngine["OfflineRecognizer"]>,
    readWave: () => ({ samples: new Float32Array(16000), sampleRate: 16000 }),
  };
  // A fake fixer model in the worker: CI has no llama.cpp model to load.
  const fixerSpec = () => ({ module: FAKE_FIXER, factory: "make" });
  const stt = createStt({ dataDir, modelDir, engine: async () => engine, install, fixerSpec, env: {}, log: () => {} });
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let memory: MemoryWorkspace | undefined;

  before(async () => {
    memory = hasLadybug ? await memoryWorkspace() : undefined;
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")), store: new MemoryRunStore(), dataDir, stt, ...(memory ? { graph: memory.graph } : {}),
      serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, browserWorkflows: false,
    });
  });
  after(async () => {
    await strut.close();
    await memory?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  type Listed = { models: { id: string; kind: string; bytes: number; description: string; state: string; progress?: number; selected: boolean }[] };
  const step = async (type: string, input: unknown, ok = true) => {
    const res = await strut.app.request(`/steps/${type}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: input }) });
    const body = (await res.json()) as { status: string; output?: Listed; error?: string };
    assert.equal(body.status, ok ? "success" : "error", JSON.stringify(body).slice(0, 600));
    return ok ? body.output! : body.error!;
  };
  const brief = (l: Listed) => l.models.map((m) => `${m.id}:${m.state}${m.progress !== undefined ? `@${m.progress}` : ""}${m.selected ? "*" : ""}`);
  const transcribe = async (query = "") => {
    const res = await strut.app.request(`/audio/transcribe${query}`, { method: "POST", body: new Uint8Array(64) });
    assert.equal(res.status, 200);
    return (await res.json()) as TranscribeResult;
  };

  it("dictation/models lists speech and fixer models: Kroko picked, no fixer", async () => {
    const out = (await step("dictation/models", {})) as Listed;
    assert.deepEqual(brief(out), ["zipformer-en-kroko:available*", "parakeet-tdt-en-0.6b-v2:available", "qwen3-0.6b-q4:available", "qwen3-1.7b-q4:available"]);
    assert.deepEqual(out.models.map((m) => m.kind), ["speech", "speech", "fixer", "fixer"]);
    assert.equal(out.models[1]!.bytes, 482468385);
  });

  it("with no pick, /audio/transcribe uses Kroko as before (downloading it on first use)", async () => {
    const reply = transcribe();
    while (!gates.has("zipformer-en-kroko")) await new Promise((r) => setTimeout(r, 1));
    gates.get("zipformer-en-kroko")!();
    const out = await reply;
    assert.deepEqual(out, { text: "streamed by zipformer-en-kroko", segments: [{ text: "streamed by zipformer-en-kroko", words: [] }], model: "zipformer-en-kroko", hotwords: null, durationMs: out.durationMs, fixer: null });
  });

  it("dictation/use picks Parakeet and a fixer; they download in the background", async () => {
    const out = (await step("dictation/use", { speech: "parakeet-tdt-en-0.6b-v2", fixer: "qwen3-0.6b-q4" })) as Listed;
    assert.deepEqual(brief(out), ["zipformer-en-kroko:installed", "parakeet-tdt-en-0.6b-v2:downloading@0.25*", "qwen3-0.6b-q4:downloading@0.25*", "qwen3-1.7b-q4:available"]);
    // Until Parakeet is installed, transcription keeps to Kroko.
    assert.equal((await transcribe()).model, "zipformer-en-kroko");
  });

  it("once installed, /audio/transcribe uses the picks and names them; ?model= still wins", async () => {
    gates.get("parakeet-tdt-en-0.6b-v2")!();
    gates.get("qwen3-0.6b-q4")!();
    await stt.dictation.idle();
    assert.deepEqual(brief((await step("dictation/models", {})) as Listed), ["zipformer-en-kroko:installed", "parakeet-tdt-en-0.6b-v2:installed*", "qwen3-0.6b-q4:installed*", "qwen3-1.7b-q4:available"]);
    const out = await transcribe();
    assert.deepEqual({ ...out, durationMs: 0 }, { text: "Decoded by parakeet-tdt-en-0.6b-v2.", segments: [{ text: "Decoded by parakeet-tdt-en-0.6b-v2.", words: [] }], model: "parakeet-tdt-en-0.6b-v2", hotwords: null, durationMs: 0, fixer: hasLadybug ? "qwen3-0.6b-q4" : null });
    assert.equal((await transcribe("?model=zipformer-en-kroko")).model, "zipformer-en-kroko");
  });

  it("the pick survives a restart: it lives in the data dir", async () => {
    const again = createStt({ dataDir, modelDir, engine: async () => engine, install, env: {}, log: () => {} });
    assert.deepEqual(await again.dictation.picks(), { speech: "parakeet-tdt-en-0.6b-v2", fixer: "qwen3-0.6b-q4" });
    assert.equal((await again.transcribe(new Uint8Array(64))).model, "parakeet-tdt-en-0.6b-v2");
  });

  it("dictation/use with fixer null turns the fixer off and keeps the speech pick", async () => {
    const out = (await step("dictation/use", { fixer: null })) as Listed;
    assert.deepEqual(out.models.filter((m) => m.selected).map((m) => m.id), ["parakeet-tdt-en-0.6b-v2"]);
  });

  it("dictation/remove-model deletes a model, never the active one or the default speech model", async () => {
    let out = (await step("dictation/remove-model", { id: "qwen3-0.6b-q4" })) as Listed;
    assert.equal(out.models.find((m) => m.id === "qwen3-0.6b-q4")!.state, "available");
    assert.match(JSON.stringify(await step("dictation/remove-model", { id: "parakeet-tdt-en-0.6b-v2" }, false)), /is in use/);
    assert.match(JSON.stringify(await step("dictation/remove-model", { id: "zipformer-en-kroko" }, false)), /the default speech model/);
    await step("dictation/use", { speech: "zipformer-en-kroko" });
    out = (await step("dictation/remove-model", { id: "parakeet-tdt-en-0.6b-v2" })) as Listed;
    assert.deepEqual(brief(out), ["zipformer-en-kroko:installed*", "parakeet-tdt-en-0.6b-v2:available", "qwen3-0.6b-q4:available", "qwen3-1.7b-q4:available"]);
    assert.equal((await transcribe()).model, "zipformer-en-kroko");
  });

  it("an unknown model, or one of the other kind, is an error", async () => {
    assert.match(JSON.stringify(await step("dictation/use", { speech: "qwen3-1.7b-q4" }, false)), /unknown speech model/);
    assert.match(JSON.stringify(await step("dictation/remove-model", { id: "nope" }, false)), /unknown dictation model/);
  });
});
