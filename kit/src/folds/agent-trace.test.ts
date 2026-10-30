// Ported from hive (src/__tests__/unit/lib/legal-cascade-strut.test.ts and
// legal-cascade/derive.test.ts), over strut's own log: the tool names as the
// model saw them, a sub-agent by its path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldAgentTrace, reasoningByCall, type TraceEvent, type TraceRow } from "./agent-trace.js";

const WF = "review";
const T0 = Date.UTC(2026, 9, 21, 3, 0, 0);
const T = (s: number) => new Date(T0 + s * 1000).toISOString();
const usage = (n: number) => ({ inputTokens: n, cacheReadTokens: 10 * n, cacheWriteTokens: 0, outputTokens: n, totalTokens: 12 * n });

/** An ingest agent that reads, writes and forks a sub-agent, and a second agent still working. */
const ingest: TraceEvent[] = [
  { type: "run.start", path: WF, workflow: WF, ts: T(0) },
  { type: "step.start", path: `${WF}/ingest#0`, stepType: "agent", ts: T(1), input: { prompt: "You are the INGEST agent.", model: "claude-sonnet-5-5" } },
  { type: "step.start", path: `${WF}/ingest#0/001-graph_graph_search`, stepType: "tool:graph_graph_search", toolCallId: "c1", ts: T(2), input: { q: "house rules" } },
  {
    type: "step.end", path: `${WF}/ingest#0/001-graph_graph_search`, stepType: "tool:graph_graph_search", toolCallId: "c1", ts: T(3), output: "[3 hits]",
    nodes: [{ ref_id: "k1", node_type: "Concept", name: "Review rules" }, { ref_id: "d1", node_type: "Document", name: "memo.docx" }],
  },
  { type: "step.start", path: `${WF}/ingest#0/002-graph_create_batch_triplet`, stepType: "tool:graph_create_batch_triplet", toolCallId: "c2", ts: T(4), input: { triplets: [{ source_type: "Report", source_data: { name: "Q3 report" } }] } },
  { type: "step.end", path: `${WF}/ingest#0/002-graph_create_batch_triplet`, stepType: "tool:graph_create_batch_triplet", toolCallId: "c2", ts: T(5), output: '{"succeeded":1}', nodes: [{ ref_id: "a1", node_type: "Report", name: "Q3 report" }] },
  { type: "step.start", path: `${WF}/ingest#0/003-agent`, stepType: "tool:agent", toolCallId: "c3", ts: T(6), input: { prompt: "Check the figures." } },
  { type: "step.start", path: `${WF}/ingest#0/003-agent/001-bash`, stepType: "tool:bash", toolCallId: "s1", ts: T(7), input: { command: "ls" } },
  { type: "step.error", path: `${WF}/ingest#0/003-agent/001-bash`, stepType: "tool:bash", toolCallId: "s1", ts: T(8), error: { message: "timed out" } },
  {
    type: "step.end", path: `${WF}/ingest#0/003-agent`, stepType: "tool:agent", toolCallId: "c3", ts: T(9),
    // A sub-agent's output is the log's 1.5 KB preview: JSON text, maybe cut.
    output: '{"result":"Figures check out.","steps":2,"usage":{"inputTok\n[… truncated for event log …]',
    modelCalls: 2, usage: usage(5), cost: 0.05,
    transcript: `/workflows/${WF}/runs/179/transcripts/${WF}/ingest%230/003-agent`,
  },
  {
    type: "step.end", path: `${WF}/ingest#0`, stepType: "agent", ts: T(10),
    output: { result: "Ingested memo.docx.", steps: 4 }, modelCalls: 4, usage: usage(10), cost: 0.4,
    transcript: `/workflows/${WF}/runs/179/transcripts/${WF}/ingest%230`,
  },
  { type: "step.start", path: `${WF}/drafter`, stepType: "agent", ts: T(11), input: { prompt: "You are the DRAFTER agent." } },
  { type: "step.start", path: `${WF}/drafter/001-bash`, stepType: "tool:bash", toolCallId: "d1", ts: T(12), input: { command: "cat facts.md" } },
  // Not an agent's tool call: ignored.
  { type: "step.start", path: `${WF}/score`, stepType: "exec", ts: T(13), input: {} },
];

const kinds = (rows: TraceRow[]) => rows.map((r) => (r.kind === "node" ? `node:${r.verb}:${r.node.name}` : r.kind));

