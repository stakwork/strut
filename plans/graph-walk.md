# graph/walk — gathering context by walking the graph, with a decision model

## The idea

An agent that "explores the graph" with `graph/graph-neighbors` as a tool
spends a generative turn per hop: slow, expensive, and the model has to
carry the whole traversal in its context. But a walk has only three
decisions per hop, and none of them needs generated text:

- is this neighbor relevant to the goal (keep it or not),
- which node is worth expanding next,
- is what we have gathered enough.

So the walk is **code** (`src/steps/lib/graph/walk.ts`, `runWalk`) and a
**decision model** answers those as typed questions — the same split strut
already uses for timestamps: traversal and bookkeeping in code, judgment
in a model, synthesis in an `llm`/`agent` step afterwards. Each hop:

1. fetch one node's neighbors (the `graph/graph-neighbors` call, importance
   sorted, capped at 50, same excluded types);
2. ONE decider call over a compact state — goal, what's gathered (name,
   type, snippet), the node just expanded, the new candidates (type, name,
   edge + direction, connection counts, snippet), the frontier's best — asking
   `relevant_c<i>` (boolean, per candidate), `next` (choice over candidates +
   frontier + `none`), `sufficient` (boolean);
3. keep candidates at/above `threshold`, push everything discovered onto
   the frontier (a hub can be worth expanding without being worth keeping),
   stop on `sufficient ≥ 0.5`, `maxNodes`, `none`, `maxHops`, or an empty
   frontier; else expand `next`.

Output: `{ goal, nodes (kept, most relevant first, with via + clipped
properties), hops (the trace), stopped, usage }`, provenance-marked with the
expanded + kept nodes.

**Every hop is a pair of nested run events** (`<path>/NNN-hop`, stepType
`walk:hop`, `iteration` = hop), shaped as deltas a viewer can fold:

- `step.start.input` — the subgraph this hop discovered: `expanded` (the
  node whose neighbors these are), `candidates` (ref_id, type, name, and
  `via` = the edge each arrived by: from, edge_type, direction), and the
  `frontier` under consideration (ref_id, relevance).
- `step.end.output` — the hop record: `verdicts` (ref_id, relevance, kept)
  for every candidate, `next`, `next_probabilities` (ref_id → probability,
  present once the decider is an evaluation model), `sufficient`; plus the
  provenance `nodes` it read.

Nothing else is needed for a live force-graph: the run's SSE tail
(`GET …/runs/:runId/stream`, replay-then-follow, 250 ms poll) already
delivers every nested event as it is appended, and the same events replay a
finished walk from the log. A frontend would filter `stepType === "walk:hop"`
under one step path (the `EvolveChart` pattern) and light nodes up on start
(discovered) and end (kept by relevance, expanded, next).

## The decider: `src/evaluate.ts`

`evaluate({ state, questions })` — named choice / score / boolean questions
answered independently against one state, returning typed answers with
probabilities. The question and answer shapes are copied from the AI SDK's
`experimental_evaluate` contract (ai@7, provider spec
`Experimental_EvaluationModelV4Question/Answer`) on purpose:

- **Today** (strut is on ai@6, which has no evaluation models):
  `languageModelEvaluate(model)` runs `generateObject` on an aieo-resolved
  language model at temperature 0, one object with a field per question.
  Probabilities are the model's estimates, not calibrated — fine for
  ranking and thresholding, which is all the walk does with them. A small
  fast model (`haiku`) is the intended default.
- **Later** (ai@7): the body becomes one `experimental_evaluate({ model,
  state, questions })` call over an EVALUATION model — TypeSafe's `jev`
  (`@ai-sdk/typesafe-ai`, `TYPESAFE_AI_API_KEY`; a non-generative decision
  model: 70–500 ms, $0.042/MTok input, output free, calibrated
  probabilities, questions evaluated in parallel, up to 255 choice options;
  its own demos include Wikiracing, i.e. exactly this traversal shape) or
  `anthropic.evaluationModel('claude-haiku-4-5-20251001')` when no new
  vendor is wanted. No walker or caller changes.

The walker takes any `Evaluate`, so tests script one and never touch a
model.

## Prerequisites for the swap (not done here)

- **AI SDK 7.** `experimental_evaluate` exists only in `ai@7`. aieo pins
  `ai@6.0.x` and the 3.x providers, and ai@7 speaks the V4 model spec while
  those providers speak V3 — so the bump lands in aieo first, then strut.
  Strut's side touches the agent step (`system` → `instructions`,
  `onStepFinish` → `onStepEnd`, usage accumulates across steps,
  `prepareStep` instructions carry forward) and needs Node 22+.
- **An evaluation-model resolver.** aieo resolves language models only;
  the evaluation model needs the same key-through-secrets treatment
  (`TYPESAFE_AI_API_KEY`, else the anthropic key).
- The evaluate API is marked experimental (may change in patch releases)
  and jev's maximum state size is undocumented — the per-hop state is kept
  compact (names, types, edge types, snippets) for that reason.

## Status

Implemented on this branch: `src/evaluate.ts` (+ offline tests, including
the generateObject backend over a fake language model), `graph/walk`
(`runWalk` offline tests over an in-memory graph and a scripted decider;
a live case in `graph-steps.test.ts` over the real reader), and
`deriveNodeName` lifted into `_shared.ts` for the four steps that label
nodes. Not yet exercised end to end with a real model: `run()` wires
`resolveModel` + `languageModelEvaluate` exactly as the `llm` step does, but
this branch was built without a provider key in the environment.

Possible next steps, in order of value: run a real walk on a seeded graph
and tune the three instructions; a generic "evaluate-driven loop" step
where `expand` is a registry step (like `agentTools`) so the same walk
covers files or GitHub issues; the ai@7 + jev swap above.
