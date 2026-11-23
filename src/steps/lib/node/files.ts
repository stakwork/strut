import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { fileOut } from "../../../node-files.js";
import { nodeFilesOf } from "./_shared.js";

const EXAMPLE = `- id: pod
  type: node/files
  config:
    ref_id: "{{ input.ref_id }}"
    package: stakwork/pods`;

const fileContent = z.union([z.string(), z.object({ base64: z.string() })]);
const versionRow = z.object({
  package: z.string(),
  version: z.number(),
  at: z.string(),
  runId: z.string().optional(),
  bytes: z.number(),
  paths: z.array(z.string()),
  note: z.string().optional(),
});

/**
 * Read a node's files (plans/package-seams.md §1): one package's folder at a
 * version, or, with `list`, every kept version of every package's folder.
 * Reading is open, as a node's fields are.
 */
export default defineStep({
  type: "node/files",
  effect: "read",
  description:
    `Read the files a package keeps on a graph node: one package's folder at one version (the latest unless \`version\` names one), or with \`list: true\` every kept version of every package's folder on the node. ` +
    `\`package\` is the folder's owner, publisher/name, or "strut" for strut's own; left out, the calling workflow's package (strut's outside a package). ` +
    `A file comes back as its text, or { base64 } when it is not UTF-8. Reading is open, as a node's fields are; nothing secret is kept there. ` +
    `Output: { package, version, at, note?, files } — version null and files {} when the node holds none of that package's — or { versions: [{ package, version, at, runId?, bytes, paths, note? }] } with list.\n\n${EXAMPLE}`,
  input: z.object({
    ref_id: z.string().min(1).describe("the node's ref_id"),
    package: z.string().optional().describe('whose folder: publisher/name, or "strut"; default the calling workflow\'s package'),
    version: z.number().int().positive().optional().describe("a kept version; default the latest"),
    list: z.boolean().optional().describe("list every kept version of every package's folder instead of reading files"),
  }),
  output: z.object({
    package: z.string().optional(),
    version: z.number().nullable().optional(),
    at: z.string().optional(),
    note: z.string().optional(),
    files: z.record(z.string(), fileContent).optional(),
    versions: z.array(versionRow).optional(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { files, package: own } = nodeFilesOf(ctx);
    if (cfg.list) return { versions: await files.list(cfg.ref_id) };
    const pkg = cfg.package ?? own;
    const read = await files.read(cfg.ref_id, { package: pkg, ...(cfg.version !== undefined ? { version: cfg.version } : {}) });
    if (!read) return { package: pkg, version: null, files: {} };
    return {
      package: read.package,
      version: read.version,
      at: read.at,
      ...(read.note ? { note: read.note } : {}),
      files: Object.fromEntries(Object.entries(read.files).map(([p, b]) => [p, fileOut(b)])),
    };
  },
});
