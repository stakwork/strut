import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelEvaluate, usageFromEvaluation, type EvalQuestion } from "./evaluate.js";
import { resolveEvaluationModel, TYPESAFE_KEY_NAME } from "./llm.js";

// OFFLINE: `modelEvaluate` through the real `experimental_evaluate` over two
// hand-rolled models — an evaluation model (jev's shape: answers with
// probabilities) and a language model wrapped in the SDK's
// EvaluationLanguageModel (the fallback path) — plus the resolver's routing.

const QUESTIONS = {
  next: { type: "choice", instructions: "Which node next?", criteria: { c0: "StrutStep: fetch", c1: "StrutRun: run-1", none: "stop" } },
  severity: { type: "score", instructions: "How severe?", criteria: ["cosmetic", "workaround", "blocking"] },
  relevant_c0: { type: "boolean", instructions: "Is c0 relevant?" },
} as const satisfies Record<string, EvalQuestion>;

/** A minimal V4 evaluation model answering every call with `answers`. */
function fakeEvaluationModel(answers: Record<string, unknown>, seen: { calls: number; state?: unknown; questions?: unknown }) {
  return {
    specificationVersion: "v4",
    provider: "fake.evaluation",
    modelId: "fake-eval-1",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    async doEvaluate(opts: any) {
      seen.calls++;
      seen.state = opts.state;
      seen.questions = opts.questions;
      return { answers, usage: { inputTokens: 40, outputTokens: 0 }, warnings: [] };
    },
  };
}

/** A minimal V4 language model answering every doGenerate with `object` as JSON text. */
function fakeLanguageModel(object: Record<string, unknown>, seen: { calls: number; prompt?: string }) {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-1",
    supportedUrls: {},
    async doGenerate(opts: any) {
      seen.calls++;
      seen.prompt = JSON.stringify(opts.prompt);
      return {
        content: [{ type: "text", text: JSON.stringify(object) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } },
        warnings: [],
      };
    },
  };
}

describe("evaluate: modelEvaluate over an evaluation model", () => {
  it("passes state + questions through and returns typed answers with probabilities", async () => {
    const seen: { calls: number; state?: unknown; questions?: unknown } = { calls: 0 };
    const evaluate = modelEvaluate(fakeEvaluationModel({
      next: { type: "choice", choice: "c1", probabilities: { c0: 0.2, c1: 0.7, none: 0.1 } },
      severity: { type: "score", score: 1.4 },
      relevant_c0: { type: "boolean", probability: 0.9 },
    }, seen));
    const r = await evaluate({ state: { goal: "g" }, questions: QUESTIONS });
    assert.equal(seen.calls, 1);
    assert.deepEqual(seen.state, { goal: "g" });
    assert.deepEqual(Object.keys(seen.questions as object), ["next", "severity", "relevant_c0"]);
    assert.deepEqual(r.answers.next, { type: "choice", choice: "c1", probabilities: { c0: 0.2, c1: 0.7, none: 0.1 } });
    assert.deepEqual(r.answers.severity, { type: "score", score: 1.4 });
    assert.deepEqual(r.answers.relevant_c0, { type: "boolean", probability: 0.9 });
    assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.totalTokens], [40, 0, 40]);
  });

  it("a choice outside the criteria is rejected by the SDK, never accepted", async () => {
    const evaluate = modelEvaluate(fakeEvaluationModel({
      next: { type: "choice", choice: "c9" },
      severity: { type: "score", score: 1 },
      relevant_c0: { type: "boolean", probability: 0.5 },
    }, { calls: 0 }));
    await assert.rejects(evaluate({ state: "s", questions: QUESTIONS }));
  });

  it("a choice that is not the argmax (jev on a near-tie) is kept as the model chose it, usage zero", async () => {
    const evaluate = modelEvaluate(fakeEvaluationModel({
      next: { type: "choice", choice: "c0", probabilities: { c0: 0.45, c1: 0.47, none: 0.08 } },
      severity: { type: "score", score: 1 },
      relevant_c0: { type: "boolean", probability: 0.5 },
    }, { calls: 0 }));
    const r = await evaluate({ state: "s", questions: QUESTIONS });
    assert.equal(r.answers.next.choice, "c0");
    assert.equal(r.answers.relevant_c0.probability, 0.5);
    assert.equal(r.usage.totalTokens, 0);
  });

  it("no questions: no model call, empty answers", async () => {
    const seen = { calls: 0 };
    const r = await modelEvaluate(fakeEvaluationModel({}, seen))({ state: "s", questions: {} });
    assert.deepEqual(r.answers, {});
    assert.equal(seen.calls, 0);
  });
});

