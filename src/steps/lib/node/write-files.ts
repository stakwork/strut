import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { fileIn, NODE_FILES_KEPT, NODE_FILES_MAX_BYTES } from "../../../node-files.js";
import { nodeFilesOf } from "./_shared.js";

const EXAMPLE = `- id: save
  type: node/write-files
  config:
    ref_id: "{{ input.ref_id }}"
    files:
      compose.yml: "{{ bake.compose }}"
    note: baked`;

/**
 * Write a node's files (plans/package-seams.md §1): the calling workflow's
 * package's folder on the node, replaced whole, as its next version.
 */
export default defineStep({
  type: "node/write-files",
  effect: "write",
  description:
    `Keep files on a graph node: replace the calling workflow's package's folder on the node with \`files\` (path → text, or { base64 } for bytes), as its next version. ` +
    `A workflow writes its own package's folder alone (strut's outside a package); any step may read it with node/files. ` +
    `The last ${NODE_FILES_KEPT} versions are kept, at most ${NODE_FILES_MAX_BYTES / (1024 * 1024)} MB a version; a soft delete of the node keeps them, a delete for good removes them. Never put a secret here. ` +
    `Fails with "node_not_found: …" when the graph holds no live node of that ref_id, "node_files_too_big: …" past the limit, "node_files_bad_path: …" for a path that is not relative. ` +
    `Output: { ref_id, package, version }.\n\n${EXAMPLE}`,
  input: z.object({
    ref_id: z.string().min(1).describe("the node's ref_id"),
    files: z
      .record(z.string(), z.union([z.string(), z.object({ base64: z.string() }).strict()]))
      .describe("path in the folder → its text, or { base64 } for bytes; the whole folder, as it will be"),
    note: z.string().optional().describe("what this version is, in a few words"),
  }),
  output: z.object({ ref_id: z.string(), package: z.string(), version: z.number() }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { files, package: pkg } = nodeFilesOf(ctx);
    const { version } = await files.write(
      cfg.ref_id,
      Object.fromEntries(Object.entries(cfg.files).map(([p, v]) => [p, fileIn(v)])),
      cfg.note ? { note: cfg.note } : {},
    );
    return { ref_id: cfg.ref_id, package: pkg, version };
  },
});
