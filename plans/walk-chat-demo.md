# Walk in chat — a `graph_walk` chat tool with a live walk graph

## The demo

The user opens the chat flyout and asks "does youtube-clip work?". The
assistant calls `graph_walk`. Its tool chip turns into a small force graph
that fills in hop by hop: seeds appear, the expanded node pulses, and
neighbors fly in along the edge they arrived by. Kept nodes turn solid and
dropped ones fade. Merged Evidence shows as one node with a `+9` badge, and
refuting evidence is red. When the walk ends, the assistant answers from the
bundle: the failed run, the claim it breaks, the evidence on each side, and a
verdict. Clicking a node shows its details, and a StrutRun node opens that
run.

Out of scope: a `show` tool that drives the UI (opening claims, steps and
runs as the answer narrates). That was considered and set aside as too much
for a first demo. §7 notes how it would fit on top of this plan.

Background: `plans/graph-walk.md` covers the walk itself (`runWalk`, the
decider, the per-hop event shapes). This plan does not change how the walk
decides, apart from the stop rule in §1.

## 0. What exists (read these first)

- **The walk** is in `src/steps/lib/graph/walk.ts`. `runWalk(cfg, { reader,
  evaluate, ctx })` emits two events per hop through `ctx.emit`:
  - `step.start` has `stepType: "walk:hop"` and `iteration` = the hop number.
    Its `input` is `{ hop, expanded, candidates[{ref_id, node_type, name, via,
    merged_into?}], frontier[{ref_id, relevance}] }`.
  - `step.end` has `output` = the `HopRecord`: `{ verdicts[{ref_id,
    relevance, kept}], kept, next, next_probabilities?, sufficient }`.

  `run()` shows how to wire the reader (`graphCtx`) and the decider
  (`resolveEvaluationModel` → `modelEvaluate`).
- **The chat server** is `launchChatTurn` in `src/createStrut.ts` (around
  line 1601). A `ToolLoopAgent` runs there, and `for await (const part of
  result.stream)` (around line 1758) maps stream parts to chat events:
  - `tool-call` → `tool-input`
  - `tool-result` → `tool-output`
  - `tool-error` → `tool-output` with `isError`

  Events go to the chat's event log. `GET /chat/:id/stream` tails that log,
  so a reloaded chat replays everything.
- **The chat tools** are built by `buildTools` in `src/ai/tools.ts`, a
  hand-written list. `graph_query` (around line 857) is the model for a tool
  that only exists when `deps.graph` is set. The chat prompt is in
  `src/ai/prompts.ts`.
- **The chat client** is `web/src/components/ChatFlyout.tsx`. Every tool call
  renders as the same chip (around lines 696–735): name, status dot, input
  JSON, and `ToolResultView`. The only tool-specific behavior is navigation
  (`create_workflow` → `onWorkflowCreated`, `run_workflow` → `onWorkflowRan`,
  around lines 435 and 460). The chat's event types (`text-delta`,
  `tool-input`, `tool-output`, `step.finish`, `chat.end`, `chat.error`) are
  typed in `web/src/api.ts` (`ChatEvent`, around line 599) and dispatched at
  around lines 720–745.
- **The web UI** uses Preact and Vite. Its only dependencies are
  codemirror, diff, js-yaml, preact, react-diff-view and system-canvas. There
  is no d3.
- **The force graph to borrow** is in hive (`/Users/evan/code/sphinx/hive`):
  - `src/components/graph/GraphVisualization.tsx` (120 lines): a d3 force
    simulation (link distance 120, charge −300, center, collide 30), zoom
    that keeps the previous transform, and drag.
  - `src/components/graph/graphUtils.ts` (313 lines): `createNodeElements`,
    links, labels, and the type → color map.
  - `src/components/graph-explorer/Graph2DView.tsx`: sizes the SVG with a
    ResizeObserver and skips the 0×0 pass while a tab is hidden. Copy this.
  - `src/components/graph-explorer/walkGraph.ts`: `mergeRawGraph`, which
    grows a graph without reordering it.

## 1. Plateau stop — DONE

Done on this branch: `runWalk` stops with `stopped: "plateau"` after
`PLATEAU_HOPS = 3` hops in a row that kept nothing at relevance ≥
`PLATEAU_AT = 0.85`. It is in `WalkOutput["stopped"]` and the step
description, and `walk.test.ts` covers the stop and the reset.

What tuning found: on the live graph (2026-09-18, `youtube-clip`), jev's
`sufficient` score stayed between 0.58 and 0.72, below `SUFFICIENT_AT =
0.8`, so both walks ran all 12 hops. Replaying their hop records showed
those hops were not wasted: Claims were still being kept at hops 7, 8 and
11. Stopping after 2 flat hops, or with a 0.9 bar, would have stopped early
but cut 3–4 of the 5 Claims. So at 0.85 and 3 hops, the plateau stop does
not fire on those walks. It is a guard against walks that really do stall,
not a fix for `sufficient`.

