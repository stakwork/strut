/**
 * A STEP GRADER's run (plans/human-steps.md §7.4): what createStrut hands
 * the task store as `deps.grade`, so `tasks.ts` stays free of the runner.
 *
 * - Once, through `runSingleStep` — its own `MemoryRunStore`, its events
 *   held only until the verdict is read — never `runStep`, which keeps a run.
 * - Against an ALLOWLIST: `secrets` (model keys, bound to the principal by
 *   the runner) and `llmAuth`. No artifacts, shell, http, graph, runs or
 *   tasks, and no `onRunEnd` or `onRunEvent`, so the run is never projected,
 *   verified, written under `dataDir` or sent to the events sink.
 * - No actor; the grading principal, billed as the client's model calls are.
 * - Under a time limit, then force-cancelled through its `RunController`,
 *   and the type's cost cap as `maxCostUsd`.
 * - Its input is `{ answer, expected, show, type }`, and its config those
 *   four as sole expressions (handed over unevaluated) with the grade's own
 *   `config` over them, its templates resolved against that input.
 * - Its verdict is read in the claims check contract (`mapCheckResult`,
 *   src/verify.ts): `{ supports, content }`. Anything else throws, which the
 *   store records as `error`.
 */
import type { StepRegistry } from "../core.js";
import { RunController } from "../run-control.js";
import { runSingleStep } from "../run-step.js";
import { isSealedStep } from "../sealed.js";
import { generateRunId } from "../store.js";
import { mapCheckResult } from "../verify.js";
import type { GradeCall, GradeVerdict } from "./tasks.js";

/** Why `step` may not grade (§7.4, ruling 5), else undefined: it must be a
 *  registry step that is SEALED — by namespace or `sealed: true` on its
 *  definition — since a grader reads every expected answer. */
export function graderProblem(registry: () => StepRegistry): (step: string) => string | undefined {
  return (step) => {
    const r = registry();
    if (!r[step]) return `no step ${step} here to grade with`;
    if (!isSealedStep(step, r)) {
      return `${step} is not sealed: a grader reads every expected answer, so it must be one the AI can neither edit nor call — "equal", or a step published with sealed: true (plans/human-steps.md §7.4)`;
    }
    return undefined;
  };
}

/** The bag a grader runs against: `secrets` and `llmAuth`, nothing else. */
export function graderServices(bag: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(bag["secrets"] ? { secrets: bag["secrets"] } : {}),
    ...(bag["llmAuth"] ? { llmAuth: bag["llmAuth"] } : {}),
  };
}

export function stepGrader(o: { registry: () => StepRegistry; services: () => Record<string, unknown> }): (call: GradeCall) => Promise<GradeVerdict> {
  return async (call) => {
    const input = { answer: call.input.answer, expected: call.input.expected, show: call.input.show, type: call.input.type };
    const config: Record<string, unknown> = {};
    for (const k of Object.keys(input)) config[k] = `{{ input[${JSON.stringify(k)}] }}`;
    Object.assign(config, call.config ?? {});
    const runId = generateRunId();
    const controller = new RunController(runId, `grade:${call.step}`);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.force();
    }, call.timeoutMs);
    timer.unref?.();
    let result;
    try {
      result = await runSingleStep(call.step, o.registry(), graderServices(o.services()), {
        runId,
        input,
        config,
        controller,
        principal: call.principal,
        maxCostUsd: call.maxCostUsd,
      });
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new Error(`timeout: the grader ${call.step} ran past ${Math.round(call.timeoutMs / 1000)} s and was stopped`);
    const mapped = mapCheckResult(call.step, result);
    if (mapped.kind !== "evidence") throw new Error(mapped.reason);
    return { supports: mapped.supports, content: mapped.content };
  };
}
