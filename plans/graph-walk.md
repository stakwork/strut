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

`modelEvaluate(model)` → an `Evaluate`: named choice / score / boolean
questions answered independently against one state, returning typed answers
with probabilities. It is one `experimental_evaluate({ model, state,
questions })` call (ai@7). `resolveEvaluationModel` (src/llm.ts) picks the model:

- **jev** (`model: jev`, `jev-<ver>`, or `typesafe/<id>`): TypeSafe's
  evaluation model via `@ai-sdk/typesafe-ai`, keyed by `TYPESAFE_AI_API_KEY`
  (secret store, then env). Non-generative: 70–500 ms, $0.042/MTok input,
  output free, calibrated probabilities (a choice answer carries
  `probabilities`, which the walk records as `next_probabilities`),
  questions evaluated in parallel, up to 255 choice options. Its own demos
  include Wikiracing — exactly this traversal shape.
- **Default** (no `model`/`provider`): jev when that key is configured,
  else the deployment's language model (`STRUT_LLM_MODEL`/`_PROVIDER`).
- **Any other name**: `resolveModel` (same aliases and key errors as the
  `llm` step) wrapped in the SDK's `EvaluationLanguageModel`
  (`@ai-sdk/provider-utils/experimental-evaluation` — the same wrapper
  behind `anthropic.evaluationModel(...)`): one structured-output call,
  the model's own estimates, no choice probabilities. Fine for ranking and
  thresholding, which is all the walk does.

The walker takes any `Evaluate`, so tests script one and never touch a
model.

Caveats: the evaluate API is experimental (may change in patch releases),
and jev's maximum state size is undocumented — the per-hop state is kept
compact (names, types, edge types, snippets) for that reason.

## Status

Implemented on this branch: `src/evaluate.ts` + `resolveEvaluationModel`
(offline tests through the real `experimental_evaluate` over a fake
evaluation model and a wrapped fake language model, plus the resolver's
routing), `graph/walk` (`runWalk` offline tests over an in-memory graph and
a scripted decider; a live case in `graph-steps.test.ts` over the real
reader), and `deriveNodeName` lifted into `_shared.ts` for the four steps
that label nodes. One live `experimental_evaluate` call through the
fallback path (haiku) returned sensible answers in ~1.4 s; jev itself has
not been called live yet (no `TYPESAFE_AI_API_KEY` in the build env), nor
has a full walk run against a real model.

Possible next steps, in order of value: run a real walk with jev on a
seeded graph and tune the three instructions; a generic "evaluate-driven
loop" step where `expand` is a registry step (like `agentTools`) so the
same walk covers files or GitHub issues.
