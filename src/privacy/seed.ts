import { readFile } from "node:fs/promises";
import type { WorkspaceStore } from "../workspace.js";

/** The workflow strut ships beside the privacy/* steps, seeded at boot like the browser ones. */
export const PRIVACY_CATEGORY = "privacy";

export const PRIVACY_WORKFLOWS: Record<string, string> = {
  "private-ask":
    "Ask a hosted model about a text without sending it the personal data in it: privacy/anonymize → llm (sees only the masked text) → privacy/deanonymize. Pseudonymization, not anonymization (see specs/PRIVACY_SPEC.md); run files record `prompt` and `answer` in plaintext. " +
    "Input { prompt (the FINAL transcript), model?, system?, vault? (memory | file), ttl_minutes?, deny?, allow? }; output { answer, handle? (file vaults only), report: { counts, entities, warnings, restored, unknown_pseudonyms } }.",
};

export async function seedPrivacyWorkflows(workspace: WorkspaceStore): Promise<Array<{ name: string; version: string; changed: boolean }>> {
  const out = [];
  for (const [name, description] of Object.entries(PRIVACY_WORKFLOWS)) {
    try {
      const text = await readFile(new URL(`../workflows/${name}.yaml`, import.meta.url), "utf-8");
      const r = await workspace.publishWorkflowByContent(name, text, description, PRIVACY_CATEGORY, undefined, { source: "seed" });
      out.push({ name, ...r });
    } catch (err) {
      console.warn(`[privacy] could not seed workflow "${name}":`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
