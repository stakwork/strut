import { readFile } from "node:fs/promises";
import type { WorkspaceStore } from "./workspace.js";

/** The workflows strut ships beside the media steps (`image`), seeded at
 *  boot by content hash like `private-ask`: a seed always matches git. */
export const MEDIA_CATEGORY = "media";

export const MEDIA_WORKFLOWS: Record<string, string> = {
  "image-gen":
    "Make one image from a prompt with any image model (the `image` step) and hand the file back in `artifacts`. " +
    "Input { prompt, model? (default xai/grok-imagine-image) }; output { image (its path), model, cost (dollars), artifacts: [{ id: image, kind: image, title, path }] }.",
};

export async function seedMediaWorkflows(workspace: WorkspaceStore): Promise<Array<{ name: string; version: string; changed: boolean }>> {
  const out = [];
  for (const [name, description] of Object.entries(MEDIA_WORKFLOWS)) {
    try {
      const text = await readFile(new URL(`./workflows/${name}.yaml`, import.meta.url), "utf-8");
      const r = await workspace.publishWorkflowByContent(name, text, description, MEDIA_CATEGORY, undefined, { source: "seed" });
      out.push({ name, ...r });
    } catch (err) {
      console.warn(`[media] could not seed workflow "${name}":`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
