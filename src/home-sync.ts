// The workflows a home box serves to a strut that keeps a read copy of its
// memory (peel docs/always-on.md, "two normal struts"): home-pull and
// home-push, both `peer: person`. Seeded at boot only when the host turns
// them on (`createStrut({ homeSync: true })`, STRUT_HOME_SYNC=1): open, they
// hand the whole memory to any person token this strut has minted.
import { readFile } from "node:fs/promises";
import type { WorkspaceStore } from "./workspace.js";

export const HOME_CATEGORY = "home";

export const HOME_WORKFLOWS: Record<string, string> = {
  "home-pull":
    "This strut's whole memory (memory/export, inline) for a strut that keeps a read copy of it, only when it changed: " +
    "input { hash? (the content_hash the caller holds) }; output { unchanged: true, content_hash } or the export ({ data, content_hash, … }).",
  "home-push":
    "Replays what a strut that keeps a read copy of this memory changed in its copy, one input per kind: today " +
    "{ dictation? (dictation/changes-since's changes) } through dictation/apply-changes. Idempotent.",
};

export async function seedHomeWorkflows(workspace: WorkspaceStore): Promise<Array<{ name: string; version: string; changed: boolean }>> {
  const out = [];
  for (const [name, description] of Object.entries(HOME_WORKFLOWS)) {
    try {
      const text = await readFile(new URL(`./workflows/${name}.yaml`, import.meta.url), "utf-8");
      const r = await workspace.publishWorkflowByContent(name, text, description, HOME_CATEGORY, undefined, { source: "seed" });
      out.push({ name, ...r });
    } catch (err) {
      console.warn(`[home] could not seed workflow "${name}":`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
