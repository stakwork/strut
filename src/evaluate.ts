// ── evaluate: typed questions against one state ─────────────────────────────
//
// The decider behind `graph/walk` (and any future "smart if-statement" inside
// a step): NAMED questions — choice / score / boolean — answered INDEPENDENTLY
// against one shared state, returning typed values with probabilities. No
// text is generated; the caller does the control flow.
//
// The contract is the AI SDK's `experimental_evaluate` (ai@7): the question
// and answer shapes below are copied from the provider spec
// (`Experimental_EvaluationModelV4Question` / `...Answer`, @ai-sdk/provider
// 4.0.17). That is deliberate — when strut moves to ai@7 the body of
// `languageModelEvaluate` becomes one call to
// `experimental_evaluate({ model, state, questions })` over an EVALUATION
// model — TypeSafe's `jev` (a non-generative decision model: 70–500 ms,
// $0.042/MTok input, calibrated probabilities, questions evaluated in
// parallel) or `anthropic.evaluationModel(...)` — and no caller changes.
// See plans/graph-walk.md.
//
// Today (ai@6 has no evaluation models): `generateObject` on an aieo-resolved
// LANGUAGE model, one object with one field per question. The probabilities
// are the model's own estimates, not calibrated — good enough to rank and
// threshold, which is all the walker does with them.
import { emptyUsage, usageFromResult, type TokenUsage } from "./pricing.js";

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
 *  walker takes any `Evaluate`, so tests script one and the ai@7 swap is
 *  a different factory, not a different walker. */
export type Evaluate = <Q extends Record<string, EvalQuestion>>(args: {
  state: EvalInput;
  questions: Q;
}) => Promise<EvaluateResult<Q>>;

// ── the generateObject backend ─────────────────────────────────────────────

/** JSON Schema for the object the language model fills in: one field per
 *  question — an enum for a choice, a bounded number for a score, and the
 *  probability of `true` for a boolean. */
export function questionsSchema(questions: Record<string, EvalQuestion>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      if (keys.length === 0) throw new Error(`evaluate: choice question "${id}" has no options`);
      properties[id] = { type: "string", enum: keys, description: "the chosen option key" };
    } else if (q.type === "score") {
      if (q.criteria.length < 2) throw new Error(`evaluate: score question "${id}" needs at least two levels`);
      const max = q.criteria.length - 1;
      properties[id] = { type: "number", minimum: 0, maximum: max, description: `score from 0 to ${max} (fractional allowed)` };
    } else {
      properties[id] = { type: "number", minimum: 0, maximum: 1, description: "probability that the answer is true, 0 to 1" };
    }
  }
  return { type: "object", properties, required: Object.keys(questions), additionalProperties: false };
}

function renderInput(v: EvalInput | null | undefined, indent = 0): string {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v, null, indent);
}

/** The prompt: the state, then every question with its criteria and the
 *  answer format it expects. Questions are answered independently. */
export function renderPrompt(state: EvalInput, questions: Record<string, EvalQuestion>): string {
  const lines = [
    "You are a decision function. Answer each QUESTION independently, judging only the STATE below.",
    "Return one JSON object with exactly one field per question id.",
    "",
    "STATE:",
    renderInput(state, 2),
    "",
    "QUESTIONS:",
  ];
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      lines.push(`- ${id} (choice): ${renderInput(q.instructions)}`);
      for (const [k, v] of Object.entries(q.criteria)) lines.push(`    ${k}: ${renderInput(v)}`);
      lines.push(`    answer with the option key, one of: ${Object.keys(q.criteria).join(", ")}`);
    } else if (q.type === "score") {
      const max = q.criteria.length - 1;
      lines.push(`- ${id} (score): ${renderInput(q.instructions)}`);
      q.criteria.forEach((c, i) => lines.push(`    ${i}: ${renderInput(c)}`));
      lines.push(`    answer with a number from 0 to ${max}; fractional values are allowed`);
    } else {
      lines.push(`- ${id} (boolean): ${renderInput(q.instructions)}`);
      if (q.criteria?.true != null) lines.push(`    true: ${renderInput(q.criteria.true)}`);
      if (q.criteria?.false != null) lines.push(`    false: ${renderInput(q.criteria.false)}`);
      lines.push("    answer with the probability that the answer is true, from 0 to 1");
    }
  }
  return lines.join("\n");
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Map the generated object back onto typed answers. The schema already
 *  validated shapes; this re-checks so a bad answer is an error, never a
 *  silent default. */
export function toAnswers<Q extends Record<string, EvalQuestion>>(
  object: Record<string, unknown>,
  questions: Q,
): EvaluateResult<Q>["answers"] {
  const out: Record<string, EvalAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const v = object[id];
    if (q.type === "choice") {
      if (typeof v !== "string" || !(v in q.criteria)) {
        throw new Error(`evaluate: answer for "${id}" is not one of ${Object.keys(q.criteria).join(", ")}: ${JSON.stringify(v)}`);
      }
      out[id] = { type: "choice", choice: v };
    } else {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`evaluate: answer for "${id}" is not a number: ${JSON.stringify(v)}`);
      }
      out[id] = q.type === "score"
        ? { type: "score", score: clamp(v, 0, q.criteria.length - 1) }
        : { type: "boolean", probability: clamp(v, 0, 1) };
    }
  }
  return out as EvaluateResult<Q>["answers"];
}

/** An `Evaluate` over an AI SDK language model (`resolveModel().model`),
 *  via `generateObject` at temperature 0. `ai` stays lazy-loaded. */
export function languageModelEvaluate(model: unknown, opts: { maxOutputTokens?: number } = {}): Evaluate {
  return async <Q extends Record<string, EvalQuestion>>({ state, questions }: { state: EvalInput; questions: Q }): Promise<EvaluateResult<Q>> => {
    if (Object.keys(questions).length === 0) return { answers: {} as EvaluateResult<Q>["answers"], usage: emptyUsage() };
    const { generateObject, jsonSchema } = await import("ai");
    const result = await generateObject({
      model: model as any,
      schema: jsonSchema(questionsSchema(questions) as any),
      prompt: renderPrompt(state, questions),
      temperature: 0,
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    });
    return { answers: toAnswers(result.object as Record<string, unknown>, questions), usage: usageFromResult(result.usage) };
  };
}
