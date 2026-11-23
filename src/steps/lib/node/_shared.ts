import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { nodeFilesAs, nodeFilesPackageOf, STRUT_FILES, type NodeFilesCapability } from "../../../node-files.js";

/** The node's files as a step of the calling workflow's package holds them:
 *  that package's folder (`ctx.package`), strut's outside a package. A
 *  package's step that calls this one with its own ctx holds its package's
 *  folder already (its fence), and keeps it. */
export function nodeFilesOf(ctx: StepContext<StrutCapabilities> | undefined): { files: NodeFilesCapability; package: string } {
  const cap = ctx?.services?.nodeFiles;
  const bound = nodeFilesPackageOf(cap);
  const pkg = bound && bound !== STRUT_FILES ? bound : (ctx?.package ?? STRUT_FILES);
  const files = nodeFilesAs(cap, pkg);
  if (!files) throw new Error("node_files_unavailable: this strut server keeps no files on nodes (the standard server does, under its dataDir)");
  return { files, package: pkg };
}