describe("foldAgentTrace — sessions", () => {
  it("makes each agent step a session and each sub-agent a child of its caller", () => {
    const m = foldAgentTrace(ingest);
    assert.equal(m.workflow, WF);
    assert.deepEqual(m.sessions.map((s) => [s.label, s.status, s.parent]), [
      ["ingest#0", "success", null],
      ["ingest#0/003-agent", "success", `${WF}/ingest#0`],
      ["drafter", "running", null],
    ]);
    const s = m.sessions[0]!;
    assert.equal(s.path, `${WF}/ingest#0`);
    assert.equal(s.model, "claude-sonnet-5-5");
    assert.equal(s.startedAt, Date.parse(T(1)));
    assert.equal(s.endedAt, Date.parse(T(10)));
    assert.deepEqual(s.usage, usage(10));
    assert.equal(s.cost, 0.4);
    assert.equal(s.toolCalls, 3);
    assert.equal(s.transcript, `/workflows/${WF}/runs/179/transcripts/${WF}/ingest%230`);
    assert.deepEqual(s.children, [`${WF}/ingest#0/003-agent`]);
    // The sub-agent inherits its caller's model when its call names none.
    assert.equal(m.sessions[1]!.model, "claude-sonnet-5-5");
  });

  it("orders turns in fixed slots: prompt, call/result pairs, the response", () => {
    const turns = foldAgentTrace(ingest).sessions[0]!.turns;
    assert.deepEqual(turns.map((t) => [t.order, t.kind, t.tool ?? null]), [
      [0, "prompt", null],
      [2, "call", "graph_graph_search"],
      [3, "result", "graph_graph_search"],
      [5, "call", "graph_create_batch_triplet"],
      [6, "result", "graph_create_batch_triplet"],
      [8, "call", "agent"],
      [9, "result", "agent"],
      [10, "response", null],
    ]);
    assert.equal(turns[0]!.text, "You are the INGEST agent.");
    assert.equal(turns[1]!.toolCallId, "c1");
    assert.equal(turns[1]!.access, "read");
    // The nodes a call reported when it ended, on the call.
    assert.equal(turns[1]!.nodes?.length, 2);
    assert.equal(turns[2]!.nodes, undefined);
    assert.equal(turns[3]!.access, "write");
    assert.deepEqual(turns[3]!.nodes, [{ ref_id: "a1", node_type: "Report", name: "Q3 report" }]);
    assert.equal(turns.at(-1)!.text, "Ingested memo.docx.");
  });

  it("gives a sub-agent its prompt, its calls, an error as a result, and its answer from the cut preview", () => {
    const sub = foldAgentTrace(ingest).sessions[1]!;
    assert.deepEqual(sub.turns.map((t) => [t.order, t.kind, t.text]), [
      [0, "prompt", "Check the figures."],
      [2, "call", '{"command":"ls"}'],
      [3, "result", "Error: timed out"],
      [4, "response", "Figures check out."],
    ]);
    assert.equal(sub.turns[2]!.error, true);
    assert.equal(sub.cost, 0.05);
  });

  it("calls an agent with no end aborted once the run is over", () => {
    const m = foldAgentTrace([...ingest, { type: "run.end", path: WF, ts: T(20) }]);
    assert.equal(m.finished, true);
    assert.equal(m.sessions.find((s) => s.label === "drafter")!.status, "aborted");
    assert.equal(m.summary.running, false);
  });

  it("starts a re-run agent's session afresh, its old sub-agents gone", () => {
    const again: TraceEvent[] = [...ingest, { type: "step.start", path: `${WF}/ingest#0`, stepType: "agent", ts: T(20), input: { prompt: "Second attempt." } }];
    const m = foldAgentTrace(again);
    const s = m.sessions.find((x) => x.label === "ingest#0")!;
    assert.equal(s.status, "running");
    assert.deepEqual(s.turns.map((t) => t.text), ["Second attempt."]);
    assert.equal(m.sessions.some((x) => x.label === "ingest#0/003-agent"), false);
  });

  it("reads the prompt and the answer when the log kept them as JSON text", () => {
    const m = foldAgentTrace([
      { type: "step.start", path: "wf/a", stepType: "agent", ts: T(0), input: '{"cwd":"/x","prompt":"Read \\"the\\" file.\\nThen stop.","model":"op' },
      { type: "step.end", path: "wf/a", stepType: "agent", ts: T(1), output: '{"result":"done"}' },
    ]);
    assert.equal(m.sessions[0]!.prompt, 'Read "the" file.\nThen stop.');
    assert.equal(m.sessions[0]!.response, "done");
    // No run.start: labels are the whole path.
    assert.equal(m.sessions[0]!.label, "wf/a");
  });

  it("counts a replayed agent as finished, with its journaled answer", () => {
    const m = foldAgentTrace([
      { type: "run.start", path: WF, ts: T(0) },
      { type: "step.replayed", path: `${WF}/a`, stepType: "agent", ts: T(1), output: { result: "from the journal" } },
    ]);
    assert.equal(m.sessions[0]!.status, "success");
    assert.equal(m.sessions[0]!.response, "from the journal");
  });
});

