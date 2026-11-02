// Fold graph_walk's progress (plans/walk-chat-demo.md §3) into the graph the
// chat draws. The tool yields one hop event per progress output — a
// `walk:hop` step.start (what the hop discovered, each candidate with the edge
// it arrived by) and a step.end (the verdicts) — then a final `done` result.
// The fold is the kit's (kit/src/folds/walk/graph.ts), shared with
// strut/views' WalkView, which reads the same hop events from a run's log.
export {
  foldWalkProgress as foldWalk,
  walkProgressHops as hopEvents,
  emptyWalkGraph as emptyWalk,
  verdictOf,
  walkSummary,
  type WalkGraphNode as WalkNode,
  type WalkGraphNodeState as WalkNodeState,
  type WalkGraphEdge as WalkEdge,
  type WalkGraphState as WalkState,
  type WalkVia,
  type WalkProgress,
} from "@strut/kit/folds";
