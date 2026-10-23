/**
 * STT model catalog — the one list desktop, server, and the dream cycle
 * agree on (plans/local-desktop-and-stt.md §4.5). Every entry is a sherpa-onnx
 * GitHub release asset with its sha256, so a download is verifiable and a
 * server image can pre-bake the same files.
 *
 * Transducers only: hotwords (§4.2) need a transducer, and the NeMo
 * transducer in sherpa is greedy-only, so `hotwords` records which entries
 * can be biased. Streaming entries serve `/audio/stream` and
 * `/audio/transcribe`; an `offline` one (Parakeet) decodes a whole clip at
 * once and serves `/audio/transcribe` only.
 *
 * The dictation catalog (`DICTATION_MODELS`, plans/dictation-models.md) is
 * what a user picks from: some of these speech models plus the fixer models.
 */
import { join } from "node:path";

export interface SttModel {
  id: string;
  url: string;
  /** sha256 of the `.tar.bz2`. */
  sha256: string;
  bytes: number;
  /** Top-level directory inside the archive. */
  archiveDir: string;
  language: string;
  /** How often partials change, measured (ms). Baked into the export. */
  chunkMs: number;
  /** Accepts a hotwords list (`modified_beam_search` transducer). */
  hotwords: boolean;
  /** Decodes a whole clip at once (sherpa's OfflineRecognizer): no streams,
   *  `/audio/transcribe` only. `chunkMs` and `tailPadMs` do not apply. */
  offline?: boolean;
  /** Emits casing and punctuation. */
  cased: boolean;
  /** Silence to feed after the last audio so the final chunk flushes (ms). */
  tailPadMs: number;
  description: string;
}

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

