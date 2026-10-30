/**
 * strut/views (plans/apps.md §3.3): strut's components for its own concepts
 * — a run, its events, an agent's transcript, a workflow's `input:` block, a
 * graph node — as an app other apps import:
 *
 *   import { RunTimeline, RunGraph, LaunchForm } from "strut/views";
 *
 * The import compiles these sources into the importing app's document,
 * tree-shaken (§3.4), and they run as that app: every read or launch is a
 * step on ITS grants — `grants.workflows` for the run views and LaunchForm,
 * `graph/graph-get-batched`, `graph/graph-neighbors` and `graph/graph-search`
 * in `grants.steps` for the graph views. The folds they draw are
 * `@strut/kit`'s. Its own page is the gallery: every component over fixtures.
 */
export { RunStatus } from "./components/RunStatus";
export { RunList, type RunListProps } from "./components/RunList";
export { RunTimeline, type RunTimelineProps } from "./components/RunTimeline";
export { Transcript, type TranscriptProps } from "./components/Transcript";
export { LaunchForm, type LaunchFormProps, type InputField } from "./components/LaunchForm";
export { ArtifactView, type ArtifactViewProps, type RunFile } from "./components/ArtifactView";
export { DocumentView, SafeHtml, type DocumentViewProps, type DocumentKind, type SafeHtmlProps } from "./components/DocumentView";
export { RunHealth, type RunHealthProps } from "./components/RunHealth";
export { NodeCard, type NodeCardProps } from "./components/NodeCard";
export { NodeSearch, type NodeSearchProps } from "./components/NodeSearch";
export { NodeGraph, type NodeGraphProps } from "./components/NodeGraph";
export { RunGraph } from "./components/run-graph/RunGraph";
export { AgentTrace, AGENT_TRACE_INTERVAL_MS, type AgentTraceProps } from "./components/agent-trace/AgentTrace";
export { RunGraphReader } from "./components/run-graph/reader";
export { useNode, useNeighbors, useGraphSearch, getNodes, getNeighbors, type GraphNode, type GraphNeighbor, type GraphHit } from "./lib/graph";
export { nodeColor, runGraphColorMap, isProvenanceType } from "./lib/colors";
