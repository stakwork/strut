import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { questionsSchema, renderPrompt, toAnswers, languageModelEvaluate, type EvalQuestion } from "./evaluate.js";

// OFFLINE: the decider's pure parts (schema, prompt, answer mapping) plus the
// generateObject backend over a hand-rolled fake language model. The shapes
// pinned here are the AI SDK's `experimental_evaluate` contract (ai@7) — the
// reason this module exists is to swap that in later without touching callers.

const QUESTIONS = {
  next: { type: "choice", instructions: "Which node next?", criteria: { c0: "StrutStep: fetch", c1: "StrutRun: run-1", none: "stop" } },
  severity: { type: "score", instructions: "How severe?", criteria: ["cosmetic", "workaround", "blocking"] },
  relevant_c0: { type: "boolean", instructions: "Is c0 relevant?" },
} as const satisfies Record<string, EvalQuestion>;

describe("evaluate: questionsSchema", () => {
  it("one required field per question: an enum, a bounded number, a probability", () => {
    const s = questionsSchema(QUESTIONS) as any;
    assert.deepEqual(s.required, ["next", "severity", "relevant_c0"]);
    assert.equal(s.additionalProperties, false);
    assert.deepEqual(s.properties.next.enum, ["c0", "c1", "none"]);
    assert.deepEqual([s.properties.severity.type, s.properties.severity.minimum, s.properties.severity.maximum], ["number", 0, 2]);
    assert.deepEqual([s.properties.relevant_c0.type, s.properties.relevant_c0.minimum, s.properties.relevant_c0.maximum], ["number", 0, 1]);
  });

  it("refuses a choice with no options and a score with one level", () => {
    assert.throws(() => questionsSchema({ q: { type: "choice", instructions: "x", criteria: {} } }), /no options/);
    assert.throws(() => questionsSchema({ q: { type: "score", instructions: "x", criteria: ["only"] } }), /at least two/);
  });
});

describe("evaluate: renderPrompt", () => {
  it("lays out the state, then each question with its criteria and answer format", () => {
    const p = renderPrompt({ goal: "why failing", candidates: [{ id: "c0" }] }, QUESTIONS);
    assert.match(p, /STATE:\n\{\n  "goal": "why failing"/);
    assert.match(p, /- next \(choice\): Which node next\?\n    c0: StrutStep: fetch\n    c1: StrutRun: run-1\n    none: stop\n    answer with the option key, one of: c0, c1, none/);
    assert.match(p, /- severity \(score\): How severe\?\n    0: cosmetic\n    1: workaround\n    2: blocking\n    answer with a number from 0 to 2/);
    assert.match(p, /- relevant_c0 \(boolean\): Is c0 relevant\?\n    answer with the probability that the answer is true/);
  });

  it("renders a string state verbatim and only the boolean criteria that are given", () => {
    const p = renderPrompt("I was charged twice.", {
      refund: { type: "boolean", instructions: "Refund?", criteria: { true: "asks for money back", false: null } },
    });
    assert.match(p, /STATE:\nI was charged twice\.\n/);
    assert.match(p, /- refund \(boolean\): Refund\?\n    true: asks for money back\n    answer with/);
    assert.doesNotMatch(p, /false:/);
  });
});

describe("evaluate: toAnswers", () => {
  it("maps fields onto typed answers, clamping numbers into range", () => {
    const a = toAnswers({ next: "c1", severity: 2.7, relevant_c0: -0.2 }, QUESTIONS);
    assert.deepEqual(a.next, { type: "choice", choice: "c1" });
    assert.deepEqual(a.severity, { type: "score", score: 2 });
    assert.deepEqual(a.relevant_c0, { type: "boolean", probability: 0 });
  });

  it("an option outside the criteria or a non-number is an error, never a silent default", () => {
    assert.throws(() => toAnswers({ next: "c9", severity: 1, relevant_c0: 0.5 }, QUESTIONS), /"next" is not one of c0, c1, none/);
    assert.throws(() => toAnswers({ next: "c0", severity: "high", relevant_c0: 0.5 }, QUESTIONS), /"severity" is not a number/);
  });
});

describe("evaluate: languageModelEvaluate (fake language model, offline)", () => {
  /** A minimal AI SDK language model: answers every generateObject call with `object`. */
  function fakeModel(object: Record<string, unknown>, seen: { prompt: string; calls: number }) {
    return {
      specificationVersion: "v3",
      provider: "fake",
      modelId: "fake-1",
      supportedUrls: {},
      async doGenerate(opts: any) {
        seen.calls++;
        seen.prompt = (opts.prompt as any[])
          .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("")))
          .join("\n");
        return {
          content: [{ type: "text", text: JSON.stringify(object) }],
          finishReason: "stop",
          // The provider spec's (v3) nested usage; the SDK flattens it for `result.usage`.
          usage: { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } },
          warnings: [],
        };
      },
    };
  }

  it("prompts with the state + questions, and returns typed answers with usage", async () => {
    const seen = { prompt: "", calls: 0 };
    const evaluate = languageModelEvaluate(fakeModel({ next: "c0", severity: 1, relevant_c0: 0.9 }, seen));
    const r = await evaluate({ state: { goal: "g" }, questions: QUESTIONS });
    assert.equal(seen.calls, 1);
    assert.match(seen.prompt, /STATE:\n\{\n  "goal": "g"\n\}\n\nQUESTIONS:\n- next \(choice\)/);
    assert.deepEqual(r.answers, {
      next: { type: "choice", choice: "c0" },
      severity: { type: "score", score: 1 },
      relevant_c0: { type: "boolean", probability: 0.9 },
    });
    assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.totalTokens], [12, 7, 19]);
  });

  it("an out-of-range enum answer fails generation instead of being accepted", async () => {
    const seen = { prompt: "", calls: 0 };
    const evaluate = languageModelEvaluate(fakeModel({ next: "c9", severity: 1, relevant_c0: 0.9 }, seen));
    await assert.rejects(evaluate({ state: "s", questions: QUESTIONS }));
  });

  it("no questions: no model call, empty answers", async () => {
    const seen = { prompt: "", calls: 0 };
    const evaluate = languageModelEvaluate(fakeModel({}, seen));
    const r = await evaluate({ state: "s", questions: {} });
    assert.deepEqual(r.answers, {});
    assert.equal(seen.calls, 0);
  });
});