describe("evaluate: modelEvaluate over a wrapped language model (the fallback)", () => {
  it("one structured-output call; option codes map back to the criteria keys", async () => {
    const { Experimental_EvaluationLanguageModel } = await import("@ai-sdk/provider-utils/experimental-evaluation");
    const seen: { calls: number; prompt?: string } = { calls: 0 };
    // The wrapper numbers questions q0.. and choice options c0.. in order.
    const lm = fakeLanguageModel({ q0: "c2", q1: 2, q2: 0.25 }, seen);
    const evaluate = modelEvaluate(new Experimental_EvaluationLanguageModel({ model: lm as any }));
    const r = await evaluate({ state: { goal: "why failing" }, questions: QUESTIONS });
    assert.equal(seen.calls, 1);
    assert.match(seen.prompt!, /why failing/);
    assert.deepEqual(r.answers.next, { type: "choice", choice: "none" });
    assert.deepEqual(r.answers.severity, { type: "score", score: 2 });
    assert.deepEqual(r.answers.relevant_c0, { type: "boolean", probability: 0.25 });
    assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.totalTokens], [12, 7, 19]);
  });
});

describe("evaluate: usageFromEvaluation", () => {
  it("flat counts, total derived when absent, missing → zeros", () => {
    assert.deepEqual(usageFromEvaluation({ inputTokens: 5, outputTokens: 2 }), { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, totalTokens: 7 });
    assert.equal(usageFromEvaluation(undefined).totalTokens, 0);
  });
});

describe("resolveEvaluationModel: routing", () => {
  const secretsWith = (vals: Record<string, string>) => ({ get: async (k: string) => vals[k] });
  const withoutEnvKey = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = process.env[TYPESAFE_KEY_NAME];
    delete process.env[TYPESAFE_KEY_NAME];
    try { return await fn(); } finally { if (saved !== undefined) process.env[TYPESAFE_KEY_NAME] = saved; }
  };

  it("'jev' resolves to typesafe/jev-latest with the key from secrets", async () => {
    const r = await withoutEnvKey(() => resolveEvaluationModel({ model: "jev", secrets: secretsWith({ [TYPESAFE_KEY_NAME]: "k" }) }));
    assert.equal(r.name, "typesafe/jev-latest");
    assert.equal(r.model.specificationVersion, "v4");
    assert.equal(typeof r.model.doEvaluate, "function");
  });

  it("'typesafe/<id>' keeps the id", async () => {
    const r = await withoutEnvKey(() => resolveEvaluationModel({ model: "typesafe/jev-2", secrets: secretsWith({ [TYPESAFE_KEY_NAME]: "k" }) }));
    assert.equal(r.name, "typesafe/jev-2");
  });

  it("'jev' without a key is an error naming the key", async () => {
    await withoutEnvKey(() => assert.rejects(resolveEvaluationModel({ model: "jev", secrets: secretsWith({}) }), new RegExp(TYPESAFE_KEY_NAME)));
  });

  it("no model named: jev when the key is configured", async () => {
    const r = await withoutEnvKey(() => resolveEvaluationModel({ secrets: secretsWith({ [TYPESAFE_KEY_NAME]: "k" }), fallback: { model: "haiku" } }));
    assert.equal(r.name, "typesafe/jev-latest");
  });

  it("no model named and no jev key: the fallback language model, wrapped", async () => {
    const r = await withoutEnvKey(() => resolveEvaluationModel({ secrets: secretsWith({ ANTHROPIC_API_KEY: "k" }), fallback: { model: "haiku" } }));
    assert.match(r.name, /^anthropic\/claude-haiku/);
    assert.equal(r.model.provider, "anthropic.evaluation");
  });

  it("a named language model wins over a configured jev key", async () => {
    const r = await resolveEvaluationModel({ model: "haiku", secrets: secretsWith({ [TYPESAFE_KEY_NAME]: "k", ANTHROPIC_API_KEY: "k" }) });
    assert.match(r.name, /^anthropic\/claude-haiku/);
  });
});
