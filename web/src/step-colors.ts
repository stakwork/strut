// The step palette: the ONE place a step's color is decided. The canvas
// node (fill + stroke) and the run overview's timeline and spend bars
// (stroke) both read it, so an agent is the same color everywhere. A skin
// would swap PALETTE and leave the mapping alone.

export interface StepColors { fill: string; stroke: string }

export const PALETTE = {
  http:     { fill: "rgba(6, 78, 59, 0.4)",   stroke: "#34d399" },
  log:      { fill: "rgba(30, 58, 138, 0.4)", stroke: "#60a5fa" },
  if:       { fill: "rgba(120, 53, 15, 0.4)", stroke: "#f59e0b" },
  loop:     { fill: "rgba(88, 28, 135, 0.4)", stroke: "#a78bfa" },
  foreach:  { fill: "rgba(67, 20, 102, 0.4)", stroke: "#8b5cf6" },
  subflow:  { fill: "rgba(21, 94, 117, 0.4)", stroke: "#22d3ee" },
  /** A step that launches another run (here or on a peer). */
  run:      { fill: "rgba(21, 94, 117, 0.4)", stroke: "#22d3ee" },
  llm:      { fill: "rgba(76, 29, 149, 0.4)", stroke: "#c084fc" },
  agent:    { fill: "rgba(124, 45, 18, 0.4)", stroke: "#fb923c" },
  /** An agent called as another agent's tool. */
  subagent: { fill: "rgba(124, 45, 18, 0.25)", stroke: "#fdba74" },
  wait:     { fill: "rgba(71, 85, 105, 0.4)", stroke: "#94a3b8" },
  exec:     { fill: "rgba(63, 63, 70, 0.5)",  stroke: "#a1a1aa" },
  slack:    { fill: "rgba(74, 21, 75, 0.4)",  stroke: "#e879f9" },
  x:        { fill: "rgba(12, 74, 110, 0.4)", stroke: "#38bdf8" },
  google:   { fill: "rgba(20, 83, 45, 0.4)",  stroke: "#4ade80" },
  browser:  { fill: "rgba(19, 78, 74, 0.4)",  stroke: "#2dd4bf" },
  default:  { fill: "rgba(38, 38, 38, 0.6)",  stroke: "#737373" },
} satisfies Record<string, StepColors>;

export type PaletteKey = keyof typeof PALETTE;

const BY_TYPE: Record<string, PaletteKey> = {
  "strut/run-workflow": "run",
  "meta/run-workflow": "run",
  "job/start": "run",
  "job/continue": "run",
};

const BY_NAMESPACE: Record<string, PaletteKey> = {
  slack: "slack",
  x: "x",
  gdrive: "google",
  sheets: "google",
  browser: "browser",
};

/** The palette entry a step type wears: a core step by name, a lib step by
 *  type or namespace, anything else `default`. A tool call's type
 *  (`tool:agent`, `tool:llm`) is the step it ran — a sub-agent its own. */
export function paletteKey(type: string): PaletteKey {
  if (type === "tool:agent") return "subagent";
  const t = type.startsWith("tool:") ? type.slice(5) : type;
  if (BY_TYPE[t]) return BY_TYPE[t]!;
  if (t in PALETTE && t !== "default" && t !== "run" && t !== "subagent") return t as PaletteKey;
  const slash = t.indexOf("/");
  return (slash > 0 && BY_NAMESPACE[t.slice(0, slash)]) || "default";
}

export function stepColors(type: string): StepColors {
  return PALETTE[paletteKey(type)];
}
