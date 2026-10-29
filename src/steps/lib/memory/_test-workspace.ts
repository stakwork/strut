// Tests only: memory on a fresh Ladybug workspace graph in a temp folder.
// Leading underscore: skipped by registry discovery.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { openGraphBackend, type LadybugBackend } from "../../../graph/backend.js";
import { loadLadybug } from "../../../graph/ladybug/db.js";

/** Why Ladybug cannot run here, or false. */
export const NO_LADYBUG: string | false = await loadLadybug().then(
  () => false as const,
  (e: Error) => e.message.split("\n")[0]!,
);

export type MemoryWorkspace = {
  dir: string;
  graph: LadybugBackend;
  /** A step context on this workspace; `services` adds to (or overrides) graph and dataDir. */
  ctx(services?: Record<string, unknown>): StepContext;
  close(): Promise<void>;
};

/** A workspace graph of its own under a new temp folder (its dataDir). */
export async function memoryWorkspace(prefix = "strut-memory-"): Promise<MemoryWorkspace> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const graph = (await openGraphBackend({ kind: "ladybug", path: join(dir, "graph", "graph.lbug"), namespace: "default" }, { embeddings: false, skipBoot: true })) as LadybugBackend;
  return {
    dir,
    graph,
    ctx: (services = {}) =>
      ({ runId: "test", path: "test", scope: {}, input: undefined, emit: async () => {}, services: { graph, dataDir: dir, ...services } }) as unknown as StepContext,
    async close() {
      await graph.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