export const STT_MODELS: readonly SttModel[] = [
  {
    id: "zipformer-en-kroko",
    url: `${RELEASE}/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2`,
    sha256: "c8676e5ff9ac2a85296e53ee0fd4d5fb1db6770e7a7647166eeafe349ade6834",
    bytes: 57267600,
    archiveDir: "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06",
    language: "en",
    chunkMs: 1280,
    hotwords: true,
    cased: true,
    tailPadMs: 2000,
    description: "Streaming Zipformer (Banafo Kroko). Cased, punctuated, hotword-capable; partials every ~1.3 s. The finals model.",
  },
  {
    id: "nemo-fast-conformer-en-80ms",
    url: `${RELEASE}/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8.tar.bz2`,
    sha256: "7bd33a914e93370a1ba9c2066d9e841bdcad8613fa2a00537c1ae15d851a14d8",
    bytes: 102813625,
    archiveDir: "sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8",
    language: "en",
    chunkMs: 80,
    hotwords: false,
    cased: false,
    tailPadMs: 1000,
    description: "NeMo streaming FastConformer transducer, 80 ms chunks (int8). Lowercase, greedy-only; partials every ~150 ms. The partials model.",
  },
  {
    id: "nemo-fast-conformer-en-480ms",
    url: `${RELEASE}/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8.tar.bz2`,
    sha256: "da93061cbf7b708b6b65976f70b29f519be29df750d8cdcabf98c65645930f13",
    bytes: 105913204,
    archiveDir: "sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8",
    language: "en",
    chunkMs: 480,
    hotwords: false,
    cased: false,
    tailPadMs: 1000,
    description: "NeMo streaming FastConformer transducer, 480 ms chunks (int8). Lowercase, greedy-only; partials every ~570 ms at less CPU than the 80 ms variant.",
  },
  {
    id: "nemotron-speech-en-80ms",
    url: `${RELEASE}/sherpa-onnx-nemotron-speech-streaming-en-0.6b-80ms-int8-2026-04-25.tar.bz2`,
    sha256: "caaf92069dbd1ca054f8e17cab179813bc28b4585f5c392540357ece4722333d",
    bytes: 463945379,
    archiveDir: "sherpa-onnx-nemotron-speech-streaming-en-0.6b-80ms-int8-2026-04-25",
    language: "en",
    chunkMs: 80,
    hotwords: false,
    cased: true,
    tailPadMs: 1000,
    description: "NVIDIA Nemotron-speech streaming 0.6B, 80 ms chunks (int8). Cased, punctuated, the most accurate; greedy-only and ~0.5× real-time CPU on two threads.",
  },
  {
    id: "parakeet-tdt-en-0.6b-v2",
    url: `${RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
    bytes: 482468385,
    archiveDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    language: "en",
    chunkMs: 0,
    hotwords: false,
    cased: true,
    tailPadMs: 0,
    offline: true,
    description: "NVIDIA Parakeet TDT 0.6B v2 (int8), offline. Cased, punctuated, among the most accurate English models; decodes a whole clip at once, so transcription only, no live partials.",
  },
];

export const DEFAULT_MODEL = "zipformer-en-kroko";
export const DEFAULT_PARTIAL_MODEL = "nemo-fast-conformer-en-80ms";

export function findModel(id: string): SttModel | undefined {
  return STT_MODELS.find((m) => m.id === id);
}

export function requireModel(id: string): SttModel {
  const m = findModel(id);
  if (!m) throw new Error(`unknown stt model "${id}" (known: ${STT_MODELS.map((x) => x.id).join(", ")})`);
  return m;
}

/** Shared with MiniLM (src/model-dir.ts). STT models live under `<dir>/stt/<id>/`. */
export { modelDirFromEnv } from "../model-dir.js";

export function sttModelPath(modelDir: string, id: string): string {
  return join(modelDir, "stt", id);
}

/** Pick the model files inside an extracted dir. Prefers int8 exports. */
export function pickModelFiles(entries: readonly string[]): {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
} {
  const pick = (re: RegExp) => {
    const hits = entries.filter((f) => re.test(f)).sort((a, b) => Number(b.includes("int8")) - Number(a.includes("int8")));
    if (!hits[0]) throw new Error(`model dir is missing a file matching ${re}`);
    return hits[0];
  };
  return {
    encoder: pick(/^encoder.*\.onnx$/),
    decoder: pick(/^decoder.*\.onnx$/),
    joiner: pick(/^joiner.*\.onnx$/),
    tokens: pick(/^tokens\.txt$/),
  };
}

// ── The dictation catalog: what a user picks (plans/dictation-models.md) ───

/**
 * A fixer: a small instruct model that edits a transcript against the
 * vocabulary and judges a user's edits (phase 3 of the plan). Nothing runs
 * one yet: the runtime is being chosen by the phase-1 spike, so `runtime`
 * and the files are PROVISIONAL. These are the GGUF Q4_K_M builds for
 * llama.cpp (node-llama-cpp); if the spike picks transformers.js instead,
 * the entries change to ONNX exports. Qwen publishes only Q8_0 GGUFs of
 * these sizes, so the Q4_K_M files are unsloth's, pinned to a commit; the
 * sha256 and size were verified by downloading each file.
 */
export interface FixerModel {
  id: string;
  url: string;
  /** sha256 of the file. */
  sha256: string;
  bytes: number;
  /** The file's name under the model's dir. */
  file: string;
  runtime: "llama.cpp";
  description: string;
}

const UNSLOTH = "https://huggingface.co/unsloth";

export const FIXER_MODELS: readonly FixerModel[] = [
  {
    id: "qwen3-0.6b-q4",
    url: `${UNSLOTH}/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_K_M.gguf`,
    sha256: "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a",
    bytes: 396705472,
    file: "Qwen3-0.6B-Q4_K_M.gguf",
    runtime: "llama.cpp",
    description: "Qwen3 0.6B instruct (GGUF Q4_K_M). The small fixer: fastest, least able to judge context.",
  },
  {
    id: "qwen3-1.7b-q4",
    url: `${UNSLOTH}/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_K_M.gguf`,
    sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
    bytes: 1107409472,
    file: "Qwen3-1.7B-Q4_K_M.gguf",
    runtime: "llama.cpp",
    description: "Qwen3 1.7B instruct (GGUF Q4_K_M). The larger fixer: slower, better at telling a mishearing from a rewrite.",
  },
];

export type DictationModelKind = "speech" | "fixer";

/** One pickable model: a speech model (an `STT_MODELS` entry) or a fixer. */
export interface DictationModel {
  id: string;
  kind: DictationModelKind;
  url: string;
  sha256: string;
  bytes: number;
  description: string;
  /** What runs it: sherpa streaming or offline, or the fixer's runtime. */
  runtime: "sherpa-online" | "sherpa-offline" | FixerModel["runtime"];
}

/** The speech models a user picks from, in the order shown. */
export const DICTATION_SPEECH = ["zipformer-en-kroko", "parakeet-tdt-en-0.6b-v2"] as const;

export const DICTATION_MODELS: readonly DictationModel[] = [
  ...DICTATION_SPEECH.map((id): DictationModel => {
    const m = requireModel(id);
    return { id, kind: "speech", url: m.url, sha256: m.sha256, bytes: m.bytes, description: m.description, runtime: m.offline ? "sherpa-offline" : "sherpa-online" };
  }),
  ...FIXER_MODELS.map((m): DictationModel => ({ id: m.id, kind: "fixer", url: m.url, sha256: m.sha256, bytes: m.bytes, description: m.description, runtime: m.runtime })),
];

export function findFixer(id: string): FixerModel | undefined {
  return FIXER_MODELS.find((m) => m.id === id);
}

/** Fixer models live under `<dir>/fixer/<id>/`. */
export function fixerModelPath(modelDir: string, id: string): string {
  return join(modelDir, "fixer", id);
}
