/**
 * The worker side of `ModelWorker` (model-worker.ts): builds its object with
 * the factory `workerData` names — an export of `module` taking `options` —
 * then answers `{ id, method, args }` with `{ id, result }` or
 * `{ id, error }`. The first message is `{ ready: true }`, or `{ error }`
 * when the factory threw.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { ModelWorkerSpec } from "./model-worker.js";

const port = parentPort!;
const { module, factory, options } = workerData as ModelWorkerSpec;
const message = (e: unknown) => ((e as Error)?.message ?? String(e)).split("\n")[0]!;

let target: Record<string, unknown> | undefined;
try {
  const make = ((await import(module)) as Record<string, unknown>)[factory];
  if (typeof make !== "function") throw new Error(`${module} exports no function ${factory}`);
  target = (await make(options)) as Record<string, unknown>;
} catch (e) {
  port.postMessage({ error: message(e) });
}

if (target) {
  const t = target;
  port.on("message", async ({ id, method, args }: { id: number; method: string; args: unknown[] }) => {
    try {
      const fn = t[method];
      if (typeof fn !== "function") throw new Error(`no method ${method}`);
      port.postMessage({ id, result: await fn.apply(t, args) });
    } catch (err) {
      port.postMessage({ id, error: message(err) });
    }
  });
  port.postMessage({ ready: true });
}
