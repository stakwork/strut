// A colour per node type: hive's Graph Explorer palette for the types it
// names (src/components/graph-explorer/nodeColors.ts, with the run graph's own
// additions — src/components/strut-run-graph/colors.ts), a stable hashed hue
// for any other. One palette for every view here, the run graph's included.

const PALETTE: Record<string, string> = {
  Hint: "#3b82f6", Prompt: "#10b981", Function: "#8b5cf6", Endpoint: "#ef4444", Datamodel: "#06b6d4",
  Request: "#ec4899", Learning: "#84cc16", Task: "#f97316", Repository: "#1e40af", Package: "#0891b2",
  Language: "#0d9488", Directory: "#f59e0b", Import: "#7c3aed", Library: "#9333ea", Class: "#a855f7",
  Trait: "#c084fc", Instance: "#d8b4fe", Feature: "#059669", Page: "#10b981", Var: "#34d399",
  UnitTest: "#fbbf24", IntegrationTest: "#f59e0b", E2eTest: "#f97316",
  EvalSet: "#3b82f6", BaselineTrigger: "#6b7280", EvalTrigger: "#14b8a6", EvalTriggerOutput_pass: "#22c55e",
  EvalTriggerOutput_fail: "#ef4444", EvalTriggerOutput_partial: "#f59e0b", ProposedFix: "#a855f7", EvalRequirement: "#6366f1",
  Concept: "#f59e0b", File: "#94a3b8", Matter: "#14b8a6", Agreement: "#6366f1", Document: "#0ea5e9",
  DiligenceIssue: "#f43f5e", AgentSession: "#d946ef", HiveWorkspace: "#eab308", HiveWorkspaceMember: "#38bdf8",
  ClinicalFinding: "#14b8a6", Diagnosis: "#f43f5e", Event: "#a855f7", Entity: "#ec4899",
};

/** Strut's own bookkeeping nodes — a run reads them by accident, walking out from a node earlier runs touched. */
export function isProvenanceType(type: string): boolean {
  return type.startsWith("Strut");
}

function hashedColor(type: string): string {
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 62% 52%)`;
}

export function nodeColor(type: string): string {
  return PALETTE[type] ?? hashedColor(type);
}

/** A colour per type: the palette's for a type it names, a hashed one for any other. */
export function runGraphColorMap(types: Iterable<string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const type of types) map[type] = nodeColor(type);
  return map;
}
