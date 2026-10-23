/**
 * A local model in a worker thread: the embedder (graph/embeddings.ts) and
 * the dictation recognizers (audio/decoder.ts).
 *
 * onnxruntime-node and sherpa-onnx run a model synchronously (the native
 * call blocks its thread), so on the main thread every forward pass blocks
 * the event loop of the process serving requests: on swarm38, mcp's whole
 * server (2026-10-11, a tick of embedding catch-up took `GET /lab/health`
 * from 0.34 s to 1.74 s and a graph search from 0.6 s to 5.6 s). Here the
 * main thread only posts calls and receives results.
 *
 * The worker builds its object with the factory `spec` names — an export of
 * `module` taking `options` — and answers `call(method, args)` with that
 * method's result. Calls start in the order they were made, so a model whose
 * methods are synchronous (sherpa's) runs them strictly in order. The worker starts
 * on the first call, and again after it dies (its calls in flight fail); it
 * holds the process open only while it starts or a call is in flight. What
 * the object keeps (a loaded model, a recognizer's streams) lives as long as
 * the worker does.
 *
 * A worker sees the environment as the env scrub left it (src/env.ts) —
 * without STRUT_MODEL_DIR or any other strut setting — so read what the model
 * needs from the environment on the main thread and pass it in `options`.
 */
import { Worker } from "node:worker_threads";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** What builds the object inside the worker: an export of `module` that
 *  takes `options` and returns (or resolves to) it. */
export interface ModelWorkerSpec {
  module: string;
  factory: string;
  options?: unknown;
}

// Beside this file in `src/` (tsx) and in `build/` alike.
const ENTRY = new URL(`./model-worker-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

type Reply = { ready: true } | { id: number; result: unknown } | { id: number; error: string } | { error: string };

export class ModelWorker {
  private worker: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private next = 0;

  /** `label` begins every error this worker reports ("embedding worker: …"). */
  constructor(
    private readonly spec: ModelWorkerSpec,
    private readonly label = "model worker",
  ) {}

  /** Run `method` of the worker's object with `args` (copied; the buffers in
   *  `transfer` are moved instead, and unusable here afterwards). */
  async call<T>(method: string, args: unknown[] = [], transfer: Transferable[] = []): Promise<T> {
    const worker = await this.start();
    return new Promise<T>((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.ref();
      worker.postMessage({ id, method, args }, transfer as never);
    });
  }

  /** Stop the worker; calls in flight fail. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.drop(worker, new Error(`${this.label} closed`));
    await worker?.terminate();
  }

  private start(): Promise<Worker> {
    return (this.starting ??= new Promise<Worker>((resolve, reject) => {
      const worker = new Worker(ENTRY, { workerData: this.spec });
      this.worker = worker;
      const fail = (e: Error) => {
        this.drop(worker, e);
        reject(e);
      };
      worker.on("message", (m: Reply) => {
        if ("ready" in m) {
          worker.unref();
          return resolve(worker);
        }
        if (!("id" in m)) return fail(new Error(`${this.label}: ${m.error}`));
        const call = this.pending.get(m.id);
        if (!call) return;
        this.pending.delete(m.id);
        if (this.pending.size === 0) worker.unref();
        if ("error" in m) call.reject(new Error(`${this.label}: ${m.error}`));
        else call.resolve(m.result);
      });
      worker.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
      worker.on("exit", (code) => fail(new Error(`${this.label} exited with code ${code}`)));
    }));
  }

  /** Forget a worker that died or was closed: its calls in flight fail, and
   *  the next `call` starts another. */
  private drop(worker: Worker | null, e: Error): void {
    if (!worker || worker !== this.worker) return;
    this.worker = null;
    this.starting = null;
    for (const call of this.pending.values()) call.reject(e);
    this.pending.clear();
  }
}
