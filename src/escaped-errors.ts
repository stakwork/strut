// Errors that ESCAPE a step: thrown inside a callback (a timer, an event
// listener, an emitter's `error` with nobody listening) or from a promise the
// step never awaits. Nothing the runner awaits sees them, and Node's default
// for both is to end the process — every run and chat in flight with it, and
// boot's auto-resume then replays the same run into the same crash until its
// cap leaves it stale.
//
// Each step's code runs inside an AsyncLocalStorage scope (`guardEscapes`):
// whatever async work it starts carries the scope, so the process-level
// handlers (`installEscapeGuard`) know which call started the work that
// failed, and fail THAT call with the error instead. Retry and onError then
// apply and the run ends as an error, like a step that threw. An error no
// step owns is logged and the process keeps serving.

import { AsyncLocalStorage } from "node:async_hooks";

interface Owner {
  /** What a log line names: `step "wf/a"`, `tool "wf/agent/003-x"`. */
  label: string;
  /** Rejects the guarded call. */
  fail(err: Error): void;
  /** The guarded call has settled: a later escape is only logged. */
  settled: boolean;
}

const owners = new AsyncLocalStorage<Owner>();

/** Run `work` so an error it lets escape fails this call: the returned
 *  promise rejects with that error (logged once, naming `label`). The work
 *  itself is left to finish or not, as a force-cancelled step is. */
export function guardEscapes<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  let reject!: (err: Error) => void;
  const escaped = new Promise<never>((_, rej) => {
    reject = rej;
  });
  const owner: Owner = {
    label,
    settled: false,
    fail(err) {
      owner.settled = true;
      reject(err);
    },
  };
  const running = owners.run(owner, async () => work());
  return Promise.race([running, escaped]).finally(() => {
    owner.settled = true;
  });
}

/** Hand an escaped error to the call that owns the work it came from.
 *  False when no guarded call does. Exported for the tests: the process
 *  handlers are its only other caller. */
export function routeEscaped(reason: unknown, kind: string): boolean {
  const owner = owners.getStore();
  if (!owner) return false;
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (owner.settled) {
    console.error(`[strut] ${owner.label}: an error escaped it after it finished (${kind}):`, err);
    return true;
  }
  console.error(`[strut] ${owner.label}: an error escaped it (${kind}) — failing it with that error:`, err);
  owner.fail(err);
  return true;
}

const INSTALLED = Symbol.for("strut.escapeGuard");

/** Listen for uncaught exceptions and unhandled rejections in this process,
 *  once, however many stores or servers call it. With a listener Node no
 *  longer exits on either: an escape a guarded step owns fails that step, and
 *  one nobody owns is logged. createStrut calls it unless `escapeGuard:
 *  false` — a host that keeps its own handlers still gets theirs called. */
export function installEscapeGuard(): void {
  const g = globalThis as { [INSTALLED]?: true };
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  process.on("uncaughtException", (err) => {
    if (!routeEscaped(err, "uncaught exception")) {
      console.error("[strut] uncaught exception outside any step — the server keeps running:", err);
    }
  });
  process.on("unhandledRejection", (reason) => {
    if (!routeEscaped(reason, "unhandled rejection")) {
      console.error("[strut] unhandled rejection outside any step — the server keeps running:", reason);
    }
  });
}
