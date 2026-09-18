// ── evaluate: typed questions against one state ─────────────────────────────
//
// The decider behind `graph/walk` (and any future "smart if-statement" inside
// a step): NAMED questions — choice / score / boolean — answered INDEPENDENTLY
// against one shared state, returning typed values with probabilities. No
// text is generated; the caller does the control flow.
//
// This is the AI SDK's `experimental_evaluate` (ai@7) behind a narrow,
// injectable function type, so the walker can be tested with a scripted
// decider and never touches a model. Two kinds of model sit behind it
// (resolved by `resolveEvaluationModel` in llm.ts):
//
// - an EVALUATION model — TypeSafe's `jev` (`@ai-sdk/typesafe-ai`): a
//   non-generative decision model, 70–500 ms, $0.042/MTok input, output
//   free, calibrated probabilities (choice answers carry `probabilities`),
//   questions evaluated in parallel;
// - any aieo-resolved LANGUAGE model wrapped in the SDK's
//   `EvaluationLanguageModel` (structured output at the model's own
//   estimate — fine for ranking and thresholding, which is all the walker
//   does; no choice `probabilities`).
//
// See plans/graph-walk.md.
import type { TokenUsage } from "./pricing.js";

/** What a question (or the state) can be made of: text or JSON. */
export type EvalInput = string | Readonly<Record<string, unknown>> | readonly unknown[];

export type EvalQuestion =
  | {
      type: "choice";
      instructions: EvalInput;
      /** option key → description (null: no description). */
      criteria: Readonly<Record<string, EvalInput | null>>;
    }
  | {
      type: "score";
      instructions: EvalInput;
      /** Ordered level descriptions; the answer is a number in [0, length-1]. */
      criteria: readonly (EvalInput | null)[];
    }
  | {
      type: "boolean";
      instructions: EvalInput;
      criteria?: { true?: EvalInput | null; false?: EvalInput | null };
    };

export type EvalAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number };

type AnswerFor<Q extends EvalQuestion> = Extract<EvalAnswer, { type: Q["type"] }>;

export interface EvaluateResult<Q extends Record<string, EvalQuestion>> {
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: TokenUsage;
}

/** One call answering every question against the state. Injectable: the
 *  walker takes any `Evaluate`, so tests script one. */
export type Evaluate = <Q extends Record<string, EvalQuestion>>(args: {
  state: EvalInput;
  questions: Q;
}) => Promise<EvaluateResult<Q>>;

// ── the backend: experimental_evaluate ────────────────────────────────────

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Evaluation usage (flat input/output counts) as strut's TokenUsage. */
export function usageFromEvaluation(u: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): TokenUsage {
  const inputTokens = num(u?.inputTokens);
  const outputTokens = num(u?.outputTokens);
  return { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens, totalTokens: num(u?.totalTokens) || inputTokens + outputTokens };
}

/** An `Evaluate` over an AI SDK evaluation model (`resolveEvaluationModel().model`),
 *  via `experimental_evaluate`. `ai` stays lazy-loaded. */
export function modelEvaluate(model: unknown, opts: { abortSignal?: AbortSignal } = {}): Evaluate {
  return async <Q extends Record<string, EvalQuestion>>({ state, questions }: { state: EvalInput; questions: Q }): Promise<EvaluateResult<Q>> => {
    if (Object.keys(questions).length === 0) return { answers: {} as EvaluateResult<Q>["answers"], usage: usageFromEvaluation(undefined) };
    const { experimental_evaluate, InvalidResponseDataError } = await import("ai");
    try {
      const result = await experimental_evaluate({
        model: model as any,
        state: state as any,
        questions: questions as any,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      });
      return { answers: result.answers as EvaluateResult<Q>["answers"], usage: usageFromEvaluation(result.usage) };
    } catch (e) {
      // jev's choice is not always the argmax of its (rounded) probabilities
      // on near-ties across many options (seen live: choice f2 @0.12 beside
      // f3 @0.13), and the SDK rejects the whole answer set. Every answer is
      // otherwise valid, so keep them and the model's own choice. Usage is
      // not on the error, so this call counts as zero.
      if (InvalidResponseDataError.isInstance(e) && /did not select a highest-probability option/.test(e.message) && e.data && typeof e.data === "object") {
        return { answers: e.data as EvaluateResult<Q>["answers"], usage: usageFromEvaluation(undefined) };
      }
      throw e;
    }
  };
}
