/**
 * A PUBLIC CALL (plans/paid-runs.md §6, work item 6; src/public-tools.ts):
 * the dynamic scope a stranger's call of a runnable step runs in.
 *
 * Many lib steps answer a failure as TEXT — what a model reads as the
 * tool's answer and carries on from (`graph/*`'s `errText`, the `sheets/*`
 * API errors). A public call is charged by how it ended: an answer is
 * charged by the rule, a failure its cost and no base (decision 24). So a
 * step reports such a failure through `stepFailed(text)`: the text as
 * before, and inside a public call a throw, which the runner records as
 * the step's error. Scoped with AsyncLocalStorage, so nothing is threaded
 * through a step's `ctx` and every call site stays `return stepFailed(…)`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<true>();

/** Run `fn` as a public call: `stepFailed` throws inside it. */
export function asPublicCall<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run(true, fn);
}

/** Is this code running inside a public call? */
export function inPublicCall(): boolean {
  return scope.getStore() === true;
}

/** A failure a step answered as text, thrown inside a public call. */
export class StepFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFailure";
  }
}

/** A step's failure as text: returned as it is, or thrown as a
 *  `StepFailure` inside a public call (its message the same text). */
export function stepFailed(text: string): string {
  if (inPublicCall()) throw new StepFailure(text);
  return text;
}