Still open for the demo: a live graph that ends on `hops` is fine (12 hops
≈ 2 s, played back at about 400 ms each). If a clean "sufficient" ending
matters, look at the `sufficient` question: its instructions, or asking it
per claim ("is each claim's status explained?"). Lowering `SUFFICIENT_AT`
is not the fix: at 0.7, walk 1 would have stopped at hop 4 with one Claim.

## 2. Server: the `graph_walk` chat tool

In `src/ai/tools.ts`, next to `graph_query` and gated on `deps.graph` in the
same way:

- **Input:** `{ goal, query?, start?, maxHops?, maxNodes?, model? }`, a
  subset of the step's schema. Import the step's Zod fields rather than
  redefining them.
- **Description:** use it to answer questions about how a workflow or step
  behaves, whether it works, what its claims and evidence say, or why runs
  fail. Set `goal` to the user's question, and set `query` to the workflow or
  step name.
- **`execute` is an async generator** (supported in `ai` 7.0.106: each
  `yield` streams as a `tool-result` with `preliminary: true`, and the last
  yield is the final result). `runWalk` reports hops through a callback
  (`ctx.emit`), so bridge that callback to the generator:
  1. Start `runWalk` with a `ctx` whose `emit` pushes each `walk:hop` event
     onto a small queue. Give the ctx a `path` so emit is enabled.
  2. Loop: await the next event (or the walk's end) and yield
     `{ status: "walking", event }`.
  3. Finally yield `{ status: "done", result }`.

  Yield one event at a time, not the accumulated state. That keeps the chat
  log small, and the client folds the events itself (§3).
- **The decider** is resolved the way `graph/walk`'s `run()` resolves it:
  jev when `TYPESAFE_AI_API_KEY` is set, otherwise the deployment's language
  model. Pass the chat's secrets. Pass the turn's `abortSignal` through, so
  cancelling the chat stops the walk.
- **What the model sees:** the model should not read `hops` or the
  per-candidate verdicts. Use the tool's `toModelOutput`, or strip the final
  result, so the model gets only `{ goal, stopped, nodes }`, with each node's
  `properties` clipped and its `merged` list. Check how v7 handles
  preliminary results in the model's messages: only the final result should
  reach them.
- **Server stream mapping** in `createStrut.ts`: in the `tool-result`
  case, emit a preliminary part (`part.preliminary === true`) as a new event,
  `{ type: "tool-progress", toolName, toolCallId, output }`. Keep emitting the
  final part as `tool-output`. Check that `chatStore.appendMessages`
  persists only the final result.
- **Prompt:** add one line to `src/ai/prompts.ts`: for "does X work / why
  does X fail / what do its claims say", call `graph_walk` before answering,
  and cite the node names it returns.

Tests (`src/chat-endpoints.test.ts` or a new `src/ai/tools.test.ts` case):
- Build the tool over a fake reader and a scripted `Evaluate`. Refactor so
  the tool can take an injected `evaluate` the way `runWalk` does.
- Check that it yields one `walking` per hop event and then one `done`, and
  that the model-facing output has no `hops`.
- Check that a preliminary `tool-result` becomes a `tool-progress` chat
  event.
- New test files must be added to the explicit list in the root
  `package.json` `test` script.

## 3. Client: fold the hop events into a walk graph

- In `web/src/api.ts`, add `tool-progress` to `ChatEvent` and dispatch it.
- **Fold function** (pure, in something like `web/src/walk-graph.ts`, with
  tests in `web/src/walk-graph.test.ts` added to the root `test` script):
  `foldWalk(events) → { nodes: Map<ref_id, WalkNode>, edges: WalkEdge[],
  current?, next?, hop, done }`.
  - A `step.start` adds its `candidates` as `discovered` nodes, each with an
    edge from `via.from` (a seed has no edge). A candidate with
    `merged_into` adds no node: it increments the group's `mergedCount`.
    `expanded` becomes `current`.
  - A `step.end` applies the `verdicts`: `relevance`, and `kept` or
    `dropped`. It also records `next`.
  - Refuting Evidence can be recognized from its name (`refutes (…): …`, the
    label `labelEvidence` builds) or from `via.properties.strength < 0`. Use
    the edge property where there is one and the name otherwise.
  - Node order is insertion order and never reorders (hive's
    `mergeRawGraph` note explains why).
- **In `ChatFlyout.tsx`:** keep each call's progress events next to
  `tc.result`. When `toolName === "graph_walk"`, render `<WalkView>` instead of
  the JSON chip. It opens by default, shows a header line (`hop 6 · 14 kept
  · walking…` / `stopped: plateau`), and puts the raw result behind the
  existing `ToolResultView` toggle.
- **Pacing:** a live walk takes about 2 s, which is too fast to follow.
  `WalkView` plays hops from a queue at roughly 400 ms each, and the answer
  text below it can stream in the meantime. A walk loaded from history
  (`GET /chat/:id` replay) renders its final state at once, with a small
  "replay" button.

## 4. Client: the force graph (ported from hive)

- **Dependencies:** add `d3-force`, `d3-selection`, `d3-zoom`, `d3-drag`
  and their `@types` to `web/package.json`, not the whole `d3`. Use the
  latest versions.
- **Port** `GraphVisualization.tsx` and the parts of `graphUtils.ts` it
  needs into something like `web/src/components/WalkGraph.tsx`, using
  `preact/hooks` (no `preact/compat` needed). Copy `Graph2DView`'s
  ResizeObserver sizing.
- **Do not copy:** hive's `"use client"`, Tailwind classes, `@/` imports,
  the legal node icons and `GRAPH_EXPLORER_COLORS`.
- **The one important change from hive:** its effect rebuilds the whole
  simulation on every data change and keeps only the zoom transform, so
  every hop would re-scatter the layout. Instead, keep one simulation for the
  component's lifetime and keep the d3 node objects in a `Map` by
  `ref_id`. On a new hop:
  - reuse the existing objects so their `x/y/vx/vy` survive;
  - place new nodes at their `via.from` parent's position (plus jitter);
  - call `simulation.nodes(all)`, update the link force, then
    `alpha(0.3).restart()`;
  - use d3's enter/update/exit join so existing SVG elements are updated
    rather than recreated.
- **Visual states:**

  | State | Look |
  |---|---|
  | discovered | outline |
  | kept | fill in the node-type color |
  | dropped | faded, 30% opacity |
  | current | pulse ring |
  | next | dashed ring |
  | refuting Evidence | red |
  | merged group | `+N` badge |

  Size nodes by `relevance`. Label only kept nodes, plus the hovered one.
  Edge labels (the edge type) show on hover.
- **Colors:** node-type colors are CSS custom properties in the web app's
  existing stylesheet (`web/src/styles`), with light and dark values like
  the rest of the UI. Use a small fixed map: StrutWorkflow,
  StrutWorkflowVersion, StrutRun, StrutStep/StrutStepVersion, Claim, Check,
  Evidence, and a fallback.
- **Size:** the chip is as wide as the flyout. A graph about 280 px tall is
  enough for about 25 kept nodes. Zoom and drag stay on, and there's a
  "fit" button.
- **Click:** selecting a node shows a small detail row under the graph:
  type, name, relevance, the edge it came by, and the merged members. For a
  StrutRun, a link calls the existing `onOpenRun` (the `onWorkflowRan` path)
  with that run's workflow and run id. This is the only navigation; see §7
  for the rest.

## 5. Order of work

1. ~~§1: the plateau stop~~ — done.
2. §2: the `graph_walk` tool, the `tool-progress` event, and their tests.
   Check it with `curl` on `/chat` and the stream endpoint before building
   any UI.
3. §3: the fold function and its tests; at first, `WalkView` can render the
   folded state as a plain list.
4. §4: the force graph, the pacing, and the visual states.
5. Try the demo script (below) in the browser pane, in dark and light
   themes, and fix any layout issues. The flyout is narrow.

## 6. Demo script

Run it against the local graph, where `youtube-clip` has a failed run and
refuting evidence:

1. Open the chat and ask "Does the youtube-clip workflow work? What do its
   claims say?"
2. The graph fills in over about 12 hops: workflow version → failed run →
   the refuting "quote not in transcript" evidence → its claim → checks. On
   this graph it ends on `hops` (see §1); the playback makes that fine.
3. The answer names the claims, what supports or refutes each one, and the
   failed run.
4. Click the failed StrutRun node; the run opens.

The walk seeds from a graph search on the workflow name, so it needs the
graph backend and a projected workspace. Seed a different machine with
`scripts/graph-restore` from a `scripts/graph-save` dump.

## 7. Later, not in this plan

- **`show`**: a no-op server tool whose `tool-input` the client turns into
  navigation (`run`, `workflow`, `claim` → `ClaimsFlyout` with the claim
  highlighted, `step` → the step flyout). It needs new deep links: claims,
  checks, evidence and steps cannot be opened by id today. The walk graph's
  node click would become the first caller.
- **Walks from runs:** a `graph/walk` step inside a workflow already emits
  the same `walk:hop` events into its run log. `EventsPanel` could render
  the same `WalkView` from them (the `EvolveChart` pattern), reusing the fold
  and the graph.
