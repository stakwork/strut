export interface PrivacyModel {
  id: string;
  task: "token-classification" | "text-generation";
  dtype: "q8" | "q4";
  approxSizeMB: number;
}

export const NER_MODEL: PrivacyModel = { id: "Xenova/bert-base-NER", task: "token-classification", dtype: "q8", approxSizeMB: 110 };
export const LLM_MODEL: PrivacyModel = { id: "onnx-community/Qwen2.5-1.5B-Instruct", task: "text-generation", dtype: "q4", approxSizeMB: 1700 };

export const PRIVACY_MODELS: Record<string, PrivacyModel> = { ner: NER_MODEL, llm: LLM_MODEL };
