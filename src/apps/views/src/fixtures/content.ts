// The gallery's files (`run/files`) and transcript.
import type { TranscriptMark } from "@strut/kit";
import type { RunFile } from "../components/ArtifactView";
import { REF } from "./runs";

function b64(text: string): string {
  let s = "";
  for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b);
  return btoa(s);
}

/** A frame of a recording: a page sketched as an SVG. */
function frameSvg(title: string, highlight: number): string {
  const rows = [0, 1, 2].map((i) => `<rect x="40" y="${110 + i * 60}" width="560" height="44" rx="8" fill="${i === highlight ? "#fde68a" : "#f1f5f9"}" stroke="#cbd5e1"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#ffffff"/><rect width="640" height="56" fill="#0f172a"/><text x="24" y="36" font-family="sans-serif" font-size="20" fill="#ffffff">${title}</text>${rows}</svg>`;
}

const CHART = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" fill="#ffffff"/>${[60, 110, 90, 160, 140, 200]
  .map((h, i) => `<rect x="${30 + i * 72}" y="${220 - h}" width="48" height="${h}" rx="4" fill="#6366f1"/>`)
  .join("")}<line x1="20" y1="220" x2="460" y2="220" stroke="#64748b"/></svg>`;

const svgFile = (path: string, svg: string): RunFile => ({ path, mediaType: "image/svg+xml", bytes: svg.length, base64: b64(svg) });

export const FILES: Record<string, RunFile> = {
  "report.md": {
    path: "report.md",
    mediaType: "text/markdown",
    bytes: 512,
    text: [
      "# Atrial fibrillation in hypertension",
      "",
      "Hypertension is the **leading modifiable risk factor** for AF (about 1.5× the risk).",
      "",
      "| Finding | Source |",
      "| --- | --- |",
      "| Intensive BP control cut incident AF by 26% | SPRINT-AF |",
      "| Early rhythm control preferred | ESC 2026 |",
      "",
      "- Treat blood pressure to < 130/80",
      "- Screen for AF in long-standing hypertension",
    ].join("\n"),
  },
  "chart.svg": svgFile("chart.svg", CHART),
  // An HTML page a step wrote (a converted document): what DocumentView keeps
  // of it — the text, the headings, the table — and what it drops: the
  // script, the styles, the inline handler, a javascript: link.
  "memo.html": {
    path: "memo.html",
    mediaType: "text/html",
    bytes: 1_400,
    text: [
      "<!doctype html><html><head><title>Memo</title><style>body{color:red}</style><script>alert('never runs')</script></head><body>",
      '<h1 style="font-size:40px">Atrial fibrillation in hypertension</h1>',
      '<p class="lead" onclick="alert(1)">Hypertension is the <strong>leading modifiable risk factor</strong> for atrial fibrillation: about 1.5× the risk.</p>',
      "<h2>What the sources say</h2>",
      "<table><thead><tr><th>Finding</th><th>Source</th></tr></thead><tbody>",
      "<tr><td>Intensive BP control cut incident AF by 26%</td><td>SPRINT-AF, Table 2</td></tr>",
      '<tr><td>Treat blood pressure to &lt; 130/80</td><td><a href="https://example.org/esc-2026">ESC guideline 2026</a></td></tr>',
      "</tbody></table>",
      '<p>Screen for atrial fibrillation in long-standing hypertension. <a href="javascript:alert(2)">Not a link</a>.</p>',
      "<ul><li>Rhythm control early</li><li>Rate control when rhythm control fails</li></ul>",
      "</body></html>",
    ].join("\n"),
  },
  "notes.txt": { path: "notes.txt", mediaType: "text/plain", bytes: 64, text: "walk depth 2 · 6 nodes read · 1 node written\nchild run summarize 1790000000500" },
  "report.pdf": { path: "report.pdf", mediaType: "application/pdf", bytes: 48_213, base64: "" },
  "walkthrough/walkthrough.json": {
    path: "walkthrough/walkthrough.json",
    mediaType: "application/json",
    bytes: 400,
    text: JSON.stringify({
      title: "Settings page",
      url: "https://app.example.org/settings",
      status: "done",
      frames: [
        { file: "frame-1.svg", caption: "Open the settings page" },
        { file: "frame-2.svg", caption: "Pick the notifications row" },
        { file: "frame-3.svg", caption: "Save — the toggle stays on" },
      ],
    }),
  },
  "walkthrough/frame-1.svg": svgFile("walkthrough/frame-1.svg", frameSvg("Settings", -1)),
  "walkthrough/frame-2.svg": svgFile("walkthrough/frame-2.svg", frameSvg("Settings", 1)),
  "walkthrough/frame-3.svg": svgFile("walkthrough/frame-3.svg", frameSvg("Settings · saved", 1)),
};

/** An agent's session as strut stores it (AI SDK model messages). */
export const TRANSCRIPT: Array<{ role: string; content: unknown }> = [
  { role: "system", content: "You research clinical questions against the graph." },
  { role: "user", content: "What drives atrial fibrillation in hypertensive patients?" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I'll start from the Arrhythmia concept and walk out from Cardiology." },
      { type: "tool-call", toolCallId: "call_1", toolName: "graph_graph_get", input: { ref_id: REF.arrhythmia } },
      { type: "tool-call", toolCallId: "call_2", toolName: "graph_walk", input: { ref_id: REF.cardiology, goal: "risk factors for AF" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call_1", toolName: "graph_graph_get", output: { type: "json", value: { ref_id: REF.arrhythmia, name: "Arrhythmia", node_type: "Concept" } } },
      { type: "tool-result", toolCallId: "call_2", toolName: "graph_walk", output: { type: "json", value: { stopped: "enough", nodes: 3 } } },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_3", toolName: "meta_run_workflow", input: { name: "summarize", input: { ref_id: REF.guideline } } }],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_3", toolName: "meta_run_workflow", output: { type: "error-text", value: "workflow \"summarize\" timed out once; retried" } }],
  },
  { role: "user", content: "[run-notification] run 1790000000500 of summarize succeeded in 14s\nOutput: {\"summary\":\"…\"}" },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "**Hypertension** is the leading modifiable risk factor:\n\n1. Long-standing pressure load remodels the left atrium.\n2. Intensive control cut incident AF by 26% (SPRINT-AF).\n\nThe report is in `report.md`.",
      },
    ],
  },
];

export const TRANSCRIPT_MARKS: TranscriptMark[] = [{ at: 1, label: "Turn 1", detail: "run 1790000000100" }];
