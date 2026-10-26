import { join } from "node:path";
import { bootEnv } from "./host.js";
import { modelDirFromEnv } from "./host.js";

export interface PrivacyModel {
  id: string;
  task: "token-classification" | "text-generation";
  dtype: "q8" | "q4";
  approxSizeMB: number;
}

export const NER_MODEL: PrivacyModel = { id: "Xenova/bert-base-NER", task: "token-classification", dtype: "q8", approxSizeMB: 110 };
export const LLM_MODEL: PrivacyModel = { id: "onnx-community/Qwen2.5-1.5B-Instruct", task: "text-generation", dtype: "q4", approxSizeMB: 1700 };

export const PRIVACY_MODELS: Record<string, PrivacyModel> = { ner: NER_MODEL, llm: LLM_MODEL };

/** Where the privacy models are cached and whether they may be downloaded. Read
 *  from the environment on the MAIN thread and handed to the factory: the
 *  models run in worker threads, which see the environment the env scrub left
 *  (no STRUT_MODEL_DIR, no STRUT_PRIVACY_OFFLINE). */
export interface PrivacyModelOptions {
  cacheDir: string;
  /** `STRUT_PRIVACY_OFFLINE=1`: never download; a missing model fails closed. */
  offline: boolean;
}

export function privacyModelOptions(env: Record<string, string | undefined> = bootEnv()): PrivacyModelOptions {
  return { cacheDir: join(modelDirFromEnv(env), "privacy"), offline: env["STRUT_PRIVACY_OFFLINE"] === "1" };
}