describe("foldAgentTrace — reasoning from the transcript", () => {
  const transcript = [
    { role: "system", content: "sys" },
    { role: "user", content: "prompt" },
    { role: "assistant", content: [{ type: "reasoning", text: "Search first." }, { type: "tool-call", toolCallId: "c1", toolName: "graph_graph_search", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: {} }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Now write it." },
        { type: "tool-call", toolCallId: "c2", toolName: "graph_create_batch_triplet", input: {} },
        { type: "tool-call", toolCallId: "c3", toolName: "agent", input: {} },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ];

  it("pairs each reasoning text with the call it led to", () => {
    assert.deepEqual([...reasoningByCall(transcript)], [["c1", "Search first."], ["c2", "Now write it."]]);
    assert.deepEqual([...reasoningByCall({ path: "x", messages: transcript })], [["c1", "Search first."], ["c2", "Now write it."]]);
    assert.equal(reasoningByCall("nope").size, 0);
  });

  it("puts it in the slot before the call, from a Map or a record by step path", () => {
    for (const t of [new Map([[`${WF}/ingest#0`, transcript]]), { [`${WF}/ingest#0`]: { messages: transcript } }]) {
      const s = foldAgentTrace(ingest, t).sessions[0]!;
      assert.equal(s.reasoned, true);
      assert.deepEqual(s.turns.filter((x) => x.kind === "reasoning").map((x) => [x.order, x.text]), [[1, "Search first."], [4, "Now write it."]]);
    }
    assert.equal(foldAgentTrace(ingest).sessions[0]!.reasoned, false);
  });
});

describe("foldAgentTrace — rows", () => {
  it("folds a session into a cascade: the nodes a call named, the sub-agent's lane and its merge, pills between", () => {
    const m = foldAgentTrace(ingest);
    const rows = m.agents[0]!.rows;
    // A call that named nodes is drawn as them, its result with it: a read
    // shows Concepts only, by default; a write shows what it wrote.
    assert.deepEqual(kinds(rows), [
      "prompt",
      "node:read:Review rules",
      "node:created:Q3 report",
      "agent",
      "pill",
      "response",
      "response",
    ]);
    const agent = rows[3] as Extract<TraceRow, { kind: "agent" }>;
    assert.deepEqual([agent.depth, agent.label, agent.prompt, agent.status, agent.hasTrace], [1, "ingest#0/003-agent", "Check the figures.", "success", true]);
    const [subPill, subResponse, response] = rows.slice(4) as [Extract<TraceRow, { kind: "pill" }>, Extract<TraceRow, { kind: "response" }>, Extract<TraceRow, { kind: "response" }>];
    assert.deepEqual([subPill.depth, subPill.calls, subPill.errors], [1, 1, 1]);
    assert.deepEqual([subResponse.depth, subResponse.merge, subResponse.text], [1, true, "Figures check out."]);
    assert.deepEqual([response.depth, response.merge], [0, false]);
    // The results of the calls drawn as rows are in no pill.
    assert.equal(rows.some((r) => r.kind === "pill" && r.turns.some((t) => t.kind === "result" && t.tool !== "bash")), false);
  });

  it("gives a pill an honest span, its tools' mix and its time; calls made beside a node's stay in it", () => {
    const parallel: TraceEvent[] = [
      { type: "step.start", path: "wf/a", stepType: "agent", ts: T(0), input: { prompt: "p" } },
      { type: "step.start", path: "wf/a/001-graph_graph_get", stepType: "tool:graph_graph_get", ts: T(1), input: {} },
      { type: "step.start", path: "wf/a/002-bash", stepType: "tool:bash", ts: T(1), input: {} },
      { type: "step.start", path: "wf/a/003-bash", stepType: "tool:bash", ts: T(1), input: {} },
      { type: "step.end", path: "wf/a/003-bash", stepType: "tool:bash", ts: T(2) },
      { type: "step.end", path: "wf/a/002-bash", stepType: "tool:bash", ts: T(4) },
      { type: "step.end", path: "wf/a/001-graph_graph_get", stepType: "tool:graph_graph_get", ts: T(5), nodes: [{ ref_id: "k", node_type: "Concept", name: "K" }] },
    ];
    const rows = foldAgentTrace(parallel).agents[0]!.rows;
    assert.deepEqual(kinds(rows), ["prompt", "node:read:K", "pill"]);
    const pill = rows[2] as Extract<TraceRow, { kind: "pill" }>;
    assert.deepEqual([pill.from, pill.to, pill.calls, pill.durationMs], [5, 9, 2, 3000]);
    assert.deepEqual(pill.mix, [{ tool: "bash", count: 2 }]);
    const open = foldAgentTrace(ingest).agents[1]!.rows;
    assert.deepEqual(kinds(open), ["prompt", "pill"]);
    // The trailing pill of a running session grows in place.
    assert.equal((open[1] as Extract<TraceRow, { kind: "pill" }>).open, true);
  });

  it("shows every node type a read named with readTypes: null", () => {
    const rows = foldAgentTrace(ingest, undefined, { readTypes: null }).agents[0]!.rows;
    assert.deepEqual(kinds(rows).slice(1, 3), ["node:read:Review rules", "node:read:memo.docx"]);
  });

  it("calls an edit, a move or a delete by what it did", () => {
    const rows = foldAgentTrace([
      { type: "step.start", path: "wf/a", stepType: "agent", ts: T(0), input: { prompt: "p" } },
      ...["graph_edit_node", "graph_move_node", "graph_delete_node"].flatMap((tool, i): TraceEvent[] => [
        { type: "step.start", path: `wf/a/00${i + 1}-${tool}`, stepType: `tool:${tool}`, ts: T(i + 1), input: {} },
        { type: "step.end", path: `wf/a/00${i + 1}-${tool}`, stepType: `tool:${tool}`, ts: T(i + 1), nodes: [{ ref_id: `n${i}`, node_type: "Concept", name: `n${i}` }] },
      ]),
    ]).agents[0]!.rows;
    assert.deepEqual(kinds(rows), ["prompt", "node:edited:n0", "node:edited:n1", "node:deleted:n2"]);
  });

  it("adds up the run: agents, sub-agents, nodes, calls, tokens, cost", () => {
    const { summary } = foldAgentTrace(ingest);
    assert.deepEqual(
      { ...summary, usage: summary.usage.totalTokens },
      { agents: 2, subAgents: 1, nodes: 2, toolCalls: 5, modelCalls: 6, usage: 12 * 15, cost: 0.45, running: true, startedAt: Date.parse(T(1)) },
    );
  });
});

describe("foldAgentTrace — batches", () => {
  const agent = (path: string, s: number, e: number | null): TraceEvent[] => [
    { type: "step.start", path, stepType: "agent", ts: T(s) },
    ...(e === null ? [] : [{ type: "step.end", path, stepType: "agent", ts: T(e) }]),
  ];

  it("groups agents that ran at the same time, a foreach's iterations among them", () => {
    const m = foldAgentTrace([
      { type: "run.start", path: WF, ts: T(0) },
      ...agent(`${WF}/checklist`, 0, 300),
      ...agent(`${WF}/ingest#0`, 2, 250),
      ...agent(`${WF}/ingest#1`, 2, 700),
      // After the first of its batch ended: a new batch, even though ingest#1 still runs.
      ...agent(`${WF}/drafter`, 301, 900),
      ...agent(`${WF}/dispute`, 901, null),
    ]);
    assert.deepEqual(m.agents.map((a) => [a.session.label, a.batch]), [
      ["checklist", 0],
      ["ingest#0", 0],
      ["ingest#1", 0],
      ["drafter", 1],
      ["dispute", 2],
    ]);
    assert.deepEqual(m.agents.map((a) => a.live), [false, false, false, false, true]);
  });

  it("flags an agent live while a sub-agent still runs", () => {
    const m = foldAgentTrace(ingest.slice(0, 9));
    assert.equal(m.agents[0]!.live, true);
    assert.equal((m.agents[0]!.rows.find((r) => r.kind === "agent") as Extract<TraceRow, { kind: "agent" }>).status, "running");
  });

  it("refolds a growing log to the same model as the whole log", () => {
    const whole = foldAgentTrace(ingest);
    for (let n = 0; n <= ingest.length; n++) foldAgentTrace(ingest.slice(0, n));
    assert.deepEqual(foldAgentTrace([...ingest]), whole);
  });
});
