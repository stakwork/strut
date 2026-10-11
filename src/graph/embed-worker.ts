/**
 * The worker side of `WorkerEmbedder` (embeddings.ts): builds an `Embedder`
 * with the factory `workerData` names — an export of `module` taking
 * `options` — then answers `{ id, texts }` with `{ id, vectors }` or
 * `{ id, error }`. The first message is `{ ready: true }`, or `{ error }`
 * when the factory threw.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { Embedder } from "./node-writer.js";

const port = parentPort!;
const { module, factory, options } = workerData as { module: string; factory: string; options?: unknown };
const message = (e: unknown) => ((e as Error)?.message ?? String(e)).split("\n")[0]!;

let embedder: Embedder | undefined;
try {
  const make = ((await import(module)) as Record<string, unknown>)[factory];
  if (typeof make !== "function") throw new Error(`${module} exports no function ${factory}`);
  embedder = (await make(options)) as Embedder;
} catch (e) {
  port.postMessage({ error: message(e) });
}

if (embedder) {
  const e = embedder;
  port.on("message", async ({ id, texts }: { id: number; texts: string[] }) => {
    try {
      port.postMessage({ id, vectors: await e.embed(texts) });
    } catch (err) {
      port.postMessage({ id, error: message(err) });
    }
  });
  port.postMessage({ ready: true });
}
